import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  auditLogs,
  customers,
  staffAssignments,
  syncChangeLog,
  syncCommandInbox,
  syncConflicts,
  syncDevices,
  syncEntityMappings,
  syncGlobalEntities,
} from "@/lib/db/schema";

export const runtime = "nodejs";

const valuesSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().max(20).nullable(),
  status: z.enum(["active", "inactive"]).nullable(),
});
const payloadSchemas = {
  create: z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  update: z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
};
const commandSchema = z.object({
  operationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  branchGlobalId: z.string().uuid(),
  registerGlobalId: z.string().uuid(),
  actorGlobalId: z.string().uuid(),
  domain: z.literal("customers"),
  action: z.enum(["create", "update"]),
  schemaVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  dependencies: z.array(z.string().uuid()).max(100),
  deviceTimestamp: z.string().datetime(),
});

type Command = z.infer<typeof commandSchema>;
type CommandResult = { operationId: string; status: "accepted" | "already_applied" | "needs_review" | "rejected" | "retry_later"; result?: Record<string, unknown>; error?: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function authenticateDevice(request: NextRequest) {
  const deviceId = request.headers.get("x-forno-device-id") ?? "";
  const credential = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || credential.length < 32 || credential.length > 100) return null;
  const [device] = await db.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).limit(1);
  if (!device || device.status !== "paired" || !device.credential_hash || device.revoked_at) return null;
  const actual = createHash("sha256").update(credential).digest();
  const expected = Buffer.from(device.credential_hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return device;
}

