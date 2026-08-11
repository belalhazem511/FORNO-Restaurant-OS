import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { ordersRouter } = await import("../orders");
const { createCallerFactory } = await import("../../init");
const {
  branches,
  ingredientCategories,
  ingredients,
  inventoryLocations,
  customers,
  diningAreas,
  kitchenStations,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  menuItemVariants,
  modifierGroups,
  modifierOptions,
  orderItemModifiers,
  orderItems,
  orders,
  orderStatusHistory,
  recipeComponents,
  recipeVersions,
  products,
  restaurantTables,
  stockBalances,
  staffAssignments,
  transactions,
  user,
  unitsOfMeasure,
} = await import("@/lib/db/schema");

const caller = createCallerFactory(ordersRouter)({ user: makeUser("user-1") });
const callerAs = (uid: string) => createCallerFactory(ordersRouter)({ user: makeUser(uid) });

let branchId: number;
let tableId: number;
let customerId: number;
let pizzaId: number;
let donerId: number;
let smallVariantId: number;
let largeVariantId: number;
let foreignVariantId: number;
let mozzarellaId: number;
let cheddarId: number;
let olivesId: number;
let mushroomsId: number;
let foreignModifierId: number;
let requestSequence = 0;

const requestId = (label: string) => `orders-test-${label}-${++requestSequence}`;
const pizzaLine = (overrides: Partial<{
  menuItemId: number;
  variantId: number | null;
  modifierOptionIds: number[];
  quantity: number;
  notes: string;
}> = {}) => ({
  menuItemId: pizzaId,
  variantId: smallVariantId,
  modifierOptionIds: [mozzarellaId],
  quantity: 1,
  ...overrides,
});

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values([makeUser("user-1"), makeUser("cashier-2")]);

  const [branch] = await db.insert(branches).values({
    code: "TEST", name_en: "Test Branch", name_ar: "فرع الاختبار",
    currency: "EGP", timezone: "Africa/Cairo", is_active: true,
  }).returning();
  branchId = branch.id;
  await db.insert(staffAssignments).values({ user_id: "user-1", branch_id: branchId, role: "admin", is_active: true });
  await db.insert(staffAssignments).values({ user_id: "cashier-2", branch_id: branchId, role: "cashier", is_active: true });

  const [area] = await db.insert(diningAreas).values({
    branch_id: branchId, code: "MAIN", name_en: "Main", name_ar: "الرئيسية",
    sort_order: 1, is_active: true,
  }).returning();
  const [table] = await db.insert(restaurantTables).values({
    dining_area_id: area.id, code: "T1", name_en: "Table 1", name_ar: "طاولة ١",
    capacity: 4, status: "available", is_active: true,
  }).returning();
  tableId = table.id;

  const [station] = await db.insert(kitchenStations).values({
    branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", is_active: true,
  }).returning();
  const [category] = await db.insert(menuCategories).values({
    branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا",
    sort_order: 1, is_active: true,
  }).returning();

  const [pizzaProduct, donerProduct] = await db.insert(products).values([
    { name: "Test Pizza", price: 10000, in_stock: 100, user_uid: "user-1", category: "pizza" },
    { name: "Test Doner", price: 9000, in_stock: 100, user_uid: "user-1", category: "doner" },
  ]).returning();
  const [pizza, doner] = await db.insert(menuItems).values([
    {
      category_id: category.id, kitchen_station_id: station.id, product_id: pizzaProduct.id,
      code: "TEST-PIZZA", name_en: "Test Pizza", name_ar: "بيتزا اختبار",
      base_price: 10000, is_available: true, sort_order: 1,
    },
    {
      category_id: category.id, kitchen_station_id: station.id, product_id: donerProduct.id,
      code: "TEST-DONER", name_en: "Test Doner", name_ar: "دونر اختبار",
      base_price: 9000, is_available: true, sort_order: 2,
    },
  ]).returning();
  pizzaId = pizza.id;
  donerId = doner.id;

  const variants = await db.insert(menuItemVariants).values([
    { menu_item_id: pizzaId, code: "S", name_en: "Small", name_ar: "صغير", price: 10000, is_default: true, is_available: true, sort_order: 1 },
    { menu_item_id: pizzaId, code: "L", name_en: "Large", name_ar: "كبير", price: 15000, is_default: false, is_available: true, sort_order: 2 },
    { menu_item_id: donerId, code: "ONLY", name_en: "Regular", name_ar: "عادي", price: 9000, is_default: true, is_available: true, sort_order: 1 },
  ]).returning();
  smallVariantId = variants[0].id;
  largeVariantId = variants[1].id;
  foreignVariantId = variants[2].id;

  const [cheeseGroup, extrasGroup, foreignGroup] = await db.insert(modifierGroups).values([
    { branch_id: branchId, code: "CHEESE", name_en: "Cheese", name_ar: "الجبن", min_selections: 1, max_selections: 1, sort_order: 1, is_active: true },
    { branch_id: branchId, code: "EXTRAS", name_en: "Extras", name_ar: "إضافات", min_selections: 0, max_selections: 2, sort_order: 2, is_active: true },
    { branch_id: branchId, code: "SAUCE", name_en: "Sauce", name_ar: "الصوص", min_selections: 0, max_selections: 1, sort_order: 1, is_active: true },
  ]).returning();
  const options = await db.insert(modifierOptions).values([
    { modifier_group_id: cheeseGroup.id, code: "MOZZ", name_en: "Mozzarella", name_ar: "موزاريلا", price_delta: 0, is_default: true, is_available: true, sort_order: 1 },
    { modifier_group_id: cheeseGroup.id, code: "CHEDDAR", name_en: "Cheddar", name_ar: "شيدر", price_delta: 2000, is_default: false, is_available: true, sort_order: 2 },
    { modifier_group_id: extrasGroup.id, code: "OLIVES", name_en: "Olives", name_ar: "زيتون", price_delta: 1000, is_default: false, is_available: true, sort_order: 1 },
    { modifier_group_id: extrasGroup.id, code: "MUSHROOM", name_en: "Mushrooms", name_ar: "مشروم", price_delta: 1500, is_default: false, is_available: true, sort_order: 2 },
    { modifier_group_id: foreignGroup.id, code: "GARLIC", name_en: "Garlic", name_ar: "ثوم", price_delta: 500, is_default: false, is_available: true, sort_order: 1 },
  ]).returning();
  [mozzarellaId, cheddarId, olivesId, mushroomsId, foreignModifierId] = options.map((option) => option.id);
  await db.insert(menuItemModifierGroups).values([
    { menu_item_id: pizzaId, modifier_group_id: cheeseGroup.id, sort_order: 1 },
    { menu_item_id: pizzaId, modifier_group_id: extrasGroup.id, sort_order: 2 },
    { menu_item_id: donerId, modifier_group_id: foreignGroup.id, sort_order: 1 },
  ]);

  const [inventoryLocation] = await db.insert(inventoryLocations).values({ branch_id: branchId, code: "PIZZA-KITCHEN", name_en: "Pizza Kitchen", name_ar: "مطبخ البيتزا", is_active: true }).returning();
  const [ingredientCategory] = await db.insert(ingredientCategories).values({ branch_id: branchId, code: "DAIRY", name_en: "Dairy", name_ar: "ألبان", is_active: true }).returning();
  const [gram] = await db.insert(unitsOfMeasure).values({ code: "G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 }).returning();
  const [cheese] = await db.insert(ingredients).values({ branch_id: branchId, category_id: ingredientCategory.id, sku: "TEST-CHEESE", name_en: "Test cheese", name_ar: "جبن اختبار", base_unit_id: gram.id, dimension: "mass", default_location_id: inventoryLocation.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, par_level: null, allow_negative: true, average_unit_cost_micros: 10_000, created_by: "user-1", updated_by: "user-1" }).returning();
  await db.insert(stockBalances).values({ branch_id: branchId, location_id: inventoryLocation.id, ingredient_id: cheese.id, quantity_base: 10_000_000_000, average_unit_cost_micros: 10_000 });
  const [recipe] = await db.insert(recipeVersions).values({ branch_id: branchId, menu_item_id: pizzaId, variant_id: smallVariantId, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "user-1", approved_by: "user-1", approved_at: new Date() }).returning();
  await db.insert(recipeComponents).values({ recipe_version_id: recipe.id, ingredient_id: cheese.id, source_location_id: inventoryLocation.id, modifier_option_id: null, unit_id: gram.id, quantity_input_scaled: 100_000, quantity_base: 100_000_000 });

  const [customer] = await db.insert(customers).values({
    name: "Delivery Customer", email: "delivery@example.test", phone: "01000000000",
    user_uid: "user-1", status: "active",
  }).returning();
  customerId = customer.id;
});

