import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";
import { NextRequest } from "next/server";
import { executeLocalCommand } from "@/lib/sync/local-command";
import { auditLogs, branches, cashierRegisters, cashierShifts, customers, ingredientCategories, ingredients, inventoryLocations, kitchenStations, menuCategories, menuItemModifierGroups, menuItemVariants, menuItems, modifierGroups, modifierOptions, paymentMethods, products, recipeVersions, registerPrintPreferences, shiftCashMovements, staffAssignments, stockBalances, stockMovements, suppliers, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, syncOutbox, transactions, unitsOfMeasure, user } from "@/lib/db/schema";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { customersRouter } = await import("../customers");
const { productsRouter } = await import("../products");
const { shiftsRouter } = await import("../shifts");
const { printingRouter } = await import("../printing");
const { inventoryRouter } = await import("../inventory");
const { procurementRouter } = await import("../procurement");
const { createCallerFactory } = await import("../../init");
const { POST: applyChanges } = await import("@/app/api/desktop/sync/apply/route");
const caller = createCallerFactory(customersRouter)({ user: makeUser("local-owner") });
const productCaller = createCallerFactory(productsRouter)({ user: makeUser("local-owner") });
const shiftCaller = createCallerFactory(shiftsRouter)({ user: makeUser("local-owner") });
const printingCaller = createCallerFactory(printingRouter)({ user: makeUser("local-owner") });
const inventoryCaller = createCallerFactory(inventoryRouter)({ user: makeUser("local-owner") });
const procurementCaller = createCallerFactory(procurementRouter)({ user: makeUser("local-owner") });
const deviceId = "b2d90704-052a-4a37-a0fc-0464bf8c9e0a";
const organizationId = "ce9b25aa-39de-41c8-8d07-6c4ad0b5b967";
const branchGlobalId = "8fb88e82-24a4-483e-b931-e5d23e4f8d0c";
const registerGlobalId = "849e199a-a15a-4dca-bc62-13f774462e0a";
const actorGlobalId = "b22d0546-3cff-4333-b27e-1a87d65c1945";
const pulledCustomerGlobalId = "4d32a7c6-54e5-46b0-a37d-ea1a733eb816";
const pulledProductGlobalId = "37d00221-42e4-4bb5-8ca8-101cbd99a352";
const originalDesktopMode = process.env.FORNO_DESKTOP_MODE;
const originalDeviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
const originalSetupToken = process.env.FORNO_DESKTOP_SETUP_TOKEN;
let localRegisterId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values({ id: "local-owner", name: "Local Owner", email: "owner@local.test", emailVerified: false });
  const [branch] = await db.insert(branches).values({ code: "LOCAL", name_en: "Local", name_ar: "محلي", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
  const [register] = await db.insert(cashierRegisters).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", is_active: true }).returning();
  localRegisterId = register!.id;
  await db.insert(syncOrganizations).values({ id: organizationId, name: "Local Org" });
  await db.insert(syncDevices).values({ id: deviceId, organization_id: organizationId, display_name: "Test device", branch_id: branch!.id, register_id: register!.id, status: "local_only" });
  await db.insert(syncEntityMappings).values([
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branch!.id), local_revision: 1, server_revision: 0 },
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "register", global_id: registerGlobalId, local_id: String(register!.id), local_revision: 1, server_revision: 0 },
    { organization_id: organizationId, device_id: deviceId, branch_id: branch!.id, entity_type: "user", global_id: actorGlobalId, local_id: "local-owner", local_revision: 1, server_revision: 0 },
  ]);
  await db.insert(syncGlobalEntities).values({ organization_id: organizationId, branch_id: branch!.id, entity_type: "user", global_id: actorGlobalId, local_id: "local-owner" });
  process.env.FORNO_DESKTOP_MODE = "1";
  process.env.FORNO_DESKTOP_DEVICE_ID = deviceId;
  process.env.FORNO_DESKTOP_SETUP_TOKEN = "test-setup-token";
});

