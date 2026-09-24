import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, cashierShifts, orderCheckouts, orderPayments, orders, paymentMethods, transactions } from "@/lib/db/schema";
import { calculateDiscount } from "@/lib/finance";

type Discount = { type: "percentage" | "fixed"; value: number; reason: string } | null | undefined;
type Allocation = { paymentMethodId: number; amount: number; tenderedAmount?: number | null };

export async function payOrder(input: { idempotencyKey: string; discount: Discount; payments: Allocation[] }, order: typeof orders.$inferSelect & { branch_id: number }, shift: typeof cashierShifts.$inferSelect, methodById: Map<number, typeof paymentMethods.$inferSelect>, actorId: string) {
  return db.transaction(async (tx) => {
    const lockedOrder = await tx.query.orders.findFirst({
      where: eq(orders.id, order.id),
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
      created_by: actorId,
      approved_by: input.discount ? actorId : null,
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
        created_by: actorId,
      }).returning();
      await tx.insert(transactions).values({
        order_id: lockedOrder.id,
        shift_id: shift.id,
        order_payment_id: payment.id,
        payment_method_id: method.id,
        amount: allocation.amount,
        user_uid: actorId,
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
      discount_applied_by: input.discount ? actorId : null,
      discount_approved_by: input.discount ? actorId : null,
      total_amount: payableAmount,
      payment_status: "paid",
      paid_at: new Date(),
      updated_at: new Date(),
    }).where(and(eq(orders.id, lockedOrder.id), eq(orders.payment_status, "unpaid")));

    if (input.discount) {
      await tx.insert(auditLogs).values({
        branch_id: order.branch_id, shift_id: shift.id, order_id: order.id,
        actor_user_id: actorId, approver_user_id: actorId,
        action: "order.discount", entity_type: "order", entity_id: String(order.id),
        reason: input.discount.reason,
        details: JSON.stringify({ type: input.discount.type, value: input.discount.value, amount: discountAmount, subtotal }),
      });
    }
    await tx.insert(auditLogs).values({
      branch_id: order.branch_id, shift_id: shift.id, order_id: order.id,
      actor_user_id: actorId,
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
}
