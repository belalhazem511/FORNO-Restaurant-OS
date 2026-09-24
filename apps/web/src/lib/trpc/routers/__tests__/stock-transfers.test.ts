import { beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { movingWeightedAverage } from "@/lib/inventory/exact";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { stockTransfersRouter } = await import("../stock-transfers");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");
const adminUser = makeUser("transfer-admin"); const managerUser = makeUser("transfer-manager"); const cashierUser = makeUser("transfer-cashier");
const admin = createCallerFactory(stockTransfersRouter)({ user: adminUser }); const manager = createCallerFactory(stockTransfersRouter)({ user: managerUser }); const cashier = createCallerFactory(stockTransfersRouter)({ user: cashierUser });
let branchId: number; let foreignBranchId: number; let sourceId: number; let destinationId: number; let foreignLocationId: number;
let ingredientId: number; let packageIngredientId: number; let baseUnitId: number; let gramId: number; let packageUnitId: number; let packageId: number;
let next = 1;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([adminUser, managerUser, cashierUser]);
  const [branch, foreign] = await db.insert(schema.branches).values([
    { code: "TRANSFER-MAIN", name_en: "Transfer Main", name_ar: "Main", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "TRANSFER-OTHER", name_en: "Other", name_ar: "Other", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning(); branchId = branch.id; foreignBranchId = foreign.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: adminUser.id, branch_id: branchId, role: "admin", is_active: true },
    { user_id: managerUser.id, branch_id: branchId, role: "manager", is_active: true },
    { user_id: cashierUser.id, branch_id: branchId, role: "cashier", is_active: true },
  ]);
  const [category] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "TRANSFER-DRY", name_en: "Dry", name_ar: "Dry", is_active: true }).returning();
  const [source, destination, foreignLocation] = await db.insert(schema.inventoryLocations).values([
    { branch_id: branchId, code: "TRANSFER-SOURCE", name_en: "Source", name_ar: "Source", is_active: true },
    { branch_id: branchId, code: "TRANSFER-DEST", name_en: "Destination", name_ar: "Destination", is_active: true },
    { branch_id: foreignBranchId, code: "TRANSFER-FOREIGN", name_en: "Foreign", name_ar: "Foreign", is_active: true },
  ]).returning(); sourceId = source.id; destinationId = destination.id; foreignLocationId = foreignLocation.id;
  const [baseUnit, gram, packageUnit] = await db.insert(schema.unitsOfMeasure).values([
    { code: "TRANSFER-MG", name_en: "Milligram", name_ar: "mg", dimension: "mass", base_numerator: 1, base_denominator: 1 },
    { code: "TRANSFER-G", name_en: "Gram", name_ar: "g", dimension: "mass", base_numerator: 1_000, base_denominator: 1 },
    { code: "TRANSFER-PACK", name_en: "Pack", name_ar: "pack", dimension: "mass", base_numerator: 1_000, base_denominator: 1 },
  ]).returning(); baseUnitId = baseUnit.id; gramId = gram.id; packageUnitId = packageUnit.id;
  const [a, b] = await db.insert(schema.ingredients).values([
    { branch_id: branchId, category_id: category.id, sku: "TRANSFER-FLOUR", name_en: "Transfer flour", name_ar: "Flour", base_unit_id: baseUnitId, dimension: "mass", default_location_id: sourceId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: adminUser.id, updated_by: adminUser.id },
    { branch_id: branchId, category_id: category.id, sku: "TRANSFER-SUGAR", name_en: "Transfer sugar", name_ar: "Sugar", base_unit_id: baseUnitId, dimension: "mass", default_location_id: sourceId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: adminUser.id, updated_by: adminUser.id },
  ]).returning(); ingredientId = a.id; packageIngredientId = b.id;
  const [pkg] = await db.insert(schema.ingredientPackageConversions).values({ ingredient_id: packageIngredientId, code: "TRANSFER-CASE", name_en: "250 gram case", name_ar: "Case", base_numerator: 250_000, base_denominator: 1, is_active: true }).returning(); packageId = pkg.id;
  await db.insert(schema.stockBalances).values([
    { branch_id: branchId, location_id: sourceId, ingredient_id: ingredientId, quantity_base: 5_000_000, average_unit_cost_micros: 2_000_000 },
    { branch_id: branchId, location_id: sourceId, ingredient_id: packageIngredientId, quantity_base: 1_500_000_000, average_unit_cost_micros: 1_000_000 },
    { branch_id: branchId, location_id: destinationId, ingredient_id: packageIngredientId, quantity_base: 250_000, average_unit_cost_micros: 2_000_000 },
  ]);
});

