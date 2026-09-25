import { createHash } from "node:crypto";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { authenticatePairedDevice } from "@/lib/sync/paired-device";
import { hasPermission } from "@/lib/permissions";
import {
  auditLogs,
  cashierRegisters,
  cashierShifts,
  customers,
  orderPayments,
  paymentMethods,
  products,
  staffAssignments,
  syncChangeLog,
  syncCommandInbox,
  syncConflicts,
  syncDevices,
  syncEntityMappings,
  syncGlobalEntities,
  shiftCashMovements,
  transactions,
} from "@/lib/db/schema";

export const runtime = "nodejs";

const valuesSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().max(20).nullable(),
  status: z.enum(["active", "inactive"]).nullable(),
});
const productValuesSchema = z.object({ name: z.string().min(1).max(255), description: z.string().nullable(), price: z.number().int().nonnegative(), in_stock: z.number().int().nonnegative(), category: z.string().max(50).nullable(), imageKey: z.string().max(200).nullable() });
const payloadSchemas = {
  "customers.create": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.update": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.delete": z.object({ customerGlobalId: z.string().uuid() }),
  "products.create": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.update": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.delete": z.object({ productGlobalId: z.string().uuid() }),
  "shifts.open": z.object({ shiftGlobalId: z.string().uuid(), registerGlobalId: z.string().uuid(), openingFloat: z.number().int().nonnegative(), openedAt: z.string().datetime() }),
  "shifts.close": z.object({ shiftGlobalId: z.string().uuid(), expectedCash: z.number().int(), closingCash: z.number().int().nonnegative(), closedAt: z.string().datetime() }),
  "shifts.drawer_adjust": z.object({ cashMovementGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), type: z.enum(["cash_in", "cash_out"]), amount: z.number().int().positive(), reason: z.string().trim().min(3).max(500), createdAt: z.string().datetime() }),
};
const commandSchema = z.object({
  operationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  branchGlobalId: z.string().uuid(),
  registerGlobalId: z.string().uuid(),
  actorGlobalId: z.string().uuid(),
  domain: z.enum(["customers", "products", "shifts"]),
  action: z.enum(["create", "update", "delete", "open", "drawer_adjust", "close"]),
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

async function auditRejectedCommand(device: { id: string; organization_id: string; branch_id: number }, actorGlobalId: string, operationId: string, reason: string) {
  await db.transaction(async (tx) => {
    const [actor] = await tx.select().from(syncGlobalEntities).where(and(
      eq(syncGlobalEntities.organization_id, device.organization_id),
      eq(syncGlobalEntities.entity_type, "user"),
      eq(syncGlobalEntities.global_id, actorGlobalId),
    )).limit(1);
    if (!actor) return;
    await tx.insert(auditLogs).values({
      branch_id: device.branch_id,
      actor_user_id: actor.local_id,
      action: "sync.command.rejected",
      entity_type: "sync_device",
      entity_id: device.id,
      details: JSON.stringify({ operationId, reason }),
    });
  });
}

export async function POST(request: NextRequest) {
  const device = await authenticatePairedDevice(request);
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
      await auditRejectedCommand(device, command.actorGlobalId, command.operationId, "scope_mismatch");
      results.set(command.operationId, { operationId: command.operationId, status: "rejected", error: "Command scope does not match the paired device." });
      continue;
    }
    const computedHash = createHash("sha256").update(stableJson(command.payload)).digest("hex");
    if (computedHash !== command.payloadHash) {
      await auditRejectedCommand(device, command.actorGlobalId, command.operationId, "payload_hash_mismatch");
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

        const payloadSchema = payloadSchemas[`${command.domain}.${command.action}` as keyof typeof payloadSchemas];
        if (!payloadSchema) return { operationId: command.operationId, status: "rejected", error: "Command type is not supported." };
        const payload = payloadSchema.safeParse(command.payload);
        if (!payload.success) return { operationId: command.operationId, status: "rejected", error: "Customer command payload is invalid." };
        if (command.domain === "shifts") {
          if (command.action === "drawer_adjust") {
            const movementPayload = payload.data as z.infer<typeof payloadSchemas["shifts.drawer_adjust"]>;
            if (!hasPermission(assignment.role, "cash:adjust")) {
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "cash_movement", entity_id: movementPayload.cashMovementGlobalId, reason: "cash:adjust", details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "rejected", error: "Actor lacks cash adjustment permission." };
            }
            const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, movementPayload.shiftGlobalId))).for("update").limit(1);
            const [shift] = await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftMapping?.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1);
            if (!shiftMapping || !shift) return { operationId: command.operationId, status: "rejected", error: "Open shift identity is invalid." };
            const [existingMovement] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cash_movement"), eq(syncGlobalEntities.global_id, movementPayload.cashMovementGlobalId))).limit(1);
            if (existingMovement) return { operationId: command.operationId, status: "rejected", error: "Cash movement identity already exists." };
            const cashMethod = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, "CASH"), eq(paymentMethods.is_active, true)) });
            if (!cashMethod) return { operationId: command.operationId, status: "retry_later", error: "Cash payment method is not configured centrally." };
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const [movement] = await tx.insert(shiftCashMovements).values({ shift_id: shift.id, type: movementPayload.type, amount: movementPayload.amount, reason: movementPayload.reason, created_by: actor.local_id, created_at: new Date(movementPayload.createdAt) }).returning();
            await tx.insert(transactions).values({ shift_id: shift.id, payment_method_id: cashMethod.id, amount: movementPayload.amount, user_uid: actor.local_id, type: movementPayload.type === "cash_in" ? "income" : "expense", category: movementPayload.type, status: "completed", description: movementPayload.reason });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: movementPayload.cashMovementGlobalId, local_id: String(movement!.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: movementPayload.cashMovementGlobalId, local_id: String(movement!.id), local_revision: 1, server_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: `shift.${movementPayload.type}`, entity_type: "cash_movement", entity_id: movementPayload.cashMovementGlobalId, reason: movementPayload.reason, details: JSON.stringify({ sourceOperationId: command.operationId, amount: movementPayload.amount }) });
            const result = { cashMovementGlobalId: movementPayload.cashMovementGlobalId, revision: 1 };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cash_movement", entity_global_id: movementPayload.cashMovementGlobalId, action: command.action, server_revision: 1, source_operation_id: command.operationId });
            await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
            return { operationId: command.operationId, status: "accepted", result };
          }
          if (command.action === "close") {
            const closePayload = payload.data as z.infer<typeof payloadSchemas["shifts.close"]>;
            const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, closePayload.shiftGlobalId))).for("update").limit(1);
            const [shift] = await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftMapping?.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1);
            if (!shiftMapping || !shift) return { operationId: command.operationId, status: "rejected", error: "Open shift identity is invalid." };
            if (shift.cashier_user_id !== actor.local_id && !hasPermission(assignment.role, "shift:review")) {
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, reason: "shift:review", details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "rejected", error: "Actor lacks shift review permission." };
            }
            const [methods, payments, movements] = await Promise.all([
              tx.select().from(paymentMethods),
              tx.select().from(orderPayments).where(eq(orderPayments.shift_id, shift.id)),
              tx.select().from(shiftCashMovements).where(eq(shiftCashMovements.shift_id, shift.id)),
            ]);
            const cashMethodIds = new Set(methods.filter((method) => method.affects_drawer).map((method) => method.id));
            const cashSales = payments.filter((payment) => payment.kind === "payment" && cashMethodIds.has(payment.payment_method_id)).reduce((sum, payment) => sum + payment.amount, 0);
            const cashRefunds = payments.filter((payment) => payment.kind === "refund" && cashMethodIds.has(payment.payment_method_id)).reduce((sum, payment) => sum + payment.amount, 0);
            const cashIn = movements.filter((movement) => movement.type === "cash_in").reduce((sum, movement) => sum + movement.amount, 0);
            const cashOut = movements.filter((movement) => movement.type === "cash_out").reduce((sum, movement) => sum + movement.amount, 0);
            const serverExpectedCash = shift.opening_float + cashSales - cashRefunds + cashIn - cashOut;
            if (serverExpectedCash !== closePayload.expectedCash) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "cash_snapshot_mismatch" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", entity_global_id: closePayload.shiftGlobalId, local_payload: command.payload, server_snapshot: { expectedCash: serverExpectedCash }, reason: "The central shift cash total differs from the device snapshot." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: "sync.shift.needs_review", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, localExpectedCash: closePayload.expectedCash, serverExpectedCash }) });
              return { operationId: command.operationId, status: "needs_review", result: { shiftGlobalId: closePayload.shiftGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const variance = closePayload.closingCash - serverExpectedCash;
            await tx.update(cashierShifts).set({ status: "closed", expected_cash: serverExpectedCash, closing_cash: closePayload.closingCash, variance, closed_by: actor.local_id, closed_at: new Date(closePayload.closedAt) }).where(eq(cashierShifts.id, shift.id));
            const revision = (shiftMapping.server_revision ?? 0) + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, shiftMapping.id));
            const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, closePayload.shiftGlobalId))).for("update").limit(1);
            if (deviceMapping) await tx.update(syncEntityMappings).set({ server_revision: revision, local_revision: deviceMapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: "sync.shift.closed", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, expectedCash: serverExpectedCash, closingCash: closePayload.closingCash, variance }) });
            const result = { shiftGlobalId: closePayload.shiftGlobalId, revision };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cashier_shift", entity_global_id: closePayload.shiftGlobalId, action: "close", server_revision: revision, source_operation_id: command.operationId });
            await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
            return { operationId: command.operationId, status: "accepted", result };
          }
          const shiftPayload = payload.data as z.infer<typeof payloadSchemas["shifts.open"]>;
          if (command.action !== "open" || shiftPayload.registerGlobalId !== command.registerGlobalId) return { operationId: command.operationId, status: "rejected", error: "Shift command scope is invalid." };
          const [registerMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.global_id, shiftPayload.registerGlobalId))).limit(1);
          const registerId = Number(registerMapping?.local_id);
          const [register] = await tx.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, registerId), eq(cashierRegisters.branch_id, device.branch_id), eq(cashierRegisters.is_active, true))).limit(1);
          if (!registerMapping || registerMapping.local_id !== String(device.register_id) || !register) return { operationId: command.operationId, status: "rejected", error: "Shift register is not assigned to the paired device." };
          const [existingMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, shiftPayload.shiftGlobalId))).for("update").limit(1);
          if (existingMapping) return { operationId: command.operationId, status: "rejected", error: "Shift global identity already exists." };
          const activeShift = await tx.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.status, "open"), eq(cashierShifts.branch_id, device.branch_id), or(eq(cashierShifts.register_id, register.id), eq(cashierShifts.cashier_user_id, actor.local_id))) });
          if (activeShift) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            await tx.update(syncCommandInbox).set({ result: { reason: "overlapping_shift" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", entity_global_id: shiftPayload.shiftGlobalId, local_payload: command.payload, server_snapshot: { activeShiftId: activeShift.id }, reason: "A conflicting open shift already exists for this register or cashier." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.shift.needs_review", entity_type: "cashier_shift", entity_id: shiftPayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, activeShiftId: activeShift.id }) });
            return { operationId: command.operationId, status: "needs_review", result: { shiftGlobalId: shiftPayload.shiftGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const [shift] = await tx.insert(cashierShifts).values({ branch_id: device.branch_id, register_id: register.id, cashier_user_id: actor.local_id, opened_by: actor.local_id, opening_float: shiftPayload.openingFloat, status: "open", opened_at: new Date(shiftPayload.openedAt) }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: shiftPayload.shiftGlobalId, local_id: String(shift!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: shiftPayload.shiftGlobalId, local_id: String(shift!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift!.id, actor_user_id: actor.local_id, action: "sync.shift.opened", entity_type: "cashier_shift", entity_id: shiftPayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, openingFloat: shiftPayload.openingFloat }) });
          const result = { shiftGlobalId: shiftPayload.shiftGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cashier_shift", entity_global_id: shiftPayload.shiftGlobalId, action: "open", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "products") {
          const productPayload = payload.data as z.infer<typeof payloadSchemas["products.create"]>;
          const productGlobalId = productPayload.productGlobalId;
          const [mapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "product"), eq(syncGlobalEntities.global_id, productGlobalId))).for("update").limit(1);
          const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.global_id, productGlobalId))).for("update").limit(1);
          if (command.action === "create" && mapping) return { operationId: command.operationId, status: "rejected", error: "Product global identity already exists." };
          if (command.action !== "create" && (!mapping || !deviceMapping || deviceMapping.server_revision !== command.baseRevision)) {
            if (!mapping) return { operationId: command.operationId, status: "rejected", error: "Product mapping does not exist." };
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const [serverProduct] = await tx.select().from(products).where(eq(products.id, Number(mapping.local_id))).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "product", entity_global_id: productGlobalId, local_payload: command.payload, server_snapshot: serverProduct ?? {}, reason: "Product was changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.needs_review", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: deviceMapping?.server_revision ?? null }) });
            return { operationId: command.operationId, status: "needs_review", result: { productGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          let revision = 1;
          if (command.action === "create") {
            const { imageKey, ...productValues } = productPayload.values;
            const [product] = await tx.insert(products).values({ ...productValues, image_key: imageKey, user_uid: actor.local_id }).returning();
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "product", global_id: productGlobalId, local_id: String(product!.id) });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "product", global_id: productGlobalId, local_id: String(product!.id), local_revision: 1, server_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.created", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else if (command.action === "delete") {
            await tx.delete(products).where(eq(products.id, Number(mapping!.local_id)));
            revision = deviceMapping!.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping!.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping!.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.deleted", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else {
            const { imageKey, ...productValues } = productPayload.values;
            const [updated] = await tx.update(products).set({ ...productValues, image_key: imageKey, user_uid: actor.local_id }).where(eq(products.id, Number(mapping!.local_id))).returning();
            revision = deviceMapping!.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping!.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping!.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.updated", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            void updated;
          }
          const response = { productGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "products", entity_type: "product", entity_global_id: productGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        const customerPayload = payload.data as z.infer<typeof payloadSchemas["customers.create"]>;
        const customerGlobalId = customerPayload.customerGlobalId;
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
          const [customer] = await tx.insert(customers).values({ ...customerPayload.values, user_uid: actor.local_id }).returning();
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
          if (command.action === "delete") {
            await tx.delete(customers).where(eq(customers.id, Number(mapping.local_id)));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.deleted", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else {
            await tx.update(customers).set(customerPayload.values).where(eq(customers.id, Number(mapping.local_id)));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.updated", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          }
          revision = entityMapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, entityMapping.id));
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
  const device = await authenticatePairedDevice(request);
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
    const isShift = change.domain === "shifts" && change.entity_type === "cashier_shift";
    const isCashMovement = change.domain === "shifts" && change.entity_type === "cash_movement";
    if (!isShift && !isCashMovement && ((change.domain !== "customers" && change.domain !== "products") || (change.entity_type !== "customer" && change.entity_type !== "product"))) {
      exported.push({ cursor: change.cursor, domain: change.domain, entityType: change.entity_type, entityGlobalId: change.entity_global_id, action: change.action, revision: change.server_revision, snapshot: null });
      continue;
    }
    const [mapping] = await db.select().from(syncGlobalEntities).where(and(
      eq(syncGlobalEntities.organization_id, device.organization_id),
      eq(syncGlobalEntities.entity_type, change.entity_type),
      eq(syncGlobalEntities.global_id, change.entity_global_id),
    )).limit(1);
    let snapshot: Record<string, unknown> | null = null;
    if (change.action === "delete") snapshot = null;
    else if (isShift && mapping) {
      const shift = await db.query.cashierShifts.findFirst({ where: eq(cashierShifts.id, Number(mapping.local_id)) });
      if (shift) {
        if (change.action === "close" && shift.status === "closed" && shift.closed_at && shift.expected_cash !== null && shift.closing_cash !== null && shift.variance !== null) {
          const [closedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, shift.closed_by ?? ""))).limit(1);
          if (closedBy) snapshot = { closedByGlobalId: closedBy.global_id, expectedCash: shift.expected_cash, closingCash: shift.closing_cash, variance: shift.variance, closedAt: shift.closed_at.toISOString() };
        } else {
          const [register] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(shift.register_id)))).limit(1);
          const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, shift.cashier_user_id))).limit(1);
          if (register && actor) snapshot = { registerGlobalId: register.global_id, actorGlobalId: actor.global_id, openingFloat: shift.opening_float, openedAt: shift.opened_at.toISOString() };
        }
      }
    }
    else if (isCashMovement && mapping) {
      const movement = await db.query.shiftCashMovements.findFirst({ where: eq(shiftCashMovements.id, Number(mapping.local_id)) });
      if (movement) {
        const [shiftMapping] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(movement.shift_id)))).limit(1);
        const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, movement.created_by))).limit(1);
        if (shiftMapping && actor) snapshot = { shiftGlobalId: shiftMapping.global_id, actorGlobalId: actor.global_id, type: movement.type, amount: movement.amount, reason: movement.reason, createdAt: movement.created_at.toISOString() };
      }
    }
    else if (mapping && change.entity_type === "customer") {
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, Number(mapping.local_id)) });
      if (customer) snapshot = { name: customer.name, email: customer.email, phone: customer.phone, status: customer.status };
    } else if (mapping) {
      const product = await db.query.products.findFirst({ where: eq(products.id, Number(mapping.local_id)) });
      if (product) snapshot = { name: product.name, description: product.description, price: product.price, in_stock: product.in_stock, category: product.category, imageKey: product.image_key };
    }
    exported.push({
      cursor: change.cursor,
      domain: change.domain,
      entityType: change.entity_type,
      entityGlobalId: change.entity_global_id,
      action: change.action,
      revision: change.server_revision,
      snapshot,
    });
  }
  return NextResponse.json({ changes: exported, nextCursor: changes.at(-1)?.cursor ?? rawCursor, hasMore: changes.length === 200 }, { headers: { "cache-control": "no-store" } });
}
