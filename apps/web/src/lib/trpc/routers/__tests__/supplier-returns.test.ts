import { beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { procurementRouter } = await import("../procurement");
const { receivingRouter } = await import("../receiving");
const { supplierReturnsRouter } = await import("../supplier-returns");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const adminUser = makeUser("returns-admin");
const managerUser = makeUser("returns-manager");
const cashierUser = makeUser("returns-cashier");
const admin = createCallerFactory(supplierReturnsRouter)({ user: adminUser });
const manager = createCallerFactory(supplierReturnsRouter)({ user: managerUser });
const cashier = createCallerFactory(supplierReturnsRouter)({ user: cashierUser });
const procurement = createCallerFactory(procurementRouter)({ user: adminUser });
const receiving = createCallerFactory(receivingRouter)({ user: adminUser });

let branchId: number;
let foreignBranchId: number;
let locationId: number;
let supplierId: number;
let ingredientId: number;
let gramId: number;
let packageId: number;
let nextId = 1;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([adminUser, managerUser, cashierUser]);
  const [branch, foreign] = await db.insert(schema.branches).values([
    { code: "RETURNS-MAIN", name_en: "Returns Main", name_ar: "فرع المرتجعات", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "RETURNS-OTHER", name_en: "Other", name_ar: "فرع آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning();
  branchId = branch.id; foreignBranchId = foreign.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: adminUser.id, branch_id: branchId, role: "admin", is_active: true },
    { user_id: managerUser.id, branch_id: branchId, role: "manager", is_active: true },
    { user_id: cashierUser.id, branch_id: branchId, role: "cashier", is_active: true },
  ]);
  const [category] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "DRY", name_en: "Dry", name_ar: "جاف", is_active: true }).returning();
  const [location] = await db.insert(schema.inventoryLocations).values({ branch_id: branchId, code: "STORE", name_en: "Store", name_ar: "مخزن", is_active: true }).returning();
  locationId = location.id;
  const [mg, gram] = await db.insert(schema.unitsOfMeasure).values([
    { code: "RET-MG", name_en: "Milligram", name_ar: "ملغ", dimension: "mass", base_numerator: 1, base_denominator: 1 },
    { code: "RET-G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 },
  ]).returning();
  gramId = gram.id;
  const [ingredient] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: category.id, sku: "RET-FLOUR", name_en: "Return flour", name_ar: "دقيق", base_unit_id: mg.id, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: adminUser.id, updated_by: adminUser.id }).returning();
  ingredientId = ingredient.id;
  const [conversion] = await db.insert(schema.ingredientPackageConversions).values({ ingredient_id: ingredientId, code: "RET-CASE", name_en: "250g case", name_ar: "عبوة 250 جرام", base_numerator: 250_000, base_denominator: 1, is_active: true }).returning();
  packageId = conversion.id;
  const [supplier] = await db.insert(schema.suppliers).values({ branch_id: branchId, code: "RET-SUP", name_en: "Return Supplier", name_ar: "مورد", is_active: true, created_by: adminUser.id, updated_by: adminUser.id }).returning();
  supplierId = supplier.id;
});

async function postedReceipt(quantityScaled = 2_000) {
  const id = nextId++;
  const order = await procurement.createPurchaseOrder({ branchId, supplierId, poNumber: `RET-PO-${id}`, idempotencyKey: `return-po-key-${id}`, lines: [{ ingredientId, packageConversionId: packageId, unitId: gramId, quantityScaled, unitPriceMinor: 500, notes: null }] });
  await procurement.submitPurchaseOrder({ branchId, purchaseOrderId: order.id });
  await procurement.approvePurchaseOrder({ branchId, purchaseOrderId: order.id });
  const orderWithLines = await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order.id), with: { lines: true } });
  const receipt = await receiving.createDraft({ branchId, purchaseOrderId: order.id, locationId, receiptNumber: `RET-GRN-${id}`, idempotencyKey: `return-grn-key-${id}`, lines: [{ purchaseOrderLineId: orderWithLines!.lines[0]!.id, acceptedQuantityScaled: quantityScaled, rejectedQuantityScaled: 0, damagedQuantityScaled: 0 }] });
  await receiving.post({ branchId, receiptId: receipt.id });
  return await db.query.purchaseReceipts.findFirst({ where: eq(schema.purchaseReceipts.id, receipt.id), with: { lines: true } });
}

async function draftFrom(receipt: NonNullable<Awaited<ReturnType<typeof postedReceipt>>>, quantityScaled: number, label: string) {
  return admin.createDraft({ branchId, receiptId: receipt.id, returnNumber: `RTV-${label}`, reasonCode: "damaged", reason: null, notes: null, evidenceMetadata: [], idempotencyKey: `return-draft-key-${label}`, lines: [{ receiptLineId: receipt.lines[0].id, quantityScaled }] });
}

