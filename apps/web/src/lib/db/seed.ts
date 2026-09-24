import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, pglite } from ".";
import {
  branches,
  cashierRegisters,
  cashierShifts,
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
  orderCheckouts,
  orderPayments,
  orders,
  orderStatusHistory,
  paymentMethods,
  products,
  registerPrintPreferences,
  restaurantTables,
  suppliers,
  purchaseOrders,
  purchaseOrderLines,
  ingredientPackageConversions,
  ingredients,
  inventoryLocations,
  stockTransferLines,
  stockTransferStatusHistory,
  stockTransfers,
  unitsOfMeasure,
  staffAssignments,
  transactions,
  user,
} from "./schema";
import { seedInventory } from "./inventory-seed";

const DEMO_EMAIL = "admin@forno.local";
const DEMO_PASSWORD = "Forno123!";
const DEMO_NAME = "FORNO Admin";
const CASHIER_EMAIL = "cashier@forno.local";
const CASHIER_PASSWORD = "Forno123!";
const MANAGER_EMAIL = "manager@forno.local";
const MANAGER_PASSWORD = "Forno123!";

async function demoUserId(email: string, name: string, password: string) {
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing) return existing.id;
  const result = await auth.api.signUpEmail({
    body: { name, email, password },
  });
  return result.user.id;
}

