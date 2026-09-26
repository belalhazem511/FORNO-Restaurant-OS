import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createTestDb, SCHEMA_DDL } from "@/lib/trpc/routers/__tests__/helpers";
import { auditLogs, branches, cashierRegisters, cashierShifts, customers, ingredientCategories, ingredientPackageConversions, ingredients, inventoryLocations, kitchenStations, menuCategories, menuItems, orderCancellations, orderCheckouts, orderPayments, orders, paymentMethods, printJobs, products, purchaseOrderLines, purchaseOrders, purchaseReceiptLines, purchaseReceiptReversals, purchaseReceipts, recipeComponents, recipeVersions, shiftCashMovements, staffAssignments, stockBalances, stockMovements, supplierReturnLines, supplierReturnReversals, supplierReturns, suppliers, syncChangeLog, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, syncOutbox, transactions, unitsOfMeasure, user } from "@/lib/db/schema";
import { productImagePath } from "@/lib/media/product-images";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { GET, POST, SYNC_COMMAND_REGISTRY } = await import("./commands/route");
const { applyAuthoritativeChanges } = await import("../desktop/sync/apply/import-authoritative-changes");
const { POST: uploadProductMedia } = await import("./media/route");
const deviceId = "b2d90704-052a-4a37-a0fc-0464bf8c9e0a";
const organizationId = "ce9b25aa-39de-41c8-8d07-6c4ad0b5b967";
const branchGlobalId = "8fb88e82-24a4-483e-b931-e5d23e4f8d0c";
const registerGlobalId = "849e199a-a15a-4dca-bc62-13f774462e0a";
const actorGlobalId = "b22d0546-3cff-4333-b27e-1a87d65c1945";
const credential = "device-secret-for-central-sync-tests-123";
const customerGlobalId = "fa9ccdae-1358-46f9-9f89-4a675607c7a0";
let centralBranchId = 0;
const menuItemGlobalId = "5575a74a-9bbc-4b99-9847-0bce2095e6ef";
const stationGlobalId = "c40f7ab8-d0db-4f6b-811e-837dc0ba8ce7";
const ingredientGlobalId = "7447115b-e944-465d-a4c4-53e54a4f4a1d";
const locationGlobalId = "ddcc591a-67e9-4af9-9b2c-d618f49b3bc3";
const unitGlobalId = "350e9e2f-8e33-44ec-92b0-e696a9f51548";
const recipeVersionGlobalId = "9c66ef65-7373-4ca2-ac10-f737955f724e";
const supplierGlobalId = "13bfa1d7-1a74-4b6c-b399-0658e7f1afdb";
const newIngredientGlobalId = "bc47a0f7-00f1-4bcb-9dce-08fbab32bfca";
const purchaseOrderGlobalId = "294188d3-1cec-4ec7-8151-5029b41e1e07";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function makeCommand(input: { operationId: string; idempotencyKey: string; customerGlobalId: string; name?: string; action?: "create" | "update" | "delete"; baseRevision?: number; dependencies?: string[] }) {
  const payload = input.action === "delete" ? { customerGlobalId: input.customerGlobalId } : { customerGlobalId: input.customerGlobalId, values: { name: input.name!, email: `${input.name!.toLowerCase().replaceAll(" ", "-")}@sync.test`, phone: null, status: "active" } };
  return {
    operationId: input.operationId,
    deviceId,
    organizationId,
    branchGlobalId,
    registerGlobalId,
    actorGlobalId,
    domain: "customers",
    action: input.action ?? "create",
    schemaVersion: 1,
    payload,
    payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"),
    idempotencyKey: input.idempotencyKey,
    baseRevision: input.baseRevision ?? 0,
    dependencies: input.dependencies ?? [],
    deviceTimestamp: new Date().toISOString(),
  };
}

function makeProductCommand(input: { operationId: string; idempotencyKey: string; productGlobalId: string; name?: string; action?: "create" | "update" | "delete"; baseRevision?: number; dependencies?: string[] }) {
  const payload = input.action === "delete" ? { productGlobalId: input.productGlobalId } : { productGlobalId: input.productGlobalId, values: { name: input.name!, description: null, price: 425, in_stock: 7, category: null, imageKey: "media/opaque.webp" } };
  return {
    operationId: input.operationId,
    deviceId,
    organizationId,
    branchGlobalId,
    registerGlobalId,
    actorGlobalId,
    domain: "products",
    action: input.action ?? "create",
    schemaVersion: 1,
    payload,
    payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"),
    idempotencyKey: input.idempotencyKey,
    baseRevision: input.baseRevision ?? 0,
    dependencies: input.dependencies ?? [],
    deviceTimestamp: new Date().toISOString(),
  };
}

function makeShiftCommand(input: { operationId: string; idempotencyKey: string; shiftGlobalId: string }) {
  const payload = { shiftGlobalId: input.shiftGlobalId, registerGlobalId, openingFloat: 3500, openedAt: new Date().toISOString() };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "shifts", action: "open", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeCashMovementCommand(input: { operationId: string; idempotencyKey: string; movementGlobalId: string; shiftGlobalId: string; dependency: string }) {
  const payload = { cashMovementGlobalId: input.movementGlobalId, shiftGlobalId: input.shiftGlobalId, type: "cash_in", amount: 500, reason: "Drawer top up", createdAt: new Date().toISOString() };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "shifts", action: "drawer_adjust", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: [input.dependency], deviceTimestamp: new Date().toISOString() };
}

function makeShiftCloseCommand(input: { operationId: string; idempotencyKey: string; shiftGlobalId: string; expectedCash: number; dependency: string }) {
  const payload = { shiftGlobalId: input.shiftGlobalId, expectedCash: input.expectedCash, closingCash: input.expectedCash, closedAt: new Date().toISOString() };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "shifts", action: "close", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: [input.dependency], deviceTimestamp: new Date().toISOString() };
}

function makeOrderCommand(input: { operationId: string; idempotencyKey: string; orderGlobalId: string; clientRequestId: string }) {
  const payload = { orderGlobalId: input.orderGlobalId, branchGlobalId, customerGlobalId: null, diningTableGlobalId: null, orderType: "takeaway", deliveryAddress: null, clientRequestId: input.clientRequestId, shiftGlobalId: null, items: [{ menuItemGlobalId: menuItemGlobalId, variantGlobalId: null, modifierOptionGlobalIds: [], quantity: 1, notes: "No onions" }] };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "orders", action: "create", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeOrderTransitionCommand(input: { operationId: string; idempotencyKey: string; orderGlobalId: string; status: "confirmed" | "preparing" | "ready"; dependencies: string[]; baseRevision?: number; overrideReason?: string }) {
  const payload = { orderGlobalId: input.orderGlobalId, status: input.status, note: "Device kitchen update", inventoryOverrideReason: input.overrideReason ?? null };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "orders", action: "transition", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: input.baseRevision ?? 1, dependencies: input.dependencies, deviceTimestamp: new Date().toISOString() };
}

function makeCheckoutCommand(input: { operationId: string; idempotencyKey: string; checkoutGlobalId: string; orderGlobalId: string; shiftGlobalId: string; paymentGlobalIds: string[]; transactionGlobalIds: string[]; dependencies: string[] }) {
  const payload = { checkoutGlobalId: input.checkoutGlobalId, orderGlobalId: input.orderGlobalId, shiftGlobalId: input.shiftGlobalId, discount: null, payments: [{ code: "CASH", amount: 125, tenderedAmount: 150 }, { code: "CARD", amount: 125, tenderedAmount: null }], paymentGlobalIds: input.paymentGlobalIds, transactionGlobalIds: input.transactionGlobalIds };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "checkout", action: "pay", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: input.dependencies, deviceTimestamp: new Date().toISOString() };
}

function makePrintCommand(input: { operationId: string; idempotencyKey: string; jobGlobalId: string; orderGlobalId: string; shiftGlobalId: string; dependencies: string[]; documentType?: "receipt" | "kot"; stationId?: string | null; isReprint?: boolean; reprintReason?: string | null }) {
  const payload = { jobGlobalId: input.jobGlobalId, orderGlobalId: input.orderGlobalId, shiftGlobalId: input.shiftGlobalId, stationGlobalId: input.stationId ?? null, documentType: input.documentType ?? "receipt", isReprint: input.isReprint ?? false, reprintReason: input.reprintReason ?? null, copyCount: 1, paperWidth: 80, language: "bilingual" };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "printing", action: "request", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: input.dependencies, deviceTimestamp: new Date().toISOString() };
}

function makePrintTransition(input: { operationId: string; idempotencyKey: string; jobGlobalId: string; orderGlobalId: string; status: "previewed" | "acknowledged"; dependency: string }) {
  const payload = { jobGlobalId: input.jobGlobalId, orderGlobalId: input.orderGlobalId, status: input.status, errorMessage: null };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "printing", action: "transition", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: [input.dependency], deviceTimestamp: new Date().toISOString() };
}

function makeCancellationCommand(input: { operationId: string; idempotencyKey: string; cancellationGlobalId: string; orderGlobalId: string; shiftGlobalId: string; checkoutGlobalId: string; originalPaymentGlobalIds: string[]; refundGlobalIds: string[]; transactionGlobalIds: string[]; dependencies: string[] }) {
  const payload = { cancellationGlobalId: input.cancellationGlobalId, orderGlobalId: input.orderGlobalId, shiftGlobalId: input.shiftGlobalId, checkoutGlobalId: input.checkoutGlobalId, originalPaymentGlobalIds: input.originalPaymentGlobalIds, reason: "Customer requested cancellation", inventoryDisposition: "returned_unused", refundGlobalIds: input.refundGlobalIds, transactionGlobalIds: input.transactionGlobalIds };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "checkout", action: "cancel", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: 0, dependencies: input.dependencies, deviceTimestamp: new Date().toISOString() };
}

