import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";
import {
  assertKotContainsNoFinancialData,
  calculatePrintableLineTotal,
  classifyReceiptState,
  itemsForStation,
  paymentBreakdown,
  type PrintableItem,
} from "@/lib/printing/documents";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { printingRouter } = await import("../printing");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");
const printingAs = (id: string) => createCallerFactory(printingRouter)({ user: makeUser(id) });
const admin = printingAs("print-admin");
const cashier = printingAs("print-cashier");
const outsider = printingAs("print-outsider");

let branchId: number;
let otherBranchId: number;
let registerId: number;
let paidOrderId: number;
let unpaidOrderId: number;
let reversedOrderId: number;
let percentageOrderId: number;
let pizzaStationId: number;
let donerStationId: number;
let cafeStationId: number;

async function createMenuItem(branch: number, stationId: number, code: string, amount: number) {
  const [category] = await db.insert(schema.menuCategories).values({ branch_id: branch, code, name_en: code, name_ar: code, sort_order: stationId, is_active: true }).returning();
  const [product] = await db.insert(schema.products).values({ name: `Product ${code}`, price: amount, in_stock: 10, user_uid: "print-admin", category: code }).returning();
  const [item] = await db.insert(schema.menuItems).values({ category_id: category.id, kitchen_station_id: stationId, product_id: product.id, code, name_en: `${code} item`, name_ar: `صنف ${code}`, base_price: amount, is_available: true, sort_order: 1 }).returning();
  return { item, product };
}

