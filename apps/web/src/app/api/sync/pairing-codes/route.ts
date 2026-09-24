import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLogs, branches, cashierRegisters, staffAssignments, syncGlobalEntities, syncOrganizationBranches, syncOrganizations, syncPairingCodes } from "@/lib/db/schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await request.json().catch(() => null) as { branchId?: unknown; registerId?: unknown } | null;
  const branchId = Number(body?.branchId);
  const registerId = Number(body?.registerId);
  if (!Number.isSafeInteger(branchId) || !Number.isSafeInteger(registerId)) return NextResponse.json({ error: "Choose a valid branch and register." }, { status: 400 });
  const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, session.user.id), eq(staffAssignments.branch_id, branchId), eq(staffAssignments.is_active, true)) });
  if (assignment?.role !== "owner") return NextResponse.json({ error: "Only an active branch Owner may issue a device pairing code." }, { status: 403 });
  const [branch] = await db.select().from(branches).where(and(eq(branches.id, branchId), eq(branches.is_active, true))).limit(1);
  const [register] = await db.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, registerId), eq(cashierRegisters.branch_id, branchId), eq(cashierRegisters.is_active, true))).limit(1);
  if (!branch || !register) return NextResponse.json({ error: "The branch or register is not active." }, { status: 404 });

  const code = randomBytes(24).toString("base64url");
  const hashedCode = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const result = await db.transaction(async (tx) => {
    const [existingOrganization] = await tx.select().from(syncOrganizationBranches).where(eq(syncOrganizationBranches.branch_id, branchId)).limit(1);
    let organization = existingOrganization;
    if (!organization) {
      const organizationId = randomUUID();
      await tx.insert(syncOrganizations).values({ id: organizationId, name: branch.name_en });
      await tx.insert(syncOrganizationBranches).values({ organization_id: organizationId, branch_id: branchId, global_branch_id: randomUUID() });
      const [createdOrganization] = await tx.select().from(syncOrganizationBranches).where(eq(syncOrganizationBranches.branch_id, branchId)).limit(1);
      organization = createdOrganization;
    }
    if (!organization) throw new Error("Organization identity could not be established.");
    const identities = [
      { entityType: "branch", localId: String(branchId), globalId: organization.global_branch_id },
      { entityType: "register", localId: String(registerId), globalId: randomUUID() },
      { entityType: "user", localId: session.user.id, globalId: randomUUID() },
    ];
    for (const identity of identities) {
      const [known] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, organization.organization_id), eq(syncGlobalEntities.entity_type, identity.entityType), eq(syncGlobalEntities.local_id, identity.localId))).limit(1);
      if (!known) await tx.insert(syncGlobalEntities).values({ organization_id: organization.organization_id, branch_id: branchId, entity_type: identity.entityType, global_id: identity.globalId, local_id: identity.localId });
    }
    await tx.insert(syncPairingCodes).values({ organization_id: organization.organization_id, branch_id: branchId, register_id: registerId, code_hash: hashedCode, created_by: session.user.id, expires_at: expiresAt });
    await tx.insert(auditLogs).values({ branch_id: branchId, actor_user_id: session.user.id, action: "sync.device.pairing_code_created", entity_type: "sync_organization", entity_id: organization.organization_id, details: JSON.stringify({ registerId, expiresAt: expiresAt.toISOString() }) });
    return organization.organization_id;
  });
  return NextResponse.json({ code, organizationId: result, expiresAt: expiresAt.toISOString() }, { status: 201, headers: { "cache-control": "no-store" } });
}