afterAll(async () => { await pg.close(); });

describe("secure POS order creation", () => {
  it("creates items, modifier snapshots and initial history atomically", async () => {
    const order = await caller.create({
      branchId, orderType: "takeaway", clientRequestId: requestId("atomic"),
      items: [pizzaLine({ quantity: 2, modifierOptionIds: [cheddarId, olivesId], notes: "well done" })],
    });

    expect(order.status).toBe("pending");
    expect(order.total_amount).toBe((10000 + 2000 + 1000) * 2);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.order_id, order.id));
    expect(item.price).toBe(10000);
    expect(item.notes).toBe("well done");
    const snapshots = await db.select().from(orderItemModifiers).where(eq(orderItemModifiers.order_item_id, item.id));
    expect(snapshots.map((entry) => entry.price_delta).sort()).toEqual([1000, 2000]);
    expect((await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.order_id, order.id))).map((entry) => entry.to_status)).toEqual(["pending"]);
    expect(await db.select().from(transactions).where(eq(transactions.order_id, order.id))).toHaveLength(0);
  });

  it("recalculates variant and modifier prices from the database", async () => {
    const order = await caller.create({
      branchId, orderType: "takeaway", clientRequestId: requestId("pricing"),
      items: [pizzaLine({ variantId: largeVariantId, modifierOptionIds: [cheddarId, olivesId, mushroomsId], quantity: 3 })],
    });
    expect(order.total_amount).toBe((15000 + 2000 + 1000 + 1500) * 3);
  });

  it("returns the original order for a duplicate client request ID", async () => {
    const clientRequestId = requestId("duplicate");
    const first = await caller.create({ branchId, orderType: "takeaway", clientRequestId, items: [pizzaLine()] });
    const second = await caller.create({ branchId, orderType: "takeaway", clientRequestId, items: [pizzaLine({ quantity: 4 })] });
    expect(second.id).toBe(first.id);
    expect(second.total_amount).toBe(first.total_amount);
    expect((await db.select().from(orderItems).where(eq(orderItems.order_id, first.id)))).toHaveLength(1);
  });

  it("requires and atomically claims an available table for dine-in", async () => {
    await expect(caller.create({ branchId, orderType: "dine_in", clientRequestId: requestId("no-table"), items: [pizzaLine()] })).rejects.toThrow("require a table");
    const order = await caller.create({ branchId, orderType: "dine_in", diningTableId: tableId, clientRequestId: requestId("dine-in"), items: [pizzaLine()] });
    expect(order.dining_table_id).toBe(tableId);
    expect((await db.select().from(restaurantTables).where(eq(restaurantTables.id, tableId)))[0].status).toBe("occupied");
  });

  it("allows takeaway without a table", async () => {
    const order = await caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("takeaway"), items: [pizzaLine()] });
    expect(order.dining_table_id).toBeNull();
    expect(order.delivery_address).toBeNull();
  });

  it("requires both a customer and address for delivery", async () => {
    await expect(caller.create({ branchId, orderType: "delivery", clientRequestId: requestId("delivery-address"), items: [pizzaLine()] })).rejects.toThrow("require an address");
    await expect(caller.create({ branchId, orderType: "delivery", deliveryAddress: "1 Test Street", clientRequestId: requestId("delivery-customer"), items: [pizzaLine()] })).rejects.toThrow("customer information");
    const order = await caller.create({ branchId, customerId, orderType: "delivery", deliveryAddress: "1 Test Street", clientRequestId: requestId("delivery-ok"), items: [pizzaLine()] });
    expect(order.delivery_address).toBe("1 Test Street");
    expect(order.customer?.name).toBe("Delivery Customer");
  });

  it("rejects a variant owned by a different menu item without writing", async () => {
    const before = await caller.list();
    await expect(caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("foreign-variant"), items: [pizzaLine({ variantId: foreignVariantId })] })).rejects.toThrow("variant does not belong");
    expect(await caller.list()).toHaveLength(before.length);
  });

  it("rejects foreign modifiers, missing required selections and selections above maximum", async () => {
    await expect(caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("foreign-mod"), items: [pizzaLine({ modifierOptionIds: [mozzarellaId, foreignModifierId] })] })).rejects.toThrow("modifier does not belong");
    await expect(caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("missing-required"), items: [pizzaLine({ modifierOptionIds: [] })] })).rejects.toThrow("CHEESE requires 1-1");
    await expect(caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("over-max"), items: [pizzaLine({ modifierOptionIds: [mozzarellaId, cheddarId] })] })).rejects.toThrow("CHEESE requires 1-1");
  });

  it("isolates orders by user", async () => {
    expect(await callerAs("outsider").list()).toEqual([]);
  });
});

