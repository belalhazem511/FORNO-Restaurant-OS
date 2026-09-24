import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  cashierShifts,
  orderCancellations,
  orderCheckouts,
  orderInventoryIssues,
  orderPayments,
  orders,
  paymentMethods,
} from "@/lib/db/schema";
import { requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";
import { cancelOrder } from "./checkout/cancellation";
import { payOrder } from "./checkout/payment";

const discountInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("percentage"), value: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }),
  z.object({ type: z.literal("fixed"), value: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }),
]);

const checkoutResultSchema = z.object({
  checkoutId: z.number(),
  orderId: z.number(),
  subtotalAmount: z.number(),
  discountAmount: z.number(),
  payableAmount: z.number(),
  changeAmount: z.number(),
  paymentStatus: z.enum(["paid", "refunded"]),
});

async function resultForCheckout(checkout: typeof orderCheckouts.$inferSelect) {
  const payments = await db.select().from(orderPayments).where(and(
    eq(orderPayments.checkout_id, checkout.id),
    eq(orderPayments.kind, "payment"),
  ));
  return {
    checkoutId: checkout.id,
    orderId: checkout.order_id,
    subtotalAmount: checkout.subtotal_amount,
    discountAmount: checkout.discount_amount,
    payableAmount: checkout.payable_amount,
    changeAmount: payments.reduce((sum, payment) => sum + payment.change_amount, 0),
    paymentStatus: "paid" as const,
  };
}

export const checkoutRouter = router({
  pay: protectedProcedure
    .input(z.object({
      orderId: z.number().int().positive(),
      idempotencyKey: z.string().trim().min(8).max(100),
      discount: discountInputSchema.nullable().optional(),
      payments: z.array(z.object({
        paymentMethodId: z.number().int().positive(),
        amount: z.number().int().positive(),
        tenderedAmount: z.number().int().positive().nullable().optional(),
      })).min(1).max(3),
    }))
    .output(checkoutResultSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.idempotency_key, input.idempotencyKey) });
      if (existing) {
        if (existing.order_id !== input.orderId || existing.created_by !== ctx.user.id) {
          throw new TRPCError({ code: "CONFLICT", message: "Checkout idempotency key is already in use" });
        }
        return resultForCheckout(existing);
      }

      const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
      if (!order || !order.branch_id) throw new Error("Order or order branch not found");
      await requireStaff(ctx.user.id, order.branch_id, "checkout:create");
      if (input.discount) await requireStaff(ctx.user.id, order.branch_id, "discount:apply");
      if (order.status === "cancelled") throw new Error("Cancelled orders cannot be paid");
      if (order.payment_status === "paid" || order.payment_status === "refunded") throw new Error("Order is already fully paid");

      const uniqueMethodIds = [...new Set(input.payments.map((payment) => payment.paymentMethodId))];
      if (uniqueMethodIds.length !== input.payments.length) throw new Error("Each payment method can only be allocated once");

      const shift = await db.query.cashierShifts.findFirst({ where: and(
        eq(cashierShifts.branch_id, order.branch_id),
        eq(cashierShifts.cashier_user_id, ctx.user.id),
        eq(cashierShifts.status, "open"),
      ) });
      if (!shift) throw new Error("An active cashier shift is required before checkout");

      const methods = await db.select().from(paymentMethods).where(and(
        inArray(paymentMethods.id, uniqueMethodIds),
        eq(paymentMethods.is_active, true),
      ));
      if (methods.length !== uniqueMethodIds.length) throw new Error("An allocated payment method is unavailable");
      const methodById = new Map(methods.map((method) => [method.id, method]));

      return payOrder(input, order, shift, methodById, ctx.user.id);
    }),

  cancel: protectedProcedure
    .input(z.object({
      orderId: z.number().int().positive(),
      idempotencyKey: z.string().trim().min(8).max(100),
      reason: z.string().trim().min(3).max(500),
      inventoryDisposition: z.enum(["returned_unused", "prepared_discarded"]).optional(),
    }))
    .output(z.object({ orderId: z.number(), paymentStatus: z.enum(["unpaid", "refunded"]), refundedAmount: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.orderCancellations.findFirst({ where: eq(orderCancellations.idempotency_key, input.idempotencyKey) });
      if (existing) {
        if (existing.order_id !== input.orderId || existing.cancelled_by !== ctx.user.id) {
          throw new TRPCError({ code: "CONFLICT", message: "Cancellation idempotency key is already in use" });
        }
        const refunds = await db.select().from(orderPayments).where(and(eq(orderPayments.order_id, input.orderId), eq(orderPayments.kind, "refund")));
        return { orderId: input.orderId, paymentStatus: existing.was_paid ? "refunded" as const : "unpaid" as const, refundedAmount: refunds.reduce((sum, payment) => sum + payment.amount, 0) };
      }

      const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
      if (!order || !order.branch_id) throw new Error("Order or order branch not found");
      await requireStaff(ctx.user.id, order.branch_id, "order:cancel");
      const inventoryIssue = await db.query.orderInventoryIssues.findFirst({ where: eq(orderInventoryIssues.order_id, order.id) });
      if (inventoryIssue && !input.inventoryDisposition) throw new Error("Cancellation after kitchen production requires an inventory disposition");
      if (order.status === "cancelled") throw new Error("Order is already cancelled");
      const wasPaid = order.payment_status === "paid";
      if (order.payment_status === "refunded") throw new Error("Order payment is already refunded");

      let shift: typeof cashierShifts.$inferSelect | null = null;
      if (wasPaid) {
        await requireStaff(ctx.user.id, order.branch_id, "payment:refund");
        shift = await db.query.cashierShifts.findFirst({ where: and(
          eq(cashierShifts.branch_id, order.branch_id),
          eq(cashierShifts.cashier_user_id, ctx.user.id),
          eq(cashierShifts.status, "open"),
        ) }) ?? null;
        if (!shift) throw new Error("An active cashier shift is required for a financial reversal");
      }

      return cancelOrder(input, order, wasPaid, shift, ctx.user.id);
    }),

  financials: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .output(z.object({
      canCancel: z.boolean(),
      checkout: z.object({ id: z.number(), subtotal_amount: z.number(), discount_amount: z.number(), payable_amount: z.number() }).nullable(),
      payments: z.array(z.object({ id: z.number(), kind: z.string(), amount: z.number(), change_amount: z.number(), method: z.string(), created_at: z.date() })),
      cancellation: z.object({ id: z.number(), reason: z.string(), was_paid: z.boolean(), created_at: z.date() }).nullable(),
    }))
    .query(async ({ ctx, input }) => {
      const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
      if (!order || !order.branch_id) throw new Error("Order or branch not found");
      const assignment = await requireStaff(ctx.user.id, order.branch_id, "order:create");
      const [checkout, payments, cancellation] = await Promise.all([
        db.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.order_id, order.id), columns: { id: true, subtotal_amount: true, discount_amount: true, payable_amount: true } }),
        db.query.orderPayments.findMany({ where: eq(orderPayments.order_id, order.id), with: { paymentMethod: { columns: { name: true } } } }),
        db.query.orderCancellations.findFirst({ where: eq(orderCancellations.order_id, order.id), columns: { id: true, reason: true, was_paid: true, created_at: true } }),
      ]);
      return {
        canCancel: assignment.role !== "cashier",
        checkout: checkout ?? null,
        payments: payments.map((payment) => ({ id: payment.id, kind: payment.kind, amount: payment.amount, change_amount: payment.change_amount, method: payment.paymentMethod.name, created_at: payment.created_at })),
        cancellation: cancellation ?? null,
      };
    }),
});
