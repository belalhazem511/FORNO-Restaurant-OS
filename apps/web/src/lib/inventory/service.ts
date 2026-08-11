import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLogs,
  ingredients,
  orderInventoryConsumptions,
  orderInventoryIssues,
  orderItemCogs,
  orders,
  recipeComponents,
  recipeVersions,
  stockBalances,
  stockMovements,
} from "@/lib/db/schema";
import { applyYieldLoss, costMinorForQuantity, movingWeightedAverage, multiplyDivide } from "./exact";

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

async function resolvedItemComponents(tx: Transaction, item: {
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

export async function issueOrderInventory(tx: Transaction, input: {
  orderId: number;
  actorUserId: string;
  idempotencyKey: string;
  allowNegative?: boolean;
  overrideReason?: string;
  overrideApproverUserId?: string;
}) {
  const existing = await tx.query.orderInventoryIssues.findFirst({ where: eq(orderInventoryIssues.order_id, input.orderId) });
  if (existing) return existing;
  const order = await tx.query.orders.findFirst({
    where: eq(orders.id, input.orderId),
    with: { orderItems: { with: { modifiers: true } } },
  });
  if (!order?.branch_id) throw new InventoryConflict("stock_unavailable", "Order branch is unavailable");
  if (order.status !== "pending") throw new InventoryConflict("stock_unavailable", "Inventory can only be issued on the first pending-to-confirmed transition");

  const resolved = [] as Array<{ item: (typeof order.orderItems)[number]; recipe: typeof recipeVersions.$inferSelect; components: Array<{ ingredientId: number; locationId: number; quantityBase: number }> }>;
  for (const item of order.orderItems) resolved.push({ item, ...(await resolvedItemComponents(tx, item)) });
  const ingredientIds = [...new Set(resolved.flatMap((entry) => entry.components.map((component) => component.ingredientId)))];
  const ingredientRows = ingredientIds.length ? await tx.select().from(ingredients).where(inArray(ingredients.id, ingredientIds)) : [];
  const ingredientById = new Map(ingredientRows.map((ingredient) => [ingredient.id, ingredient]));
  const required = new Map<string, { ingredientId: number; locationId: number; quantityBase: number }>();
  for (const entry of resolved) for (const component of entry.components) {
    const key = `${component.ingredientId}:${component.locationId}`;
    const current = required.get(key) ?? { ...component, quantityBase: 0 };
    current.quantityBase += component.quantityBase;
    required.set(key, current);
  }

  const balances = new Map<string, typeof stockBalances.$inferSelect>();
  let usedNegativeOverride = false;
  for (const requirement of required.values()) {
    await tx.execute(sql`select id from stock_balances where ingredient_id = ${requirement.ingredientId} and location_id = ${requirement.locationId} for update`);
    const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.ingredient_id, requirement.ingredientId), eq(stockBalances.location_id, requirement.locationId)) });
    const ingredient = ingredientById.get(requirement.ingredientId);
    if (!balance || !ingredient) throw new InventoryConflict("stock_unavailable", "A required ingredient balance is unavailable", requirement);
    balances.set(`${requirement.ingredientId}:${requirement.locationId}`, balance);
    if (ingredient.is_tracked && balance.quantity_base < requirement.quantityBase && !input.allowNegative) {
      throw new InventoryConflict("insufficient_stock", `${ingredient.name_en} has insufficient stock`, { ingredientId: ingredient.id, required: requirement.quantityBase, available: balance.quantity_base });
    }
    if (ingredient.is_tracked && balance.quantity_base < requirement.quantityBase && input.allowNegative && !ingredient.allow_negative) {
      throw new InventoryConflict("insufficient_stock", `${ingredient.name_en} does not permit negative-stock override`, { ingredientId: ingredient.id });
    }
    if (ingredient.is_tracked && balance.quantity_base < requirement.quantityBase && input.allowNegative) usedNegativeOverride = true;
    if (balance.quantity_base < requirement.quantityBase && input.allowNegative && (!input.overrideReason || input.overrideReason.trim().length < 3)) {
      throw new InventoryConflict("insufficient_stock", "A reason is required for negative stock override");
    }
  }

  const issuedAt = new Date();
  let totalCogs = 0;
  const [issue] = await tx.insert(orderInventoryIssues).values({
    branch_id: order.branch_id,
    order_id: order.id,
    idempotency_key: input.idempotencyKey,
    status: "issued",
    total_cogs_amount: 0,
    issued_by: input.actorUserId,
    issued_at: issuedAt,
  }).returning();

  for (const entry of resolved) {
    let itemCogs = 0;
    for (const component of entry.components) {
      const key = `${component.ingredientId}:${component.locationId}`;
      const balance = balances.get(key)!;
      const ingredient = ingredientById.get(component.ingredientId)!;
      const cost = costMinorForQuantity(component.quantityBase, balance.average_unit_cost_micros);
      itemCogs += cost;
      await tx.insert(orderInventoryConsumptions).values({ issue_id: issue.id, order_id: order.id, order_item_id: entry.item.id, recipe_version_id: entry.recipe.id, ingredient_id: component.ingredientId, location_id: component.locationId, quantity_base: component.quantityBase, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: cost });
      if (ingredient.is_tracked) {
        const negative = balance.quantity_base < component.quantityBase;
        await tx.insert(stockMovements).values({ branch_id: order.branch_id, location_id: component.locationId, ingredient_id: component.ingredientId, movement_type: negative ? "negative_override" : "sale_consumption", direction: -1, quantity_base: component.quantityBase, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: cost, source_type: "order_inventory_issue", source_id: String(issue.id), idempotency_key: `${input.idempotencyKey}:item:${entry.item.id}:ingredient:${component.ingredientId}:location:${component.locationId}`, actor_user_id: input.actorUserId, reason: negative ? input.overrideReason : null, order_id: order.id, order_item_id: entry.item.id, recipe_version_id: entry.recipe.id, created_at: issuedAt });
        balance.quantity_base -= component.quantityBase;
        await tx.update(stockBalances).set({ quantity_base: balance.quantity_base, updated_at: issuedAt }).where(eq(stockBalances.id, balance.id));
      }
    }
    await tx.insert(orderItemCogs).values({ order_id: order.id, order_item_id: entry.item.id, recipe_version_id: entry.recipe.id, quantity: entry.item.quantity, total_cogs_amount: itemCogs, created_at: issuedAt });
    totalCogs += itemCogs;
  }
  await tx.update(orderInventoryIssues).set({ total_cogs_amount: totalCogs }).where(eq(orderInventoryIssues.id, issue.id));
  await tx.update(orders).set({ inventory_issued_at: issuedAt, total_cogs_amount: totalCogs, updated_at: issuedAt }).where(eq(orders.id, order.id));
  await tx.insert(auditLogs).values({ branch_id: order.branch_id, order_id: order.id, actor_user_id: input.actorUserId, approver_user_id: usedNegativeOverride ? input.overrideApproverUserId ?? input.actorUserId : null, action: usedNegativeOverride ? "inventory.negative_override" : "inventory.order_issue", entity_type: "order_inventory_issue", entity_id: String(issue.id), reason: usedNegativeOverride ? input.overrideReason : null, details: JSON.stringify({ totalCogs, ingredientCount: required.size, idempotencyKey: input.idempotencyKey }) });
  return { ...issue, total_cogs_amount: totalCogs };
}

