import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { offlineRouter } = await import("../offline");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");
const caller = (id: string) => createCallerFactory(offlineRouter)({ user: makeUser(id) });
const cashier = caller("offline-cashier");
const manager = caller("offline-manager");
const outsider = caller("offline-outsider");

let branchId: number;
let otherBranchId: number;
let registerId: number;
let shiftId: number;
let tableId: number;
let revision: string;
let priceSnapshotReference: string;
let priceSnapshotRevision: string;
let inventoryIngredientId: number;
let items: Array<{ id: number; stationId: number; price: number }>;
let sequence = 0;

function operation(overrides: Record<string, unknown> = {}) {
  const id = ++sequence;
  const checkoutIdempotencyKey = `offline-checkout-${id.toString().padStart(4, "0")}`;
  const checkoutAt = "2026-08-11T12:00:00.000Z";
  const deviceInstanceId = "00000000-0000-4000-8000-000000000001";
  const digest = createHash("sha256").update(`${branchId}:${registerId}:${deviceInstanceId}:${checkoutIdempotencyKey}`).digest("hex").slice(0, 16).toUpperCase();
  const total = items.reduce((sum, item) => sum + item.price, 0);
  const base = {
    kind: "cash_sale" as const,
    clientOperationId: `offline-operation-${id.toString().padStart(4, "0")}`,
    snapshotRevision: revision,
    priceSnapshotReference,
    priceSnapshotRevision,
    branchId,
    registerId,
    shiftId,
    order: {
      clientRequestId: `offline-order-request-${id.toString().padStart(4, "0")}`,
      orderType: "takeaway" as "dine_in" | "takeaway" | "delivery",
      diningTableId: null as number | null,
      deliveryAddress: null,
      deliveryContact: null,
      expectedTotal: total,
      items: items.map((item) => ({ menuItemId: item.id, variantId: null, modifierOptionIds: [], quantity: 1, notes: item.stationId === items[0].stationId ? "No onions" : null })),
    },
    cash: { checkoutIdempotencyKey, tenderedAmount: 100_000 },
    offlineReceipt: { number: `OFF-OFFLINE-OFFLINEP-20260811-${digest}`, deviceInstanceId, checkoutAt, subtotal: total, total, cashReceived: 100_000, change: 100_000 - total, printIdempotencyKey: `offline-receipt-print-${id.toString().padStart(4, "0")}`, previewedAt: checkoutAt },
    kotAcknowledgements: items.map((item) => ({ stationId: item.stationId, idempotencyKey: `offline-kot-${id}-${item.stationId}`, previewed: true, acknowledged: false })),
  };
  return { ...base, ...overrides };
}

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([
    { id: "offline-cashier", name: "Offline Cashier", email: "offline-cashier@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "offline-manager", name: "Offline Manager", email: "offline-manager@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "offline-outsider", name: "Outsider", email: "offline-outsider@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const branches = await db.insert(schema.branches).values([
    { code: "OFFLINE", name_en: "Offline Branch", name_ar: "فرع دون اتصال", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "OFFLINE-OTHER", name_en: "Other", name_ar: "آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning();
  branchId = branches[0].id;
  otherBranchId = branches[1].id;
  await db.insert(schema.staffAssignments).values([
    { user_id: "offline-cashier", branch_id: branchId, role: "cashier", is_active: true, updated_at: new Date() },
    { user_id: "offline-manager", branch_id: branchId, role: "manager", is_active: true, updated_at: new Date() },
    { user_id: "offline-outsider", branch_id: otherBranchId, role: "cashier", is_active: true, updated_at: new Date() },
  ]);
  const [register] = await db.insert(schema.cashierRegisters).values({ branch_id: branchId, code: "OFFLINE-POS", name_en: "Offline POS", name_ar: "كاشير", is_active: true }).returning();
  registerId = register.id;
  const [shift] = await db.insert(schema.cashierShifts).values({ branch_id: branchId, register_id: registerId, cashier_user_id: "offline-cashier", opened_by: "offline-manager", status: "open", opening_float: 0 }).returning();
  shiftId = shift.id;
  await db.insert(schema.registerPrintPreferences).values({ register_id: registerId, paper_width: 80, language: "bilingual", receipt_copies: 1, kot_copies: 1, updated_by: "offline-manager" });
  await db.insert(schema.paymentMethods).values({ code: "CASH", name: "Cash", affects_drawer: true, is_active: true });
  const [area] = await db.insert(schema.diningAreas).values({ branch_id: branchId, code: "MAIN", name_en: "Main", name_ar: "رئيسية", is_active: true, sort_order: 1 }).returning();
  const [table] = await db.insert(schema.restaurantTables).values({ dining_area_id: area.id, code: "T1", name_en: "Table 1", name_ar: "طاولة ١", capacity: 4, status: "available", is_active: true }).returning();
  tableId = table.id;
  const stations = await db.insert(schema.kitchenStations).values([
    { branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", is_active: true },
    { branch_id: branchId, code: "DONER", name_en: "Doner", name_ar: "دونر", is_active: true },
    { branch_id: branchId, code: "CAFE", name_en: "Cafe", name_ar: "كافيه", is_active: true },
  ]).returning();
  items = [];
  for (const [index, station] of stations.entries()) {
    const code = station.code;
    const [category] = await db.insert(schema.menuCategories).values({ branch_id: branchId, code, name_en: code, name_ar: code, is_active: true, sort_order: index }).returning();
    const [product] = await db.insert(schema.products).values({ name: code, price: 10_000 + index * 1_000, in_stock: 100, user_uid: "offline-manager", category: code }).returning();
    const [item] = await db.insert(schema.menuItems).values({ category_id: category.id, kitchen_station_id: station.id, product_id: product.id, code: `${code}-ITEM`, name_en: `${code} item`, name_ar: code, base_price: product.price, is_available: true, sort_order: 1 }).returning();
    items.push({ id: item.id, stationId: station.id, price: item.base_price });
  }
  const [inventoryLocation] = await db.insert(schema.inventoryLocations).values({ branch_id: branchId, code: "PRODUCTION", name_en: "Production", name_ar: "الإنتاج", is_active: true }).returning();
  const [ingredientCategory] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "RAW", name_en: "Raw", name_ar: "خام", is_active: true }).returning();
  const [pieceUnit] = await db.insert(schema.unitsOfMeasure).values({ code: "PC", name_en: "Piece", name_ar: "قطعة", dimension: "count", base_numerator: 1, base_denominator: 1 }).returning();
  const [ingredient] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: ingredientCategory.id, sku: "OFFLINE-COMPONENT", name_en: "Offline component", name_ar: "مكون دون اتصال", base_unit_id: pieceUnit.id, dimension: "count", default_location_id: inventoryLocation.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 5_000, par_level: 100_000, allow_negative: true, average_unit_cost_micros: 100_000_000, created_by: "offline-manager", updated_by: "offline-manager" }).returning();
  inventoryIngredientId = ingredient.id;
  await db.insert(schema.stockBalances).values({ branch_id: branchId, location_id: inventoryLocation.id, ingredient_id: ingredient.id, quantity_base: 1_000_000, average_unit_cost_micros: 100_000_000 });
  for (const item of items) {
    const [recipe] = await db.insert(schema.recipeVersions).values({ branch_id: branchId, menu_item_id: item.id, variant_id: null, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "offline-manager", approved_by: "offline-manager", approved_at: new Date() }).returning();
    await db.insert(schema.recipeComponents).values({ recipe_version_id: recipe.id, ingredient_id: ingredient.id, source_location_id: inventoryLocation.id, modifier_option_id: null, unit_id: pieceUnit.id, quantity_input_scaled: 1_000, quantity_base: 1_000 });
  }
  const snapshot = await cashier.bootstrap({ branchId });
  revision = snapshot.revision;
  priceSnapshotReference = snapshot.priceSnapshot.reference;
  priceSnapshotRevision = snapshot.priceSnapshot.revision;
});

