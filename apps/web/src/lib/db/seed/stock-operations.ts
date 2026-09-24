import { and, eq } from "drizzle-orm";
import { db } from "..";
import {
  ingredientPackageConversions, ingredients, inventoryLocations, stockCountStatusHistory, stockCounts,
  stockTransferLines, stockTransferStatusHistory, stockTransfers, unitsOfMeasure,
} from "../schema";

export async function seedStockOperations(branchId: number, userId: string) {
  const flour = await db.query.ingredients.findFirst({
    where: and(eq(ingredients.branch_id, branchId), eq(ingredients.sku, "FLOUR-00")),
  });
  const gram = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "G") });
  const transferSeed = await db.query.stockTransfers.findFirst({ where: eq(stockTransfers.idempotency_key, "seed-stock-transfer-demo") });
  if (!transferSeed && flour && gram) {
    const [source, destination, sauce, ml] = await Promise.all([
      db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.branch_id, branchId), eq(inventoryLocations.code, "PIZZA_KITCHEN")) }),
      db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.branch_id, branchId), eq(inventoryLocations.code, "MAIN_STORE")) }),
      db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branchId), eq(ingredients.sku, "PIZZA-SAUCE")) }),
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

  const countSeed = await db.query.stockCounts.findFirst({ where: eq(stockCounts.idempotency_key, "seed-stock-count-demo") });
  if (!countSeed) {
    const countLocation = await db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.branch_id, branchId), eq(inventoryLocations.code, "MAIN_STORE")) });
    if (countLocation) {
      const [count] = await db.insert(stockCounts).values({ branch_id: branchId, location_id: countLocation.id, count_number: "SC-DEMO-DRAFT-001", status: "draft", notes: "Deterministic demo draft; no inventory effect before approval and posting", idempotency_key: "seed-stock-count-demo", created_by: userId }).onConflictDoNothing().returning();
      if (count) await db.insert(stockCountStatusHistory).values({ count_id: count.id, branch_id: branchId, from_status: null, to_status: "draft", actor_user_id: userId, idempotency_key: "seed-stock-count-demo:created", reason: "Deterministic seeded draft" }).onConflictDoNothing();
    }
  }
}
