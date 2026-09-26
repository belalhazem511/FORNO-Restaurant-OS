import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { applyCancellationDisposition } from "@/lib/inventory/service";
import { auditLogs, cashierShifts, orderCancellations, orderPayments, orders, orderStatusHistory, restaurantTables, transactions } from "@/lib/db/schema";

type CancellationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cancelOrder(input: { idempotencyKey: string; reason: string; inventoryDisposition?: "returned_unused" | "prepared_discarded" }, order: typeof orders.$inferSelect, wasPaid: boolean, shift: typeof cashierShifts.$inferSelect | null, actorId: string, transaction?: CancellationTransaction) {
  const persist = async (tx: CancellationTransaction) => {
    const current = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
    if (!current || current.status === "cancelled") throw new Error("Order is already cancelled");
    const [cancellation] = await tx.insert(orderCancellations).values({
      order_id: order.id,
      shift_id: shift?.id ?? null,
      idempotency_key: input.idempotencyKey,
      reason: input.reason,
      was_paid: wasPaid,
      cancelled_by: actorId,
      approved_by: actorId,
      inventory_disposition: input.inventoryDisposition ?? null,
      inventory_resolved_by: input.inventoryDisposition ? actorId : null,
    }).returning();

    if (input.inventoryDisposition) await applyCancellationDisposition(tx, { orderId: order.id, actorUserId: actorId, disposition: input.inventoryDisposition, reason: input.reason, idempotencyKey: `${input.idempotencyKey}:inventory` });

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
          created_by: actorId,
        }).returning();
        const originalTransaction = await tx.query.transactions.findFirst({ where: eq(transactions.order_payment_id, original.id) });
        await tx.insert(transactions).values({
          order_id: order.id,
          shift_id: shift.id,
          order_payment_id: refund.id,
          original_transaction_id: originalTransaction?.id ?? null,
          payment_method_id: original.payment_method_id,
          amount: original.amount,
          user_uid: actorId,
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
      changed_by: actorId,
      note: input.reason,
    });
    if (current.dining_table_id) {
      await tx.update(restaurantTables).set({ status: "available" }).where(eq(restaurantTables.id, current.dining_table_id));
    }
    await tx.insert(auditLogs).values({
      branch_id: order.branch_id!, shift_id: shift?.id ?? null, order_id: order.id,
      actor_user_id: actorId, approver_user_id: actorId,
      action: wasPaid ? "order.payment_reversal" : "order.cancel",
      entity_type: "order_cancellation", entity_id: String(cancellation.id),
      reason: input.reason, details: JSON.stringify({ wasPaid, refundedAmount }),
    });
    return { cancellationId: cancellation.id, orderId: order.id, paymentStatus: wasPaid ? "refunded" as const : "unpaid" as const, refundedAmount };
  };
  return transaction ? persist(transaction) : db.transaction(persist);
}