describe("supplier returns", () => {
  it("keeps draft/submitted/approved states stock-neutral and snapshots package conversions and original costs", async () => {
    const receipt = (await postedReceipt())!;
    const [before] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    const row = await draftFrom(receipt, 500, "STATE-1");
    expect(row.status).toBe("draft");
    const [initialLine] = await db.query.supplierReturnLines.findMany({ where: eq(schema.supplierReturnLines.supplier_return_id, row.id) });
    await admin.editDraft({ branchId, returnId: row.id, notes: "Draft edit audit sample", lines: [{ receiptLineId: initialLine!.receipt_line_id, quantityScaled: 400 }] });
    const [line] = await db.query.supplierReturnLines.findMany({ where: eq(schema.supplierReturnLines.supplier_return_id, row.id) });
    expect(line!.quantity_base).toBe(100_000_000);
    expect((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "supplier_return.draft_update"), eq(schema.auditLogs.entity_id, String(row.id)))))).toHaveLength(1);
    expect(line.conversion_numerator_snapshot).toBe(250_000);
    expect(line.original_unit_cost_micros_snapshot).toBe(receipt.lines[0]!.accepted_unit_cost_micros_snapshot);
    await admin.submit({ branchId, returnId: row.id, idempotencyKey: "return-submit-key-state-1" });
    await admin.approve({ branchId, returnId: row.id, reason: "Return authorized", idempotencyKey: "return-approve-key-state-1" });
    const [after] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.id, before!.id));
    expect(after).toEqual(before);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).toHaveLength(0);
    await expect(admin.editDraft({ branchId, returnId: row.id, lines: [{ receiptLineId: line.receipt_line_id, quantityScaled: 100 }] })).rejects.toThrow("Only Draft");
  });

  it("rejects excess, protects availability, and atomically dispatches exact quantities once with audit and variance", async () => {
    const receipt = (await postedReceipt())!;
    const row = await draftFrom(receipt, 1_000, "DISPATCH-1");
    const line = (await db.query.supplierReturnLines.findMany({ where: eq(schema.supplierReturnLines.supplier_return_id, row.id) }))[0]!;
    await expect(draftFrom(receipt, 2_500, "EXCESS-1")).rejects.toThrow("must not exceed");
    await expect(cashier.createDraft({ branchId, receiptId: receipt.id, returnNumber: "RTV-CASHIER", reasonCode: "damaged", idempotencyKey: "return-cashier-key", lines: [{ receiptLineId: line.receipt_line_id, quantityScaled: 100 }] })).rejects.toThrow();
    await manager.submit({ branchId, returnId: row.id, idempotencyKey: "return-submit-manager-1" });
    await expect(manager.approve({ branchId, returnId: row.id, reason: "Manager approval", idempotencyKey: "return-approve-manager-1" })).rejects.toThrow();
    await admin.approve({ branchId, returnId: row.id, reason: "Owner authorized dispatch", idempotencyKey: "return-approve-admin-1" });
    const [before] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    const [posted, retry] = await Promise.all([
      admin.dispatch({ branchId, returnId: row.id, reason: "Supplier collected goods", idempotencyKey: "return-dispatch-key-1" }),
      admin.dispatch({ branchId, returnId: row.id, reason: "Supplier collected goods", idempotencyKey: "return-dispatch-key-1" }),
    ]);
    expect(posted.status).toBe("dispatched");
    expect(retry.id).toBe(posted.id);
    const [after] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.id, before!.id));
    expect(after!.quantity_base).toBe(before!.quantity_base - 250_000_000);
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ movement_type: "supplier_return", direction: -1, quantity_base: 250_000_000, purchase_receipt_id: receipt.id, purchase_receipt_line_id: line.receipt_line_id });
    const persistedLine = await db.query.supplierReturnLines.findFirst({ where: eq(schema.supplierReturnLines.id, line.id) });
    expect(persistedLine!.dispatch_unit_cost_micros_snapshot).toBeGreaterThan(0);
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity_type, "supplier_return"), eq(schema.auditLogs.entity_id, String(row.id))))).toHaveLength(4);
    const [dispatchAudit] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "supplier_return.dispatch"), eq(schema.auditLogs.entity_id, String(row.id))));
    const dispatchDetails = JSON.parse(dispatchAudit!.details!) as { lines: Array<{ dispatchValuationMinor: number; quantityBase: number }>; varianceMinor: number };
    expect(dispatchDetails.lines[0]).toMatchObject({ dispatchValuationMinor: persistedLine!.dispatch_valuation_amount!, quantityBase: persistedLine!.quantity_base });
    expect(dispatchDetails.varianceMinor).toBe((await admin.detail({ branchId, returnId: row.id })).cost_variance_amount!);
    await expect(admin.dispatch({ branchId, returnId: row.id, idempotencyKey: "return-dispatch-new-key-2" })).rejects.toThrow("Only Approved");
  });

  it("cancels before dispatch, prevents cross-branch access, and appends safe reversal movements", async () => {
    const cancelReceipt = (await postedReceipt())!;
    const cancelled = await draftFrom(cancelReceipt, 100, "CANCEL-1");
    await admin.cancel({ branchId, returnId: cancelled.id, reason: "Wrong return request", idempotencyKey: "return-cancel-key-1" });
    expect((await admin.detail({ branchId, returnId: cancelled.id })).status).toBe("cancelled");
    await expect(admin.detail({ branchId: foreignBranchId, returnId: cancelled.id })).rejects.toThrow();

    const receipt = (await postedReceipt())!;
    const row = await draftFrom(receipt, 250, "REVERSE-1");
    await admin.submit({ branchId, returnId: row.id, idempotencyKey: "return-submit-reverse-1" });
    await admin.approve({ branchId, returnId: row.id, reason: "Approved", idempotencyKey: "return-approve-reverse-1" });
    await admin.dispatch({ branchId, returnId: row.id, idempotencyKey: "return-dispatch-reverse-1" });
    const [afterDispatch] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    const reversal = await admin.reverseDispatch({ branchId, returnId: row.id, reason: "Dispatch was entered incorrectly", idempotencyKey: "return-reverse-key-1" });
    expect(reversal.status).toBe("reversed");
    const [afterReverse] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.id, afterDispatch!.id));
    expect(afterReverse!.quantity_base).toBeGreaterThan(afterDispatch!.quantity_base);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).toHaveLength(2);
    expect((await admin.detail({ branchId, returnId: row.id })).status).toBe("reversed");
    const duplicate = await admin.reverseDispatch({ branchId, returnId: row.id, reason: "retry reversal", idempotencyKey: "return-reverse-key-1" });
    expect(duplicate.id).toBe(reversal.id);
  });

  it("returns the same draft for a duplicate request and audits permission denials", async () => {
    const receipt = (await postedReceipt())!;
    const args = { branchId, receiptId: receipt.id, returnNumber: "RTV-IDEMPOTENT", reasonCode: "other" as const, reason: "Packaging issue", idempotencyKey: "return-create-idempotent-key", lines: [{ receiptLineId: receipt.lines[0]!.id, quantityScaled: 100 }] };
    const [first, second] = await Promise.all([admin.createDraft(args), admin.createDraft(args)]);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(schema.supplierReturns).where(eq(schema.supplierReturns.idempotency_key, args.idempotencyKey))).toHaveLength(1);
    const deniedBefore = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "supplier_return.permission_denied"));
    await expect(cashier.list({ branchId })).rejects.toThrow();
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "supplier_return.permission_denied"))).toHaveLength(deniedBefore.length + 1);
  });

  it("serializes competing submissions so reserved quantities cannot exceed the source receipt", async () => {
    const receipt = (await postedReceipt(2_000))!;
    const first = await draftFrom(receipt, 1_500, "RACE-A");
    const second = await draftFrom(receipt, 1_500, "RACE-B");
    const results = await Promise.allSettled([
      admin.submit({ branchId, returnId: first.id, idempotencyKey: "return-race-submit-a" }),
      admin.submit({ branchId, returnId: second.id, idempotencyKey: "return-race-submit-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(schema.stockMovements).where(inArray(schema.stockMovements.supplier_return_id, [first.id, second.id]))).toHaveLength(0);
  });

  it("blocks insufficient-stock and multi-line dispatch without partial ledger writes", async () => {
    const id = nextId++;
    const order = await procurement.createPurchaseOrder({ branchId, supplierId, poNumber: `RET-PO-ATOMIC-${id}`, idempotencyKey: `return-po-atomic-${id}`, lines: [
      { ingredientId, packageConversionId: packageId, unitId: gramId, quantityScaled: 1_000, unitPriceMinor: 500, notes: null },
      { ingredientId, packageConversionId: packageId, unitId: gramId, quantityScaled: 1_000, unitPriceMinor: 500, notes: null },
    ] });
    await procurement.submitPurchaseOrder({ branchId, purchaseOrderId: order.id });
    await procurement.approvePurchaseOrder({ branchId, purchaseOrderId: order.id });
    const fullOrder = await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order.id), with: { lines: true } });
    const receiptDraft = await receiving.createDraft({ branchId, purchaseOrderId: order.id, locationId, receiptNumber: `RET-GRN-ATOMIC-${id}`, idempotencyKey: `return-grn-atomic-${id}`, lines: fullOrder!.lines.map((line) => ({ purchaseOrderLineId: line.id, acceptedQuantityScaled: 1_000, rejectedQuantityScaled: 0, damagedQuantityScaled: 0 })) });
    await receiving.post({ branchId, receiptId: receiptDraft.id });
    const receipt = await db.query.purchaseReceipts.findFirst({ where: eq(schema.purchaseReceipts.id, receiptDraft.id), with: { lines: true } });
    const row = await admin.createDraft({ branchId, receiptId: receipt!.id, returnNumber: `RTV-ATOMIC-${id}`, reasonCode: "wrong_item", idempotencyKey: `return-atomic-draft-${id}`, lines: receipt!.lines.map((line) => ({ receiptLineId: line.id, quantityScaled: 1_000 })) });
    const returnLines = await db.query.supplierReturnLines.findMany({ where: eq(schema.supplierReturnLines.supplier_return_id, row.id) });
    await admin.submit({ branchId, returnId: row.id, idempotencyKey: `return-atomic-submit-${id}` });
    await admin.approve({ branchId, returnId: row.id, reason: "Approved for return", idempotencyKey: `return-atomic-approve-${id}` });
    const [balance] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    await db.update(schema.stockBalances).set({ quantity_base: returnLines[0]!.quantity_base + returnLines[1]!.quantity_base - 1 }).where(eq(schema.stockBalances.id, balance!.id));
    const movementCount = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).length;
    await expect(admin.dispatch({ branchId, returnId: row.id, reason: "Cannot dispatch insufficient stock", idempotencyKey: `return-atomic-dispatch-${id}` })).rejects.toThrow("Insufficient on-hand");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).toHaveLength(movementCount);
    expect((await db.query.supplierReturns.findFirst({ where: eq(schema.supplierReturns.id, row.id) }))?.status).toBe("approved");
  });

  it("preserves tampered source snapshots in Needs Review without any stock effect", async () => {
    const receipt = (await postedReceipt())!;
    const row = await draftFrom(receipt, 250, "NEEDS-REVIEW");
    const [line] = await db.select().from(schema.supplierReturnLines).where(eq(schema.supplierReturnLines.supplier_return_id, row.id));
    await db.update(schema.supplierReturnLines).set({ conversion_numerator_snapshot: line!.conversion_numerator_snapshot + 1 }).where(eq(schema.supplierReturnLines.id, line!.id));
    const result = await admin.submit({ branchId, returnId: row.id, idempotencyKey: "return-needs-review-submit" });
    expect(result.status).toBe("needs_review");
    expect(result.needs_review_reason).toContain("conversion");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).toHaveLength(0);
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "supplier_return.needs_review"), eq(schema.auditLogs.entity_id, String(row.id))))).toHaveLength(1);
    await admin.resolveNeedsReview({ branchId, returnId: row.id, reason: "Cancel after source snapshot verification failed", idempotencyKey: "return-needs-review-resolve" });
    expect((await db.query.supplierReturns.findFirst({ where: eq(schema.supplierReturns.id, row.id) }))?.status).toBe("cancelled");
  });

  it("keeps an unsafe dispatched-return reversal in Needs Review without pretending it was cancelled", async () => {
    const receipt = (await postedReceipt())!;
    const row = await draftFrom(receipt, 250, "UNSAFE-REVERSAL");
    await admin.submit({ branchId, returnId: row.id, idempotencyKey: "return-unsafe-submit" });
    await admin.approve({ branchId, returnId: row.id, reason: "Approved", idempotencyKey: "return-unsafe-approve" });
    await admin.dispatch({ branchId, returnId: row.id, idempotencyKey: "return-unsafe-dispatch" });
    const [line] = await db.select().from(schema.supplierReturnLines).where(eq(schema.supplierReturnLines.supplier_return_id, row.id));
    await db.update(schema.supplierReturnLines).set({ dispatch_unit_cost_micros_snapshot: null }).where(eq(schema.supplierReturnLines.id, line!.id));
    const beforeReverse = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id));
    const result = await admin.reverseDispatch({ branchId, returnId: row.id, reason: "Incorrect dispatch record", idempotencyKey: "return-unsafe-reversal" });
    expect(result.status).toBe("needs_review");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.supplier_return_id, row.id))).toHaveLength(beforeReverse.length);
    await expect(admin.resolveNeedsReview({ branchId, returnId: row.id, reason: "Try unsafe cancellation", idempotencyKey: "return-unsafe-cancel" })).rejects.toThrow("inventory reconciliation");
    expect((await db.query.supplierReturns.findFirst({ where: eq(schema.supplierReturns.id, row.id) }))?.status).toBe("needs_review");
  });
});
