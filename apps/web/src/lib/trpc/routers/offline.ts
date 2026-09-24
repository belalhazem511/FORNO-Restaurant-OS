import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { auditLogs, offlineSyncRecords, staffAssignments } from "@/lib/db/schema";
import { protectedProcedure, router } from "../init";
import { loadOfflineBootstrap } from "./offline/bootstrap";
import {
  conflictCategory,
  OfflineConflict,
  offlineOperationSchema,
  type OfflineSyncInput,
} from "./offline/contracts";
import {
  findExistingOfflineResult,
  recordOfflineConflict,
  synchronizeOfflineOperation,
} from "./offline/synchronization";

export {
  OFFLINE_CONFLICT_CODES,
  OFFLINE_SNAPSHOT_MAX_AGE_MS,
  OFFLINE_SNAPSHOT_STALE_MS,
  offlinePriceSnapshotTtlMs,
} from "./offline/contracts";
export type { OfflineConflictCode, OfflineSyncInput } from "./offline/contracts";

export const offlineRouter = router({
  health: protectedProcedure.input(z.void()).query(({ ctx }) => ({ ok: true as const, userId: ctx.user.id, serverTime: new Date() })),

  bootstrap: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ ctx, input }) => loadOfflineBootstrap(ctx.user.id, input.branchId)),

  sync: protectedProcedure
    .input(offlineOperationSchema)
    .mutation(async ({ ctx, input }) => {
      const prior = await findExistingOfflineResult(input.clientOperationId, ctx.user.id);
      if (prior?.status === "accepted" || prior?.status === "needs_review") return prior;
      const reviewed = await db.query.offlineSyncRecords.findFirst({ where: and(eq(offlineSyncRecords.client_operation_id, input.clientOperationId), eq(offlineSyncRecords.status, "resolved")) });
      try {
        return await synchronizeOfflineOperation(input, ctx.user.id, { approved: Boolean(reviewed?.resolved_by), reason: reviewed?.resolution_reason ?? null, approverUserId: reviewed?.resolved_by ?? null });
      } catch (cause) {
        if (!(cause instanceof OfflineConflict)) throw cause;
        const record = await recordOfflineConflict(input, ctx.user.id, cause);
        return {
          status: "needs_review" as const,
          duplicate: false,
          operationId: input.clientOperationId,
          orderId: null,
          checkoutId: null,
          receiptJobId: null,
          conflict: { code: cause.code, category: conflictCategory(cause.code), message: cause.message, recordId: record?.id ?? null },
        };
      }
    }),

  center: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.branch_id, input.branchId), eq(staffAssignments.is_active, true)) });
      if (!assignment) throw new TRPCError({ code: "FORBIDDEN", message: "No active branch assignment" });
      const canReviewBranch = ["owner", "admin", "manager"].includes(assignment.role);
      return db.query.offlineSyncRecords.findMany({ where: canReviewBranch ? eq(offlineSyncRecords.branch_id, input.branchId) : and(eq(offlineSyncRecords.branch_id, input.branchId), eq(offlineSyncRecords.actor_user_id, ctx.user.id)), orderBy: (records, { desc }) => desc(records.updated_at), limit: input.limit });
    }),

  resolveReview: protectedProcedure
    .input(z.object({ recordId: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const record = await db.query.offlineSyncRecords.findFirst({ where: eq(offlineSyncRecords.id, input.recordId) });
      if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Offline review record not found" });
      const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.branch_id, record.branch_id), eq(staffAssignments.is_active, true)) });
      if (!assignment || !["owner", "admin", "manager"].includes(assignment.role)) throw new TRPCError({ code: "FORBIDDEN", message: "Manager or Owner/Admin review is required" });
      if (record.status !== "needs_review") throw new TRPCError({ code: "CONFLICT", message: "This operation is not awaiting review" });
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(offlineSyncRecords).set({ status: "resolved", resolved_by: ctx.user.id, resolution_reason: input.reason, resolved_at: new Date(), updated_at: new Date() }).where(and(eq(offlineSyncRecords.id, record.id), eq(offlineSyncRecords.status, "needs_review"))).returning();
        if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Review record changed concurrently" });
        await tx.insert(auditLogs).values({ branch_id: record.branch_id, shift_id: record.shift_id, order_id: record.order_id, actor_user_id: record.actor_user_id, approver_user_id: ctx.user.id, action: "offline.sync.review_resolved", entity_type: "offline_sync_record", entity_id: String(record.id), reason: input.reason, details: JSON.stringify({ conflictCode: record.conflict_code }) });
        return { id: updated.id, status: updated.status };
      });
    }),
});