async function createOrderWithItems(paymentStatus: "unpaid" | "paid" | "refunded", clientId: string) {
  const [order] = await db.insert(schema.orders).values({ branch_id: branchId, client_request_id: clientId, order_type: "takeaway", subtotal_amount: 30_000, discount_type: paymentStatus === "unpaid" ? null : "fixed", discount_value: paymentStatus === "unpaid" ? 0 : 2_000, discount_amount: paymentStatus === "unpaid" ? 0 : 2_000, discount_reason: paymentStatus === "unpaid" ? null : "Manager recovery", total_amount: paymentStatus === "unpaid" ? 30_000 : 28_000, payment_status: paymentStatus, paid_at: paymentStatus === "unpaid" ? null : new Date(), user_uid: "print-admin", status: paymentStatus === "refunded" ? "cancelled" : "pending", updated_at: new Date() }).returning();
  const menu = await db.select().from(schema.menuItems);
  const items = await db.insert(schema.orderItems).values(menu.slice(0, 3).map((item, index) => ({ order_id: order.id, product_id: item.product_id, menu_item_id: item.id, quantity: 1, price: 10_000, notes: index === 0 ? "No onions / بدون بصل" : null }))).returning();
  const [group] = await db.select().from(schema.modifierGroups).limit(1);
  const [option] = await db.select().from(schema.modifierOptions).where(eq(schema.modifierOptions.modifier_group_id, group.id)).limit(1);
  await db.insert(schema.orderItemModifiers).values({ order_item_id: items[0].id, modifier_option_id: option.id, name_en: "Extra cheese", name_ar: "جبنة إضافية", price_delta: 0 });
  return order;
}

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([
    { id: "print-admin", name: "Print Admin", email: "print-admin@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "print-cashier", name: "Print Cashier", email: "print-cashier@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "print-outsider", name: "Other Branch", email: "print-other@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const branches = await db.insert(schema.branches).values([
    { code: "PRINT", name_en: "FORNO Print Branch", name_ar: "فرع فورنو للطباعة", address_en: "Cairo", address_ar: "القاهرة", phone: "0100", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "OTHER-PRINT", name_en: "Other", name_ar: "آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning();
  branchId = branches[0].id;
  otherBranchId = branches[1].id;
  await db.insert(schema.staffAssignments).values([
    { user_id: "print-admin", branch_id: branchId, role: "admin", is_active: true, updated_at: new Date() },
    { user_id: "print-cashier", branch_id: branchId, role: "cashier", is_active: true, updated_at: new Date() },
    { user_id: "print-outsider", branch_id: otherBranchId, role: "manager", is_active: true, updated_at: new Date() },
  ]);
  const [register] = await db.insert(schema.cashierRegisters).values({ branch_id: branchId, code: "PRINT-FRONT", name_en: "Front", name_ar: "الأمامي", is_active: true }).returning();
  registerId = register.id;
  await db.insert(schema.registerPrintPreferences).values({ register_id: registerId, paper_width: 80, language: "bilingual", receipt_copies: 1, kot_copies: 2, updated_by: "print-admin" });
  const [shift] = await db.insert(schema.cashierShifts).values({ branch_id: branchId, register_id: registerId, cashier_user_id: "print-admin", opened_by: "print-admin", status: "open", opening_float: 0 }).returning();
  const stations = await db.insert(schema.kitchenStations).values([
    { branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", is_active: true },
    { branch_id: branchId, code: "DONER", name_en: "Doner", name_ar: "دونر", is_active: true },
    { branch_id: branchId, code: "CAFE", name_en: "Cafe", name_ar: "كافيه", is_active: true },
  ]).returning();
  [pizzaStationId, donerStationId, cafeStationId] = stations.map((station) => station.id);
  await createMenuItem(branchId, pizzaStationId, "PIZZA-PRINT", 10_000);
  await createMenuItem(branchId, donerStationId, "DONER-PRINT", 10_000);
  await createMenuItem(branchId, cafeStationId, "CAFE-PRINT", 10_000);
  const [group] = await db.insert(schema.modifierGroups).values({ branch_id: branchId, code: "EXTRA-PRINT", name_en: "Extras", name_ar: "إضافات", min_selections: 0, max_selections: 2, sort_order: 1, is_active: true }).returning();
  await db.insert(schema.modifierOptions).values({ modifier_group_id: group.id, code: "CHEESE-PRINT", name_en: "Extra cheese", name_ar: "جبنة إضافية", price_delta: 0, is_default: false, is_available: true, sort_order: 1 });
  const paid = await createOrderWithItems("paid", "print-paid");
  paidOrderId = paid.id;
  const [checkout] = await db.insert(schema.orderCheckouts).values({ order_id: paid.id, shift_id: shift.id, idempotency_key: "print-checkout-paid", subtotal_amount: 30_000, discount_amount: 2_000, payable_amount: 28_000, created_by: "print-admin", approved_by: "print-admin" }).returning();
  const methods = await db.insert(schema.paymentMethods).values([
    { code: "PRINT-CASH", name: "Print Cash", affects_drawer: true, is_active: true },
    { code: "PRINT-CARD", name: "Print Card", affects_drawer: false, is_active: true },
  ]).returning();
  await db.insert(schema.orderPayments).values([
    { checkout_id: checkout.id, order_id: paid.id, shift_id: shift.id, payment_method_id: methods[0].id, kind: "payment", amount: 18_000, tendered_amount: 20_000, change_amount: 2_000, created_by: "print-admin" },
    { checkout_id: checkout.id, order_id: paid.id, shift_id: shift.id, payment_method_id: methods[1].id, kind: "payment", amount: 10_000, tendered_amount: null, change_amount: 0, created_by: "print-admin" },
  ]);
  unpaidOrderId = (await createOrderWithItems("unpaid", "print-unpaid")).id;
  const reversed = await createOrderWithItems("refunded", "print-reversed");
  reversedOrderId = reversed.id;
  const [reversedCheckout] = await db.insert(schema.orderCheckouts).values({ order_id: reversed.id, shift_id: shift.id, idempotency_key: "print-checkout-reversed", subtotal_amount: 30_000, discount_amount: 2_000, payable_amount: 28_000, created_by: "print-admin", approved_by: "print-admin" }).returning();
  const [originalPayment] = await db.insert(schema.orderPayments).values({ checkout_id: reversedCheckout.id, order_id: reversed.id, shift_id: shift.id, payment_method_id: methods[0].id, kind: "payment", amount: 28_000, tendered_amount: 30_000, change_amount: 2_000, created_by: "print-admin" }).returning();
  await db.insert(schema.orderPayments).values({ order_id: reversed.id, shift_id: shift.id, payment_method_id: methods[0].id, kind: "refund", amount: 28_000, tendered_amount: null, change_amount: 0, original_payment_id: originalPayment.id, created_by: "print-admin" });
  await db.insert(schema.orderCancellations).values({ order_id: reversed.id, shift_id: shift.id, idempotency_key: "print-reverse-cancel", reason: "Customer requested reversal", was_paid: true, cancelled_by: "print-admin", approved_by: "print-admin" });
  const percentage = await createOrderWithItems("paid", "print-percentage");
  percentageOrderId = percentage.id;
  await db.update(schema.orders).set({ discount_type: "percentage", discount_value: 1_000, discount_amount: 3_000, total_amount: 27_000, discount_reason: "Ten percent offer" }).where(eq(schema.orders.id, percentage.id));
  const [percentageCheckout] = await db.insert(schema.orderCheckouts).values({ order_id: percentage.id, shift_id: shift.id, idempotency_key: "print-checkout-percentage", subtotal_amount: 30_000, discount_amount: 3_000, payable_amount: 27_000, created_by: "print-admin", approved_by: "print-admin" }).returning();
  await db.insert(schema.orderPayments).values({ checkout_id: percentageCheckout.id, order_id: percentage.id, shift_id: shift.id, payment_method_id: methods[1].id, kind: "payment", amount: 27_000, tendered_amount: null, change_amount: 0, created_by: "print-admin" });
});

afterAll(async () => { await pg.close(); });

describe("trusted print document calculations", () => {
  it("calculates line totals and payment-method breakdown in integer minor units", () => {
    const item = { quantity: 2, unitPrice: 12_000, modifiers: [{ en: "Extra", ar: "إضافة", priceDelta: 1_500 }] };
    expect(calculatePrintableLineTotal(item)).toBe(27_000);
    expect(paymentBreakdown([{ method: "Cash", kind: "payment", amount: 20_000, tenderedAmount: 25_000, changeAmount: 5_000 }, { method: "Cash", kind: "refund", amount: 7_000, tenderedAmount: null, changeAmount: 0 }])).toEqual({ Cash: { paid: 20_000, refunded: 7_000 } });
  });

  it("classifies paid, unpaid, refunded, and reversed states", () => {
    expect(classifyReceiptState({ paymentStatus: "paid", wasPaidCancellation: false })).toBe("paid");
    expect(classifyReceiptState({ paymentStatus: "unpaid", wasPaidCancellation: false })).toBe("unpaid");
    expect(classifyReceiptState({ paymentStatus: "refunded", wasPaidCancellation: false })).toBe("refunded");
    expect(classifyReceiptState({ paymentStatus: "refunded", wasPaidCancellation: true })).toBe("reversed");
  });

  it("routes station items without crossing stations", () => {
    const items = [{ station: { code: "PIZZA" } }, { station: { code: "DONER" } }, { station: { code: "CAFE" } }] as PrintableItem[];
    expect(itemsForStation(items, "PIZZA")).toHaveLength(1);
    expect(itemsForStation(items, "PIZZA")[0].station.code).toBe("PIZZA");
  });
});

describe("print settings and trusted receipts", () => {
  it("returns 80mm bilingual register defaults and updates to 58mm Arabic", async () => {
    const before = await admin.registerSettings({ branchId });
    expect(before.preferences).toEqual({ paperWidth: 80, language: "bilingual", receiptCopies: 1, kotCopies: 2 });
    await admin.updatePreferences({ registerId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 1 });
    const after = await admin.registerSettings({ branchId });
    expect(after.preferences.paperWidth).toBe(58);
    expect(after.preferences.language).toBe("ar");
    await admin.updatePreferences({ registerId, paperWidth: 80, language: "bilingual", receiptCopies: 1, kotCopies: 2 });
  });

  it("builds a paid receipt from server totals, split payments, cash tendered, change, and discount", async () => {
    const requested = await admin.request({ orderId: paidOrderId, documentType: "receipt", idempotencyKey: "receipt-initial-paid" });
    const document = await admin.document({ jobId: requested.jobId });
    expect(document.job.paperWidth).toBe(80);
    expect(document.job.language).toBe("bilingual");
    expect(document.financial?.state).toBe("paid");
    expect(document.financial?.subtotal).toBe(30_000);
    expect(document.financial?.discount).toBe(2_000);
    expect(document.financial?.total).toBe(28_000);
    expect(document.financial?.cashReceived).toBe(20_000);
    expect(document.financial?.change).toBe(2_000);
    expect(document.financial?.payments.map((payment) => payment.amount)).toEqual([18_000, 10_000]);
  });

  it("allows an explicitly unpaid summary and rejects misleading receipt states", async () => {
    const summary = await admin.request({ orderId: unpaidOrderId, documentType: "order_summary", idempotencyKey: "summary-initial-unpaid", paperWidth: 58, language: "en" });
    const document = await admin.document({ jobId: summary.jobId });
    expect(document.financial?.state).toBe("unpaid");
    expect(document.job.paperWidth).toBe(58);
    expect(document.job.language).toBe("en");
    await expect(admin.request({ orderId: unpaidOrderId, documentType: "receipt", idempotencyKey: "bad-unpaid-receipt" })).rejects.toThrow("Only fully paid");
    await expect(admin.request({ orderId: reversedOrderId, documentType: "receipt", idempotencyKey: "bad-reversed-receipt" })).rejects.toThrow("Only fully paid");
  });

  it("renders a reversal state and immutable reversal reason", async () => {
    const reversal = await admin.request({ orderId: reversedOrderId, documentType: "reversal", idempotencyKey: "reversal-initial-doc" });
    const document = await admin.document({ jobId: reversal.jobId });
    expect(document.financial?.state).toBe("reversed");
    expect(document.financial?.reversalReason).toBe("Customer requested reversal");
    expect(document.financial?.payments.map((payment) => payment.kind)).toEqual(["payment", "refund"]);
  });

  it("renders a server-snapshotted basis-point percentage discount", async () => {
    const receipt = await admin.request({ orderId: percentageOrderId, documentType: "receipt", idempotencyKey: "receipt-percentage-paid" });
    const document = await admin.document({ jobId: receipt.jobId });
    expect(document.financial?.subtotal).toBe(30_000);
    expect(document.financial?.discount).toBe(3_000);
    expect(document.financial?.total).toBe(27_000);
    expect(document.financial?.discountReason).toBe("Ten percent offer");
  });
});

describe("station KOT jobs, audit, permissions, and idempotency", () => {
  it("creates deterministic station jobs and returns the same job for the same client key", async () => {
    const input = { orderId: paidOrderId, documentType: "kot" as const, stationId: pizzaStationId, idempotencyKey: "kot-pizza-initial-key" };
    const first = await admin.request(input);
    const duplicate = await admin.request(input);
    expect(duplicate.jobId).toBe(first.jobId);
    await expect(admin.request({ ...input, idempotencyKey: "kot-pizza-second-initial" })).rejects.toThrow("authorized reprint");
    expect(await db.select().from(schema.printJobs).where(eq(schema.printJobs.station_id, pizzaStationId))).toHaveLength(1);
  });

  it("creates one KOT per Pizza, Doner, and Cafe with notes/modifiers and no financial data", async () => {
    const pizzaJob = await db.query.printJobs.findFirst({ where: eq(schema.printJobs.station_id, pizzaStationId) });
    const doner = await admin.request({ orderId: paidOrderId, documentType: "kot", stationId: donerStationId, idempotencyKey: "kot-doner-initial-key" });
    const cafe = await admin.request({ orderId: paidOrderId, documentType: "kot", stationId: cafeStationId, idempotencyKey: "kot-cafe-initial-key" });
    for (const [jobId, stationCode] of [[pizzaJob!.id, "PIZZA"], [doner.jobId, "DONER"], [cafe.jobId, "CAFE"]] as const) {
      const document = await admin.document({ jobId });
      expect(document.items).toHaveLength(1);
      expect(document.items[0].station.code).toBe(stationCode);
      expect(document.financial).toBeNull();
      expect(JSON.stringify(document)).not.toContain("payment breakdown");
      expect(() => assertKotContainsNoFinancialData(document)).not.toThrow();
    }
    const pizzaDocument = await admin.document({ jobId: pizzaJob!.id });
    expect(pizzaDocument.items[0].notes).toContain("No onions");
    expect(pizzaDocument.items[0].modifiers[0].en).toBe("Extra cheese");
  });

  it("rejects cashier reprints and requires an authorized reason", async () => {
    await expect(cashier.request({ orderId: paidOrderId, documentType: "receipt", idempotencyKey: "cashier-reprint-denied", reprint: true, reprintReason: "Duplicate requested" })).rejects.toThrow("cannot perform print:reprint");
    await expect(admin.request({ orderId: paidOrderId, documentType: "receipt", idempotencyKey: "admin-reprint-no-reason", reprint: true, reprintReason: null })).rejects.toThrow();
    const reprint = await admin.request({ orderId: paidOrderId, documentType: "receipt", idempotencyKey: "admin-reprint-approved", reprint: true, reprintReason: "Customer requested duplicate" });
    const document = await admin.document({ jobId: reprint.jobId });
    expect(document.job.isReprint).toBe(true);
    const [job] = await db.select().from(schema.printJobs).where(eq(schema.printJobs.id, reprint.jobId));
    expect(job.approved_by).toBe("print-admin");
    expect(job.reprint_reason).toBe("Customer requested duplicate");
  });

  it("audits requests and explicit browser preview acknowledgement without claiming physical print", async () => {
    const reprint = await db.query.printJobs.findFirst({ where: eq(schema.printJobs.idempotency_key, "admin-reprint-approved") });
    expect((await admin.transition({ jobId: reprint!.id, status: "previewed" })).status).toBe("previewed");
    expect((await admin.transition({ jobId: reprint!.id, status: "acknowledged" })).status).toBe("acknowledged");
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity_id, String(reprint!.id)));
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(["print.reprint.request", "print.previewed", "print.acknowledged"]));
  });

  it("enforces branch isolation", async () => {
    await expect(outsider.options({ orderId: paidOrderId })).rejects.toThrow("No active staff assignment");
    await expect(outsider.document({ jobId: 1 })).rejects.toThrow("No active staff assignment");
  });
});