describe("order lifecycle", () => {
  it("validates type-specific transitions and records history", async () => {
    const order = await caller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("lifecycle"), items: [pizzaLine()] });
    expect((await caller.transition({ id: order.id, status: "confirmed" })).status).toBe("confirmed");
    expect((await caller.transition({ id: order.id, status: "preparing" })).status).toBe("preparing");
    expect((await caller.transition({ id: order.id, status: "ready" })).status).toBe("ready");
    await expect(caller.transition({ id: order.id, status: "served" })).rejects.toThrow();
    expect((await caller.transition({ id: order.id, status: "collected" })).status).toBe("collected");
    expect((await caller.transition({ id: order.id, status: "completed" })).status).toBe("completed");
  });

  it("denies cashier negative-stock override even when a reason is supplied", async () => {
    const cashierCaller = callerAs("cashier-2");
    const order = await cashierCaller.create({ branchId, orderType: "takeaway", clientRequestId: requestId("cashier-override"), items: [pizzaLine()] });
    await expect(cashierCaller.transition({ id: order.id, status: "confirmed", inventoryOverrideReason: "Cashier cannot self authorize" })).rejects.toThrow("Cashiers cannot override");
    expect((await db.query.orders.findFirst({ where: eq(orders.id, order.id) }))?.status).toBe("pending");
  });
});
