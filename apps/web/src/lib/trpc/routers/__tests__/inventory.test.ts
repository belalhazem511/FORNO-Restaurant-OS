import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { inventoryRouter } = await import("../inventory");
const { createCallerFactory } = await import("../../init");
const { InventoryConflict, applyCancellationDisposition, issueOrderInventory, menuAvailability, postStockIncrease } = await import("@/lib/inventory/service");
const schema = await import("@/lib/db/schema");

const admin = createCallerFactory(inventoryRouter)({ user: makeUser("inventory-admin") });
const cashier = createCallerFactory(inventoryRouter)({ user: makeUser("inventory-cashier") });
let branchId: number; let foreignBranchId: number; let locationId: number; let categoryId: number; let unitId: number; let ingredientId: number; let menuItemId: number; let modifierId: number; let recipeId: number;
let sequence = 0;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([makeUser("inventory-admin"), makeUser("inventory-cashier")]);
  const [branch, foreign] = await db.insert(schema.branches).values([
    { code: "INV", name_en: "Inventory", name_ar: "المخزون", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "FOREIGN", name_en: "Foreign", name_ar: "فرع آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning(); branchId = branch.id; foreignBranchId = foreign.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: "inventory-admin", branch_id: branchId, role: "admin", is_active: true },
    { user_id: "inventory-cashier", branch_id: branchId, role: "cashier", is_active: true },
  ]);
  const [location] = await db.insert(schema.inventoryLocations).values({ branch_id: branchId, code: "KITCHEN", name_en: "Kitchen", name_ar: "المطبخ", is_active: true }).returning(); locationId = location.id;
  const [category] = await db.insert(schema.ingredientCategories).values({ branch_id: branchId, code: "RAW", name_en: "Raw", name_ar: "خام", is_active: true }).returning(); categoryId = category.id;
  const [unit] = await db.insert(schema.unitsOfMeasure).values({ code: "G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 }).returning(); unitId = unit.id;
  const [ingredient] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: categoryId, sku: "CHEESE", name_en: "Cheese", name_ar: "جبن", base_unit_id: unitId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 1_000_000, low_stock_threshold: 2_000_000, par_level: 10_000_000, allow_negative: true, average_unit_cost_micros: 0, created_by: "inventory-admin", updated_by: "inventory-admin" }).returning(); ingredientId = ingredient.id;
  const [station] = await db.insert(schema.kitchenStations).values({ branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", is_active: true }).returning();
  const [menuCategory] = await db.insert(schema.menuCategories).values({ branch_id: branchId, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", sort_order: 1, is_active: true }).returning();
  const [menuItem] = await db.insert(schema.menuItems).values({ category_id: menuCategory.id, kitchen_station_id: station.id, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا", base_price: 10_000, is_available: true, sort_order: 1 }).returning(); menuItemId = menuItem.id;
  const [group] = await db.insert(schema.modifierGroups).values({ branch_id: branchId, code: "EXTRA", name_en: "Extra", name_ar: "إضافي", min_selections: 0, max_selections: 1, sort_order: 1, is_active: true }).returning();
  const [modifier] = await db.insert(schema.modifierOptions).values({ modifier_group_id: group.id, code: "EXTRA-CHEESE", name_en: "Extra cheese", name_ar: "جبن إضافي", price_delta: 1000, is_default: false, is_available: true, sort_order: 1 }).returning(); modifierId = modifier.id;
  await db.insert(schema.menuItemModifierGroups).values({ menu_item_id: menuItemId, modifier_group_id: group.id, sort_order: 1 });
  const [recipe] = await db.insert(schema.recipeVersions).values({ branch_id: branchId, menu_item_id: menuItemId, variant_id: null, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "inventory-admin", approved_by: "inventory-admin", approved_at: new Date() }).returning(); recipeId = recipe.id;
  await db.insert(schema.recipeComponents).values([
    { recipe_version_id: recipeId, ingredient_id: ingredientId, source_location_id: locationId, modifier_option_id: null, unit_id: unitId, quantity_input_scaled: 100_000, quantity_base: 100_000_000 },
    { recipe_version_id: recipeId, ingredient_id: ingredientId, source_location_id: locationId, modifier_option_id: modifierId, unit_id: unitId, quantity_input_scaled: 20_000, quantity_base: 20_000_000 },
  ]);
});

afterAll(async () => pg.close());

async function pendingOrder(quantity = 1, withModifier = false) {
  const [order] = await db.insert(schema.orders).values({ branch_id: branchId, client_request_id: `inventory-order-${++sequence}`, order_type: "takeaway", subtotal_amount: 10_000 * quantity, discount_value: 0, discount_amount: 0, total_amount: 10_000 * quantity, payment_status: "unpaid", status: "pending", user_uid: "inventory-admin" }).returning();
  const [item] = await db.insert(schema.orderItems).values({ order_id: order.id, menu_item_id: menuItemId, variant_id: null, quantity, price: 10_000 }).returning();
  if (withModifier) await db.insert(schema.orderItemModifiers).values({ order_item_id: item.id, modifier_option_id: modifierId, name_en: "Extra cheese", name_ar: "جبن إضافي", price_delta: 1000 });
  return { order, item };
}

describe("inventory ledger, recipes, and order consumption", () => {
  it("posts idempotent opening balances and exact moving weighted-average cost", async () => {
    const opening = await db.transaction((tx) => postStockIncrease(tx, { branchId, locationId, ingredientId, quantityBase: 1_000_000_000, unitCostMicros: 10_000, actorUserId: "inventory-admin", idempotencyKey: "opening-cheese", movementType: "opening_balance", reason: "Opening stock" }));
    const duplicate = await db.transaction((tx) => postStockIncrease(tx, { branchId, locationId, ingredientId, quantityBase: 9_000_000_000, unitCostMicros: 99_000, actorUserId: "inventory-admin", idempotencyKey: "opening-cheese", movementType: "opening_balance", reason: "Retry" }));
    expect(duplicate.id).toBe(opening.id);
    await db.transaction((tx) => postStockIncrease(tx, { branchId, locationId, ingredientId, quantityBase: 1_000_000_000, unitCostMicros: 20_000, actorUserId: "inventory-admin", idempotencyKey: "adjust-cheese", movementType: "manual_positive", reason: "Trusted purchase-free adjustment" }));
    const balance = await db.query.stockBalances.findFirst({ where: and(eq(schema.stockBalances.ingredient_id, ingredientId), eq(schema.stockBalances.location_id, locationId)) });
    expect(balance?.quantity_base).toBe(2_000_000_000);
    expect(balance?.average_unit_cost_micros).toBe(15_000);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(2);
  });

  it("deducts base, modifier, and multi-quantity recipes exactly once and snapshots COGS", async () => {
    const { order, item } = await pendingOrder(2, true);
    const first = await db.transaction((tx) => issueOrderInventory(tx, { orderId: order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${order.id}` }));
    const retry = await db.transaction((tx) => issueOrderInventory(tx, { orderId: order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${order.id}` }));
    expect(retry.id).toBe(first.id);
    const snapshots = await db.select().from(schema.orderInventoryConsumptions).where(eq(schema.orderInventoryConsumptions.order_id, order.id));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].quantity_base).toBe(240_000_000);
    const cogs = await db.query.orderItemCogs.findFirst({ where: eq(schema.orderItemCogs.order_item_id, item.id) });
    expect(cogs?.recipe_version_id).toBe(recipeId);
    expect(cogs?.total_cogs_amount).toBe(3_600);
    expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, order.id) }))?.total_cogs_amount).toBe(3_600);
    expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.order_id, order.id)))).toHaveLength(1);
  });

  it("allows a modifier to replace a base ingredient with an exact zero final quantity", async () => {
    const [replaced] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: categoryId, sku: `REPLACED-${++sequence}`, name_en: "Replaced ingredient", name_ar: "مكون مستبدل", base_unit_id: unitId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "inventory-admin", updated_by: "inventory-admin" }).returning();
    await db.insert(schema.recipeComponents).values([
      { recipe_version_id: recipeId, ingredient_id: replaced.id, source_location_id: locationId, modifier_option_id: null, unit_id: unitId, quantity_input_scaled: 50_000, quantity_base: 50_000_000 },
      { recipe_version_id: recipeId, ingredient_id: replaced.id, source_location_id: locationId, modifier_option_id: modifierId, unit_id: unitId, quantity_input_scaled: -50_000, quantity_base: -50_000_000 },
    ]);
    await db.transaction((tx) => postStockIncrease(tx, { branchId, locationId, ingredientId: replaced.id, quantityBase: 1_000_000_000, unitCostMicros: 5_000, actorUserId: "inventory-admin", idempotencyKey: `opening-replaced:${replaced.id}`, movementType: "opening_balance", reason: "Replacement test stock" }));
    const { order } = await pendingOrder(1, true);
    await db.transaction((tx) => issueOrderInventory(tx, { orderId: order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${order.id}` }));
    expect(await db.select().from(schema.orderInventoryConsumptions).where(and(eq(schema.orderInventoryConsumptions.order_id, order.id), eq(schema.orderInventoryConsumptions.ingredient_id, replaced.id)))).toHaveLength(0);
    expect(await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.order_id, order.id), eq(schema.stockMovements.ingredient_id, replaced.id)))).toHaveLength(0);
  });

  it("keeps historical recipe and COGS snapshots immutable after recipe and cost changes", async () => {
    const prior = await db.query.orderItemCogs.findFirst({ orderBy: (rows, { desc }) => [desc(rows.id)] });
    const originalComponents = await db.select().from(schema.recipeComponents).where(eq(schema.recipeComponents.recipe_version_id, recipeId));
    await db.update(schema.recipeComponents).set({ quantity_base: 999_000_000 }).where(eq(schema.recipeComponents.recipe_version_id, recipeId));
    await db.update(schema.ingredients).set({ average_unit_cost_micros: 999_000 }).where(eq(schema.ingredients.id, ingredientId));
    const unchanged = await db.query.orderItemCogs.findFirst({ where: eq(schema.orderItemCogs.id, prior!.id) });
    expect(unchanged).toEqual(prior);
    for (const component of originalComponents) await db.update(schema.recipeComponents).set({ quantity_base: component.quantity_base }).where(eq(schema.recipeComponents.id, component.id));
  });

  it("blocks insufficient stock, then permits an explicit audited negative override", async () => {
    const balance = await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) });
    await db.update(schema.stockBalances).set({ quantity_base: 10_000_000 }).where(eq(schema.stockBalances.id, balance!.id));
    const { order } = await pendingOrder(1);
    await expect(db.transaction((tx) => issueOrderInventory(tx, { orderId: order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${order.id}` }))).rejects.toBeInstanceOf(InventoryConflict);
    const issue = await db.transaction((tx) => issueOrderInventory(tx, { orderId: order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${order.id}`, allowNegative: true, overrideReason: "Manager honors prepared sale" }));
    expect(issue.order_id).toBe(order.id);
    expect((await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.id, balance!.id) }))!.quantity_base).toBeLessThan(0);
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.order_id, order.id))).some((row) => row.action === "inventory.negative_override")).toBe(true);
    const overview = await admin.overview({ branchId });
    expect(overview.outOfStock).toBeGreaterThan(0);
    expect(overview.valuation).toBeNumber();
  });

  it("serializes concurrent confirmation so stock cannot be oversold", async () => {
    await db.update(schema.stockBalances).set({ quantity_base: 150_000_000 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const first = await pendingOrder(); const second = await pendingOrder();
    const results = await Promise.allSettled([
      db.transaction((tx) => issueOrderInventory(tx, { orderId: first.order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${first.order.id}` })),
      db.transaction((tx) => issueOrderInventory(tx, { orderId: second.order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${second.order.id}` })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const issues = await db.select().from(schema.orderInventoryIssues);
    expect(issues.filter((issue) => issue.order_id === first.order.id || issue.order_id === second.order.id)).toHaveLength(1);
    expect((await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))?.quantity_base).toBe(50_000_000);
  });

  it("requires explicit cancellation disposition and records exact return or zero-effect waste", async () => {
    const pending = await pendingOrder();
    const movementCount = (await db.select().from(schema.stockMovements)).length;
    expect(await db.transaction((tx) => applyCancellationDisposition(tx, { orderId: pending.order.id, actorUserId: "inventory-admin", disposition: "returned_unused", reason: "Cancelled before production", idempotencyKey: `cancel:${pending.order.id}` }))).toBeNull();
    expect(await db.select().from(schema.stockMovements)).toHaveLength(movementCount);
    await db.update(schema.stockBalances).set({ quantity_base: 1_000_000_000 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const returned = await pendingOrder(); await db.transaction((tx) => issueOrderInventory(tx, { orderId: returned.order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${returned.order.id}` }));
    const beforeReturn = (await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))!.quantity_base;
    await db.transaction((tx) => applyCancellationDisposition(tx, { orderId: returned.order.id, actorUserId: "inventory-admin", disposition: "returned_unused", reason: "Never prepared", idempotencyKey: `cancel:${returned.order.id}` }));
    expect((await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))!.quantity_base).toBeGreaterThan(beforeReturn);
    const waste = await pendingOrder(); await db.transaction((tx) => issueOrderInventory(tx, { orderId: waste.order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${waste.order.id}` }));
    const beforeWaste = (await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))!.quantity_base;
    await db.transaction((tx) => applyCancellationDisposition(tx, { orderId: waste.order.id, actorUserId: "inventory-admin", disposition: "prepared_discarded", reason: "Prepared food discarded", idempotencyKey: `cancel:${waste.order.id}` }));
    expect((await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))!.quantity_base).toBe(beforeWaste);
    expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.order_id, waste.order.id))).some((row) => row.movement_type === "waste_discard" && row.direction === 0)).toBe(true);
  });

  it("does not restore prepared ingredients for a financial refund or reversal", async () => {
    await db.update(schema.stockBalances).set({ quantity_base: 1_000_000_000 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const issued = await pendingOrder();
    await db.transaction((tx) => issueOrderInventory(tx, { orderId: issued.order.id, actorUserId: "inventory-admin", idempotencyKey: `confirm:${issued.order.id}` }));
    const before = await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) });
    const movementCount = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.order_id, issued.order.id))).length;
    await db.update(schema.orders).set({ payment_status: "refunded" }).where(eq(schema.orders.id, issued.order.id));
    expect((await db.query.stockBalances.findFirst({ where: eq(schema.stockBalances.ingredient_id, ingredientId) }))?.quantity_base).toBe(before?.quantity_base);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.order_id, issued.order.id))).toHaveLength(movementCount);
  });

  it("reports low/out availability and enforces permission and branch isolation", async () => {
    await db.update(schema.stockBalances).set({ quantity_base: 0 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const availability = await db.transaction((tx) => menuAvailability(tx, branchId));
    expect(availability.find((row) => row.menuItemId === menuItemId)?.status).toBe("unavailable");
    expect((await cashier.availability({ branchId })).find((row) => row.menuItemId === menuItemId)?.theoreticalCost).toBeNull();
    await expect(cashier.overview({ branchId })).rejects.toThrow();
    await expect(cashier.createIngredient({ branchId, categoryId, sku: "DENIED", nameEn: "Denied", nameAr: "مرفوض", baseUnitId: unitId, dimension: "mass", defaultLocationId: locationId, tracked: true, reorderLevel: 0, lowStockThreshold: 0, allowNegative: false })).rejects.toThrow();
    await expect(admin.ingredients({ branchId: foreignBranchId })).rejects.toThrow();
  });

  it("validates recipe dimensions, ambiguity, and active version uniqueness", async () => {
    await expect(admin.createRecipe({ branchId, menuItemId, variantId: null, yieldLossBps: 0, components: [
      { ingredientId, locationId, unitId, quantityScaled: 1_000 },
      { ingredientId, locationId, unitId, quantityScaled: 2_000 },
    ] })).rejects.toThrow("Duplicate ambiguous");
    const [volumeUnit] = await db.insert(schema.unitsOfMeasure).values({ code: "ML", name_en: "Millilitre", name_ar: "مليلتر", dimension: "volume", base_numerator: 1, base_denominator: 1 }).returning();
    await expect(admin.createRecipe({ branchId, menuItemId, variantId: null, yieldLossBps: 0, components: [{ ingredientId, locationId, unitId: volumeUnit.id, quantityScaled: 1_000 }] })).rejects.toThrow("Cannot convert volume to mass");
    expect((await db.select().from(schema.recipeVersions).where(and(eq(schema.recipeVersions.menu_item_id, menuItemId), eq(schema.recipeVersions.status, "active"))))).toHaveLength(1);
    const draft = await admin.createRecipe({ branchId, menuItemId, variantId: null, yieldLossBps: 100, components: [{ ingredientId, locationId, unitId, quantityScaled: 110_000 }] });
    const active = await admin.activateRecipe({ branchId, recipeVersionId: draft.id, reason: "Approved after kitchen yield review" });
    expect(active.version).toBe(2);
    expect(active.status).toBe("active");
    expect((await db.select().from(schema.recipeVersions).where(and(eq(schema.recipeVersions.menu_item_id, menuItemId), eq(schema.recipeVersions.status, "active"))))).toHaveLength(1);
    expect((await db.select().from(schema.auditLogs)).some((row) => row.action === "recipe.activate" && row.reason === "Approved after kitchen yield review")).toBe(true);
  });

  it("returns exact recipe shortages for modifier configurations without exposing costs to cashiers", async () => {
    const active = await db.query.recipeVersions.findFirst({ where: and(eq(schema.recipeVersions.menu_item_id, menuItemId), eq(schema.recipeVersions.status, "active")) });
    await db.insert(schema.recipeComponents).values({ recipe_version_id: active!.id, ingredient_id: ingredientId, source_location_id: locationId, modifier_option_id: modifierId, unit_id: unitId, quantity_input_scaled: 20_000, quantity_base: 20_000_000 });
    await db.update(schema.stockBalances).set({ quantity_base: 300_000_000 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const rows = await db.transaction((tx) => menuAvailability(tx, branchId, {
      configurations: [{ menuItemId, variantId: null, modifierOptionIds: [modifierId], quantity: 3 }],
      includeInventoryDetails: true,
    }));
    const configured = rows.find((row) => row.menuItemId === menuItemId && row.modifierOptionIds.includes(modifierId));
    expect(configured?.status).toBe("unavailable");
    expect(configured?.maxProducibleQuantity).toBe(2);
    expect(configured?.blockingIngredients).toEqual([expect.objectContaining({ ingredientId, requiredQuantity: 393_939_394, availableQuantity: 300_000_000, shortageQuantity: 93_939_394, unit: "G", sourceLocationEn: "Kitchen" })]);
    const cashierRows = await cashier.availability({ branchId, configurations: [{ menuItemId, variantId: null, modifierOptionIds: [modifierId], quantity: 3 }] });
    const cashierResult = cashierRows.find((row) => row.menuItemId === menuItemId && row.modifierOptionIds.includes(modifierId));
    expect(cashierResult?.blockingIngredients[0]?.nameEn).toBe("Cheese");
    expect("unit" in (cashierResult?.blockingIngredients[0] ?? {})).toBe(false);
    expect(cashierResult?.theoreticalCost).toBeNull();

    const [packaging] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: categoryId, sku: "PACKAGING", name_en: "Packaging", name_ar: "تغليف", base_unit_id: unitId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "inventory-admin", updated_by: "inventory-admin" }).returning();
    await db.insert(schema.stockBalances).values({ branch_id: branchId, location_id: locationId, ingredient_id: packaging.id, quantity_base: 0, average_unit_cost_micros: 0 });
    await db.insert(schema.recipeComponents).values({ recipe_version_id: active!.id, ingredient_id: packaging.id, source_location_id: locationId, modifier_option_id: null, unit_id: unitId, quantity_input_scaled: 5_000, quantity_base: 5_000_000 });
    const packagingResult = (await db.transaction((tx) => menuAvailability(tx, branchId))).find((row) => row.menuItemId === menuItemId && row.variantId == null)!;
    expect(packagingResult.blockingIngredients.some((ingredient) => ingredient.nameEn === "Packaging" && ingredient.shortageQuantity === 5_050_505)).toBe(true);

    const [variant] = await db.insert(schema.menuItemVariants).values({ menu_item_id: menuItemId, code: "LOW", name_en: "Low stock variant", name_ar: "حجم قليل", price: 12_000, is_default: false, is_available: true, sort_order: 9 }).returning();
    const [variantRecipe] = await db.insert(schema.recipeVersions).values({ branch_id: branchId, menu_item_id: menuItemId, variant_id: variant.id, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "inventory-admin", approved_by: "inventory-admin", approved_at: new Date() }).returning();
    const [variantIngredient] = await db.insert(schema.ingredients).values({ branch_id: branchId, category_id: categoryId, sku: "VARIANT-SHORT", name_en: "Variant ingredient", name_ar: "مكون الحجم", base_unit_id: unitId, dimension: "mass", default_location_id: locationId, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "inventory-admin", updated_by: "inventory-admin" }).returning();
    await db.insert(schema.stockBalances).values({ branch_id: branchId, location_id: locationId, ingredient_id: variantIngredient.id, quantity_base: 0, average_unit_cost_micros: 0 });
    await db.insert(schema.recipeComponents).values({ recipe_version_id: variantRecipe.id, ingredient_id: variantIngredient.id, source_location_id: locationId, modifier_option_id: null, unit_id: unitId, quantity_input_scaled: 20_000, quantity_base: 20_000_000 });
    const variantResult = (await db.transaction((tx) => menuAvailability(tx, branchId))).find((row) => row.menuItemId === menuItemId && row.variantId === variant.id)!;
    expect(variantResult.status).toBe("unavailable");
    expect(variantResult.blockingIngredients[0]?.nameEn).toBe("Variant ingredient");
  });

  it("reports missing recipes and manual disablement as distinct availability states", async () => {
    const [withoutRecipe] = await db.insert(schema.menuItems).values({ category_id: (await db.query.menuItems.findFirst({ where: eq(schema.menuItems.id, menuItemId) }))!.category_id, kitchen_station_id: (await db.query.menuItems.findFirst({ where: eq(schema.menuItems.id, menuItemId) }))!.kitchen_station_id, code: "NO-RECIPE", name_en: "No recipe", name_ar: "بلا وصفة", base_price: 100, is_available: true, sort_order: 2 }).returning();
    const rows = await db.transaction((tx) => menuAvailability(tx, branchId));
    expect(rows.find((row) => row.menuItemId === withoutRecipe.id)?.status).toBe("recipe_missing");
    await db.update(schema.menuItems).set({ is_available: false }).where(eq(schema.menuItems.id, menuItemId));
    expect((await db.transaction((tx) => menuAvailability(tx, branchId))).find((row) => row.menuItemId === menuItemId)?.status).toBe("manually_disabled");
  });

  it("accounts for shared ingredient demand across all configured cart lines", async () => {
    await db.update(schema.menuItems).set({ is_available: true }).where(eq(schema.menuItems.id, menuItemId));
    const original = (await db.query.menuItems.findFirst({ where: eq(schema.menuItems.id, menuItemId) }))!;
    const [secondItem] = await db.insert(schema.menuItems).values({ category_id: original.category_id, kitchen_station_id: original.kitchen_station_id, code: "SHARED-STOCK", name_en: "Shared stock item", name_ar: "صنف مخزون مشترك", base_price: 100, is_available: true, sort_order: 20 }).returning();
    const [secondRecipe] = await db.insert(schema.recipeVersions).values({ branch_id: branchId, menu_item_id: secondItem.id, variant_id: null, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "inventory-admin", approved_by: "inventory-admin", approved_at: new Date() }).returning();
    await db.insert(schema.recipeComponents).values({ recipe_version_id: secondRecipe.id, ingredient_id: ingredientId, source_location_id: locationId, modifier_option_id: null, unit_id: unitId, quantity_input_scaled: 100_000, quantity_base: 100_000_000 });
    await db.update(schema.stockBalances).set({ quantity_base: 150_000_000 }).where(eq(schema.stockBalances.ingredient_id, ingredientId));
    const packageIngredient = await db.query.ingredients.findFirst({ where: eq(schema.ingredients.sku, "PACKAGING") });
    await db.update(schema.stockBalances).set({ quantity_base: 10_000_000 }).where(eq(schema.stockBalances.ingredient_id, packageIngredient!.id));
    const requested = await db.transaction((tx) => menuAvailability(tx, branchId, { configurations: [
      { menuItemId, variantId: null }, { menuItemId: secondItem.id, variantId: null },
    ] }));
    const firstDemand = requested.find((row) => row.menuItemId === menuItemId && row.variantId === null && row.status === "unavailable");
    const secondDemand = requested.find((row) => row.menuItemId === secondItem.id && row.variantId === null && row.status === "unavailable");
    expect(firstDemand?.status).toBe("unavailable");
    expect(secondDemand?.status).toBe("unavailable");
    expect(firstDemand?.blockingIngredients.find((entry) => entry.ingredientId === ingredientId)?.requiredQuantity).toBe(211_111_111);
  });
});
