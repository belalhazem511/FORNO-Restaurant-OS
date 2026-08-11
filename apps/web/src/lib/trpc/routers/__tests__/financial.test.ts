import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { shiftsRouter } = await import("../shifts");
const { checkoutRouter } = await import("../checkout");
const { createCallerFactory } = await import("../../init");
const {
  auditLogs,
  branches,
  cashierRegisters,
  cashierShifts,
  orderCancellations,
  orderCheckouts,
  orderItems,
  orderPayments,
  orders,
  paymentMethods,
  shiftCashMovements,
  staffAssignments,
  transactions,
  user,
} = await import("@/lib/db/schema");

const shiftsAs = (id: string) => createCallerFactory(shiftsRouter)({ user: makeUser(id) });
const checkoutAs = (id: string) => createCallerFactory(checkoutRouter)({ user: makeUser(id) });
const adminShifts = shiftsAs("admin-1");
const adminCheckout = checkoutAs("admin-1");
const cashierShiftsCaller = shiftsAs("cashier-1");
const cashierCheckout = checkoutAs("cashier-1");

let branchId: number;
let registerId: number;
let cashierRegisterId: number;
let cashId: number;
let cardId: number;
let instapayId: number;
let adminShiftId: number;
let sequence = 0;

async function createOrder(amount = 10_000, status: "pending" | "cancelled" = "pending") {
  const [order] = await db.insert(orders).values({
    branch_id: branchId,
    client_request_id: `financial-order-${++sequence}`,
    order_type: "takeaway",
    subtotal_amount: amount,
    discount_value: 0,
    discount_amount: 0,
    total_amount: amount,
    payment_status: "unpaid",
    user_uid: "admin-1",
    status,
    updated_at: new Date(),
  }).returning();
  await db.insert(orderItems).values({ order_id: order.id, quantity: 1, price: amount });
  return order;
}

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values([
    { id: "admin-1", name: "Admin", email: "admin@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "manager-1", name: "Manager", email: "manager@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "cashier-1", name: "Cashier", email: "cashier@test.local", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const [branch] = await db.insert(branches).values({
    code: "FIN", name_en: "Financial Test", name_ar: "اختبار مالي", currency: "EGP",
    timezone: "Africa/Cairo", is_active: true,
  }).returning();
  branchId = branch.id;
  await db.insert(staffAssignments).values([
    { user_id: "admin-1", branch_id: branchId, role: "admin", is_active: true, updated_at: new Date() },
    { user_id: "manager-1", branch_id: branchId, role: "manager", is_active: true, updated_at: new Date() },
    { user_id: "cashier-1", branch_id: branchId, role: "cashier", is_active: true, updated_at: new Date() },
  ]);
  const registers = await db.insert(cashierRegisters).values([
    { branch_id: branchId, code: "ADMIN", name_en: "Admin Register", name_ar: "كاشير المدير", is_active: true },
    { branch_id: branchId, code: "CASHIER", name_en: "Cashier Register", name_ar: "كاشير الموظف", is_active: true },
  ]).returning();
  registerId = registers[0].id;
  cashierRegisterId = registers[1].id;
  const methods = await db.insert(paymentMethods).values([
    { code: "CASH", name: "Cash", affects_drawer: true, is_active: true },
    { code: "CARD", name: "Card", affects_drawer: false, is_active: true },
    { code: "INSTAPAY", name: "InstaPay", affects_drawer: false, is_active: true },
  ]).returning();
  cashId = methods[0].id;
  cardId = methods[1].id;
  instapayId = methods[2].id;
});

afterAll(async () => { await pg.close(); });

describe("cashier shifts", () => {
  it("opens a shift, audits it, and prevents multiple active shifts", async () => {
    const shift = await adminShifts.open({ branchId, registerId, openingFloat: 5_000 });
    adminShiftId = shift.id;
    expect(shift.status).toBe("open");
    expect(shift.summary.expectedCash).toBe(5_000);
    await expect(adminShifts.open({ branchId, registerId, openingFloat: 0 })).rejects.toThrow("already has an open shift");
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "shift.open"))).toHaveLength(1);
  });

  it("records manager-authorized cash-in/out and calculates expected cash", async () => {
    await adminShifts.moveCash({ shiftId: adminShiftId, type: "cash_in", amount: 2_000, reason: "Petty cash return" });
    const shift = await adminShifts.moveCash({ shiftId: adminShiftId, type: "cash_out", amount: 500, reason: "Courier expense" });
    expect(shift.summary.cashIn).toBe(2_000);
    expect(shift.summary.cashOut).toBe(500);
    expect(shift.summary.expectedCash).toBe(6_500);
    expect(await db.select().from(shiftCashMovements).where(eq(shiftCashMovements.shift_id, adminShiftId))).toHaveLength(2);
  });

  it("rejects restricted cashier cash adjustments", async () => {
    const cashierShift = await cashierShiftsCaller.open({ branchId, registerId: cashierRegisterId, openingFloat: 0 });
    await expect(cashierShiftsCaller.moveCash({ shiftId: cashierShift.id, type: "cash_in", amount: 100, reason: "Unauthorized adjustment" })).rejects.toThrow("cannot perform cash:adjust");
  });
});

