import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SCHEMA_DDL } from "@/lib/trpc/routers/__tests__/helpers";
import { applyAuthoritativeChanges } from "./apply/import-authoritative-changes";
import * as schema from "@/lib/db/schema";
import { branches, cashierRegisters, ingredientCategories, ingredients, inventoryLocations, purchaseOrderLines, purchaseOrders, purchaseReceiptLines, purchaseReceipts, stockBalances, stockMovements, supplierReturnLines, supplierReturns, suppliers, syncChangeLog, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, syncOutbox, unitsOfMeasure, user } from "@/lib/db/schema";

const sourcePg = new PGlite(requiredPath("FORNO_TEST_PEER_SOURCE_DIR"));
const destinationPg = new PGlite(requiredPath("FORNO_TEST_PEER_DESTINATION_DIR"));
const source = { pg: sourcePg, db: drizzle({ client: sourcePg, schema }) };
const destination = { pg: destinationPg, db: drizzle({ client: destinationPg, schema }) };
const organizationId = "28502bbd-f951-4217-8dfc-e127638d79a0";
const deviceId = "cd5b3049-7a41-48ee-8b67-7ee40fae05f4";
const ids = {
  branch: "b60886ab-18b7-4a97-910a-7039c6b1b800", user: "9e0377e8-64df-4eb3-95ec-592d9e77de3d",
  supplier: "eb7642fb-b3e7-4b2d-b967-ad76475406c2", category: "1c9a3f3a-6a47-47b0-aed9-8d5f972c4e94",
  location: "e0f2f71d-ef24-4480-818a-d1961a964b2a", ingredient: "fbcb7ad4-2fd1-40be-960c-9c4bd01f7500",
  unit: "7833983f-f573-4d11-8ab2-083c7f838c0d", po: "f54248c2-f943-4678-b43b-560439307b4f",
  receipt: "bff59fdc-8ef7-411a-9cc4-3f7b9ca72523", returned: "8714053a-361c-4ab2-a880-f1b874df21c5",
};
let sourceIds: Record<string, number>;
let destinationIds: Record<string, number>;
let changes: Array<Record<string, unknown>>;

