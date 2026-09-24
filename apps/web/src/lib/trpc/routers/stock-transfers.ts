import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { auditLogs, ingredients, ingredientPackageConversions, inventoryLocations, stockBalances, stockMovements, stockTransferDispatchLines, stockTransferDispatches, stockTransferLines, stockTransferReceiptLines, stockTransferReceipts, stockTransferReversals, stockTransferStatusHistory, stockTransfers, staffAssignments, unitsOfMeasure } from "@/lib/db/schema";
import { convertScaledQuantity, costMinorForQuantity, movingWeightedAverage } from "@/lib/inventory/exact";
import { hasPermission, requireStaff, type Permission } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

const branchInput = z.object({ branchId: z.number().int().positive() });
const keyInput = z.string().trim().min(8).max(120);
const MAX_INT = 2_147_483_647;
const lineInput = z.object({ ingredientId: z.number().int().positive(), unitId: z.number().int().positive(), packageConversionId: z.number().int().positive().nullable().optional(), quantityScaled: z.number().int().positive(), notes: z.string().trim().max(500).nullable().optional() });
const quantityLine = z.object({ transferLineId: z.number().int().positive(), quantityScaled: z.number().int().positive() });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function add(a: number, b: number, label: string, max = Number.MAX_SAFE_INTEGER) {
  const n = a + b;
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} exceeds the exact supported range` });
  return n;
}
async function authorize(userId: string, branchId: number, permission: Permission) {
  try { return await requireStaff(userId, branchId, permission); }
  catch (error) {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, userId), eq(staffAssignments.branch_id, branchId)) });
    if (assignment) await db.insert(auditLogs).values({ branch_id: branchId, actor_user_id: userId, action: "stock_transfer.permission_denied", entity_type: "stock_transfer_access", entity_id: String(branchId), reason: permission });
    throw error;
  }
}
async function audit(tx: Tx, branchId: number, actor: string, action: string, id: number, reason?: string, details?: unknown) {
  await tx.insert(auditLogs).values({ branch_id: branchId, actor_user_id: actor, action, entity_type: "stock_transfer", entity_id: String(id), reason: reason ?? null, details: details == null ? null : JSON.stringify(details) });
}
async function history(tx: Tx, row: typeof stockTransfers.$inferSelect, to: typeof row.status, actor: string, key: string, reason?: string) {
  await tx.insert(stockTransferStatusHistory).values({ transfer_id: row.id, branch_id: row.branch_id, from_status: row.status, to_status: to, actor_user_id: actor, idempotency_key: key, reason: reason ?? null });
}
function convert(line: typeof stockTransferLines.$inferSelect, scaled: number) {
  try { return convertScaledQuantity({ quantityScaled: scaled, fromDimension: line.dimension_snapshot as "mass" | "volume" | "count", toDimension: line.dimension_snapshot as "mass" | "volume" | "count", factor: { numerator: line.conversion_numerator_snapshot, denominator: line.conversion_denominator_snapshot } }); }
  catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transfer quantity conversion is invalid" }); }
}
async function bundle(id: number, branchId: number) {
  const row = await db.query.stockTransfers.findFirst({ where: and(eq(stockTransfers.id, id), eq(stockTransfers.branch_id, branchId)), with: { lines: { orderBy: [asc(stockTransferLines.id)] }, dispatches: { with: { lines: true } }, receipts: { with: { lines: true }, orderBy: [asc(stockTransferReceipts.created_at)] }, reversals: true, statusHistory: { orderBy: [asc(stockTransferStatusHistory.created_at)] } } });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found in this branch" });
  const lines = await Promise.all(row.lines.map(async (line) => {
    const [ingredient, unit, balance] = await Promise.all([
      db.query.ingredients.findFirst({ where: eq(ingredients.id, line.ingredient_id), columns: { dimension: true } }),
      db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id), columns: { code: true } }),
      db.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.destination_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) }),
    ]);
    const dispatch = row.dispatches[0]?.lines.find((d) => d.transfer_line_id === line.id);
    const receivedBase = row.receipts.flatMap((r) => r.lines).filter((r) => r.transfer_line_id === line.id).reduce((n, r) => add(n, r.quantity_base, "Received quantity"), 0);
    return { ...line, dimension: ingredient?.dimension ?? "mass", unit_code: unit?.code ?? line.unit_code_snapshot, dispatched_base: dispatch?.quantity_base ?? 0, received_base: receivedBase, in_transit_base: Math.max(0, (dispatch?.quantity_base ?? 0) - receivedBase), destination_on_hand_base: balance?.quantity_base ?? 0, dispatch_unit_cost_micros: dispatch?.unit_cost_micros_snapshot ?? null };
  }));
  return { ...row, lines };
}

export const stockTransfersRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)) });
    if (!assignment) throw new TRPCError({ code: "FORBIDDEN", message: "No active staff assignment" });
    await authorize(ctx.user.id, assignment.branch_id, "stock-transfer:view");
    const can = (p: Permission) => hasPermission(assignment.role, p);
    return { branchId: assignment.branch_id, canCreate: can("stock-transfer:create"), canSubmit: can("stock-transfer:submit"), canApprove: can("stock-transfer:approve"), canDispatch: can("stock-transfer:dispatch"), canReceive: can("stock-transfer:receive"), canCancel: can("stock-transfer:cancel"), canReverse: can("stock-transfer:reverse"), canResolve: can("stock-transfer:resolve") };
  }),
  locations: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:view");
    return db.query.inventoryLocations.findMany({ where: and(eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)), orderBy: [asc(inventoryLocations.code)] });
  }),
  ingredients: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:create");
    const rows = await db.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true)), orderBy: [asc(ingredients.name_en)] });
    return Promise.all(rows.map(async (ingredient) => ({ ...ingredient, baseUnit: await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, ingredient.base_unit_id) }), packageConversions: await db.query.ingredientPackageConversions.findMany({ where: eq(ingredientPackageConversions.ingredient_id, ingredient.id) }) })));
  }),
  list: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:view");
    const rows = await db.query.stockTransfers.findMany({ where: eq(stockTransfers.branch_id, input.branchId), orderBy: [desc(stockTransfers.created_at)] });
    return Promise.all(rows.map((row) => bundle(row.id, input.branchId)));
  }),
  detail: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:view");
    return bundle(input.transferId, input.branchId);
  }),
  createDraft: protectedProcedure.input(branchInput.extend({ transferNumber: z.string().trim().min(3).max(48), sourceLocationId: z.number().int().positive(), destinationLocationId: z.number().int().positive(), notes: z.string().trim().max(1000).nullable().optional(), idempotencyKey: keyInput, lines: z.array(lineInput).min(1) })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:create");
    const existing = await db.query.stockTransfers.findFirst({ where: eq(stockTransfers.idempotency_key, input.idempotencyKey) });
    if (existing) { if (existing.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return bundle(existing.id, input.branchId); }
    if (input.sourceLocationId === input.destinationLocationId) throw new TRPCError({ code: "BAD_REQUEST", message: "Source and destination must be different" });
    const [source, destination] = await Promise.all([db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.sourceLocationId), eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)) }), db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.destinationLocationId), eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)) })]);
    if (!source || !destination) throw new TRPCError({ code: "BAD_REQUEST", message: "Both active locations must belong to this branch" });
    const prepared = [] as Array<{ ingredient: typeof ingredients.$inferSelect; unit: typeof unitsOfMeasure.$inferSelect; pkg: typeof ingredientPackageConversions.$inferSelect | null; input: typeof input.lines[number]; numerator: number; denominator: number; base: number }>;
    const seen = new Set<number>();
    for (const line of input.lines) {
      if (seen.has(line.ingredientId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Use one line per ingredient" }); seen.add(line.ingredientId);
      const ingredient = await db.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredientId), eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true)) });
      const unit = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unitId) });
      const pkg = line.packageConversionId ? await db.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.id, line.packageConversionId), eq(ingredientPackageConversions.ingredient_id, line.ingredientId), eq(ingredientPackageConversions.is_active, true)) }) : null;
      if (!ingredient || !unit || unit.dimension !== ingredient.dimension || (line.packageConversionId && !pkg)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid ingredient, unit, or package conversion" });
      const numerator = pkg?.base_numerator ?? unit.base_numerator, denominator = pkg?.base_denominator ?? unit.base_denominator;
      const base = convertScaledQuantity({ quantityScaled: line.quantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator, denominator } });
      if (!base) throw new TRPCError({ code: "BAD_REQUEST", message: "Transfer quantity rounds to zero" });
      prepared.push({ ingredient, unit, pkg: pkg ?? null, input: line, numerator, denominator, base });
    }
    return db.transaction(async (tx) => {
      const byKey = await tx.query.stockTransfers.findFirst({ where: eq(stockTransfers.idempotency_key, input.idempotencyKey) });
      if (byKey) { if (byKey.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return byKey.id; }
      const duplicate = await tx.query.stockTransfers.findFirst({ where: and(eq(stockTransfers.branch_id, input.branchId), eq(stockTransfers.transfer_number, input.transferNumber)) });
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "Transfer number already exists" });
      const [row] = await tx.insert(stockTransfers).values({ branch_id: input.branchId, transfer_number: input.transferNumber, source_location_id: source.id, destination_location_id: destination.id, source_code_snapshot: source.code, source_name_en_snapshot: source.name_en, source_name_ar_snapshot: source.name_ar, destination_code_snapshot: destination.code, destination_name_en_snapshot: destination.name_en, destination_name_ar_snapshot: destination.name_ar, status: "draft", notes: input.notes ?? null, idempotency_key: input.idempotencyKey, created_by: ctx.user.id }).onConflictDoNothing({ target: stockTransfers.idempotency_key }).returning();
      if (!row) { const concurrent = await tx.query.stockTransfers.findFirst({ where: eq(stockTransfers.idempotency_key, input.idempotencyKey) }); if (!concurrent || concurrent.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return concurrent.id; }
      await tx.insert(stockTransferLines).values(prepared.map((p) => ({ transfer_id: row.id, ingredient_id: p.ingredient.id, ingredient_sku_snapshot: p.ingredient.sku, ingredient_name_en_snapshot: p.ingredient.name_en, ingredient_name_ar_snapshot: p.ingredient.name_ar, dimension_snapshot: p.ingredient.dimension, unit_id: p.unit.id, unit_code_snapshot: p.pkg?.code ?? p.unit.code, package_conversion_id: p.pkg?.id ?? null, package_code_snapshot: p.pkg?.code ?? null, package_name_en_snapshot: p.pkg?.name_en ?? null, package_name_ar_snapshot: p.pkg?.name_ar ?? null, conversion_numerator_snapshot: p.numerator, conversion_denominator_snapshot: p.denominator, quantity_input_scaled: p.input.quantityScaled, quantity_base: p.base, notes: p.input.notes ?? null })));
      await tx.insert(stockTransferStatusHistory).values({ transfer_id: row.id, branch_id: input.branchId, from_status: null, to_status: "draft", actor_user_id: ctx.user.id, idempotency_key: `${input.idempotencyKey}:create` });
      await audit(tx, input.branchId, ctx.user.id, "stock_transfer.created", row.id, undefined, { transferNumber: row.transfer_number, lineCount: prepared.length });
      return row.id;
    }).then((id) => bundle(id, input.branchId));
  }),
  editDraft: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), notes: z.string().trim().max(1000).nullable().optional(), lines: z.array(lineInput).min(1) })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:create");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, input.transferId), eq(stockTransfers.branch_id, input.branchId))).for("update");
      if (!row || row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Draft transfers can be edited" });
      await tx.delete(stockTransferLines).where(eq(stockTransferLines.transfer_id, row.id));
      const prepared = [] as Array<Record<string, unknown>>;
      for (const line of input.lines) {
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredientId), eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true)) });
        const unit = await tx.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unitId) });
        const pkg = line.packageConversionId ? await tx.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.id, line.packageConversionId), eq(ingredientPackageConversions.ingredient_id, line.ingredientId), eq(ingredientPackageConversions.is_active, true)) }) : null;
        if (!ingredient || !unit || unit.dimension !== ingredient.dimension || (line.packageConversionId && !pkg)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid ingredient or conversion" });
        const n = pkg?.base_numerator ?? unit.base_numerator, d = pkg?.base_denominator ?? unit.base_denominator;
        prepared.push({ transfer_id: row.id, ingredient_id: ingredient.id, ingredient_sku_snapshot: ingredient.sku, ingredient_name_en_snapshot: ingredient.name_en, ingredient_name_ar_snapshot: ingredient.name_ar, dimension_snapshot: ingredient.dimension, unit_id: unit.id, unit_code_snapshot: pkg?.code ?? unit.code, package_conversion_id: pkg?.id ?? null, package_code_snapshot: pkg?.code ?? null, package_name_en_snapshot: pkg?.name_en ?? null, package_name_ar_snapshot: pkg?.name_ar ?? null, conversion_numerator_snapshot: n, conversion_denominator_snapshot: d, quantity_input_scaled: line.quantityScaled, quantity_base: convertScaledQuantity({ quantityScaled: line.quantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: n, denominator: d } }), notes: line.notes ?? null });
      }
      if (new Set(input.lines.map((l) => l.ingredientId)).size !== input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Use one line per ingredient" });
      await tx.insert(stockTransferLines).values(prepared as never[]);
      await tx.update(stockTransfers).set({ notes: input.notes === undefined ? row.notes : input.notes, updated_at: new Date() }).where(eq(stockTransfers.id, row.id));
      await audit(tx, input.branchId, ctx.user.id, "stock_transfer.draft_edited", row.id, undefined, { lineCount: prepared.length });
      return row.id;
    }).then((id) => bundle(id, input.branchId));
  }),
  submit: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => transition({ ctx, branchId: input.branchId, id: input.transferId, to: "submitted", key: input.idempotencyKey })),
  approve: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => transition({ ctx, branchId: input.branchId, id: input.transferId, to: "approved", key: input.idempotencyKey, reason: input.reason })),
  cancel: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => transition({ ctx, branchId: input.branchId, id: input.transferId, to: "cancelled", key: input.idempotencyKey, reason: input.reason })),
  dispatch: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().min(3).max(500).optional(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:dispatch");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, input.transferId), eq(stockTransfers.branch_id, input.branchId))).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found" });
      const duplicate = await tx.query.stockTransferDispatches.findFirst({ where: eq(stockTransferDispatches.idempotency_key, input.idempotencyKey) });
      if (duplicate) { if (duplicate.transfer_id !== row.id) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return row.id; }
      if (row.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Approved transfers can be dispatched" });
      const lines = await tx.query.stockTransferLines.findMany({ where: eq(stockTransferLines.transfer_id, row.id), orderBy: [asc(stockTransferLines.id)] });
      const ids = lines.map((l) => l.ingredient_id).sort((a, b) => a - b);
      for (const ingredientId of ids) await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${row.source_location_id} and ingredient_id = ${ingredientId} for update`);
      const balances = new Map<number, typeof stockBalances.$inferSelect>();
      for (const line of lines) {
        const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, row.source_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        if (!balance || balance.quantity_base < line.quantity_base) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Insufficient stock for ${line.ingredient_name_en_snapshot}` });
        balances.set(line.ingredient_id, balance);
      }
      const now = new Date();
      const [dispatch] = await tx.insert(stockTransferDispatches).values({ transfer_id: row.id, branch_id: input.branchId, idempotency_key: input.idempotencyKey, actor_user_id: ctx.user.id, reason: input.reason ?? null }).returning();
      for (const line of lines) {
        const balance = balances.get(line.ingredient_id)!;
        const amount = costMinorForQuantity(line.quantity_base, balance.average_unit_cost_micros);
        const [dl] = await tx.insert(stockTransferDispatchLines).values({ dispatch_id: dispatch.id, transfer_line_id: line.id, quantity_base: line.quantity_base, unit_cost_micros_snapshot: balance.average_unit_cost_micros, total_cost_amount: amount }).returning();
        await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: row.source_location_id, ingredient_id: line.ingredient_id, movement_type: "stock_transfer_out", direction: -1, quantity_base: line.quantity_base, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: amount, source_type: "stock_transfer_dispatch", source_id: String(dispatch.id), idempotency_key: `stock-transfer:${row.id}:dispatch:${line.id}`, actor_user_id: ctx.user.id, reason: input.reason ?? null, stock_transfer_id: row.id, stock_transfer_line_id: line.id, stock_transfer_dispatch_id: dispatch.id, stock_transfer_dispatch_line_id: dl.id, created_at: now });
        await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - line.quantity_base, updated_at: now }).where(eq(stockBalances.id, balance.id));
      }
      const [updated] = await tx.update(stockTransfers).set({ status: "dispatched", dispatched_by: ctx.user.id, dispatched_at: now, updated_at: now }).where(eq(stockTransfers.id, row.id)).returning();
      await history(tx, row, "dispatched", ctx.user.id, `${input.idempotencyKey}:history`, input.reason);
      await audit(tx, input.branchId, ctx.user.id, "stock_transfer.dispatched", row.id, input.reason, { dispatchId: dispatch.id, lines: lines.map((l) => ({ lineId: l.id, quantityBase: l.quantity_base, sourceUnitCostMicros: balances.get(l.ingredient_id)!.average_unit_cost_micros })) });
      return updated.id;
    }).then((id) => bundle(id, input.branchId));
  }),
  receive: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().max(500).optional(), idempotencyKey: keyInput, lines: z.array(quantityLine).min(1) })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:receive");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, input.transferId), eq(stockTransfers.branch_id, input.branchId))).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found" });
      const duplicate = await tx.query.stockTransferReceipts.findFirst({ where: eq(stockTransferReceipts.idempotency_key, input.idempotencyKey), with: { lines: true } });
      if (duplicate) { if (duplicate.transfer_id !== row.id) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return row.id; }
      if (row.status !== "dispatched" && row.status !== "partially_received") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only dispatched transfers can be received" });
      const allLines = await tx.query.stockTransferLines.findMany({ where: eq(stockTransferLines.transfer_id, row.id), orderBy: [asc(stockTransferLines.id)] });
      const dispatch = await tx.query.stockTransferDispatches.findFirst({ where: eq(stockTransferDispatches.transfer_id, row.id), with: { lines: true } });
      if (!dispatch) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Dispatch snapshot is missing" });
      const prior = await tx.query.stockTransferReceiptLines.findMany({ with: { receipt: true } });
      const receivedByLine = new Map<number, number>();
      for (const r of prior) if (r.receipt.transfer_id === row.id) receivedByLine.set(r.transfer_line_id, add(receivedByLine.get(r.transfer_line_id) ?? 0, r.quantity_base, "Received quantity"));
      const seen = new Set<number>();
      const prepared = input.lines.map((requested) => {
        if (seen.has(requested.transferLineId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Duplicate transfer line" }); seen.add(requested.transferLineId);
        const line = allLines.find((l) => l.id === requested.transferLineId);
        const dispatched = dispatch.lines.find((l) => l.transfer_line_id === requested.transferLineId);
        if (!line || !dispatched) throw new TRPCError({ code: "BAD_REQUEST", message: "Line is not part of this transfer dispatch" });
        const qty = convert(line, requested.quantityScaled);
        if (!qty || qty > dispatched.quantity_base - (receivedByLine.get(line.id) ?? 0)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Receipt exceeds the remaining dispatched quantity" });
        return { line, dispatched, qty };
      });
      const now = new Date();
      const ids = [...new Set(prepared.map((p) => p.line.ingredient_id))].sort((a, b) => a - b);
      for (const ingredientId of ids) await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${row.destination_location_id} and ingredient_id = ${ingredientId} for update`);
      const [receipt] = await tx.insert(stockTransferReceipts).values({ transfer_id: row.id, branch_id: input.branchId, idempotency_key: input.idempotencyKey, actor_user_id: ctx.user.id, reason: input.reason ?? null }).returning();
      for (const { line, dispatched, qty } of prepared) {
        let balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, row.destination_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        if (!balance) [balance] = await tx.insert(stockBalances).values({ branch_id: input.branchId, location_id: row.destination_location_id, ingredient_id: line.ingredient_id, quantity_base: 0, average_unit_cost_micros: 0 }).returning();
        const newQty = add(balance.quantity_base, qty, "Destination stock");
        const newCost = movingWeightedAverage({ existingQuantity: balance.quantity_base, existingUnitCostMicros: balance.average_unit_cost_micros, addedQuantity: qty, addedUnitCostMicros: dispatched.unit_cost_micros_snapshot });
        const amount = costMinorForQuantity(qty, dispatched.unit_cost_micros_snapshot);
        const [receiptLine] = await tx.insert(stockTransferReceiptLines).values({ receipt_id: receipt.id, transfer_line_id: line.id, quantity_base: qty, unit_cost_micros_snapshot: dispatched.unit_cost_micros_snapshot, total_cost_amount: amount }).returning();
        await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: row.destination_location_id, ingredient_id: line.ingredient_id, movement_type: "stock_transfer_in", direction: 1, quantity_base: qty, unit_cost_micros: dispatched.unit_cost_micros_snapshot, total_cost_amount: amount, source_type: "stock_transfer_receipt", source_id: String(receipt.id), idempotency_key: `stock-transfer:${row.id}:receipt:${receipt.id}:line:${line.id}`, actor_user_id: ctx.user.id, reason: input.reason ?? null, stock_transfer_id: row.id, stock_transfer_line_id: line.id, stock_transfer_dispatch_id: dispatch.id, stock_transfer_receipt_id: receipt.id, stock_transfer_receipt_line_id: receiptLine.id, created_at: now });
        await tx.update(stockBalances).set({ quantity_base: newQty, average_unit_cost_micros: newCost, updated_at: now }).where(eq(stockBalances.id, balance.id));
        await tx.update(ingredients).set({ average_unit_cost_micros: newCost, updated_by: ctx.user.id, updated_at: now }).where(eq(ingredients.id, line.ingredient_id));
      }
      const refreshed = await tx.query.stockTransferReceiptLines.findMany({ with: { receipt: true } });
      const totalDispatched = dispatch.lines.reduce((n, l) => add(n, l.quantity_base, "Dispatched quantity"), 0);
      const totalReceived = refreshed.filter((l) => l.receipt.transfer_id === row.id).reduce((n, l) => add(n, l.quantity_base, "Received quantity"), 0);
      const status = totalReceived === totalDispatched ? "received" : "partially_received";
      const [updated] = await tx.update(stockTransfers).set({ status, received_at: status === "received" ? now : row.received_at, updated_at: now }).where(eq(stockTransfers.id, row.id)).returning();
      await history(tx, row, status, ctx.user.id, `${input.idempotencyKey}:history`, input.reason);
      await audit(tx, input.branchId, ctx.user.id, status === "received" ? "stock_transfer.received" : "stock_transfer.partially_received", row.id, input.reason, { receiptId: receipt.id, lines: prepared.map((p) => ({ lineId: p.line.id, quantityBase: p.qty, remainingInTransitBase: p.dispatched.quantity_base - (receivedByLine.get(p.line.id) ?? 0) - p.qty })) });
      return updated.id;
    }).then((id) => bundle(id, input.branchId));
  }),
  reverse: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:reverse");
    return reverseTransfer(ctx.user.id, input.branchId, input.transferId, input.reason, input.idempotencyKey);
  }),
  resolveNeedsReview: protectedProcedure.input(branchInput.extend({ transferId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-transfer:resolve");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, input.transferId), eq(stockTransfers.branch_id, input.branchId))).for("update");
      if (!row || row.status !== "needs_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transfer is not awaiting review" });
      const reversal = await tx.query.stockTransferReversals.findFirst({ where: and(eq(stockTransferReversals.transfer_id, row.id), eq(stockTransferReversals.status, "needs_review")) });
      if (reversal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Unsafe dispatched transfer requires inventory reconciliation" });
      const [updated] = await tx.update(stockTransfers).set({ status: "cancelled", cancellation_reason: input.reason, cancelled_by: ctx.user.id, updated_at: new Date() }).where(eq(stockTransfers.id, row.id)).returning();
      await history(tx, row, "cancelled", ctx.user.id, input.idempotencyKey, input.reason); await audit(tx, input.branchId, ctx.user.id, "stock_transfer.needs_review_resolved", row.id, input.reason);
      return updated;
    });
  }),
});