describe("secure checkout", () => {
  it("requires the cashier's own active shift", async () => {
    const order = await createOrder();
    await expect(checkoutAs("manager-1").pay({
      orderId: order.id, idempotencyKey: `no-shift-${sequence}`, payments: [{ paymentMethodId: cashId, amount: 10_000, tenderedAmount: 10_000 }],
    })).rejects.toThrow("active cashier shift");
  });

  it("accepts cash, records change, keeps lifecycle separate, and is idempotent", async () => {
    const order = await createOrder();
    const input = {
      orderId: order.id,
      idempotencyKey: `cash-checkout-${sequence}`,
      payments: [{ paymentMethodId: cashId, amount: 10_000, tenderedAmount: 12_000 }],
    };
    const first = await adminCheckout.pay(input);
    const duplicate = await adminCheckout.pay(input);
    expect(first.changeAmount).toBe(2_000);
    expect(duplicate.checkoutId).toBe(first.checkoutId);
    const [storedOrder] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(storedOrder.payment_status).toBe("paid");
    expect(storedOrder.status).toBe("pending");
    expect(await db.select().from(orderPayments).where(eq(orderPayments.order_id, order.id))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.order_id, order.id))).toHaveLength(1);
    await expect(adminCheckout.pay({ ...input, idempotencyKey: `already-paid-${sequence}` })).rejects.toThrow("already fully paid");
  });

  it("accepts an exact Cash/Card split and excludes card from drawer cash", async () => {
    const order = await createOrder();
    const result = await adminCheckout.pay({
      orderId: order.id,
      idempotencyKey: `financial-split-${sequence}`,
      payments: [
        { paymentMethodId: cashId, amount: 4_000, tenderedAmount: 4_000 },
        { paymentMethodId: cardId, amount: 6_000 },
      ],
    });
    expect(result.payableAmount).toBe(10_000);
    const context = await adminShifts.context({ branchId });
    expect(context.currentShift?.summary.cashSales).toBe(14_000);
    expect(context.currentShift?.summary.byPaymentMethod.find((method) => method.code === "CARD")?.net).toBe(6_000);
  });

  it("rejects underpayment, over-allocation, and cancelled orders with atomic rollback", async () => {
    const under = await createOrder();
    await expect(adminCheckout.pay({ orderId: under.id, idempotencyKey: `financial-under-${sequence}`, payments: [{ paymentMethodId: cashId, amount: 9_999 }] })).rejects.toThrow("do not cover");
    const over = await createOrder();
    await expect(adminCheckout.pay({ orderId: over.id, idempotencyKey: `financial-over-${sequence}`, payments: [{ paymentMethodId: cashId, amount: 10_001 }] })).rejects.toThrow("exceed");
    const cancelled = await createOrder(10_000, "cancelled");
    await expect(adminCheckout.pay({ orderId: cancelled.id, idempotencyKey: `cancelled-${sequence}`, payments: [{ paymentMethodId: cardId, amount: 10_000 }] })).rejects.toThrow("Cancelled orders");
    expect(await db.select().from(orderCheckouts).where(inArray(orderCheckouts.order_id, [under.id, over.id, cancelled.id]))).toHaveLength(0);
  });

  it("calculates fixed and basis-point percentage discounts on the server", async () => {
    const fixedOrder = await createOrder();
    const fixed = await adminCheckout.pay({
      orderId: fixedOrder.id,
      idempotencyKey: `financial-fixed-${sequence}`,
      discount: { type: "fixed", value: 1_000, reason: "Manager service recovery" },
      payments: [{ paymentMethodId: cardId, amount: 9_000 }],
    });
    expect(fixed.discountAmount).toBe(1_000);
    const percentOrder = await createOrder();
    const percentage = await adminCheckout.pay({
      orderId: percentOrder.id,
      idempotencyKey: `percent-${sequence}`,
      discount: { type: "percentage", value: 1_000, reason: "Ten percent promotion" },
      payments: [{ paymentMethodId: instapayId, amount: 9_000 }],
    });
    expect(percentage.discountAmount).toBe(1_000);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "order.discount")))).toHaveLength(2);
  });

  it("enforces discount permissions for cashiers on the server", async () => {
    const order = await createOrder();
    await expect(cashierCheckout.pay({
      orderId: order.id,
      idempotencyKey: `cashier-discount-${sequence}`,
      discount: { type: "fixed", value: 500, reason: "Self authorized discount" },
      payments: [{ paymentMethodId: cashId, amount: 9_500, tenderedAmount: 9_500 }],
    })).rejects.toThrow("cannot perform discount:apply");
  });
});

