import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, purchaseOrderLines, purchaseOrders } from "@/lib/db/schema";

export async function submitPurchaseOrder(input: { branchId: number; purchaseOrderId: number }, actorId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(purchaseOrders).where(and(
      eq(purchaseOrders.id, input.purchaseOrderId),
      eq(purchaseOrders.branch_id, input.branchId),
    )).for("update");
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
    if (order.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only draft purchase orders can be submitted" });
    const [line] = await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchase_order_id, order.id)).limit(1);
    if (!line || order.total_amount <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A purchase order must contain priced lines before submission" });
    const [updated] = await tx.update(purchaseOrders).set({ status: "submitted", submitted_by: actorId, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
    await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: actorId, action: "purchase_order.submit", entity_type: "purchase_order", entity_id: String(order.id) });
    return updated;
  });
}

export async function approvePurchaseOrder(input: { branchId: number; purchaseOrderId: number }, actorId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(purchaseOrders).where(and(
      eq(purchaseOrders.id, input.purchaseOrderId),
      eq(purchaseOrders.branch_id, input.branchId),
    )).for("update");
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
    if (order.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only submitted purchase orders can be approved" });
    const [updated] = await tx.update(purchaseOrders).set({ status: "approved", approved_by: actorId, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
    await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: actorId, approver_user_id: actorId, action: "purchase_order.approve", entity_type: "purchase_order", entity_id: String(order.id) });
    return updated;
  });
}

export async function cancelPurchaseOrder(input: { branchId: number; purchaseOrderId: number; reason: string }, actorId: string) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(purchaseOrders).where(and(
      eq(purchaseOrders.id, input.purchaseOrderId),
      eq(purchaseOrders.branch_id, input.branchId),
    )).for("update");
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
    if (order.status === "cancelled" || order.status === "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This purchase order cannot be cancelled" });
    const [updated] = await tx.update(purchaseOrders).set({ status: "cancelled", cancelled_by: actorId, cancellation_reason: input.reason, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
    await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: actorId, action: "purchase_order.cancel", entity_type: "purchase_order", entity_id: String(order.id), reason: input.reason });
    return updated;
  });
}
