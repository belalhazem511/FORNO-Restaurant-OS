import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  auditLogs, branches, ingredients, inventoryLocations, purchaseOrderLines, purchaseOrders,
  purchaseReceiptLines, purchaseReceipts, stockBalances, stockMovements, staffAssignments,
  supplierReturnLines, supplierReturnReversals, supplierReturnStatusHistory, supplierReturns,
  suppliers, unitsOfMeasure,
  syncDevices,
} from "@/lib/db/schema";
import { costMinorForQuantity, convertScaledQuantity, movingWeightedAverage } from "@/lib/inventory/exact";
import { hasPermission, requireStaff, type Permission } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";
import { ensureLocalGlobalMapping, executeLocalCommand } from "@/lib/sync/local-command";

const branchInput = z.object({ branchId: z.number().int().positive() });
const MAX_INT = 2_147_483_647;
const statusKey = z.string().trim().min(8).max(140);
const lineInput = z.object({ receiptLineId: z.number().int().positive(), quantityScaled: z.number().int().positive(), notes: z.string().trim().max(500).nullable().optional() });
const metadataInput = z.array(z.object({ name: z.string().trim().min(1).max(180), mediaType: z.string().trim().max(100).optional(), reference: z.string().trim().min(1).max(500) })).max(20);
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function safeAdd(a: number, b: number, label: string, max = Number.MAX_SAFE_INTEGER) {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} exceeds the exact supported range` });
  return result;
}

function convertReturnQuantity(quantityScaled: number, numerator: number, denominator: number, dimension: "mass" | "volume" | "count") {
  try { return convertScaledQuantity({ quantityScaled, fromDimension: dimension, toDimension: dimension, factor: { numerator, denominator } }); }
  catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The saved source conversion is invalid; the return needs review" }); }
}

async function authorize(userId: string, branchId: number, permission: Permission) {
  try { return await requireStaff(userId, branchId, permission); }
  catch (error) {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId), columns: { id: true } });
    if (branch) await db.insert(auditLogs).values({ branch_id: branchId, actor_user_id: userId, action: "supplier_return.permission_denied", entity_type: "supplier_return_access", entity_id: String(branchId), reason: permission });
    throw error;
  }
}

async function audit(tx: DbTransaction, branchId: number, actorId: string, action: string, returnId: number, reason?: string, details?: unknown) {
  await tx.insert(auditLogs).values({ branch_id: branchId, actor_user_id: actorId, action, entity_type: "supplier_return", entity_id: String(returnId), reason: reason ?? null, details: details == null ? null : JSON.stringify(details) });
}

async function queueReturnCommand(
  tx: DbTransaction,
  input: { branchId: number; userId: string; returnId: number; action: string; idempotencyKey: string; payload: (globalId: string, baseRevision: number) => Record<string, unknown> },
) {
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
  if (process.env.FORNO_DESKTOP_MODE !== "1" || !deviceId) return;
  const device = await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
  if (!device) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The local synchronization identity is unavailable" });
  if (device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Supplier returns must use the paired device branch" });
  const row = await tx.query.supplierReturns.findFirst({ where: and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId)) });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
  const receipt = await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_receipt", localId: row.receipt_id });
  const returnMapping = await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "supplier_return", localId: input.returnId });
  await executeLocalCommand(tx, {
    actorId: input.userId, domain: "supplier_returns", action: input.action, entityType: "supplier_return", localId: () => String(input.returnId), idempotencyKey: input.idempotencyKey,
    dependsOnGlobalIds: () => [receipt.global_id], payload: (globalId) => input.payload(globalId, returnMapping.server_revision),
  }, async () => input.returnId);
}

async function addHistory(tx: DbTransaction, input: { row: typeof supplierReturns.$inferSelect; from: string | null; to: typeof supplierReturns.$inferSelect.status; actorId: string; key: string; reason?: string | null }) {
  await tx.insert(supplierReturnStatusHistory).values({ supplier_return_id: input.row.id, branch_id: input.row.branch_id, from_status: input.from, to_status: input.to, actor_user_id: input.actorId, idempotency_key: input.key, reason: input.reason ?? null });
}

async function returnBundle(returnId: number, branchId: number, revealCost: boolean) {
  const row = await db.query.supplierReturns.findFirst({ where: and(eq(supplierReturns.id, returnId), eq(supplierReturns.branch_id, branchId)), with: { lines: { orderBy: [asc(supplierReturnLines.id)] }, statusHistory: { orderBy: [asc(supplierReturnStatusHistory.created_at)] }, reversals: true } });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
  const [supplier, order, receipt, location] = await Promise.all([
    db.query.suppliers.findFirst({ where: eq(suppliers.id, row.supplier_id), columns: { id: true, code: true, name_en: true, name_ar: true } }),
    db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, row.purchase_order_id), columns: { id: true, po_number: true, status: true } }),
    db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, row.receipt_id), columns: { id: true, receipt_number: true, status: true } }),
    db.query.inventoryLocations.findFirst({ where: eq(inventoryLocations.id, row.location_id), columns: { id: true, name_en: true, name_ar: true } }),
  ]);
  const lines = await Promise.all(row.lines.map(async (line) => {
    const [receiptLine, ingredient, unit, balance] = await Promise.all([
      db.query.purchaseReceiptLines.findFirst({ where: eq(purchaseReceiptLines.id, line.receipt_line_id), columns: { id: true, accepted_quantity_base: true, conversion_numerator_snapshot: true, conversion_denominator_snapshot: true, accepted_unit_cost_micros_snapshot: true, unit_code_snapshot: true } }),
      db.query.ingredients.findFirst({ where: eq(ingredients.id, line.ingredient_id), columns: { dimension: true } }),
      db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id), columns: { code: true } }),
      db.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id), sql`${stockBalances.quantity_base} >= 0`) }),
    ]);
    return {
      ...line,
      ingredient_dimension: ingredient?.dimension ?? "mass",
      unit_code: unit?.code ?? line.unit_code_snapshot,
      source_receipt_line: receiptLine,
      current_on_hand_base: balance?.quantity_base ?? 0,
      current_unit_cost_micros: revealCost ? (balance?.average_unit_cost_micros ?? 0) : null,
      ...(revealCost ? {} : { original_unit_cost_micros_snapshot: null, expected_credit_amount: null, dispatch_unit_cost_micros_snapshot: null, dispatch_valuation_amount: null }),
    };
  }));
  return {
    ...row,
    ...(revealCost ? {} : { expected_credit_amount: null, valuation_amount: null, cost_variance_amount: null }),
    supplier, purchaseOrder: order, receipt, location, lines,
  };
}

async function returnableRows<T extends typeof db | DbTransaction>(executor: T, receiptId: number, branchId: number, excludeReturnId?: number) {
  const [receipt, lines, returns] = await Promise.all([
    executor.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, receiptId), eq(purchaseReceipts.branch_id, branchId)), with: { purchaseOrder: true, supplier: true, location: true } }),
    executor.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receiptId), orderBy: [asc(purchaseReceiptLines.id)] }),
    executor.query.supplierReturns.findMany({ where: and(eq(supplierReturns.receipt_id, receiptId), sql`${supplierReturns.id} <> ${excludeReturnId ?? 0}`), with: { lines: true } }),
  ]);
  if (!receipt || receipt.status !== "posted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Returns require a posted, unreversed source receipt" });
  const posted = new Map<number, number>();
  const reserved = new Map<number, number>();
  for (const row of returns) {
    for (const line of row.lines) {
      if (row.status === "dispatched") posted.set(line.receipt_line_id, safeAdd(posted.get(line.receipt_line_id) ?? 0, line.quantity_base, "Previously returned quantity"));
      if (row.status === "submitted" || row.status === "approved") reserved.set(line.receipt_line_id, safeAdd(reserved.get(line.receipt_line_id) ?? 0, line.quantity_base, "Reserved return quantity"));
    }
  }
  return { receipt, lines, posted, reserved };
}

function validateSnapshot(returnLine: typeof supplierReturnLines.$inferSelect, sourceLine: typeof purchaseReceiptLines.$inferSelect) {
  return returnLine.ingredient_id === sourceLine.ingredient_id
    && returnLine.unit_id === sourceLine.unit_id
    && returnLine.package_conversion_id === sourceLine.package_conversion_id
    && returnLine.conversion_numerator_snapshot === sourceLine.conversion_numerator_snapshot
    && returnLine.conversion_denominator_snapshot === sourceLine.conversion_denominator_snapshot
    && returnLine.accepted_quantity_base_snapshot === sourceLine.accepted_quantity_base
    && returnLine.original_unit_cost_micros_snapshot === sourceLine.accepted_unit_cost_micros_snapshot
    && returnLine.quantity_base > 0
    && returnLine.quantity_base <= sourceLine.accepted_quantity_base;
}

export const supplierReturnsRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)) });
    if (!assignment) throw new TRPCError({ code: "FORBIDDEN", message: "No active staff assignment" });
    await authorize(ctx.user.id, assignment.branch_id, "supplier-return:view");
    return {
      branchId: assignment.branch_id,
      canCreate: hasPermission(assignment.role, "supplier-return:create"),
      canSubmit: hasPermission(assignment.role, "supplier-return:submit"),
      canApprove: hasPermission(assignment.role, "supplier-return:approve"),
      canDispatch: hasPermission(assignment.role, "supplier-return:dispatch"),
      canCancel: hasPermission(assignment.role, "supplier-return:cancel"),
      canReverse: hasPermission(assignment.role, "supplier-return:reverse"),
      canResolve: hasPermission(assignment.role, "supplier-return:resolve"),
      canViewCosts: hasPermission(assignment.role, "supplier-return:cost:view"),
    };
  }),

  sourceReceipts: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    const assignment = await authorize(ctx.user.id, input.branchId, "supplier-return:view");
    const sources = await db.query.purchaseReceipts.findMany({ where: and(eq(purchaseReceipts.branch_id, input.branchId), eq(purchaseReceipts.status, "posted")), with: { lines: { orderBy: [asc(purchaseReceiptLines.id)] }, supplier: true, purchaseOrder: true, location: true }, orderBy: [desc(purchaseReceipts.posted_at)] });
    const withAvailability = await Promise.all(sources.map(async (source) => {
      const { posted, reserved } = await returnableRows(db, source.id, input.branchId);
      const visibleLines = await Promise.all(source.lines.filter((line) => line.accepted_quantity_base > 0).map(async (line) => {
        const ingredient = await db.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, input.branchId)), columns: { dimension: true } });
        return {
          id: line.id,
          ingredient_id: line.ingredient_id,
          ingredient_name_en: line.ingredient_name_en_snapshot,
          ingredient_name_ar: line.ingredient_name_ar_snapshot,
          dimension: ingredient?.dimension ?? "mass",
          unit_code: line.unit_code_snapshot,
          conversion_numerator_snapshot: line.conversion_numerator_snapshot,
          conversion_denominator_snapshot: line.conversion_denominator_snapshot,
          accepted_quantity_base: line.accepted_quantity_base,
          previously_returned_base: posted.get(line.id) ?? 0,
          reserved_base: reserved.get(line.id) ?? 0,
          returnable_base: Math.max(0, line.accepted_quantity_base - (posted.get(line.id) ?? 0) - (reserved.get(line.id) ?? 0)),
          original_unit_cost_micros: hasPermission(assignment.role, "supplier-return:cost:view") ? line.accepted_unit_cost_micros_snapshot : null,
        };
      }));
      return { id: source.id, receipt_number: source.receipt_number, received_at: source.received_at, location: source.location, supplier: source.supplier, purchaseOrder: source.purchaseOrder, lines: visibleLines };
    }));
    return withAvailability.filter((source) => source.lines.some((line) => line.returnable_base > 0));
  }),

  list: protectedProcedure.input(branchInput.extend({ supplierId: z.number().int().positive().optional(), purchaseOrderId: z.number().int().positive().optional(), receiptId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
    const assignment = await authorize(ctx.user.id, input.branchId, "supplier-return:view");
    const rows = await db.query.supplierReturns.findMany({ where: and(eq(supplierReturns.branch_id, input.branchId), input.supplierId ? eq(supplierReturns.supplier_id, input.supplierId) : undefined, input.purchaseOrderId ? eq(supplierReturns.purchase_order_id, input.purchaseOrderId) : undefined, input.receiptId ? eq(supplierReturns.receipt_id, input.receiptId) : undefined), orderBy: [desc(supplierReturns.created_at)] });
    return assignment.role === "cashier" ? [] : rows.map((row) => assignment.role === "owner" || assignment.role === "admin" || assignment.role === "manager" ? row : { ...row, expected_credit_amount: null, valuation_amount: null, cost_variance_amount: null });
  }),

  detail: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const assignment = await authorize(ctx.user.id, input.branchId, "supplier-return:view");
    return returnBundle(input.returnId, input.branchId, hasPermission(assignment.role, "supplier-return:cost:view"));
  }),

  createDraft: protectedProcedure.input(branchInput.extend({
    receiptId: z.number().int().positive(), returnNumber: z.string().trim().min(3).max(48),
    reasonCode: z.enum(["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"]),
    reason: z.string().trim().max(500).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
    evidenceMetadata: metadataInput.optional(), idempotencyKey: statusKey, lines: z.array(lineInput).min(1),
  }).refine((input) => input.reasonCode !== "other" || !!input.reason?.trim(), "Describe the return reason" )).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:create");
    const existing = await db.query.supplierReturns.findFirst({ where: eq(supplierReturns.idempotency_key, input.idempotencyKey) });
    if (existing) {
      if (existing.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
      return returnBundle(existing.id, input.branchId, true);
    }
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Supplier returns must use the paired device branch" });
      const receiptMapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_receipt", localId: input.receiptId }) : undefined;
      let commandLines: Array<{ receiptLineIndex: number; quantityScaled: number; notes: string | null }> = [];
      return executeLocalCommand<typeof supplierReturns.$inferSelect>(tx, {
        actorId: ctx.user.id, domain: "supplier_returns", action: "return_create", entityType: "supplier_return", localId: (row) => String(row.id), idempotencyKey: input.idempotencyKey,
        dependsOnGlobalIds: () => [receiptMapping?.global_id].filter((id): id is string => Boolean(id)),
        payload: (supplierReturnGlobalId) => ({ supplierReturnGlobalId, receiptGlobalId: receiptMapping?.global_id, returnNumber: input.returnNumber, reasonCode: input.reasonCode, reason: input.reason ?? null, notes: input.notes ?? null, evidenceMetadata: input.evidenceMetadata ?? [], lines: commandLines }),
      }, async (tx) => {
      const source = await tx.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.branch_id, input.branchId)), with: { lines: true, supplier: true, purchaseOrder: true } });
      if (!source || source.status !== "posted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Returns require a posted, unreversed receipt in this branch" });
      const sourceLineIndex = new Map(source.lines.map((line, index) => [line.id, index]));
      const sourceLines = new Map(source.lines.map((line) => [line.id, line]));
      const seen = new Set<number>();
      let credit = 0;
      const prepared = [];
      for (const line of input.lines) {
        if (seen.has(line.receiptLineId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A source receipt line may appear only once" });
        seen.add(line.receiptLineId);
        const sourceLine = sourceLines.get(line.receiptLineId);
        if (!sourceLine || sourceLine.accepted_quantity_base <= 0 || sourceLine.conversion_numerator_snapshot <= 0 || sourceLine.conversion_denominator_snapshot <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The source receipt line is invalid; create no return from it" });
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, sourceLine.ingredient_id), eq(ingredients.branch_id, input.branchId)) });
        if (!ingredient) throw new TRPCError({ code: "NOT_FOUND", message: "Source ingredient is outside this branch" });
        const quantityBase = convertReturnQuantity(line.quantityScaled, sourceLine.conversion_numerator_snapshot, sourceLine.conversion_denominator_snapshot, ingredient.dimension);
        if (quantityBase <= 0 || quantityBase > sourceLine.accepted_quantity_base) throw new TRPCError({ code: "BAD_REQUEST", message: "Return quantity must not exceed the accepted source quantity" });
        const expectedCredit = costMinorForQuantity(quantityBase, sourceLine.accepted_unit_cost_micros_snapshot);
        credit = safeAdd(credit, expectedCredit, "Expected supplier credit", MAX_INT);
        prepared.push({ sourceLine, ingredient, input: line, quantityBase, expectedCredit });
      }
      commandLines = prepared.map((line) => ({ receiptLineIndex: sourceLineIndex.get(line.sourceLine.id)!, quantityScaled: line.input.quantityScaled, notes: line.input.notes ?? null }));
      const [created] = await tx.insert(supplierReturns).values({
        branch_id: input.branchId, supplier_id: source.supplier_id, purchase_order_id: source.purchase_order_id,
        receipt_id: source.id, location_id: source.location_id, return_number: input.returnNumber,
        supplier_code_snapshot: source.supplier_code_snapshot, supplier_name_en_snapshot: source.supplier_name_en_snapshot,
        supplier_name_ar_snapshot: source.supplier_name_ar_snapshot, po_number_snapshot: source.po_number_snapshot,
        receipt_number_snapshot: source.receipt_number, reason_code: input.reasonCode, reason: input.reason ?? null,
        notes: input.notes ?? null, evidence_metadata: input.evidenceMetadata ? JSON.stringify(input.evidenceMetadata) : null,
        status: "draft", idempotency_key: input.idempotencyKey, expected_credit_amount: credit, created_by: ctx.user.id,
      }).onConflictDoNothing({ target: supplierReturns.idempotency_key }).returning();
      if (!created) {
        const dup = await tx.query.supplierReturns.findFirst({ where: eq(supplierReturns.idempotency_key, input.idempotencyKey) });
        if (dup && dup.branch_id === input.branchId) return dup;
        throw new TRPCError({ code: "CONFLICT", message: "Return number or idempotency key is already in use" });
      }
      await tx.insert(supplierReturnLines).values(prepared.map(({ sourceLine, ingredient, input: line, quantityBase, expectedCredit }) => ({
        supplier_return_id: created.id, receipt_line_id: sourceLine.id, ingredient_id: ingredient.id,
        ingredient_sku_snapshot: sourceLine.ingredient_sku_snapshot, ingredient_name_en_snapshot: sourceLine.ingredient_name_en_snapshot,
        ingredient_name_ar_snapshot: sourceLine.ingredient_name_ar_snapshot, dimension_snapshot: ingredient.dimension, unit_id: sourceLine.unit_id,
        unit_code_snapshot: sourceLine.unit_code_snapshot, package_conversion_id: sourceLine.package_conversion_id,
        conversion_numerator_snapshot: sourceLine.conversion_numerator_snapshot, conversion_denominator_snapshot: sourceLine.conversion_denominator_snapshot,
        quantity_input_scaled: line.quantityScaled, quantity_base: quantityBase,
        accepted_quantity_base_snapshot: sourceLine.accepted_quantity_base,
        original_unit_cost_micros_snapshot: sourceLine.accepted_unit_cost_micros_snapshot,
        expected_credit_amount: expectedCredit, notes: line.notes ?? null,
      })));
      await addHistory(tx, { row: created, from: null, to: "draft", actorId: ctx.user.id, key: `${input.idempotencyKey}:created` });
      await audit(tx, input.branchId, ctx.user.id, "supplier_return.create", created.id, undefined, { receiptId: source.id, lineCount: prepared.length, lines: prepared.map(({ sourceLine, quantityBase, expectedCredit }) => ({ receiptLineId: sourceLine.id, quantityBase, expectedCreditMinor: expectedCredit })) });
      return created;
      });
    });
  }),

  editDraft: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reasonCode: z.enum(["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"]).optional(), reason: z.string().trim().max(500).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(), evidenceMetadata: metadataInput.optional(), lines: z.array(lineInput).min(1) })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:create");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId))).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
      if (row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Draft returns can be edited; submitted lines are immutable" });
      const oldLines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.receipt_line_id)] });
      const byReceipt = new Map(oldLines.map((line) => [line.receipt_line_id, line]));
      const seen = new Set<number>();
      const editedLineDetails: Array<{ receiptLineId: number; quantityBase: number; expectedCreditMinor: number }> = [];
      let credit = 0;
      for (const line of input.lines) {
        if (seen.has(line.receiptLineId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A source receipt line may appear only once" });
        seen.add(line.receiptLineId);
        const saved = byReceipt.get(line.receiptLineId);
        if (!saved) throw new TRPCError({ code: "BAD_REQUEST", message: "Draft edits cannot add receipt lines; create a new return" });
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, saved.ingredient_id), eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true)) });
        if (!ingredient || ingredient.dimension !== saved.dimension_snapshot) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source ingredient dimension snapshot needs review" });
        const quantityBase = convertReturnQuantity(line.quantityScaled, saved.conversion_numerator_snapshot, saved.conversion_denominator_snapshot, ingredient.dimension);
        if (quantityBase <= 0 || quantityBase > saved.accepted_quantity_base_snapshot) throw new TRPCError({ code: "BAD_REQUEST", message: "Return quantity exceeds the source accepted quantity" });
        const expected = costMinorForQuantity(quantityBase, saved.original_unit_cost_micros_snapshot);
        credit = safeAdd(credit, expected, "Expected supplier credit", MAX_INT);
        editedLineDetails.push({ receiptLineId: saved.receipt_line_id, quantityBase, expectedCreditMinor: expected });
        await tx.update(supplierReturnLines).set({ quantity_input_scaled: line.quantityScaled, quantity_base: quantityBase, expected_credit_amount: expected, notes: line.notes ?? null }).where(eq(supplierReturnLines.id, saved.id));
      }
      if (seen.size !== oldLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Keep every source line or create a new draft return" });
      const reasonCode = input.reasonCode ?? row.reason_code;
      const reason = input.reason === undefined ? row.reason : input.reason;
      if (reasonCode === "other" && !reason?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Describe the return reason" });
      await tx.update(supplierReturns).set({ reason_code: reasonCode, reason, notes: input.notes === undefined ? row.notes : input.notes, evidence_metadata: input.evidenceMetadata ? JSON.stringify(input.evidenceMetadata) : row.evidence_metadata, expected_credit_amount: credit, updated_at: new Date() }).where(eq(supplierReturns.id, row.id));
      await audit(tx, input.branchId, ctx.user.id, "supplier_return.draft_update", row.id, reason ?? undefined, { lineCount: seen.size, lines: editedLineDetails });
      const receiptLineIndex = new Map(oldLines.map((line, index) => [line.receipt_line_id, index]));
      await queueReturnCommand(tx, { branchId: input.branchId, userId: ctx.user.id, returnId: row.id, action: "return_edit", idempotencyKey: randomUUID(), payload: (globalId, baseRevision) => ({ supplierReturnGlobalId: globalId, baseRevision, reasonCode, reason, notes: input.notes === undefined ? row.notes : input.notes, evidenceMetadata: input.evidenceMetadata ?? null, quantities: input.lines.map((line) => ({ lineIndex: receiptLineIndex.get(line.receiptLineId)!, quantityScaled: line.quantityScaled, notes: line.notes ?? null })) }) });
      return row.id;
    }).then((id) => returnBundle(id, input.branchId, true));
  }),

  submit: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().max(500).optional(), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:submit");
    return transition({ userId: ctx.user.id, branchId: input.branchId, returnId: input.returnId, to: "submitted", key: input.idempotencyKey, reason: input.reason });
  }),

  approve: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:approve");
    return transition({ userId: ctx.user.id, branchId: input.branchId, returnId: input.returnId, to: "approved", key: input.idempotencyKey, reason: input.reason });
  }),

  dispatch: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().min(3).max(500).optional(), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:dispatch");
    return dispatchReturn({ branchId: input.branchId, returnId: input.returnId, userId: ctx.user.id, reason: input.reason, key: input.idempotencyKey });
  }),

  cancel: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:cancel");
    return transition({ userId: ctx.user.id, branchId: input.branchId, returnId: input.returnId, to: "cancelled", key: input.idempotencyKey, reason: input.reason });
  }),

  reverseDispatch: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:reverse");
    return reverseDispatch({ branchId: input.branchId, returnId: input.returnId, userId: ctx.user.id, reason: input.reason, key: input.idempotencyKey });
  }),

  resolveNeedsReview: protectedProcedure.input(branchInput.extend({ returnId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: statusKey })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "supplier-return:resolve");
    return transition({ userId: ctx.user.id, branchId: input.branchId, returnId: input.returnId, to: "cancelled", key: input.idempotencyKey, reason: input.reason, fromAllowed: ["needs_review"] });
  }),
});

async function transition(input: { userId: string; branchId: number; returnId: number; to: "submitted" | "approved" | "cancelled"; key: string; reason?: string; fromAllowed?: string[] }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
    const duplicate = await tx.query.supplierReturnStatusHistory.findFirst({ where: eq(supplierReturnStatusHistory.idempotency_key, input.key) });
    if (duplicate) {
      if (duplicate.branch_id !== input.branchId || duplicate.supplier_return_id !== input.returnId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
      const [existing] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId)));
      return existing;
    }
    if (input.to === "submitted") {
      if (row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Draft returns can be submitted" });
      await tx.execute(sql`select id from purchase_receipts where id = ${row.receipt_id} and branch_id = ${input.branchId} for update`);
      const source = await tx.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, row.receipt_id), eq(purchaseReceipts.branch_id, input.branchId)), with: { lines: true } });
      const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id) });
      if (!source || source.status !== "posted") return await markReturnNeedsReview(tx, row, input.userId, input.key, "Source receipt is no longer posted");
      const sourceById = new Map(source.lines.map((line) => [line.id, line]));
      for (const line of lines) {
        const sourceLine = sourceById.get(line.receipt_line_id);
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, input.branchId)), columns: { dimension: true } });
        if (!sourceLine || !validateSnapshot(line, sourceLine) || ingredient?.dimension !== line.dimension_snapshot) return await markReturnNeedsReview(tx, row, input.userId, input.key, "Source receipt conversion, ingredient dimension, accepted quantity, or cost snapshot changed");
      }
      const { posted, reserved } = await returnableRows(tx, row.receipt_id, input.branchId, row.id);
      for (const line of lines) {
        const sourceLine = sourceById.get(line.receipt_line_id)!;
        const free = Math.max(0, sourceLine.accepted_quantity_base - (posted.get(line.receipt_line_id) ?? 0) - (reserved.get(line.receipt_line_id) ?? 0));
        if (line.quantity_base > free) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Return quantity exceeds the remaining returnable source receipt quantity" });
      }
    } else if (input.to === "approved") {
      if (row.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Submitted returns can be approved" });
    } else if (!(input.fromAllowed?.includes(row.status) ?? ["draft", "submitted", "approved", "needs_review"].includes(row.status))) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pre-dispatch returns can be cancelled" });
    }
    if (input.to === "cancelled" && row.status === "needs_review") {
      const reversal = await tx.query.supplierReturnReversals.findFirst({ where: and(eq(supplierReturnReversals.supplier_return_id, row.id), eq(supplierReturnReversals.status, "needs_review")) });
      if (reversal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A dispatched return with an unsafe reversal must remain in Needs Review for inventory reconciliation" });
    }
    const now = new Date();
    const patch = input.to === "submitted" ? { status: "submitted" as const, submitted_by: input.userId, submitted_at: now }
      : input.to === "approved" ? { status: "approved" as const, approved_by: input.userId, approved_at: now }
      : { status: "cancelled" as const, cancelled_by: input.userId, cancelled_at: now, cancellation_reason: input.reason };
    const [updated] = await tx.update(supplierReturns).set({ ...patch, updated_at: now }).where(eq(supplierReturns.id, row.id)).returning();
    await addHistory(tx, { row, from: row.status, to: updated.status, actorId: input.userId, key: input.key, reason: input.reason });
    await audit(tx, input.branchId, input.userId, `supplier_return.${updated.status}`, row.id, input.reason);
    const action = input.to === "submitted" ? "return_submit" : input.to === "approved" ? "return_approve" : "return_cancel";
    await queueReturnCommand(tx, { branchId: input.branchId, userId: input.userId, returnId: row.id, action, idempotencyKey: input.key, payload: (globalId, baseRevision) => ({ supplierReturnGlobalId: globalId, baseRevision, reason: input.reason ?? null, idempotencyKey: input.key }) });
    return updated;
  });
}

async function markReturnNeedsReview(tx: DbTransaction, row: typeof supplierReturns.$inferSelect, userId: string, key: string, why: string) {
  const reason = `Needs Review: ${why}`;
  const [updated] = await tx.update(supplierReturns).set({ status: "needs_review", needs_review_reason: reason, updated_at: new Date() }).where(eq(supplierReturns.id, row.id)).returning();
  await addHistory(tx, { row, from: row.status, to: "needs_review", actorId: userId, key, reason });
  await audit(tx, row.branch_id, userId, "supplier_return.needs_review", row.id, reason);
  return updated;
}

async function dispatchReturn(input: { branchId: number; returnId: number; userId: string; reason?: string; key: string }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
    const duplicate = await tx.query.supplierReturnStatusHistory.findFirst({ where: eq(supplierReturnStatusHistory.idempotency_key, input.key) });
    if (duplicate) {
      if (duplicate.branch_id !== input.branchId || duplicate.supplier_return_id !== input.returnId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
      const [existing] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId)));
      return existing;
    }
    if (row.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Approved returns can be dispatched" });
    await tx.execute(sql`select id from purchase_receipts where id = ${row.receipt_id} and branch_id = ${input.branchId} for update`);
    const source = await tx.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, row.receipt_id), eq(purchaseReceipts.branch_id, input.branchId)), with: { lines: true } });
    const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.id)] });
    const sourceById = new Map((source?.lines ?? []).map((line) => [line.id, line]));
    const dimensionsValid = await Promise.all(lines.map(async (line) => (await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, input.branchId), eq(ingredients.dimension, line.dimension_snapshot as "mass" | "volume" | "count")), columns: { id: true } })) != null));
    if (!source || source.status !== "posted" || lines.some((line) => { const sourceLine = sourceById.get(line.receipt_line_id); return !sourceLine || !validateSnapshot(line, sourceLine); }) || dimensionsValid.some((valid) => !valid)) {
      return await markReturnNeedsReview(tx, row, input.userId, input.key, "Source receipt or conversion/cost snapshots are invalid or no longer match");
    }
    const { posted } = await returnableRows(tx, row.receipt_id, input.branchId, row.id);
    for (const line of lines) {
      const sourceLine = sourceById.get(line.receipt_line_id)!;
      if (safeAdd(posted.get(line.receipt_line_id) ?? 0, line.quantity_base, "Returned quantity") > sourceLine.accepted_quantity_base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Return quantity exceeds the source receipt's accepted quantity" });
    }
    const totals = new Map<number, number>();
    for (const line of lines) totals.set(line.ingredient_id, safeAdd(totals.get(line.ingredient_id) ?? 0, line.quantity_base, "Dispatch quantity"));
    const ingredientIds = [...totals.keys()].sort((a, b) => a - b);
    for (const ingredientId of ingredientIds) await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${row.location_id} and ingredient_id = ${ingredientId} for update`);
    const balances = new Map<number, typeof stockBalances.$inferSelect>();
    for (const ingredientId of ingredientIds) {
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, ingredientId)) });
      if (!balance || balance.quantity_base < totals.get(ingredientId)!) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Insufficient on-hand inventory at the source location; dispatch is blocked" });
      balances.set(ingredientId, balance);
    }
    let valuationTotal = 0;
    const dispatchAuditLines = [] as Array<Record<string, number>>;
    const now = new Date();
    for (const line of lines) {
      const balance = balances.get(line.ingredient_id)!;
      const amount = costMinorForQuantity(line.quantity_base, balance.average_unit_cost_micros);
      valuationTotal = safeAdd(valuationTotal, amount, "Dispatch valuation", MAX_INT);
      dispatchAuditLines.push({ supplierReturnLineId: line.id, receiptLineId: line.receipt_line_id, quantityBase: line.quantity_base, originalUnitCostMicros: line.original_unit_cost_micros_snapshot, dispatchUnitCostMicros: balance.average_unit_cost_micros, expectedCreditMinor: line.expected_credit_amount, dispatchValuationMinor: amount });
      await tx.update(supplierReturnLines).set({ dispatch_unit_cost_micros_snapshot: balance.average_unit_cost_micros, dispatch_valuation_amount: amount }).where(eq(supplierReturnLines.id, line.id));
      await tx.insert(stockMovements).values({
        branch_id: input.branchId, location_id: row.location_id, ingredient_id: line.ingredient_id,
        movement_type: "supplier_return", direction: -1, quantity_base: line.quantity_base,
        unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: amount,
        source_type: "supplier_return", source_id: String(row.id), idempotency_key: `supplier-return-dispatch:${row.id}:line:${line.id}`,
        actor_user_id: input.userId, reason: input.reason ?? row.reason, supplier_return_id: row.id,
        supplier_return_line_id: line.id, purchase_receipt_id: row.receipt_id, purchase_receipt_line_id: line.receipt_line_id, created_at: now,
      });
    }
    for (const ingredientId of ingredientIds) {
      const balance = balances.get(ingredientId)!;
      await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - totals.get(ingredientId)!, updated_at: now }).where(eq(stockBalances.id, balance.id));
      await tx.update(ingredients).set({ average_unit_cost_micros: balance.average_unit_cost_micros, updated_by: input.userId, updated_at: now }).where(eq(ingredients.id, ingredientId));
    }
    const variance = valuationTotal - row.expected_credit_amount;
    if (!Number.isSafeInteger(variance) || Math.abs(variance) > MAX_INT) throw new TRPCError({ code: "BAD_REQUEST", message: "Return cost variance exceeds the supported EGP range" });
    const [updated] = await tx.update(supplierReturns).set({ status: "dispatched", dispatched_by: input.userId, dispatched_at: now, valuation_amount: valuationTotal, cost_variance_amount: variance, updated_at: now }).where(eq(supplierReturns.id, row.id)).returning();
    await addHistory(tx, { row, from: "approved", to: "dispatched", actorId: input.userId, key: input.key, reason: input.reason });
    await audit(tx, input.branchId, input.userId, "supplier_return.dispatch", row.id, input.reason ?? row.reason ?? undefined, { expectedCreditMinor: row.expected_credit_amount, valuationMinor: valuationTotal, varianceMinor: variance, lineCount: lines.length, lines: dispatchAuditLines });
    await queueReturnCommand(tx, { branchId: input.branchId, userId: input.userId, returnId: row.id, action: "return_dispatch", idempotencyKey: input.key, payload: (globalId, baseRevision) => ({ supplierReturnGlobalId: globalId, baseRevision, reason: input.reason ?? null, idempotencyKey: input.key }) });
    return updated;
  });
}