describe("cancellation and reversal", () => {
  it("cancels an unpaid order without fake payment rows and audits the action", async () => {
    const order = await createOrder();
    const result = await adminCheckout.cancel({ orderId: order.id, idempotencyKey: `cancel-unpaid-${sequence}`, reason: "Customer changed their mind" });
    expect(result.paymentStatus).toBe("unpaid");
    expect(result.refundedAmount).toBe(0);
    expect(await db.select().from(orderPayments).where(eq(orderPayments.order_id, order.id))).toHaveLength(0);
    expect(await db.select().from(orderCancellations).where(eq(orderCancellations.order_id, order.id))).toHaveLength(1);
  });

  it("reverses every paid allocation without deleting original financial history", async () => {
    const order = await createOrder();
    await adminCheckout.pay({
      orderId: order.id, idempotencyKey: `reverse-pay-${sequence}`,
      payments: [{ paymentMethodId: cashId, amount: 4_000 }, { paymentMethodId: cardId, amount: 6_000 }],
    });
    const beforeTransactions = await db.select().from(transactions).where(eq(transactions.order_id, order.id));
    const reversed = await adminCheckout.cancel({ orderId: order.id, idempotencyKey: `reverse-${sequence}`, reason: "Manager-approved full reversal" });
    expect(reversed.paymentStatus).toBe("refunded");
    expect(reversed.refundedAmount).toBe(10_000);
    const payments = await db.select().from(orderPayments).where(eq(orderPayments.order_id, order.id));
    expect(payments.filter((payment) => payment.kind === "payment")).toHaveLength(2);
    expect(payments.filter((payment) => payment.kind === "refund")).toHaveLength(2);
    expect(await db.select().from(transactions).where(eq(transactions.order_id, order.id))).toHaveLength(beforeTransactions.length + 2);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.order_id, order.id), eq(auditLogs.action, "order.payment_reversal")))).toHaveLength(1);
  });

  it("prevents a cashier from cancelling or refunding", async () => {
    const order = await createOrder();
    await expect(cashierCheckout.cancel({ orderId: order.id, idempotencyKey: `cashier-cancel-${sequence}`, reason: "Not allowed" })).rejects.toThrow("cannot perform order:cancel");
  });
});

describe("shift close reconciliation", () => {
  it("freezes expected cash, counted cash, and over/short variance", async () => {
    const open = await adminShifts.context({ branchId });
    const expected = open.currentShift!.summary.expectedCash;
    const closed = await adminShifts.close({ shiftId: adminShiftId, closingCash: expected + 100 });
    expect(closed.status).toBe("closed");
    expect(closed.expected_cash).toBe(expected);
    expect(closed.closing_cash).toBe(expected + 100);
    expect(closed.variance).toBe(100);
    await expect(adminShifts.moveCash({ shiftId: adminShiftId, type: "cash_in", amount: 100, reason: "Too late" })).rejects.toThrow("Open shift not found");
    expect((await db.select().from(cashierShifts).where(eq(cashierShifts.id, adminShiftId)))[0].status).toBe("closed");
  });
});
