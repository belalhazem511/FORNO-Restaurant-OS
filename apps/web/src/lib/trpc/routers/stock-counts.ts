import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { auditLogs, ingredients, ingredientPackageConversions, inventoryLocations, stockBalances, stockCountEntries, stockCountLines, stockCounts, stockCountReversals, stockCountStatusHistory, stockMovements, staffAssignments, unitsOfMeasure } from "@/lib/db/schema";
import { convertScaledQuantity, costMinorForQuantity, movingWeightedAverage } from "@/lib/inventory/exact";
import { hasPermission, requireStaff, type Permission } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

const branchInput = z.object({ branchId: z.number().int().positive() });
const keyInput = z.string().trim().min(8).max(140);
const reasonInput = z.string().trim().min(3).max(500);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function authorize(userId: string, branchId: number, permission: Permission) {
  try { return await requireStaff(userId, branchId, permission); }
  catch (error) {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, userId), eq(staffAssignments.branch_id, branchId)) });
    if (assignment) await db.insert(auditLogs).values({ branch_id: branchId, actor_user_id: userId, action: "stock_count.permission_denied", entity_type: "stock_count_access", entity_id: String(branchId), reason: permission });
    throw error;
  }
}
async function audit(tx: Tx, branchId: number, actor: string, action: string, countId: number, reason?: string, details?: unknown) {
  await tx.insert(auditLogs).values({ branch_id: branchId, actor_user_id: actor, action, entity_type: "stock_count", entity_id: String(countId), reason: reason ?? null, details: details == null ? null : JSON.stringify(details) });
}
async function changeStatus(tx: Tx, row: typeof stockCounts.$inferSelect, status: typeof row.status, actor: string, key: string, reason?: string) {
  await tx.update(stockCounts).set({ status, updated_at: new Date() }).where(eq(stockCounts.id, row.id));
  await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: row.status, to_status: status, actor_user_id: actor, reason: reason ?? null, idempotency_key: key }).onConflictDoNothing();
  await audit(tx, row.branch_id, actor, `stock_count.${status}`, row.id, reason, { from: row.status, to: status, idempotencyKey: key });
}
async function getBundle(id: number, branchId: number, seeVariance: boolean) {
  const row = await db.query.stockCounts.findFirst({ where: and(eq(stockCounts.id, id), eq(stockCounts.branch_id, branchId)), with: { lines: { orderBy: [asc(stockCountLines.id)] }, statusHistory: { orderBy: [asc(stockCountStatusHistory.created_at)] }, reversals: true } });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Stock count not found in this branch" });
  const showExpected = seeVariance && ["submitted", "approved", "posted", "needs_review", "reversed"].includes(row.status);
  return { ...row, lines: row.lines.map((line) => ({ ...line, expected_quantity_base: showExpected ? line.expected_quantity_base : null, expected_unit_cost_micros: showExpected ? line.expected_unit_cost_micros : null, variance_base: showExpected ? line.variance_base : null, valuation_amount: seeVariance && showExpected ? line.valuation_amount : null, valuation_unit_cost_micros: seeVariance && showExpected ? line.valuation_unit_cost_micros : null })) };
}
async function lockedCount(tx: Tx, id: number, branchId: number) {
  const [row] = await tx.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.branch_id, branchId))).for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Stock count not found in this branch" });
  return row;
}