afterAll(async () => { await pg.close(); });

describe("offline POS bootstrap and authoritative synchronization", () => {
  it("returns a scoped, versioned snapshot with an active shift, register, menu, stations, tables, permissions, and printing preferences", async () => {
    const snapshot = await cashier.bootstrap({ branchId });
    expect(snapshot.version).toBe(2);
    expect(snapshot.userId).toBe("offline-cashier");
    expect(snapshot.branch.menuCategories).toHaveLength(3);
    expect(snapshot.branch.kitchenStations.map((station) => station.code)).toEqual(["PIZZA", "DONER", "CAFE"]);
    expect(snapshot.shift.id).toBe(shiftId);
    expect(snapshot.register.id).toBe(registerId);
    expect(snapshot.permissions).toContain("order:create");
    expect(snapshot.printing).toEqual({ paperWidth: 80, language: "bilingual", receiptCopies: 1, kotCopies: 1 });
    expect(snapshot.priceSnapshot.reference).toStartWith(`OPS-${branchId}-`);
    expect(new Date(snapshot.expiresAt).getTime()).toBeGreaterThan(new Date(snapshot.staleAt).getTime());
  });

  it("atomically reprices and creates exactly one order, checkout, payment, status history, transaction, receipt, and KOT per station", async () => {
    const input = operation();
    const result = await cashier.sync(input);
    expect(result.status).toBe("accepted");
    expect(result.receiptJobId).toBeNumber();
    const orderId = result.orderId!;
    expect(await db.select().from(schema.orders).where(eq(schema.orders.id, orderId))).toHaveLength(1);
    expect(await db.select().from(schema.orderCheckouts).where(eq(schema.orderCheckouts.order_id, orderId))).toHaveLength(1);
    expect(await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.order_id, orderId))).toHaveLength(1);
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.order_id, orderId))).toHaveLength(1);
    expect(await db.select().from(schema.orderStatusHistory).where(eq(schema.orderStatusHistory.order_id, orderId))).toHaveLength(1);
    const jobs = await db.select().from(schema.printJobs).where(eq(schema.printJobs.order_id, orderId));
    expect(jobs.filter((job) => job.document_type === "kot")).toHaveLength(3);
    expect(jobs.filter((job) => job.document_type === "receipt")).toHaveLength(1);
    expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.order_id, orderId))).not.toHaveLength(0);
  });

  it("returns the authoritative mapping on duplicate retries without duplicating financial or print records", async () => {
    const input = operation();
    const first = await cashier.sync(input);
    const duplicate = await cashier.sync(input);
    expect(duplicate.status).toBe("accepted");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.orderId).toBe(first.orderId);
    expect(duplicate.checkoutId).toBe(first.checkoutId);
    expect(await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.order_id, first.orderId!))).toHaveLength(1);
    expect((await db.select().from(schema.printJobs).where(eq(schema.printJobs.order_id, first.orderId!))).filter((job) => job.document_type === "kot")).toHaveLength(3);
  });

  it("honors an unexpired server-issued price snapshot and exactly matches the printed offline receipt", async () => {
    const input = operation();
    const originalPrice = items[0].price;
    await db.update(schema.menuItems).set({ base_price: originalPrice + 5_000 }).where(eq(schema.menuItems.id, items[0].id));
    const result = await cashier.sync(input);
    expect(result.status).toBe("accepted");
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, result.orderId!) });
    const checkout = await db.query.orderCheckouts.findFirst({ where: eq(schema.orderCheckouts.id, result.checkoutId!) });
    expect(order?.total_amount).toBe(input.offlineReceipt.total);
    expect(checkout?.payable_amount).toBe(input.offlineReceipt.total);
    expect(order?.offline_receipt_reference).toBe(input.offlineReceipt.number);
    await db.update(schema.menuItems).set({ base_price: originalPrice }).where(eq(schema.menuItems.id, items[0].id));
  });

  it("rejects expired or foreign price snapshot references and preserves printed values for review", async () => {
    const expired = operation();
    await db.update(schema.offlinePriceSnapshots).set({ expires_at: new Date("2020-01-01T00:00:00Z") }).where(eq(schema.offlinePriceSnapshots.reference, expired.priceSnapshotReference));
    const expiredResult = await cashier.sync(expired);
    expect(expiredResult.status).toBe("needs_review");
    expect(expiredResult.conflict?.code).toBe("price_snapshot_expired");
    const record = await db.query.offlineSyncRecords.findFirst({ where: eq(schema.offlineSyncRecords.client_operation_id, expired.clientOperationId) });
    expect(record?.offline_receipt_number).toBe(expired.offlineReceipt.number);
    expect(record?.printed_tendered_amount).toBe(expired.offlineReceipt.cashReceived);
    const refreshed = await cashier.bootstrap({ branchId });
    priceSnapshotReference = refreshed.priceSnapshot.reference;
    priceSnapshotRevision = refreshed.priceSnapshot.revision;
    revision = refreshed.revision;
    const foreign = operation({ priceSnapshotReference: "OPS-999-missing-reference" });
    const foreignResult = await cashier.sync(foreign);
    expect(foreignResult.conflict?.code).toBe("price_snapshot_invalid");
  });

  it("audits one deterministic offline receipt preview without claiming physical printing", async () => {
    const input = operation();
    const result = await cashier.sync(input);
    const jobs = await db.select().from(schema.printJobs).where(and(eq(schema.printJobs.order_id, result.orderId!), eq(schema.printJobs.document_type, "receipt")));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotency_key).toBe(input.offlineReceipt.printIdempotencyKey);
    expect(jobs[0].status).toBe("previewed");
    expect(jobs[0].acknowledged_at).toBeNull();
    const audits = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.order_id, result.orderId!), eq(schema.auditLogs.action, "offline.receipt.previewed")));
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toContain('"physicalPrintConfirmed":false');
  });

  it("rejects tampered receipt totals into Needs Review before creating an order", async () => {
    const input = operation();
    input.order.expectedTotal -= 500;
    const result = await cashier.sync(input);
    expect(result.status).toBe("needs_review");
    expect(result.conflict?.code).toBe("receipt_payload_tampered");
    expect(result.conflict?.category).toBe("financial");
    expect(await db.select().from(schema.orders).where(eq(schema.orders.client_request_id, input.order.clientRequestId))).toHaveLength(0);
    expect(await db.select().from(schema.offlineSyncRecords).where(eq(schema.offlineSyncRecords.client_operation_id, input.clientOperationId))).toHaveLength(1);
  });

  it("moves tampered cash tendering to financial Needs Review and never writes a partial payment", async () => {
    const paymentsBefore = (await db.select().from(schema.orderPayments)).length;
    const input = operation();
    input.cash!.tenderedAmount = input.order.expectedTotal - 1;
    const result = await cashier.sync(input);
    expect(result.status).toBe("needs_review");
    expect(result.conflict?.code).toBe("receipt_payload_tampered");
    expect(await db.select().from(schema.orderPayments)).toHaveLength(paymentsBefore);
    expect(await db.select().from(schema.orders).where(eq(schema.orders.client_request_id, input.order.clientRequestId))).toHaveLength(0);
  });

  it("detects a table conflict", async () => {
    await db.update(schema.restaurantTables).set({ status: "occupied" }).where(eq(schema.restaurantTables.id, tableId));
    const input = operation();
    input.order.orderType = "dine_in";
    input.order.diningTableId = tableId;
    const result = await cashier.sync(input);
    expect(result.status).toBe("needs_review");
    expect(result.conflict?.code).toBe("table_occupied");
    await db.update(schema.restaurantTables).set({ status: "available" }).where(eq(schema.restaurantTables.id, tableId));
  });

  it("detects closed shifts and permission changes", async () => {
    await db.update(schema.cashierShifts).set({ status: "closed", closed_at: new Date() }).where(eq(schema.cashierShifts.id, shiftId));
    expect((await cashier.sync(operation())).conflict?.code).toBe("shift_closed");
    await db.update(schema.cashierShifts).set({ status: "open", closed_at: null }).where(eq(schema.cashierShifts.id, shiftId));
    await db.update(schema.staffAssignments).set({ is_active: false }).where(and(eq(schema.staffAssignments.user_id, "offline-cashier"), eq(schema.staffAssignments.branch_id, branchId)));
    expect((await cashier.sync(operation())).conflict?.code).toBe("user_branch_mismatch");
    await db.update(schema.staffAssignments).set({ is_active: true }).where(and(eq(schema.staffAssignments.user_id, "offline-cashier"), eq(schema.staffAssignments.branch_id, branchId)));
  });

  it("requires manager review with a durable audit reason, then revalidates the same operation", async () => {
    const input = operation();
    await db.update(schema.cashierShifts).set({ status: "closed", closed_at: new Date() }).where(eq(schema.cashierShifts.id, shiftId));
    const conflict = await cashier.sync(input);
    await expect(cashier.resolveReview({ recordId: conflict.conflict!.recordId!, reason: "Cashier self approval" })).rejects.toThrow("Manager");
    await manager.resolveReview({ recordId: conflict.conflict!.recordId!, reason: "Verified the original printed cash receipt and reopened the shift" });
    await db.update(schema.cashierShifts).set({ status: "open", closed_at: null }).where(eq(schema.cashierShifts.id, shiftId));
    const accepted = await cashier.sync(input);
    expect(accepted.status).toBe("accepted");
    const record = await db.query.offlineSyncRecords.findFirst({ where: eq(schema.offlineSyncRecords.client_operation_id, input.clientOperationId) });
    expect(record?.resolution_reason).toBe("Verified the original printed cash receipt and reopened the shift");
    expect(record?.printed_total_amount).toBe(input.offlineReceipt.total);
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "offline.sync.review_resolved"))).length).toBeGreaterThan(0);
  });

  it("preserves insufficient-stock cash sales in Needs Review and consumes once after manager override", async () => {
    await db.update(schema.stockBalances).set({ quantity_base: 0 }).where(eq(schema.stockBalances.ingredient_id, inventoryIngredientId));
    const input = operation();
    const conflict = await cashier.sync(input);
    expect(conflict.status).toBe("needs_review");
    expect(conflict.conflict?.code).toBe("insufficient_stock");
    expect(await db.select().from(schema.orders).where(eq(schema.orders.client_request_id, input.order.clientRequestId))).toHaveLength(0);
    await manager.resolveReview({ recordId: conflict.conflict!.recordId!, reason: "Manager honors cash already received with negative stock" });
    const accepted = await cashier.sync(input);
    expect(accepted.status).toBe("accepted");
    const duplicate = await cashier.sync(input);
    expect(duplicate.duplicate).toBe(true);
    expect(await db.select().from(schema.orderInventoryIssues).where(eq(schema.orderInventoryIssues.order_id, accepted.orderId!))).toHaveLength(1);
    expect(await db.select().from(schema.orderPayments).where(eq(schema.orderPayments.order_id, accepted.orderId!))).toHaveLength(1);
    const overrideAudit = await db.query.auditLogs.findFirst({ where: and(eq(schema.auditLogs.order_id, accepted.orderId!), eq(schema.auditLogs.action, "inventory.negative_override")) });
    expect(overrideAudit?.approver_user_id).toBe("offline-manager");
    await db.update(schema.stockBalances).set({ quantity_base: 1_000_000 }).where(eq(schema.stockBalances.ingredient_id, inventoryIngredientId));
  });

  it("enforces branch and user isolation in bootstrap and synchronization", async () => {
    await expect(outsider.bootstrap({ branchId })).rejects.toThrow("No offline POS permission");
    const input = operation({ branchId: otherBranchId });
    const result = await outsider.sync(input);
    expect(result.status).toBe("needs_review");
    expect(result.conflict?.code).toBe("price_snapshot_invalid");
  });
});
