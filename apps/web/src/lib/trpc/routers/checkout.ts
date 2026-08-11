import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  auditLogs,
  cashierShifts,
  orderCancellations,
  orderCheckouts,
  orderPayments,
  orders,
  orderStatusHistory,
  paymentMethods,
  restaurantTables,
  transactions,
} from "@/lib/db/schema";
import { calculateDiscount } from "@/lib/finance";
import { requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

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

      return db.transaction(async (tx) => {
        const lockedOrder = await tx.query.orders.findFirst({
          where: eq(orders.id, input.orderId),
          with: { orderItems: { with: { modifiers: true } } },
        });
        if (!lockedOrder) throw new Error("Order not found");
        if (lockedOrder.status === "cancelled") throw new Error("Cancelled orders cannot be paid");
        if (lockedOrder.payment_status !== "unpaid") throw new Error("Order is already fully paid");

        const subtotal = lockedOrder.orderItems.reduce((orderSum, item) => {
          const modifierTotal = item.modifiers.reduce((sum, modifier) => sum + modifier.price_delta, 0);
          return orderSum + (item.price + modifierTotal) * item.quantity;
        }, 0);
        const discountAmount = calculateDiscount(subtotal, input.discount ?? null);
        const payableAmount = subtotal - discountAmount;
        if (payableAmount <= 0) throw new Error("Order payable amount must remain positive");
        const allocatedAmount = input.payments.reduce((sum, payment) => sum + payment.amount, 0);
        if (allocatedAmount < payableAmount) throw new Error("Payment allocations do not cover the payable amount");
        if (allocatedAmount > payableAmount) throw new Error("Payment allocations exceed the payable amount");

        for (const allocation of input.payments) {
          const method = methodById.get(allocation.paymentMethodId)!;
          if (method.affects_drawer) {
            if ((allocation.tenderedAmount ?? allocation.amount) < allocation.amount) throw new Error("Cash received cannot be less than the cash allocation");
          } else if (allocation.tenderedAmount != null && allocation.tenderedAmount !== allocation.amount) {
            throw new Error("Only cash payments can include change");
          }
        }

        const [checkout] = await tx.insert(orderCheckouts).values({
          order_id: lockedOrder.id,
          shift_id: shift.id,
          idempotency_key: input.idempotencyKey,
          subtotal_amount: subtotal,
          discount_amount: discountAmount,
          payable_amount: payableAmount,
          created_by: ctx.user.id,
          approved_by: input.discount ? ctx.user.id : null,
        }).returning();

        let changeAmount = 0;
        for (const allocation of input.payments) {
          const method = methodById.get(allocation.paymentMethodId)!;
          const tendered = method.affects_drawer ? allocation.tenderedAmount ?? allocation.amount : null;
          const change = tendered == null ? 0 : tendered - allocation.amount;
          changeAmount += change;
          const [payment] = await tx.insert(orderPayments).values({
            checkout_id: checkout.id,
            order_id: lockedOrder.id,
            shift_id: shift.id,
            payment_method_id: method.id,
            kind: "payment",
            amount: allocation.amount,
            tendered_amount: tendered,
            change_amount: change,
            created_by: ctx.user.id,
          }).returning();
          await tx.insert(transactions).values({
            order_id: lockedOrder.id,
            shift_id: shift.id,
            order_payment_id: payment.id,
            payment_method_id: method.id,
            amount: allocation.amount,
            user_uid: ctx.user.id,
            type: "income",
            category: "selling",
            status: "completed",
            description: `Payment for order #${lockedOrder.id}`,
          });
        }

        await tx.update(orders).set({
          subtotal_amount: subtotal,
          discount_type: input.discount?.type ?? null,
          discount_value: input.discount?.value ?? 0,
          discount_amount: discountAmount,
          discount_reason: input.discount?.reason ?? null,
          discount_applied_by: input.discount ? ctx.user.id : null,
          discount_approved_by: input.discount ? ctx.user.id : null,
          total_amount: payableAmount,
          payment_status: "paid",
          paid_at: new Date(),
          updated_at: new Date(),
        }).where(and(eq(orders.id, lockedOrder.id), eq(orders.payment_status, "unpaid")));

        if (input.discount) {
          await tx.insert(auditLogs).values({
            branch_id: order.branch_id, shift_id: shift.id, order_id: order.id,
            actor_user_id: ctx.user.id, approver_user_id: ctx.user.id,
            action: "order.discount", entity_type: "order", entity_id: String(order.id),
            reason: input.discount.reason,
            details: JSON.stringify({ type: input.discount.type, value: input.discount.value, amount: discountAmount, subtotal }),
          });
        }
        await tx.insert(auditLogs).values({
          branch_id: order.branch_id, shift_id: shift.id, order_id: order.id,
          actor_user_id: ctx.user.id,
          action: "order.checkout", entity_type: "order_checkout", entity_id: String(checkout.id),
          details: JSON.stringify({ payableAmount, changeAmount, paymentCount: input.payments.length }),
        });

        return {
          checkoutId: checkout.id,
          orderId: order.id,
          subtotalAmount: subtotal,
          discountAmount,
          payableAmount,
          changeAmount,
          paymentStatus: "paid" as const,
        };
      });
    }),

  cancel: protectedProcedure
    .input(z.object({
      orderId: z.number().int().positive(),
      idempotencyKey: z.string().trim().min(8).max(100),
      reason: z.string().trim().min(3).max(500),
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

      return db.transaction(async (tx) => {
        const current = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
        if (!current || current.status === "cancelled") throw new Error("Order is already cancelled");
        const [cancellation] = await tx.insert(orderCancellations).values({
          order_id: order.id,
          shift_id: shift?.id ?? null,
          idempotency_key: input.idempotencyKey,
          reason: input.reason,
          was_paid: wasPaid,
          cancelled_by: ctx.user.id,
          approved_by: ctx.user.id,
        }).returning();

        let refundedAmount = 0;
        if (wasPaid && shift) {
          const originalPayments = await tx.select().from(orderPayments).where(and(
            eq(orderPayments.order_id, order.id),
            eq(orderPayments.kind, "payment"),
          ));
          if (originalPayments.length === 0) throw new Error("Paid order has no immutable payment records");
          for (const original of originalPayments) {
            const [refund] = await tx.insert(orderPayments).values({
              order_id: order.id,
              shift_id: shift.id,
              payment_method_id: original.payment_method_id,
              kind: "refund",
              amount: original.amount,
              change_amount: 0,
              original_payment_id: original.id,
              created_by: ctx.user.id,
            }).returning();
            const originalTransaction = await tx.query.transactions.findFirst({ where: eq(transactions.order_payment_id, original.id) });
            await tx.insert(transactions).values({
              order_id: order.id,
              shift_id: shift.id,
              order_payment_id: refund.id,
              original_transaction_id: originalTransaction?.id ?? null,
              payment_method_id: original.payment_method_id,
              amount: original.amount,
              user_uid: ctx.user.id,
              type: "expense",
              category: "refund",
              status: "completed",
              description: `Full payment reversal for order #${order.id}: ${input.reason}`,
            });
            refundedAmount += original.amount;
          }
        }

        await tx.update(orders).set({
          status: "cancelled",
          payment_status: wasPaid ? "refunded" : "unpaid",
          updated_at: new Date(),
        }).where(eq(orders.id, order.id));
        await tx.insert(orderStatusHistory).values({
          order_id: order.id,
          from_status: current.status,
          to_status: "cancelled",
          changed_by: ctx.user.id,
          note: input.reason,
        });
        if (current.dining_table_id) {
          await tx.update(restaurantTables).set({ status: "available" }).where(eq(restaurantTables.id, current.dining_table_id));
        }
        await tx.insert(auditLogs).values({
          branch_id: order.branch_id, shift_id: shift?.id ?? null, order_id: order.id,
          actor_user_id: ctx.user.id, approver_user_id: ctx.user.id,
          action: wasPaid ? "order.payment_reversal" : "order.cancel",
          entity_type: "order_cancellation", entity_id: String(cancellation.id),
          reason: input.reason, details: JSON.stringify({ wasPaid, refundedAmount }),
        });
        return { orderId: order.id, paymentStatus: wasPaid ? "refunded" as const : "unpaid" as const, refundedAmount };
      });
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
