import { beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { procurementRouter } = await import("../procurement");
const { receivingRouter } = await import("../receiving");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const adminUser = makeUser("receiving-admin");
const managerUser = makeUser("receiving-manager");
const cashierUser = makeUser("receiving-cashier");
const admin = createCallerFactory(receivingRouter)({ user: adminUser });
const manager = createCallerFactory(receivingRouter)({ user: managerUser });
const cashier = createCallerFactory(receivingRouter)({ user: cashierUser });
const procurement = createCallerFactory(procurementRouter)({ user: adminUser });

let branchId: number;
let foreignBranchId: number;
let supplierId: number;
let ingredientId: number;
let secondIngredientId: number;
let mgId: number;
let gramId: number;
let packageId: number;
let locationId: number;
let nextOrder = 1;
let nextReceipt = 1;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([adminUser, managerUser, cashierUser]);
  const [branch, foreign] = await db.insert(schema.branches).values([
    { code: "RECEIVING-MAIN", name_en: "Receiving Main", name_ar: "فرع الاستلام", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "RECEIVING-OTHER", name_en: "Other branch", name_ar: "فرع آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning();
  branchId = branch.id; foreignBranchId = foreign.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: adminUser.id, branch_id: branchId, role: "admin", is_active: true },
    { user_id: managerUser.id, branch_id: branchId, role: "manager", is_active: true },
    { user_id: cashierUser.id, branch_id: branchId, role: "cashier", is_active: true },
  ]);
  const [category] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "DRY", name_en: "Dry goods", name_ar: "جاف", is_active: true }).returning();
  const [location] = await db.insert(schema.inventoryLocations).values({ branch_id: branchId, code: "STORE", name_en: "Store", name_ar: "مخزن", is_active: true }).returning();
  locationId = location.id;
  const [mg, gram] = await db.insert(schema.unitsOfMeasure).values([
    { code: "RCV-MG", name_en: "Milligram", name_ar: "ملغ", dimension: "mass", base_numerator: 1, base_denominator: 1 },
    { code: "RCV-G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 },
  ]).returning();
  mgId = mg.id; gramId = gram.id;
  const [ingredient, second] = await db.insert(schema.ingredients).values([
    { branch_id: branchId, category_id: category.id, sku: "RCV-FLOUR", name_en: "Receipt flour", name_ar: "دقيق الاستلام", base_unit_id: mgId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: adminUser.id, updated_by: adminUser.id },
    { branch_id: branchId, category_id: category.id, sku: "RCV-SUGAR", name_en: "Receipt sugar", name_ar: "سكر الاستلام", base_unit_id: mgId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: adminUser.id, updated_by: adminUser.id },
  ]).returning();
  ingredientId = ingredient.id; secondIngredientId = second.id;
  const [pkg] = await db.insert(schema.ingredientPackageConversions).values({ ingredient_id: ingredientId, code: "RCV-CASE", name_en: "250 gram case", name_ar: "عبوة 250 جرام", base_numerator: 250_000, base_denominator: 1, is_active: true }).returning();
  packageId = pkg.id;
  const [supplier] = await db.insert(schema.suppliers).values({ branch_id: branchId, code: "RCV-SUP", name_en: "Receiving Supplier", name_ar: "مورد الاستلام", is_active: true, created_by: adminUser.id, updated_by: adminUser.id }).returning();
  supplierId = supplier.id;
});

async function approvedOrder(lines: Array<{ ingredientId: number; packageConversionId?: number | null; quantityScaled: number; unitPriceMinor: number }>) {
  const suffix = nextOrder++;
  const order = await procurement.createPurchaseOrder({
    branchId, supplierId, poNumber: `RCV-PO-${suffix}`, idempotencyKey: `receiving-po-key-${suffix}`,
    lines: lines.map((line) => ({ ...line, unitId: gramId, notes: null })),
  });
  await procurement.submitPurchaseOrder({ branchId, purchaseOrderId: order.id });
  await procurement.approvePurchaseOrder({ branchId, purchaseOrderId: order.id });
  return await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order.id), with: { lines: true } });
}