async function transition(input: { ctx: { user: { id: string } }; branchId: number; id: number; to: "submitted" | "approved" | "cancelled"; key: string; reason?: string }) {
  const permission: Permission = input.to === "submitted" ? "stock-transfer:submit" : input.to === "approved" ? "stock-transfer:approve" : "stock-transfer:cancel";
  await authorize(input.ctx.user.id, input.branchId, permission);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, input.id), eq(stockTransfers.branch_id, input.branchId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found" });
    const prior = await tx.query.stockTransferStatusHistory.findFirst({ where: eq(stockTransferStatusHistory.idempotency_key, input.key) });
    if (prior) { if (prior.transfer_id !== row.id) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return row.id; }
    if (input.to === "submitted" && row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Draft transfers can be submitted" });
    if (input.to === "approved" && row.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Submitted transfers can be approved" });
    if (input.to === "cancelled" && !["draft", "submitted", "approved"].includes(row.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pre-dispatch transfers can be cancelled" });
    if (input.to === "submitted") {
      const lines = await tx.query.stockTransferLines.findMany({ where: eq(stockTransferLines.transfer_id, row.id) });
      if (!lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Transfer must have at least one line" });
      for (const line of lines) {
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true)) });
        const unit = await tx.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id) });
        if (!ingredient || ingredient.dimension !== line.dimension_snapshot || !unit || unit.dimension !== line.dimension_snapshot) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transfer ingredient or unit snapshot no longer validates" });
        if (line.package_conversion_id) {
          const pkg = await tx.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.id, line.package_conversion_id), eq(ingredientPackageConversions.ingredient_id, line.ingredient_id)) });
          if (!pkg || pkg.base_numerator !== line.conversion_numerator_snapshot || pkg.base_denominator !== line.conversion_denominator_snapshot) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Package conversion snapshot changed" });
        } else if (unit.base_numerator !== line.conversion_numerator_snapshot || unit.base_denominator !== line.conversion_denominator_snapshot) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Unit conversion snapshot changed" });
      }
    }
    const patch = input.to === "submitted" ? { status: "submitted" as const, submitted_by: input.ctx.user.id } : input.to === "approved" ? { status: "approved" as const, approved_by: input.ctx.user.id } : { status: "cancelled" as const, cancelled_by: input.ctx.user.id, cancellation_reason: input.reason };
    const [updated] = await tx.update(stockTransfers).set({ ...patch, updated_at: new Date() }).where(eq(stockTransfers.id, row.id)).returning();
    await history(tx, row, input.to, input.ctx.user.id, input.key, input.reason); await audit(tx, input.branchId, input.ctx.user.id, `stock_transfer.${input.to}`, row.id, input.reason, { from: row.status, to: input.to });
      return updated.id;
  }).then((id) => bundle(id, input.branchId));
}