export async function seed() {
  const userId = await demoUserId(DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD);
  const cashierUserId = await demoUserId(CASHIER_EMAIL, "FORNO Cashier", CASHIER_PASSWORD);
  const managerUserId = await demoUserId(MANAGER_EMAIL, "FORNO Manager", MANAGER_PASSWORD);

  await db.insert(paymentMethods).values([
    { code: "CARD", name: "Card", affects_drawer: false, is_active: true },
    { code: "INSTAPAY", name: "InstaPay", affects_drawer: false, is_active: true },
    { code: "CASH", name: "Cash", affects_drawer: true, is_active: true },
  ]).onConflictDoNothing();
  await db.update(paymentMethods).set({ code: "CARD", affects_drawer: false, is_active: true }).where(eq(paymentMethods.name, "Card"));
  await db.update(paymentMethods).set({ code: "INSTAPAY", affects_drawer: false, is_active: true }).where(eq(paymentMethods.name, "InstaPay"));
  await db.update(paymentMethods).set({ code: "CASH", affects_drawer: true, is_active: true }).where(eq(paymentMethods.name, "Cash"));
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

  await db.insert(staffAssignments).values({
    user_id: userId,
    branch_id: branch.id,
    role: "admin",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "admin", is_active: true, updated_at: new Date() },
  });
  await db.insert(staffAssignments).values({
    user_id: cashierUserId,
    branch_id: branch.id,
    role: "cashier",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "cashier", is_active: true, updated_at: new Date() },
  });
  await db.insert(staffAssignments).values({
    user_id: managerUserId,
    branch_id: branch.id,
    role: "manager",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "manager", is_active: true, updated_at: new Date() },
  });
  await db.insert(cashierRegisters).values({
    branch_id: branch.id,
    code: "FRONT",
    name_en: "Front Register",
    name_ar: "كاشير الواجهة",
    is_active: true,
  }).onConflictDoNothing();

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

  await seedInventory(branch.id, userId);

  const [demoSupplier] = await db.insert(suppliers).values({
    branch_id: branch.id,
    code: "FRESH-FOODS",
    name_en: "Fresh Foods Supplier",
    name_ar: "مورد الأغذية الطازجة",
    contact_name: "Ahmed Hassan",
    phone: "+20 100 111 2222",
    email: "orders@freshfoods.example",
    address: "Obour City, Cairo",
    notes: "Demo procurement supplier",
    created_by: userId,
    updated_by: userId,
  }).onConflictDoNothing().returning();
  const seededSupplier = demoSupplier ?? await db.query.suppliers.findFirst({
    where: and(eq(suppliers.branch_id, branch.id), eq(suppliers.code, "FRESH-FOODS")),
  });
  const flour = await db.query.ingredients.findFirst({
    where: and(eq(ingredients.branch_id, branch.id), eq(ingredients.sku, "FLOUR-00")),
  });
  const gram = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "G") });
  if (seededSupplier && flour && gram) {
    let demoPurchaseOrder = await db.query.purchaseOrders.findFirst({
      where: eq(purchaseOrders.idempotency_key, "seed-po-fresh-foods"),
    });
    if (!demoPurchaseOrder) {
      [demoPurchaseOrder] = await db.insert(purchaseOrders).values({
        branch_id: branch.id,
        supplier_id: seededSupplier.id,
        supplier_code_snapshot: seededSupplier.code,
        supplier_name_en_snapshot: seededSupplier.name_en,
        supplier_name_ar_snapshot: seededSupplier.name_ar,
        po_number: "PO-DEMO-001",
        status: "draft",
        receiving_status: "not_received",
        currency: "EGP",
        subtotal_amount: 18_000,
        total_amount: 18_000,
        notes: "Demo draft awaiting approval; no inventory effect",
        idempotency_key: "seed-po-fresh-foods",
        created_by: userId,
      }).returning();
      await db.insert(purchaseOrderLines).values({
        purchase_order_id: demoPurchaseOrder.id,
        ingredient_id: flour.id,
        unit_id: gram.id,
        ingredient_sku: flour.sku,
        ingredient_name_en: flour.name_en,
        ingredient_name_ar: flour.name_ar,
        unit_code: gram.code,
        quantity_input_scaled: 10_000,
        quantity_base: 10_000_000,
        conversion_numerator_snapshot: gram.base_numerator,
        conversion_denominator_snapshot: gram.base_denominator,
        unit_price_minor: 1_800,
        line_total_amount: 18_000,
        notes: "Demo flour order",
      });
    }
  }
  if (seededSupplier && flour && gram) {
    const [packageRow, sauce, litre] = await Promise.all([
      db.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.ingredient_id, flour.id), eq(ingredientPackageConversions.code, "BAG-25KG")) }),
      db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branch.id), eq(ingredients.sku, "PIZZA-SAUCE")) }),
      db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "L") }),
    ]);
    const existingReceivingOrder = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.idempotency_key, "seed-po-receiving") });
    if (!existingReceivingOrder && packageRow && sauce && litre) {
      const [approvedOrder] = await db.insert(purchaseOrders).values({
        branch_id: branch.id,
        supplier_id: seededSupplier.id,
        supplier_code_snapshot: seededSupplier.code,
        supplier_name_en_snapshot: seededSupplier.name_en,
        supplier_name_ar_snapshot: seededSupplier.name_ar,
        po_number: "PO-RECEIVING-001",
        status: "approved",
        receiving_status: "not_received",
        approved_by: userId,
        currency: "EGP",
        subtotal_amount: 675_000,
        total_amount: 675_000,
        notes: "Deterministic approved purchase order for receiving verification",
        idempotency_key: "seed-po-receiving",
        created_by: userId,
      }).returning();
      await db.insert(purchaseOrderLines).values([
        { purchase_order_id: approvedOrder.id, ingredient_id: flour.id, package_conversion_id: null, unit_id: gram.id, ingredient_sku: flour.sku, ingredient_name_en: flour.name_en, ingredient_name_ar: flour.name_ar, unit_code: gram.code, quantity_input_scaled: 10_000_000, quantity_base: 10_000_000_000, conversion_numerator_snapshot: gram.base_numerator, conversion_denominator_snapshot: gram.base_denominator, unit_price_minor: 50, line_total_amount: 500_000, notes: "Base-unit flour line" },
        { purchase_order_id: approvedOrder.id, ingredient_id: flour.id, package_conversion_id: packageRow.id, unit_id: gram.id, ingredient_sku: flour.sku, ingredient_name_en: flour.name_en, ingredient_name_ar: flour.name_ar, unit_code: packageRow.code, quantity_input_scaled: 2_000, quantity_base: 50_000_000_000, conversion_numerator_snapshot: packageRow.base_numerator, conversion_denominator_snapshot: packageRow.base_denominator, unit_price_minor: 80_000, line_total_amount: 160_000, notes: "Package-conversion flour line" },
        { purchase_order_id: approvedOrder.id, ingredient_id: sauce.id, package_conversion_id: null, unit_id: litre.id, ingredient_sku: sauce.sku, ingredient_name_en: sauce.name_en, ingredient_name_ar: sauce.name_ar, unit_code: litre.code, quantity_input_scaled: 1_000, quantity_base: 1_000_000, conversion_numerator_snapshot: litre.base_numerator, conversion_denominator_snapshot: litre.base_denominator, unit_price_minor: 15_000, line_total_amount: 15_000, notes: "Volume-unit sauce line" },
      ]);
    }
  }
  if (seededSupplier && gram) {
    const sugar = await db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branch.id), eq(ingredients.sku, "SUGAR")) });
    const existingOverrideOrder = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.idempotency_key, "seed-po-receiving-override") });
    if (sugar && !existingOverrideOrder) {
      const [overrideOrder] = await db.insert(purchaseOrders).values({
        branch_id: branch.id,
        supplier_id: seededSupplier.id,
        supplier_code_snapshot: seededSupplier.code,
        supplier_name_en_snapshot: seededSupplier.name_en,
        supplier_name_ar_snapshot: seededSupplier.name_ar,
        po_number: "PO-RECEIVING-OVERRIDE-001",
        status: "approved",
        receiving_status: "not_received",
        approved_by: userId,
        currency: "EGP",
        subtotal_amount: 500_000,
        total_amount: 500_000,
        notes: "Deterministic approved purchase order for over-receiving verification",
        idempotency_key: "seed-po-receiving-override",
        created_by: userId,
      }).returning();
      await db.insert(purchaseOrderLines).values({ purchase_order_id: overrideOrder.id, ingredient_id: sugar.id, unit_id: gram.id, ingredient_sku: sugar.sku, ingredient_name_en: sugar.name_en, ingredient_name_ar: sugar.name_ar, unit_code: gram.code, quantity_input_scaled: 1_000_000, quantity_base: 1_000_000_000, conversion_numerator_snapshot: gram.base_numerator, conversion_denominator_snapshot: gram.base_denominator, unit_price_minor: 500, line_total_amount: 500_000, notes: "Manager over-receive verification line" });
    }
  }

  const transferSeed = await db.query.stockTransfers.findFirst({ where: eq(stockTransfers.idempotency_key, "seed-stock-transfer-demo") });
  if (!transferSeed && flour && gram) {
    const [source, destination, sauce, ml] = await Promise.all([
      db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.branch_id, branch.id), eq(inventoryLocations.code, "PIZZA_KITCHEN")) }),
      db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.branch_id, branch.id), eq(inventoryLocations.code, "MAIN_STORE")) }),
      db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branch.id), eq(ingredients.sku, "PIZZA-SAUCE")) }),
      db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "ML") }),
    ]);
    const saucePackage = sauce && await db.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.ingredient_id, sauce.id), eq(ingredientPackageConversions.code, "CAN-3L")) });
    if (source && destination && sauce && saucePackage && ml) {
      const [transfer] = await db.insert(stockTransfers).values({ branch_id: source.branch_id, transfer_number: "ST-DEMO-001", source_location_id: source.id, destination_location_id: destination.id, source_code_snapshot: source.code, source_name_en_snapshot: source.name_en, source_name_ar_snapshot: source.name_ar, destination_code_snapshot: destination.code, destination_name_en_snapshot: destination.name_en, destination_name_ar_snapshot: destination.name_ar, status: "draft", notes: "Deterministic stock-transfer demo; no inventory effect until dispatch", idempotency_key: "seed-stock-transfer-demo", created_by: userId }).onConflictDoNothing().returning();
      if (transfer) await db.insert(stockTransferLines).values([
        { transfer_id: transfer.id, ingredient_id: flour.id, ingredient_sku_snapshot: flour.sku, ingredient_name_en_snapshot: flour.name_en, ingredient_name_ar_snapshot: flour.name_ar, dimension_snapshot: flour.dimension, unit_id: gram.id, unit_code_snapshot: gram.code, package_conversion_id: null, conversion_numerator_snapshot: gram.base_numerator, conversion_denominator_snapshot: gram.base_denominator, quantity_input_scaled: 500_000, quantity_base: 500_000_000, notes: "Base-unit flour movement" },
        { transfer_id: transfer.id, ingredient_id: sauce.id, ingredient_sku_snapshot: sauce.sku, ingredient_name_en_snapshot: sauce.name_en, ingredient_name_ar_snapshot: sauce.name_ar, dimension_snapshot: sauce.dimension, unit_id: ml.id, unit_code_snapshot: saucePackage.code, package_conversion_id: saucePackage.id, package_code_snapshot: saucePackage.code, package_name_en_snapshot: saucePackage.name_en, package_name_ar_snapshot: saucePackage.name_ar, conversion_numerator_snapshot: saucePackage.base_numerator, conversion_denominator_snapshot: saucePackage.base_denominator, quantity_input_scaled: 1_000, quantity_base: saucePackage.base_numerator, notes: "Package-conversion sauce movement" },
      ]);
      if (transfer) await db.insert(stockTransferStatusHistory).values({ transfer_id: transfer.id, branch_id: source.branch_id, from_status: null, to_status: "draft", actor_user_id: userId, idempotency_key: "seed-stock-transfer-demo:created", reason: "Deterministic seeded draft" }).onConflictDoNothing();
    }
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
  const register = await db.query.cashierRegisters.findFirst({ where: and(eq(cashierRegisters.branch_id, branch.id), eq(cashierRegisters.code, "FRONT")) });
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
      branch_id: branch.id,
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
      branch_id: branch.id,
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

  console.log(`FORNO seed ready: ${DEMO_EMAIL} and ${CASHIER_EMAIL} / ${DEMO_PASSWORD}`);
}

if (import.meta.main) {
  await seed();
  await pglite.close();
}
