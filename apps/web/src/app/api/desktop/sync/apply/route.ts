import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { auditLogs, customers, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOutbox } from "@/lib/db/schema";

export const runtime = "nodejs";
const customerSnapshot = z.object({ name: z.string(), email: z.string().email(), phone: z.string().nullable(), status: z.string().nullable() });
const changeSchema = z.object({ cursor: z.number().int().positive(), domain: z.string(), entityType: z.string(), entityGlobalId: z.string().uuid(), action: z.string(), revision: z.number().int().positive(), snapshot: customerSnapshot.nullable() });

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN ?? "";
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  return process.env.FORNO_DESKTOP_MODE === "1" && expected.length > 0 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Local synchronization is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null) as { changes?: unknown; nextCursor?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > 200 || !Number.isSafeInteger(body.nextCursor) || Number(body.nextCursor) < 0) return NextResponse.json({ error: "Change page is invalid." }, { status: 400 });
  const changes = body.changes.map((item) => changeSchema.safeParse(item));
  if (changes.some((item) => !item.success)) return NextResponse.json({ error: "A typed change is invalid." }, { status: 400 });
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID ?? "";
  try {
    await db.transaction(async (tx) => {
      const [device] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).for("update").limit(1);
      if (!device) throw new Error("Local device identity is missing.");
      if (Number(body.nextCursor) < device.last_pulled_cursor) throw new Error("Change cursor cannot move backwards.");
      let previousCursor = device.last_pulled_cursor;
      for (const parsed of changes) {
        if (!parsed.success) continue;
        const change = parsed.data;
        if (change.cursor <= previousCursor || change.cursor > Number(body.nextCursor)) throw new Error("Change page ordering is invalid.");
        previousCursor = change.cursor;
        if (change.domain !== "customers" || change.entityType !== "customer" || !change.snapshot) continue;
        const existing = await tx.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, change.entityGlobalId)) });
        if (existing) {
          const queuedCommands = await tx.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, device.id), eq(syncOutbox.state, "pending")));
          const queued = queuedCommands.find((item) => item.domain === "customers" && item.payload.customerGlobalId === change.entityGlobalId);
          if (queued) {
            const operationId = randomUUID();
            const idempotencyKey = randomUUID();
            const localPayload = queued.payload;
            const remotePayload = { customerGlobalId: change.entityGlobalId, values: change.snapshot };
            const payloadHash = createHash("sha256").update(JSON.stringify(remotePayload)).digest("hex");
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: operationId, branch_id: device.branch_id, actor_global_id: queued.actor_global_id, domain: "customers", action: "pull_conflict", schema_version: 1, payload: remotePayload, payload_hash: payloadHash, idempotency_key: idempotencyKey, state: "needs_review" }).returning();
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", entity_global_id: change.entityGlobalId, local_payload: localPayload, server_snapshot: remotePayload, reason: "A local customer edit is pending while an authoritative server change arrived." });
            const [actor] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
            if (actor) await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.needs_review", entity_type: "customer", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor }) });
            continue;
          }
          await tx.update(customers).set(change.snapshot).where(eq(customers.id, Number(existing.local_id)));
          await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: existing.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, existing.id));
        } else {
          const [owner] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"))).limit(1);
          if (!owner) throw new Error("No local user mapping is available to import customer ownership.");
          const [customer] = await tx.insert(customers).values({ ...change.snapshot, user_uid: owner.local_id }).returning();
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "customer", global_id: change.entityGlobalId, local_id: String(customer!.id), local_revision: 1, server_revision: change.revision });
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", global_id: change.entityGlobalId, local_id: String(customer!.id), server_revision: change.revision });
        }
      }
      await tx.update(syncDevices).set({ last_pulled_cursor: Number(body.nextCursor), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
    });
    return NextResponse.json({ applied: true, cursor: Number(body.nextCursor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Changes were not applied." }, { status: 409, headers: { "cache-control": "no-store" } });
  }
}
