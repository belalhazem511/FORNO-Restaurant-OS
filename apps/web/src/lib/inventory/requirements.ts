import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingredients, inventoryLocations, menuItems, recipeComponents, recipeVersions, stockBalances, unitsOfMeasure } from "@/lib/db/schema";
import { applyYieldLoss, costMinorForQuantity, multiplyDivide } from "./exact";

export type InventoryConflictCode = "recipe_missing" | "stock_unavailable" | "insufficient_stock" | "invalid_recipe";

export class InventoryConflict extends Error {
  constructor(public readonly code: InventoryConflictCode, message: string, public readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function activeRecipe(tx: Transaction, menuItemId: number, variantId: number | null) {
  const exact = await tx.select().from(recipeVersions).where(and(
    eq(recipeVersions.menu_item_id, menuItemId),
    variantId == null ? isNull(recipeVersions.variant_id) : eq(recipeVersions.variant_id, variantId),
    eq(recipeVersions.status, "active"),
  )).orderBy(desc(recipeVersions.version));
  const fallback = variantId != null && exact.length === 0
    ? await tx.select().from(recipeVersions).where(and(eq(recipeVersions.menu_item_id, menuItemId), isNull(recipeVersions.variant_id), eq(recipeVersions.status, "active"))).orderBy(desc(recipeVersions.version))
    : [];
  const matches = exact.length ? exact : fallback;
  if (matches.length === 0) throw new InventoryConflict("recipe_missing", `No active recipe for menu item ${menuItemId}${variantId ? ` variant ${variantId}` : ""}`);
  if (matches.length > 1) throw new InventoryConflict("invalid_recipe", "Multiple active recipes exist for the same menu configuration");
  return matches[0];
}

export async function resolvedItemComponents(tx: Transaction, item: {
  id: number;
  menu_item_id: number | null;
  variant_id: number | null;
  quantity: number;
  modifiers: Array<{ modifier_option_id: number }>;
}) {
  if (!item.menu_item_id) throw new InventoryConflict("recipe_missing", `Order item ${item.id} has no menu item recipe source`);
  const recipe = await activeRecipe(tx, item.menu_item_id, item.variant_id);
  const components = await tx.select().from(recipeComponents).where(eq(recipeComponents.recipe_version_id, recipe.id));
  const selected = new Set(item.modifiers.map((modifier) => modifier.modifier_option_id));
  const aggregated = new Map<string, { ingredientId: number; locationId: number; quantityBase: number }>();
  for (const component of components) {
    if (component.modifier_option_id != null && !selected.has(component.modifier_option_id)) continue;
    const key = `${component.ingredient_id}:${component.source_location_id}`;
    const current = aggregated.get(key) ?? { ingredientId: component.ingredient_id, locationId: component.source_location_id, quantityBase: 0 };
    current.quantityBase += component.quantity_base;
    if (!Number.isSafeInteger(current.quantityBase)) throw new InventoryConflict("invalid_recipe", "Recipe quantity exceeds exact integer range");
    aggregated.set(key, current);
  }
  if (aggregated.size === 0) throw new InventoryConflict("recipe_missing", `Recipe ${recipe.id} has no applicable components`);
  const finalComponents = [...aggregated.values()];
  if (finalComponents.some((component) => component.quantityBase < 0)) throw new InventoryConflict("invalid_recipe", "Recipe produces a negative final ingredient quantity");
  const result = finalComponents.filter((component) => component.quantityBase > 0).map((component) => ({
    ...component,
    quantityBase: applyYieldLoss(multiplyDivide(component.quantityBase, item.quantity, 1), recipe.yield_loss_bps),
  }));
  if (result.length === 0) throw new InventoryConflict("invalid_recipe", "Recipe produces no consumable ingredients");
  return { recipe, components: result };
}

export type MenuAvailabilityConfiguration = {
  menuItemId: number;
  variantId: number | null;
  modifierOptionIds?: number[];
  quantity?: number;
};

type MenuAvailabilityStatus = "available" | "low_stock" | "unavailable" | "recipe_missing" | "manually_disabled" | "out_of_stock";

export async function menuAvailability(
  tx: Transaction,
  branchId: number,
  options: { configurations?: MenuAvailabilityConfiguration[]; includeInventoryDetails?: boolean } = {},
) {
  const menu = (await tx.query.menuItems.findMany({ with: {
    category: true,
    variants: true,
    modifierGroups: { with: { modifierGroup: { with: { options: true } } } },
  } })).filter((item) => item.category.branch_id === branchId);
  if (menu.length === 0) return [];
  const menuIds = menu.map((item) => item.id);
  const activeRecipes = await tx.select().from(recipeVersions).where(and(
    eq(recipeVersions.branch_id, branchId), eq(recipeVersions.status, "active"), inArray(recipeVersions.menu_item_id, menuIds),
  ));
  const recipeIds = activeRecipes.map((recipe) => recipe.id);
  const components = recipeIds.length ? await tx.select().from(recipeComponents).where(inArray(recipeComponents.recipe_version_id, recipeIds)) : [];
  const ingredientIds = [...new Set(components.map((component) => component.ingredient_id))];
  const locationIds = [...new Set(components.map((component) => component.source_location_id))];
  const [ingredientRows, balances, locations, units] = await Promise.all([
    ingredientIds.length ? tx.select().from(ingredients).where(and(eq(ingredients.branch_id, branchId), inArray(ingredients.id, ingredientIds))) : [],
    ingredientIds.length ? tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, branchId), inArray(stockBalances.ingredient_id, ingredientIds))) : [],
    locationIds.length ? tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.branch_id, branchId), inArray(inventoryLocations.id, locationIds))) : [],
    tx.select().from(unitsOfMeasure),
  ]);
  const ingredientById = new Map(ingredientRows.map((row) => [row.id, row]));
  const balanceByKey = new Map(balances.map((row) => [`${row.ingredient_id}:${row.location_id}`, row]));
  const locationById = new Map(locations.map((row) => [row.id, row]));
  const unitById = new Map(units.map((row) => [row.id, row]));
  const componentsByRecipe = new Map<number, typeof components>();
  for (const component of components) componentsByRecipe.set(component.recipe_version_id, [...(componentsByRecipe.get(component.recipe_version_id) ?? []), component]);
  const configurationKey = (config: MenuAvailabilityConfiguration) => `${config.menuItemId}:${config.variantId ?? "base"}:${[...new Set(config.modifierOptionIds ?? [])].sort((a, b) => a - b).join(",")}`;
  const requestedConfigurations = new Map<string, MenuAvailabilityConfiguration>();
  for (const config of options.configurations ?? []) {
    if (!menuIds.includes(config.menuItemId)) continue;
    const key = configurationKey(config);
    const quantity = (requestedConfigurations.get(key)?.quantity ?? 0) + (config.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity > 1_000_000) throw new Error("Requested menu quantity is outside the supported range");
    requestedConfigurations.set(key, { ...config, modifierOptionIds: [...new Set(config.modifierOptionIds ?? [])].sort((a, b) => a - b), quantity });
  }
  const configurations: Array<{ config: MenuAvailabilityConfiguration; requested: boolean }> = [];
  for (const item of menu) for (const variant of item.variants.length ? item.variants : [{ id: null }]) {
    configurations.push({ config: { menuItemId: item.id, variantId: variant.id }, requested: false });
  }
  for (const config of requestedConfigurations.values()) configurations.push({ config, requested: true });
  const output: Array<{
    menuItemId: number;
    variantId: number | null;
    modifierOptionIds: number[];
    requestedQuantity: number;
    status: MenuAvailabilityStatus;
    maxProducibleQuantity: number;
    maxProducible: number;
    blockingIngredients: Array<Record<string, number | string | null>>;
    theoreticalCost: number;
  }> = [];
  const requestedResults: Array<{
    row: (typeof output)[number];
    requirements: Map<string, { required: number; perItem: number; perItemBase: number; yieldLossBps: number; available: number; ingredient: typeof ingredientRows[number]; location: typeof locations[number] }>;
  }> = [];
  for (const { config, requested } of configurations) {
    const item = menu.find((row) => row.id === config.menuItemId)!;
    const variant = item.variants.find((row) => row.id === config.variantId);
    const quantity = config.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Error("Requested menu quantity is outside the supported range");
    const selected = new Set(config.modifierOptionIds ?? []);
    const optionIds = new Set(item.modifierGroups.flatMap((link) => link.modifierGroup.options.map((option) => option.id)));
    let status: "available" | "low_stock" | "unavailable" | "recipe_missing" | "manually_disabled" | "out_of_stock" = "available";
    let max = 1_000_000;
    let theoreticalCost = 0;
    let low = false;
    const blockingIngredients: Array<Record<string, number | string | null>> = [];
    const requirements = new Map<string, { required: number; perItem: number; perItemBase: number; yieldLossBps: number; available: number; ingredient: typeof ingredientRows[number]; location: typeof locations[number] }>();
    if (!item.is_available || variant?.is_available === false || !variant && config.variantId != null) status = "manually_disabled";
    else if ([...selected].some((id) => !optionIds.has(id))) status = "unavailable";
    const exact = activeRecipes.filter((recipe) => recipe.menu_item_id === item.id && recipe.variant_id === config.variantId);
    const fallback = config.variantId == null ? [] : activeRecipes.filter((recipe) => recipe.menu_item_id === item.id && recipe.variant_id == null);
    const matches = exact.length ? exact : fallback;
    if (status === "available" && matches.length !== 1) status = "recipe_missing";
    const recipe = matches.length === 1 ? matches[0] : null;
    const selectedComponents = recipe ? (componentsByRecipe.get(recipe.id) ?? []).filter((component) => component.modifier_option_id == null || selected.has(component.modifier_option_id)) : [];
    const aggregated = new Map<string, number>();
    for (const component of selectedComponents) {
      const key = `${component.ingredient_id}:${component.source_location_id}`;
      const sum = (aggregated.get(key) ?? 0) + component.quantity_base;
      if (!Number.isSafeInteger(sum)) throw new InventoryConflict("invalid_recipe", "Recipe quantity exceeds exact integer range");
      aggregated.set(key, sum);
    }
    if (status === "available" && (!recipe || aggregated.size === 0 || [...aggregated.values()].some((value) => value <= 0))) status = "recipe_missing";
    if (status === "available" && recipe) for (const [key, perItem] of aggregated) {
      const [ingredientId, locationId] = key.split(":").map(Number);
      const ingredient = ingredientById.get(ingredientId);
      const balance = balanceByKey.get(key);
      const location = locationById.get(locationId);
      if (!ingredient || !location) {
        status = "unavailable";
        continue;
      }
      const availableQuantity = ingredient.is_active && location.is_active ? Math.max(0, balance?.quantity_base ?? 0) : 0;
      const requiredPerItem = applyYieldLoss(perItem, recipe.yield_loss_bps);
      const requiredQuantity = applyYieldLoss(multiplyDivide(perItem, quantity, 1), recipe.yield_loss_bps);
      if (requested && ingredient.is_tracked) requirements.set(key, { required: requiredQuantity, perItem: requiredPerItem, perItemBase: perItem, yieldLossBps: recipe.yield_loss_bps, available: availableQuantity, ingredient, location });
      if (ingredient.is_tracked) {
        const fits = (count: number) => applyYieldLoss(multiplyDivide(perItem, count, 1), recipe.yield_loss_bps) <= availableQuantity;
        let ingredientMaximum = Math.floor(availableQuantity / requiredPerItem);
        while (ingredientMaximum > 0 && !fits(ingredientMaximum)) ingredientMaximum--;
        while (ingredientMaximum < Number.MAX_SAFE_INTEGER && fits(ingredientMaximum + 1)) ingredientMaximum++;
        max = Math.min(max, ingredientMaximum);
        low ||= availableQuantity <= ingredient.low_stock_threshold;
      }
      if (!ingredient.is_active || !location.is_active) status = "unavailable";
      if (balance?.average_unit_cost_micros) theoreticalCost += costMinorForQuantity(requiredQuantity, balance.average_unit_cost_micros);
      const shortage = Math.max(0, requiredQuantity - availableQuantity);
      if (shortage > 0) {
        const unit = unitById.get(ingredient.base_unit_id);
        blockingIngredients.push({
          ingredientId,
          nameEn: ingredient.name_en,
          nameAr: ingredient.name_ar,
          requiredQuantity,
          availableQuantity,
          shortageQuantity: shortage,
          ...(options.includeInventoryDetails ? { unit: unit?.code ?? null, sourceLocationEn: location.name_en, sourceLocationAr: location.name_ar } : {}),
        });
      }
    }
    if (status === "available" && max < quantity) status = "unavailable";
    else if (status === "available" && low) status = "low_stock";
    const row = {
      menuItemId: config.menuItemId,
      variantId: config.variantId,
      modifierOptionIds: config.modifierOptionIds ?? [],
      requestedQuantity: quantity,
      status,
      maxProducibleQuantity: Math.max(0, max),
      maxProducible: Math.max(0, max),
      blockingIngredients,
      theoreticalCost,
    };
    output.push(row);
    if (requested) requestedResults.push({ row, requirements });
  }
  const totalRequirements = new Map<string, number>();
  for (const result of requestedResults) for (const [key, requirement] of result.requirements) {
    const total = (totalRequirements.get(key) ?? 0) + requirement.required;
    if (!Number.isSafeInteger(total)) throw new InventoryConflict("invalid_recipe", "Combined cart quantity exceeds exact integer range");
    totalRequirements.set(key, total);
  }
  for (const result of requestedResults) for (const [key, requirement] of result.requirements) {
    const totalRequired = totalRequirements.get(key) ?? 0;
    if (totalRequired <= requirement.available) continue;
    const reservedForOthers = totalRequired - requirement.required;
    const availableForConfiguration = Math.max(0, requirement.available - reservedForOthers);
    const fits = (count: number) => applyYieldLoss(multiplyDivide(requirement.perItemBase, count, 1), requirement.yieldLossBps) <= availableForConfiguration;
    let maximum = Math.floor(availableForConfiguration / requirement.perItem);
    while (maximum > 0 && !fits(maximum)) maximum--;
    while (maximum < 1_000_000 && fits(maximum + 1)) maximum++;
    result.row.maxProducibleQuantity = Math.min(result.row.maxProducibleQuantity, maximum);
    result.row.maxProducible = result.row.maxProducibleQuantity;
    if (result.row.requestedQuantity > result.row.maxProducibleQuantity) result.row.status = "unavailable";
    const unit = unitById.get(requirement.ingredient.base_unit_id);
    result.row.blockingIngredients = result.row.blockingIngredients.filter((entry) => entry.ingredientId !== requirement.ingredient.id);
    result.row.blockingIngredients.push({
      ingredientId: requirement.ingredient.id,
      nameEn: requirement.ingredient.name_en,
      nameAr: requirement.ingredient.name_ar,
      requiredQuantity: totalRequired,
      availableQuantity: requirement.available,
      shortageQuantity: totalRequired - requirement.available,
      ...(options.includeInventoryDetails ? { unit: unit?.code ?? null, sourceLocationEn: requirement.location.name_en, sourceLocationAr: requirement.location.name_ar } : {}),
    });
  }
  return output;
}
