import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
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
  orderCheckouts,
  orderCancellations,
  orderInventoryIssues,
  orders,
  orderItems,
  orderItemModifiers,
  orderStatusHistory,
  restaurantTables,
  kitchenStations,
  menuItems,
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
  printJobs,
  registerPrintPreferences,
  transactions,
  ingredients,
  inventoryLocations,
  stockBalances,
  stockMovements,
  suppliers,
} from "@/lib/db/schema";
import { createOrder } from "@/lib/trpc/routers/orders/create";
import { payOrder } from "@/lib/trpc/routers/checkout/payment";
import { assertOrderTransition } from "@/lib/orders/lifecycle";
import { issueOrderInventory } from "@/lib/inventory/service";
import { cancelOrder } from "@/lib/trpc/routers/checkout/cancellation";
import { postStockIncrease } from "@/lib/inventory/service";
import { costMinorForQuantity } from "@/lib/inventory/exact";

export const runtime = "nodejs";

const valuesSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().max(20).nullable(),
  status: z.enum(["active", "inactive"]).nullable(),
});
const productValuesSchema = z.object({ name: z.string().min(1).max(255), description: z.string().nullable(), price: z.number().int().nonnegative(), in_stock: z.number().int().nonnegative(), category: z.string().max(50).nullable(), imageKey: z.string().max(200).nullable() });
const supplierValuesSchema = z.object({ code: z.string().min(2).max(40), nameEn: z.string().min(2).max(160), nameAr: z.string().min(2).max(160), contactName: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable(), address: z.string().nullable(), notes: z.string().nullable() });
const payloadSchemas = {
  "customers.create": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.update": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.delete": z.object({ customerGlobalId: z.string().uuid() }),
  "products.create": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.update": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.delete": z.object({ productGlobalId: z.string().uuid() }),
  "inventory.adjust": z.object({ movementGlobalId: z.string().uuid(), ingredientGlobalId: z.string().uuid(), locationGlobalId: z.string().uuid(), direction: z.enum(["positive", "negative"]), opening: z.boolean(), quantityBase: z.number().int().positive(), unitCostMicros: z.number().int().nonnegative(), reason: z.string().trim().min(3).max(500), override: z.boolean(), idempotencyKey: z.string().trim().min(8).max(140) }),
  "suppliers.create": z.object({ supplierGlobalId: z.string().uuid(), values: supplierValuesSchema }),
  "suppliers.update": z.object({ supplierGlobalId: z.string().uuid(), values: supplierValuesSchema, baseRevision: z.number().int().nonnegative() }),
  "suppliers.archive": z.object({ supplierGlobalId: z.string().uuid(), reason: z.string().trim().min(3).max(500), baseRevision: z.number().int().nonnegative(), values: supplierValuesSchema.extend({ isActive: z.boolean() }) }),
  "shifts.open": z.object({ shiftGlobalId: z.string().uuid(), registerGlobalId: z.string().uuid(), openingFloat: z.number().int().nonnegative(), openedAt: z.string().datetime() }),
  "shifts.close": z.object({ shiftGlobalId: z.string().uuid(), expectedCash: z.number().int(), closingCash: z.number().int().nonnegative(), closedAt: z.string().datetime() }),
  "shifts.drawer_adjust": z.object({ cashMovementGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), type: z.enum(["cash_in", "cash_out"]), amount: z.number().int().positive(), reason: z.string().trim().min(3).max(500), createdAt: z.string().datetime() }),
  "orders.create": z.object({ orderGlobalId: z.string().uuid(), branchGlobalId: z.string().uuid(), customerGlobalId: z.string().uuid().nullable(), diningTableGlobalId: z.string().uuid().nullable(), orderType: z.enum(["dine_in", "takeaway", "delivery"]), deliveryAddress: z.string().nullable(), clientRequestId: z.string().min(8).max(80), shiftGlobalId: z.string().uuid().nullable(), items: z.array(z.object({ menuItemGlobalId: z.string().uuid(), variantGlobalId: z.string().uuid().nullable(), modifierOptionGlobalIds: z.array(z.string().uuid()), quantity: z.number().int().positive(), notes: z.string().nullable() })).min(1) }),
  "orders.transition": z.object({ orderGlobalId: z.string().uuid(), status: z.enum(["pending", "confirmed", "preparing", "ready", "served", "collected", "delivered", "completed", "cancelled"]), note: z.string().nullable(), inventoryOverrideReason: z.string().nullable() }),
  "orders.update": z.object({ orderGlobalId: z.string().uuid(), status: z.enum(["pending", "confirmed", "preparing", "ready", "served", "collected", "delivered", "completed", "cancelled"]).nullable(), note: z.string().nullable(), inventoryOverrideReason: z.string().nullable() }),
  "checkout.pay": z.object({ checkoutGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), discount: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number().int().positive(), reason: z.string().min(3).max(500) }).nullable(), payments: z.array(z.object({ code: z.string().min(1).max(50), amount: z.number().int().positive(), tenderedAmount: z.number().int().positive().nullable() })).min(1).max(3), paymentGlobalIds: z.array(z.string().uuid()).min(1).max(3), transactionGlobalIds: z.array(z.string().uuid()).min(1).max(3) }),
  "checkout.cancel": z.object({ cancellationGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid().nullable(), checkoutGlobalId: z.string().uuid().nullable(), originalPaymentGlobalIds: z.array(z.string().uuid()), reason: z.string().min(3).max(500), inventoryDisposition: z.enum(["returned_unused", "prepared_discarded"]).nullable(), refundGlobalIds: z.array(z.string().uuid()), transactionGlobalIds: z.array(z.string().uuid()) }),
  "printing.request": z.object({ jobGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid().nullable(), stationGlobalId: z.string().uuid().nullable(), documentType: z.enum(["receipt", "order_summary", "kot", "refund", "reversal"]), isReprint: z.boolean(), reprintReason: z.string().nullable(), copyCount: z.number().int().min(1).max(5), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]) }),
  "printing.transition": z.object({ jobGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), status: z.enum(["previewed", "acknowledged", "failed", "cancelled"]), errorMessage: z.string().nullable() }),
  "printing.settings_update": z.object({ preferenceGlobalId: z.string().uuid(), registerGlobalId: z.string().uuid(), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]), receiptCopies: z.number().int().min(1).max(5), kotCopies: z.number().int().min(1).max(5), updatedAt: z.string().datetime() }),
};

