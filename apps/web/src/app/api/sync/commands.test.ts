import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createTestDb, SCHEMA_DDL } from "@/lib/trpc/routers/__tests__/helpers";
import { auditLogs, branches, cashierRegisters, customers, products, staffAssignments, syncChangeLog, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, user } from "@/lib/db/schema";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { GET, POST } = await import("./commands/route");
const deviceId = "b2d90704-052a-4a37-a0fc-0464bf8c9e0a";
const organizationId = "ce9b25aa-39de-41c8-8d07-6c4ad0b5b967";
const branchGlobalId = "8fb88e82-24a4-483e-b931-e5d23e4f8d0c";
const registerGlobalId = "849e199a-a15a-4dca-bc62-13f774462e0a";
const actorGlobalId = "b22d0546-3cff-4333-b27e-1a87d65c1945";
const credential = "device-secret-for-central-sync-tests-123";
const customerGlobalId = "fa9ccdae-1358-46f9-9f89-4a675607c7a0";
let centralBranchId = 0;

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
});

afterAll(async () => { await pg.close(); });

describe("paired customer command processing", () => {
  it("authenticates the paired device and applies a customer create exactly once", async () => {
    const command = makeCommand({ operationId: "8ce283aa-13f4-44fa-a27c-e45f5d7cc23e", idempotencyKey: "256006e3-46a8-42de-9a3f-49c739da8975", customerGlobalId, name: "Offline Customer" });
    const first = await postCommands([command]);
    expect(first.status).toBe(200);
    expect((await first.json()).results[0].status).toBe("accepted");
    const retry = await postCommands([command]);
    expect((await retry.json()).results[0].status).toBe("already_applied");
    expect((await db.select().from(customers)).length).toBe(1);
    expect((await db.select().from(syncChangeLog)).length).toBe(1);
    expect((await db.select().from(syncCommandInbox)).length).toBe(1);
    expect((await db.select().from(auditLogs)).length).toBe(1);
    const pulled = await GET(new NextRequest("http://localhost/api/sync/commands?cursor=0", { headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId } }));
    const page = await pulled.json();
    expect(page.changes[0].entityGlobalId).toBe(customerGlobalId);
    expect(page.changes[0].snapshot.email).toBe("offline-customer@sync.test");
    expect(page.changes[0].snapshot.user_uid).toBeUndefined();
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
});
