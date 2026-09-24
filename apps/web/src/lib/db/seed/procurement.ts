import { and, eq } from "drizzle-orm";
import { db } from "..";
import {
  ingredientPackageConversions, ingredients, purchaseOrderLines, purchaseOrders, suppliers, unitsOfMeasure,
} from "../schema";

export async function seedProcurement(branchId: number, userId: string) {
  const [demoSupplier] = await db.insert(suppliers).values({
    branch_id: branchId,
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
    where: and(eq(suppliers.branch_id, branchId), eq(suppliers.code, "FRESH-FOODS")),
  });
  const flour = await db.query.ingredients.findFirst({
    where: and(eq(ingredients.branch_id, branchId), eq(ingredients.sku, "FLOUR-00")),
  });
  const gram = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "G") });
  if (seededSupplier && flour && gram) {
    let demoPurchaseOrder = await db.query.purchaseOrders.findFirst({
      where: eq(purchaseOrders.idempotency_key, "seed-po-fresh-foods"),
    });
    if (!demoPurchaseOrder) {
      [demoPurchaseOrder] = await db.insert(purchaseOrders).values({
        branch_id: branchId,
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
      db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branchId), eq(ingredients.sku, "PIZZA-SAUCE")) }),
      db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "L") }),
    ]);
    const existingReceivingOrder = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.idempotency_key, "seed-po-receiving") });
    if (!existingReceivingOrder && packageRow && sauce && litre) {
      const [approvedOrder] = await db.insert(purchaseOrders).values({
        branch_id: branchId,
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
    const sugar = await db.query.ingredients.findFirst({ where: and(eq(ingredients.branch_id, branchId), eq(ingredients.sku, "SUGAR")) });
    const existingOverrideOrder = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.idempotency_key, "seed-po-receiving-override") });
    if (sugar && !existingOverrideOrder) {
      const [overrideOrder] = await db.insert(purchaseOrders).values({
        branch_id: branchId,
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
}
