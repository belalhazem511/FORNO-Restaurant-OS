import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, ingredients, orderInventoryConsumptions, orderInventoryIssues, orderItemCogs, orders, recipeVersions, stockBalances, stockMovements } from "@/lib/db/schema";
import { applyYieldLoss, costMinorForQuantity, multiplyDivide } from "./exact";
import { InventoryConflict, resolvedItemComponents } from "./requirements";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