async function reverseTransfer(userId: string, branchId: number, id: number, reason: string, key: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.branch_id, branchId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found" });
    const duplicate = await tx.query.stockTransferReversals.findFirst({ where: eq(stockTransferReversals.idempotency_key, key) });
    if (duplicate) { if (duplicate.transfer_id !== row.id) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return row.id; }
    const prior = await tx.query.stockTransferReversals.findFirst({ where: eq(stockTransferReversals.transfer_id, row.id) });
    if (prior) return row.id;
    if (row.status !== "dispatched" && row.status !== "partially_received" && row.status !== "received") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only dispatched transfers can be reversed" });
    const lines = await tx.query.stockTransferLines.findMany({ where: eq(stockTransferLines.transfer_id, row.id) });
    const dispatch = await tx.query.stockTransferDispatches.findFirst({ where: eq(stockTransferDispatches.transfer_id, row.id), with: { lines: true } });
    const receiptRows = await tx.query.stockTransferReceiptLines.findMany({ with: { receipt: true } });
    const received = receiptRows.filter((r) => r.receipt.transfer_id === row.id);
    const receivedByLine = new Map<number, number>(); for (const r of received) receivedByLine.set(r.transfer_line_id, add(receivedByLine.get(r.transfer_line_id) ?? 0, r.quantity_base, "Received quantity"));
    const sourceIds = [...new Set(lines.map((l) => l.ingredient_id))].sort((a, b) => a - b);
    const destIds = [...new Set(received.map((r) => lines.find((l) => l.id === r.transfer_line_id)!.ingredient_id))].sort((a, b) => a - b);
    for (const ingredientId of [...new Set([...sourceIds, ...destIds])].sort((a, b) => a - b)) {
      await tx.execute(sql`select id from stock_balances where branch_id = ${branchId} and (location_id = ${row.source_location_id} or location_id = ${row.destination_location_id}) and ingredient_id = ${ingredientId} order by location_id for update`);
    }
    const dispatchByLine = new Map((dispatch?.lines ?? []).map((l) => [l.transfer_line_id, l]));
    const safe = Boolean(dispatch) && await Promise.all(lines.map(async (line) => {
      const dispatchLine = dispatchByLine.get(line.id);
      const source = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.source_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
      if (!dispatchLine || dispatchLine.quantity_base !== line.quantity_base || dispatchLine.unit_cost_micros_snapshot < 0 || !source) return false;
      try {
        add(source.quantity_base, dispatchLine.quantity_base, "Restored source stock");
        movingWeightedAverage({ existingQuantity: source.quantity_base, existingUnitCostMicros: source.average_unit_cost_micros, addedQuantity: dispatchLine.quantity_base, addedUnitCostMicros: dispatchLine.unit_cost_micros_snapshot });
      } catch { return false; }
      const receivedQty = receivedByLine.get(line.id) ?? 0;
      if (!receivedQty) return true;
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.destination_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
      if (!balance || balance.quantity_base < receivedQty) return false;
      const receiptTimes = received.filter((r) => r.transfer_line_id === line.id).map((r) => r.receipt.created_at);
      const later = await tx.query.stockMovements.findFirst({ where: and(eq(stockMovements.branch_id, branchId), eq(stockMovements.location_id, row.destination_location_id), eq(stockMovements.ingredient_id, line.ingredient_id), sql`${stockMovements.created_at} > ${new Date(Math.min(...receiptTimes.map((d) => d.getTime())))} and ${stockMovements.stock_transfer_id} is distinct from ${row.id}`) });
      return !later;
    })).then((checks) => checks.every(Boolean));
    const [reversal] = await tx.insert(stockTransferReversals).values({ transfer_id: row.id, branch_id: branchId, status: safe ? "reversed" : "needs_review", reason, idempotency_key: key, actor_user_id: userId }).returning();
    if (!safe || !dispatch) {
      const [updated] = await tx.update(stockTransfers).set({ status: "needs_review", needs_review_reason: "Transfer reversal is unsafe; reconcile destination inventory", updated_at: new Date() }).where(eq(stockTransfers.id, row.id)).returning();
      await history(tx, row, "needs_review", userId, `${key}:history`, reason); await audit(tx, branchId, userId, "stock_transfer.needs_review", row.id, reason, { reversalId: reversal.id, noCompensatingMovements: true }); return updated.id;
    }
    const now = new Date();
    for (const line of lines) {
      const d = dispatchByLine.get(line.id)!;
      let source = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.source_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
      if (!source) [source] = await tx.insert(stockBalances).values({ branch_id: branchId, location_id: row.source_location_id, ingredient_id: line.ingredient_id, quantity_base: 0, average_unit_cost_micros: 0 }).returning();
      const restored = add(source.quantity_base, d.quantity_base, "Restored source stock");
      const average = movingWeightedAverage({ existingQuantity: source.quantity_base, existingUnitCostMicros: source.average_unit_cost_micros, addedQuantity: d.quantity_base, addedUnitCostMicros: d.unit_cost_micros_snapshot });
      await tx.update(stockBalances).set({ quantity_base: restored, average_unit_cost_micros: average, updated_at: now }).where(eq(stockBalances.id, source.id));
      await tx.update(ingredients).set({ average_unit_cost_micros: average, updated_by: userId, updated_at: now }).where(eq(ingredients.id, line.ingredient_id));
      await tx.insert(stockMovements).values({ branch_id: branchId, location_id: row.source_location_id, ingredient_id: line.ingredient_id, movement_type: "stock_transfer_reversal_in", direction: 1, quantity_base: d.quantity_base, unit_cost_micros: d.unit_cost_micros_snapshot, total_cost_amount: d.total_cost_amount, source_type: "stock_transfer_reversal", source_id: String(reversal.id), idempotency_key: `stock-transfer:${row.id}:reversal:source:${line.id}`, actor_user_id: userId, reason, stock_transfer_id: row.id, stock_transfer_line_id: line.id, stock_transfer_reversal_id: reversal.id, created_at: now });
    }
    for (const r of received) {
      const line = lines.find((l) => l.id === r.transfer_line_id)!;
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, branchId), eq(stockBalances.location_id, row.destination_location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
      if (!balance || balance.quantity_base < r.quantity_base) throw new TRPCError({ code: "CONFLICT", message: "Destination stock changed during reversal" });
      await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - r.quantity_base, updated_at: now }).where(eq(stockBalances.id, balance.id));
      await tx.insert(stockMovements).values({ branch_id: branchId, location_id: row.destination_location_id, ingredient_id: line.ingredient_id, movement_type: "stock_transfer_reversal_out", direction: -1, quantity_base: r.quantity_base, unit_cost_micros: r.unit_cost_micros_snapshot, total_cost_amount: r.total_cost_amount, source_type: "stock_transfer_reversal", source_id: String(reversal.id), idempotency_key: `stock-transfer:${row.id}:reversal:destination:${r.id}`, actor_user_id: userId, reason, stock_transfer_id: row.id, stock_transfer_line_id: line.id, stock_transfer_receipt_id: r.receipt_id, stock_transfer_receipt_line_id: r.id, stock_transfer_reversal_id: reversal.id, created_at: now });
    }
    await tx.update(stockTransfers).set({ status: "reversed", updated_at: now }).where(eq(stockTransfers.id, row.id));
    await history(tx, row, "reversed", userId, `${key}:history`, reason); await audit(tx, branchId, userId, "stock_transfer.reversed", row.id, reason, { reversalId: reversal.id, sourceRestoredLines: lines.length, destinationRemovedLines: received.length });
    return row.id;
  }).then((transferId) => bundle(transferId, branchId));
}
