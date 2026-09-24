import { beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { stockCountsRouter } = await import("../stock-counts");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");
const adminUser = makeUser("count-admin"); const managerUser = makeUser("count-manager"); const cashierUser = makeUser("count-cashier");
const admin = createCallerFactory(stockCountsRouter)({ user: adminUser }); const manager = createCallerFactory(stockCountsRouter)({ user: managerUser }); const cashier = createCallerFactory(stockCountsRouter)({ user: cashierUser });
let branchId: number; let otherBranchId: number; let locationId: number; let otherLocationId: number; let separateLocationId: number; let cancelLocationId: number; let zeroLocationId: number; let flourId: number; let sugarId: number; let mgId: number; let packageConversionId: number;
let sequence = 1;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([adminUser, managerUser, cashierUser]);
  const [branch, other] = await db.insert(schema.branches).values([
    { code: "COUNT-MAIN", name_en: "Main", name_ar: "Main", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "COUNT-OTHER", name_en: "Other", name_ar: "Other", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning(); branchId = branch.id; otherBranchId = other.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: adminUser.id, branch_id: branchId, role: "admin", is_active: true },
    { user_id: managerUser.id, branch_id: branchId, role: "manager", is_active: true },
    { user_id: cashierUser.id, branch_id: branchId, role: "cashier", is_active: true },
  ]);
  const [category] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "COUNT-CAT", name_en: "Count", name_ar: "Count", is_active: true }).returning();
  const [location, otherLocation, separateLocation, cancelLocation, zeroLocation] = await db.insert(schema.inventoryLocations).values([
    { branch_id: branchId, code: "COUNT-LOC", name_en: "Count location", name_ar: "Count", is_active: true },
    { branch_id: otherBranchId, code: "COUNT-OTHER-LOC", name_en: "Other location", name_ar: "Other", is_active: true },
    { branch_id: branchId, code: "COUNT-SEPARATE", name_en: "Separate location", name_ar: "Separate", is_active: true },
    { branch_id: branchId, code: "COUNT-CANCEL", name_en: "Cancel location", name_ar: "Cancel", is_active: true },
    { branch_id: branchId, code: "COUNT-ZERO", name_en: "Zero location", name_ar: "Zero", is_active: true },
  ]).returning(); locationId = location.id; otherLocationId = otherLocation.id; separateLocationId = separateLocation.id; cancelLocationId = cancelLocation.id; zeroLocationId = zeroLocation.id;
  const [mg] = await db.insert(schema.unitsOfMeasure).values({ code: "COUNT-MG", name_en: "Milligram", name_ar: "mg", dimension: "mass", base_numerator: 1, base_denominator: 1 }).returning(); mgId = mg.id;
  const [flour, sugar] = await db.insert(schema.ingredients).values([
    { branch_id: branchId, category_id: category.id, sku: "COUNT-FLOUR", name_en: "Flour", name_ar: "دقيق", base_unit_id: mgId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 2_000_000, created_by: adminUser.id, updated_by: adminUser.id },
    { branch_id: branchId, category_id: category.id, sku: "COUNT-SUGAR", name_en: "Sugar", name_ar: "سكر", base_unit_id: mgId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 1_000_000, created_by: adminUser.id, updated_by: adminUser.id },
  ]).returning(); flourId = flour.id; sugarId = sugar.id;
  const [pkg] = await db.insert(schema.ingredientPackageConversions).values({ ingredient_id: sugarId, code: "COUNT-BAG", name_en: "Bag", name_ar: "كيس", base_numerator: 250_000, base_denominator: 1, is_active: true }).returning(); packageConversionId = pkg.id;
  await db.insert(schema.stockBalances).values([
    { branch_id: branchId, location_id: locationId, ingredient_id: flourId, quantity_base: 1_000, average_unit_cost_micros: 2_000_000 },
    { branch_id: branchId, location_id: locationId, ingredient_id: sugarId, quantity_base: 250_000_500, average_unit_cost_micros: 1_000_000 },
  ]);
});