export async function POST(request: NextRequest) {
  const device = await authenticateDevice(request);
  if (!device) return NextResponse.json({ error: "Paired device authentication failed." }, { status: 401, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null) as { commands?: unknown } | null;
  if (!body || !Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 100) {
    return NextResponse.json({ error: "A batch of 1 to 100 typed commands is required." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const results = new Map<string, CommandResult>();
  for (const raw of body.commands) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      results.set(typeof (raw as { operationId?: unknown })?.operationId === "string" ? String((raw as { operationId: string }).operationId) : "invalid", {
        operationId: typeof (raw as { operationId?: unknown })?.operationId === "string" ? String((raw as { operationId: string }).operationId) : "invalid",
        status: "rejected", error: "Command envelope is invalid.",
      });
      continue;
    }
    const command = parsed.data;
    if (command.deviceId !== device.id || command.organizationId !== device.organization_id || command.branchGlobalId.length !== 36) {
      results.set(command.operationId, { operationId: command.operationId, status: "rejected", error: "Command scope does not match the paired device." });
      continue;
    }
    const computedHash = createHash("sha256").update(stableJson(command.payload)).digest("hex");
    if (computedHash !== command.payloadHash) {
      results.set(command.operationId, { operationId: command.operationId, status: "rejected", error: "Payload hash mismatch." });
      continue;
    }
    let dependenciesReady = true;
    for (const dependency of command.dependencies) {
      const inBatch = results.get(dependency);
      if (inBatch) {
        if (inBatch.status !== "accepted" && inBatch.status !== "already_applied") dependenciesReady = false;
        continue;
      }
      const prior = await db.query.syncCommandInbox.findFirst({ where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.operation_id, dependency)) });
      if (prior?.state !== "accepted" && prior?.state !== "already_applied") dependenciesReady = false;
    }
    if (!dependenciesReady) {
      results.set(command.operationId, { operationId: command.operationId, status: "retry_later", error: "A dependency has not been accepted." });
      continue;
    }
    try {
      const result = await db.transaction(async (tx): Promise<CommandResult> => {
        const existing = await tx.query.syncCommandInbox.findFirst({
          where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.operation_id, command.operationId)),
        });
        const existingKey = existing ?? await tx.query.syncCommandInbox.findFirst({
          where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.idempotency_key, command.idempotencyKey)),
        });
        if (existingKey) {
          if (existingKey.payload_hash !== command.payloadHash || existingKey.operation_id !== command.operationId) {
            const [owner] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
            if (owner) await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: owner.local_id, action: "sync.command.identity_mismatch", entity_type: "sync_device", entity_id: device.id, details: JSON.stringify({ operationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Operation or idempotency key was reused with different content." };
          }
          return { operationId: command.operationId, status: "already_applied", result: existingKey.result ?? undefined };
        }
        const [branchMapping] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "branch"),
          eq(syncGlobalEntities.global_id, command.branchGlobalId),
        )).limit(1);
        const [registerMapping] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "register"),
          eq(syncGlobalEntities.global_id, command.registerGlobalId),
        )).limit(1);
        const [actor] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "user"),
          eq(syncGlobalEntities.global_id, command.actorGlobalId),
        )).limit(1);
        if (!branchMapping || branchMapping.local_id !== String(device.branch_id) || !registerMapping || registerMapping.local_id !== String(device.register_id) || !actor) return { operationId: command.operationId, status: "rejected", error: "Branch, register, or actor identity is invalid." };
        const assignment = await tx.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, actor.local_id), eq(staffAssignments.branch_id, device.branch_id), eq(staffAssignments.is_active, true)) });
        if (!assignment) return { operationId: command.operationId, status: "rejected", error: "Actor has no active assignment in this branch." };

        const payload = payloadSchemas[command.action].safeParse(command.payload);
        if (!payload.success) return { operationId: command.operationId, status: "rejected", error: "Customer command payload is invalid." };
        const values = payload.data.values;
        let customerGlobalId = payload.data.customerGlobalId;
        let revision = 1;
        let inboxId = 0;
        if (command.action === "create") {
          const [inbox] = await tx.insert(syncCommandInbox).values({
            organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
            branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
            action: command.action, schema_version: command.schemaVersion, payload: command.payload,
            payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted",
          }).returning();
          inboxId = inbox!.id;
          const [customer] = await tx.insert(customers).values({ ...values, user_uid: actor.local_id }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", global_id: customerGlobalId, local_id: String(customer!.id) });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "customer", global_id: customerGlobalId, local_id: String(customer!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.created", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
        } else {
          const [mapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "customer"), eq(syncGlobalEntities.global_id, customerGlobalId))).for("update").limit(1);
          if (!mapping) return { operationId: command.operationId, status: "rejected", error: "Customer mapping does not exist." };
          const [entityMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, customerGlobalId))).for("update").limit(1);
          if (!entityMapping || entityMapping.server_revision !== command.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({
              organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
              branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
              action: command.action, schema_version: command.schemaVersion, payload: command.payload,
              payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review",
            }).returning();
            inboxId = inbox!.id;
            const [serverCustomer] = await tx.select().from(customers).where(eq(customers.id, Number(mapping.local_id))).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", entity_global_id: customerGlobalId, local_payload: command.payload, server_snapshot: serverCustomer ?? {}, reason: "Customer was changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.needs_review", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: entityMapping?.server_revision ?? null }) });
            return { operationId: command.operationId, status: "needs_review", result: { customerGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({
            organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
            branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
            action: command.action, schema_version: command.schemaVersion, payload: command.payload,
            payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted",
          }).returning();
          inboxId = inbox!.id;
          const [updated] = await tx.update(customers).set(values).where(eq(customers.id, Number(mapping.local_id))).returning();
          revision = entityMapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, entityMapping.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.updated", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          void updated;
        }
        const response = { customerGlobalId, revision };
        await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
        await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "customers", entity_type: "customer", entity_global_id: customerGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
        await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
        return { operationId: command.operationId, status: "accepted", result: response };
      });
      results.set(command.operationId, result);
    } catch (error) {
      results.set(command.operationId, { operationId: command.operationId, status: "retry_later", error: error instanceof Error ? error.message : "Command processing failed." });
    }
  }
  return NextResponse.json({ results: [...results.values()] }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const device = await authenticateDevice(request);
  if (!device) return NextResponse.json({ error: "Paired device authentication failed." }, { status: 401, headers: { "cache-control": "no-store" } });
  const rawCursor = Number(request.nextUrl.searchParams.get("cursor") ?? "0");
  if (!Number.isSafeInteger(rawCursor) || rawCursor < 0) return NextResponse.json({ error: "Change cursor is invalid." }, { status: 400, headers: { "cache-control": "no-store" } });
  const changes = await db.select().from(syncChangeLog).where(and(
    eq(syncChangeLog.organization_id, device.organization_id),
    eq(syncChangeLog.branch_id, device.branch_id),
    gt(syncChangeLog.cursor, rawCursor),
  )).orderBy(asc(syncChangeLog.cursor)).limit(200);
  const exported = [];
  for (const change of changes) {
    if (change.domain !== "customers" || change.entity_type !== "customer") {
      exported.push({ cursor: change.cursor, domain: change.domain, entityType: change.entity_type, entityGlobalId: change.entity_global_id, action: change.action, revision: change.server_revision, snapshot: null });
      continue;
    }
    const [mapping] = await db.select().from(syncGlobalEntities).where(and(
      eq(syncGlobalEntities.organization_id, device.organization_id),
      eq(syncGlobalEntities.entity_type, "customer"),
      eq(syncGlobalEntities.global_id, change.entity_global_id),
    )).limit(1);
    const customer = mapping ? await db.query.customers.findFirst({ where: eq(customers.id, Number(mapping.local_id)) }) : undefined;
    exported.push({
      cursor: change.cursor,
      domain: change.domain,
      entityType: change.entity_type,
      entityGlobalId: change.entity_global_id,
      action: change.action,
      revision: change.server_revision,
      snapshot: customer ? { name: customer.name, email: customer.email, phone: customer.phone, status: customer.status } : null,
    });
  }
  return NextResponse.json({ changes: exported, nextCursor: changes.at(-1)?.cursor ?? rawCursor, hasMore: changes.length === 200 }, { headers: { "cache-control": "no-store" } });
}
