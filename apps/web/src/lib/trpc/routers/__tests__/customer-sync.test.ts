import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";
import { NextRequest } from "next/server";
import { branches, cashierRegisters, customers, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, syncOutbox, user } from "@/lib/db/schema";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { customersRouter } = await import("../customers");
const { createCallerFactory } = await import("../../init");
const { POST: applyChanges } = await import("@/app/api/desktop/sync/apply/route");
const caller = createCallerFactory(customersRouter)({ user: makeUser("local-owner") });
const deviceId = "b2d90704-052a-4a37-a0fc-0464bf8c9e0a";
const organizationId = "ce9b25aa-39de-41c8-8d07-6c4ad0b5b967";
const branchGlobalId = "8fb88e82-24a4-483e-b931-e5d23e4f8d0c";
const registerGlobalId = "849e199a-a15a-4dca-bc62-13f774462e0a";
const actorGlobalId = "b22d0546-3cff-4333-b27e-1a87d65c1945";
const pulledCustomerGlobalId = "4d32a7c6-54e5-46b0-a37d-ea1a733eb816";
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
    const created = await caller.create({ name: "Offline Customer", email: "offline-customer@example.test" });
    const [outbox] = await db.select().from(syncOutbox).where(eq(syncOutbox.domain, "customers"));
    const mapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.local_id, String(created.id))) });
    expect(outbox?.action).toBe("create");
    expect(outbox?.payload.customerGlobalId).toBe(mapping?.global_id);
    expect(mapping?.local_id).toBe(String(created.id));
    const rows = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(rows.length).toBe(1);
  });

  it("rolls back a customer mutation when its local identity mapping is unavailable", async () => {
    const branch = await db.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
    const branchMapping = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, "branch")) });
    await db.delete(syncEntityMappings).where(eq(syncEntityMappings.id, branchMapping!.id));
    const beforeCustomers = (await db.select().from(customers)).length;
    const beforeCommands = (await db.select().from(syncOutbox)).length;
    await expect(caller.create({ name: "Must Roll Back", email: "rollback@example.test" })).rejects.toThrow("The local branch mapping is unavailable.");
    expect((await db.select().from(customers)).length).toBe(beforeCustomers);
    expect((await db.select().from(syncOutbox)).length).toBe(beforeCommands);
    await db.insert(syncEntityMappings).values({ organization_id: organizationId, device_id: deviceId, branch_id: branch!.branch_id, entity_type: "branch", global_id: branchGlobalId, local_id: String(branch!.branch_id) });
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
  });
});