async function draft(suffix = next++, baseScaled = 1_000, packageScaled = 1_000) {
  return admin.createDraft({ branchId, transferNumber: `ST-TEST-${suffix}`, sourceLocationId: sourceId, destinationLocationId: destinationId, idempotencyKey: `stock-transfer-create-${suffix}`, lines: [
    { ingredientId, unitId: gramId, quantityScaled: baseScaled },
    { ingredientId: packageIngredientId, unitId: packageUnitId, packageConversionId: packageId, quantityScaled: packageScaled },
  ] });
}
async function approved(suffix = next++, baseScaled = 1_000) { const row = await draft(suffix, baseScaled); await manager.submit({ branchId, transferId: row.id, idempotencyKey: `stock-transfer-submit-${suffix}` }); return manager.approve({ branchId, transferId: row.id, reason: "Operational transfer approved", idempotencyKey: `stock-transfer-approve-${suffix}` }); }
async function balance(locationId: number, id: number) { return db.query.stockBalances.findFirst({ where: and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, id)) }); }

describe("internal stock transfers", () => {
  it("validates source/destination and branch, denies Cashier, and is stock-neutral through approval", async () => {
    const before = await db.select().from(schema.stockMovements);
    await expect(admin.createDraft({ branchId, transferNumber: "ST-SAME-LOC", sourceLocationId: sourceId, destinationLocationId: sourceId, idempotencyKey: "transfer-same-location-key", lines: [{ ingredientId, unitId: gramId, quantityScaled: 1_000 }] })).rejects.toThrow("different");
    await expect(admin.createDraft({ branchId, transferNumber: "ST-CROSS-LOC", sourceLocationId: sourceId, destinationLocationId: foreignLocationId, idempotencyKey: "transfer-cross-branch-key", lines: [{ ingredientId, unitId: gramId, quantityScaled: 1_000 }] })).rejects.toThrow("branch");
    const row = await admin.createDraft({ branchId, transferNumber: "ST-TAMPER-SNAPSHOT", sourceLocationId: sourceId, destinationLocationId: destinationId, idempotencyKey: "transfer-tamper-key", lines: [({ ingredientId, unitId: gramId, quantityScaled: 1_000, quantityBase: 999_999, conversionNumeratorSnapshot: 999_999, unitCostMicros: 0 } as never)] });
    expect(row.lines[0]).toMatchObject({ quantity_base: 1_000_000, conversion_numerator_snapshot: 1_000 });
    await admin.cancel({ branchId, transferId: row.id, reason: "Discard tamper test", idempotencyKey: "transfer-tamper-cancel" });
    const valid = await draft();
    expect(valid.lines[1]).toMatchObject({ quantity_base: 250_000_000, conversion_numerator_snapshot: 250_000, package_code_snapshot: "TRANSFER-CASE" });
    await manager.submit({ branchId, transferId: valid.id, idempotencyKey: "transfer-submit-main" });
    await expect(manager.editDraft({ branchId, transferId: valid.id, lines: [{ ingredientId, unitId: gramId, quantityScaled: 100 }] })).rejects.toThrow("Draft");
    await manager.approve({ branchId, transferId: valid.id, reason: "Manager approval", idempotencyKey: "transfer-approve-main" });
    expect(await db.select().from(schema.stockMovements)).toHaveLength(before.length);
    await expect(cashier.list({ branchId })).rejects.toThrow();
    await expect(cashier.dispatch({ branchId, transferId: valid.id, idempotencyKey: "cashier-transfer-dispatch" })).rejects.toThrow();
    await expect(admin.detail({ branchId: foreignBranchId, transferId: valid.id })).rejects.toThrow();
  });

  it("dispatches once, receives partially then completely at the dispatch valuation, and reverses safely", async () => {
    const financialCounts = { transactions: (await db.select().from(schema.transactions)).length, payments: (await db.select().from(schema.orderPayments)).length };
    const row = await approved();
    const sourceBefore = await balance(sourceId, ingredientId); const destBefore = await balance(destinationId, packageIngredientId);
    const [sent, retry] = await Promise.all([
      manager.dispatch(({ branchId, transferId: row.id, reason: "Truck departed", idempotencyKey: "transfer-dispatch-idempotent", quantityBase: 9_999_999, unitCostMicros: 0 } as never)),
      manager.dispatch({ branchId, transferId: row.id, reason: "Truck departed", idempotencyKey: "transfer-dispatch-idempotent" }),
    ]);
    expect(sent.status).toBe("dispatched"); expect(retry.id).toBe(sent.id);
    expect((await balance(sourceId, ingredientId))?.quantity_base).toBe(sourceBefore!.quantity_base - row.lines[0]!.quantity_base);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id))).toHaveLength(2);
    await expect(manager.cancel({ branchId, transferId: row.id, reason: "Too late", idempotencyKey: "transfer-late-cancel-key" })).rejects.toThrow("pre-dispatch");
    const [firstReceipt, partialRetry] = await Promise.all([
      manager.receive({ branchId, transferId: row.id, lines: [{ transferLineId: row.lines[1]!.id, quantityScaled: 500 }], idempotencyKey: "transfer-receive-partial" }),
      manager.receive({ branchId, transferId: row.id, lines: [{ transferLineId: row.lines[1]!.id, quantityScaled: 500 }], idempotencyKey: "transfer-receive-partial" }),
    ]);
    expect(partialRetry.id).toBe(firstReceipt.id);
    expect(firstReceipt.status).toBe("partially_received");
    const lineB = firstReceipt.lines.find((line) => line.id === row.lines[1]!.id)!;
    expect(lineB.received_base).toBe(125_000_000); expect(lineB.in_transit_base).toBe(125_000_000);
    const expectedAvg = movingWeightedAverage({ existingQuantity: destBefore!.quantity_base, existingUnitCostMicros: destBefore!.average_unit_cost_micros, addedQuantity: 125_000_000, addedUnitCostMicros: 1_000_000 });
    expect((await balance(destinationId, packageIngredientId))?.average_unit_cost_micros).toBe(expectedAvg);
    await expect(manager.receive({ branchId, transferId: row.id, lines: [{ transferLineId: row.lines[1]!.id, quantityScaled: 1_000 }], idempotencyKey: "transfer-excess-receipt" })).rejects.toThrow("remaining dispatched");
    const final = await manager.receive({ branchId, transferId: row.id, lines: [{ transferLineId: row.lines[0]!.id, quantityScaled: 1_000 }, { transferLineId: row.lines[1]!.id, quantityScaled: 500 }], idempotencyKey: "transfer-receive-final" });
    expect(final.status).toBe("received"); expect(final.lines.every((line) => line.in_transit_base === 0)).toBe(true);
    const reversal = await admin.reverse({ branchId, transferId: row.id, reason: "Transfer recorded in error", idempotencyKey: "transfer-reverse-safe" });
    expect(reversal.status).toBe("reversed");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id))).toHaveLength(10);
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity_type, "stock_transfer"), eq(schema.auditLogs.entity_id, String(row.id))))).toHaveLength(7);
    expect({ transactions: (await db.select().from(schema.transactions)).length, payments: (await db.select().from(schema.orderPayments)).length }).toEqual(financialCounts);
  });

  it("blocks insufficient and tampered stock paths atomically; cancellation stays pre-dispatch only", async () => {
    const row = await approved(next++, 9_000);
    const movementsBefore = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id));
    await expect(manager.dispatch({ branchId, transferId: row.id, idempotencyKey: "transfer-insufficient-stock" })).rejects.toThrow("Insufficient stock");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id))).toHaveLength(movementsBefore.length);
    const cancellable = await draft();
    await manager.cancel({ branchId, transferId: cancellable.id, reason: "No vehicle available", idempotencyKey: "transfer-cancel-before" });
    expect((await admin.detail({ branchId, transferId: cancellable.id })).status).toBe("cancelled");
    const inTransit = await approved(); await manager.dispatch({ branchId, transferId: inTransit.id, idempotencyKey: "transfer-intransit-dispatch" });
    const beforeReverse = await balance(sourceId, ingredientId);
    const reversed = await admin.reverse({ branchId, transferId: inTransit.id, reason: "Dispatch was not intended", idempotencyKey: "transfer-intransit-reversal" });
    expect(reversed.status).toBe("reversed");
    expect((await balance(sourceId, ingredientId))?.quantity_base).toBe(beforeReverse!.quantity_base + inTransit.lines[0]!.quantity_base);
  });

  it("serializes competing dispatch and receipt requests without overspending or duplicate ledger rows", async () => {
    const dispatchTarget = await approved();
    const dispatches = await Promise.allSettled([
      manager.dispatch({ branchId, transferId: dispatchTarget.id, idempotencyKey: "transfer-concurrent-dispatch-a" }),
      manager.dispatch({ branchId, transferId: dispatchTarget.id, idempotencyKey: "transfer-concurrent-dispatch-b" }),
    ]);
    expect(dispatches.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(dispatches.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, dispatchTarget.id))).toHaveLength(2);

    const receiptTarget = await approved(); await manager.dispatch({ branchId, transferId: receiptTarget.id, idempotencyKey: "transfer-concurrent-receipt-dispatch" });
    const competingReceipts = await Promise.allSettled([
      manager.receive({ branchId, transferId: receiptTarget.id, lines: [{ transferLineId: receiptTarget.lines[0]!.id, quantityScaled: 1_000 }], idempotencyKey: "transfer-concurrent-receipt-a" }),
      manager.receive({ branchId, transferId: receiptTarget.id, lines: [{ transferLineId: receiptTarget.lines[0]!.id, quantityScaled: 1_000 }], idempotencyKey: "transfer-concurrent-receipt-b" }),
    ]);
    expect(competingReceipts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competingReceipts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.stock_transfer_id, receiptTarget.id), eq(schema.stockMovements.movement_type, "stock_transfer_in")))).toHaveLength(1);
  });

  it("marks an unsafe received reversal Needs Review without partial compensation", async () => {
    const row = await approved(); await manager.dispatch({ branchId, transferId: row.id, idempotencyKey: "transfer-unsafe-dispatch" });
    await manager.receive({ branchId, transferId: row.id, lines: [{ transferLineId: row.lines[0]!.id, quantityScaled: 1_000 }], idempotencyKey: "transfer-unsafe-receipt" });
    const [later] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id));
    await db.insert(schema.stockMovements).values({ branch_id: branchId, location_id: destinationId, ingredient_id: ingredientId, movement_type: "manual_negative", direction: -1, quantity_base: 1, unit_cost_micros: 1, total_cost_amount: 0, source_type: "later-activity", source_id: "later-activity", idempotency_key: "transfer-later-stock-activity", actor_user_id: adminUser.id, created_at: new Date(later!.created_at.getTime() + 2_000) });
    const before = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id));
    const result = await admin.reverse({ branchId, transferId: row.id, reason: "Wrong destination", idempotencyKey: "transfer-unsafe-reversal" });
    expect(result.status).toBe("needs_review"); expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stock_transfer_id, row.id))).toHaveLength(before.length);
  });
});
