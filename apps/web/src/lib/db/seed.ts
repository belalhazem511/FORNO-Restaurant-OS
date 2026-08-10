import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, pglite } from ".";
import {
  branches,
  customers,
  diningAreas,
  kitchenStations,
  menuCategories,
  menuItemModifierGroups,
  menuItems,
  menuItemVariants,
  modifierGroups,
  modifierOptions,
  orderItems,
  orders,
  orderStatusHistory,
  paymentMethods,
  products,
  restaurantTables,
  transactions,
  user,
} from "./schema";

const DEMO_EMAIL = "admin@forno.local";
const DEMO_PASSWORD = "Forno123!";
const DEMO_NAME = "FORNO Admin";

async function demoUserId() {
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, DEMO_EMAIL)).limit(1);
  if (existing) return existing.id;
  const result = await auth.api.signUpEmail({
    body: { name: DEMO_NAME, email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  return result.user.id;
}

export async function seed() {
  const userId = await demoUserId();

  await db.insert(paymentMethods).values([{ name: "Card" }, { name: "InstaPay" }, { name: "Cash" }]).onConflictDoNothing();
  const methods = await db.select().from(paymentMethods);
  const paymentByName = new Map(methods.map((method) => [method.name, method.id]));

  await db.insert(branches).values({
    code: "FORNO-MAIN",
    name_en: "FORNO Main Branch",
    name_ar: "فرع فورنو الرئيسي",
    address_en: "New Cairo, Cairo",
    address_ar: "القاهرة الجديدة، القاهرة",
    phone: "+20 100 000 0000",
  }).onConflictDoNothing();
  const branch = await db.query.branches.findFirst({ where: eq(branches.code, "FORNO-MAIN") });
  if (!branch) throw new Error("Failed to seed FORNO branch");

  const areaSeeds = [
    { code: "INDOOR", name_en: "Main Dining Room", name_ar: "الصالة الرئيسية", sort_order: 1 },
    { code: "TERRACE", name_en: "Terrace", name_ar: "التراس", sort_order: 2 },
  ];
  for (const area of areaSeeds) {
    await db.insert(diningAreas).values({ branch_id: branch.id, ...area }).onConflictDoNothing();
  }
  const areas = await db.select().from(diningAreas).where(eq(diningAreas.branch_id, branch.id));
  const areaByCode = new Map(areas.map((area) => [area.code, area.id]));
  const tableSeeds = [
    { dining_area_id: areaByCode.get("INDOOR")!, code: "T1", name_en: "Table 1", name_ar: "طاولة ١", capacity: 4 },
    { dining_area_id: areaByCode.get("INDOOR")!, code: "T2", name_en: "Table 2", name_ar: "طاولة ٢", capacity: 4 },
    { dining_area_id: areaByCode.get("INDOOR")!, code: "T3", name_en: "Table 3", name_ar: "طاولة ٣", capacity: 6 },
    { dining_area_id: areaByCode.get("TERRACE")!, code: "T4", name_en: "Table 4", name_ar: "طاولة ٤", capacity: 4 },
  ];
  for (const table of tableSeeds) await db.insert(restaurantTables).values(table).onConflictDoNothing();

  const stationSeeds = [
    { code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا" },
    { code: "DONER", name_en: "Doner", name_ar: "دونر" },
    { code: "CAFE", name_en: "Cafe", name_ar: "كافيه" },
  ];
  for (const station of stationSeeds) {
    await db.insert(kitchenStations).values({ branch_id: branch.id, ...station }).onConflictDoNothing();
  }
  const stations = await db.select().from(kitchenStations).where(eq(kitchenStations.branch_id, branch.id));
  const stationByCode = new Map(stations.map((station) => [station.code, station.id]));

  const categorySeeds = [
    { code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", sort_order: 1 },
    { code: "DONER", name_en: "Doner", name_ar: "دونر", sort_order: 2 },
    { code: "CAFE", name_en: "Cafe", name_ar: "كافيه", sort_order: 3 },
    { code: "DRINKS", name_en: "Cold Drinks", name_ar: "مشروبات باردة", sort_order: 4 },
  ];
  for (const category of categorySeeds) {
    await db.insert(menuCategories).values({ branch_id: branch.id, ...category }).onConflictDoNothing();
  }
  const categories = await db.select().from(menuCategories).where(eq(menuCategories.branch_id, branch.id));
  const categoryByCode = new Map(categories.map((category) => [category.code, category.id]));

  const itemSeeds = [
    { code: "MARGHERITA", name_en: "Margherita Pizza", name_ar: "بيتزا مارجريتا", category: "PIZZA", station: "PIZZA", price: 12500 },
    { code: "PEPPERONI", name_en: "Pepperoni Pizza", name_ar: "بيتزا بيبروني", category: "PIZZA", station: "PIZZA", price: 16500 },
    { code: "FORNO-SPECIAL", name_en: "FORNO Special Pizza", name_ar: "بيتزا فورنو سبيشيال", category: "PIZZA", station: "PIZZA", price: 19500 },
    { code: "CHICKEN-DONER", name_en: "Chicken Doner Sandwich", name_ar: "ساندوتش دونر فراخ", category: "DONER", station: "DONER", price: 9500 },
    { code: "BEEF-DONER", name_en: "Beef Doner Sandwich", name_ar: "ساندوتش دونر لحم", category: "DONER", station: "DONER", price: 11500 },
    { code: "CAPPUCCINO", name_en: "Cappuccino", name_ar: "كابتشينو", category: "CAFE", station: "CAFE", price: 6500 },
    { code: "LATTE", name_en: "Latte", name_ar: "لاتيه", category: "CAFE", station: "CAFE", price: 7000 },
    { code: "LEMON-MINT", name_en: "Lemon Mint", name_ar: "ليمون بالنعناع", category: "DRINKS", station: "CAFE", price: 6000 },
  ];

  for (const item of itemSeeds) {
    await db.insert(products).values({
      name: item.name_en,
      description: `${item.name_en} prepared fresh at FORNO`,
      price: item.price,
      in_stock: 100,
      user_uid: userId,
      category: item.category.toLowerCase(),
    }).onConflictDoNothing();
    const product = await db.query.products.findFirst({
      where: and(eq(products.user_uid, userId), eq(products.name, item.name_en)),
    });
    await db.insert(menuItems).values({
      code: item.code,
      name_en: item.name_en,
      name_ar: item.name_ar,
      description_en: `Prepared fresh at FORNO`,
      description_ar: "يُحضّر طازجًا في فورنو",
      category_id: categoryByCode.get(item.category)!,
      kitchen_station_id: stationByCode.get(item.station)!,
      product_id: product!.id,
      base_price: item.price,
    }).onConflictDoNothing();
  }
  const seededItems = await db.select().from(menuItems);
  const itemByCode = new Map(seededItems.map((item) => [item.code, item]));

  for (const code of ["MARGHERITA", "PEPPERONI", "FORNO-SPECIAL"]) {
    const item = itemByCode.get(code)!;
    for (const variant of [
      { code: "S", name_en: "Small", name_ar: "صغير", price: item.base_price, is_default: true, sort_order: 1 },
      { code: "M", name_en: "Medium", name_ar: "وسط", price: item.base_price + 4000, sort_order: 2 },
      { code: "L", name_en: "Large", name_ar: "كبير", price: item.base_price + 7500, sort_order: 3 },
    ]) await db.insert(menuItemVariants).values({ menu_item_id: item.id, ...variant }).onConflictDoNothing();
  }

  const groupSeeds = [
    { code: "SIZE", name_en: "Size", name_ar: "الحجم", min_selections: 1, max_selections: 1, sort_order: 1 },
    { code: "CHEESE", name_en: "Cheese Type", name_ar: "نوع الجبن", min_selections: 1, max_selections: 1, sort_order: 2 },
    { code: "EXTRAS", name_en: "Extras", name_ar: "الإضافات", min_selections: 0, max_selections: 4, sort_order: 3 },
  ];
  for (const group of groupSeeds) await db.insert(modifierGroups).values({ branch_id: branch.id, ...group }).onConflictDoNothing();
  const groups = await db.select().from(modifierGroups).where(eq(modifierGroups.branch_id, branch.id));
  const groupByCode = new Map(groups.map((group) => [group.code, group.id]));
  const optionSeeds = [
    { group: "SIZE", code: "REGULAR", name_en: "Regular", name_ar: "عادي", price_delta: 0, is_default: true },
    { group: "SIZE", code: "LARGE", name_en: "Large", name_ar: "كبير", price_delta: 2500 },
    { group: "CHEESE", code: "MOZZARELLA", name_en: "Mozzarella", name_ar: "موتزاريلا", price_delta: 0, is_default: true },
    { group: "CHEESE", code: "CHEDDAR", name_en: "Cheddar", name_ar: "شيدر", price_delta: 1500 },
    { group: "CHEESE", code: "MIX", name_en: "Mixed Cheese", name_ar: "خليط جبن", price_delta: 2500 },
    { group: "EXTRAS", code: "MUSHROOM", name_en: "Mushrooms", name_ar: "مشروم", price_delta: 1500 },
    { group: "EXTRAS", code: "OLIVES", name_en: "Olives", name_ar: "زيتون", price_delta: 1000 },
    { group: "EXTRAS", code: "JALAPENO", name_en: "Jalapeno", name_ar: "هالبينو", price_delta: 1000 },
    { group: "EXTRAS", code: "EXTRA-MEAT", name_en: "Extra Meat", name_ar: "لحم إضافي", price_delta: 3500 },
  ];
  for (const option of optionSeeds) {
    const { group, ...values } = option;
    await db.insert(modifierOptions).values({ modifier_group_id: groupByCode.get(group)!, ...values }).onConflictDoNothing();
  }

  const links: Array<[string, string]> = [
    ["MARGHERITA", "CHEESE"], ["MARGHERITA", "EXTRAS"],
    ["PEPPERONI", "CHEESE"], ["PEPPERONI", "EXTRAS"],
    ["FORNO-SPECIAL", "CHEESE"], ["FORNO-SPECIAL", "EXTRAS"],
    ["CHICKEN-DONER", "SIZE"], ["CHICKEN-DONER", "EXTRAS"],
    ["BEEF-DONER", "SIZE"], ["BEEF-DONER", "EXTRAS"],
    ["CAPPUCCINO", "SIZE"], ["LATTE", "SIZE"],
  ];
  for (const [itemCode, groupCode] of links) {
    await db.insert(menuItemModifierGroups).values({
      menu_item_id: itemByCode.get(itemCode)!.id,
      modifier_group_id: groupByCode.get(groupCode)!,
    }).onConflictDoNothing();
  }

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

  const orderSeeds = [
    { request: "forno-demo-dine-in", customer: "ahmed@forno.demo", type: "dine_in" as const, table: table1.id, address: null, item: "MARGHERITA" },
    { request: "forno-demo-takeaway", customer: "mariam@forno.demo", type: "takeaway" as const, table: null, address: null, item: "CHICKEN-DONER" },
    { request: "forno-demo-delivery", customer: "omar@forno.demo", type: "delivery" as const, table: null, address: "90th Street, New Cairo", item: "FORNO-SPECIAL" },
  ];
  for (const demo of orderSeeds) {
    const menuItem = itemByCode.get(demo.item)!;
    const [created] = await db.insert(orders).values({
      branch_id: branch.id,
      customer_id: customerByEmail.get(demo.customer),
      dining_table_id: demo.table,
      client_request_id: demo.request,
      order_type: demo.type,
      total_amount: menuItem.base_price,
      delivery_address: demo.address,
      user_uid: userId,
      status: "completed",
    }).onConflictDoNothing().returning();
    if (!created) continue;
    await db.insert(orderItems).values({ order_id: created.id, menu_item_id: menuItem.id, product_id: menuItem.product_id, quantity: 1, price: menuItem.base_price });
    await db.insert(orderStatusHistory).values({ order_id: created.id, from_status: null, to_status: "completed", changed_by: userId, note: "FORNO demo order" });
    await db.insert(transactions).values({ order_id: created.id, payment_method_id: paymentByName.get("Cash"), amount: menuItem.base_price, user_uid: userId, type: "income", category: "selling", status: "completed", description: `Payment for order #${created.id}` });
  }

  console.log(`FORNO seed ready: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

if (import.meta.main) {
  await seed();
  await pglite.close();
}