export const stockCountsRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)) });
    if (!assignment) throw new TRPCError({ code: "FORBIDDEN", message: "No active staff assignment" });
    await authorize(ctx.user.id, assignment.branch_id, "stock-count:view");
    const can = (permission: Permission) => hasPermission(assignment.role, permission);
    return { branchId: assignment.branch_id, canCreate: can("stock-count:create"), canStart: can("stock-count:start"), canEnter: can("stock-count:enter"), canSubmit: can("stock-count:submit"), canApprove: can("stock-count:approve"), canPost: can("stock-count:post"), canCancel: can("stock-count:cancel"), canReverse: can("stock-count:reverse"), canResolve: can("stock-count:resolve"), canViewVariance: can("stock-count:variance:view") };
  }),
  locations: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => { await authorize(ctx.user.id, input.branchId, "stock-count:view"); return db.query.inventoryLocations.findMany({ where: and(eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)), orderBy: [asc(inventoryLocations.code)] }); }),
  ingredients: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:enter");
    const rows = await db.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, input.branchId), eq(ingredients.is_active, true), eq(ingredients.is_tracked, true)), orderBy: [asc(ingredients.name_en)] });
    return Promise.all(rows.map(async (ingredient) => ({ id: ingredient.id, packages: await db.query.ingredientPackageConversions.findMany({ where: and(eq(ingredientPackageConversions.ingredient_id, ingredient.id), eq(ingredientPackageConversions.is_active, true)) }) })));
  }),
  list: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view");
    const rows = await db.query.stockCounts.findMany({ where: eq(stockCounts.branch_id, input.branchId), orderBy: [desc(stockCounts.created_at)] });
    return Promise.all(rows.map((row) => getBundle(row.id, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"))));
  }),
  detail: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view");
    return getBundle(input.countId, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"));
  }),
  createDraft: protectedProcedure.input(branchInput.extend({ countNumber: z.string().trim().min(3).max(48), locationId: z.number().int().positive(), notes: z.string().trim().max(1000).nullable().optional(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:create");
    const id = await db.transaction(async (tx) => {
      const existing = await tx.query.stockCounts.findFirst({ where: eq(stockCounts.idempotency_key, input.idempotencyKey) });
      if (existing) { if (existing.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return existing.id; }
      const location = await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.locationId), eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)) });
      if (!location) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active inventory location in this branch" });
      const [row] = await tx.insert(stockCounts).values({ branch_id: input.branchId, location_id: location.id, count_number: input.countNumber, status: "draft", notes: input.notes ?? null, idempotency_key: input.idempotencyKey, created_by: ctx.user.id }).onConflictDoNothing().returning();
      if (!row) {
        const retry = await tx.query.stockCounts.findFirst({ where: eq(stockCounts.idempotency_key, input.idempotencyKey) });
        if (retry && retry.branch_id === input.branchId) return retry.id;
        throw new TRPCError({ code: "CONFLICT", message: "Count reference is already in use, or this location already has an active count" });
      }
      await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: null, to_status: "draft", actor_user_id: ctx.user.id, idempotency_key: `${input.idempotencyKey}:created` });
      await audit(tx, row.branch_id, ctx.user.id, "stock_count.created", row.id, undefined, { countNumber: row.count_number, locationId: row.location_id, idempotencyKey: input.idempotencyKey });
      return row.id;
    });
    return getBundle(id, input.branchId, false);
  }),
  editDraft: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), notes: z.string().trim().max(1000).nullable(), locationId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:create");
    return db.transaction(async (tx) => { const row = await lockedCount(tx, input.countId, input.branchId); if (row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only Draft configuration can be edited" }); if (input.locationId !== undefined) { const location = await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.locationId), eq(inventoryLocations.branch_id, row.branch_id), eq(inventoryLocations.is_active, true)) }); if (!location) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active location in this branch" }); } await tx.update(stockCounts).set({ notes: input.notes, location_id: input.locationId ?? row.location_id, updated_at: new Date() }).where(eq(stockCounts.id, row.id)); await audit(tx, row.branch_id, ctx.user.id, "stock_count.draft_edited", row.id, undefined, { notesChanged: true, locationId: input.locationId ?? row.location_id }); return row.id; }).then((id) => getBundle(id, input.branchId, false));
  }),
  start: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:start");
    const id = await db.transaction(async (tx) => {
      const row = await lockedCount(tx, input.countId, input.branchId);
      if (row.status === "counting") return row.id;
      if (row.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a Draft count can start" });
      const location = await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, row.location_id), eq(inventoryLocations.branch_id, row.branch_id), eq(inventoryLocations.is_active, true)) });
      if (!location) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Count location is no longer active" });
      const stockItems = await tx.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, row.branch_id), eq(ingredients.is_active, true), eq(ingredients.is_tracked, true)), orderBy: [asc(ingredients.id)] });
      if (!stockItems.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active tracked ingredients are available to count" });
      const lines = [];
      for (const ingredient of stockItems) {
        await tx.execute(sql`select id from stock_balances where branch_id = ${row.branch_id} and location_id = ${row.location_id} and ingredient_id = ${ingredient.id} for update`);
        const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, ingredient.id)) });
        const unit = await tx.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, ingredient.base_unit_id) });
        if (!unit) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ingredient base unit is unavailable" });
        const [watermark] = await tx.select({ value: sql<number>`coalesce(max(${stockMovements.id}), 0)::int` }).from(stockMovements).where(and(eq(stockMovements.branch_id, row.branch_id), eq(stockMovements.location_id, row.location_id), eq(stockMovements.ingredient_id, ingredient.id)));
        lines.push({ count_id: row.id, branch_id: row.branch_id, location_id: row.location_id, ingredient_id: ingredient.id, ingredient_sku_snapshot: ingredient.sku, ingredient_name_en_snapshot: ingredient.name_en, ingredient_name_ar_snapshot: ingredient.name_ar, dimension_snapshot: ingredient.dimension, base_unit_id: unit.id, base_unit_code_snapshot: unit.code, expected_quantity_base: balance?.quantity_base ?? 0, expected_unit_cost_micros: balance?.average_unit_cost_micros ?? ingredient.average_unit_cost_micros, movement_watermark: watermark?.value ?? 0, conversion_numerator_snapshot: unit.base_numerator, conversion_denominator_snapshot: unit.base_denominator, zero_confirmed: false });
      }
      await tx.insert(stockCountLines).values(lines);
      await tx.update(stockCounts).set({ status: "counting", started_by: ctx.user.id, started_at: new Date(), updated_at: new Date() }).where(eq(stockCounts.id, row.id));
      await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "draft", to_status: "counting", actor_user_id: ctx.user.id, idempotency_key: `${input.idempotencyKey}:start` });
      await audit(tx, row.branch_id, ctx.user.id, "stock_count.started", row.id, undefined, { snapshottedLines: lines.length, idempotencyKey: input.idempotencyKey });
      return row.id;
    });
    return getBundle(id, input.branchId, false);
  }),
  enterLine: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), lineId: z.number().int().positive(), quantityScaled: z.number().int().nonnegative().nullable(), zeroConfirmed: z.boolean(), unitId: z.number().int().positive().optional(), packageConversionId: z.number().int().positive().nullable().optional(), notes: z.string().trim().max(500).nullable().optional(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:enter");
    return db.transaction(async (tx) => {
      const row = await lockedCount(tx, input.countId, input.branchId);
      const existingEntry = await tx.query.stockCountEntries.findFirst({ where: eq(stockCountEntries.idempotency_key, input.idempotencyKey) });
      if (existingEntry) { if (existingEntry.count_id !== row.id || existingEntry.line_id !== input.lineId || existingEntry.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key already used" }); return row.id; }
      if (row.status !== "counting") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Counts can only be entered during Counting" });
      const [line] = await tx.select().from(stockCountLines).where(and(eq(stockCountLines.id, input.lineId), eq(stockCountLines.count_id, row.id), eq(stockCountLines.branch_id, input.branchId), eq(stockCountLines.location_id, row.location_id))).for("update");
      if (!line) throw new TRPCError({ code: "NOT_FOUND", message: "Count line not found" });
      if (input.zeroConfirmed && input.quantityScaled !== null && input.quantityScaled !== 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A confirmed zero cannot include a positive quantity" });
      if (!input.zeroConfirmed && input.quantityScaled === null) throw new TRPCError({ code: "BAD_REQUEST", message: "Leave blank until counted, or explicitly confirm zero" });
      const unitId = input.unitId ?? line.base_unit_id;
      const unit = await tx.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, unitId) });
      if (!unit || unit.dimension !== line.dimension_snapshot) throw new TRPCError({ code: "BAD_REQUEST", message: "Count unit is incompatible with this ingredient" });
      const pkg = input.packageConversionId ? await tx.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.id, input.packageConversionId), eq(ingredientPackageConversions.ingredient_id, line.ingredient_id), eq(ingredientPackageConversions.is_active, true)) }) : null;
      if (input.packageConversionId && !pkg) throw new TRPCError({ code: "BAD_REQUEST", message: "Package conversion is invalid" });
      if (pkg && unitId !== line.base_unit_id) throw new TRPCError({ code: "BAD_REQUEST", message: "Package entry must use the ingredient base unit selector" });
      const numerator = pkg?.base_numerator ?? unit.base_numerator;
      const denominator = pkg?.base_denominator ?? unit.base_denominator;
      const counted = input.zeroConfirmed ? 0 : convertScaledQuantity({ quantityScaled: input.quantityScaled!, fromDimension: line.dimension_snapshot as "mass" | "volume" | "count", toDimension: line.dimension_snapshot as "mass" | "volume" | "count", factor: { numerator, denominator } });
      await tx.insert(stockCountEntries).values({ count_id: row.id, line_id: line.id, branch_id: row.branch_id, actor_user_id: ctx.user.id, quantity_input_scaled: input.zeroConfirmed ? 0 : input.quantityScaled!, quantity_base: counted, unit_id: unitId, unit_code_snapshot: pkg?.code ?? unit.code, package_conversion_id: pkg?.id ?? null, package_code_snapshot: pkg?.code ?? null, conversion_numerator_snapshot: numerator, conversion_denominator_snapshot: denominator, zero_confirmed: input.zeroConfirmed, idempotency_key: input.idempotencyKey });
      await tx.update(stockCountLines).set({ counted_input_scaled: input.zeroConfirmed ? 0 : input.quantityScaled, counted_unit_id: unitId, counted_unit_code_snapshot: pkg?.code ?? unit.code, package_conversion_id: pkg?.id ?? null, package_code_snapshot: pkg?.code ?? null, package_name_en_snapshot: pkg?.name_en ?? null, package_name_ar_snapshot: pkg?.name_ar ?? null, conversion_numerator_snapshot: numerator, conversion_denominator_snapshot: denominator, counted_quantity_base: counted, zero_confirmed: input.zeroConfirmed, notes: input.notes ?? null, updated_at: new Date() }).where(eq(stockCountLines.id, line.id));
      await audit(tx, row.branch_id, ctx.user.id, "stock_count.line_entered", row.id, undefined, { lineId: line.id, confirmedZero: input.zeroConfirmed, idempotencyKey: input.idempotencyKey });
      return row.id;
    }).then((id) => getBundle(id, input.branchId, false));
  }),
  submit: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:submit");
    const id = await db.transaction(async (tx) => { const row = await lockedCount(tx, input.countId, input.branchId); if (row.status === "submitted") return row.id; if (row.status !== "counting") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a Counting count can be submitted" }); const lines = await tx.query.stockCountLines.findMany({ where: eq(stockCountLines.count_id, row.id) }); if (!lines.length || lines.some((line) => line.counted_quantity_base === null || (line.counted_input_scaled === null && !line.zero_confirmed))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every ingredient must be counted or explicitly confirmed as zero" }); for (const line of lines) await tx.update(stockCountLines).set({ variance_base: line.counted_quantity_base! - line.expected_quantity_base }).where(eq(stockCountLines.id, line.id)); await tx.update(stockCounts).set({ status: "submitted", submitted_by: ctx.user.id, submitted_at: new Date(), updated_at: new Date() }).where(eq(stockCounts.id, row.id)); await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: row.status, to_status: "submitted", actor_user_id: ctx.user.id, idempotency_key: `${input.idempotencyKey}:submit` }).onConflictDoNothing(); await audit(tx, row.branch_id, ctx.user.id, "stock_count.submitted", row.id, undefined, { lineCount: lines.length }); return row.id; });
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view"); return getBundle(id, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"));
  }),
  approve: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), reason: reasonInput, idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:approve");
    const id = await db.transaction(async (tx) => { const row = await lockedCount(tx, input.countId, input.branchId); if (row.status === "approved") return row.id; if (row.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a submitted count can be approved" }); const lines = await tx.query.stockCountLines.findMany({ where: eq(stockCountLines.count_id, row.id) }); await tx.update(stockCounts).set({ status: "approved", approved_by: ctx.user.id, approved_at: new Date(), updated_at: new Date() }).where(eq(stockCounts.id, row.id)); await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: row.status, to_status: "approved", actor_user_id: ctx.user.id, reason: input.reason, idempotency_key: `${input.idempotencyKey}:approve` }).onConflictDoNothing(); await audit(tx, row.branch_id, ctx.user.id, "stock_count.approved", row.id, input.reason, { lineCount: lines.length }); return row.id; });
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view"); return getBundle(id, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"));
  }),
  post: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:post");
    const id = await db.transaction(async (tx) => {
      const row = await lockedCount(tx, input.countId, input.branchId);
      if (row.status === "posted") return row.id;
      if (row.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an approved count can be posted" });
      const lines = await tx.query.stockCountLines.findMany({ where: eq(stockCountLines.count_id, row.id), orderBy: [asc(stockCountLines.ingredient_id)] });
      for (const line of lines) await tx.execute(sql`select id from stock_balances where branch_id = ${row.branch_id} and location_id = ${row.location_id} and ingredient_id = ${line.ingredient_id} for update`);
      let conflict: string | null = null;
      for (const line of lines) {
        const current = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        const [later] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.branch_id, row.branch_id), eq(stockMovements.location_id, row.location_id), eq(stockMovements.ingredient_id, line.ingredient_id), sql`${stockMovements.id} > ${line.movement_watermark}`)).limit(1);
        if ((current?.quantity_base ?? 0) !== line.expected_quantity_base || (current?.average_unit_cost_micros ?? line.expected_unit_cost_micros) !== line.expected_unit_cost_micros || later) { conflict = `Stock activity changed after count began for ${line.ingredient_sku_snapshot}`; break; }
      }
      if (!conflict) {
        const currentIngredients = await tx.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, row.branch_id), eq(ingredients.is_active, true), eq(ingredients.is_tracked, true)) });
        if (currentIngredients.length !== lines.length || currentIngredients.some((item) => !lines.some((line) => line.ingredient_id === item.id))) conflict = "The active stock-tracked ingredient set changed after count began";
      }
      if (conflict) {
        await tx.update(stockCounts).set({ status: "needs_review", needs_review_reason: conflict, updated_at: new Date() }).where(eq(stockCounts.id, row.id));
        await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "approved", to_status: "needs_review", actor_user_id: ctx.user.id, reason: conflict, idempotency_key: `${input.idempotencyKey}:conflict` }).onConflictDoNothing();
        await audit(tx, row.branch_id, ctx.user.id, "stock_count.needs_review", row.id, conflict, { noAdjustmentMovements: true });
        return row.id;
      }
      for (const line of lines) {
        const delta = line.counted_quantity_base! - line.expected_quantity_base;
        let balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        const resolvedCost = balance?.average_unit_cost_micros || line.expected_unit_cost_micros;
        if (delta > 0 && resolvedCost <= 0) {
          await tx.update(stockCounts).set({ status: "needs_review", needs_review_reason: `No valid moving-average cost for ${line.ingredient_sku_snapshot}`, updated_at: new Date() }).where(eq(stockCounts.id, row.id));
          await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "approved", to_status: "needs_review", actor_user_id: ctx.user.id, reason: "No valid moving-average cost for positive variance", idempotency_key: `${input.idempotencyKey}:cost-review` }).onConflictDoNothing();
          await audit(tx, row.branch_id, ctx.user.id, "stock_count.needs_review", row.id, "No valid moving-average cost", { noAdjustmentMovements: true, lineId: line.id });
          return row.id;
        }
      }
      const now = new Date();
      for (const line of lines) {
        const delta = line.counted_quantity_base! - line.expected_quantity_base;
        const currentCost = (await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) }))?.average_unit_cost_micros ?? 0;
        const cost = currentCost || line.expected_unit_cost_micros;
        const amount = costMinorForQuantity(Math.abs(delta), cost);
        let balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        if (!balance) [balance] = await tx.insert(stockBalances).values({ branch_id: row.branch_id, location_id: row.location_id, ingredient_id: line.ingredient_id, quantity_base: 0, average_unit_cost_micros: cost }).returning();
        if (delta < 0 && balance.quantity_base < -delta) throw new TRPCError({ code: "CONFLICT", message: "Count adjustment would make stock negative" });
        const nextQty = balance.quantity_base + delta;
        const nextCost = delta > 0 ? movingWeightedAverage({ existingQuantity: balance.quantity_base, existingUnitCostMicros: balance.average_unit_cost_micros, addedQuantity: delta, addedUnitCostMicros: cost }) : balance.average_unit_cost_micros;
        if (delta !== 0) {
          await tx.update(stockBalances).set({ quantity_base: nextQty, average_unit_cost_micros: nextCost, updated_at: now }).where(eq(stockBalances.id, balance.id));
          await tx.update(ingredients).set({ average_unit_cost_micros: nextCost, updated_by: ctx.user.id, updated_at: now }).where(eq(ingredients.id, line.ingredient_id));
          await tx.insert(stockMovements).values({ branch_id: row.branch_id, location_id: row.location_id, ingredient_id: line.ingredient_id, movement_type: delta > 0 ? "stock_count_positive" : "stock_count_negative", direction: delta > 0 ? 1 : -1, quantity_base: Math.abs(delta), unit_cost_micros: cost, total_cost_amount: amount, source_type: "stock_count", source_id: String(row.id), idempotency_key: `stock-count:${row.id}:line:${line.id}:post`, actor_user_id: ctx.user.id, reason: "Approved physical stock count", stock_count_id: row.id, stock_count_line_id: line.id, created_at: now });
        }
        await tx.update(stockCountLines).set({ variance_base: delta, valuation_unit_cost_micros: cost, valuation_amount: amount, posted_balance_quantity: nextQty, updated_at: now }).where(eq(stockCountLines.id, line.id));
      }
      const [watermark] = await tx.select({ value: sql<number>`coalesce(max(${stockMovements.id}), 0)::int` }).from(stockMovements);
      await tx.update(stockCounts).set({ status: "posted", posted_by: ctx.user.id, posted_at: now, posting_watermark: watermark?.value ?? 0, updated_at: now }).where(eq(stockCounts.id, row.id));
      await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "approved", to_status: "posted", actor_user_id: ctx.user.id, idempotency_key: `${input.idempotencyKey}:posted` }).onConflictDoNothing();
      await audit(tx, row.branch_id, ctx.user.id, "stock_count.posted", row.id, undefined, { movementLines: lines.filter((line) => line.counted_quantity_base !== line.expected_quantity_base).length, idempotencyKey: input.idempotencyKey });
      return row.id;
    });
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view"); return getBundle(id, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"));
  }),
  cancel: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), reason: reasonInput, idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:cancel");
    const id = await db.transaction(async (tx) => { const row = await lockedCount(tx, input.countId, input.branchId); if (row.status === "cancelled") return row.id; if (!["draft", "counting", "submitted", "approved"].includes(row.status) && !(row.status === "needs_review" && row.posted_at === null)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a count not yet posted can be cancelled" }); await tx.update(stockCounts).set({ status: "cancelled", cancelled_by: ctx.user.id, cancellation_reason: input.reason, updated_at: new Date() }).where(eq(stockCounts.id, row.id)); await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: row.status, to_status: "cancelled", actor_user_id: ctx.user.id, reason: input.reason, idempotency_key: `${input.idempotencyKey}:cancel` }).onConflictDoNothing(); await audit(tx, row.branch_id, ctx.user.id, "stock_count.cancelled", row.id, input.reason); return row.id; });
    const assignment = await authorize(ctx.user.id, input.branchId, "stock-count:view"); return getBundle(id, input.branchId, hasPermission(assignment.role, "stock-count:variance:view"));
  }),
  reverse: protectedProcedure.input(branchInput.extend({ countId: z.number().int().positive(), reason: reasonInput, idempotencyKey: keyInput })).mutation(async ({ ctx, input }) => {
    await authorize(ctx.user.id, input.branchId, "stock-count:reverse");
    const id = await db.transaction(async (tx) => {
      const row = await lockedCount(tx, input.countId, input.branchId);
      const existing = await tx.query.stockCountReversals.findFirst({ where: eq(stockCountReversals.count_id, row.id) });
      if (existing) return row.id;
      if (row.status !== "posted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a posted count can be reversed" });
      const lines = await tx.query.stockCountLines.findMany({ where: eq(stockCountLines.count_id, row.id), orderBy: [asc(stockCountLines.ingredient_id)] });
      for (const line of lines) await tx.execute(sql`select id from stock_balances where branch_id = ${row.branch_id} and location_id = ${row.location_id} and ingredient_id = ${line.ingredient_id} for update`);
      let safe = true;
      for (const line of lines) {
        const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        const [later] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.branch_id, row.branch_id), eq(stockMovements.location_id, row.location_id), eq(stockMovements.ingredient_id, line.ingredient_id), sql`${stockMovements.id} > ${row.posting_watermark ?? 0}`, sql`${stockMovements.stock_count_id} is distinct from ${row.id}`)).limit(1);
        if ((balance?.quantity_base ?? 0) !== line.posted_balance_quantity || later || (line.variance_base! > 0 && (balance?.quantity_base ?? 0) < line.variance_base!)) { safe = false; break; }
      }
      const [reversal] = await tx.insert(stockCountReversals).values({ count_id: row.id, branch_id: row.branch_id, status: safe ? "reversed" : "needs_review", reason: input.reason, idempotency_key: input.idempotencyKey, actor_user_id: ctx.user.id }).onConflictDoNothing().returning();
      if (!reversal) return row.id;
      if (!safe) {
        await tx.update(stockCounts).set({ status: "needs_review", needs_review_reason: "Later stock activity prevents a safe all-lines reversal", updated_at: new Date() }).where(eq(stockCounts.id, row.id));
        await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "posted", to_status: "needs_review", actor_user_id: ctx.user.id, reason: input.reason, idempotency_key: `${input.idempotencyKey}:review` }).onConflictDoNothing();
        await audit(tx, row.branch_id, ctx.user.id, "stock_count.needs_review", row.id, input.reason, { reversalId: reversal.id, noCompensatingMovements: true }); return row.id;
      }
      const now = new Date();
      for (const line of lines) {
        const delta = line.variance_base!;
        if (!delta) continue;
        const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, row.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)) });
        if (!balance) throw new TRPCError({ code: "CONFLICT", message: "Stock balance changed during reversal" });
        const nextQty = balance.quantity_base - delta;
        const addQty = delta < 0 ? -delta : 0;
        const cost = line.valuation_unit_cost_micros ?? 0;
        const nextCost = addQty ? movingWeightedAverage({ existingQuantity: balance.quantity_base, existingUnitCostMicros: balance.average_unit_cost_micros, addedQuantity: addQty, addedUnitCostMicros: cost }) : balance.average_unit_cost_micros;
        await tx.update(stockBalances).set({ quantity_base: nextQty, average_unit_cost_micros: nextCost, updated_at: now }).where(eq(stockBalances.id, balance.id));
        await tx.update(ingredients).set({ average_unit_cost_micros: nextCost, updated_by: ctx.user.id, updated_at: now }).where(eq(ingredients.id, line.ingredient_id));
        await tx.insert(stockMovements).values({ branch_id: row.branch_id, location_id: row.location_id, ingredient_id: line.ingredient_id, movement_type: delta > 0 ? "stock_count_reversal_negative" : "stock_count_reversal_positive", direction: delta > 0 ? -1 : 1, quantity_base: Math.abs(delta), unit_cost_micros: cost, total_cost_amount: costMinorForQuantity(Math.abs(delta), cost), source_type: "stock_count_reversal", source_id: String(reversal.id), idempotency_key: `stock-count:${row.id}:reversal:line:${line.id}`, actor_user_id: ctx.user.id, reason: input.reason, stock_count_id: row.id, stock_count_line_id: line.id, stock_count_reversal_id: reversal.id, created_at: now });
      }
      await tx.update(stockCounts).set({ status: "reversed", updated_at: now }).where(eq(stockCounts.id, row.id));
      await tx.insert(stockCountStatusHistory).values({ count_id: row.id, branch_id: row.branch_id, from_status: "posted", to_status: "reversed", actor_user_id: ctx.user.id, reason: input.reason, idempotency_key: `${input.idempotencyKey}:reversed` }).onConflictDoNothing();
      await audit(tx, row.branch_id, ctx.user.id, "stock_count.reversed", row.id, input.reason, { reversalId: reversal.id }); return row.id;
    });
    return getBundle(id, input.branchId, true);
  }),
});
