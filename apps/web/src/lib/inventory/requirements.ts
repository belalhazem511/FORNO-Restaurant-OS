import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingredients, recipeComponents, recipeVersions, stockBalances } from "@/lib/db/schema";
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

export async function menuAvailability(tx: Transaction, branchId: number) {
  const menu = (await tx.query.menuItems.findMany({ with: { variants: true, category: true } }))
    .filter((item) => item.category.branch_id === branchId);
  const output: Array<{ menuItemId: number; variantId: number | null; status: "in_stock" | "low_stock" | "out_of_stock" | "recipe_missing" | "stock_unavailable"; maxProducible: number; theoreticalCost: number }> = [];
  for (const item of menu) for (const variant of item.variants.length ? item.variants : [{ id: null }]) {
    try {
      const recipe = await activeRecipe(tx, item.id, variant.id);
      const components = (await tx.select().from(recipeComponents).where(eq(recipeComponents.recipe_version_id, recipe.id))).filter((component) => component.modifier_option_id == null);
      if (!components.length) throw new InventoryConflict("recipe_missing", "Recipe has no base components");
      let max = Number.MAX_SAFE_INTEGER;
      let cost = 0;
      let low = false;
      for (const component of components) {
        const [ingredient, balance] = await Promise.all([
          tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, component.ingredient_id), eq(ingredients.branch_id, branchId)) }),
          tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.ingredient_id, component.ingredient_id), eq(stockBalances.location_id, component.source_location_id)) }),
        ]);
        if (!ingredient || !balance) throw new InventoryConflict("stock_unavailable", "Stock data unavailable");
        const required = applyYieldLoss(component.quantity_base, recipe.yield_loss_bps);
        if (ingredient.is_tracked) {
          max = Math.min(max, Math.floor(balance.quantity_base / required));
          low ||= balance.quantity_base <= ingredient.low_stock_threshold;
        }
        cost += costMinorForQuantity(required, balance.average_unit_cost_micros);
      }
      output.push({ menuItemId: item.id, variantId: variant.id, status: max <= 0 ? "out_of_stock" : low ? "low_stock" : "in_stock", maxProducible: Math.max(0, max), theoreticalCost: cost });
    } catch (cause) {
      output.push({ menuItemId: item.id, variantId: variant.id, status: cause instanceof InventoryConflict && cause.code === "recipe_missing" ? "recipe_missing" : "stock_unavailable", maxProducible: 0, theoreticalCost: 0 });
    }
  }
  return output;
}
