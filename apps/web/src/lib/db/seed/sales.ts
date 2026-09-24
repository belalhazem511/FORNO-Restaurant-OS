import { and, eq } from "drizzle-orm";
import { db } from "..";
import {
  cashierRegisters, cashierShifts, customers, menuItems, orderCheckouts, orderItems, orderPayments, orders,
  orderStatusHistory, paymentMethods, registerPrintPreferences, restaurantTables, transactions,
} from "../schema";

export async function seedSales(branchId: number, userId: string, paymentByName: Map<string, number>) {
  const seededItems = await db.select().from(menuItems);
  const itemByCode = new Map(seededItems.map((item) => [item.code, item]));
  const customerSeeds = [
    { name: "Ahmed Hassan", email: "ahmed@forno.demo", phone: "01000000001", status: "active" },
    { name: "Mariam Adel", email: "mariam@forno.demo", phone: "01000000002", status: "active" },
    { name: "Omar Khaled", email: "omar@forno.demo", phone: "01000000003", status: "active" },
  ];
  for (const customer of customerSeeds) await db.insert(customers).values({ ...customer, user_uid: userId }).onConflictDoNothing();
  const demoCustomers = await db.select().from(customers).where(eq(customers.user_uid, userId));
  const customerByEmail = new Map(demoCustomers.map((customer) => [customer.email, customer.id]));
  const tables = await db.select().from(restaurantTables);
  const table1 = tables.find((table) => table.code === "T1")!;
  const register = await db.query.cashierRegisters.findFirst({ where: and(eq(cashierRegisters.branch_id, branchId), eq(cashierRegisters.code, "FRONT")) });
  if (!register) throw new Error("Failed to seed cashier register");
  await db.insert(registerPrintPreferences).values({
    register_id: register.id,
    paper_width: 80,
    language: "bilingual",
    receipt_copies: 1,
    kot_copies: 1,
    updated_by: userId,
  }).onConflictDoNothing();
  let demoShift = await db.query.cashierShifts.findFirst({ where: and(
    eq(cashierShifts.register_id, register.id),
    eq(cashierShifts.opened_by, userId),
    eq(cashierShifts.status, "closed"),
  ) });
  if (!demoShift) {
    [demoShift] = await db.insert(cashierShifts).values({
      branch_id: branchId,
      register_id: register.id,
      cashier_user_id: userId,
      opened_by: userId,
      closed_by: userId,
      status: "closed",
      opening_float: 0,
      expected_cash: 41500,
      closing_cash: 41500,
      variance: 0,
      closed_at: new Date(),
    }).returning();
  }

  const orderSeeds = [
    { request: "forno-demo-dine-in", customer: "ahmed@forno.demo", type: "dine_in" as const, table: table1.id, address: null, item: "MARGHERITA" },
    { request: "forno-demo-takeaway", customer: "mariam@forno.demo", type: "takeaway" as const, table: null, address: null, item: "CHICKEN-DONER" },
    { request: "forno-demo-delivery", customer: "omar@forno.demo", type: "delivery" as const, table: null, address: "90th Street, New Cairo", item: "FORNO-SPECIAL" },
  ];
  for (const demo of orderSeeds) {
    const menuItem = itemByCode.get(demo.item)!;
    const [created] = await db.insert(orders).values({
      branch_id: branchId,
      customer_id: customerByEmail.get(demo.customer),
      dining_table_id: demo.table,
      client_request_id: demo.request,
      order_type: demo.type,
      subtotal_amount: menuItem.base_price,
      total_amount: menuItem.base_price,
      payment_status: "paid",
      paid_at: new Date(),
      delivery_address: demo.address,
      user_uid: userId,
      status: "completed",
    }).onConflictDoNothing().returning();
    const seededOrder = created ?? await db.query.orders.findFirst({ where: eq(orders.client_request_id, demo.request) });
    if (!seededOrder) throw new Error(`Failed to seed order ${demo.request}`);
    await db.update(orders).set({
      subtotal_amount: menuItem.base_price,
      discount_value: 0,
      discount_amount: 0,
      total_amount: menuItem.base_price,
      payment_status: "paid",
      paid_at: seededOrder.paid_at ?? new Date(),
    }).where(eq(orders.id, seededOrder.id));
    if (created) {
      await db.insert(orderItems).values({ order_id: created.id, menu_item_id: menuItem.id, product_id: menuItem.product_id, quantity: 1, price: menuItem.base_price });
      await db.insert(orderStatusHistory).values({ order_id: created.id, from_status: null, to_status: "completed", changed_by: userId, note: "FORNO demo order" });
    }
    let checkout = await db.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.order_id, seededOrder.id) });
    if (!checkout) {
      [checkout] = await db.insert(orderCheckouts).values({
        order_id: seededOrder.id,
        shift_id: demoShift.id,
        idempotency_key: `seed-checkout-${demo.request}`,
        subtotal_amount: menuItem.base_price,
        discount_amount: 0,
        payable_amount: menuItem.base_price,
        created_by: userId,
      }).returning();
    }
    let payment = await db.query.orderPayments.findFirst({ where: and(eq(orderPayments.checkout_id, checkout.id), eq(orderPayments.kind, "payment")) });
    if (!payment) {
      [payment] = await db.insert(orderPayments).values({
        checkout_id: checkout.id,
        order_id: seededOrder.id,
        shift_id: demoShift.id,
        payment_method_id: paymentByName.get("Cash")!,
        kind: "payment",
        amount: menuItem.base_price,
        tendered_amount: menuItem.base_price,
        change_amount: 0,
        created_by: userId,
      }).returning();
    }
    const transaction = await db.query.transactions.findFirst({ where: eq(transactions.order_payment_id, payment.id) });
    if (!transaction) await db.insert(transactions).values({ order_id: seededOrder.id, shift_id: demoShift.id, order_payment_id: payment.id, payment_method_id: paymentByName.get("Cash"), amount: menuItem.base_price, user_uid: userId, type: "income", category: "selling", status: "completed", description: `Payment for order #${seededOrder.id}` });
  }

}
