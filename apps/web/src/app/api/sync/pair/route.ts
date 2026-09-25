import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLogs, cashierRegisters, branches, syncDevices, syncGlobalEntities, syncOrganizationBranches, syncPairingCodes } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { deviceId?: unknown; credential?: unknown; pairingCode?: unknown; deviceName?: unknown } | null;
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
  const credential = typeof body?.credential === "string" ? body.credential : "";
  const pairingCode = typeof body?.pairingCode === "string" ? body.pairingCode : "";
  const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !/^[A-Za-z0-9_-]{43}$/.test(credential) || pairingCode.length < 16 || pairingCode.length > 100 || deviceName.length < 2 || deviceName.length > 120) {
    return NextResponse.json({ error: "Pairing data is invalid." }, { status: 400 });
  }
  const credentialHash = createHash("sha256").update(credential).digest("hex");
  const codeHash = createHash("sha256").update(pairingCode).digest("hex");
  try {
    const paired = await db.transaction(async (tx) => {
      const [pairing] = await tx.select().from(syncPairingCodes).where(eq(syncPairingCodes.code_hash, codeHash)).for("update").limit(1);
      const [existing] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).limit(1);
      if (!pairing) {
        if (existing?.status === "paired" && existing.credential_hash && timingSafeEqual(Buffer.from(existing.credential_hash), Buffer.from(credentialHash))) {
          const [branchIdentity] = await tx.select().from(syncOrganizationBranches).where(eq(syncOrganizationBranches.branch_id, existing.branch_id)).limit(1);
          const [registerIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, existing.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(existing.register_id)))).limit(1);
          const [actorIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, existing.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
          if (branchIdentity && registerIdentity && actorIdentity) return { organizationId: existing.organization_id, branchId: existing.branch_id, globalBranchId: branchIdentity.global_branch_id, globalRegisterId: registerIdentity.global_id, globalActorId: actorIdentity.global_id };
        }
        throw new PairingError("The pairing code is invalid or expired.");
      }
      if (pairing.consumed_at || pairing.expires_at.getTime() <= Date.now()) throw new PairingError("The pairing code is invalid or expired.");
      if (existing && (existing.organization_id !== pairing.organization_id || (existing.credential_hash && existing.credential_hash !== credentialHash))) {
        throw new PairingError("This device identity is already paired to another organization.");
      }
      const [branch] = await tx.select().from(branches).where(and(eq(branches.id, pairing.branch_id), eq(branches.is_active, true))).limit(1);
      const [register] = await tx.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, pairing.register_id), eq(cashierRegisters.branch_id, pairing.branch_id), eq(cashierRegisters.is_active, true))).limit(1);
      if (!branch || !register) throw new PairingError("The assigned branch or register is no longer active.");
      if (existing) {
        await tx.update(syncDevices).set({ display_name: deviceName, credential_hash: credentialHash, branch_id: pairing.branch_id, register_id: pairing.register_id, status: "paired", last_seen_at: new Date() }).where(eq(syncDevices.id, deviceId));
      } else {
        await tx.insert(syncDevices).values({ id: deviceId, organization_id: pairing.organization_id, display_name: deviceName, credential_hash: credentialHash, branch_id: pairing.branch_id, register_id: pairing.register_id, status: "paired", last_seen_at: new Date() });
      }
      await tx.update(syncPairingCodes).set({ consumed_at: new Date() }).where(eq(syncPairingCodes.id, pairing.id));
      await tx.insert(auditLogs).values({ branch_id: pairing.branch_id, actor_user_id: pairing.created_by, action: "sync.device.paired", entity_type: "sync_device", entity_id: deviceId, details: JSON.stringify({ organizationId: pairing.organization_id, registerId: pairing.register_id, deviceName }) });
      const [branchIdentity] = await tx.select().from(syncOrganizationBranches).where(eq(syncOrganizationBranches.branch_id, pairing.branch_id)).limit(1);
      const [registerIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, pairing.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(pairing.register_id)))).limit(1);
      const [actorIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, pairing.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, pairing.created_by))).limit(1);
      if (!branchIdentity || !registerIdentity || !actorIdentity) throw new PairingError("The assigned global branch/register/actor identities are missing.");
      return { organizationId: pairing.organization_id, branchId: pairing.branch_id, globalBranchId: branchIdentity.global_branch_id, globalRegisterId: registerIdentity.global_id, globalActorId: actorIdentity.global_id };
    });
    return NextResponse.json({ paired: true, ...paired }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PairingError ? error.message : "Device pairing could not be completed." }, { status: error instanceof PairingError ? 409 : 500 });
  }
}

class PairingError extends Error {}