function makeStockAdjustmentCommand() {
  const payload = { movementGlobalId: "8075f850-2853-4b90-a9f3-2d7294df0d0a", ingredientGlobalId, locationGlobalId, direction: "positive", opening: false, quantityBase: 2_500, unitCostMicros: 125, reason: "Offline supplier correction", override: false, idempotencyKey: "stock-adjustment-sync-001" };
  return { operationId: "82867db8-c9a8-4c8e-85be-f5b99f2e6e55", deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "inventory", action: "adjust", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: "stock-adjustment-command-001", baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeSupplierCommand() {
  const payload = { supplierGlobalId, values: { code: "SYNC-SUP", nameEn: "Sync Supplier", nameAr: "مورد", contactName: null, phone: null, email: null, address: null, notes: "Paired device supplier" } };
  return { operationId: "48488adb-15ce-4d67-bc95-4d180e932611", deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "suppliers", action: "create", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: "supplier-sync-create-001", baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeIngredientCommand() {
  const payload = { ingredientGlobalId: newIngredientGlobalId, values: { sku: "SYNC-NEW", nameEn: "New ingredient", nameAr: "مكون جديد", dimension: "mass", tracked: true, reorderLevel: 12, lowStockThreshold: 3, parLevel: null, allowNegative: false, categoryCode: "BASE", locationCode: "MAIN", unitCode: "SYNC-G" } };
  return { operationId: "d0523796-e9eb-457f-9656-91f238bf55c9", deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "inventory", action: "ingredient_create", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: "ingredient-create-sync-001", baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeRecipeCommand() {
  const payload = { recipeVersionGlobalId, menuItemGlobalId, variantGlobalId: null, version: 2, yieldLossBps: 0, components: [{ ingredientGlobalId, locationGlobalId, unitGlobalId, modifierOptionGlobalId: null, quantityScaled: 100_000 }] };
  return { operationId: "0db8334f-1b60-4b1a-9fe8-9b9b398e11d5", deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "inventory", action: "recipe_create", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: "recipe-create-sync-001", baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makePurchaseOrderCommand(input: { action: string; operationId: string; idempotencyKey: string; baseRevision?: number; reason?: string }) {
  const commandLine = { ingredientGlobalId, unitGlobalId, packageConversionGlobalId: null, packageConversionCode: null, quantityScaled: 2_000, unitPriceMinor: 125, notes: null };
  const payload = input.action === "purchase_order_create"
    ? { purchaseOrderGlobalId, supplierGlobalId, poNumber: "PO-SYNC-01", expectedDate: null, notes: "No stock effect before receiving", supplierSnapshot: { code: "SYNC-SUP", nameEn: "Sync Supplier", nameAr: "مورد" }, lines: [commandLine] }
    : input.action === "purchase_order_lines_update"
      ? { purchaseOrderGlobalId, baseRevision: input.baseRevision ?? 1, poNumber: "PO-SYNC-01", lines: [{ ...commandLine, quantityScaled: 3_000 }] }
      : input.action === "purchase_order_cancel"
        ? { purchaseOrderGlobalId, baseRevision: input.baseRevision ?? 1, expectedStatus: "draft", reason: input.reason ?? "Cancelled before approval" }
        : { purchaseOrderGlobalId, baseRevision: input.baseRevision ?? 1, expectedStatus: input.action === "purchase_order_submit" ? "draft" : "submitted" };
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "procurement", action: input.action, schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: input.baseRevision ?? 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
}

function makeSupplyMutation(input: { domain: "procurement" | "receiving" | "supplier_returns"; action: string; operationId: string; idempotencyKey: string; payload: Record<string, unknown>; baseRevision?: number; dependencies?: string[] }) {
  return { operationId: input.operationId, deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: input.domain, action: input.action, schemaVersion: 1, payload: input.payload, payloadHash: createHash("sha256").update(stableJson(input.payload)).digest("hex"), idempotencyKey: input.idempotencyKey, baseRevision: input.baseRevision ?? 0, dependencies: input.dependencies ?? [], deviceTimestamp: new Date().toISOString() };
}

async function postCommands(commands: unknown[]) {
  return POST(new NextRequest("http://localhost/api/sync/commands", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId },
    body: JSON.stringify({ commands }),
  }));
}

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values({ id: "central-owner", name: "Central Owner", email: "central-owner@sync.test", emailVerified: false });
  const [branch] = await db.insert(branches).values({ code: "SYNC", name_en: "Sync", name_ar: "مزامنة", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
  centralBranchId = branch!.id;
  const [register] = await db.insert(cashierRegisters).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", is_active: true }).returning();
  await db.insert(staffAssignments).values({ user_id: "central-owner", branch_id: branch!.id, role: "owner", is_active: true });
  await db.insert(syncOrganizations).values({ id: organizationId, name: "Sync Organization" });
  await db.insert(syncDevices).values({ id: deviceId, organization_id: organizationId, display_name: "Device A", credential_hash: createHash("sha256").update(credential).digest("hex"), branch_id: branch!.id, register_id: register!.id, status: "paired" });
  await db.insert(syncGlobalEntities).values([
    { organization_id: organizationId, branch_id: branch!.id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branch!.id) },
    { organization_id: organizationId, branch_id: branch!.id, entity_type: "register", global_id: registerGlobalId, local_id: String(register!.id) },
    { organization_id: organizationId, branch_id: branch!.id, entity_type: "user", global_id: actorGlobalId, local_id: "central-owner" },
  ]);
  await db.insert(syncEntityMappings).values([
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branch!.id) },
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "register", global_id: registerGlobalId, local_id: String(register!.id) },
  ]);
  const [station] = await db.insert(kitchenStations).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", is_active: true }).returning();
  await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: branch!.id, entity_type: "kitchen_station", global_id: stationGlobalId, local_id: String(station!.id) });
  await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "kitchen_station", global_id: stationGlobalId, local_id: String(station!.id) });
  const [category] = await db.insert(menuCategories).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", sort_order: 1, is_active: true }).returning();
  const [menuItem] = await db.insert(menuItems).values({ category_id: category!.id, kitchen_station_id: station!.id, code: "SYNC-ITEM", name_en: "Sync item", name_ar: "صنف", base_price: 250, is_available: true, sort_order: 1 }).returning();
  const [location] = await db.insert(inventoryLocations).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", is_active: true }).returning();
  const [ingredientCategory] = await db.insert(ingredientCategories).values({ branch_id: branch!.id, code: "BASE", name_en: "Base", name_ar: "أساسي", is_active: true }).returning();
  const [unit] = await db.insert(unitsOfMeasure).values({ code: "SYNC-G", name_en: "Gram", name_ar: "جرام", dimension: "mass", base_numerator: 1_000, base_denominator: 1 }).returning();
  const [ingredient] = await db.insert(ingredients).values({ branch_id: branch!.id, category_id: ingredientCategory!.id, sku: "SYNC-BASE", name_en: "Base", name_ar: "أساسي", base_unit_id: unit!.id, dimension: "mass", default_location_id: location!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 100, created_by: "central-owner", updated_by: "central-owner" }).returning();
  await db.insert(stockBalances).values({ branch_id: branch!.id, location_id: location!.id, ingredient_id: ingredient!.id, quantity_base: 100_000_000, average_unit_cost_micros: 100 });
  await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: branch!.id, entity_type: "unit_of_measure", global_id: unitGlobalId, local_id: String(unit!.id) });
  await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "unit_of_measure", global_id: unitGlobalId, local_id: String(unit!.id) });
  await db.insert(syncGlobalEntities).values([
    { organization_id: organizationId, branch_id: branch!.id, entity_type: "ingredient", global_id: ingredientGlobalId, local_id: String(ingredient!.id) },
    { organization_id: organizationId, branch_id: branch!.id, entity_type: "inventory_location", global_id: locationGlobalId, local_id: String(location!.id) },
  ]);
  await db.insert(syncEntityMappings).values([
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "ingredient", global_id: ingredientGlobalId, local_id: String(ingredient!.id) },
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "inventory_location", global_id: locationGlobalId, local_id: String(location!.id) },
  ]);
  const [recipe] = await db.insert(recipeVersions).values({ branch_id: branch!.id, menu_item_id: menuItem!.id, version: 1, status: "active", effective_at: new Date(), yield_loss_bps: 0, authored_by: "central-owner", approved_by: "central-owner", approved_at: new Date() }).returning();
  await db.insert(recipeComponents).values({ recipe_version_id: recipe!.id, ingredient_id: ingredient!.id, source_location_id: location!.id, unit_id: unit!.id, quantity_input_scaled: 100_000, quantity_base: 100_000_000 });
  await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: branch!.id, entity_type: "menu_item", global_id: menuItemGlobalId, local_id: String(menuItem!.id) });
  await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "menu_item", global_id: menuItemGlobalId, local_id: String(menuItem!.id) });
});

afterAll(async () => { await pg.close(); });

