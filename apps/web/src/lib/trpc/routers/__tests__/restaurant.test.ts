import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { restaurantRouter } = await import("../restaurant");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");
const caller = createCallerFactory(restaurantRouter)({ user: makeUser("user-1") });

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  const [branch] = await db.insert(schema.branches).values({
    code: "FORNO-TEST", name_en: "FORNO", name_ar: "فورنو", currency: "EGP",
    timezone: "Africa/Cairo", is_active: true,
  }).returning();
  const [area] = await db.insert(schema.diningAreas).values({
    branch_id: branch.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسية",
    sort_order: 1, is_active: true,
  }).returning();
  for (let number = 1; number <= 4; number++) {
    await db.insert(schema.restaurantTables).values({
      dining_area_id: area.id, code: `T${number}`, name_en: `Table ${number}`,
      name_ar: `طاولة ${number}`, capacity: 4, status: "available", is_active: true,
    });
  }
  const [station] = await db.insert(schema.kitchenStations).values({
    branch_id: branch.id, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", is_active: true,
  }).returning();
  const [category] = await db.insert(schema.menuCategories).values({
    branch_id: branch.id, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا",
    sort_order: 1, is_active: true,
  }).returning();
  const [product] = await db.insert(schema.products).values({
    name: "Margherita", price: 12000, in_stock: 10, user_uid: "user-1", category: "pizza",
  }).returning();
  const [item] = await db.insert(schema.menuItems).values({
    category_id: category.id, kitchen_station_id: station.id, product_id: product.id,
    code: "MARGHERITA", name_en: "Margherita", name_ar: "مارجريتا", base_price: 12000,
    is_available: true, sort_order: 1,
  }).returning();
  await db.insert(schema.menuItemVariants).values({
    menu_item_id: item.id, code: "L", name_en: "Large", name_ar: "كبير",
    price: 18000, is_default: true, is_available: true, sort_order: 1,
  });
  const [group] = await db.insert(schema.modifierGroups).values({
    branch_id: branch.id, code: "CHEESE", name_en: "Cheese", name_ar: "الجبن",
    min_selections: 1, max_selections: 1, sort_order: 1, is_active: true,
  }).returning();
  await db.insert(schema.modifierOptions).values({
    modifier_group_id: group.id, code: "MOZZARELLA", name_en: "Mozzarella",
    name_ar: "موتزاريلا", price_delta: 0, is_default: true, is_available: true, sort_order: 1,
  });
  await db.insert(schema.menuItemModifierGroups).values({
    menu_item_id: item.id, modifier_group_id: group.id, sort_order: 1,
  });
});

afterAll(async () => { await pg.close(); });

describe("restaurant.model", () => {
  it("returns the branch, four tables, stations, bilingual menu, variants and modifiers", async () => {
    const model = await caller.model();
    expect(model).toHaveLength(1);
    expect(model[0].name_ar).toBe("فورنو");
    expect(model[0].diningAreas[0].tables).toHaveLength(4);
    expect(model[0].kitchenStations[0].code).toBe("PIZZA");
    const item = model[0].menuCategories[0].menuItems[0];
    expect(item.base_price).toBe(12000);
    expect(item.variants[0].price).toBe(18000);
    expect(item.modifierGroups[0].modifierGroup.options[0].code).toBe("MOZZARELLA");
  });
});