export async function postStockIncrease(tx: Transaction, input: {
  branchId: number; locationId: number; ingredientId: number; quantityBase: number; unitCostMicros: number;
  actorUserId: string; idempotencyKey: string; movementType: "opening_balance" | "manual_positive"; reason: string;
}) {
  if (input.quantityBase <= 0 || input.unitCostMicros < 0) throw new Error("Positive stock and a non-negative trusted unit cost are required");
  const duplicate = await tx.query.stockMovements.findFirst({ where: eq(stockMovements.idempotency_key, input.idempotencyKey) });
  if (duplicate) return duplicate;
  await tx.execute(sql`select id from stock_balances where ingredient_id = ${input.ingredientId} and location_id = ${input.locationId} for update`);
  let balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.ingredient_id, input.ingredientId), eq(stockBalances.location_id, input.locationId)) });
  const nextAverage = movingWeightedAverage({ existingQuantity: balance?.quantity_base ?? 0, existingUnitCostMicros: balance?.average_unit_cost_micros ?? 0, addedQuantity: input.quantityBase, addedUnitCostMicros: input.unitCostMicros });
  if (!balance) {
    [balance] = await tx.insert(stockBalances).values({ branch_id: input.branchId, location_id: input.locationId, ingredient_id: input.ingredientId, quantity_base: input.quantityBase, average_unit_cost_micros: nextAverage, updated_at: new Date() }).returning();
  } else {
    [balance] = await tx.update(stockBalances).set({ quantity_base: balance.quantity_base + input.quantityBase, average_unit_cost_micros: nextAverage, updated_at: new Date() }).where(eq(stockBalances.id, balance.id)).returning();
  }
  await tx.update(ingredients).set({ average_unit_cost_micros: nextAverage, updated_by: input.actorUserId, updated_at: new Date() }).where(eq(ingredients.id, input.ingredientId));
  const [movement] = await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: input.locationId, ingredient_id: input.ingredientId, movement_type: input.movementType, direction: 1, quantity_base: input.quantityBase, unit_cost_micros: input.unitCostMicros, total_cost_amount: costMinorForQuantity(input.quantityBase, input.unitCostMicros), source_type: "inventory_adjustment", source_id: input.idempotencyKey, idempotency_key: input.idempotencyKey, actor_user_id: input.actorUserId, reason: input.reason }).returning();
  await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: input.actorUserId, approver_user_id: input.actorUserId, action: input.movementType === "opening_balance" ? "inventory.opening_balance" : "inventory.adjustment", entity_type: "stock_movement", entity_id: String(movement.id), reason: input.reason, details: JSON.stringify({ ingredientId: input.ingredientId, locationId: input.locationId, quantityBase: input.quantityBase, unitCostMicros: input.unitCostMicros }) });
  return movement;
}

