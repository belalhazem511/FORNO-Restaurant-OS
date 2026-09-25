import { timingSafeEqual } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncConflicts, syncDevices, syncEntityMappings, syncOrganizations, syncOutbox } from "@/lib/db/schema";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN ?? "";
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  return process.env.FORNO_DESKTOP_MODE === "1" && expected.length > 0 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Local synchronization is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID ?? "";
  const [device] = await db.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).limit(1);
  if (!device) return NextResponse.json({ error: "Local device identity is missing." }, { status: 409, headers: { "cache-control": "no-store" } });
  const [organization] = await db.select().from(syncOrganizations).where(eq(syncOrganizations.id, device.organization_id)).limit(1);
  const branch = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "branch"), eq(syncEntityMappings.local_id, String(device.branch_id))) });
  const register = await db.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register"), eq(syncEntityMappings.local_id, String(device.register_id))) });
  const outbox = await db.select().from(syncOutbox).where(eq(syncOutbox.device_id, device.id)).orderBy(asc(syncOutbox.id));
  const conflicts = await db.select().from(syncConflicts).where(and(eq(syncConflicts.organization_id, device.organization_id), eq(syncConflicts.branch_id, device.branch_id), eq(syncConflicts.state, "needs_review")));
  const pending = outbox.filter((item) => item.state === "pending").slice(0, 100);
  return NextResponse.json({
    paired: device.status === "paired" && !!organization?.remote_organization_id,
    organizationId: organization?.remote_organization_id ?? null,
    branchGlobalId: branch?.global_id ?? null,
    registerGlobalId: register?.global_id ?? null,
    cursor: device.last_pulled_cursor,
    pendingCount: outbox.filter((item) => item.state === "pending").length,
    needsReviewCount: outbox.filter((item) => item.state === "needs_review").length + conflicts.length,
    rejectedCount: outbox.filter((item) => item.state === "rejected").length,
    commands: pending.map((item) => ({
      operationId: item.operation_id,
      deviceId: item.device_id,
      organizationId: organization?.remote_organization_id,
      branchGlobalId: branch?.global_id,
      registerGlobalId: register?.global_id,
      actorGlobalId: item.actor_global_id,
      domain: item.domain,
      action: item.action,
      schemaVersion: item.schema_version,
      payload: item.payload,
      payloadHash: item.payload_hash,
      idempotencyKey: item.idempotency_key,
      baseRevision: item.base_revision,
      dependencies: item.dependencies,
      deviceTimestamp: item.device_timestamp.toISOString(),
    })),
  }, { headers: { "cache-control": "no-store" } });
}

const resultStatuses = new Set(["accepted", "already_applied", "needs_review", "rejected", "retry_later"]);

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Local synchronization is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null) as { results?: unknown } | null;
  if (!body || !Array.isArray(body.results) || body.results.length > 100) return NextResponse.json({ error: "Synchronization results are invalid." }, { status: 400 });
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID ?? "";
  await db.transaction(async (tx) => {
    for (const raw of body.results as Array<Record<string, unknown>>) {
      if (typeof raw.operationId !== "string" || typeof raw.status !== "string" || !resultStatuses.has(raw.status)) continue;
      const [item] = await tx.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, deviceId), eq(syncOutbox.operation_id, raw.operationId))).for("update").limit(1);
      if (!item || item.state !== "pending") continue;
      if (raw.status === "retry_later") {
        await tx.update(syncOutbox).set({ attempts: item.attempts + 1, last_error: typeof raw.error === "string" ? raw.error.slice(0, 1000) : "Central server requested retry." }).where(eq(syncOutbox.id, item.id));
        continue;
      }
      const state = raw.status === "already_applied" ? "accepted" : raw.status;
      await tx.update(syncOutbox).set({ state, server_result: raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : null, last_error: typeof raw.error === "string" ? raw.error.slice(0, 1000) : null, acknowledged_at: new Date() }).where(eq(syncOutbox.id, item.id));
      if ((state === "accepted") && raw.result && typeof raw.result === "object" && typeof (raw.result as Record<string, unknown>).revision === "number") {
        const entityType = item.domain === "customers" ? "customer" : item.domain === "products" ? "product" : item.domain === "shifts" ? item.action === "open" ? "cashier_shift" : item.action === "drawer_adjust" ? "cash_movement" : "" : "";
        const globalId = item.payload[entityType === "cashier_shift" ? "shiftGlobalId" : entityType === "cash_movement" ? "cashMovementGlobalId" : `${entityType}GlobalId`];
        if (entityType && typeof globalId === "string") await tx.update(syncEntityMappings).set({ server_revision: (raw.result as Record<string, unknown>).revision as number, updated_at: new Date() }).where(and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, entityType), eq(syncEntityMappings.global_id, globalId)));
      }
    }
  });
  return NextResponse.json({ saved: true }, { headers: { "cache-control": "no-store" } });
}