async function reverseDispatch(input: { branchId: number; returnId: number; userId: string; reason: string; key: string }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(supplierReturns).where(and(eq(supplierReturns.id, input.returnId), eq(supplierReturns.branch_id, input.branchId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier return not found in this branch" });
    const duplicate = await tx.query.supplierReturnReversals.findFirst({ where: eq(supplierReturnReversals.idempotency_key, input.key) });
    if (duplicate) {
      if (duplicate.branch_id !== input.branchId || duplicate.supplier_return_id !== input.returnId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
      return duplicate;
    }
    const duplicateReverse = await tx.query.supplierReturnReversals.findFirst({ where: eq(supplierReturnReversals.supplier_return_id, row.id) });
    if (duplicateReverse) return duplicateReverse;
    if (row.status !== "dispatched") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a Dispatched return can be reversed" });
    const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.id)] });
    const invalid = lines.some((line) => line.dispatch_unit_cost_micros_snapshot == null || line.dispatch_valuation_amount == null || line.quantity_base <= 0 || line.quantity_base > line.accepted_quantity_base_snapshot);
    const totals = new Map<number, number>();
    for (const line of lines) totals.set(line.ingredient_id, safeAdd(totals.get(line.ingredient_id) ?? 0, line.quantity_base, "Reversal quantity"));
    const ingredientIds = [...totals.keys()].sort((a, b) => a - b);
    for (const ingredientId of ingredientIds) await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${row.location_id} and ingredient_id = ${ingredientId} for update`);
    const balances = new Map<number, typeof stockBalances.$inferSelect>();
    let safe = !invalid;
    for (const ingredientId of ingredientIds) {
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, ingredientId)) });
      if (!balance) safe = false; else balances.set(ingredientId, balance);
      if (balance && !Number.isSafeInteger(balance.quantity_base + totals.get(ingredientId)!)) safe = false;
    }
    const finalStatus = safe ? "reversed" : "needs_review";
    const [reversal] = await tx.insert(supplierReturnReversals).values({ supplier_return_id: row.id, branch_id: input.branchId, reason: input.reason, status: finalStatus, actor_user_id: input.userId, idempotency_key: input.key }).returning();
    const now = new Date();
    if (safe) {
      for (const ingredientId of ingredientIds) {
        const balance = balances.get(ingredientId)!;
        let quantity = balance.quantity_base;
        let unitCost = balance.average_unit_cost_micros;
        for (const line of lines.filter((entry) => entry.ingredient_id === ingredientId)) {
          unitCost = movingWeightedAverage({ existingQuantity: quantity, existingUnitCostMicros: unitCost, addedQuantity: line.quantity_base, addedUnitCostMicros: line.dispatch_unit_cost_micros_snapshot! });
          quantity = safeAdd(quantity, line.quantity_base, "Reversed stock quantity");
          await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: row.location_id, ingredient_id: ingredientId, movement_type: "supplier_return_reversal", direction: 1, quantity_base: line.quantity_base, unit_cost_micros: line.dispatch_unit_cost_micros_snapshot!, total_cost_amount: line.dispatch_valuation_amount!, source_type: "supplier_return_reversal", source_id: String(reversal.id), idempotency_key: `supplier-return-reversal:${reversal.id}:line:${line.id}`, actor_user_id: input.userId, reason: input.reason, supplier_return_id: row.id, supplier_return_line_id: line.id, purchase_receipt_id: row.receipt_id, purchase_receipt_line_id: line.receipt_line_id, created_at: now });
        }
        await tx.update(stockBalances).set({ quantity_base: quantity, average_unit_cost_micros: unitCost, updated_at: now }).where(eq(stockBalances.id, balance.id));
        await tx.update(ingredients).set({ average_unit_cost_micros: unitCost, updated_by: input.userId, updated_at: now }).where(eq(ingredients.id, ingredientId));
      }
    }
    const [updated] = await tx.update(supplierReturns).set({ status: finalStatus, reversed_by: safe ? input.userId : null, reversed_at: safe ? now : null, needs_review_reason: safe ? null : "Reversal requires manual review: dispatch snapshot or destination balance is invalid", updated_at: now }).where(eq(supplierReturns.id, row.id)).returning();
    await addHistory(tx, { row, from: row.status, to: finalStatus, actorId: input.userId, key: `${input.key}:history`, reason: input.reason });
    await audit(tx, input.branchId, input.userId, safe ? "supplier_return.reverse_dispatch" : "supplier_return.needs_review", row.id, input.reason, { reversalId: reversal.id, stockRestored: safe, lines: safe ? lines.map((line) => ({ supplierReturnLineId: line.id, receiptLineId: line.receipt_line_id, quantityBase: line.quantity_base, dispatchUnitCostMicros: line.dispatch_unit_cost_micros_snapshot, dispatchValuationMinor: line.dispatch_valuation_amount })) : [] });
    await queueReturnCommand(tx, { branchId: input.branchId, userId: input.userId, returnId: row.id, action: "return_reverse", idempotencyKey: input.key, payload: (globalId, baseRevision) => ({ supplierReturnGlobalId: globalId, baseRevision, reason: input.reason, idempotencyKey: input.key }) });
    return reversal;
  });
}