function requiredPath(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point to a new isolated PGLite directory.`);
  return value;
}

async function initialize(db: typeof source.db, pg: typeof source.pg, pad: boolean) {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values({ id: "sync-owner", name: "Owner", email: `${pad ? "destination" : "source"}@test.local`, emailVerified: false });
  if (pad) await db.insert(branches).values({ code: "PAD", name_en: "Padding", name_ar: "Padding", currency: "EGP", timezone: "Africa/Cairo", is_active: true });
  const [branch] = await db.insert(branches).values({ code: pad ? "DEVICE" : "CENTRAL", name_en: "Branch", name_ar: "Branch", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
  const [register] = await db.insert(cashierRegisters).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "Main", is_active: true }).returning();
  await db.insert(syncOrganizations).values({ id: organizationId, name: "Test organization" });
  await db.insert(syncDevices).values({ id: deviceId, organization_id: organizationId, display_name: "Device B", credential_hash: null, branch_id: branch!.id, register_id: register!.id, status: "paired" });
  return { branchId: branch!.id, registerId: register!.id };
}

async function addMapping(branchId: number, entityType: string, globalId: string, localId: number | string) {
  await destination.db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: branchId, entity_type: entityType, global_id: globalId, local_id: String(localId), local_revision: 1, server_revision: 0 });
  await destination.db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: branchId, entity_type: entityType, global_id: globalId, local_id: String(localId), server_revision: 1 }).onConflictDoNothing();
}

beforeAll(async () => {
  const sourceScope = await initialize(source.db, source.pg, false);
  const destinationScope = await initialize(destination.db, destination.pg, true);
  const unitRow = (await source.db.insert(unitsOfMeasure).values({ code: "KG", name_en: "Kilogram", name_ar: "Kilogram", dimension: "mass", base_numerator: 1_000, base_denominator: 1 }).returning())[0]!;
  const categoryRow = (await source.db.insert(ingredientCategories).values({ branch_id: sourceScope.branchId, code: "RAW", name_en: "Raw", name_ar: "Raw", is_active: true }).returning())[0]!;
  const locationRow = (await source.db.insert(inventoryLocations).values({ branch_id: sourceScope.branchId, code: "STORE", name_en: "Store", name_ar: "Store", is_active: true }).returning())[0]!;
  const ingredientRow = (await source.db.insert(ingredients).values({ branch_id: sourceScope.branchId, category_id: categoryRow.id, sku: "FLOUR", name_en: "Flour", name_ar: "Flour", base_unit_id: unitRow.id, dimension: "mass", default_location_id: locationRow.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 40_000, created_by: "sync-owner", updated_by: "sync-owner" }).returning())[0]!;
  const supplierRow = (await source.db.insert(suppliers).values({ branch_id: sourceScope.branchId, code: "SUP-1", name_en: "Supplier", name_ar: "Supplier", is_active: true, created_by: "sync-owner", updated_by: "sync-owner" }).returning())[0]!;
  const poRow = (await source.db.insert(purchaseOrders).values({ branch_id: sourceScope.branchId, supplier_id: supplierRow.id, supplier_code_snapshot: supplierRow.code, supplier_name_en_snapshot: supplierRow.name_en, supplier_name_ar_snapshot: supplierRow.name_ar, po_number: "PO-1", status: "approved", receiving_status: "partially_received", currency: "EGP", subtotal_amount: 40, total_amount: 40, idempotency_key: "source-po", created_by: "sync-owner" }).returning())[0]!;
  const poLine = (await source.db.insert(purchaseOrderLines).values({ purchase_order_id: poRow.id, ingredient_id: ingredientRow.id, unit_id: unitRow.id, ingredient_sku: ingredientRow.sku, ingredient_name_en: ingredientRow.name_en, ingredient_name_ar: ingredientRow.name_ar, unit_code: "KG", quantity_input_scaled: 1_000, quantity_base: 2_000, conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, unit_price_minor: 40, line_total_amount: 40 }).returning())[0]!;
  const now = new Date().toISOString();
  const receipt = (await source.db.insert(purchaseReceipts).values({ branch_id: sourceScope.branchId, purchase_order_id: poRow.id, supplier_id: supplierRow.id, supplier_code_snapshot: supplierRow.code, supplier_name_en_snapshot: supplierRow.name_en, supplier_name_ar_snapshot: supplierRow.name_ar, po_number_snapshot: poRow.po_number, receipt_number: "GRN-1", location_id: locationRow.id, received_by: "sync-owner", status: "posted", idempotency_key: "source-grn", posted_at: new Date(now), posted_by: "sync-owner" }).returning())[0]!;
  const receiptLine = (await source.db.insert(purchaseReceiptLines).values({ receipt_id: receipt.id, purchase_order_line_id: poLine.id, ingredient_id: ingredientRow.id, ingredient_sku_snapshot: ingredientRow.sku, ingredient_name_en_snapshot: ingredientRow.name_en, ingredient_name_ar_snapshot: ingredientRow.name_ar, unit_id: unitRow.id, unit_code_snapshot: "KG", conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, ordered_quantity_base_snapshot: 2_000, po_unit_price_minor_snapshot: 40, quantity_input_scaled: 500, accepted_quantity_base: 1_000, rejected_quantity_base: 0, damaged_quantity_base: 0, actual_unit_price_minor: 40, accepted_unit_cost_micros_snapshot: 40_000, balance_quantity_before: 0, balance_unit_cost_before: 0, ingredient_average_unit_cost_before: 0, line_total_amount: 20 }).returning())[0]!;
  const returned = (await source.db.insert(supplierReturns).values({ branch_id: sourceScope.branchId, supplier_id: supplierRow.id, purchase_order_id: poRow.id, receipt_id: receipt.id, location_id: locationRow.id, return_number: "RTV-1", supplier_code_snapshot: supplierRow.code, supplier_name_en_snapshot: supplierRow.name_en, supplier_name_ar_snapshot: supplierRow.name_ar, po_number_snapshot: poRow.po_number, receipt_number_snapshot: receipt.receipt_number, reason_code: "damaged", status: "dispatched", idempotency_key: "source-rtv", expected_credit_amount: 8, valuation_amount: 10, cost_variance_amount: 2, created_by: "sync-owner", submitted_by: "sync-owner", approved_by: "sync-owner", dispatched_by: "sync-owner", submitted_at: new Date(now), approved_at: new Date(now), dispatched_at: new Date(now) }).returning())[0]!;
  const returnLine = (await source.db.insert(supplierReturnLines).values({ supplier_return_id: returned.id, receipt_line_id: receiptLine.id, ingredient_id: ingredientRow.id, ingredient_sku_snapshot: ingredientRow.sku, ingredient_name_en_snapshot: ingredientRow.name_en, ingredient_name_ar_snapshot: ingredientRow.name_ar, dimension_snapshot: "mass", unit_id: unitRow.id, unit_code_snapshot: "KG", conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, quantity_input_scaled: 100, quantity_base: 200, accepted_quantity_base_snapshot: 1_000, original_unit_cost_micros_snapshot: 40_000, expected_credit_amount: 8, dispatch_unit_cost_micros_snapshot: 50_000, dispatch_valuation_amount: 10 }).returning())[0]!;
  const sourceMovements = await source.db.insert(stockMovements).values([
    { branch_id: sourceScope.branchId, location_id: locationRow.id, ingredient_id: ingredientRow.id, movement_type: "purchase_receipt", direction: 1, quantity_base: 1_000, unit_cost_micros: 40_000, total_cost_amount: 40, source_type: "purchase_receipt", source_id: String(receipt.id), idempotency_key: "source-receipt-movement", actor_user_id: "sync-owner", purchase_receipt_id: receipt.id, purchase_receipt_line_id: receiptLine.id, created_at: new Date(now) },
    { branch_id: sourceScope.branchId, location_id: locationRow.id, ingredient_id: ingredientRow.id, movement_type: "supplier_return", direction: -1, quantity_base: 200, unit_cost_micros: 50_000, total_cost_amount: 10, source_type: "supplier_return", source_id: String(returned.id), idempotency_key: "source-return-movement", actor_user_id: "sync-owner", supplier_return_id: returned.id, supplier_return_line_id: returnLine.id, purchase_receipt_id: receipt.id, purchase_receipt_line_id: receiptLine.id, created_at: new Date(now) },
  ]).returning();
  await source.db.insert(stockBalances).values({ branch_id: sourceScope.branchId, location_id: locationRow.id, ingredient_id: ingredientRow.id, quantity_base: 800, average_unit_cost_micros: 40_000 });
  sourceIds = { branch: sourceScope.branchId, supplier: supplierRow.id, ingredient: ingredientRow.id, location: locationRow.id, po: poRow.id, poLine: poLine.id, receipt: receipt.id, receiptLine: receiptLine.id, returned: returned.id, returnLine: returnLine.id, receiptMovement: sourceMovements[0]!.id, returnMovement: sourceMovements[1]!.id };
  const mappingSeeds = [
    ["branch", ids.branch, sourceScope.branchId], ["user", ids.user, "sync-owner"], ["supplier", ids.supplier, supplierRow.id], ["ingredient_category", ids.category, categoryRow.id],
    ["inventory_location", ids.location, locationRow.id], ["ingredient", ids.ingredient, ingredientRow.id], ["unit_of_measure", ids.unit, unitRow.id], ["purchase_order", ids.po, poRow.id],
  ] as const;
  const [paddingSupplier] = await destination.db.insert(suppliers).values({ branch_id: destinationScope.branchId, code: "PAD-SUP", name_en: "Padding", name_ar: "Padding", is_active: true, created_by: "sync-owner", updated_by: "sync-owner" }).returning();
  const [destinationCategory] = await destination.db.insert(ingredientCategories).values({ branch_id: destinationScope.branchId, code: "PAD", name_en: "Padding", name_ar: "Padding", is_active: true }).returning();
  const [destinationLocation] = await destination.db.insert(inventoryLocations).values({ branch_id: destinationScope.branchId, code: "PAD", name_en: "Padding", name_ar: "Padding", is_active: true }).returning();
  const [destinationUnit] = await destination.db.insert(unitsOfMeasure).values({ code: "G", name_en: "Gram", name_ar: "Gram", dimension: "mass", base_numerator: 1, base_denominator: 1 }).returning();
  const [destinationLocationTarget] = await destination.db.insert(inventoryLocations).values({ branch_id: destinationScope.branchId, code: "STORE", name_en: "Store", name_ar: "Store", is_active: true }).returning();
  await destination.db.insert(ingredientCategories).values({ branch_id: destinationScope.branchId, code: "RAW", name_en: "Raw", name_ar: "Raw", is_active: true });
  const destinationCategoryTarget = await destination.db.query.ingredientCategories.findFirst({ where: and(eq(ingredientCategories.branch_id, destinationScope.branchId), eq(ingredientCategories.code, "RAW")) });
  await destination.db.insert(unitsOfMeasure).values({ code: "KG", name_en: "Kilogram", name_ar: "Kilogram", dimension: "mass", base_numerator: 1_000, base_denominator: 1 });
  const destinationUnitTarget = await destination.db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "KG") });
  const [destinationIngredientPadding] = await destination.db.insert(ingredients).values({ branch_id: destinationScope.branchId, category_id: destinationCategory!.id, sku: "PAD", name_en: "Padding", name_ar: "Padding", base_unit_id: destinationUnit!.id, dimension: "mass", default_location_id: destinationLocation!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "sync-owner", updated_by: "sync-owner" }).returning();
  const [destinationSupplier] = await destination.db.insert(suppliers).values({ branch_id: destinationScope.branchId, code: "SUP-LOCAL", name_en: "Supplier", name_ar: "Supplier", is_active: true, created_by: "sync-owner", updated_by: "sync-owner" }).returning();
  const [destinationIngredientCategory] = await destination.db.select().from(ingredientCategories).where(eq(ingredientCategories.code, "RAW"));
  const [destinationIngredient] = await destination.db.insert(ingredients).values({ branch_id: destinationScope.branchId, category_id: destinationIngredientCategory!.id, sku: "FLOUR-LOCAL", name_en: "Flour", name_ar: "Flour", base_unit_id: destinationUnitTarget!.id, dimension: "mass", default_location_id: destinationLocationTarget!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "sync-owner", updated_by: "sync-owner" }).returning();
  const [paddingPo] = await destination.db.insert(purchaseOrders).values({ branch_id: destinationScope.branchId, supplier_id: paddingSupplier!.id, supplier_code_snapshot: "PAD-SUP", supplier_name_en_snapshot: "Padding", supplier_name_ar_snapshot: "Padding", po_number: "PO-PAD", status: "draft", receiving_status: "not_received", currency: "EGP", subtotal_amount: 0, total_amount: 0, idempotency_key: "peer-po-pad", created_by: "sync-owner" }).returning();
  const [paddingPoLine] = await destination.db.insert(purchaseOrderLines).values({ purchase_order_id: paddingPo!.id, ingredient_id: destinationIngredientPadding!.id, unit_id: destinationUnit!.id, ingredient_sku: "PAD", ingredient_name_en: "Padding", ingredient_name_ar: "Padding", unit_code: "G", quantity_input_scaled: 1, quantity_base: 1, conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, unit_price_minor: 0, line_total_amount: 0 }).returning();
  const [destinationPo] = await destination.db.insert(purchaseOrders).values({ branch_id: destinationScope.branchId, supplier_id: destinationSupplier!.id, supplier_code_snapshot: "SUP-LOCAL", supplier_name_en_snapshot: "Supplier", supplier_name_ar_snapshot: "Supplier", po_number: "PO-LOCAL", status: "approved", receiving_status: "not_received", currency: "EGP", subtotal_amount: 40, total_amount: 40, idempotency_key: "peer-po", created_by: "sync-owner" }).returning();
  const [destinationPoLine] = await destination.db.insert(purchaseOrderLines).values({ purchase_order_id: destinationPo!.id, ingredient_id: destinationIngredient!.id, unit_id: destinationUnitTarget!.id, ingredient_sku: "FLOUR-LOCAL", ingredient_name_en: "Flour", ingredient_name_ar: "Flour", unit_code: "KG", quantity_input_scaled: 1_000, quantity_base: 2_000, conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, unit_price_minor: 40, line_total_amount: 40 }).returning();
  const padReceipt = (await destination.db.insert(purchaseReceipts).values({ branch_id: destinationScope.branchId, purchase_order_id: paddingPo!.id, supplier_id: paddingSupplier!.id, supplier_code_snapshot: "PAD-SUP", supplier_name_en_snapshot: "Padding", supplier_name_ar_snapshot: "Padding", po_number_snapshot: "PO-PAD", receipt_number: "GRN-PAD", location_id: destinationLocation!.id, received_by: "sync-owner", status: "draft", idempotency_key: "peer-grn-pad" }).returning())[0]!;
  const padReceiptLine = (await destination.db.insert(purchaseReceiptLines).values({ receipt_id: padReceipt.id, purchase_order_line_id: paddingPoLine!.id, ingredient_id: destinationIngredientPadding!.id, ingredient_sku_snapshot: "PAD", ingredient_name_en_snapshot: "Padding", ingredient_name_ar_snapshot: "Padding", unit_id: destinationUnit!.id, unit_code_snapshot: "G", conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, ordered_quantity_base_snapshot: 1, po_unit_price_minor_snapshot: 0, quantity_input_scaled: 1, accepted_quantity_base: 0, rejected_quantity_base: 0, damaged_quantity_base: 0, actual_unit_price_minor: 0, accepted_unit_cost_micros_snapshot: 0, line_total_amount: 0 }).returning())[0]!;
  await destination.db.insert(supplierReturns).values({ branch_id: destinationScope.branchId, supplier_id: paddingSupplier!.id, purchase_order_id: paddingPo!.id, receipt_id: padReceipt.id, location_id: destinationLocation!.id, return_number: "RTV-PAD", supplier_code_snapshot: "PAD-SUP", supplier_name_en_snapshot: "Padding", supplier_name_ar_snapshot: "Padding", po_number_snapshot: "PO-PAD", receipt_number_snapshot: "GRN-PAD", reason_code: "other", status: "draft", idempotency_key: "peer-rtv-pad", expected_credit_amount: 0, created_by: "sync-owner" });
  await destination.db.insert(supplierReturnLines).values({ supplier_return_id: 1, receipt_line_id: padReceiptLine.id, ingredient_id: destinationIngredientPadding!.id, ingredient_sku_snapshot: "PAD", ingredient_name_en_snapshot: "Padding", ingredient_name_ar_snapshot: "Padding", dimension_snapshot: "mass", unit_id: destinationUnit!.id, unit_code_snapshot: "G", conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, quantity_input_scaled: 1, quantity_base: 1, accepted_quantity_base_snapshot: 1, original_unit_cost_micros_snapshot: 0, expected_credit_amount: 0 });
  await destination.db.insert(stockMovements).values({ branch_id: destinationScope.branchId, location_id: destinationLocation!.id, ingredient_id: destinationIngredientPadding!.id, movement_type: "manual_positive", direction: 1, quantity_base: 1, unit_cost_micros: 0, total_cost_amount: 0, source_type: "padding", source_id: "padding", idempotency_key: "peer-movement-pad", actor_user_id: "sync-owner" });
  await destination.db.insert(stockBalances).values({ branch_id: destinationScope.branchId, location_id: destinationLocationTarget!.id, ingredient_id: destinationIngredient!.id, quantity_base: 0, average_unit_cost_micros: 0 });
  destinationIds = { branch: destinationScope.branchId, supplier: destinationSupplier!.id, ingredient: destinationIngredient!.id, location: destinationLocationTarget!.id, po: destinationPo!.id, poLine: destinationPoLine!.id };
  for (const [type, globalId, id] of mappingSeeds) {
    const targetId = type === "branch" ? destinationScope.branchId : type === "user" ? "sync-owner" : type === "supplier" ? destinationSupplier!.id : type === "ingredient_category" ? destinationIngredientCategory!.id : type === "inventory_location" ? destinationLocation!.id : type === "ingredient" ? destinationIngredient!.id : type === "unit_of_measure" ? destinationUnitTarget!.id : destinationPo!.id;
    await addMapping(destinationScope.branchId, type, globalId, type === "inventory_location" ? destinationLocationTarget!.id : targetId);
    if (type === "user") continue;
    void id;
  }
  void paddingSupplier; void destinationIngredientPadding; void destinationUnit;
  const receiptChange = { cursor: 1, domain: "receiving", entityType: "purchase_receipt", entityGlobalId: ids.receipt, action: "receipt_post", revision: 1, snapshot: { receiptGlobalId: ids.receipt, purchaseOrderGlobalId: ids.po, supplierGlobalId: ids.supplier, locationGlobalId: ids.location, receivedByGlobalId: ids.user, postedByGlobalId: ids.user, supplierCodeSnapshot: "SUP-1", supplierNameEnSnapshot: "Supplier", supplierNameArSnapshot: "Supplier", poNumberSnapshot: "PO-1", receiptNumber: "GRN-1", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: now, notes: null, status: "posted", idempotencyKey: "receipt-source", postedAt: now, varianceApprovedByGlobalId: null, varianceReason: null, overreceiveApprovedByGlobalId: null, overreceiveReason: null, reversalReason: null, needsReviewReason: null, lines: [{ poLineIndex: 0, ingredientGlobalId: ids.ingredient, packageConversionCode: null, unitCode: "KG", ingredientSku: "FLOUR", ingredientNameEn: "Flour", ingredientNameAr: "Flour", conversionNumerator: 2, conversionDenominator: 1, orderedQuantityBase: 2_000, poUnitPriceMinor: 40, quantityScaled: 500, acceptedQuantityBase: 1_000, rejectedQuantityBase: 0, damagedQuantityBase: 0, actualUnitPriceMinor: 40, acceptedUnitCostMicros: 40_000, balanceQuantityBefore: 0, balanceUnitCostBefore: 0, ingredientAverageUnitCostBefore: 0, lineTotalAmount: 20, notes: null }], reversal: null, movements: [{ movementType: "purchase_receipt", direction: 1, quantityBase: 1_000, unitCostMicros: 40_000, totalCostAmount: 40, idempotencyKey: "source-receipt-move", actorGlobalId: ids.user, reason: null, createdAt: now, lineIndex: 0, reversal: false }] } };
  const returnChange = { cursor: 2, domain: "supplier_returns", entityType: "supplier_return", entityGlobalId: ids.returned, action: "return_dispatch", revision: 1, snapshot: { supplierReturnGlobalId: ids.returned, supplierGlobalId: ids.supplier, purchaseOrderGlobalId: ids.po, receiptGlobalId: ids.receipt, locationGlobalId: ids.location, createdByGlobalId: ids.user, returnNumber: "RTV-1", supplierCodeSnapshot: "SUP-1", supplierNameEnSnapshot: "Supplier", supplierNameArSnapshot: "Supplier", poNumberSnapshot: "PO-1", receiptNumberSnapshot: "GRN-1", reasonCode: "damaged", reason: "Damaged", notes: null, evidenceMetadata: null, status: "dispatched", idempotencyKey: "return-source", expectedCreditAmount: 8, valuationAmount: 10, costVarianceAmount: 2, submittedByGlobalId: ids.user, approvedByGlobalId: ids.user, dispatchedByGlobalId: ids.user, cancelledByGlobalId: null, reversedByGlobalId: null, submittedAt: now, approvedAt: now, dispatchedAt: now, cancelledAt: null, reversedAt: null, cancellationReason: null, needsReviewReason: null, lines: [{ receiptLineIndex: 0, ingredientGlobalId: ids.ingredient, sku: "FLOUR", nameEn: "Flour", nameAr: "Flour", dimension: "mass", unitCode: "KG", packageConversionCode: null, quantityScaled: 100, quantityBase: 200, acceptedQuantityBase: 1_000, conversionNumerator: 2, conversionDenominator: 1, originalUnitCostMicros: 40_000, expectedCreditAmount: 8, dispatchUnitCostMicros: 50_000, dispatchValuationAmount: 10, notes: null }], histories: [{ fromStatus: null, toStatus: "draft", actorGlobalId: ids.user, reason: null, idempotencyKey: "h1", createdAt: now }, { fromStatus: "draft", toStatus: "submitted", actorGlobalId: ids.user, reason: null, idempotencyKey: "h2", createdAt: now }, { fromStatus: "submitted", toStatus: "approved", actorGlobalId: ids.user, reason: "Approved", idempotencyKey: "h3", createdAt: now }, { fromStatus: "approved", toStatus: "dispatched", actorGlobalId: ids.user, reason: "Dispatched", idempotencyKey: "h4", createdAt: now }], reversal: null, movements: [{ lineIndex: 0, direction: -1, quantityBase: 200, unitCostMicros: 50_000, totalCostAmount: 10, idempotencyKey: "source-return-move", actorGlobalId: ids.user, reason: "Damaged", createdAt: now, reversal: false }] } };
  const authoritativeChanges = [receiptChange, returnChange];
  await source.db.insert(syncChangeLog).values(authoritativeChanges.map((change) => ({ organization_id: organizationId, branch_id: sourceScope.branchId, domain: change.domain as string, entity_type: change.entityType as string, entity_global_id: change.entityGlobalId as string, action: change.action as string, server_revision: change.revision as number, source_operation_id: `source-operation-${change.cursor}` })));
  const orderedChangeLog = await source.db.select().from(syncChangeLog).orderBy(asc(syncChangeLog.cursor));
  changes = orderedChangeLog.map((entry, index) => ({ ...authoritativeChanges[index]!, cursor: entry.cursor }));
});

afterAll(async () => { await source.pg.close(); await destination.pg.close(); });

describe("fresh-device procurement reconciliation", () => {
  it("imports receipt and return snapshots with destination-local foreign keys exactly once", async () => {
    const oldMode = process.env.FORNO_DESKTOP_MODE; const oldToken = process.env.FORNO_DESKTOP_SETUP_TOKEN; const oldDevice = process.env.FORNO_DESKTOP_DEVICE_ID;
    process.env.FORNO_DESKTOP_MODE = "1"; process.env.FORNO_DESKTOP_SETUP_TOKEN = "test-pull-token"; process.env.FORNO_DESKTOP_DEVICE_ID = deviceId;
    const request = () => new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-pull-token" }, body: JSON.stringify({ changes, nextCursor: 2 }) });
    try {
      const response = await applyAuthoritativeChanges(request(), destination.db);
      expect(response.status).toBe(200);
      const receipt = await destination.db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.receipt_number, "GRN-1"), with: { lines: true } });
      const returned = await destination.db.query.supplierReturns.findFirst({ where: eq(supplierReturns.return_number, "RTV-1"), with: { lines: true, statusHistory: true } });
      expect(receipt).toMatchObject({ branch_id: destinationIds.branch, purchase_order_id: destinationIds.po, supplier_id: destinationIds.supplier, location_id: destinationIds.location, status: "posted" });
      expect(receipt!.id).not.toBe(sourceIds.receipt);
      expect(receipt!.lines[0]).toMatchObject({ purchase_order_line_id: destinationIds.poLine, ingredient_id: destinationIds.ingredient, receipt_id: receipt!.id, quantity_input_scaled: 500, accepted_quantity_base: 1_000, conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, accepted_unit_cost_micros_snapshot: 40_000, line_total_amount: 20 });
      expect(returned).toMatchObject({ branch_id: destinationIds.branch, supplier_id: destinationIds.supplier, purchase_order_id: destinationIds.po, receipt_id: receipt!.id, location_id: destinationIds.location, status: "dispatched", expected_credit_amount: 8, valuation_amount: 10, cost_variance_amount: 2 });
      expect(returned!.id).not.toBe(sourceIds.returned);
      expect(returned!.lines[0]).toMatchObject({ supplier_return_id: returned!.id, receipt_line_id: receipt!.lines[0]!.id, ingredient_id: destinationIds.ingredient, quantity_input_scaled: 100, quantity_base: 200, conversion_numerator_snapshot: 2, conversion_denominator_snapshot: 1, original_unit_cost_micros_snapshot: 40_000, dispatch_unit_cost_micros_snapshot: 50_000, dispatch_valuation_amount: 10 });
      const balance = await destination.db.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, destinationIds.branch), eq(stockBalances.location_id, destinationIds.location), eq(stockBalances.ingredient_id, destinationIds.ingredient)) });
      expect(balance).toMatchObject({ quantity_base: 800, average_unit_cost_micros: 40_000 });
      const importedMovements = await destination.db.select().from(stockMovements).where(and(eq(stockMovements.branch_id, destinationIds.branch), eq(stockMovements.ingredient_id, destinationIds.ingredient), eq(stockMovements.location_id, destinationIds.location)));
      expect(importedMovements).toHaveLength(2);
      const importedReceiptMovement = await destination.db.query.stockMovements.findFirst({ where: eq(stockMovements.purchase_receipt_id, receipt!.id) });
      const importedReturnMovement = await destination.db.query.stockMovements.findFirst({ where: eq(stockMovements.supplier_return_id, returned!.id) });
      expect(importedReceiptMovement).toMatchObject({ branch_id: destinationIds.branch, location_id: destinationIds.location, ingredient_id: destinationIds.ingredient, purchase_receipt_line_id: receipt!.lines[0]!.id, direction: 1, quantity_base: 1_000, unit_cost_micros: 40_000 });
      expect(importedReturnMovement).toMatchObject({ branch_id: destinationIds.branch, location_id: destinationIds.location, ingredient_id: destinationIds.ingredient, supplier_return_line_id: returned!.lines[0]!.id, purchase_receipt_line_id: receipt!.lines[0]!.id, direction: -1, quantity_base: 200, unit_cost_micros: 50_000 });
      expect(importedReceiptMovement!.id).not.toBe(sourceIds.receiptMovement);
      expect(importedReturnMovement!.id).not.toBe(sourceIds.returnMovement);
      expect(destinationIds.branch).not.toBe(sourceIds.branch);
      expect(destinationIds.supplier).not.toBe(sourceIds.supplier);
      expect(destinationIds.ingredient).not.toBe(sourceIds.ingredient);
      expect(destinationIds.location).not.toBe(sourceIds.location);
      expect(destinationIds.po).not.toBe(sourceIds.po);
      expect(destinationIds.poLine).not.toBe(sourceIds.poLine);
      expect(receipt!.id).not.toBe(sourceIds.receipt);
      expect(receipt!.lines[0]!.id).not.toBe(sourceIds.receiptLine);
      expect(returned!.id).not.toBe(sourceIds.returned);
      expect(returned!.lines[0]!.id).not.toBe(sourceIds.returnLine);
      expect((await destination.db.select().from(syncOutbox))).toHaveLength(0);
      expect((await destination.db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, destinationIds.po) }))?.receiving_status).toBe("partially_received");
      const firstCounts = { receipts: (await destination.db.select().from(purchaseReceipts)).length, receiptLines: (await destination.db.select().from(purchaseReceiptLines)).length, returns: (await destination.db.select().from(supplierReturns)).length, returnLines: (await destination.db.select().from(supplierReturnLines)).length, movements: (await destination.db.select().from(stockMovements)).length };
      const replay = await applyAuthoritativeChanges(request(), destination.db);
      expect(replay.status).toBe(200);
      expect({ receipts: (await destination.db.select().from(purchaseReceipts)).length, receiptLines: (await destination.db.select().from(purchaseReceiptLines)).length, returns: (await destination.db.select().from(supplierReturns)).length, returnLines: (await destination.db.select().from(supplierReturnLines)).length, movements: (await destination.db.select().from(stockMovements)).length }).toEqual(firstCounts);
      expect((await destination.db.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }))?.last_pulled_cursor).toBe(2);
    } finally {
      if (oldMode === undefined) delete process.env.FORNO_DESKTOP_MODE; else process.env.FORNO_DESKTOP_MODE = oldMode;
      if (oldToken === undefined) delete process.env.FORNO_DESKTOP_SETUP_TOKEN; else process.env.FORNO_DESKTOP_SETUP_TOKEN = oldToken;
      if (oldDevice === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID; else process.env.FORNO_DESKTOP_DEVICE_ID = oldDevice;
    }
  });
});