export async function applyCancellationDisposition(tx: Transaction, input: { orderId: number; actorUserId: string; disposition: "returned_unused" | "prepared_discarded"; reason: string; idempotencyKey: string }) {
  const issue = await tx.query.orderInventoryIssues.findFirst({ where: eq(orderInventoryIssues.order_id, input.orderId) });
  if (!issue) return null;
  if (issue.status !== "issued") return issue;
  const consumptions = await tx.select().from(orderInventoryConsumptions).where(eq(orderInventoryConsumptions.issue_id, issue.id));
  const order = await tx.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
  if (!order?.branch_id) throw new Error("Order branch unavailable");
  for (const consumption of consumptions) {
    const movementKey = `${input.idempotencyKey}:${consumption.id}`;
    if (input.disposition === "returned_unused") {
      await tx.execute(sql`select id from stock_balances where ingredient_id = ${consumption.ingredient_id} and location_id = ${consumption.location_id} for update`);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.ingredient_id, consumption.ingredient_id), eq(stockBalances.location_id, consumption.location_id)) });
      if (!balance) throw new Error("Inventory balance unavailable for reversal");
      await tx.update(stockBalances).set({ quantity_base: balance.quantity_base + consumption.quantity_base, updated_at: new Date() }).where(eq(stockBalances.id, balance.id));
    }
    await tx.insert(stockMovements).values({ branch_id: order.branch_id, location_id: consumption.location_id, ingredient_id: consumption.ingredient_id, movement_type: input.disposition === "returned_unused" ? "sale_consumption_reversal" : "waste_discard", direction: input.disposition === "returned_unused" ? 1 : 0, quantity_base: consumption.quantity_base, unit_cost_micros: consumption.unit_cost_micros, total_cost_amount: consumption.total_cost_amount, source_type: "order_cancellation", source_id: String(input.orderId), idempotency_key: movementKey, actor_user_id: input.actorUserId, reason: input.reason, order_id: input.orderId, order_item_id: consumption.order_item_id, recipe_version_id: consumption.recipe_version_id });
  }
  const [updated] = await tx.update(orderInventoryIssues).set({ status: input.disposition === "returned_unused" ? "returned" : "discarded" }).where(eq(orderInventoryIssues.id, issue.id)).returning();
  await tx.insert(auditLogs).values({ branch_id: order.branch_id, order_id: order.id, actor_user_id: input.actorUserId, approver_user_id: input.actorUserId, action: `inventory.cancellation_${input.disposition}`, entity_type: "order_inventory_issue", entity_id: String(issue.id), reason: input.reason, details: JSON.stringify({ consumptionCount: consumptions.length }) });
  return updated;
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