afterAll(async () => {
  if (originalDesktopMode === undefined) delete process.env.FORNO_DESKTOP_MODE;
  else process.env.FORNO_DESKTOP_MODE = originalDesktopMode;
  if (originalDeviceId === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID;
  else process.env.FORNO_DESKTOP_DEVICE_ID = originalDeviceId;
  if (originalSetupToken === undefined) delete process.env.FORNO_DESKTOP_SETUP_TOKEN;
  else process.env.FORNO_DESKTOP_SETUP_TOKEN = originalSetupToken;
  await pg.close();
});

describe("desktop customer command boundary", () => {
  it("commits print preferences and their typed synchronization command together", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    if (!await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, "local-owner"), eq(staffAssignments.branch_id, branch!.id)) })) await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true });
    const preference = await printingCaller.updatePreferences({ registerId: localRegisterId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 3 });
    const command = (await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "printing"))).at(-1);
    expect(preference.paper_width).toBe(58);
    expect((await db.select().from(registerPrintPreferences).where(eq(registerPrintPreferences.register_id, localRegisterId))).length).toBe(1);
    expect(command?.action).toBe("settings_update");
    expect(command?.payload).toMatchObject({ registerGlobalId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 3 });
  });

  it("commits customer, global mapping, audit, and typed outbox together", async () => {
    await db.delete(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.local_id, "local-owner")));
    const created = await caller.create({ name: "Offline Customer", email: "offline-customer@example.test" });
    const [outbox] = await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "customers"));
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.local_id, String(created.id))) });
    expect(outbox?.action).toBe("create");
    expect(outbox?.payload.customerGlobalId).toBe(mapping?.global_id);
    expect(mapping?.local_id).toBe(String(created.id));
    expect(await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.local_id, "local-owner")) })).toBeDefined();
    const rows = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(rows.length).toBe(1);
  });

  it("rolls back the business mutation when the atomic audit/outbox boundary fails", async () => {
    await db.delete(auditLogs);
    await pg.exec("ALTER TABLE audit_logs ADD CONSTRAINT test_sync_customer_audit_failure CHECK (action <> 'sync.customers.create.queued')");
    const beforeCustomers = (await db.select().from(customers)).length;
    const beforeCommands = (await db.select().from(syncOutbox)).length;
    await expect(caller.create({ name: "Must Roll Back", email: "rollback@example.test" })).rejects.toThrow();
    expect((await db.select().from(customers)).length).toBe(beforeCustomers);
    expect((await db.select().from(syncOutbox)).length).toBe(beforeCommands);
    await pg.exec("ALTER TABLE audit_logs DROP CONSTRAINT test_sync_customer_audit_failure");
  });

  it("queues customer edits behind the original create operation", async () => {
    const created = await caller.create({ name: "Before Edit", email: "edit-offline@example.test" });
    await caller.update({ id: created.id, name: "After Edit" });
    const commands = await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "customers"));
    expect(commands.length).toBe(3);
    const [create, update] = commands.slice(-2);
    expect(create?.action).toBe("create");
    expect(update?.action).toBe("update");
    expect(update?.dependencies).toEqual([create?.operation_id]);
    expect(update?.base_revision).toBe(1);
  });

  it("queues customer deletion with the same global identity before removing its local row", async () => {
    const created = await caller.create({ name: "Delete Offline", email: "delete-offline@example.test" });
    const mapping = await db.query.syncEntityMappings.findFirst({
      where: and(
        eq(syncEntityMappings.device_id, deviceId),
        eq(syncEntityMappings.entity_type, "customer"),
        eq(syncEntityMappings.local_id, String(created.id)),
      ),
    });
    const result = await caller.delete({ id: created.id });
    const commands = await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "customers"));
    const deletion = commands.at(-1);
    expect(result.success).toBe(true);
    expect((await db.select().from(customers).where(eq(customers.id, created.id))).length).toBe(0);
    expect(deletion?.action).toBe("delete");
    expect(deletion?.payload.customerGlobalId).toBe(mapping?.global_id);
    expect(deletion?.dependencies).toEqual([commands.at(-2)!.operation_id]);
  });

  it("imports customer snapshots with a local integer ID and advances the cursor transactionally", async () => {
    const response = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({
        changes: [{ cursor: 41, domain: "customers", entityType: "customer", entityGlobalId: pulledCustomerGlobalId, action: "create", revision: 1, snapshot: { name: "Pulled Customer", email: "pulled@sync.test", phone: null, status: "active" } }],
        nextCursor: 41,
      }),
    }));
    expect(response.status).toBe(200);
    const imported = await db.query.customers.findFirst({ where: eq(customers.email, "pulled@sync.test") });
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, pulledCustomerGlobalId)) });
    const device = await db.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
    expect(imported?.user_uid).toBe("local-owner");
    expect(Number(mapping?.local_id)).toBe(Number(imported?.id));
    expect(device?.last_pulled_cursor).toBe(41);
    const deleted = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 43, domain: "customers", entityType: "customer", entityGlobalId: pulledCustomerGlobalId, action: "delete", revision: 2, snapshot: null }], nextCursor: 43 }),
    }));
    expect(deleted.status).toBe(200);
    expect((await db.select().from(customers).where(eq(customers.id, imported!.id))).length).toBe(0);
    expect((await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, pulledCustomerGlobalId)) }))?.server_revision).toBe(2);
  });

  it("records product creation and edits as typed local commands", async () => {
    const created = await productCaller.create({ name: "Local Product", price: 425, in_stock: 7 });
    await productCaller.update({ id: created.id, name: "Renamed Local Product" });
    const commands = await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "products"));
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.local_id, String(created.id))) });
    expect(commands.length).toBe(2);
    expect(commands[0]?.action).toBe("create");
    expect(commands[0]?.payload.productGlobalId).toBe(mapping?.global_id);
    expect(commands[1]?.action).toBe("update");
    expect(commands[1]?.dependencies).toEqual([commands[0]?.operation_id]);
    expect((await db.select().from(products).where(eq(products.id, created.id)))[0]?.name).toBe("Renamed Local Product");
    await productCaller.delete({ id: created.id });
    const deletion = (await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "products"))).at(-1);
    expect(deletion?.action).toBe("delete");
    expect(deletion?.payload.productGlobalId).toBe(mapping?.global_id);
    expect((await db.select().from(products).where(eq(products.id, created.id))).length).toBe(0);
  });

  it("commits an opening stock movement, global references, audit, and sync command atomically", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true }).onConflictDoNothing();
    const [location] = await db.insert(inventoryLocations).values({ branch_id: branch!.id, code: "SYNC-STOCK", name_en: "Stock", name_ar: "مخزون", is_active: true }).returning();
    const [category] = await db.insert(ingredientCategories).values({ branch_id: branch!.id, code: "SYNC-STOCK", name_en: "Stock", name_ar: "مخزون", is_active: true }).returning();
    const [unit] = await db.insert(unitsOfMeasure).values({ code: "SYNC-COUNT", name_en: "Each", name_ar: "قطعة", dimension: "count", base_numerator: 1, base_denominator: 1 }).returning();
    const [ingredient] = await db.insert(ingredients).values({ branch_id: branch!.id, category_id: category!.id, sku: "SYNC-STOCK-1", name_en: "Stock Ingredient", name_ar: "مكون", base_unit_id: unit!.id, dimension: "count", default_location_id: location!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "local-owner", updated_by: "local-owner" }).returning();
    await pg.exec("ALTER TABLE audit_logs ADD CONSTRAINT test_sync_stock_outbox_failure CHECK (action <> 'sync.inventory.adjust.queued')");
    await expect(inventoryCaller.adjust({ branchId: branch!.id, ingredientId: ingredient!.id, locationId: location!.id, quantityBase: 7, unitCostMicros: 250, direction: "positive", opening: true, idempotencyKey: "local-stock-outbox-fail", reason: "Opening count verified" })).rejects.toThrow();
    expect((await db.select().from(stockMovements).where(eq(stockMovements.ingredient_id, ingredient!.id))).length).toBe(0);
    expect((await db.select().from(syncOutbox).where(eq(syncOutbox.idempotency_key, "local-stock-outbox-fail"))).length).toBe(0);
    expect(await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, ingredient!.id) })).toBeUndefined();
    await pg.exec("ALTER TABLE audit_logs DROP CONSTRAINT test_sync_stock_outbox_failure");
    const movement = await inventoryCaller.adjust({ branchId: branch!.id, ingredientId: ingredient!.id, locationId: location!.id, quantityBase: 7, unitCostMicros: 250, direction: "positive", opening: true, idempotencyKey: "local-stock-outbox-001", reason: "Opening count verified" });
    const [command] = await db.select().from(syncOutbox).where(eq(syncOutbox.idempotency_key, "local-stock-outbox-001"));
    const ingredientMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "ingredient"), eq(syncEntityMappings.local_id, String(ingredient!.id))) });
    const locationMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "inventory_location"), eq(syncEntityMappings.local_id, String(location!.id))) });
    expect(movement).toMatchObject({ direction: 1, quantity_base: 7, unit_cost_micros: 250, movement_type: "opening_balance" });
    expect((await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, ingredient!.id) }))?.quantity_base).toBe(7);
    expect(command?.domain).toBe("inventory");
    expect(command?.action).toBe("adjust");
    expect(command?.payload).toMatchObject({ ingredientGlobalId: ingredientMapping?.global_id, locationGlobalId: locationMapping?.global_id, movementGlobalId: expect.any(String), quantityBase: 7, unitCostMicros: 250, opening: true });
    expect((await db.select().from(stockMovements).where(eq(stockMovements.idempotency_key, "local-stock-outbox-001"))).length).toBe(1);
  });

  it("imports an authoritative stock movement with local IDs and exact weighted-average valuation", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    const ingredient = await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "SYNC-STOCK-1") });
    const location = await db.query.inventoryLocations.findFirst({ where: eq(inventoryLocations.code, "SYNC-STOCK") });
    const movementGlobalId = "f4900ba2-e67c-4a1d-babd-cac8f0eab048";
    const response = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 44, domain: "inventory", entityType: "stock_movement", entityGlobalId: movementGlobalId, action: "adjust", revision: 1, snapshot: { ingredientGlobalId: (await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "ingredient"), eq(syncEntityMappings.local_id, String(ingredient!.id))) }))!.global_id, locationGlobalId: (await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "inventory_location"), eq(syncEntityMappings.local_id, String(location!.id))) }))!.global_id, actorGlobalId, movementType: "manual_positive", direction: 1, quantityBase: 3, unitCostMicros: 1_000, totalCostAmount: 0, sourceType: "inventory_adjustment", sourceId: "remote-adjustment-1", idempotencyKey: "remote-adjustment-key-1", reason: "Remote verified count", createdAt: new Date().toISOString() } }], nextCursor: 44 }),
    }));
    expect(response.status).toBe(200);
    const balance = await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, ingredient!.id) });
    const movement = await db.query.stockMovements.findFirst({ where: eq(stockMovements.idempotency_key, `sync:${movementGlobalId}`) });
    const identity = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "stock_movement"), eq(syncEntityMappings.global_id, movementGlobalId)) });
    expect(balance).toMatchObject({ quantity_base: 10, average_unit_cost_micros: 475 });
    expect(movement).toMatchObject({ ingredient_id: ingredient!.id, location_id: location!.id, direction: 1, quantity_base: 3, actor_user_id: "local-owner" });
    expect(movement).toBeDefined();
    expect(Number(identity?.local_id)).toBe(movement!.id);
    expect((await db.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }))?.last_pulled_cursor).toBe(44);
    expect(branch?.id).toBe(location?.branch_id);
  });

  it("commits supplier creation to the local outbox and imports remote suppliers with local IDs", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true }).onConflictDoNothing();
    const local = await procurementCaller.createSupplier({ branchId: branch!.id, code: "LOCAL-SYNC-SUP", nameEn: "Local Supplier", nameAr: "مورد محلي" });
    const localCommand = (await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "suppliers"))).at(-1);
    const localMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "supplier"), eq(syncEntityMappings.local_id, String(local.id))) });
    expect(localCommand?.payload).toMatchObject({ supplierGlobalId: localMapping?.global_id, values: { code: "LOCAL-SYNC-SUP", nameEn: "Local Supplier" } });
    const remoteGlobalId = "de077d02-96a3-42a5-a280-35925d40860b";
    const response = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 45, domain: "suppliers", entityType: "supplier", entityGlobalId: remoteGlobalId, action: "create", revision: 1, snapshot: { code: "REMOTE-SUP", nameEn: "Remote Supplier", nameAr: "مورد بعيد", contactName: null, phone: null, email: null, address: null, notes: null, isActive: true, updatedByGlobalId: actorGlobalId } }], nextCursor: 45 }),
    }));
    expect(response.status).toBe(200);
    const imported = await db.query.suppliers.findFirst({ where: eq(suppliers.code, "REMOTE-SUP") });
    const remoteMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "supplier"), eq(syncEntityMappings.global_id, remoteGlobalId)) });
    expect(imported).toMatchObject({ branch_id: branch!.id, created_by: "local-owner", updated_by: "local-owner" });
    expect(imported).toBeDefined();
    expect(Number(remoteMapping?.local_id)).toBe(imported!.id);
  });

  it("commits ingredient configuration and archive with typed commands, then imports it without stock effects", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true }).onConflictDoNothing();
    const category = await db.query.ingredientCategories.findFirst({ where: eq(ingredientCategories.code, "SYNC-STOCK") });
    const location = await db.query.inventoryLocations.findFirst({ where: eq(inventoryLocations.code, "SYNC-STOCK") });
    const unit = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.code, "SYNC-COUNT") });
    const created = await inventoryCaller.createIngredient({ branchId: branch!.id, categoryId: category!.id, sku: "SYNC-NEW-ING", nameEn: "New Ingredient", nameAr: "مكون جديد", baseUnitId: unit!.id, dimension: "count", defaultLocationId: location!.id, tracked: true, reorderLevel: 20, lowStockThreshold: 5, parLevel: 30, allowNegative: false });
    const createCommand = (await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "inventory"))).at(-1);
    const globalMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "ingredient"), eq(syncEntityMappings.local_id, String(created.id))) });
    expect(createCommand?.action).toBe("ingredient_create");
    expect(createCommand?.payload).toMatchObject({ ingredientGlobalId: globalMapping?.global_id, values: { sku: "SYNC-NEW-ING", reorderLevel: 20, lowStockThreshold: 5 } });
    expect(await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, created.id) })).toMatchObject({ quantity_base: 0, average_unit_cost_micros: 0 });
    await inventoryCaller.updateIngredient({ branchId: branch!.id, ingredientId: created.id, categoryId: category!.id, nameEn: "Updated Ingredient", nameAr: "Ù…ÙƒÙˆÙ† Ø¬Ø¯ÙŠØ¯", baseUnitId: unit!.id, dimension: "count", defaultLocationId: location!.id, tracked: true, reorderLevel: 22, lowStockThreshold: 6, parLevel: 32, allowNegative: false });
    expect((await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "inventory"))).at(-1)).toMatchObject({ action: "ingredient_update", payload: expect.objectContaining({ baseRevision: 0, values: expect.objectContaining({ nameEn: "Updated Ingredient", lowStockThreshold: 6 }) }) });
    const remoteGlobalId = "f0e9d39b-1a4d-40d5-8a12-f94f0ee612d3";
    const snapshot = { sku: "REMOTE-ING", nameEn: "Remote Ingredient", nameAr: "مكون بعيد", dimension: "count", tracked: true, reorderLevel: 2, lowStockThreshold: 1, parLevel: null, allowNegative: false, isActive: true, categoryCode: "SYNC-STOCK", locationCode: "SYNC-STOCK", unitCode: "SYNC-COUNT", updatedByGlobalId: actorGlobalId };
    const importResponse = () => applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" }, body: JSON.stringify({ changes: [{ cursor: 52, domain: "inventory", entityType: "ingredient", entityGlobalId: remoteGlobalId, action: "ingredient_create", revision: 1, snapshot }], nextCursor: 52 }) }));
    expect((await importResponse()).status).toBe(200);
    expect((await importResponse()).status).toBe(200);
    const imported = await db.query.ingredients.findFirst({ where: eq(ingredients.sku, "REMOTE-ING") });
    expect(imported).toBeDefined();
    expect((await db.select().from(ingredients).where(eq(ingredients.sku, "REMOTE-ING"))).length).toBe(1);
    expect((await db.query.stockBalances.findFirst({ where: eq(stockBalances.ingredient_id, imported!.id) }))?.quantity_base).toBe(0);
    await inventoryCaller.archiveIngredient({ branchId: branch!.id, ingredientId: created.id, reason: "Catalog item discontinued" });
    expect((await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "inventory"))).at(-1)?.action).toBe("ingredient_archive");
  });

  it("queues immutable recipe versions, variant/modifier effects, activation and retirement without stock movements", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true }).onConflictDoNothing();
    const [category] = await db.insert(menuCategories).values({ branch_id: branch!.id, code: "SYNC-RECIPES", name_en: "Recipes", name_ar: "وصفات", sort_order: 1, is_active: true }).returning();
    const [station] = await db.insert(kitchenStations).values({ branch_id: branch!.id, code: "SYNC-RECIPES", name_en: "Kitchen", name_ar: "مطبخ", is_active: true }).returning();
    const [item] = await db.insert(menuItems).values({ category_id: category!.id, kitchen_station_id: station!.id, code: "SYNC-RECIPE", name_en: "Recipe item", name_ar: "صنف", base_price: 100, is_available: true, sort_order: 1 }).returning();
    const [variant] = await db.insert(menuItemVariants).values({ menu_item_id: item!.id, code: "LARGE", name_en: "Large", name_ar: "كبير", price: 150, is_default: true, is_available: true, sort_order: 1 }).returning();
    const [group] = await db.insert(modifierGroups).values({ branch_id: branch!.id, code: "SYNC-EXTRA", name_en: "Extra", name_ar: "إضافة", min_selections: 0, max_selections: 1, sort_order: 0, is_active: true }).returning();
    const [option] = await db.insert(modifierOptions).values({ modifier_group_id: group!.id, code: "LESS", name_en: "Less", name_ar: "أقل", price_delta: 0, is_default: false, is_available: true, sort_order: 1 }).returning();
    await db.insert(menuItemModifierGroups).values({ menu_item_id: item!.id, modifier_group_id: group!.id, sort_order: 0 });
    const [location] = await db.insert(inventoryLocations).values({ branch_id: branch!.id, code: "RECIPE-STOCK", name_en: "Recipe stock", name_ar: "مخزون الوصفات", is_active: true }).returning();
    const [ingredientCategory] = await db.insert(ingredientCategories).values({ branch_id: branch!.id, code: "RECIPE-STOCK", name_en: "Recipe stock", name_ar: "مخزون الوصفات", is_active: true }).returning();
    const [unit] = await db.insert(unitsOfMeasure).values({ code: "RECIPE-EACH", name_en: "Each", name_ar: "قطعة", dimension: "count", base_numerator: 1, base_denominator: 1 }).returning();
    const [ingredient] = await db.insert(ingredients).values({ branch_id: branch!.id, category_id: ingredientCategory!.id, sku: "RECIPE-STOCK", name_en: "Recipe stock", name_ar: "مخزون الوصفات", base_unit_id: unit!.id, dimension: "count", default_location_id: location!.id, is_active: true, is_tracked: true, reorder_level: 0, low_stock_threshold: 0, allow_negative: false, average_unit_cost_micros: 0, created_by: "local-owner", updated_by: "local-owner" }).returning();
    const beforeMovements = (await db.select().from(stockMovements)).length;
    const draft = await inventoryCaller.createRecipe({ branchId: branch!.id, menuItemId: item!.id, variantId: variant!.id, yieldLossBps: 100, components: [{ ingredientId: ingredient!.id, locationId: location!.id, unitId: unit!.id, quantityScaled: 10 }, { ingredientId: ingredient!.id, locationId: location!.id, unitId: unit!.id, quantityScaled: -2, modifierOptionId: option!.id }] });
    const createCommand = (await db.select().from(syncOutbox).where(and(eq(syncOutbox.domain, "inventory"), eq(syncOutbox.action, "recipe_create")))).at(-1);
    expect(createCommand?.payload).toMatchObject({ variantGlobalId: expect.any(String), components: [{ modifierOptionGlobalId: null, quantityScaled: 10 }, { modifierOptionGlobalId: expect.any(String), quantityScaled: -2 }] });
    const active = await inventoryCaller.activateRecipe({ branchId: branch!.id, recipeVersionId: draft.id, reason: "Approved test recipe" });
    expect(active.status).toBe("active");
    expect((await db.select().from(syncOutbox).where(and(eq(syncOutbox.domain, "inventory"), eq(syncOutbox.action, "recipe_activate")))).length).toBe(1);
    expect((await db.select().from(stockMovements)).length).toBe(beforeMovements);
    expect((await db.select().from(recipeVersions).where(eq(recipeVersions.id, draft.id)))[0]?.status).toBe("active");
    const nextDraft = await inventoryCaller.createRecipe({ branchId: branch!.id, menuItemId: item!.id, variantId: variant!.id, yieldLossBps: 0, components: [{ ingredientId: ingredient!.id, locationId: location!.id, unitId: unit!.id, quantityScaled: 12 }] });
    await inventoryCaller.activateRecipe({ branchId: branch!.id, recipeVersionId: nextDraft.id, reason: "Superseding recipe approved" });
    expect((await db.select().from(recipeVersions).where(eq(recipeVersions.id, draft.id)))[0]?.status).toBe("retired");
    expect((await db.select().from(stockMovements)).length).toBe(beforeMovements);
    const remoteRecipeGlobalId = "aa4d10d0-06d7-4f82-9ebc-9c1b947f08d0";
    const globalId = async (entityType: string, localId: number) => {
      const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, entityType), eq(syncEntityMappings.local_id, String(localId))) });
      return mapping!.global_id;
    };
    const remoteRecipe = { menuItemGlobalId: await globalId("menu_item", item!.id), variantGlobalId: await globalId("menu_item_variant", variant!.id), version: 3, status: "draft", yieldLossBps: 0, effectiveAt: null, authoredByGlobalId: actorGlobalId, approvedByGlobalId: null, approvedAt: null, components: [{ ingredientGlobalId: await globalId("ingredient", ingredient!.id), locationGlobalId: await globalId("inventory_location", location!.id), unitGlobalId: await globalId("unit_of_measure", unit!.id), modifierOptionGlobalId: await globalId("modifier_option", option!.id), quantityScaled: -1 }] };
    const importRecipe = () => applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", { method: "POST", headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" }, body: JSON.stringify({ changes: [{ cursor: 59, domain: "inventory", entityType: "recipe_version", entityGlobalId: remoteRecipeGlobalId, action: "recipe_create", revision: 1, snapshot: remoteRecipe }], nextCursor: 59 }) }));
    expect((await importRecipe()).status).toBe(200);
    expect((await importRecipe()).status).toBe(200);
    const importedRecipe = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "recipe_version"), eq(syncEntityMappings.global_id, remoteRecipeGlobalId)) });
    expect(importedRecipe).toBeDefined();
    expect((await db.query.recipeVersions.findFirst({ where: eq(recipeVersions.id, Number(importedRecipe!.local_id)), with: { components: true } }))?.components[0]).toMatchObject({ modifier_option_id: option!.id, quantity_input_scaled: -1 });
    expect((await db.select().from(stockMovements)).length).toBe(beforeMovements);
  });

  it("imports product snapshots by global UUID while retaining a device-local integer key", async () => {
    const response = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({
        changes: [{ cursor: 60, domain: "products", entityType: "product", entityGlobalId: pulledProductGlobalId, action: "create", revision: 1, snapshot: { name: "Remote Product", description: null, price: 700, in_stock: 5, category: null, imageKey: "media/opaque.webp" } }],
        nextCursor: 60,
      }),
    }));
    expect(response.status).toBe(200);
    const imported = await db.query.products.findFirst({ where: eq(products.name, "Remote Product") });
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.global_id, pulledProductGlobalId)) });
    expect(imported?.image_key).toBe("media/opaque.webp");
    expect(Number(mapping?.local_id)).toBe(Number(imported?.id));
  });

  it("commits local shift creation and its register reference to the outbox atomically", async () => {
    const branch = await db.query.branches.findFirst({ where: eq(branches.code, "LOCAL") });
    const register = await db.query.cashierRegisters.findFirst({ where: eq(cashierRegisters.code, "MAIN") });
    if (!await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, "local-owner"), eq(staffAssignments.branch_id, branch!.id)) })) await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true });
    const shift = await shiftCaller.open({ branchId: branch!.id, registerId: register!.id, openingFloat: 1200 });
    const command = await db.query.syncOutbox.findFirst({ where: eq(syncOutbox.domain, "shifts") });
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.local_id, String(shift.id))) });
    expect((await db.select().from(cashierShifts).where(eq(cashierShifts.id, shift.id))).length).toBe(1);
    expect(command?.action).toBe("open");
    expect(command?.payload.shiftGlobalId).toBe(mapping?.global_id);
    expect(command?.payload.registerGlobalId).toBe(registerGlobalId);
    expect(command?.payload.openingFloat).toBe(1200);
    await db.insert(paymentMethods).values({ code: "CASH", name: "Cash", affects_drawer: true, is_active: true });
    await shiftCaller.moveCash({ shiftId: shift.id, type: "cash_in", amount: 500, reason: "Local drawer top up" });
    const movementCommand = (await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "shifts"))).at(-1);
    expect(movementCommand?.action).toBe("drawer_adjust");
    expect(movementCommand?.dependencies).toEqual([command!.operation_id]);
    expect((await db.select().from(shiftCashMovements)).length).toBe(1);
    expect((await db.select().from(transactions).where(eq(transactions.category, "cash_in"))).length).toBe(1);
    const deviceBId = "c8d1dc2f-7cd4-4e66-bcb0-ccdb0b04ff59";
    const organizationBId = "548b22d5-b7b5-4f18-bf6f-ea72630fe7b8";
    const [branchB] = await db.insert(branches).values({ code: "LOCALB", name_en: "Local B", name_ar: "فرع ب", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
    const [registerB] = await db.insert(cashierRegisters).values({ branch_id: branchB!.id, code: "BREG", name_en: "Register B", name_ar: "كاشير ب", is_active: true }).returning();
    await db.insert(user).values({ id: "local-owner-b", name: "Local Owner B", email: "owner-b@local.test", emailVerified: false });
    await db.insert(staffAssignments).values({ user_id: "local-owner-b", branch_id: branchB!.id, role: "owner", is_active: true });
    await db.insert(syncOrganizations).values({ id: organizationBId, name: "Device B" });
    await db.insert(syncDevices).values({ id: deviceBId, organization_id: organizationBId, display_name: "Device B", branch_id: branchB!.id, register_id: registerB!.id, status: "local_only" });
    await db.insert(syncEntityMappings).values([
      { organization_id: organizationBId, device_id: deviceBId, branch_id: branchB!.id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branchB!.id) },
      { organization_id: organizationBId, device_id: deviceBId, branch_id: branchB!.id, entity_type: "register", global_id: registerGlobalId, local_id: String(registerB!.id) },
      { organization_id: organizationBId, device_id: deviceBId, branch_id: branchB!.id, entity_type: "user", global_id: actorGlobalId, local_id: "local-owner-b" },
    ]);
    await db.insert(syncGlobalEntities).values([
      { organization_id: organizationBId, branch_id: branchB!.id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branchB!.id) },
      { organization_id: organizationBId, branch_id: branchB!.id, entity_type: "register", global_id: registerGlobalId, local_id: String(registerB!.id) },
      { organization_id: organizationBId, branch_id: branchB!.id, entity_type: "user", global_id: actorGlobalId, local_id: "local-owner-b" },
    ]);
    const movement = (await db.select().from(shiftCashMovements)).at(-1)!;
    const previousCloseDeviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
    process.env.FORNO_DESKTOP_DEVICE_ID = deviceBId;
    let importedStatus = 0;
    let importError: string | undefined;
    try {
      const imported = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
        body: JSON.stringify({ changes: [
          { cursor: 61, domain: "shifts", entityType: "cashier_shift", entityGlobalId: mapping!.global_id, action: "open", revision: 1, snapshot: { registerGlobalId, actorGlobalId, openingFloat: 1200, openedAt: shift.opened_at.toISOString() } },
          { cursor: 62, domain: "shifts", entityType: "cash_movement", entityGlobalId: movementCommand!.payload.cashMovementGlobalId, action: "drawer_adjust", revision: 1, snapshot: { shiftGlobalId: mapping!.global_id, actorGlobalId, type: movement.type, amount: movement.amount, reason: movement.reason, createdAt: movement.created_at.toISOString() } },
          { cursor: 63, domain: "printing", entityType: "register_print_preferences", entityGlobalId: "2b2cfdce-82c6-468b-a1b0-cbaaf83e2659", action: "settings_update", revision: 1, snapshot: { registerGlobalId, updatedByGlobalId: actorGlobalId, paperWidth: 58, language: "ar", receiptCopies: 2, kotCopies: 3, updatedAt: new Date().toISOString() } },
        ], nextCursor: 63 }),
      }));
      importedStatus = imported.status;
      importError = (await imported.json()).error;
    } finally {
      if (previousCloseDeviceId === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID;
      else process.env.FORNO_DESKTOP_DEVICE_ID = previousCloseDeviceId;
    }
    expect(importError).toBeUndefined();
    expect(importedStatus).toBe(200);
    expect((await db.select().from(cashierShifts)).length).toBe(2);
    expect((await db.select().from(shiftCashMovements)).length).toBe(2);
    expect((await db.select().from(transactions).where(eq(transactions.category, "cash_in"))).length).toBe(2);
    const importedPrintSettings = await db.query.registerPrintPreferences.findFirst({ where: eq(registerPrintPreferences.register_id, registerB!.id) });
    expect(importedPrintSettings).toMatchObject({ paper_width: 58, language: "ar", receipt_copies: 2, kot_copies: 3 });
    expect(await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceBId), eq(syncEntityMappings.entity_type, "register_print_preferences"), eq(syncEntityMappings.global_id, "2b2cfdce-82c6-468b-a1b0-cbaaf83e2659")) })).toBeDefined();
    const remoteShiftGlobalId = "7501a95a-c582-4a3d-921f-c06d28053a77";
    const applied = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 64, domain: "shifts", entityType: "cashier_shift", entityGlobalId: remoteShiftGlobalId, action: "open", revision: 1, snapshot: { registerGlobalId, actorGlobalId, openingFloat: 900, openedAt: new Date().toISOString() } }], nextCursor: 64 }),
    }));
    expect(applied.status).toBe(200);
    expect((await db.select().from(cashierShifts).where(and(eq(cashierShifts.branch_id, branch!.id), eq(cashierShifts.status, "open")))).length).toBe(1);
    expect((await db.select().from(syncConflicts).where(eq(syncConflicts.entity_global_id, remoteShiftGlobalId))).length).toBe(1);
    const closed = await shiftCaller.close({ shiftId: shift.id, closingCash: 1750 });
    const closeCommand = (await db.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, deviceId), eq(syncOutbox.domain, "shifts")))).find((item) => item.action === "close");
    expect(closed.status).toBe("closed");
    expect(closeCommand?.payload.expectedCash).toBe(1700);
    expect(closeCommand?.payload.closingCash).toBe(1750);
    expect(closeCommand?.dependencies).toContain(command!.operation_id);
    expect((await db.select().from(cashierShifts).where(and(eq(cashierShifts.id, shift.id), eq(cashierShifts.status, "closed")))).length).toBe(1);
    const previousDeviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
    process.env.FORNO_DESKTOP_DEVICE_ID = deviceBId;
    let closeImportStatus = 0;
    try {
      const closeImport = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 65, domain: "shifts", entityType: "cashier_shift", entityGlobalId: mapping!.global_id, action: "close", revision: 2, snapshot: { closedByGlobalId: actorGlobalId, expectedCash: 1700, closingCash: 1750, variance: 50, closedAt: closed.closed_at!.toISOString() } }], nextCursor: 65 }),
      }));
      closeImportStatus = closeImport.status;
    } finally {
      if (previousDeviceId === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID;
      else process.env.FORNO_DESKTOP_DEVICE_ID = previousDeviceId;
    }
    expect(closeImportStatus).toBe(200);
    expect((await db.select().from(cashierShifts).where(and(eq(cashierShifts.branch_id, branchB!.id), eq(cashierShifts.status, "closed")))).length).toBe(1);
  });

  it("orders a cross-domain command after its pending global-identity dependency", async () => {
    const customer = await caller.create({ name: "Dependency Customer", email: "dependency@example.test" });
    const customerMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.local_id, String(customer.id))) });
    const priorCommand = (await db.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, deviceId), eq(syncOutbox.domain, "customers"), eq(syncOutbox.state, "pending")))).find((item) => item.payload.customerGlobalId === customerMapping?.global_id);
    await db.transaction((tx) => executeLocalCommand(tx, {
      actorId: "local-owner",
      domain: "products",
      action: "create",
      entityType: "product",
      localId: (result: { id: number }) => String(result.id),
      dependsOnGlobalIds: () => [customerMapping!.global_id],
      payload: (productGlobalId) => ({ productGlobalId, customerGlobalId: customerMapping!.global_id }),
    }, async () => ({ id: 987654 })));
    const productMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.local_id, "987654")) });
    const dependentCommand = (await db.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, deviceId), eq(syncOutbox.domain, "products")))).find((item) => item.payload.productGlobalId === productMapping?.global_id);
    expect(priorCommand).toBeDefined();
    expect(dependentCommand?.dependencies).toContain(priorCommand!.operation_id);
  });

  it("creates one durable outbox command for a stable idempotency key", async () => {
    let applied = 0;
    const execute = (description: string) => db.transaction((tx) => executeLocalCommand(tx, {
      actorId: "local-owner",
      domain: "orders",
      action: "create",
      entityType: "order",
      idempotencyKey: "stable-order-request-001",
      localId: (result: { id: number }) => String(result.id),
      payload: (orderGlobalId) => ({ orderGlobalId, requestId: "stable-order-request-001", description }),
    }, async () => {
      applied += 1;
      return { id: 987655 };
    }));
    await execute("Takeaway order");
    await execute("Takeaway order");
    const operations = await db.select().from(syncOutbox).where(eq(syncOutbox.idempotency_key, "stable-order-request-001"));
    expect(applied).toBe(2);
    expect(operations.length).toBe(1);
    await expect(execute("Different order payload")).rejects.toThrow("Local synchronization idempotency key was reused with different content.");
    expect((await db.select().from(syncOutbox).where(eq(syncOutbox.idempotency_key, "stable-order-request-001"))).length).toBe(1);
  });
});