async function draft(location = locationId) { const n = sequence++; return manager.createDraft({ branchId, countNumber: `SC-TEST-${n}`, locationId: location, notes: null, idempotencyKey: `stock-count-create-${n}` }); }
async function byId(id: number) { return db.query.stockCounts.findFirst({ where: eq(schema.stockCounts.id, id) }); }
async function balance(ingredientId: number) { return db.query.stockBalances.findFirst({ where: and(eq(schema.stockBalances.branch_id, branchId), eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)) }); }
async function fillAndSubmit(id: number) {
  const row = await manager.start({ branchId, countId: id, idempotencyKey: `stock-count-start-${id}` });
  const flour = row.lines.find((line) => line.ingredient_id === flourId)!; const sugar = row.lines.find((line) => line.ingredient_id === sugarId)!;
  await manager.enterLine({ branchId, countId: id, lineId: flour.id, quantityScaled: 1_500, zeroConfirmed: false, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-${id}-flour` });
  await manager.enterLine({ branchId, countId: id, lineId: sugar.id, quantityScaled: 1_000, zeroConfirmed: false, unitId: mgId, packageConversionId, idempotencyKey: `count-entry-${id}-sugar` });
  return { row, flour, sugar, submitted: await manager.submit({ branchId, countId: id, idempotencyKey: `stock-count-submit-${id}` }) };
}

describe("full stock counts", () => {
  it("enforces branch/location access, one active count, blind snapshots, and cashier denial", async () => {
    const row = await draft();
    await expect(admin.createDraft({ branchId, countNumber: "SC-SECOND", locationId, idempotencyKey: "stock-count-second-draft" })).rejects.toThrow();
    await expect(manager.detail({ branchId: otherBranchId, countId: row.id })).rejects.toThrow();
    await expect(cashier.context()).rejects.toThrow("stock-count:view");
    await expect(cashier.post({ branchId, countId: row.id, idempotencyKey: "count-cashier-post-denied" })).rejects.toThrow("stock-count:post");
    const started = await manager.start({ branchId, countId: row.id, idempotencyKey: "stock-count-start-blind" });
    expect(started.lines).toHaveLength(2);
    expect(started.lines.every((line) => line.expected_quantity_base === null)).toBe(true);
    expect(started.lines.map((line) => line.ingredient_id).sort()).toEqual([flourId, sugarId].sort());
    await expect(manager.submit({ branchId, countId: row.id, idempotencyKey: "stock-count-submit-blank" })).rejects.toThrow("explicitly confirmed as zero");
    expect((await db.select().from(schema.stockMovements))).toHaveLength(0);
    await admin.cancel({ branchId, countId: row.id, reason: "End permission test", idempotencyKey: "count-cancel-permission-test" });
  });

  it("counts base/package quantities, distinguishes zero, approves without movements, posts exactly once, and reverses append-only", async () => {
    const row = await draft(); const { flour, sugar, submitted } = await fillAndSubmit(row.id);
    expect(flour.counted_quantity_base).toBeNull();
    expect(submitted.lines.find((line) => line.ingredient_id === flourId)?.expected_quantity_base).toBe(1_000);
    expect(submitted.lines.find((line) => line.ingredient_id === flourId)?.variance_base).toBe(500);
    expect(submitted.lines.find((line) => line.ingredient_id === sugarId)?.counted_quantity_base).toBe(250_000_000);
    expect(submitted.lines.find((line) => line.ingredient_id === sugarId)?.variance_base).toBe(-500);
    await manager.enterLine({ branchId, countId: row.id, lineId: flour.id, quantityScaled: 1_500, zeroConfirmed: false, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-${row.id}-flour` });
    expect(await db.select().from(schema.stockCountEntries).where(eq(schema.stockCountEntries.count_id, row.id))).toHaveLength(2);
    const before = (await db.select().from(schema.stockMovements)).length;
    const approved = await manager.approve({ branchId, countId: row.id, reason: "Physical count checked", idempotencyKey: `stock-count-approve-${row.id}` });
    expect(approved.status).toBe("approved"); expect((await db.select().from(schema.stockMovements))).toHaveLength(before);
    const posted = await manager.post({ branchId, countId: row.id, idempotencyKey: `stock-count-post-${row.id}` });
    expect(posted.status).toBe("posted");
    expect((await balance(flourId))?.quantity_base).toBe(1_500);
    expect((await balance(sugarId))?.quantity_base).toBe(250_000_000);
    const original = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, row.id));
    expect(original).toHaveLength(2); expect(original.map((movement) => movement.movement_type).sort()).toEqual(["stock_count_negative", "stock_count_positive"]);
    expect(original.every((movement) => movement.total_cost_amount === 1)).toBe(true);
    expect((await balance(flourId))?.average_unit_cost_micros).toBe(2_000_000);
    await expect(manager.enterLine({ branchId, countId: row.id, lineId: flour.id, quantityScaled: 999, zeroConfirmed: false, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-after-submit-${row.id}` })).rejects.toThrow("during Counting");
    const concurrent = await Promise.all([manager.post({ branchId, countId: row.id, idempotencyKey: `stock-count-post-retry-${row.id}` }), manager.post({ branchId, countId: row.id, idempotencyKey: `stock-count-post-race-${row.id}` })]);
    expect(concurrent.every((result) => result.status === "posted")).toBe(true);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, row.id))).toHaveLength(2);
    const reversed = await admin.reverse({ branchId, countId: row.id, reason: "Count posted in error", idempotencyKey: `stock-count-reverse-${row.id}` });
    expect(reversed.status).toBe("reversed"); expect((await balance(flourId))?.quantity_base).toBe(1_000); expect((await balance(sugarId))?.quantity_base).toBe(250_000_500);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, row.id))).toHaveLength(4);
    await expect(admin.cancel({ branchId, countId: row.id, reason: "Too late", idempotencyKey: `stock-count-cancel-late-${row.id}` })).rejects.toThrow("not yet posted");
  });

  it("moves stale snapshots to Needs Review without count adjustments and never partially reverses later activity", async () => {
    const stale = await draft(); const started = await manager.start({ branchId, countId: stale.id, idempotencyKey: `count-start-${stale.id}` });
    const lines = started.lines;
    for (const line of lines) await manager.enterLine({ branchId, countId: stale.id, lineId: line.id, quantityScaled: line.ingredient_id === flourId ? 1_000 : 0, zeroConfirmed: line.ingredient_id === sugarId, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-stale-${stale.id}-${line.id}` });
    await manager.submit({ branchId, countId: stale.id, idempotencyKey: `count-submit-${stale.id}` }); await manager.approve({ branchId, countId: stale.id, reason: "Reviewed", idempotencyKey: `count-approve-${stale.id}` });
    const flourBalance = await balance(flourId);
    await db.update(schema.stockBalances).set({ quantity_base: flourBalance!.quantity_base + 1 }).where(eq(schema.stockBalances.id, flourBalance!.id));
    await db.insert(schema.stockMovements).values({ branch_id: branchId, location_id: locationId, ingredient_id: flourId, movement_type: "manual_positive", direction: 1, quantity_base: 1, unit_cost_micros: 2_000_000, total_cost_amount: 0, source_type: "later-test", source_id: "later-test", idempotency_key: `count-stale-movement-${stale.id}`, actor_user_id: adminUser.id });
    const beforeCountAdjustments = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, stale.id));
    const conflict = await manager.post({ branchId, countId: stale.id, idempotencyKey: `count-post-${stale.id}` });
    expect(conflict.status).toBe("needs_review"); expect(conflict.needs_review_reason).toContain("changed");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, stale.id))).toHaveLength(beforeCountAdjustments.length);
    await expect(manager.post({ branchId, countId: stale.id, idempotencyKey: `count-post-again-${stale.id}` })).rejects.toThrow("approved");

    const reversalTarget = await draft(separateLocationId);
    const reversalStart = await manager.start({ branchId, countId: reversalTarget.id, idempotencyKey: `count-start-reversal-${reversalTarget.id}` });
    for (const line of reversalStart.lines) await manager.enterLine({ branchId, countId: reversalTarget.id, lineId: line.id, quantityScaled: line.ingredient_id === flourId ? 1 : 0, zeroConfirmed: line.ingredient_id === sugarId, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-reversal-${reversalTarget.id}-${line.id}` });
    await manager.submit({ branchId, countId: reversalTarget.id, idempotencyKey: `count-submit-reversal-${reversalTarget.id}` }); await manager.approve({ branchId, countId: reversalTarget.id, reason: "Verified separate location", idempotencyKey: `count-approve-reversal-${reversalTarget.id}` }); await manager.post({ branchId, countId: reversalTarget.id, idempotencyKey: `count-post-reversal-${reversalTarget.id}` });
    const beforeUnsafeReverse = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, reversalTarget.id));
    const separateBalance = await db.query.stockBalances.findFirst({ where: and(eq(schema.stockBalances.location_id, separateLocationId), eq(schema.stockBalances.ingredient_id, flourId)) });
    await db.update(schema.stockBalances).set({ quantity_base: separateBalance!.quantity_base + 1 }).where(eq(schema.stockBalances.id, separateBalance!.id));
    await db.insert(schema.stockMovements).values({ branch_id: branchId, location_id: separateLocationId, ingredient_id: flourId, movement_type: "manual_positive", direction: 1, quantity_base: 1, unit_cost_micros: 2_000_000, total_cost_amount: 0, source_type: "later-test", source_id: "later-test-reverse", idempotency_key: `count-later-reverse-${reversalTarget.id}`, actor_user_id: adminUser.id });
    const unsafe = await admin.reverse({ branchId, countId: reversalTarget.id, reason: "Test detects later activity", idempotencyKey: `count-unsafe-reverse-${reversalTarget.id}` });
    expect(unsafe.status).toBe("needs_review"); expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_count_id, reversalTarget.id))).toHaveLength(beforeUnsafeReverse.length);
  });

  it("cancels a pre-post count without stock effects and prevents cross-branch location selection", async () => {
    await expect(manager.createDraft({ branchId, countNumber: "SC-CROSS", locationId: otherLocationId, idempotencyKey: "stock-count-cross-branch" })).rejects.toThrow("active inventory location");
    const row = await draft(cancelLocationId); const before = await db.select().from(schema.stockMovements); const cancelled = await admin.cancel({ branchId, countId: row.id, reason: "Duplicate operational request", idempotencyKey: `count-cancel-${row.id}` });
    expect(cancelled.status).toBe("cancelled"); expect(await db.select().from(schema.stockMovements)).toHaveLength(before.length);
  });

  it("posts a zero-variance count with no inventory movement", async () => {
    const row = await draft(zeroLocationId); const started = await manager.start({ branchId, countId: row.id, idempotencyKey: `count-start-zero-${row.id}` });
    for (const line of started.lines) await manager.enterLine({ branchId, countId: row.id, lineId: line.id, quantityScaled: 0, zeroConfirmed: true, unitId: mgId, packageConversionId: null, idempotencyKey: `count-entry-zero-${row.id}-${line.id}` });
    await manager.submit({ branchId, countId: row.id, idempotencyKey: `count-submit-zero-${row.id}` }); await manager.approve({ branchId, countId: row.id, reason: "Zero balances verified", idempotencyKey: `count-approve-zero-${row.id}` });
    const before = await db.select().from(schema.stockMovements); const posted = await manager.post({ branchId, countId: row.id, idempotencyKey: `count-post-zero-${row.id}` });
    expect(posted.status).toBe("posted"); expect(await db.select().from(schema.stockMovements)).toHaveLength(before.length);
  });
});
