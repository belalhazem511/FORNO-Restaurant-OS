import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLogs,
  customers,
  syncDevices,
  syncEntityMappings,
  syncGlobalEntities,
  syncOutbox,
} from "@/lib/db/schema";

type LocalTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CustomerCommandAction = "create" | "update";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function recordLocalCustomerCommand(
  tx: LocalTransaction,
  input: {
    action: CustomerCommandAction;
    customer: typeof customers.$inferSelect;
    actorId: string;
  },
) {
  if (process.env.FORNO_DESKTOP_MODE !== "1") return;
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
  if (!deviceId) throw new Error("The desktop device identity is unavailable.");

  const [device] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).for("update").limit(1);
  if (!device) throw new Error("The local synchronization identity is unavailable.");

  const branchIdentity = await tx.query.syncEntityMappings.findFirst({
    where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "branch"), eq(syncEntityMappings.local_id, String(device.branch_id))),
  });
  let actorIdentity = await tx.query.syncGlobalEntities.findFirst({
    where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, input.actorId)),
  });
  if (!branchIdentity) throw new Error("The local branch mapping is unavailable.");
  if (!actorIdentity) {
    const globalId = randomUUID();
    [actorIdentity] = await tx.insert(syncGlobalEntities).values({
      organization_id: device.organization_id,
      branch_id: device.branch_id,
      entity_type: "user",
      global_id: globalId,
      local_id: input.actorId,
    }).returning();
    await tx.insert(syncEntityMappings).values({
      organization_id: device.organization_id,
      device_id: device.id,
      branch_id: device.branch_id,
      entity_type: "user",
      global_id: globalId,
      local_id: input.actorId,
    });
  }

  let customerIdentity = await tx.query.syncEntityMappings.findFirst({
    where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.local_id, String(input.customer.id))),
  });
  if (!customerIdentity) {
    const globalId = randomUUID();
    [customerIdentity] = await tx.insert(syncEntityMappings).values({
      organization_id: device.organization_id,
      device_id: device.id,
      branch_id: device.branch_id,
      entity_type: "customer",
      global_id: globalId,
      local_id: String(input.customer.id),
    }).returning();
    await tx.insert(syncGlobalEntities).values({
      organization_id: device.organization_id,
      branch_id: device.branch_id,
      entity_type: "customer",
      global_id: globalId,
      local_id: String(input.customer.id),
    });
  } else {
    await tx.update(syncEntityMappings).set({ local_revision: customerIdentity.local_revision + 1, updated_at: new Date() })
      .where(eq(syncEntityMappings.id, customerIdentity.id));
  }

  const action = input.action;
  const payload = {
    customerGlobalId: customerIdentity.global_id,
    values: { name: input.customer.name, email: input.customer.email, phone: input.customer.phone, status: input.customer.status },
  };
  const payloadHash = createHash("sha256").update(stableJson(payload)).digest("hex");
  const idempotencyKey = randomUUID();
  const operationId = randomUUID();
  const pendingCommands = await tx.select({ operation_id: syncOutbox.operation_id, payload: syncOutbox.payload })
    .from(syncOutbox)
    .where(and(eq(syncOutbox.device_id, device.id), eq(syncOutbox.domain, "customers"), eq(syncOutbox.state, "pending")));
  const dependencies = pendingCommands
    .filter((command) => command.payload.customerGlobalId === customerIdentity.global_id)
    .map((command) => command.operation_id);
  await tx.insert(auditLogs).values({
    branch_id: device.branch_id,
    actor_user_id: input.actorId,
    action: `sync.customer.${action}.queued`,
    entity_type: "customer",
    entity_id: customerIdentity.global_id,
    details: JSON.stringify({ operationId, payloadHash }),
  });
  await tx.insert(syncOutbox).values({
    operation_id: operationId,
    organization_id: device.organization_id,
    device_id: device.id,
    branch_id: device.branch_id,
    register_id: device.register_id,
    actor_global_id: actorIdentity.global_id,
    domain: "customers",
    action,
    schema_version: 1,
    payload,
    payload_hash: payloadHash,
    idempotency_key: idempotencyKey,
    base_revision: customerIdentity.server_revision + dependencies.length,
    dependencies,
    device_timestamp: new Date(),
  });
}
