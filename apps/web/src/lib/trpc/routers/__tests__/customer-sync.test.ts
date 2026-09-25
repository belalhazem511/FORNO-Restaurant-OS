import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";
import { NextRequest } from "next/server";
import { auditLogs, branches, cashierRegisters, cashierShifts, customers, paymentMethods, products, shiftCashMovements, staffAssignments, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, syncOutbox, transactions, user } from "@/lib/db/schema";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { customersRouter } = await import("../customers");
const { productsRouter } = await import("../products");
const { shiftsRouter } = await import("../shifts");
const { createCallerFactory } = await import("../../init");
const { POST: applyChanges } = await import("@/app/api/desktop/sync/apply/route");
const caller = createCallerFactory(customersRouter)({ user: makeUser("local-owner") });
const productCaller = createCallerFactory(productsRouter)({ user: makeUser("local-owner") });
const shiftCaller = createCallerFactory(shiftsRouter)({ user: makeUser("local-owner") });
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

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(user).values({ id: "local-owner", name: "Local Owner", email: "owner@local.test", emailVerified: false });
  const [branch] = await db.insert(branches).values({ code: "LOCAL", name_en: "Local", name_ar: "محلي", currency: "EGP", timezone: "Africa/Cairo", is_active: true }).returning();
  const [register] = await db.insert(cashierRegisters).values({ branch_id: branch!.id, code: "MAIN", name_en: "Main", name_ar: "الرئيسي", is_active: true }).returning();
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

  it("imports product snapshots by global UUID while retaining a device-local integer key", async () => {
    const response = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({
        changes: [{ cursor: 44, domain: "products", entityType: "product", entityGlobalId: pulledProductGlobalId, action: "create", revision: 1, snapshot: { name: "Remote Product", description: null, price: 700, in_stock: 5, category: null, imageKey: "media/opaque.webp" } }],
        nextCursor: 44,
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
    await db.insert(staffAssignments).values({ user_id: "local-owner", branch_id: branch!.id, role: "owner", is_active: true });
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
    const previousDeviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
    process.env.FORNO_DESKTOP_DEVICE_ID = deviceBId;
    let importedStatus = 0;
    let importError: string | undefined;
    try {
      const imported = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
        body: JSON.stringify({ changes: [
          { cursor: 1, domain: "shifts", entityType: "cashier_shift", entityGlobalId: mapping!.global_id, action: "open", revision: 1, snapshot: { registerGlobalId, actorGlobalId, openingFloat: 1200, openedAt: shift.opened_at.toISOString() } },
          { cursor: 2, domain: "shifts", entityType: "cash_movement", entityGlobalId: movementCommand!.payload.cashMovementGlobalId, action: "drawer_adjust", revision: 1, snapshot: { shiftGlobalId: mapping!.global_id, actorGlobalId, type: movement.type, amount: movement.amount, reason: movement.reason, createdAt: movement.created_at.toISOString() } },
        ], nextCursor: 2 }),
      }));
      importedStatus = imported.status;
      importError = (await imported.json()).error;
    } finally {
      if (previousDeviceId === undefined) delete process.env.FORNO_DESKTOP_DEVICE_ID;
      else process.env.FORNO_DESKTOP_DEVICE_ID = previousDeviceId;
    }
    expect(importError).toBeUndefined();
    expect(importedStatus).toBe(200);
    expect((await db.select().from(cashierShifts)).length).toBe(2);
    expect((await db.select().from(shiftCashMovements)).length).toBe(2);
    expect((await db.select().from(transactions).where(eq(transactions.category, "cash_in"))).length).toBe(2);
    const remoteShiftGlobalId = "7501a95a-c582-4a3d-921f-c06d28053a77";
    const applied = await applyChanges(new NextRequest("http://localhost/api/desktop/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forno-desktop-setup": "test-setup-token" },
      body: JSON.stringify({ changes: [{ cursor: 45, domain: "shifts", entityType: "cashier_shift", entityGlobalId: remoteShiftGlobalId, action: "open", revision: 1, snapshot: { registerGlobalId, actorGlobalId, openingFloat: 900, openedAt: new Date().toISOString() } }], nextCursor: 45 }),
    }));
    expect(applied.status).toBe(200);
    expect((await db.select().from(cashierShifts).where(and(eq(cashierShifts.branch_id, branch!.id), eq(cashierShifts.status, "open")))).length).toBe(1);
    expect((await db.select().from(syncConflicts).where(eq(syncConflicts.entity_global_id, remoteShiftGlobalId))).length).toBe(1);
  });
});
