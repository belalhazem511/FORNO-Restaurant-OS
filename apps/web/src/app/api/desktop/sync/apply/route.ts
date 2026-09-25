import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { auditLogs, customers, products, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOutbox } from "@/lib/db/schema";

export const runtime = "nodejs";
const customerSnapshot = z.object({ name: z.string(), email: z.string().email(), phone: z.string().nullable(), status: z.string().nullable() });
const productSnapshot = z.object({ name: z.string(), description: z.string().nullable(), price: z.number().int().nonnegative(), in_stock: z.number().int().nonnegative(), category: z.string().nullable(), imageKey: z.string().max(200).nullable() });
const changeSchema = z.object({ cursor: z.number().int().positive(), domain: z.string(), entityType: z.string(), entityGlobalId: z.string().uuid(), action: z.string(), revision: z.number().int().positive(), snapshot: z.unknown().nullable() });

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
        const isCustomer = change.domain === "customers" && change.entityType === "customer";
        const isProduct = change.domain === "products" && change.entityType === "product";
        if ((!isCustomer && !isProduct) || !change.snapshot) continue;
        const parsedSnapshot = isCustomer ? customerSnapshot.safeParse(change.snapshot) : productSnapshot.safeParse(change.snapshot);
        if (!parsedSnapshot.success) throw new Error("A typed domain snapshot is invalid.");
        const snapshot = parsedSnapshot.data;
        const entityType = change.entityType;
        const mapping = await tx.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, entityType), eq(syncEntityMappings.global_id, change.entityGlobalId)) });
        if (mapping) {
          const queuedCommands = await tx.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, device.id), eq(syncOutbox.state, "pending")));
          const globalKey = `${entityType}GlobalId`;
          const queued = queuedCommands.find((item) => item.domain === change.domain && item.payload[globalKey] === change.entityGlobalId);
          if (queued) {
            const operationId = randomUUID();
            const idempotencyKey = randomUUID();
            const localPayload = queued.payload;
            const remotePayload = { [globalKey]: change.entityGlobalId, values: snapshot };
            const payloadHash = createHash("sha256").update(JSON.stringify(remotePayload)).digest("hex");
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: operationId, branch_id: device.branch_id, actor_global_id: queued.actor_global_id, domain: "customers", action: "pull_conflict", schema_version: 1, payload: remotePayload, payload_hash: payloadHash, idempotency_key: idempotencyKey, state: "needs_review" }).returning();
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: entityType, entity_global_id: change.entityGlobalId, local_payload: localPayload, server_snapshot: remotePayload, reason: `A local ${entityType} edit is pending while an authoritative server change arrived.` });
            const [actor] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
            if (actor) await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: `sync.${entityType}.needs_review`, entity_type: entityType, entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor }) });
            continue;
          }
          if (entityType === "customer") await tx.update(customers).set(snapshot as z.infer<typeof customerSnapshot>).where(eq(customers.id, Number(mapping.local_id)));
          else {
            const { imageKey, ...values } = snapshot as z.infer<typeof productSnapshot>;
            await tx.update(products).set({ ...values, image_key: imageKey }).where(eq(products.id, Number(mapping.local_id)));
          }
          await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
        } else {
          const [owner] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"))).limit(1);
          if (!owner) throw new Error("No local user mapping is available to import customer ownership.");
          let localId: string;
          if (entityType === "customer") {
            const [customer] = await tx.insert(customers).values({ ...(snapshot as z.infer<typeof customerSnapshot>), user_uid: owner.local_id }).returning();
            localId = String(customer!.id);
          } else {
            const { imageKey, ...values } = snapshot as z.infer<typeof productSnapshot>;
            const [product] = await tx.insert(products).values({ ...values, image_key: imageKey, user_uid: owner.local_id }).returning();
            localId = String(product!.id);
          }
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: entityType, global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: entityType, global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
        }
      }
      await tx.update(syncDevices).set({ last_pulled_cursor: Number(body.nextCursor), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
    });
    return NextResponse.json({ applied: true, cursor: Number(body.nextCursor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Changes were not applied." }, { status: 409, headers: { "cache-control": "no-store" } });
  }
}
