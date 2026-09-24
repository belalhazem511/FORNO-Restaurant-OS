import { and, eq, isNull } from "drizzle-orm";
import { db } from "..";
import {
  ingredientCategories,
  ingredientPackageConversions,
  ingredients,
  inventoryLocations,
  menuItems,
  menuItemVariants,
  modifierOptions,
  recipeComponents,
  recipeVersions,
  unitsOfMeasure,
} from "../schema";
import { convertScaledQuantity, parseDecimalToScaled } from "@/lib/inventory/exact";
import { postStockIncrease } from "@/lib/inventory/service";

type Dimension = "mass" | "volume" | "count";

const unitSeeds: Array<{ code: string; name_en: string; name_ar: string; dimension: Dimension; base_numerator: number; base_denominator: number }> = [
  { code: "MG", name_en: "Milligram", name_ar: "مليجرام", dimension: "mass", base_numerator: 1, base_denominator: 1 },
  { code: "G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 },
  { code: "KG", name_en: "Kilogram", name_ar: "كيلوجرام", dimension: "mass", base_numerator: 1_000_000, base_denominator: 1 },
  { code: "ML", name_en: "Millilitre", name_ar: "مليلتر", dimension: "volume", base_numerator: 1, base_denominator: 1 },
  { code: "L", name_en: "Litre", name_ar: "لتر", dimension: "volume", base_numerator: 1_000, base_denominator: 1 },
  { code: "PC", name_en: "Piece", name_ar: "قطعة", dimension: "count", base_numerator: 1, base_denominator: 1 },
];

const locationSeeds = [
  { code: "MAIN_STORE", name_en: "Main Store", name_ar: "المخزن الرئيسي" },
  { code: "PIZZA_KITCHEN", name_en: "Pizza Kitchen", name_ar: "مطبخ البيتزا" },
  { code: "DONER_KITCHEN", name_en: "Doner Kitchen", name_ar: "مطبخ الدونر" },
  { code: "CAFE_BAR", name_en: "Cafe Bar", name_ar: "بار الكافيه" },
];

const categorySeeds = [
  { code: "DRY", name_en: "Dry goods", name_ar: "مواد جافة" },
  { code: "DAIRY", name_en: "Dairy", name_ar: "ألبان" },
  { code: "MEAT", name_en: "Meat", name_ar: "لحوم" },
  { code: "PRODUCE", name_en: "Produce", name_ar: "خضروات وفاكهة" },
  { code: "SAUCE", name_en: "Sauces", name_ar: "صلصات" },
  { code: "BEVERAGE", name_en: "Beverage ingredients", name_ar: "مكونات المشروبات" },
  { code: "PACKAGING", name_en: "Packaging", name_ar: "عبوات وتغليف" },
];

const ingredientSeeds: Array<{
  sku: string; name_en: string; name_ar: string; category: string; baseUnit: "MG" | "ML" | "PC"; dimension: Dimension;
  location: string; openingUnit: "KG" | "L" | "PC"; opening: string; lowUnit: "KG" | "L" | "PC"; low: string;
  unitCostMicros: number; package?: { code: string; name_en: string; name_ar: string; numerator: number };
}> = [
  { sku: "FLOUR-00", name_en: "Pizza flour 00", name_ar: "دقيق بيتزا 00", category: "DRY", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "20", lowUnit: "KG", low: "3", unitCostMicros: 4_000, package: { code: "BAG-25KG", name_en: "25 kg bag", name_ar: "شيكارة 25 كجم", numerator: 25_000_000 } },
  { sku: "PIZZA-SAUCE", name_en: "Pizza sauce", name_ar: "صلصة بيتزا", category: "SAUCE", baseUnit: "ML", dimension: "volume", location: "PIZZA_KITCHEN", openingUnit: "L", opening: "12", lowUnit: "L", low: "2", unitCostMicros: 6_000_000, package: { code: "CAN-3L", name_en: "3 litre can", name_ar: "عبوة 3 لتر", numerator: 3_000 } },
  { sku: "MOZZARELLA", name_en: "Mozzarella", name_ar: "موتزاريلا", category: "DAIRY", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "12", lowUnit: "KG", low: "2", unitCostMicros: 18_000 },
  { sku: "CHEDDAR", name_en: "Cheddar", name_ar: "شيدر", category: "DAIRY", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "6", lowUnit: "KG", low: "1", unitCostMicros: 16_000 },
  { sku: "PEPPERONI", name_en: "Pepperoni", name_ar: "بيبروني", category: "MEAT", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "6", lowUnit: "KG", low: "1", unitCostMicros: 28_000 },
  { sku: "MUSHROOM", name_en: "Mushroom", name_ar: "مشروم", category: "PRODUCE", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "5", lowUnit: "KG", low: "0.75", unitCostMicros: 9_000 },
  { sku: "OLIVES", name_en: "Olives", name_ar: "زيتون", category: "PRODUCE", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "4", lowUnit: "KG", low: "0.5", unitCostMicros: 12_000 },
  { sku: "JALAPENO", name_en: "Jalapeno", name_ar: "هالبينو", category: "PRODUCE", baseUnit: "MG", dimension: "mass", location: "PIZZA_KITCHEN", openingUnit: "KG", opening: "3", lowUnit: "KG", low: "0.5", unitCostMicros: 10_000 },
  { sku: "PIZZA-BOX", name_en: "Pizza box", name_ar: "علبة بيتزا", category: "PACKAGING", baseUnit: "PC", dimension: "count", location: "PIZZA_KITCHEN", openingUnit: "PC", opening: "250", lowUnit: "PC", low: "40", unitCostMicros: 150_000_000, package: { code: "CARTON-50", name_en: "Carton of 50", name_ar: "كرتونة 50", numerator: 50 } },
  { sku: "CHICKEN-DONER", name_en: "Chicken doner meat", name_ar: "لحم دونر فراخ", category: "MEAT", baseUnit: "MG", dimension: "mass", location: "DONER_KITCHEN", openingUnit: "KG", opening: "15", lowUnit: "KG", low: "2", unitCostMicros: 22_000 },
  { sku: "BEEF-DONER", name_en: "Beef doner meat", name_ar: "لحم دونر بقري", category: "MEAT", baseUnit: "MG", dimension: "mass", location: "DONER_KITCHEN", openingUnit: "KG", opening: "12", lowUnit: "KG", low: "2", unitCostMicros: 30_000 },
  { sku: "DONER-BREAD", name_en: "Doner bread", name_ar: "خبز دونر", category: "DRY", baseUnit: "PC", dimension: "count", location: "DONER_KITCHEN", openingUnit: "PC", opening: "200", lowUnit: "PC", low: "30", unitCostMicros: 180_000_000, package: { code: "TRAY-20", name_en: "Tray of 20", name_ar: "صينية 20", numerator: 20 } },
  { sku: "DONER-VEG", name_en: "Doner vegetables", name_ar: "خضار دونر", category: "PRODUCE", baseUnit: "MG", dimension: "mass", location: "DONER_KITCHEN", openingUnit: "KG", opening: "10", lowUnit: "KG", low: "1.5", unitCostMicros: 5_000 },
  { sku: "DONER-SAUCE", name_en: "Doner sauce", name_ar: "صوص دونر", category: "SAUCE", baseUnit: "ML", dimension: "volume", location: "DONER_KITCHEN", openingUnit: "L", opening: "10", lowUnit: "L", low: "1.5", unitCostMicros: 5_500_000 },
  { sku: "WRAP-PAPER", name_en: "Sandwich wrap", name_ar: "ورق تغليف ساندوتش", category: "PACKAGING", baseUnit: "PC", dimension: "count", location: "DONER_KITCHEN", openingUnit: "PC", opening: "300", lowUnit: "PC", low: "50", unitCostMicros: 60_000_000 },
  { sku: "COFFEE-BEAN", name_en: "Coffee beans", name_ar: "حبوب قهوة", category: "BEVERAGE", baseUnit: "MG", dimension: "mass", location: "CAFE_BAR", openingUnit: "KG", opening: "8", lowUnit: "KG", low: "1", unitCostMicros: 38_000, package: { code: "BAG-1KG", name_en: "1 kg bag", name_ar: "كيس 1 كجم", numerator: 1_000_000 } },
  { sku: "MILK", name_en: "Milk", name_ar: "حليب", category: "DAIRY", baseUnit: "ML", dimension: "volume", location: "CAFE_BAR", openingUnit: "L", opening: "30", lowUnit: "L", low: "5", unitCostMicros: 4_500_000, package: { code: "CARTON-12L", name_en: "Carton of 12 litres", name_ar: "كرتونة 12 لتر", numerator: 12_000 } },
  { sku: "LEMON", name_en: "Lemon juice", name_ar: "عصير ليمون", category: "BEVERAGE", baseUnit: "ML", dimension: "volume", location: "CAFE_BAR", openingUnit: "L", opening: "12", lowUnit: "L", low: "2", unitCostMicros: 7_000_000 },
  { sku: "MINT", name_en: "Mint", name_ar: "نعناع", category: "PRODUCE", baseUnit: "MG", dimension: "mass", location: "CAFE_BAR", openingUnit: "KG", opening: "2", lowUnit: "KG", low: "0.3", unitCostMicros: 8_000 },
  { sku: "SUGAR", name_en: "Sugar", name_ar: "سكر", category: "DRY", baseUnit: "MG", dimension: "mass", location: "CAFE_BAR", openingUnit: "KG", opening: "10", lowUnit: "KG", low: "1.5", unitCostMicros: 3_000 },
  { sku: "CAFE-CUP", name_en: "Cafe cup and lid", name_ar: "كوب وغطاء", category: "PACKAGING", baseUnit: "PC", dimension: "count", location: "CAFE_BAR", openingUnit: "PC", opening: "400", lowUnit: "PC", low: "60", unitCostMicros: 110_000_000, package: { code: "BOX-50", name_en: "Box of 50", name_ar: "علبة 50", numerator: 50 } },
];

type ComponentSeed = { sku: string; unit: string; quantity: string; modifier?: string };

export async function seedInventory(branchId: number, userId: string) {
  for (const unit of unitSeeds) await db.insert(unitsOfMeasure).values(unit).onConflictDoNothing();
  for (const location of locationSeeds) await db.insert(inventoryLocations).values({ branch_id: branchId, ...location }).onConflictDoNothing();
  for (const category of categorySeeds) await db.insert(ingredientCategories).values({ branch_id: branchId, ...category }).onConflictDoNothing();

  const units = await db.select().from(unitsOfMeasure);
  const locations = await db.select().from(inventoryLocations).where(eq(inventoryLocations.branch_id, branchId));
  const categories = await db.select().from(ingredientCategories).where(eq(ingredientCategories.branch_id, branchId));
  const unitByCode = new Map(units.map((row) => [row.code, row]));
  const locationByCode = new Map(locations.map((row) => [row.code, row]));
  const categoryByCode = new Map(categories.map((row) => [row.code, row]));

  for (const seed of ingredientSeeds) {
    const lowUnit = unitByCode.get(seed.lowUnit)!;
    const low = convertScaledQuantity({ quantityScaled: parseDecimalToScaled(seed.low), fromDimension: seed.dimension, toDimension: seed.dimension, factor: { numerator: lowUnit.base_numerator, denominator: lowUnit.base_denominator } });
    await db.insert(ingredients).values({
      branch_id: branchId, category_id: categoryByCode.get(seed.category)!.id, sku: seed.sku, name_en: seed.name_en, name_ar: seed.name_ar,
      base_unit_id: unitByCode.get(seed.baseUnit)!.id, dimension: seed.dimension, default_location_id: locationByCode.get(seed.location)!.id,
      is_active: true, is_tracked: true, reorder_level: low, low_stock_threshold: low, par_level: low * 3, allow_negative: true,
      average_unit_cost_micros: 0, created_by: userId, updated_by: userId,
    }).onConflictDoNothing();
  }
  const ingredientRows = await db.select().from(ingredients).where(eq(ingredients.branch_id, branchId));
  const ingredientBySku = new Map(ingredientRows.map((row) => [row.sku, row]));

  for (const seed of ingredientSeeds) {
    const ingredient = ingredientBySku.get(seed.sku)!;
    const openingUnit = unitByCode.get(seed.openingUnit)!;
    const quantityBase = convertScaledQuantity({ quantityScaled: parseDecimalToScaled(seed.opening), fromDimension: seed.dimension, toDimension: seed.dimension, factor: { numerator: openingUnit.base_numerator, denominator: openingUnit.base_denominator } });
    await db.transaction((tx) => postStockIncrease(tx, {
      branchId, locationId: ingredient.default_location_id, ingredientId: ingredient.id, quantityBase, unitCostMicros: seed.unitCostMicros,
      actorUserId: userId, idempotencyKey: `seed-opening:${branchId}:${seed.sku}`, movementType: "opening_balance", reason: "Deterministic FORNO opening stock",
    }));
    if (seed.package) await db.insert(ingredientPackageConversions).values({ ingredient_id: ingredient.id, code: seed.package.code, name_en: seed.package.name_en, name_ar: seed.package.name_ar, base_numerator: seed.package.numerator, base_denominator: 1, is_active: true }).onConflictDoNothing();
  }

  const menu = await db.query.menuItems.findMany({ with: { category: true, variants: true } });
  const branchMenu = menu.filter((item) => item.category.branch_id === branchId);
  const itemByCode = new Map(branchMenu.map((item) => [item.code, item]));
  const options = await db.query.modifierOptions.findMany({ with: { group: true } });
  const optionByCode = new Map(options.filter((option) => option.group.branch_id === branchId).map((option) => [option.code, option]));

  const pizzaComponents = (size: "S" | "M" | "L", topping?: string): ComponentSeed[] => {
    const amounts = { S: [180, 70, 90], M: [250, 100, 130], L: [330, 130, 170] }[size];
    const base: ComponentSeed[] = [
      { sku: "FLOUR-00", unit: "G", quantity: String(amounts[0]) }, { sku: "PIZZA-SAUCE", unit: "ML", quantity: String(amounts[1]) },
      { sku: "MOZZARELLA", unit: "G", quantity: String(amounts[2]) }, { sku: "PIZZA-BOX", unit: "PC", quantity: "1" },
      { sku: "MOZZARELLA", unit: "G", quantity: String(-amounts[2]), modifier: "CHEDDAR" }, { sku: "CHEDDAR", unit: "G", quantity: String(amounts[2]), modifier: "CHEDDAR" },
      { sku: "MOZZARELLA", unit: "G", quantity: String(-Math.floor(amounts[2] / 2)), modifier: "MIX" }, { sku: "CHEDDAR", unit: "G", quantity: String(Math.floor(amounts[2] / 2)), modifier: "MIX" },
      { sku: "MUSHROOM", unit: "G", quantity: "35", modifier: "MUSHROOM" }, { sku: "OLIVES", unit: "G", quantity: "25", modifier: "OLIVES" },
      { sku: "JALAPENO", unit: "G", quantity: "20", modifier: "JALAPENO" }, { sku: "PEPPERONI", unit: "G", quantity: "45", modifier: "EXTRA-MEAT" },
    ];
    if (topping) base.push({ sku: topping, unit: "G", quantity: size === "S" ? "45" : size === "M" ? "65" : "85" });
    return base;
  };
  const recipes: Array<{ item: string; variant?: string; loss: number; components: ComponentSeed[] }> = [];
  for (const item of ["MARGHERITA", "PEPPERONI", "FORNO-SPECIAL"] as const) for (const size of ["S", "M", "L"] as const) {
    recipes.push({ item, variant: size, loss: 200, components: pizzaComponents(size, item === "MARGHERITA" ? undefined : "PEPPERONI") });
  }
  recipes.push(
    { item: "CHICKEN-DONER", loss: 300, components: [{ sku: "CHICKEN-DONER", unit: "G", quantity: "140" }, { sku: "DONER-BREAD", unit: "PC", quantity: "1" }, { sku: "DONER-VEG", unit: "G", quantity: "60" }, { sku: "DONER-SAUCE", unit: "ML", quantity: "35" }, { sku: "WRAP-PAPER", unit: "PC", quantity: "1" }, { sku: "CHICKEN-DONER", unit: "G", quantity: "60", modifier: "LARGE" }, { sku: "CHICKEN-DONER", unit: "G", quantity: "50", modifier: "EXTRA-MEAT" }] },
    { item: "BEEF-DONER", loss: 300, components: [{ sku: "BEEF-DONER", unit: "G", quantity: "140" }, { sku: "DONER-BREAD", unit: "PC", quantity: "1" }, { sku: "DONER-VEG", unit: "G", quantity: "60" }, { sku: "DONER-SAUCE", unit: "ML", quantity: "35" }, { sku: "WRAP-PAPER", unit: "PC", quantity: "1" }, { sku: "BEEF-DONER", unit: "G", quantity: "60", modifier: "LARGE" }, { sku: "BEEF-DONER", unit: "G", quantity: "50", modifier: "EXTRA-MEAT" }] },
    { item: "CAPPUCCINO", loss: 0, components: [{ sku: "COFFEE-BEAN", unit: "G", quantity: "18" }, { sku: "MILK", unit: "ML", quantity: "160" }, { sku: "CAFE-CUP", unit: "PC", quantity: "1" }, { sku: "COFFEE-BEAN", unit: "G", quantity: "4", modifier: "LARGE" }, { sku: "MILK", unit: "ML", quantity: "80", modifier: "LARGE" }] },
    { item: "LATTE", loss: 0, components: [{ sku: "COFFEE-BEAN", unit: "G", quantity: "18" }, { sku: "MILK", unit: "ML", quantity: "220" }, { sku: "CAFE-CUP", unit: "PC", quantity: "1" }, { sku: "COFFEE-BEAN", unit: "G", quantity: "4", modifier: "LARGE" }, { sku: "MILK", unit: "ML", quantity: "100", modifier: "LARGE" }] },
    { item: "LEMON-MINT", loss: 0, components: [{ sku: "LEMON", unit: "ML", quantity: "120" }, { sku: "MINT", unit: "G", quantity: "12" }, { sku: "SUGAR", unit: "G", quantity: "25" }, { sku: "CAFE-CUP", unit: "PC", quantity: "1" }] },
  );

  for (const seed of recipes) {
    const item = itemByCode.get(seed.item)!;
    const variantId = seed.variant ? item.variants.find((variant) => variant.code === seed.variant)!.id : null;
    let recipe = await db.query.recipeVersions.findFirst({ where: and(eq(recipeVersions.menu_item_id, item.id), variantId == null ? isNull(recipeVersions.variant_id) : eq(recipeVersions.variant_id, variantId), eq(recipeVersions.version, 1)) });
    if (!recipe) [recipe] = await db.insert(recipeVersions).values({ branch_id: branchId, menu_item_id: item.id, variant_id: variantId, version: 1, status: "active", effective_at: new Date("2026-01-01T00:00:00Z"), yield_loss_bps: seed.loss, authored_by: userId, approved_by: userId, approved_at: new Date("2026-01-01T00:00:00Z") }).returning();
    const existing = await db.query.recipeComponents.findFirst({ where: eq(recipeComponents.recipe_version_id, recipe.id) });
    if (existing) continue;
    await db.insert(recipeComponents).values(seed.components.map((component) => {
      const ingredient = ingredientBySku.get(component.sku)!;
      const unit = unitByCode.get(component.unit)!;
      const quantityScaled = component.quantity.startsWith("-") ? -parseDecimalToScaled(component.quantity.slice(1)) : parseDecimalToScaled(component.quantity);
      const quantityBase = convertScaledQuantity({ quantityScaled, fromDimension: unit.dimension, toDimension: ingredient.dimension, factor: { numerator: unit.base_numerator, denominator: unit.base_denominator } });
      return { recipe_version_id: recipe.id, ingredient_id: ingredient.id, source_location_id: ingredient.default_location_id, modifier_option_id: component.modifier ? optionByCode.get(component.modifier)!.id : null, unit_id: unit.id, quantity_input_scaled: quantityScaled, quantity_base: quantityBase };
    }));
  }
}