describe("paired customer command processing", () => {
  it("registers a validated handler and reconciliation importer for each supported command", () => {
    const commandNames = Object.keys(SYNC_COMMAND_REGISTRY).sort();
    expect(commandNames).toEqual([
      "checkout.cancel", "checkout.pay", "customers.create", "customers.delete", "customers.update", "inventory.adjust", "inventory.ingredient_archive", "inventory.ingredient_create", "inventory.ingredient_update",
      "inventory.recipe_activate", "inventory.recipe_create",
      "orders.create", "orders.transition", "orders.update", "printing.request", "printing.settings_update", "printing.transition",
      "procurement.purchase_order_approve", "procurement.purchase_order_cancel", "procurement.purchase_order_create", "procurement.purchase_order_lines_update", "procurement.purchase_order_submit",
      "products.create", "products.delete", "products.update", "receiving.receipt_create", "receiving.receipt_edit", "receiving.receipt_post", "receiving.receipt_reverse",
      "shifts.close", "shifts.drawer_adjust", "shifts.open",
      "supplier_returns.return_approve", "supplier_returns.return_cancel", "supplier_returns.return_create", "supplier_returns.return_dispatch", "supplier_returns.return_edit", "supplier_returns.return_reverse", "supplier_returns.return_submit",
      "suppliers.archive", "suppliers.create", "suppliers.update",
    ]);
    for (const command of Object.values(SYNC_COMMAND_REGISTRY)) {
      expect(typeof command.schema.safeParse).toBe("function");
      expect(command.handler.length).toBeGreaterThan(0);
      expect(command.importer.length).toBeGreaterThan(0);
    }
  });

  it("applies a stock adjustment exactly once and exports an immutable typed movement snapshot", async () => {
    const command = makeStockAdjustmentCommand();
    expect((await (await postCommands([command])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    const [movement] = await db.select().from(stockMovements).where(eq(stockMovements.idempotency_key, command.payload.idempotencyKey));
    const [ingredient] = await db.select().from(ingredients).where(eq(ingredients.sku, "SYNC-BASE"));
    const [balance] = await db.select().from(stockBalances).where(eq(stockBalances.ingredient_id, ingredient!.id));
    expect(movement).toMatchObject({ direction: 1, quantity_base: 2_500, unit_cost_micros: 125, reason: "Offline supplier correction" });
    expect(balance?.quantity_base).toBe(100_002_500);
    expect((await db.select().from(stockMovements).where(eq(stockMovements.idempotency_key, command.payload.idempotencyKey))).length).toBe(1);
    const response = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await response.json()).changes as Array<{ entityGlobalId: string; snapshot: Record<string, unknown> | null }>;
    expect(changes.find((change) => change.entityGlobalId === command.payload.movementGlobalId)?.snapshot).toMatchObject({ ingredientGlobalId, locationGlobalId, direction: 1, quantityBase: 2_500, unitCostMicros: 125, sourceType: "inventory_adjustment" });
  });

  it("applies supplier creation once and exports its branch-scoped UUID snapshot", async () => {
    const command = makeSupplierCommand();
    expect((await (await postCommands([command])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    let created = await db.query.suppliers.findFirst({ where: eq(suppliers.code, "SYNC-SUP") });
    expect(created).toMatchObject({ branch_id: centralBranchId, name_en: "Sync Supplier", is_active: true });
    expect((await db.select().from(suppliers).where(eq(suppliers.code, "SYNC-SUP"))).length).toBe(1);
    const updatePayload = { supplierGlobalId, values: { ...command.payload.values, nameEn: "Updated Sync Supplier" }, baseRevision: 1 };
    const updateCommand = { ...command, operationId: "9c64d171-ae7e-4449-8a9c-29b1cf7835a0", action: "update", payload: updatePayload, payloadHash: createHash("sha256").update(stableJson(updatePayload)).digest("hex"), idempotencyKey: "supplier-sync-update-001", baseRevision: 1 };
    expect((await (await postCommands([updateCommand])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([updateCommand])).json()).results[0].status).toBe("already_applied");
    created = await db.query.suppliers.findFirst({ where: eq(suppliers.code, "SYNC-SUP") });
    expect(created?.name_en).toBe("Updated Sync Supplier");
    const archivePayload = { supplierGlobalId, reason: "Supplier record verified for archive", baseRevision: 2, values: { ...updatePayload.values, isActive: true } };
    const archiveCommand = { ...command, operationId: "b45d8eef-9187-42d8-a76b-343f9d89fc36", action: "archive", payload: archivePayload, payloadHash: createHash("sha256").update(stableJson(archivePayload)).digest("hex"), idempotencyKey: "supplier-sync-archive-001", baseRevision: 2 };
    expect((await (await postCommands([archiveCommand])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([archiveCommand])).json()).results[0].status).toBe("already_applied");
    created = await db.query.suppliers.findFirst({ where: eq(suppliers.code, "SYNC-SUP") });
    expect(created?.is_active).toBe(false);
    const response = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await response.json()).changes as Array<{ entityGlobalId: string; snapshot: Record<string, unknown> | null }>;
    expect(changes.find((change) => change.entityGlobalId === supplierGlobalId)?.snapshot).toMatchObject({ code: "SYNC-SUP", nameEn: "Updated Sync Supplier", isActive: false, updatedByGlobalId: actorGlobalId });
  });

  it("applies draft purchase-order edits and lifecycle without stock effects", async () => {
    await db.update(suppliers).set({ is_active: true }).where(eq(suppliers.code, "SYNC-SUP"));
    const beforeMovements = (await db.select().from(stockMovements)).length;
    const create = makePurchaseOrderCommand({ action: "purchase_order_create", operationId: "1783c165-a895-4658-9fe3-6295af8ad8be", idempotencyKey: "po-sync-create-001" });
    expect((await (await postCommands([create])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([create])).json()).results[0].status).toBe("already_applied");
    let order = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.po_number, "PO-SYNC-01"), with: { lines: true } });
    expect(order).toMatchObject({ status: "draft", receiving_status: "not_received", subtotal_amount: 250, total_amount: 250 });
    const update = makePurchaseOrderCommand({ action: "purchase_order_lines_update", operationId: "4e79b44c-32f1-43fd-9e26-af69543f8fe9", idempotencyKey: "po-sync-lines-001", baseRevision: 1 });
    expect((await (await postCommands([update])).json()).results[0].status).toBe("accepted");
    order = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.po_number, "PO-SYNC-01"), with: { lines: true } });
    expect(order?.lines[0]?.quantity_input_scaled).toBe(3_000);
    const submit = makePurchaseOrderCommand({ action: "purchase_order_submit", operationId: "02bf7992-5ef4-4575-a139-a93cb6dcde1b", idempotencyKey: "po-sync-submit-001", baseRevision: 2 });
    expect((await (await postCommands([submit])).json()).results[0].status).toBe("accepted");
    const approve = makePurchaseOrderCommand({ action: "purchase_order_approve", operationId: "cc61d733-f7d7-4fae-a87a-8ccf061c0a4c", idempotencyKey: "po-sync-approve-001", baseRevision: 3 });
    expect((await (await postCommands([approve])).json()).results[0].status).toBe("accepted");
    order = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.po_number, "PO-SYNC-01"), with: { lines: true } });
    expect(order?.status).toBe("approved");
    expect((await db.select().from(stockMovements)).length).toBe(beforeMovements);
    const response = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await response.json()).changes as Array<{ entityGlobalId: string; snapshot: Record<string, unknown> | null }>;
    expect(changes.find((change) => change.entityGlobalId === purchaseOrderGlobalId)?.snapshot).toMatchObject({ status: "approved", subtotalAmount: 375, lines: [{ quantityScaled: 3_000, lineTotalAmount: 375 }] });
  });

  it("synchronizes receipt posting, return dispatch and reversal snapshots exactly once", async () => {
    const receiptGlobalId = "c3017869-8cb1-4ee5-901e-2f4e2829586a";
    const createOperation = "db3b1c1a-e442-4319-9ac9-abf5c9e1537e";
    const create = makeSupplyMutation({ domain: "receiving", action: "receipt_create", operationId: createOperation, idempotencyKey: "receipt-sync-create-001", dependencies: ["cc61d733-f7d7-4fae-a87a-8ccf061c0a4c"], payload: { receiptGlobalId, purchaseOrderGlobalId, locationGlobalId, receiptNumber: "GRN-SYNC-01", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: new Date().toISOString(), notes: "sync test", lines: [{ poLineIndex: 0, acceptedQuantityScaled: 1_000, rejectedQuantityScaled: 0, damagedQuantityScaled: 0, actualUnitPriceMinor: null, notes: null }] } });
    expect((await (await postCommands([create])).json()).results[0].status).toBe("accepted");
    const receiptId = (await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.receipt_number, "GRN-SYNC-01") }))!.id;
    const stockBeforePost = (await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, (await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-BASE") }))!.id) }))!.quantity_base;
    expect((await db.select().from(stockMovements).where(eq(stockMovements.purchase_receipt_id, receiptId))).length).toBe(0);
    const post = makeSupplyMutation({ domain: "receiving", action: "receipt_post", operationId: "c8ff26aa-572f-492a-8517-7a19f029d8dc", idempotencyKey: "receipt-sync-post-001", baseRevision: 1, dependencies: [createOperation], payload: { receiptGlobalId, baseRevision: 1, approveVariance: false, varianceReason: null, overreceive: false, overreceiveReason: null } });
    expect((await (await postCommands([post])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([post])).json()).results[0].status).toBe("already_applied");
    const postedLines = await db.select().from(stockMovements).where(eq(stockMovements.purchase_receipt_id, receiptId));
    expect(postedLines).toHaveLength(1);
    expect(postedLines[0]).toMatchObject({ movement_type: "purchase_receipt", direction: 1 });
    const returnGlobalId = "76d715f5-477c-4b12-99a4-655493a0c68a";
    const returnCreate = makeSupplyMutation({ domain: "supplier_returns", action: "return_create", operationId: "46cedf05-884b-425b-97fb-765246862b36", idempotencyKey: "return-sync-create-001", dependencies: [post.operationId], payload: { supplierReturnGlobalId: returnGlobalId, receiptGlobalId, returnNumber: "RTV-SYNC-01", reasonCode: "damaged", reason: "Damaged on arrival", notes: null, evidenceMetadata: [], lines: [{ receiptLineIndex: 0, quantityScaled: 100, notes: null }] } });
    expect((await (await postCommands([returnCreate])).json()).results[0].status).toBe("accepted");
    const submit = makeSupplyMutation({ domain: "supplier_returns", action: "return_submit", operationId: "8484090a-66e6-4c32-983a-948aa5184055", idempotencyKey: "return-sync-submit-001", baseRevision: 1, dependencies: [returnCreate.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 1, reason: null, idempotencyKey: "return-sync-submit-hist-001" } });
    expect((await (await postCommands([submit])).json()).results[0].status).toBe("accepted");
    const approve = makeSupplyMutation({ domain: "supplier_returns", action: "return_approve", operationId: "4da2d532-1649-4688-ac44-bcb3dcbd550e", idempotencyKey: "return-sync-approve-001", baseRevision: 2, dependencies: [submit.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 2, reason: "Verified return approval", idempotencyKey: "return-sync-approve-hist-01" } });
    expect((await (await postCommands([approve])).json()).results[0].status).toBe("accepted");
    const dispatch = makeSupplyMutation({ domain: "supplier_returns", action: "return_dispatch", operationId: "202993e2-bf27-4f27-9eb1-3bec8c59b643", idempotencyKey: "return-sync-dispatch-001", baseRevision: 3, dependencies: [approve.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 3, reason: "Handed to supplier", idempotencyKey: "return-sync-dispatch-hist1" } });
    expect((await (await postCommands([dispatch])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([dispatch])).json()).results[0].status).toBe("already_applied");
    const reversal = makeSupplyMutation({ domain: "supplier_returns", action: "return_reverse", operationId: "a5f5d5a4-192e-45d5-8c0d-0247ff0b0f8d", idempotencyKey: "return-sync-reverse-001", baseRevision: 4, dependencies: [dispatch.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 4, reason: "Dispatch entered in error", idempotencyKey: "return-sync-reverse-hist1" } });
    expect((await (await postCommands([reversal])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([reversal])).json()).results[0].status).toBe("already_applied");
    const returnRow = await db.query.supplierReturns.findFirst({ where: eq(supplierReturns.return_number, "RTV-SYNC-01"), with: { lines: true, statusHistory: true, reversals: true } });
    expect(returnRow).toMatchObject({ status: "reversed" });
    expect(returnRow?.statusHistory.length).toBe(5);
    expect(returnRow?.reversals).toHaveLength(1);
    expect((await db.select().from(stockMovements).where(eq(stockMovements.supplier_return_id, returnRow!.id))).length).toBe(2);
    expect((await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, receiptId) }))?.status).toBe("posted");
    const receiptReverse = makeSupplyMutation({ domain: "receiving", action: "receipt_reverse", operationId: "46a2bb6e-8cc4-436e-b8a3-52d0e0381d98", idempotencyKey: "receipt-sync-reverse-001", baseRevision: 2, dependencies: [reversal.operationId], payload: { reversalGlobalId: "69bec583-c35a-46c2-9eef-44f1b037b53a", receiptGlobalId, baseRevision: 2, reason: "Reverse original receipt", idempotencyKey: "receipt-reversal-record-001" } });
    expect((await (await postCommands([receiptReverse])).json()).results[0]).toMatchObject({ status: "needs_review" });
    const receiptAfter = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, receiptId) });
    expect(receiptAfter?.status).toBe("needs_review");
    expect((await db.select().from(stockMovements).where(and(eq(stockMovements.purchase_receipt_id, receiptId), eq(stockMovements.movement_type, "purchase_receipt_reversal")))).length).toBe(0);
    const pull = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await pull.json()).changes as Array<{ cursor: number; entityType: string; entityGlobalId: string; snapshot: Record<string, unknown> | null }>;
    expect(changes.find((change) => change.entityType === "purchase_receipt" && change.entityGlobalId === receiptGlobalId)?.snapshot).toMatchObject({ status: "needs_review", lines: [{ acceptedQuantityBase: expect.any(Number) }], movements: expect.any(Array) });
    expect(changes.find((change) => change.entityType === "supplier_return" && change.entityGlobalId === returnGlobalId)?.snapshot).toMatchObject({ status: "reversed", histories: expect.any(Array), movements: expect.any(Array), reversal: expect.any(Object) });
    const latestReceiptChange = changes.filter((change) => change.entityType === "purchase_receipt" && change.entityGlobalId === receiptGlobalId).at(-1)!;
    const latestReturnChange = changes.filter((change) => change.entityType === "supplier_return" && change.entityGlobalId === returnGlobalId).at(-1)!;
    const actorIdentity = await db.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.global_id, actorGlobalId)) });
    await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: centralBranchId, entity_type: "user", global_id: actorGlobalId, local_id: actorIdentity!.local_id, local_revision: 1, server_revision: 1 }).onConflictDoNothing();
    const beforePeerApply = await db.select().from(stockMovements);
    const previousDesktopMode = process.env.FORNO_DESKTOP_MODE;
    const previousSetupToken = process.env.FORNO_DESKTOP_SETUP_TOKEN;
    const previousDeviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
    process.env.FORNO_DESKTOP_MODE = "1";
    process.env.FORNO_DESKTOP_SETUP_TOKEN = "isolated-sync-test-token";
    process.env.FORNO_DESKTOP_DEVICE_ID = deviceId;
    let applyResponse: Response;
    try {
      const firstReceiptChange = changes.find((change) => change.entityType === "purchase_receipt" && change.entityGlobalId === receiptGlobalId)!;
      const invalidReturnChange = { ...latestReturnChange, snapshot: { ...latestReturnChange.snapshot!, receiptGlobalId: "4dd67c3d-106b-4950-9fb6-6ec8f75066f6" } };
      const beforeFailedImport = {
        receiptLines: (await db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receipt_id, receiptId))).length,
        receiptReversals: (await db.select().from(purchaseReceiptReversals).where(eq(purchaseReceiptReversals.receipt_id, receiptId))).length,
        returnLines: (await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.supplier_return_id, returnRow!.id))).length,
        returnReversals: (await db.select().from(supplierReturnReversals).where(eq(supplierReturnReversals.supplier_return_id, returnRow!.id))).length,
        movements: (await db.select().from(stockMovements)).length,
        mappings: (await db.select().from(syncEntityMappings).where(eq(syncEntityMappings.device_id, deviceId))).length,
        balance: (await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, (await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-BASE") }))!.id) }))!.quantity_base,
      };
      const failedPage = await applyAuthoritativeChanges(new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "isolated-sync-test-token" }, body: JSON.stringify({ changes: [firstReceiptChange, invalidReturnChange], nextCursor: latestReturnChange.cursor }) }), db);
      expect(failedPage.status).toBe(409);
      expect((await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, receiptId) }))?.status).toBe("needs_review");
      expect((await db.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }))?.last_pulled_cursor).toBe(0);
      expect((await db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receipt_id, receiptId))).length).toBe(beforeFailedImport.receiptLines);
      expect((await db.select().from(purchaseReceiptReversals).where(eq(purchaseReceiptReversals.receipt_id, receiptId))).length).toBe(beforeFailedImport.receiptReversals);
      expect((await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.supplier_return_id, returnRow!.id))).length).toBe(beforeFailedImport.returnLines);
      expect((await db.select().from(supplierReturnReversals).where(eq(supplierReturnReversals.supplier_return_id, returnRow!.id))).length).toBe(beforeFailedImport.returnReversals);
      expect((await db.select().from(stockMovements)).length).toBe(beforeFailedImport.movements);
      expect((await db.select().from(syncEntityMappings).where(eq(syncEntityMappings.device_id, deviceId))).length).toBe(beforeFailedImport.mappings);
      expect((await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, (await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-BASE") }))!.id) }))!.quantity_base).toBe(beforeFailedImport.balance);
      applyResponse = await applyAuthoritativeChanges(new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "isolated-sync-test-token" }, body: JSON.stringify({ changes: [latestReturnChange, latestReceiptChange], nextCursor: latestReceiptChange.cursor }) }), db);
      const outboxBeforeReplay = await db.select().from(syncOutbox);
      const replay = await applyAuthoritativeChanges(new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "isolated-sync-test-token" }, body: JSON.stringify({ changes: [latestReturnChange, latestReceiptChange], nextCursor: latestReceiptChange.cursor }) }), db);
      expect(replay.status).toBe(200);
      expect(await db.select().from(syncOutbox)).toEqual(outboxBeforeReplay);
    } finally {
      if (previousDesktopMode === undefined) delete process.env.FORNO_DESKTOP_MODE; else process.env.FORNO_DESKTOP_MODE = previousDesktopMode;
      if (previousSetupToken === undefined) delete process.env.FORNO_DESKTOP_SETUP_TOKEN; else process.env.FORNO_DESKTOP_SETUP_TOKEN = previousSetupToken;
      if (previousDeviceId === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID; else process.env.FORNO_DESKTOP_DEVICE_ID = previousDeviceId;
    }
    expect(applyResponse.status).toBe(200);
    expect((await db.select().from(stockMovements))).toHaveLength(beforePeerApply.length);
    expect((await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, receiptId))).length).toBe(1);
    expect((await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.supplier_return_id, returnRow!.id))).length).toBe(1);
    expect((await db.select().from(purchaseReceiptReversals).where(eq(purchaseReceiptReversals.receipt_id, receiptId))).length).toBe(1);
    expect((await (await postCommands([receiptReverse])).json()).results[0].status).toBe("needs_review");

    const safeReceiptGlobalId = "654a6c0a-f460-4db6-aa8b-52c85089812c";
    const safeCreate = makeSupplyMutation({ domain: "receiving", action: "receipt_create", operationId: "9a88a85d-55d7-42fa-b8b2-40de12b84429", idempotencyKey: "receipt-sync-safe-create-1", dependencies: ["cc61d733-f7d7-4fae-a87a-8ccf061c0a4c"], payload: { receiptGlobalId: safeReceiptGlobalId, purchaseOrderGlobalId, locationGlobalId, receiptNumber: "GRN-SYNC-02", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: new Date().toISOString(), notes: null, lines: [{ poLineIndex: 0, acceptedQuantityScaled: 100, rejectedQuantityScaled: 0, damagedQuantityScaled: 0, actualUnitPriceMinor: null, notes: null }] } });
    expect((await (await postCommands([safeCreate])).json()).results[0].status).toBe("accepted");
    const safePost = makeSupplyMutation({ domain: "receiving", action: "receipt_post", operationId: "72a16bdc-ed6a-4570-9214-5364e3db7191", idempotencyKey: "receipt-sync-safe-post-1", baseRevision: 1, dependencies: [safeCreate.operationId], payload: { receiptGlobalId: safeReceiptGlobalId, baseRevision: 1, approveVariance: false, varianceReason: null, overreceive: false, overreceiveReason: null } });
    expect((await (await postCommands([safePost])).json()).results[0].status).toBe("accepted");
    const safeReverse = makeSupplyMutation({ domain: "receiving", action: "receipt_reverse", operationId: "696bd568-9a9b-4f4f-bf59-929b6027c49b", idempotencyKey: "receipt-sync-safe-reverse1", baseRevision: 2, dependencies: [safePost.operationId], payload: { reversalGlobalId: "eab8e41f-6a1a-44dc-ad78-d21ded169de5", receiptGlobalId: safeReceiptGlobalId, baseRevision: 2, reason: "Safe receipt correction", idempotencyKey: "receipt-sync-safe-reversal-record" } });
    expect((await (await postCommands([safeReverse])).json()).results[0]).toMatchObject({ status: "accepted", result: { status: "reversed" } });
    expect((await (await postCommands([safeReverse])).json()).results[0].status).toBe("already_applied");
    const safeReceipt = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.receipt_number, "GRN-SYNC-02") });
    expect(safeReceipt?.status).toBe("reversed");
    expect((await db.select().from(stockMovements).where(and(eq(stockMovements.purchase_receipt_id, safeReceipt!.id), eq(stockMovements.movement_type, "purchase_receipt_reversal")))).length).toBe(1);
  });

  it("keeps an unsafe supplier-return reversal in Needs Review without compensating movements", async () => {
    const receiptGlobalId = "854ee9fc-529d-4fb9-864d-cf34fe75ea61";
    const create = makeSupplyMutation({ domain: "receiving", action: "receipt_create", operationId: "a8eeec8a-7b6a-46aa-a5f6-c8027175c4b9", idempotencyKey: "receipt-unsafe-return-create", dependencies: ["cc61d733-f7d7-4fae-a87a-8ccf061c0a4c"], payload: { receiptGlobalId, purchaseOrderGlobalId, locationGlobalId, receiptNumber: "GRN-UNSAFE-RTV", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: new Date().toISOString(), notes: null, lines: [{ poLineIndex: 0, acceptedQuantityScaled: 100, rejectedQuantityScaled: 0, damagedQuantityScaled: 0, actualUnitPriceMinor: null, notes: null }] } });
    expect((await (await postCommands([create])).json()).results[0].status).toBe("accepted");
    const post = makeSupplyMutation({ domain: "receiving", action: "receipt_post", operationId: "2b46ef47-6b59-46d2-9767-550f2eb4c513", idempotencyKey: "receipt-unsafe-return-post", baseRevision: 1, dependencies: [create.operationId], payload: { receiptGlobalId, baseRevision: 1, approveVariance: false, varianceReason: null, overreceive: false, overreceiveReason: null } });
    expect((await (await postCommands([post])).json()).results[0].status).toBe("accepted");
    const receipt = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.receipt_number, "GRN-UNSAFE-RTV"), with: { lines: true } });
    const returnGlobalId = "d9a49121-0559-439c-9470-535f84b280ea";
    const returnCreate = makeSupplyMutation({ domain: "supplier_returns", action: "return_create", operationId: "00ca56c1-dba1-4e4d-b733-8741bf70cc38", idempotencyKey: "return-unsafe-create", dependencies: [post.operationId], payload: { supplierReturnGlobalId: returnGlobalId, receiptGlobalId, returnNumber: "RTV-UNSAFE-01", reasonCode: "damaged", reason: "Damaged", notes: null, evidenceMetadata: [], lines: [{ receiptLineIndex: 0, quantityScaled: 10, notes: null }] } });
    expect((await (await postCommands([returnCreate])).json()).results[0].status).toBe("accepted");
    const submit = makeSupplyMutation({ domain: "supplier_returns", action: "return_submit", operationId: "86d6148d-2bc1-440d-86e6-7335fe006e63", idempotencyKey: "return-unsafe-submit", baseRevision: 1, dependencies: [returnCreate.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 1, reason: null, idempotencyKey: "return-unsafe-submit-history" } });
    expect((await (await postCommands([submit])).json()).results[0].status).toBe("accepted");
    const approve = makeSupplyMutation({ domain: "supplier_returns", action: "return_approve", operationId: "cd99d5d3-dd49-41cc-8964-cb3edc4279cd", idempotencyKey: "return-unsafe-approve", baseRevision: 2, dependencies: [submit.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 2, reason: "Approved", idempotencyKey: "return-unsafe-approve-history" } });
    expect((await (await postCommands([approve])).json()).results[0].status).toBe("accepted");
    const dispatch = makeSupplyMutation({ domain: "supplier_returns", action: "return_dispatch", operationId: "9ba4bb18-3afe-4e57-bef8-415e83e28795", idempotencyKey: "return-unsafe-dispatch", baseRevision: 3, dependencies: [approve.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 3, reason: "Dispatched", idempotencyKey: "return-unsafe-dispatch-history" } });
    expect((await (await postCommands([dispatch])).json()).results[0].status).toBe("accepted");
    const returnRow = await db.query.supplierReturns.findFirst({ where: eq(supplierReturns.return_number, "RTV-UNSAFE-01"), with: { statusHistory: true } });
    const dispatchMovements = await db.select().from(stockMovements).where(eq(stockMovements.supplier_return_id, returnRow!.id));
    const laterActivity = makeStockAdjustmentCommand();
    const laterPayload = { ...laterActivity.payload, movementGlobalId: "a7e77a22-46db-4889-8c3f-5e6bd23fdc8c", idempotencyKey: "return-unsafe-later-stock" };
    const laterCommand = { ...laterActivity, operationId: "fddda9c0-fbc9-4f82-b39d-0eb322d4755e", payload: laterPayload, payloadHash: createHash("sha256").update(stableJson(laterPayload)).digest("hex"), idempotencyKey: "return-unsafe-later-command" };
    expect((await (await postCommands([laterCommand])).json()).results[0].status).toBe("accepted");
    const reverse = makeSupplyMutation({ domain: "supplier_returns", action: "return_reverse", operationId: "be3a770b-16de-4e28-87ef-40f2bb1c27f2", idempotencyKey: "return-unsafe-reverse", baseRevision: 4, dependencies: [dispatch.operationId, laterCommand.operationId], payload: { supplierReturnGlobalId: returnGlobalId, baseRevision: 4, reason: "Check unsafe reversal", idempotencyKey: "return-unsafe-reversal-record" } });
    const first = (await (await postCommands([reverse])).json()).results[0];
    expect(first.status).toBe("needs_review");
    const afterFirst = await db.query.supplierReturns.findFirst({ where: eq(supplierReturns.id, returnRow!.id), with: { statusHistory: true, reversals: true } });
    const afterMovements = await db.select().from(stockMovements).where(eq(stockMovements.supplier_return_id, returnRow!.id));
    expect(afterFirst?.status).toBe("needs_review");
    expect(afterFirst?.statusHistory).toHaveLength(returnRow!.statusHistory.length + 1);
    expect(afterFirst?.statusHistory.at(-1)).toMatchObject({ from_status: "dispatched", to_status: "needs_review" });
    expect(afterFirst?.reversals).toHaveLength(1);
    expect(afterMovements).toHaveLength(dispatchMovements.length);
    expect(afterMovements).toEqual(dispatchMovements);
    expect((await (await postCommands([reverse])).json()).results[0]).toMatchObject({ status: "needs_review", operationId: reverse.operationId });
    expect(await db.select().from(stockMovements).where(eq(stockMovements.supplier_return_id, returnRow!.id))).toHaveLength(dispatchMovements.length);
    expect(afterFirst?.statusHistory).toHaveLength(returnRow!.statusHistory.length + 1);
    expect(await db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receipt_id, receipt!.id))).toHaveLength(1);
  });

  it("revalidates procurement permissions and branch scope before writing", async () => {
    const beforeOrders = (await db.select().from(purchaseOrders)).length;
    const beforeReturns = (await db.select().from(supplierReturns)).length;
    await db.update(staffAssignments).set({ role: "manager" }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
    const managerPayload = { ...makePurchaseOrderCommand({ action: "purchase_order_create", operationId: "d27f64ab-0fc2-4cf3-b1eb-8c32dd22cf2e", idempotencyKey: "manager-po-create" }).payload, purchaseOrderGlobalId: "5a9189b0-108f-49e8-8cca-26055f8a226e", poNumber: "PO-MANAGER-SYNC" };
    const managerCommand = makePurchaseOrderCommand({ action: "purchase_order_create", operationId: "d27f64ab-0fc2-4cf3-b1eb-8c32dd22cf2e", idempotencyKey: "manager-po-create" });
    const managerResult = { ...managerCommand, payload: managerPayload, payloadHash: createHash("sha256").update(stableJson(managerPayload)).digest("hex") };
    expect((await (await postCommands([managerResult])).json()).results[0].status).toBe("accepted");
    expect((await db.select().from(purchaseOrders))).toHaveLength(beforeOrders + 1);
    await db.update(staffAssignments).set({ role: "cashier" }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
    const receipt = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.receipt_number, "GRN-SYNC-01"), with: { lines: true } });
    const deniedPayload = { supplierReturnGlobalId: "e3f56d14-bf49-49c1-b120-3d70f36c3bb3", receiptGlobalId: "c3017869-8cb1-4ee5-901e-2f4e2829586a", returnNumber: "RTV-CASHIER-DENIED", reasonCode: "damaged", reason: "Unauthorized", notes: null, evidenceMetadata: [], lines: [{ receiptLineIndex: 0, quantityScaled: 1, notes: null }] };
    const denied = makeSupplyMutation({ domain: "supplier_returns", action: "return_create", operationId: "2166f6c5-ad53-4904-b1d0-f109d99a8cf8", idempotencyKey: "cashier-return-denied", payload: deniedPayload });
    expect((await (await postCommands([denied])).json()).results[0].status).toBe("rejected");
    expect(await db.select().from(supplierReturns)).toHaveLength(beforeReturns);
    const wrongBranch = { ...managerCommand, operationId: "5ae83092-18a7-4d2c-a2f0-86013fa4ec07", branchGlobalId: "52716c4a-84d4-49c6-ab9d-e302f45f3d9b", idempotencyKey: "wrong-branch-po", payload: { ...managerPayload, purchaseOrderGlobalId: "c6453d4d-2a73-42d4-8d68-9b70ccbd9b5e", poNumber: "PO-WRONG-BRANCH" } };
    wrongBranch.payloadHash = createHash("sha256").update(stableJson(wrongBranch.payload)).digest("hex");
    expect((await (await postCommands([wrongBranch])).json()).results[0].status).toBe("rejected");
    expect((await db.select().from(purchaseOrders))).toHaveLength(beforeOrders + 1);
    expect(receipt?.lines).toHaveLength(1);
    await db.update(staffAssignments).set({ role: "owner" }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
  });

  it("rejects procurement and receiving references owned by another branch without partial writes", async () => {
    const branchBGlobal = "56c9e883-f280-42fa-8ddf-7740ec5b4601";
    const supplierBGlobal = "f8a9a8a2-ccbe-482f-a653-fefcffaaeb17";
    const ingredientBGlobal = "82418fac-0315-483f-8431-f3e96801e81f";
    const locationBGlobal = "8a24c74f-c65e-4e21-8678-3fcd2a2e77c5";
    const poBGlobal = "56c926e4-0e18-4502-9d9a-2c841671ebef";
    const receiptBGlobal = "8a25ed0b-ab5d-4846-a7dc-60e762984b42";
    const returnBGlobal = "489a4ce2-8012-40c8-9d8b-e1445f8d9b96";
    const [branchB] = await db.insert(branches).values({ code: "SYNC-B", name_en: "Branch B", name_ar: "الفرع ب", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
    const [locationB] = await db.insert(inventoryLocations).values({ branch_id: branchB!.id, code: "STORE-B", name_en: "Store B", name_ar: "مخزن ب", is_active: true }).returning();
    const [categoryB] = await db.insert(ingredientCategories).values({ branch_id: branchB!.id, code: "RAW-B", name_en: "Raw B", name_ar: "خام ب", is_active: true }).returning();
    const [ingredientB] = await db.insert(ingredients).values({ branch_id: branchB!.id, category_id: categoryB!.id, sku: "BRANCH-B-ING", name_en: "Branch B ingredient", name_ar: "مكون الفرع ب", base_unit_id: 1, dimension: "mass", default_location_id: locationB!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "central-owner", updated_by: "central-owner" }).returning();
    const [supplierB] = await db.insert(suppliers).values({ branch_id: branchB!.id, code: "BRANCH-B-SUP", name_en: "Branch B supplier", name_ar: "مورد الفرع ب", is_active: true, created_by: "central-owner", updated_by: "central-owner" }).returning();
    await db.insert(ingredientPackageConversions).values({ ingredient_id: ingredientB!.id, code: "CASE-B", name_en: "Case B", name_ar: "عبوة ب", base_numerator: 12_000, base_denominator: 1, is_active: true });
    const [poB] = await db.insert(purchaseOrders).values({ branch_id: branchB!.id, supplier_id: supplierB!.id, supplier_code_snapshot: supplierB!.code, supplier_name_en_snapshot: supplierB!.name_en, supplier_name_ar_snapshot: supplierB!.name_ar, po_number: "PO-BRANCH-B", status: "approved", receiving_status: "not_received", currency: "EGP", subtotal_amount: 10, total_amount: 10, idempotency_key: "cross-branch-po-b", created_by: "central-owner" }).returning();
    const [poLineB] = await db.insert(purchaseOrderLines).values({ purchase_order_id: poB!.id, ingredient_id: ingredientB!.id, unit_id: 1, package_conversion_id: null, ingredient_sku: ingredientB!.sku, ingredient_name_en: ingredientB!.name_en, ingredient_name_ar: ingredientB!.name_ar, unit_code: "SYNC-G", quantity_input_scaled: 1_000, quantity_base: 1_000, conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, unit_price_minor: 10, line_total_amount: 10 }).returning();
    const [receiptB] = await db.insert(purchaseReceipts).values({ branch_id: branchB!.id, purchase_order_id: poB!.id, supplier_id: supplierB!.id, supplier_code_snapshot: supplierB!.code, supplier_name_en_snapshot: supplierB!.name_en, supplier_name_ar_snapshot: supplierB!.name_ar, po_number_snapshot: poB!.po_number, receipt_number: "GRN-BRANCH-B", location_id: locationB!.id, received_by: "central-owner", status: "posted", idempotency_key: "cross-branch-receipt-b", posted_at: new Date() }).returning();
    const [receiptLineB] = await db.insert(purchaseReceiptLines).values({ receipt_id: receiptB!.id, purchase_order_line_id: poLineB!.id, ingredient_id: ingredientB!.id, ingredient_sku_snapshot: ingredientB!.sku, ingredient_name_en_snapshot: ingredientB!.name_en, ingredient_name_ar_snapshot: ingredientB!.name_ar, unit_id: 1, unit_code_snapshot: "SYNC-G", conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, ordered_quantity_base_snapshot: 1_000, po_unit_price_minor_snapshot: 10, quantity_input_scaled: 1_000, accepted_quantity_base: 1_000, rejected_quantity_base: 0, damaged_quantity_base: 0, actual_unit_price_minor: 10, accepted_unit_cost_micros_snapshot: 10_000, balance_quantity_before: 0, balance_unit_cost_before: 0, ingredient_average_unit_cost_before: 0, line_total_amount: 10 }).returning();
    const [returnB] = await db.insert(supplierReturns).values({ branch_id: branchB!.id, supplier_id: supplierB!.id, purchase_order_id: poB!.id, receipt_id: receiptB!.id, location_id: locationB!.id, return_number: "RTV-BRANCH-B", supplier_code_snapshot: supplierB!.code, supplier_name_en_snapshot: supplierB!.name_en, supplier_name_ar_snapshot: supplierB!.name_ar, po_number_snapshot: poB!.po_number, receipt_number_snapshot: receiptB!.receipt_number, reason_code: "damaged", status: "draft", idempotency_key: "cross-branch-return-b", expected_credit_amount: 10, created_by: "central-owner" }).returning();
    await db.insert(supplierReturnLines).values({ supplier_return_id: returnB!.id, receipt_line_id: receiptLineB!.id, ingredient_id: ingredientB!.id, ingredient_sku_snapshot: ingredientB!.sku, ingredient_name_en_snapshot: ingredientB!.name_en, ingredient_name_ar_snapshot: ingredientB!.name_ar, dimension_snapshot: "mass", unit_id: 1, unit_code_snapshot: "SYNC-G", conversion_numerator_snapshot: 1, conversion_denominator_snapshot: 1, quantity_input_scaled: 100, quantity_base: 100, accepted_quantity_base_snapshot: 1_000, original_unit_cost_micros_snapshot: 10_000, expected_credit_amount: 1 });
    await db.insert(syncGlobalEntities).values([
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "branch", global_id: branchBGlobal, local_id: String(branchB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "supplier", global_id: supplierBGlobal, local_id: String(supplierB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "ingredient", global_id: ingredientBGlobal, local_id: String(ingredientB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "inventory_location", global_id: locationBGlobal, local_id: String(locationB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "purchase_order", global_id: poBGlobal, local_id: String(poB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "purchase_receipt", global_id: receiptBGlobal, local_id: String(receiptB!.id) },
      { organization_id: organizationId, branch_id: branchB!.id, entity_type: "supplier_return", global_id: returnBGlobal, local_id: String(returnB!.id) },
    ]);
    const initial = {
      purchaseOrders: (await db.select().from(purchaseOrders)).length,
      purchaseOrderLines: (await db.select().from(purchaseOrderLines)).length,
      receipts: (await db.select().from(purchaseReceipts)).length,
      receiptLines: (await db.select().from(purchaseReceiptLines)).length,
      returns: (await db.select().from(supplierReturns)).length,
      returnLines: (await db.select().from(supplierReturnLines)).length,
      movements: (await db.select().from(stockMovements)).length,
      changes: (await db.select().from(syncChangeLog)).length,
      balances: await db.select().from(stockBalances),
      ingredientCosts: await db.select({ id: ingredients.id, averageUnitCost: ingredients.average_unit_cost_micros }).from(ingredients),
    };
    const makeRejectedPo = (operationId: string, idempotencyKey: string, supplierId: string, ingredientId: string, number: string) => {
      const base = makePurchaseOrderCommand({ action: "purchase_order_create", operationId, idempotencyKey });
      const payload = { ...(base.payload as Record<string, unknown>), purchaseOrderGlobalId: crypto.randomUUID(), supplierGlobalId: supplierId, poNumber: number, lines: [{ ingredientGlobalId: ingredientId, unitGlobalId, packageConversionGlobalId: null, packageConversionCode: ingredientId === ingredientBGlobal ? "CASE-B" : null, quantityScaled: 1_000, unitPriceMinor: 10, notes: null }] };
      return { ...base, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex") };
    };
    const commands = [
      makeRejectedPo("b88a3578-6880-48e7-9fbb-6eab38999901", "cross-po-supplier", supplierBGlobal, ingredientGlobalId, "PO-CROSS-SUPPLIER"),
      makeRejectedPo("b88a3578-6880-48e7-9fbb-6eab38999902", "cross-po-ingredient", supplierGlobalId, ingredientBGlobal, "PO-CROSS-INGREDIENT"),
      makeSupplyMutation({ domain: "receiving", action: "receipt_create", operationId: "b88a3578-6880-48e7-9fbb-6eab38999903", idempotencyKey: "cross-receipt-po", payload: { receiptGlobalId: crypto.randomUUID(), purchaseOrderGlobalId: poBGlobal, locationGlobalId, receiptNumber: "GRN-CROSS-PO", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: new Date().toISOString(), notes: null, lines: [{ poLineIndex: 0, acceptedQuantityScaled: 1, rejectedQuantityScaled: 0, damagedQuantityScaled: 0, actualUnitPriceMinor: null, notes: null }] } }),
      makeSupplyMutation({ domain: "receiving", action: "receipt_create", operationId: "b88a3578-6880-48e7-9fbb-6eab38999904", idempotencyKey: "cross-receipt-location", payload: { receiptGlobalId: crypto.randomUUID(), purchaseOrderGlobalId, locationGlobalId: locationBGlobal, receiptNumber: "GRN-CROSS-LOCATION", supplierDeliveryNote: null, supplierInvoiceReference: null, receivedAt: new Date().toISOString(), notes: null, lines: [{ poLineIndex: 0, acceptedQuantityScaled: 1, rejectedQuantityScaled: 0, damagedQuantityScaled: 0, actualUnitPriceMinor: null, notes: null }] } }),
      makeSupplyMutation({ domain: "supplier_returns", action: "return_create", operationId: "b88a3578-6880-48e7-9fbb-6eab38999905", idempotencyKey: "cross-return-receipt", payload: { supplierReturnGlobalId: crypto.randomUUID(), receiptGlobalId: receiptBGlobal, returnNumber: "RTV-CROSS-RECEIPT", reasonCode: "damaged", reason: null, notes: null, evidenceMetadata: [], lines: [{ receiptLineIndex: 0, quantityScaled: 1, notes: null }] } }),
      makeSupplyMutation({ domain: "procurement", action: "purchase_order_submit", operationId: "b88a3578-6880-48e7-9fbb-6eab38999906", idempotencyKey: "cross-po-lifecycle", baseRevision: 1, payload: { purchaseOrderGlobalId: poBGlobal, baseRevision: 1, expectedStatus: "draft" } }),
      makeSupplyMutation({ domain: "receiving", action: "receipt_post", operationId: "b88a3578-6880-48e7-9fbb-6eab38999907", idempotencyKey: "cross-receipt-lifecycle", baseRevision: 1, payload: { receiptGlobalId: receiptBGlobal, baseRevision: 1, approveVariance: false, varianceReason: null, overreceive: false, overreceiveReason: null } }),
      makeSupplyMutation({ domain: "supplier_returns", action: "return_submit", operationId: "b88a3578-6880-48e7-9fbb-6eab38999908", idempotencyKey: "cross-return-lifecycle", baseRevision: 1, payload: { supplierReturnGlobalId: returnBGlobal, baseRevision: 1, reason: null, idempotencyKey: "cross-return-submit-history" } }),
      makeSupplyMutation({ domain: "supplier_returns", action: "return_dispatch", operationId: "b88a3578-6880-48e7-9fbb-6eab38999909", idempotencyKey: "cross-return-dispatch", baseRevision: 1, payload: { supplierReturnGlobalId: returnBGlobal, baseRevision: 1, reason: "Must remain branch scoped", idempotencyKey: "cross-return-dispatch-history" } }),
    ];
    for (const command of commands) {
      const first = (await (await postCommands([command])).json()).results[0];
      expect(first.status).toBe("rejected");
      const retry = (await (await postCommands([command])).json()).results[0];
      expect(retry.status).toBe("rejected");
      expect(retry.operationId).toBe(command.operationId);
    }
    expect({
      purchaseOrders: (await db.select().from(purchaseOrders)).length,
      purchaseOrderLines: (await db.select().from(purchaseOrderLines)).length,
      receipts: (await db.select().from(purchaseReceipts)).length,
      receiptLines: (await db.select().from(purchaseReceiptLines)).length,
      returns: (await db.select().from(supplierReturns)).length,
      returnLines: (await db.select().from(supplierReturnLines)).length,
      movements: (await db.select().from(stockMovements)).length,
      changes: (await db.select().from(syncChangeLog)).length,
      balances: await db.select().from(stockBalances),
      ingredientCosts: await db.select({ id: ingredients.id, averageUnitCost: ingredients.average_unit_cost_micros }).from(ingredients),
    }).toEqual(initial);
    expect((await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, receiptB!.id))).length).toBe(1);
    expect((await db.select().from(supplierReturns).where(eq(supplierReturns.id, returnB!.id))).length).toBe(1);
  });

  it("creates a branch-scoped ingredient exactly once with thresholds and no stock movement", async () => {
    const command = makeIngredientCommand();
    expect((await (await postCommands([command])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    let created = await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-NEW") });
    expect(created).toMatchObject({ branch_id: centralBranchId, reorder_level: 12, low_stock_threshold: 3, is_active: true });
    expect((await db.select().from(ingredients).where(eq(ingredients.sku, "SYNC-NEW"))).length).toBe(1);
    expect((await db.select().from(stockMovements).where(eq(stockMovements.ingredient_id, created!.id))).length).toBe(0);
    const balance = await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, created!.id) });
    expect(balance).toMatchObject({ quantity_base: 0, average_unit_cost_micros: 0 });
    const updatePayload = { ingredientGlobalId: newIngredientGlobalId, baseRevision: 1, values: { ...command.payload.values, nameEn: "Updated ingredient", lowStockThreshold: 5 } };
    const update = { ...command, operationId: "20bafe1c-9619-4fca-a487-524faad53f9f", action: "ingredient_update", payload: updatePayload, payloadHash: createHash("sha256").update(stableJson(updatePayload)).digest("hex"), idempotencyKey: "ingredient-update-sync-001", baseRevision: 1 };
    expect((await (await postCommands([update])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([update])).json()).results[0].status).toBe("already_applied");
    created = await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-NEW") });
    expect(created).toMatchObject({ name_en: "Updated ingredient", low_stock_threshold: 5 });
    const stalePayload = { ...updatePayload, values: { ...updatePayload.values, nameEn: "Concurrent local edit" } };
    const staleUpdate = { ...update, operationId: "8ccf55e8-b8c7-4e0c-94b8-34ce1e75916e", payload: stalePayload, payloadHash: createHash("sha256").update(stableJson(stalePayload)).digest("hex"), idempotencyKey: "ingredient-update-stale-001" };
    expect((await (await postCommands([staleUpdate])).json()).results[0].status).toBe("needs_review");
    expect((await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-NEW") }))?.name_en).toBe("Updated ingredient");
    const archivePayload = { ingredientGlobalId: newIngredientGlobalId, reason: "Retired ingredient configuration", baseRevision: 2, values: { sku: "SYNC-NEW", isActive: true } };
    const archive = { ...command, operationId: "0c1c0b6d-278a-4d6e-8479-3a43c4576900", action: "ingredient_archive", payload: archivePayload, payloadHash: createHash("sha256").update(stableJson(archivePayload)).digest("hex"), idempotencyKey: "ingredient-archive-sync-001", baseRevision: 2 };
    expect((await (await postCommands([archive])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([archive])).json()).results[0].status).toBe("already_applied");
    created = await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-NEW") });
    expect(created?.is_active).toBe(false);
    expect((await db.select().from(stockMovements).where(eq(stockMovements.ingredient_id, created!.id))).length).toBe(0);
  });

  it("creates and activates immutable recipe history exactly once without stock effects", async () => {
    const beforeMovements = (await db.select().from(stockMovements)).length;
    const create = makeRecipeCommand();
    expect((await (await postCommands([create])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([create])).json()).results[0].status).toBe("already_applied");
    const draft = await db.query.recipeVersions.findFirst({ where: eq(recipeVersions.version, 2), with: { components: true } });
    expect(draft).toMatchObject({ branch_id: centralBranchId, status: "draft", yield_loss_bps: 0 });
    expect(draft?.components[0]).toMatchObject({ ingredient_id: expect.any(Number), source_location_id: expect.any(Number), quantity_input_scaled: 100_000, quantity_base: 100_000_000 });
    const activationPayload = { recipeVersionGlobalId, reason: "Approved central recipe", baseRevision: 1 };
    const activation = { ...create, operationId: "12d78960-0562-4624-a67f-b6ea765d26e7", action: "recipe_activate", payload: activationPayload, payloadHash: createHash("sha256").update(stableJson(activationPayload)).digest("hex"), idempotencyKey: "recipe-activate-sync-001", baseRevision: 1 };
    expect((await (await postCommands([activation])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([activation])).json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(recipeVersions).where(eq(recipeVersions.id, draft!.id)))[0]?.status).toBe("active");
    expect((await db.select().from(recipeVersions).where(eq(recipeVersions.id, 1)))[0]?.status).toBe("retired");
    expect((await db.select().from(stockMovements)).length).toBe(beforeMovements);
    const response = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await response.json()).changes as Array<{ entityGlobalId: string; snapshot: Record<string, unknown> | null }>;
    expect(changes.find((change) => change.entityGlobalId === recipeVersionGlobalId)?.snapshot).toMatchObject({ status: "active", version: 2, yieldLossBps: 0 });
  });

  it("applies print-setting commands once and exports a typed register snapshot", async () => {
    const preferenceGlobalId = "5e707a0a-4c28-45ed-a37a-706b31a3bad6";
    const payload = { preferenceGlobalId, registerGlobalId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 3, updatedAt: new Date().toISOString() };
    const command = { operationId: "0f4f1e9d-5cc5-4d4d-8cdb-dc741c40dfba", deviceId, organizationId, branchGlobalId, registerGlobalId, actorGlobalId, domain: "printing", action: "settings_update", schemaVersion: 1, payload, payloadHash: createHash("sha256").update(stableJson(payload)).digest("hex"), idempotencyKey: "print-settings-test-01", baseRevision: 0, dependencies: [], deviceTimestamp: new Date().toISOString() };
    expect((await (await postCommands([command])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    const response = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const change = (await response.json()).changes.find((item: { entityGlobalId: string }) => item.entityGlobalId === preferenceGlobalId);
    expect(change.snapshot).toMatchObject({ registerGlobalId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 3 });
  });

  it("authenticates the paired device and applies a customer create exactly once", async () => {
    const command = makeCommand({ operationId: "8ce283aa-13f4-44fa-a27c-e45f5d7cc23e", idempotencyKey: "256006e3-46a8-42de-9a3f-49c739da8975", customerGlobalId, name: "Offline Customer" });
    const first = await postCommands([command]);
    expect(first.status).toBe(200);
    expect((await first.json()).results[0].status).toBe("accepted");
    const retry = await postCommands([command]);
    expect((await retry.json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(customers)).length).toBe(1);
    expect((await db.select().from(syncChangeLog).where(eq(syncChangeLog.domain, "customers"))).length).toBe(1);
    expect((await db.select().from(syncCommandInbox).where(eq(syncCommandInbox.domain, "customers"))).length).toBe(1);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "sync.customer.created"))).length).toBe(1);
    const pulled = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const page = await pulled.json();
    const customerChange = page.changes.find((change: { entityGlobalId: string }) => change.entityGlobalId === customerGlobalId);
    expect(customerChange.entityGlobalId).toBe(customerGlobalId);
    expect(customerChange.snapshot.email).toBe("offline-customer@sync.test");
    expect(customerChange.snapshot.user_uid).toBeUndefined();
    expect(page.nextCursor).toBeGreaterThan(0);
  });

  it("rejects reused operation identity with different content and audits it", async () => {
    const original = makeCommand({ operationId: "b7157c37-beca-4d0f-b27c-fd8fb1f0d999", idempotencyKey: "1a690de5-7030-4b10-a283-9ac11f325532", customerGlobalId: "edbc387c-153f-43b4-903a-88651bd62e65", name: "Original" });
    await postCommands([original]);
    const altered = makeCommand({ operationId: original.operationId, idempotencyKey: original.idempotencyKey, customerGlobalId: original.payload.customerGlobalId, name: "Altered" });
    const response = await postCommands([altered]);
    expect((await response.json()).results[0].status).toBe("rejected");
    expect((await db.select().from(customers)).length).toBe(2);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "sync.command.identity_mismatch"))).length).toBe(1);
  });

  it("preserves a concurrent customer edit as Needs Review", async () => {
    const [serverCustomer] = await db.insert(customers).values({ name: "Server Version", email: "server-version@sync.test", user_uid: "central-owner", status: "active" }).returning();
    const globalId = "8dfd2ad9-c289-4ba5-a466-2e17d5276f66";
    const [global] = await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: centralBranchId, entity_type: "customer", global_id: globalId, local_id: String(serverCustomer!.id), server_revision: 2 }).returning();
    await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: centralBranchId, entity_type: "customer", global_id: globalId, local_id: String(serverCustomer!.id), local_revision: 2, server_revision: 2 });
    const command = makeCommand({ operationId: "573e0a23-8280-4656-b29c-7e4b503d26c0", idempotencyKey: "d7e3e01c-2a41-4c00-8903-e6382167a2da", customerGlobalId: globalId, name: "Device Version", action: "update", baseRevision: 1 });
    const response = await postCommands([command]);
    const conflictResult = (await response.json()).results[0];
    expect(conflictResult.status).toBe("needs_review");
    expect((await db.select().from(syncConflicts).where(eq(syncConflicts.entity_global_id, globalId))).length).toBe(1);
    expect((await db.select().from(customers).where(eq(customers.id, serverCustomer!.id)))[0]?.name).toBe("Server Version");
    expect(global?.server_revision).toBe(2);
  });

  it("rejects revoked devices, wrong branch scope, and inactive actors without business writes", async () => {
    const [device] = await db.select().from(syncDevices).where(eq(syncDevices.id, deviceId));
    await db.update(syncDevices).set({ status: "revoked", revoked_at: new Date() }).where(eq(syncDevices.id, deviceId));
    const revoked = await postCommands([makeCommand({ operationId: "d0336702-c798-4b59-84b9-500f238bb2c0", idempotencyKey: "e2cb3784-e6cc-49b7-a7ef-452068c92230", customerGlobalId: "2f8d03e1-5f13-4f42-89ac-0ab12a7dccaa", name: "Revoked" })]);
    expect(revoked.status).toBe(401);
    await db.update(syncDevices).set({ status: "paired", revoked_at: null }).where(eq(syncDevices.id, deviceId));

    const before = (await db.select().from(customers)).length;
    const wrongBranch = makeCommand({ operationId: "cb02a31e-d25e-4aeb-b238-d76e73f76c24", idempotencyKey: "21e3215b-6ce8-458c-8a0a-f674d878d8dd", customerGlobalId: "8bbd4ddb-f019-4053-86a1-f7564273db6f", name: "Wrong Branch" });
    wrongBranch.branchGlobalId = "21a4a147-2ae8-4630-88d0-02eeb7d87917";
    expect((await (await postCommands([wrongBranch])).json()).results[0].status).toBe("rejected");

    await db.update(staffAssignments).set({ is_active: false }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
    const inactiveActor = makeCommand({ operationId: "6e4f9a39-72bc-4d6d-b2df-0d41f9ebcc7a", idempotencyKey: "6cc00486-4756-442c-b398-0b0ed7922d42", customerGlobalId: "fe0b6f0e-edbe-49e0-b663-600a23cd72a4", name: "Inactive Actor" });
    expect((await (await postCommands([inactiveActor])).json()).results[0].status).toBe("rejected");
    expect((await db.select().from(customers)).length).toBe(before);
    await db.update(staffAssignments).set({ is_active: true }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
  });

  it("audits a payload hash mismatch without applying the command", async () => {
    const command = makeCommand({ operationId: "99b10866-c83b-47bb-85ba-f4847cc85ced", idempotencyKey: "40cc081e-a9e9-4b6a-9ba0-a5e663de00ca", customerGlobalId: "9191052f-c5bb-4670-aeb1-117ca0efecb2", name: "Tampered Payload" });
    command.payloadHash = "0".repeat(64);
    const beforeCustomers = (await db.select().from(customers)).length;
    const result = (await (await postCommands([command])).json()).results[0];
    expect(result.status).toBe("rejected");
    expect((await db.select().from(customers)).length).toBe(beforeCustomers);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "sync.command.rejected"))).length).toBe(1);
  });

  it("applies product commands and publishes an opaque media reference without local integer IDs", async () => {
    const productGlobalId = "247d2eca-7c10-4dc2-867f-af94dd7b5c8c";
    const command = makeProductCommand({ operationId: "76fa5c16-9a0a-4c69-b806-9b439c45cb8d", idempotencyKey: "f818e481-a04c-40ab-98ab-5f4fd0d1b447", productGlobalId, name: "Synced Product" });
    const response = await postCommands([command]);
    expect((await response.json()).results[0].status).toBe("accepted");
    const product = await db.query.products.findFirst({ where: eq(products.name, "Synced Product") });
    expect(product?.image_key).toBe("media/opaque.webp");
    const pulled = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const page = await pulled.json();
    const item = page.changes.find((change: { entityGlobalId: string }) => change.entityGlobalId === productGlobalId);
    expect(item.snapshot.imageKey).toBe("media/opaque.webp");
    expect(item.snapshot.id).toBeUndefined();
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    const deletion = makeProductCommand({ operationId: "b47d03e5-3265-40ca-91da-3e9dc662d04e", idempotencyKey: "611d7ab6-e8db-4c8c-b144-8dfbca4942f4", productGlobalId, action: "delete", baseRevision: 1, dependencies: [command.operationId] });
    expect((await (await postCommands([deletion])).json()).results[0].status).toBe("accepted");
    expect(await db.query.products.findFirst({ where: eq(products.name, "Synced Product") })).toBeUndefined();
    expect((await (await postCommands([deletion])).json()).results[0].status).toBe("already_applied");
  });

  it("applies a customer deletion as an idempotent tombstone change", async () => {
    const id = "17e8b0ef-9d8b-44f8-9d97-b8ea984f64f2";
    const create = makeCommand({ operationId: "643980d1-e0db-4fe4-b64a-1a750f09f19a", idempotencyKey: "790f490a-cf2b-4d0b-b7b7-6bdff0edb023", customerGlobalId: id, name: "Deleted Customer" });
    expect((await (await postCommands([create])).json()).results[0].status).toBe("accepted");
    const deletion = makeCommand({ operationId: "0a39d981-6373-48d7-b5fd-42d5d2d32c34", idempotencyKey: "4c089d8b-1a7f-4a79-88e9-6657c8f1b132", customerGlobalId: id, action: "delete", baseRevision: 1, dependencies: [create.operationId] });
    expect((await (await postCommands([deletion])).json()).results[0].status).toBe("accepted");
    expect(await db.query.customers.findFirst({ where: eq(customers.email, "deleted-customer@sync.test") })).toBeUndefined();
    const change = await db.query.syncChangeLog.findFirst({ where: eq(syncChangeLog.entity_global_id, id), orderBy: (table, { desc }) => [desc(table.cursor)] });
    expect(change?.action).toBe("delete");
    expect((await (await postCommands([deletion])).json()).results[0].status).toBe("already_applied");
  });

  it("accepts only paired, hash-verified media for the authoritative product reference", async () => {
    const mediaDirectory = await mkdtemp(join(tmpdir(), "forno-central-media-test-"));
    const oldMediaDirectory = process.env.FORNO_MEDIA_DIR;
    const oldDatabaseRole = process.env.FORNO_DATABASE_ROLE;
    process.env.FORNO_MEDIA_DIR = mediaDirectory;
    process.env.FORNO_DATABASE_ROLE = "test";
    const globalId = "6c5a66bd-5596-47f9-92bf-ab99c64e263a";
    const key = "products/314/12345678-1234-1234-1234-123456789012.png";
    const [product] = await db.insert(products).values({ name: "Media Sync", description: null, price: 100, in_stock: 1, category: null, image_key: key, user_uid: "central-owner" }).returning();
    await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: centralBranchId, entity_type: "product", global_id: globalId, local_id: String(product!.id) });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64");
    const contentHash = createHash("sha256").update(png).digest("hex");
    const requestFor = (hash = contentHash) => {
      const form = new FormData();
      form.set("productGlobalId", globalId);
      form.set("key", key);
      form.set("file", new File([png], "image.png", { type: "image/png" }));
      return new NextRequest("http://localhost/api/sync/media", { method: "POST", headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId, "x-forno-content-sha256": hash }, body: form });
    };
    try {
      expect((await uploadProductMedia(requestFor())).status).toBe(200);
      expect(await readFile(productImagePath(key))).toEqual(png);
      expect((await uploadProductMedia(requestFor())).status).toBe(200);
      expect((await uploadProductMedia(requestFor("0".repeat(64)))).status).toBe(400);
      const unauthorizedForm = new FormData();
      unauthorizedForm.set("productGlobalId", globalId);
      unauthorizedForm.set("key", key);
      unauthorizedForm.set("file", new File([png], "image.png", { type: "image/png" }));
      expect((await uploadProductMedia(new NextRequest("http://localhost/api/sync/media", { method: "POST", body: unauthorizedForm }))).status).toBe(401);
    } finally {
      if (oldMediaDirectory === undefined) delete process.env.FORNO_MEDIA_DIR;
      else process.env.FORNO_MEDIA_DIR = oldMediaDirectory;
      if (oldDatabaseRole === undefined) delete process.env.FORNO_DATABASE_ROLE;
      else process.env.FORNO_DATABASE_ROLE = oldDatabaseRole;
      await rm(mediaDirectory, { recursive: true, force: true });
    }
  });

  it("applies a shift-open command once and preserves register-overlap conflicts", async () => {
    await db.insert(paymentMethods).values({ code: "CASH", name: "Cash", affects_drawer: true, is_active: true });
    const shiftGlobalId = "aa988aab-2770-4e50-b098-ccab0ace21b1";
    const command = makeShiftCommand({ operationId: "a3d24ee8-2975-4109-8cd1-59998b97ab8d", idempotencyKey: "a1d96d93-48bb-4456-9741-ad4465ef1845", shiftGlobalId });
    expect((await (await postCommands([command])).json()).results[0].status).toBe("accepted");
    expect((await db.select().from(cashierShifts).where(eq(cashierShifts.status, "open"))).length).toBe(1);
    const changes = await (await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }))).json();
    const shiftChange = changes.changes.find((change: { entityGlobalId: string }) => change.entityGlobalId === shiftGlobalId);
    expect(shiftChange.snapshot.registerGlobalId).toBe(registerGlobalId);
    expect(shiftChange.snapshot.openingFloat).toBe(3500);
    expect((await (await postCommands([command])).json()).results[0].status).toBe("already_applied");
    const cashMovement = makeCashMovementCommand({ operationId: "c117ee8d-6e0e-454a-9204-f39c42f1267d", idempotencyKey: "b223645c-2d0e-423d-bc67-56be5a6a12cc", movementGlobalId: "6d332b5a-6085-4c84-848f-f1953c8f8aed", shiftGlobalId, dependency: command.operationId });
    expect((await (await postCommands([cashMovement])).json()).results[0].status).toBe("accepted");
    expect((await db.select().from(shiftCashMovements)).length).toBe(1);
    expect((await db.select().from(transactions).where(eq(transactions.category, "cash_in"))).length).toBe(1);
    expect((await (await postCommands([cashMovement])).json()).results[0].status).toBe("already_applied");
    await db.update(staffAssignments).set({ role: "cashier" }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
    const deniedMovement = makeCashMovementCommand({ operationId: "3461d3c0-f6b3-4fcf-b70d-b44ae5f530c2", idempotencyKey: "1c29c75e-4b08-4905-8b12-c559ff6cf604", movementGlobalId: "622cefea-121f-4b94-901a-06f8fce4a22d", shiftGlobalId, dependency: command.operationId });
    expect((await (await postCommands([deniedMovement])).json()).results[0].status).toBe("rejected");
    expect((await db.select().from(shiftCashMovements)).length).toBe(1);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "sync.permission_denied"))).length).toBe(1);
    await db.update(staffAssignments).set({ role: "owner" }).where(and(eq(staffAssignments.user_id, "central-owner"), eq(staffAssignments.branch_id, centralBranchId)));
    const overlapping = makeShiftCommand({ operationId: "37d7334d-a8dc-4f05-96b7-a1903ea7077f", idempotencyKey: "ad4bdcf0-f748-458c-bc12-4a80e7749455", shiftGlobalId: "9c7dc744-a4b3-4a22-86c1-0256adac36ea" });
    expect((await (await postCommands([overlapping])).json()).results[0].status).toBe("needs_review");
    expect((await db.select().from(cashierShifts).where(eq(cashierShifts.status, "open"))).length).toBe(1);
    expect((await db.select().from(syncConflicts).where(eq(syncConflicts.entity_global_id, overlapping.payload.shiftGlobalId))).length).toBe(1);
    const staleClose = makeShiftCloseCommand({ operationId: "baf18b5f-63b9-4023-bc28-91018a73a2ce", idempotencyKey: "af7d25e7-3f37-4bd9-875a-1f12e1227e15", shiftGlobalId, expectedCash: 3500, dependency: cashMovement.operationId });
    expect((await (await postCommands([staleClose])).json()).results[0].status).toBe("needs_review");
    expect((await (await postCommands([staleClose])).json()).results[0].status).toBe("needs_review");
    expect((await db.select().from(cashierShifts).where(eq(cashierShifts.status, "open"))).length).toBe(1);
    const close = makeShiftCloseCommand({ operationId: "a4153b68-5f30-4126-b04f-69a57c012cab", idempotencyKey: "2f23bb93-0e17-4334-88d2-679bb3c81c10", shiftGlobalId, expectedCash: 4000, dependency: cashMovement.operationId });
    expect((await (await postCommands([close])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([close])).json()).results[0].status).toBe("already_applied");
    const closedShift = await db.query.cashierShifts.findFirst({ where: eq(cashierShifts.status, "closed") });
    expect(closedShift?.expected_cash).toBe(4000);
    expect(closedShift?.closing_cash).toBe(4000);
    const closeChanges = await (await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }))).json();
    const closeChange = closeChanges.changes.find((change: { action: string; entityGlobalId: string }) => change.action === "close" && change.entityGlobalId === shiftGlobalId);
    expect(closeChange.snapshot.expectedCash).toBe(4000);
  });
});