export const SYNC_COMMAND_REGISTRY = {
  "orders.create": { schema: payloadSchemas["orders.create"], permission: "order:create", handler: "createOrder", importer: "order" },
  "orders.transition": { schema: payloadSchemas["orders.transition"], permission: "order:create", handler: "transitionOrder", importer: "order" },
  "orders.update": { schema: payloadSchemas["orders.update"], permission: null, handler: "updateOrder", importer: "order" },
  "checkout.pay": { schema: payloadSchemas["checkout.pay"], permission: "checkout:create", handler: "payOrder", importer: "checkout" },
  "checkout.cancel": { schema: payloadSchemas["checkout.cancel"], permission: "order:cancel", handler: "cancelOrder", importer: "cancellation" },
  "printing.request": { schema: payloadSchemas["printing.request"], permission: "print:initial", handler: "requestPrintJob", importer: "print_job" },
  "printing.transition": { schema: payloadSchemas["printing.transition"], permission: "print:initial", handler: "transitionPrintJob", importer: "print_job" },
  "printing.settings_update": { schema: payloadSchemas["printing.settings_update"], permission: "print:settings", handler: "updatePrintSettings", importer: "register_print_preferences" },
  "shifts.open": { schema: payloadSchemas["shifts.open"], permission: "shift:own", handler: "openShift", importer: "cashier_shift" },
  "shifts.drawer_adjust": { schema: payloadSchemas["shifts.drawer_adjust"], permission: "cash:adjust", handler: "adjustDrawer", importer: "cash_movement" },
  "shifts.close": { schema: payloadSchemas["shifts.close"], permission: "shift:review", handler: "closeShift", importer: "cashier_shift" },
  "customers.create": { schema: payloadSchemas["customers.create"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "customers.update": { schema: payloadSchemas["customers.update"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "customers.delete": { schema: payloadSchemas["customers.delete"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "products.create": { schema: payloadSchemas["products.create"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "products.update": { schema: payloadSchemas["products.update"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "products.delete": { schema: payloadSchemas["products.delete"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "inventory.adjust": { schema: payloadSchemas["inventory.adjust"], permission: "inventory:adjust", handler: "adjustStock", importer: "stock_movement" },
  "suppliers.create": { schema: payloadSchemas["suppliers.create"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
  "suppliers.update": { schema: payloadSchemas["suppliers.update"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
  "suppliers.archive": { schema: payloadSchemas["suppliers.archive"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
} as const satisfies Record<keyof typeof payloadSchemas, { schema: z.ZodType; permission: string | null; handler: string; importer: string }>;
const commandSchema = z.object({
  operationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  branchGlobalId: z.string().uuid(),
  registerGlobalId: z.string().uuid(),
  actorGlobalId: z.string().uuid(),
  domain: z.enum(["customers", "products", "shifts", "orders", "checkout", "printing", "inventory", "suppliers"]),
  action: z.enum(["create", "update", "delete", "open", "drawer_adjust", "close", "pay", "cancel", "request", "transition", "settings_update", "adjust", "archive"]),
  schemaVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().trim().min(8).max(120),
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
          const status = existingKey.state === "needs_review" ? "needs_review" : existingKey.state === "rejected" ? "rejected" : "already_applied";
          return { operationId: command.operationId, status, result: existingKey.result ?? undefined };
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
        if (command.domain === "orders" && command.action === "create") {
          const orderPayload = payload.data as z.infer<typeof payloadSchemas["orders.create"]>;
          if (orderPayload.branchGlobalId !== command.branchGlobalId || orderPayload.orderGlobalId.length !== 36) return { operationId: command.operationId, status: "rejected", error: "Order branch identity is invalid." };
          if (!hasPermission(assignment.role, "order:create")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "order", entity_id: orderPayload.orderGlobalId, reason: "order:create", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks order creation permission." };
          }
          const resolveLocalId = async (entityType: string, globalId: string | null) => {
            if (globalId === null) return null;
            const [mapping] = await tx.select().from(syncGlobalEntities).where(and(
              eq(syncGlobalEntities.organization_id, device.organization_id),
              eq(syncGlobalEntities.entity_type, entityType),
              eq(syncGlobalEntities.global_id, globalId),
            )).limit(1);
            if (!mapping || mapping.branch_id !== device.branch_id) throw new Error(`Order dependency ${entityType} is not synchronized.`);
            return Number(mapping.local_id);
          };
          const branchId = Number(branchMapping.local_id);
          const customerId = await resolveLocalId("customer", orderPayload.customerGlobalId);
          const diningTableId = await resolveLocalId("restaurant_table", orderPayload.diningTableGlobalId);
          const items = await Promise.all(orderPayload.items.map(async (item) => ({
            menuItemId: (await resolveLocalId("menu_item", item.menuItemGlobalId))!,
            variantId: await resolveLocalId("menu_item_variant", item.variantGlobalId),
            modifierOptionIds: await Promise.all(item.modifierOptionGlobalIds.map((id) => resolveLocalId("modifier_option", id).then((value) => value!))),
            quantity: item.quantity,
            notes: item.notes ?? undefined,
          })));
          const [priorIdentity] = await tx.select().from(syncGlobalEntities).where(and(
            eq(syncGlobalEntities.organization_id, device.organization_id),
            eq(syncGlobalEntities.entity_type, "order"),
            eq(syncGlobalEntities.global_id, orderPayload.orderGlobalId),
          )).limit(1);
          if (priorIdentity) return { operationId: command.operationId, status: "rejected", error: "Order global identity already exists." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const created = await createOrder({ branchId, customerId, diningTableId, orderType: orderPayload.orderType, deliveryAddress: orderPayload.deliveryAddress, clientRequestId: orderPayload.clientRequestId, items }, actor.local_id, tx);
          const globalValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order", global_id: orderPayload.orderGlobalId, local_id: String(created.id), server_revision: 1 };
          await tx.insert(syncGlobalEntities).values(globalValues);
          await tx.insert(syncEntityMappings).values({ ...globalValues, device_id: device.id, local_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.created", entity_type: "order", entity_id: orderPayload.orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, orderType: orderPayload.orderType }) });
          const result = { orderGlobalId: orderPayload.orderGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: orderPayload.orderGlobalId, action: "create", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "orders" && (command.action === "transition" || command.action === "update")) {
          const transition = payload.data as z.infer<typeof payloadSchemas["orders.transition"]> | z.infer<typeof payloadSchemas["orders.update"]>;
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, transition.orderGlobalId))).for("update").limit(1);
          const [deviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, transition.orderGlobalId))).for("update").limit(1);
          const [order] = identity ? await tx.select().from(orders).where(and(eq(orders.id, Number(identity.local_id)), eq(orders.branch_id, device.branch_id))).for("update").limit(1) : [undefined];
          if (!order || !deviceIdentity) return { operationId: command.operationId, status: "rejected", error: "Order identity is invalid for this branch." };
          if (deviceIdentity.server_revision !== command.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const serverSnapshot = { status: order.status, paymentStatus: order.payment_status, totalAmount: order.total_amount, updatedAt: order.updated_at?.toISOString() ?? null };
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order", entity_global_id: transition.orderGlobalId, local_payload: command.payload, server_snapshot: serverSnapshot, reason: "The order changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.needs_review", entity_type: "order", entity_id: transition.orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: deviceIdentity.server_revision }) });
            return { operationId: command.operationId, status: "needs_review", result: { orderGlobalId: transition.orderGlobalId } };
          }
          if (transition.status === "cancelled") return { operationId: command.operationId, status: "rejected", error: "Use the cancellation workflow for cancelled orders." };
          if (transition.status && transition.status !== order.status) {
            try { assertOrderTransition(order.status, transition.status, order.order_type); } catch (error) { return { operationId: command.operationId, status: "rejected", error: error instanceof Error ? error.message : "Order transition is invalid." }; }
          }
          if (transition.status === "confirmed" && transition.status !== order.status) {
            if (!hasPermission(assignment.role, "order:create")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks order transition permission." };
            if (transition.inventoryOverrideReason && !hasPermission(assignment.role, "inventory:override")) return { operationId: command.operationId, status: "rejected", error: "Actor cannot override insufficient stock." };
            await issueOrderInventory(tx, { orderId: order.id, actorUserId: actor.local_id, idempotencyKey: `order-confirm:${order.id}`, allowNegative: Boolean(transition.inventoryOverrideReason), overrideReason: transition.inventoryOverrideReason ?? undefined });
          }
          const [updated] = await tx.update(orders).set({ status: transition.status ?? order.status, updated_at: new Date() }).where(eq(orders.id, order.id)).returning();
          if (transition.status && transition.status !== order.status) await tx.insert(orderStatusHistory).values({ order_id: order.id, from_status: order.status, to_status: transition.status, changed_by: actor.local_id, note: transition.note });
          if (transition.status && ["completed", "cancelled"].includes(transition.status) && order.dining_table_id) await tx.update(restaurantTables).set({ status: "available" }).where(eq(restaurantTables.id, order.dining_table_id));
          const revision = deviceIdentity.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceIdentity.id));
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.transition", entity_type: "order", entity_id: transition.orderGlobalId, reason: transition.note, details: JSON.stringify({ sourceOperationId: command.operationId, from: order.status, to: transition.status, inventoryOverrideReason: transition.inventoryOverrideReason }) });
          const result = { orderGlobalId: transition.orderGlobalId, revision, status: updated!.status };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: transition.orderGlobalId, action: "transition", server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "checkout" && command.action === "pay") {
          const checkoutPayload = payload.data as z.infer<typeof payloadSchemas["checkout.pay"]>;
          if (!hasPermission(assignment.role, "checkout:create") || checkoutPayload.discount && !hasPermission(assignment.role, "discount:apply")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "order_checkout", entity_id: checkoutPayload.checkoutGlobalId, reason: checkoutPayload.discount ? "discount:apply" : "checkout:create", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks checkout permission." };
          }
          const [orderMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, checkoutPayload.orderGlobalId))).limit(1);
          const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, checkoutPayload.shiftGlobalId))).limit(1);
          const order = orderMapping && await tx.query.orders.findFirst({ where: and(eq(orders.id, Number(orderMapping.local_id)), eq(orders.branch_id, device.branch_id)) });
          const shift = shiftMapping && await tx.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.id, Number(shiftMapping.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open")) });
          if (!order || !shift || shift.cashier_user_id !== actor.local_id) return { operationId: command.operationId, status: "rejected", error: "Checkout order or active shift is invalid." };
          const methods = await tx.select().from(paymentMethods).where(and(inArray(paymentMethods.code, checkoutPayload.payments.map((payment) => payment.code)), eq(paymentMethods.is_active, true)));
          if (methods.length !== checkoutPayload.payments.length) return { operationId: command.operationId, status: "rejected", error: "A payment method is unavailable." };
          const methodByCode = new Map(methods.map((method) => [method.code, method]));
          const allocations = checkoutPayload.payments.map((payment) => {
            const method = methodByCode.get(payment.code);
            if (!method) throw new Error("A payment method is unavailable.");
            return { paymentMethodId: method.id, amount: payment.amount, tenderedAmount: payment.tenderedAmount };
          });
          const [existingCheckout] = await tx.select().from(orderCheckouts).where(eq(orderCheckouts.idempotency_key, command.idempotencyKey)).limit(1);
          if (existingCheckout) return { operationId: command.operationId, status: "rejected", error: "Checkout idempotency identity already exists without its command record." };
          const result = await payOrder({ idempotencyKey: command.idempotencyKey, discount: checkoutPayload.discount, payments: allocations }, order, shift, new Map(methods.map((method) => [method.id, method])), actor.local_id, tx);
          const rows = await tx.select().from(orderPayments).where(and(eq(orderPayments.checkout_id, result.checkoutId), eq(orderPayments.kind, "payment")));
          if (rows.length !== checkoutPayload.paymentGlobalIds.length) throw new Error("Checkout payment identity count does not match its records.");
          const paymentSnapshots: Array<{ globalId: string; localId: number }> = [];
          const transactionSnapshots: Array<{ globalId: string; localId: number }> = [];
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            const paymentGlobalId = checkoutPayload.paymentGlobalIds[index]!;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: paymentGlobalId, local_id: String(row.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: paymentGlobalId, local_id: String(row.id), local_revision: 1, server_revision: 1 });
            paymentSnapshots.push({ globalId: paymentGlobalId, localId: row.id });
            const [financial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, row.id)).limit(1);
            const transactionGlobalId = checkoutPayload.transactionGlobalIds[index]!;
            if (financial) {
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: transactionGlobalId, local_id: String(financial.id), server_revision: 1 });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: transactionGlobalId, local_id: String(financial.id), local_revision: 1, server_revision: 1 });
              transactionSnapshots.push({ globalId: transactionGlobalId, localId: financial.id });
            }
          }
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: checkoutPayload.checkoutGlobalId, local_id: String(result.checkoutId), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: checkoutPayload.checkoutGlobalId, local_id: String(result.checkoutId), local_revision: 1, server_revision: 1 });
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, order_id: order.id, actor_user_id: actor.local_id, action: "sync.checkout.paid", entity_type: "order_checkout", entity_id: checkoutPayload.checkoutGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, paymentCount: rows.length }) });
          const response = { checkoutGlobalId: checkoutPayload.checkoutGlobalId, revision: 1, subtotalAmount: result.subtotalAmount, discountAmount: result.discountAmount, payableAmount: result.payableAmount, paymentGlobalIds: paymentSnapshots.map((item) => item.globalId), transactionGlobalIds: transactionSnapshots.map((item) => item.globalId) };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "checkout", entity_type: "order_checkout", entity_global_id: checkoutPayload.checkoutGlobalId, action: "pay", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "checkout" && command.action === "cancel") {
          const cancellationPayload = payload.data as z.infer<typeof payloadSchemas["checkout.cancel"]>;
          if (!hasPermission(assignment.role, "order:cancel")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks order cancellation permission." };
          const [orderIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, cancellationPayload.orderGlobalId))).for("update").limit(1);
          const [orderDeviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, cancellationPayload.orderGlobalId))).for("update").limit(1);
          const [order] = orderIdentity ? await tx.select().from(orders).where(and(eq(orders.id, Number(orderIdentity.local_id)), eq(orders.branch_id, device.branch_id))).for("update").limit(1) : [undefined];
          if (!order || order.status === "cancelled") return { operationId: command.operationId, status: "rejected", error: "Order is missing or already cancelled." };
          const wasPaid = order.payment_status === "paid";
          if (wasPaid && !hasPermission(assignment.role, "payment:refund")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks refund permission." };
          if (wasPaid && !cancellationPayload.shiftGlobalId) return { operationId: command.operationId, status: "rejected", error: "A cashier shift is required for a financial reversal." };
          const [shiftIdentity] = cancellationPayload.shiftGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, cancellationPayload.shiftGlobalId))).limit(1) : [undefined];
          const [shift] = shiftIdentity ? await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftIdentity.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1) : [undefined];
          if (cancellationPayload.shiftGlobalId && (!shift || shift!.cashier_user_id !== actor.local_id)) return { operationId: command.operationId, status: "rejected", error: "Cancellation shift is not open for the authorized actor." };
          const originalPayments = await tx.select().from(orderPayments).where(and(eq(orderPayments.order_id, order.id), eq(orderPayments.kind, "payment")));
          const mappedOriginals = await Promise.all(originalPayments.map(async (payment) => tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(payment.id))) })));
          if (wasPaid && (mappedOriginals.some((mapping) => !mapping) || mappedOriginals.map((mapping) => mapping!.global_id).sort().join(",") !== cancellationPayload.originalPaymentGlobalIds.slice().sort().join(","))) return { operationId: command.operationId, status: "rejected", error: "Original payment identities do not match the immutable checkout." };
          if (cancellationPayload.checkoutGlobalId && !await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_checkout"), eq(syncGlobalEntities.global_id, cancellationPayload.checkoutGlobalId)) })) return { operationId: command.operationId, status: "rejected", error: "Original checkout identity is unavailable." };
          const issue = await tx.query.orderInventoryIssues.findFirst({ where: eq(orderInventoryIssues.order_id, order.id) });
          if (issue && !cancellationPayload.inventoryDisposition) return { operationId: command.operationId, status: "rejected", error: "Cancellation after production requires an inventory disposition." };
          if (wasPaid && cancellationPayload.refundGlobalIds.length !== originalPayments.length) return { operationId: command.operationId, status: "rejected", error: "Refund identities do not match original payments." };
          const result = await cancelOrder({ idempotencyKey: command.idempotencyKey, reason: cancellationPayload.reason, inventoryDisposition: cancellationPayload.inventoryDisposition ?? undefined }, order, wasPaid, shift ?? null, actor.local_id, tx);
          const [cancellation] = await tx.select().from(orderCancellations).where(eq(orderCancellations.id, result.cancellationId)).limit(1);
          const refundRows = await tx.select().from(orderPayments).where(and(eq(orderPayments.order_id, order.id), eq(orderPayments.kind, "refund")));
          for (let index = 0; index < refundRows.length; index += 1) {
            const refund = refundRows[index]!;
            const refundGlobalId = cancellationPayload.refundGlobalIds[index]!;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refundGlobalId, local_id: String(refund.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refundGlobalId, local_id: String(refund.id), local_revision: 1, server_revision: 1 });
            const [financial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, refund.id)).limit(1);
            const financialGlobalId = cancellationPayload.transactionGlobalIds[index];
            if (financial && financialGlobalId) {
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: financialGlobalId, local_id: String(financial.id), server_revision: 1 });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: financialGlobalId, local_id: String(financial.id), local_revision: 1, server_revision: 1 });
            }
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: cancellationPayload.cancellationGlobalId, local_id: String(cancellation!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: cancellationPayload.cancellationGlobalId, local_id: String(cancellation!.id), local_revision: 1, server_revision: 1 });
          const response = { cancellationGlobalId: cancellationPayload.cancellationGlobalId, orderGlobalId: cancellationPayload.orderGlobalId, revision: 1, refundedAmount: result.refundedAmount };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          const orderRevision = (orderDeviceIdentity?.server_revision ?? 0) + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: orderRevision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, orderIdentity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: orderRevision, updated_at: new Date() }).where(eq(syncEntityMappings.id, orderDeviceIdentity!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: cancellationPayload.orderGlobalId, action: "cancel", server_revision: orderRevision, source_operation_id: command.operationId });
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "checkout", entity_type: "order_cancellation", entity_global_id: cancellationPayload.cancellationGlobalId, action: "cancel", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "printing" && command.action === "settings_update") {
          const settings = payload.data as z.infer<typeof payloadSchemas["printing.settings_update"]>;
          if (!hasPermission(assignment.role, "print:settings")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks print settings permission." };
          if (settings.registerGlobalId !== command.registerGlobalId) return { operationId: command.operationId, status: "rejected", error: "Print settings register is outside the paired device scope." };
          const [registerIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.global_id, settings.registerGlobalId))).limit(1);
          const [register] = registerIdentity ? await tx.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, Number(registerIdentity.local_id)), eq(cashierRegisters.branch_id, device.branch_id))).limit(1) : [undefined];
          if (!register || register.id !== device.register_id) return { operationId: command.operationId, status: "rejected", error: "Print settings register is not assigned to this device." };
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register_print_preferences"), eq(syncGlobalEntities.global_id, settings.preferenceGlobalId))).for("update").limit(1);
          const [deviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register_print_preferences"), eq(syncEntityMappings.global_id, settings.preferenceGlobalId))).for("update").limit(1);
          if (identity && (!deviceIdentity || deviceIdentity.server_revision !== command.baseRevision)) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const [current] = await tx.select().from(registerPrintPreferences).where(eq(registerPrintPreferences.register_id, register.id)).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "register_print_preferences", entity_global_id: settings.preferenceGlobalId, local_payload: command.payload, server_snapshot: current ?? {}, reason: "Print preferences changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.print_settings.needs_review", entity_type: "register_print_preferences", entity_id: settings.preferenceGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "needs_review", result: { preferenceGlobalId: settings.preferenceGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const [preference] = await tx.insert(registerPrintPreferences).values({ register_id: register.id, paper_width: settings.paperWidth, language: settings.language, receipt_copies: settings.receiptCopies, kot_copies: settings.kotCopies, updated_by: actor.local_id, updated_at: new Date(settings.updatedAt) }).onConflictDoUpdate({ target: registerPrintPreferences.register_id, set: { paper_width: settings.paperWidth, language: settings.language, receipt_copies: settings.receiptCopies, kot_copies: settings.kotCopies, updated_by: actor.local_id, updated_at: new Date(settings.updatedAt) } }).returning();
          const revision = (deviceIdentity?.server_revision ?? 0) + 1;
          if (identity) await tx.update(syncGlobalEntities).set({ local_id: String(preference!.id), server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
          else await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: settings.preferenceGlobalId, local_id: String(preference!.id), server_revision: revision });
          if (deviceIdentity) await tx.update(syncEntityMappings).set({ local_id: String(preference!.id), server_revision: revision, local_revision: deviceIdentity.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceIdentity.id));
          else await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: settings.preferenceGlobalId, local_id: String(preference!.id), local_revision: 1, server_revision: revision });
          const result = { preferenceGlobalId: settings.preferenceGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.print.settings_updated", entity_type: "register_print_preferences", entity_id: settings.preferenceGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "register_print_preferences", entity_global_id: settings.preferenceGlobalId, action: "settings_update", server_revision: revision, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "printing" && command.action === "request") {
          const requestPayload = payload.data as z.infer<typeof payloadSchemas["printing.request"]>;
          if (!hasPermission(assignment.role, requestPayload.isReprint ? "print:reprint" : "print:initial")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks print permission." };
          if (requestPayload.isReprint && (!requestPayload.reprintReason || requestPayload.reprintReason.trim().length < 3)) return { operationId: command.operationId, status: "rejected", error: "A reprint reason is required." };
          const [orderIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, requestPayload.orderGlobalId))).limit(1);
          const [order] = orderIdentity ? await tx.select().from(orders).where(and(eq(orders.id, Number(orderIdentity.local_id)), eq(orders.branch_id, device.branch_id))).limit(1) : [undefined];
          const [shiftIdentity] = requestPayload.shiftGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, requestPayload.shiftGlobalId))).limit(1) : [undefined];
          const [stationIdentity] = requestPayload.stationGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "kitchen_station"), eq(syncGlobalEntities.global_id, requestPayload.stationGlobalId))).limit(1) : [undefined];
          if (!order || requestPayload.shiftGlobalId && !shiftIdentity || requestPayload.stationGlobalId && !stationIdentity) return { operationId: command.operationId, status: "retry_later", error: "Print order, shift, or station dependency is unavailable." };
          if (requestPayload.documentType === "receipt" && order.payment_status !== "paid" || requestPayload.documentType === "order_summary" && order.payment_status !== "unpaid" || ["refund", "reversal"].includes(requestPayload.documentType) && order.payment_status !== "refunded") return { operationId: command.operationId, status: "rejected", error: "Print document does not match the current order financial state." };
          if (requestPayload.documentType === "kot" && (!stationIdentity || order.status === "cancelled")) return { operationId: command.operationId, status: "rejected", error: "KOT requires an active order and mapped kitchen station." };
          if (requestPayload.documentType !== "kot" && stationIdentity) return { operationId: command.operationId, status: "rejected", error: "Only KOT documents may select a station." };
          if (requestPayload.documentType === "kot") {
            const [station] = await tx.select().from(kitchenStations).where(and(eq(kitchenStations.id, Number(stationIdentity!.local_id)), eq(kitchenStations.branch_id, device.branch_id), eq(kitchenStations.is_active, true))).limit(1);
            const routedItems = await tx.select({ id: orderItems.id }).from(orderItems).innerJoin(menuItems, eq(orderItems.menu_item_id, menuItems.id)).where(and(eq(orderItems.order_id, order.id), eq(menuItems.kitchen_station_id, Number(stationIdentity!.local_id))));
            if (!station || routedItems.length === 0) return { operationId: command.operationId, status: "rejected", error: "KOT station is not active for this order." };
          }
          if (!requestPayload.isReprint) {
            const initial = await tx.query.printJobs.findFirst({ where: requestPayload.documentType === "kot" ? and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, Number(stationIdentity?.local_id)), eq(printJobs.is_reprint, false)) : and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, requestPayload.documentType), eq(printJobs.is_reprint, false)) });
            if (initial) return { operationId: command.operationId, status: "rejected", error: "Initial print document already exists." };
          } else {
            const initial = await tx.query.printJobs.findFirst({ where: requestPayload.documentType === "kot" ? and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, Number(stationIdentity?.local_id)), eq(printJobs.is_reprint, false)) : and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, requestPayload.documentType), eq(printJobs.is_reprint, false)) });
            if (!initial) return { operationId: command.operationId, status: "rejected", error: "An initial document must exist before reprinting." };
          }
          const [created] = await tx.insert(printJobs).values({ order_id: order.id, station_id: stationIdentity ? Number(stationIdentity.local_id) : null, register_id: device.register_id, shift_id: shiftIdentity ? Number(shiftIdentity.local_id) : null, requested_by: actor.local_id, approved_by: requestPayload.isReprint ? actor.local_id : null, document_type: requestPayload.documentType, status: "requested", is_reprint: requestPayload.isReprint, idempotency_key: command.idempotencyKey, copy_count: requestPayload.copyCount, paper_width: requestPayload.paperWidth, language: requestPayload.language, reprint_reason: requestPayload.isReprint ? requestPayload.reprintReason : null }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "print_job", global_id: requestPayload.jobGlobalId, local_id: String(created!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "print_job", global_id: requestPayload.jobGlobalId, local_id: String(created!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: created!.shift_id, order_id: order.id, actor_user_id: actor.local_id, approver_user_id: requestPayload.isReprint ? actor.local_id : null, action: requestPayload.isReprint ? "sync.print.reprint.request" : "sync.print.initial.request", entity_type: "print_job", entity_id: requestPayload.jobGlobalId, reason: requestPayload.reprintReason, details: JSON.stringify({ sourceOperationId: command.operationId, documentType: requestPayload.documentType, stationGlobalId: requestPayload.stationGlobalId }) });
          const response = { jobGlobalId: requestPayload.jobGlobalId, revision: 1 };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "print_job", entity_global_id: requestPayload.jobGlobalId, action: "request", server_revision: 1, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "printing" && command.action === "transition") {
          const transition = payload.data as z.infer<typeof payloadSchemas["printing.transition"]>;
          const [jobIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "print_job"), eq(syncGlobalEntities.global_id, transition.jobGlobalId))).for("update").limit(1);
          const [job] = jobIdentity ? await tx.select().from(printJobs).where(eq(printJobs.id, Number(jobIdentity.local_id))).for("update").limit(1) : [undefined];
          const [requester] = job ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.requested_by))).limit(1) : [undefined];
          if (!job || !requester || job.order_id !== Number((await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, transition.orderGlobalId))).limit(1))[0]?.local_id)) return { operationId: command.operationId, status: "rejected", error: "Print job identity is invalid." };
          if (job.requested_by !== actor.local_id && !hasPermission(assignment.role, "print:reprint")) return { operationId: command.operationId, status: "rejected", error: "Actor cannot acknowledge this print request." };
          const allowed: Record<string, string[]> = { requested: ["previewed", "failed", "cancelled"], previewed: ["acknowledged", "failed", "cancelled"], acknowledged: [], failed: [], cancelled: [] };
          if (!allowed[job.status]?.includes(transition.status) || transition.status === "failed" && !transition.errorMessage) return { operationId: command.operationId, status: "rejected", error: "Print transition is invalid." };
          await tx.update(printJobs).set({ status: transition.status, error_message: transition.status === "failed" ? transition.errorMessage : null, previewed_at: transition.status === "previewed" ? new Date() : job.previewed_at, acknowledged_at: transition.status === "acknowledged" ? new Date() : null, updated_at: new Date() }).where(eq(printJobs.id, job.id));
          const revision = Number((await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "print_job"), eq(syncEntityMappings.global_id, transition.jobGlobalId))).limit(1))[0]?.server_revision ?? 0) + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, jobIdentity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "print_job"), eq(syncEntityMappings.global_id, transition.jobGlobalId)));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: job.shift_id, order_id: job.order_id, actor_user_id: actor.local_id, action: `sync.print.${transition.status}`, entity_type: "print_job", entity_id: transition.jobGlobalId, details: transition.errorMessage });
          const response = { jobGlobalId: transition.jobGlobalId, revision };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "print_job", entity_global_id: transition.jobGlobalId, action: transition.status, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result: response };
        }
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
        if (command.domain === "inventory" && command.action === "adjust") {
          const adjustment = payload.data as z.infer<typeof payloadSchemas["inventory.adjust"]>;
          if (!hasPermission(assignment.role, "inventory:adjust") || adjustment.override && !hasPermission(assignment.role, "inventory:override")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "stock_movement", entity_id: adjustment.movementGlobalId, reason: adjustment.override ? "inventory:override" : "inventory:adjust", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks stock adjustment permission." };
          }
          const [ingredientIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.global_id, adjustment.ingredientGlobalId), eq(syncGlobalEntities.branch_id, device.branch_id))).limit(1);
          const [locationIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.global_id, adjustment.locationGlobalId), eq(syncGlobalEntities.branch_id, device.branch_id))).limit(1);
          const ingredientId = ingredientIdentity ? Number(ingredientIdentity.local_id) : 0;
          const locationId = locationIdentity ? Number(locationIdentity.local_id) : 0;
          const ingredient = ingredientId ? await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, ingredientId), eq(ingredients.branch_id, device.branch_id), eq(ingredients.is_active, true)) }) : undefined;
          const location = locationId ? await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.branch_id, device.branch_id), eq(inventoryLocations.is_active, true)) }) : undefined;
          const priorMovement = await tx.query.stockMovements.findFirst({ where: eq(stockMovements.idempotency_key, adjustment.idempotencyKey) });
          if (priorMovement) return { operationId: command.operationId, status: "rejected", error: "Stock adjustment idempotency key already exists outside this command." };
          if (!ingredient || !location) return { operationId: command.operationId, status: "rejected", error: "Ingredient or inventory location is not available in this branch." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          let movement;
          if (adjustment.direction === "positive") {
            movement = await postStockIncrease(tx, { branchId: device.branch_id, locationId, ingredientId, quantityBase: adjustment.quantityBase, unitCostMicros: adjustment.unitCostMicros, actorUserId: actor.local_id, idempotencyKey: adjustment.idempotencyKey, movementType: adjustment.opening ? "opening_balance" : "manual_positive", reason: adjustment.reason });
          } else {
            await tx.execute(sql`select id from stock_balances where ingredient_id = ${ingredientId} and location_id = ${locationId} for update`);
            const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, locationId), eq(stockBalances.ingredient_id, ingredientId)) });
            if (!balance) throw new Error("Stock balance is unavailable centrally.");
            if (balance.quantity_base < adjustment.quantityBase && (!adjustment.override || !ingredient.allow_negative)) throw new Error("Negative stock override is not permitted for this ingredient.");
            const [createdMovement] = await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: locationId, ingredient_id: ingredientId, movement_type: balance.quantity_base < adjustment.quantityBase ? "negative_override" : "manual_negative", direction: -1, quantity_base: adjustment.quantityBase, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: costMinorForQuantity(adjustment.quantityBase, balance.average_unit_cost_micros), source_type: "inventory_adjustment", source_id: adjustment.idempotencyKey, idempotency_key: adjustment.idempotencyKey, actor_user_id: actor.local_id, reason: adjustment.reason }).returning();
            await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - adjustment.quantityBase, updated_at: new Date() }).where(eq(stockBalances.id, balance.id));
            movement = createdMovement!;
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: balance.quantity_base < adjustment.quantityBase ? actor.local_id : null, action: balance.quantity_base < adjustment.quantityBase ? "inventory.negative_override" : "inventory.adjustment", entity_type: "stock_movement", entity_id: String(movement.id), reason: adjustment.reason });
          }
          const movementValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "stock_movement", global_id: adjustment.movementGlobalId, local_id: String(movement.id), server_revision: 1 };
          await tx.insert(syncGlobalEntities).values(movementValues);
          await tx.insert(syncEntityMappings).values({ ...movementValues, device_id: device.id, local_revision: 1 });
          const result = { movementGlobalId: adjustment.movementGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "stock_movement", entity_global_id: adjustment.movementGlobalId, action: "adjust", server_revision: 1, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "suppliers") {
          const supplierPayload = payload.data as z.infer<typeof payloadSchemas["suppliers.create"]> | z.infer<typeof payloadSchemas["suppliers.update"]> | z.infer<typeof payloadSchemas["suppliers.archive"]>;
          if (!hasPermission(assignment.role, "supplier:manage")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, reason: "supplier:manage", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks supplier management permission." };
          }
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.global_id, supplierPayload.supplierGlobalId))).for("update").limit(1);
          const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "supplier"), eq(syncEntityMappings.global_id, supplierPayload.supplierGlobalId))).for("update").limit(1);
          let revision = 1;
          let supplierId = identity ? Number(identity.local_id) : 0;
          let inboxId: number;
          if (command.action === "create") {
            if (identity) return { operationId: command.operationId, status: "rejected", error: "Supplier global identity already exists." };
            const values = (supplierPayload as z.infer<typeof payloadSchemas["suppliers.create"]>).values;
            const duplicateCode = await tx.query.suppliers.findFirst({ where: and(eq(suppliers.branch_id, device.branch_id), eq(suppliers.code, values.code)) });
            if (duplicateCode) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "supplier_code_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, local_payload: command.payload, server_snapshot: duplicateCode, reason: "The supplier code is already used in this branch." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.supplier.needs_review", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, conflictingSupplierId: duplicateCode.id }) });
              return { operationId: command.operationId, status: "needs_review", result: { supplierGlobalId: supplierPayload.supplierGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            inboxId = inbox!.id;
            const [created] = await tx.insert(suppliers).values({ branch_id: device.branch_id, code: values.code, name_en: values.nameEn, name_ar: values.nameAr, contact_name: values.contactName, phone: values.phone, email: values.email, address: values.address, notes: values.notes, is_active: true, created_by: actor.local_id, updated_by: actor.local_id }).returning();
            supplierId = created!.id;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", global_id: supplierPayload.supplierGlobalId, local_id: String(supplierId), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "supplier", global_id: supplierPayload.supplierGlobalId, local_id: String(supplierId), local_revision: 1, server_revision: 1 });
          } else {
            if (!identity || !deviceMapping || identity.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Supplier identity is unavailable in this branch." };
            const baseRevision = "baseRevision" in supplierPayload ? supplierPayload.baseRevision : command.baseRevision;
            if (deviceMapping.server_revision !== baseRevision) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              inboxId = inbox!.id;
              const serverSupplier = await tx.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
              await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
              await tx.insert(syncConflicts).values({ inbox_id: inboxId, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, local_payload: command.payload, server_snapshot: serverSupplier ?? {}, reason: "Supplier was changed on the central server after this device's base revision." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.supplier.needs_review", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision, serverRevision: deviceMapping.server_revision }) });
              return { operationId: command.operationId, status: "needs_review", result: { supplierGlobalId: supplierPayload.supplierGlobalId } };
            }
            if (command.action === "archive") {
              const archive = supplierPayload as z.infer<typeof payloadSchemas["suppliers.archive"]>;
              await tx.update(suppliers).set({ is_active: false, updated_by: actor.local_id, updated_at: new Date() }).where(eq(suppliers.id, supplierId));
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier.archive", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, reason: archive.reason });
            } else {
              const values = (supplierPayload as z.infer<typeof payloadSchemas["suppliers.update"]>).values;
              await tx.update(suppliers).set({ code: values.code, name_en: values.nameEn, name_ar: values.nameAr, contact_name: values.contactName, phone: values.phone, email: values.email, address: values.address, notes: values.notes, updated_by: actor.local_id, updated_at: new Date() }).where(eq(suppliers.id, supplierId));
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier.update", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId });
            }
            revision = deviceMapping.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            inboxId = inbox!.id;
          }
          const result = { supplierGlobalId: supplierPayload.supplierGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "suppliers", entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
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
    const isOrder = change.domain === "orders" && change.entity_type === "order";
    const isPrintJob = change.domain === "printing" && change.entity_type === "print_job";
    const isPrintPreferences = change.domain === "printing" && change.entity_type === "register_print_preferences";
    const isCheckout = change.domain === "checkout" && change.entity_type === "order_checkout";
    const isCancellation = change.domain === "checkout" && change.entity_type === "order_cancellation";
    const isStockMovement = change.domain === "inventory" && change.entity_type === "stock_movement";
    const isSupplier = change.domain === "suppliers" && change.entity_type === "supplier";
    if (!isShift && !isCashMovement && !isOrder && !isPrintJob && !isPrintPreferences && !isCheckout && !isCancellation && !isStockMovement && !isSupplier && ((change.domain !== "customers" && change.domain !== "products") || (change.entity_type !== "customer" && change.entity_type !== "product"))) {
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
    else if (isStockMovement && mapping) {
      const movement = await db.query.stockMovements.findFirst({ where: eq(stockMovements.id, Number(mapping.local_id)) });
      if (!movement) throw new Error("A stock movement change has no authoritative ledger record.");
      {
        const [ingredient] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.local_id, String(movement.ingredient_id)))).limit(1);
        const [location] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.local_id, String(movement.location_id)))).limit(1);
        const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, movement.actor_user_id))).limit(1);
        if (!ingredient || !location || !actor) throw new Error("A stock movement change is missing a global ingredient, location, or actor mapping.");
        snapshot = { ingredientGlobalId: ingredient.global_id, locationGlobalId: location.global_id, actorGlobalId: actor.global_id, movementType: movement.movement_type, direction: movement.direction, quantityBase: movement.quantity_base, unitCostMicros: movement.unit_cost_micros, totalCostAmount: movement.total_cost_amount, sourceType: movement.source_type, sourceId: movement.source_id, idempotencyKey: movement.idempotency_key, reason: movement.reason, createdAt: movement.created_at.toISOString() };
      }
    }
    else if (isSupplier && mapping) {
      const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, Number(mapping.local_id)) });
      if (!supplier) throw new Error("A supplier change has no authoritative record.");
      const [updatedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, supplier.updated_by))).limit(1);
      if (!updatedBy) throw new Error("A supplier change is missing its actor identity mapping.");
      snapshot = { code: supplier.code, nameEn: supplier.name_en, nameAr: supplier.name_ar, contactName: supplier.contact_name, phone: supplier.phone, email: supplier.email, address: supplier.address, notes: supplier.notes, isActive: supplier.is_active, updatedByGlobalId: updatedBy.global_id };
    }
    else if (isOrder && mapping) {
      const order = await db.query.orders.findFirst({ where: eq(orders.id, Number(mapping.local_id)), with: { orderItems: { with: { modifiers: true } }, statusHistory: true } });
      if (order?.branch_id) {
        const globalFor = async (entityType: string, localId: string | number | null) => {
          if (localId === null) return null;
          const [identity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.local_id, String(localId)))).limit(1);
          return identity?.global_id ?? null;
        };
        const actorGlobalId = await globalFor("user", order.user_uid);
        const itemSnapshots = await Promise.all(order.orderItems.map(async (item) => ({
          productGlobalId: await globalFor("product", item.product_id),
          menuItemGlobalId: await globalFor("menu_item", item.menu_item_id),
          variantGlobalId: await globalFor("menu_item_variant", item.variant_id),
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          modifiers: await Promise.all(item.modifiers.map(async (modifier) => ({ modifierOptionGlobalId: await globalFor("modifier_option", modifier.modifier_option_id), name_en: modifier.name_en, name_ar: modifier.name_ar, price_delta: modifier.price_delta }))),
        })));
        const history = await Promise.all(order.statusHistory.map(async (entry) => ({ fromStatus: entry.from_status, toStatus: entry.to_status, actorGlobalId: await globalFor("user", entry.changed_by), note: entry.note, createdAt: entry.created_at.toISOString() })));
        if (actorGlobalId && itemSnapshots.every((item) => item.menuItemGlobalId) && itemSnapshots.every((item) => item.modifiers.every((modifier) => modifier.modifierOptionGlobalId))) {
          snapshot = {
            branchGlobalId: await globalFor("branch", order.branch_id),
            customerGlobalId: await globalFor("customer", order.customer_id),
            diningTableGlobalId: await globalFor("restaurant_table", order.dining_table_id),
            actorGlobalId,
            clientRequestId: order.client_request_id,
            orderType: order.order_type,
            deliveryAddress: order.delivery_address,
            status: order.status,
            paymentStatus: order.payment_status,
            subtotalAmount: order.subtotal_amount,
            discountType: order.discount_type,
            discountValue: order.discount_value,
            discountAmount: order.discount_amount,
            discountReason: order.discount_reason,
            totalAmount: order.total_amount,
            createdAt: order.created_at?.toISOString() ?? order.updated_at.toISOString(),
            updatedAt: order.updated_at.toISOString(),
            items: itemSnapshots,
            history,
          };
        }
      }
    }
    else if (isPrintJob && mapping) {
      const job = await db.query.printJobs.findFirst({ where: eq(printJobs.id, Number(mapping.local_id)) });
      if (job) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(job.order_id)))).limit(1);
        const [requestedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.requested_by))).limit(1);
        const [approvedBy] = job.approved_by ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.approved_by))).limit(1) : [undefined];
        const [station] = job.station_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "kitchen_station"), eq(syncGlobalEntities.local_id, String(job.station_id)))).limit(1) : [undefined];
        const [shift] = job.shift_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(job.shift_id)))).limit(1) : [undefined];
        if (orderIdentity && requestedBy) snapshot = { orderGlobalId: orderIdentity.global_id, stationGlobalId: station?.global_id ?? null, shiftGlobalId: shift?.global_id ?? null, requestedByGlobalId: requestedBy.global_id, approvedByGlobalId: approvedBy?.global_id ?? null, documentType: job.document_type, status: job.status, isReprint: job.is_reprint, idempotencyKey: job.idempotency_key, copyCount: job.copy_count, paperWidth: job.paper_width, language: job.language, reprintReason: job.reprint_reason, errorMessage: job.error_message, requestedAt: job.requested_at.toISOString(), previewedAt: job.previewed_at?.toISOString() ?? null, acknowledgedAt: job.acknowledged_at?.toISOString() ?? null };
      }
    }
    else if (isPrintPreferences && mapping) {
      const preference = await db.query.registerPrintPreferences.findFirst({ where: eq(registerPrintPreferences.id, Number(mapping.local_id)) });
      if (preference) {
        const [register] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(preference.register_id)))).limit(1);
        const [updatedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, preference.updated_by))).limit(1);
        if (register && updatedBy) snapshot = { registerGlobalId: register.global_id, updatedByGlobalId: updatedBy.global_id, paperWidth: preference.paper_width, language: preference.language, receiptCopies: preference.receipt_copies, kotCopies: preference.kot_copies, updatedAt: preference.updated_at.toISOString() };
      }
    }
    else if (isCheckout && mapping) {
      const checkout = await db.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.id, Number(mapping.local_id)) });
      if (checkout) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(checkout.order_id)))).limit(1);
        const [shiftIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(checkout.shift_id)))).limit(1);
        const [actorIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, checkout.created_by))).limit(1);
        const [approverIdentity] = checkout.approved_by ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, checkout.approved_by))).limit(1) : [undefined];
        const payments = await db.select().from(orderPayments).where(and(eq(orderPayments.checkout_id, checkout.id), eq(orderPayments.kind, "payment")));
        const paymentSnapshots = await Promise.all(payments.map(async (payment) => {
          const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, payment.payment_method_id) });
          const [paymentIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(payment.id)))).limit(1);
          const [transaction] = await db.select().from(transactions).where(eq(transactions.order_payment_id, payment.id)).limit(1);
          const [transactionIdentity] = transaction ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "transaction"), eq(syncGlobalEntities.local_id, String(transaction.id)))).limit(1) : [undefined];
          if (!method || !paymentIdentity || !transaction || !transactionIdentity) return null;
          return { paymentGlobalId: paymentIdentity.global_id, transactionGlobalId: transactionIdentity.global_id, methodCode: method.code, amount: payment.amount, tenderedAmount: payment.tendered_amount, changeAmount: payment.change_amount, createdAt: payment.created_at.toISOString() };
        }));
        if (orderIdentity && shiftIdentity && actorIdentity && paymentSnapshots.every(Boolean)) snapshot = { orderGlobalId: orderIdentity.global_id, shiftGlobalId: shiftIdentity.global_id, actorGlobalId: actorIdentity.global_id, idempotencyKey: checkout.idempotency_key, subtotalAmount: checkout.subtotal_amount, discountAmount: checkout.discount_amount, payableAmount: checkout.payable_amount, approvedByGlobalId: approverIdentity?.global_id ?? null, createdAt: checkout.created_at.toISOString(), payments: paymentSnapshots };
      }
    }
    else if (isCancellation && mapping) {
      const cancellation = await db.query.orderCancellations.findFirst({ where: eq(orderCancellations.id, Number(mapping.local_id)) });
      if (cancellation) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(cancellation.order_id)))).limit(1);
        const [shiftIdentity] = cancellation.shift_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(cancellation.shift_id)))).limit(1) : [undefined];
        const [actorIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, cancellation.cancelled_by))).limit(1);
        const refundRows = await db.select().from(orderPayments).where(and(eq(orderPayments.order_id, cancellation.order_id), eq(orderPayments.kind, "refund")));
        const refunds = await Promise.all(refundRows.map(async (refund) => {
          const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, refund.payment_method_id) });
          const [refundIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(refund.id)))).limit(1);
          const [originalIdentity] = refund.original_payment_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(refund.original_payment_id)))).limit(1) : [undefined];
          const [financial] = await db.select().from(transactions).where(eq(transactions.order_payment_id, refund.id)).limit(1);
          const [transactionIdentity] = financial ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "transaction"), eq(syncGlobalEntities.local_id, String(financial.id)))).limit(1) : [undefined];
          if (!method || !refundIdentity || !originalIdentity || !transactionIdentity) return null;
          return { refundGlobalId: refundIdentity.global_id, originalPaymentGlobalId: originalIdentity.global_id, transactionGlobalId: transactionIdentity.global_id, methodCode: method.code, amount: refund.amount, createdAt: refund.created_at.toISOString() };
        }));
        if (orderIdentity && actorIdentity && refunds.every(Boolean)) snapshot = { orderGlobalId: orderIdentity.global_id, shiftGlobalId: shiftIdentity?.global_id ?? null, actorGlobalId: actorIdentity.global_id, idempotencyKey: cancellation.idempotency_key, reason: cancellation.reason, wasPaid: cancellation.was_paid, inventoryDisposition: cancellation.inventory_disposition, createdAt: cancellation.created_at.toISOString(), refunds };
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