async function draft(orderId: number, lines: Array<{ poLineId: number; accepted?: number; rejected?: number; damaged?: number; price?: number }>, suffix = nextReceipt++) {
  return admin.createDraft({
    branchId, purchaseOrderId: orderId, locationId, receiptNumber: `GRN-RCV-${suffix}`,
    idempotencyKey: `receiving-grn-key-${suffix}`,
    lines: lines.map((line) => ({ purchaseOrderLineId: line.poLineId, acceptedQuantityScaled: line.accepted ?? 0, rejectedQuantityScaled: line.rejected ?? 0, damagedQuantityScaled: line.damaged ?? 0, actualUnitPriceMinor: line.price })),
  });
}

describe("purchase-order receiving", () => {
  it("keeps drafts inventory-neutral, converts exact package/base quantities, posts partial receipts, and tracks completion", async () => {
    const order = await approvedOrder([
      { ingredientId, quantityScaled: 10_000, unitPriceMinor: 100 },
      { ingredientId, packageConversionId: packageId, quantityScaled: 2_000, unitPriceMinor: 250 },
    ]);
    expect(order?.receiving_status).toBe("not_received");
    expect(order?.lines[0].conversion_numerator_snapshot).toBe(1_000);
    expect(order?.lines[1].quantity_base).toBe(500_000_000);
    const before = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const receipt = await draft(order!.id, [
      { poLineId: order!.lines[0].id, accepted: 5_000, rejected: 1_000, damaged: 1_000 },
      { poLineId: order!.lines[1].id, accepted: 1_000 },
    ]);
    expect(receipt.status).toBe("draft");
    expect(receipt.lines[1].accepted_quantity_base).toBe(250_000_000);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.branch_id, branchId))).toHaveLength(0);
    expect(await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.ingredient_id, ingredientId))).toEqual(before);
    await admin.editDraft({ branchId, receiptId: receipt.id, notes: "Counted at delivery", lines: [
      { purchaseOrderLineId: order!.lines[0].id, acceptedQuantityScaled: 5_000, rejectedQuantityScaled: 1_000, damagedQuantityScaled: 1_000 },
      { purchaseOrderLineId: order!.lines[1].id, acceptedQuantityScaled: 1_000 },
    ] });
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity_id, String(receipt.id)))).map((row) => row.action)).toContain("purchase_receipt.draft_update");
    const posted = await admin.post({ branchId, receiptId: receipt.id });
    expect(posted.status).toBe("posted");
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity_id, String(receipt.id)))).map((row) => row.action)).toContain("purchase_receipt.quantity_variance");
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order!.id) }))?.receiving_status).toBe("partially_received");
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)));
    expect(movements.map((row) => row.quantity_base)).toEqual([5_000_000, 250_000_000]);
    expect(movements.every((row) => row.movement_type === "purchase_receipt" && row.direction === 1)).toBe(true);
    const [balance] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    expect(balance.quantity_base).toBe(255_000_000);
    expect(balance.average_unit_cost_micros).toBeGreaterThan(0);
    expect(movements.reduce((sum, row) => sum + row.total_cost_amount, 0)).toBe(750);
    const postAuditBeforeRetry = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "purchase_receipt.post"), eq(schema.auditLogs.entity_id, String(receipt.id))));
    await admin.post({ branchId, receiptId: receipt.id });
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)))).toHaveLength(2);
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "purchase_receipt.post"), eq(schema.auditLogs.entity_id, String(receipt.id))))).toHaveLength(postAuditBeforeRetry.length);
    await expect(admin.editDraft({ branchId, receiptId: receipt.id, lines: [{ purchaseOrderLineId: order!.lines[0].id, acceptedQuantityScaled: 1_000 }] })).rejects.toThrow("Only draft receipts");
    const next = await draft(order!.id, [
      { poLineId: order!.lines[0].id, accepted: 5_000 },
      { poLineId: order!.lines[1].id, accepted: 1_000 },
    ]);
    await admin.post({ branchId, receiptId: next.id });
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order!.id) }))?.receiving_status).toBe("fully_received");
  });

  it("blocks over-receiving by default, permits an audited Manager override, and enforces price variance approval", async () => {
    const order = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const line = order!.lines[0];
    const tooMuch = await draft(order!.id, [{ poLineId: line.id, accepted: 2_000, price: 100 }]);
    await expect(admin.post({ branchId, receiptId: tooMuch.id })).rejects.toThrow("authorized override");
    await manager.post({ branchId, receiptId: tooMuch.id, overreceive: true, overreceiveReason: "Manager approved extra quantity", approveVariance: false });
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity_id, String(tooMuch.id)));
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(["purchase_receipt.post", "purchase_receipt.overreceive"]));
    expect(audit.find((row) => row.action === "purchase_receipt.overreceive")?.reason).toBe("Manager approved extra quantity");
    const varianceOrder = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const varianceReceipt = await draft(varianceOrder!.id, [{ poLineId: varianceOrder!.lines[0].id, accepted: 1_000, price: 120 }]);
    await expect(admin.post({ branchId, receiptId: varianceReceipt.id })).rejects.toThrow("Price variance over 10%");
    await admin.post({ branchId, receiptId: varianceReceipt.id, approveVariance: true, varianceReason: "Supplier invoice confirmed price increase" });
    const varianceAudit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity_id, String(varianceReceipt.id)));
    expect(varianceAudit.map((row) => row.action)).toContain("purchase_receipt.price_variance");
  });

  it("denies Cashier actions, isolates branches, and returns an existing receipt for duplicate requests", async () => {
    const order = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    await expect(cashier.context()).rejects.toThrow("cannot perform purchase-receipt:view");
    await expect(cashier.receipts({ branchId })).rejects.toThrow();
    await expect(admin.receipt({ branchId: foreignBranchId, receiptId: 1 })).rejects.toThrow();
    const duplicateInput = { branchId, purchaseOrderId: order!.id, locationId, receiptNumber: "GRN-RECEIVING-DUPLICATE", idempotencyKey: "receiving-grn-concurrent-key", lines: [{ purchaseOrderLineId: order!.lines[0].id, acceptedQuantityScaled: 1_000 }] };
    const [receipt, concurrentRetry] = await Promise.all([admin.createDraft(duplicateInput), admin.createDraft(duplicateInput)]);
    expect(concurrentRetry.id).toBe(receipt.id);
    expect(await db.select().from(schema.purchaseReceipts).where(eq(schema.purchaseReceipts.idempotency_key, duplicateInput.idempotencyKey))).toHaveLength(1);
    const retry = await admin.createDraft({ branchId, purchaseOrderId: order!.id, locationId, receiptNumber: "IGNORED-ON-RETRY", idempotencyKey: receipt.idempotency_key, lines: [{ purchaseOrderLineId: order!.lines[0].id, acceptedQuantityScaled: 1_000 }] });
    expect(retry.id).toBe(receipt.id);
    await expect(admin.createDraft({ branchId: foreignBranchId, purchaseOrderId: order!.id, locationId, receiptNumber: "GRN-FOREIGN", idempotencyKey: "cross-branch-receipt-key", lines: [{ purchaseOrderLineId: order!.lines[0].id, acceptedQuantityScaled: 1_000 }] })).rejects.toThrow();
  });

  it("reverses an untouched posting exactly and sends later inventory activity to Needs Review", async () => {
    const safeOrder = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const safeReceipt = await draft(safeOrder!.id, [{ poLineId: safeOrder!.lines[0].id, accepted: 1_000 }]);
    await admin.post({ branchId, receiptId: safeReceipt.id });
    const postedReceipt = await admin.receipt({ branchId, receiptId: safeReceipt.id });
    const [afterPost] = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, ingredientId)));
    const reversal = await admin.reverse({ branchId, receiptId: safeReceipt.id, reason: "Duplicate supplier delivery note", idempotencyKey: "receiving-safe-reversal-0001" });
    expect(reversal.status).toBe("reversed");
    const [afterReverse] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.id, afterPost.id));
    expect(afterReverse.quantity_base).toBe(afterPost.quantity_base - safeReceipt.lines[0].accepted_quantity_base);
    expect(afterReverse.average_unit_cost_micros).toBe(postedReceipt.lines[0].balance_unit_cost_before ?? 0);
    expect((await db.query.ingredients.findFirst({ where: eq(schema.ingredients.id, ingredientId) }))?.average_unit_cost_micros).toBe(postedReceipt.lines[0].ingredient_average_unit_cost_before ?? 0);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_type, "purchase_receipt_reversal"))).toHaveLength(1);
    expect((await admin.reverse({ branchId, receiptId: safeReceipt.id, reason: "retry", idempotencyKey: "receiving-safe-reversal-0001" })).id).toBe(reversal.id);

    const reviewOrder = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const reviewReceipt = await draft(reviewOrder!.id, [{ poLineId: reviewOrder!.lines[0].id, accepted: 1_000 }]);
    await admin.post({ branchId, receiptId: reviewReceipt.id });
    await db.insert(schema.stockMovements).values({ branch_id: branchId, location_id: locationId, ingredient_id: ingredientId, movement_type: "manual_negative", direction: -1, quantity_base: 1, unit_cost_micros: 1, total_cost_amount: 0, source_type: "later-consumption", source_id: "later-consumption", idempotency_key: "later-consumption-test-key", actor_user_id: adminUser.id, created_at: new Date(Date.now() + 2_000) });
    const needsReview = await admin.reverse({ branchId, receiptId: reviewReceipt.id, reason: "Delivery correction", idempotencyKey: "receiving-needs-review-0001" });
    expect(needsReview.status).toBe("needs_review");
    expect((await admin.receipt({ branchId, receiptId: reviewReceipt.id })).needs_review_reason).toContain("Later inventory activity");

    const insufficientOrder = await approvedOrder([
      { ingredientId: secondIngredientId, quantityScaled: 1_000, unitPriceMinor: 100 },
      { ingredientId: secondIngredientId, quantityScaled: 1_000, unitPriceMinor: 100 },
    ]);
    const insufficientReceipt = await draft(insufficientOrder!.id, insufficientOrder!.lines.map((line) => ({ poLineId: line.id, accepted: 1_000 })));
    await admin.post({ branchId, receiptId: insufficientReceipt.id });
    await db.update(schema.stockBalances).set({ quantity_base: 1_500_000 }).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, secondIngredientId)));
    const insufficient = await admin.reverse({ branchId, receiptId: insufficientReceipt.id, reason: "Inventory reduced before correction", idempotencyKey: "receiving-insufficient-reversal-0001" });
    expect(insufficient.status).toBe("needs_review");
    expect((await admin.receipt({ branchId, receiptId: insufficientReceipt.id })).needs_review_reason).toContain("Insufficient stock");
  });

  it("rolls back all lines if a later balance overflows and prevents concurrent over-receiving", async () => {
    const order = await approvedOrder([
      { ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 },
      { ingredientId: secondIngredientId, quantityScaled: 1_000, unitPriceMinor: 100 },
    ]);
    const [secondBalance] = await db.update(schema.stockBalances).set({ quantity_base: Number.MAX_SAFE_INTEGER - 100, average_unit_cost_micros: 0 }).where(and(eq(schema.stockBalances.location_id, locationId), eq(schema.stockBalances.ingredient_id, secondIngredientId))).returning();
    const atomic = await draft(order!.id, order!.lines.map((line) => ({ poLineId: line.id, accepted: 1_000 })));
    const beforeMovements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.branch_id, branchId));
    await expect(admin.post({ branchId, receiptId: atomic.id })).rejects.toThrow("exact integer range");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.branch_id, branchId))).toHaveLength(beforeMovements.length);
    expect(await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.ingredient_id, ingredientId))).toHaveLength(1);
    expect((await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.id, secondBalance.id)))[0].quantity_base).toBe(Number.MAX_SAFE_INTEGER - 100);

    const concurrentOrder = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const concurrentDrafts = await Promise.all([
      draft(concurrentOrder!.id, [{ poLineId: concurrentOrder!.lines[0].id, accepted: 1_000 }]),
      draft(concurrentOrder!.id, [{ poLineId: concurrentOrder!.lines[0].id, accepted: 1_000 }]),
    ]);
    const outcomes = await Promise.allSettled(concurrentDrafts.map((row) => admin.post({ branchId, receiptId: row.id })));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, concurrentOrder!.id) }))?.receiving_status).toBe("fully_received");
  });

  it("rolls back earlier line movements and balance updates when a later movement insert fails, then retries cleanly", async () => {
    const order = await approvedOrder([
      { ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 },
      { ingredientId: secondIngredientId, quantityScaled: 1_000, unitPriceMinor: 200 },
    ]);
    const receipt = await draft(order!.id, order!.lines.map((line) => ({ poLineId: line.id, accepted: 1_000 })));
    await db.update(schema.stockBalances).set({ quantity_base: 0, average_unit_cost_micros: 0 }).where(eq(schema.stockBalances.location_id, locationId));
    const beforeBalances = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.branch_id, branchId));

    await pg.exec(`
      CREATE FUNCTION fail_later_receipt_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.ingredient_id = ${secondIngredientId} THEN
          RAISE EXCEPTION 'forced later receipt movement failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_later_receipt_movement_trigger
      BEFORE INSERT ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION fail_later_receipt_movement();
    `);

    try {
      await expect(admin.post({ branchId, receiptId: receipt.id })).rejects.toThrow('Failed query: insert into "stock_movements"');
    } finally {
      await pg.exec("DROP TRIGGER IF EXISTS fail_later_receipt_movement_trigger ON stock_movements; DROP FUNCTION IF EXISTS fail_later_receipt_movement();");
    }
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)))).toHaveLength(0);
    expect(await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.branch_id, branchId))).toEqual(beforeBalances);
    expect((await db.query.purchaseReceipts.findFirst({ where: eq(schema.purchaseReceipts.id, receipt.id) }))?.status).toBe("draft");
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order!.id) }))?.receiving_status).toBe("not_received");
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity_type, "purchase_receipt"), eq(schema.auditLogs.entity_id, String(receipt.id)), eq(schema.auditLogs.action, "purchase_receipt.post")))).toHaveLength(0);

    const posted = await admin.post({ branchId, receiptId: receipt.id });
    expect(posted.status).toBe("posted");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)))).toHaveLength(2);
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order!.id) }))?.receiving_status).toBe("fully_received");
  });

  it("rolls back receipt movements and balances when the required posting audit insert fails", async () => {
    const order = await approvedOrder([{ ingredientId, quantityScaled: 1_000, unitPriceMinor: 100 }]);
    const receipt = await draft(order!.id, [{ poLineId: order!.lines[0].id, accepted: 1_000 }]);
    const beforeBalances = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.branch_id, branchId));
    await pg.exec(`
      CREATE FUNCTION fail_receipt_post_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'purchase_receipt.post' THEN
          RAISE EXCEPTION 'forced receipt audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_receipt_post_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION fail_receipt_post_audit();
    `);

    try {
      await expect(admin.post({ branchId, receiptId: receipt.id })).rejects.toThrow('Failed query: insert into "audit_logs"');
    } finally {
      await pg.exec("DROP TRIGGER IF EXISTS fail_receipt_post_audit_trigger ON audit_logs; DROP FUNCTION IF EXISTS fail_receipt_post_audit();");
    }

    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)))).toHaveLength(0);
    expect(await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.branch_id, branchId))).toEqual(beforeBalances);
    expect((await db.query.purchaseReceipts.findFirst({ where: eq(schema.purchaseReceipts.id, receipt.id) }))?.status).toBe("draft");
    expect((await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, order!.id) }))?.receiving_status).toBe("not_received");

    const posted = await admin.post({ branchId, receiptId: receipt.id });
    expect(posted.status).toBe("posted");
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.source_id, String(receipt.id)))).toHaveLength(1);
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity_type, "purchase_receipt"), eq(schema.auditLogs.entity_id, String(receipt.id)), eq(schema.auditLogs.action, "purchase_receipt.post")))).toHaveLength(1);
  });
});