describe("paired order command processing", () => {
  it("applies an order command exactly once and exports a global-ID-only snapshot", async () => {
    const command = makeOrderCommand({ operationId: "c84ec790-967e-481f-a011-331ee73083de", idempotencyKey: "dc34b60f-a2d0-435c-8ad9-89dfd6e3e5f8", orderGlobalId: "31de3057-7f4d-4f7f-90c3-2d0ee1fb2654", clientRequestId: "central-order-sync-001" });
    const before = (await db.select().from(orders)).length;
    const first = await postCommands([command]);
    expect((await first.json()).results[0].status).toBe("accepted");
    const retry = await postCommands([command]);
    expect((await retry.json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(orders))).toHaveLength(before + 1);
    const pull = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const changes = (await pull.json()).changes as Array<{ domain: string; entityType: string; snapshot: Record<string, unknown> | null }>;
    const orderChange = changes.find((change) => change.domain === "orders" && change.entityType === "order");
    expect(orderChange?.snapshot?.clientRequestId).toBe("central-order-sync-001");
    expect(orderChange?.snapshot?.branchGlobalId).toBe(branchGlobalId);
    expect(JSON.stringify(Object.keys(orderChange?.snapshot ?? {}))).not.toContain("branch_id");
    const updatePayload = { orderGlobalId: command.payload.orderGlobalId, status: "pending", note: "Keep pending", inventoryOverrideReason: null };
    const updateCommand = { ...command, operationId: "2c873e10-51e9-4c51-b359-a008b5e20122", domain: "orders", action: "update", payload: updatePayload, payloadHash: createHash("sha256").update(stableJson(updatePayload)).digest("hex"), idempotencyKey: "order-update-idempotency-01", baseRevision: 1, dependencies: [command.operationId] };
    expect((await (await postCommands([updateCommand])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([updateCommand])).json()).results[0].status).toBe("already_applied");
  });

  it("processes shift, split-safe checkout, and print acknowledgement in dependency order exactly once", async () => {
    const orderGlobalId = "31de3057-7f4d-4f7f-90c3-2d0ee1fb2654";
    const orderOperationId = "c84ec790-967e-481f-a011-331ee73083de";
    const shiftOpen = makeShiftCommand({ operationId: "ed13a43d-879e-4b13-b8b8-2d6d4debc2f2", idempotencyKey: "5dbba043-4707-4d0c-a2b8-3a8be57d431a", shiftGlobalId: "03d80d42-559b-44ac-b55a-e5bb09821ff0" });
    expect((await (await postCommands([shiftOpen])).json()).results[0].status).toBe("accepted");
    const orderUpdateOperationId = "2c873e10-51e9-4c51-b359-a008b5e20122";
    const confirmation = makeOrderTransitionCommand({ operationId: "f4e0f249-f36c-455f-b457-fec412b25bb9", idempotencyKey: "bea2a4a7-300c-4dd3-8dd8-b812ea8e62cb", orderGlobalId, status: "confirmed", baseRevision: 2, dependencies: [orderOperationId, orderUpdateOperationId, shiftOpen.operationId] });
    const confirmationResult = (await (await postCommands([confirmation])).json()).results[0];
    expect(confirmationResult).toMatchObject({ status: "accepted" });
    expect((await (await postCommands([confirmation])).json()).results[0].status).toBe("already_applied");
    if (!await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.code, "CASH") })) await db.insert(paymentMethods).values({ code: "CASH", name: "Cash", affects_drawer: true, is_active: true });
    if (!await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.code, "CARD") })) await db.insert(paymentMethods).values({ code: "CARD", name: "Card", affects_drawer: false, is_active: true });
    const checkout = makeCheckoutCommand({ operationId: "4b318d33-ec4a-4d75-97be-39b6697f4a1f", idempotencyKey: "7ac3e3e6-5721-4936-b665-e83abc4bc823", checkoutGlobalId: "f1d4dc63-e1ef-4685-97ee-016886145071", orderGlobalId, shiftGlobalId: shiftOpen.payload.shiftGlobalId, paymentGlobalIds: ["b5bc7814-5c84-4ee2-ae62-58a0081bbed0", "a57a91a1-63e6-47d9-beb8-ea110b7165de"], transactionGlobalIds: ["e2a8f73a-ed82-4d00-8d98-50ba97388091", "9d6f8125-3ccf-4ecb-b652-24eb30fd6382"], dependencies: [orderOperationId, orderUpdateOperationId, confirmation.operationId, shiftOpen.operationId] });
    expect((await (await postCommands([checkout])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([checkout])).json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(orderCheckouts))).toHaveLength(1);
    expect((await db.select().from(orderPayments))).toHaveLength(2);
    expect((await db.select().from(transactions).where(eq(transactions.category, "selling")))).toHaveLength(2);
    const checkoutChanges = await (await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }))).json();
    const checkoutSnapshot = checkoutChanges.changes.find((change: { entityGlobalId: string }) => change.entityGlobalId === checkout.payload.checkoutGlobalId).snapshot;
    expect(checkoutSnapshot.payments.map((payment: { methodCode: string }) => payment.methodCode)).toEqual(["CASH", "CARD"]);
    expect(JSON.stringify(checkoutSnapshot)).not.toMatch(/cardNumber|pin|cvv|password|token/i);
    const print = makePrintCommand({ operationId: "3708c095-5c5c-4f2a-adb8-2dcb307b3567", idempotencyKey: "ae4d1658-1992-4956-bbe3-4249c54f43b5", jobGlobalId: "6e3ae919-6081-46dd-a59f-82c07198c038", orderGlobalId, shiftGlobalId: shiftOpen.payload.shiftGlobalId, dependencies: [orderOperationId, checkout.operationId] });
    expect((await (await postCommands([print])).json()).results[0].status).toBe("accepted");
    const preview = makePrintTransition({ operationId: "b76a8e1f-f91e-473c-92b6-216735639f44", idempotencyKey: "1b28d0fb-430f-41bb-bf83-8eb20900be6c", jobGlobalId: print.payload.jobGlobalId, orderGlobalId, status: "previewed", dependency: print.operationId });
    expect((await (await postCommands([preview])).json()).results[0].status).toBe("accepted");
    const acknowledgement = makePrintTransition({ operationId: "a2b5ac38-83b0-4a68-a32b-2bb3acfe93ee", idempotencyKey: "a0a1ce4e-4143-4e42-a013-6e886393a40c", jobGlobalId: print.payload.jobGlobalId, orderGlobalId, status: "acknowledged", dependency: preview.operationId });
    expect((await (await postCommands([acknowledgement])).json()).results[0].status).toBe("accepted");
    const kot = makePrintCommand({ operationId: "86d0c442-9d0a-4870-820b-769e5e9760f7", idempotencyKey: "b35e1a31-5aa0-4aaf-8676-0f450740709a", jobGlobalId: "3387c2ab-bcf5-4695-9a5b-6848ec74f6a7", orderGlobalId, shiftGlobalId: shiftOpen.payload.shiftGlobalId, dependencies: [orderOperationId], documentType: "kot", stationId: stationGlobalId });
    expect((await (await postCommands([kot])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([kot])).json()).results[0].status).toBe("already_applied");
    const reprint = makePrintCommand({ operationId: "bb7d5e83-7a62-4639-9057-b3f71b7467d8", idempotencyKey: "73f62f20-801b-4e64-bc37-a55f406a1c27", jobGlobalId: "524eb97d-cf03-43b4-995f-29217be28e51", orderGlobalId, shiftGlobalId: shiftOpen.payload.shiftGlobalId, dependencies: [print.operationId], isReprint: true, reprintReason: "Customer copy requested" });
    expect((await (await postCommands([reprint])).json()).results[0].status).toBe("accepted");
    const printRows = await db.select().from(printJobs);
    expect(printRows).toHaveLength(3);
    expect(printRows.some((job) => job.document_type === "receipt" && job.status === "acknowledged" && !job.is_reprint)).toBe(true);
    expect(printRows.filter((job) => job.is_reprint)).toHaveLength(1);
    const cancellation = makeCancellationCommand({ operationId: "c3468a0a-bbd2-48ab-9b1b-a4ac9291fc9a", idempotencyKey: "d97a1c4d-85f3-4a91-84a1-f09ded50f215", cancellationGlobalId: "71c566e5-70aa-405a-98cf-eb657e218efb", orderGlobalId, shiftGlobalId: shiftOpen.payload.shiftGlobalId, checkoutGlobalId: checkout.payload.checkoutGlobalId, originalPaymentGlobalIds: checkout.payload.paymentGlobalIds, refundGlobalIds: ["49c33f7c-6337-458d-a4e0-f6ef86b96a68", "8511c9d3-3884-4cee-9a8e-9184d06347fb"], transactionGlobalIds: ["9e76fe2b-6098-4791-9e1b-931b51526ca5", "9a64483a-a77a-4f32-ae3c-2d069aedb817"], dependencies: [checkout.operationId, shiftOpen.operationId] });
    expect((await (await postCommands([cancellation])).json()).results[0].status).toBe("accepted");
    expect((await (await postCommands([cancellation])).json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(orders).where(eq(orders.client_request_id, "central-order-sync-001")))[0]?.payment_status).toBe("refunded");
    expect((await db.select().from(orderPayments))).toHaveLength(4);
    expect((await db.select().from(transactions).where(eq(transactions.order_id, (await db.query.orders.findFirst({ where: eq(orders.client_request_id, "central-order-sync-001") }))!.id)))).toHaveLength(4);
    expect((await db.select().from(orderCancellations))).toHaveLength(1);
  });
});
