import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createTestDb, SCHEMA_DDL } from "@/lib/trpc/routers/__tests__/helpers";
import { auditLogs, branches, cashierRegisters, customers, staffAssignments, syncChangeLog, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizations, user } from "@/lib/db/schema";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { POST } = await import("./commands/route");
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

function makeCommand(input: { operationId: string; idempotencyKey: string; customerGlobalId: string; name: string; action?: "create" | "update"; baseRevision?: number }) {
  const payload = { customerGlobalId: input.customerGlobalId, values: { name: input.name, email: `${input.name.toLowerCase().replaceAll(" ", "-")}@sync.test`, phone: null, status: "active" } };
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
    dependencies: [],
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
});
