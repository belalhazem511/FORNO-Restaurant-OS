import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, ingredients, stockBalances, stockMovements } from "@/lib/db/schema";
import { costMinorForQuantity, movingWeightedAverage } from "./exact";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
