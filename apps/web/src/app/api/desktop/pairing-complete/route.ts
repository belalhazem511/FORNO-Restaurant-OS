import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLogs, syncDevices, syncEntityMappings, syncGlobalEntities, syncOrganizationBranches, syncOrganizations } from "@/lib/db/schema";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN ?? "";
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  return process.env.FORNO_DESKTOP_MODE === "1" && expected.length > 0 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Desktop pairing completion is unavailable." }, { status: 404 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
  const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
  const globalBranchId = typeof body?.globalBranchId === "string" ? body.globalBranchId : "";
  const globalRegisterId = typeof body?.globalRegisterId === "string" ? body.globalRegisterId : "";
  if (![deviceId, organizationId, globalBranchId, globalRegisterId].every((value) => /^[0-9a-f-]{36}$/i.test(value))) return NextResponse.json({ error: "Pairing identity is invalid." }, { status: 400 });
  try {
    await db.transaction(async (tx) => {
      const [device] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).for("update").limit(1);
      if (!device) throw new Error("This local device is not initialized.");
      const [organization] = await tx.select().from(syncOrganizations).where(eq(syncOrganizations.id, device.organization_id)).limit(1);
      if (!organization) throw new Error("The local organization identity is missing.");
      if (organization.remote_organization_id && organization.remote_organization_id !== organizationId) throw new Error("This device is already paired to a different organization.");
      if (organization.remote_organization_id === organizationId && device.status === "paired") return;
      const [ownerIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
      if (!ownerIdentity) throw new Error("The local Owner identity mapping is missing.");
      const identityChanges = [
        { type: "branch", localId: String(device.branch_id), globalId: globalBranchId },
        { type: "register", localId: String(device.register_id), globalId: globalRegisterId },
      ];
      for (const identity of identityChanges) {
        await tx.update(syncGlobalEntities).set({ global_id: identity.globalId, updated_at: new Date() }).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, identity.type), eq(syncGlobalEntities.local_id, identity.localId)));
        await tx.update(syncEntityMappings).set({ global_id: identity.globalId, updated_at: new Date() }).where(and(eq(syncEntityMappings.device_id, deviceId), eq(syncEntityMappings.entity_type, identity.type), eq(syncEntityMappings.local_id, identity.localId)));
      }
      await tx.update(syncOrganizationBranches).set({ global_branch_id: globalBranchId }).where(and(eq(syncOrganizationBranches.organization_id, device.organization_id), eq(syncOrganizationBranches.branch_id, device.branch_id)));
      await tx.update(syncOrganizations).set({ remote_organization_id: organizationId }).where(eq(syncOrganizations.id, device.organization_id));
      await tx.update(syncDevices).set({ status: "paired" }).where(eq(syncDevices.id, deviceId));
      await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: ownerIdentity.local_id, action: "sync.device.pairing_completed", entity_type: "sync_device", entity_id: deviceId, details: JSON.stringify({ organizationId, registerId: device.register_id }) });
    });
    return NextResponse.json({ paired: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pairing could not be finalized." }, { status: 409 });
  }
}
