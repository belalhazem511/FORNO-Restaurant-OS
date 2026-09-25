import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, syncDevices, syncEntityMappings, syncGlobalEntities, syncOutbox } from "@/lib/db/schema";

type LocalTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LocalCommandInput<Result> = {
  actorId: string;
  domain: string;
  action: string;
  entityType: string;
  localId(result: Result): string | null;
  payload(globalId: string, result: Result): Record<string, unknown>;
  dependsOnGlobalIds?(result: Result): string[];
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function executeLocalCommand<Result>(
  tx: LocalTransaction,
  input: LocalCommandInput<Result>,
  apply: (tx: LocalTransaction) => Promise<Result>,
): Promise<Result> {
  if (process.env.FORNO_DESKTOP_MODE !== "1") return apply(tx);
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
  if (!deviceId) throw new Error("The desktop device identity is unavailable.");
  const [device] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).for("update").limit(1);
  if (!device) throw new Error("The local synchronization identity is unavailable.");
  const branchIdentity = await tx.query.syncEntityMappings.findFirst({
    where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "branch"), eq(syncEntityMappings.local_id, String(device.branch_id))),
  });
  if (!branchIdentity) throw new Error("The local branch mapping is unavailable.");

  let actorIdentity = await tx.query.syncGlobalEntities.findFirst({
    where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, input.actorId)),
  });
  if (!actorIdentity) {
    const globalId = randomUUID();
    [actorIdentity] = await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "user", global_id: globalId, local_id: input.actorId }).returning();
  }
  const actorMapping = await tx.query.syncEntityMappings.findFirst({
    where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.local_id, input.actorId)),
  });
  if (!actorMapping) {
    await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "user", global_id: actorIdentity!.global_id, local_id: input.actorId });
  }

  const result = await apply(tx);
  const localId = input.localId(result);
  if (localId === null) return result;
  let entityMapping = await tx.query.syncEntityMappings.findFirst({
    where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, input.entityType), eq(syncEntityMappings.local_id, localId)),
  });
  if (!entityMapping) {
    const globalId = randomUUID();
    [entityMapping] = await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: input.entityType, global_id: globalId, local_id: localId }).returning();
    await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: input.entityType, global_id: globalId, local_id: localId });
  } else {
    await tx.update(syncEntityMappings).set({ local_revision: entityMapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, entityMapping.id));
  }

  const payload = input.payload(entityMapping.global_id, result);
  const payloadHash = createHash("sha256").update(stableJson(payload)).digest("hex");
  const operationId = randomUUID();
  const idempotencyKey = randomUUID();
  const pendingCommands = await tx.select({ operation_id: syncOutbox.operation_id, payload: syncOutbox.payload })
    .from(syncOutbox)
    .where(and(eq(syncOutbox.device_id, device.id), eq(syncOutbox.domain, input.domain), eq(syncOutbox.state, "pending")));
  const relatedGlobalIds = new Set([entityMapping.global_id, ...(input.dependsOnGlobalIds?.(result) ?? [])]);
  const dependencies = pendingCommands.filter((command) => Object.values(command.payload).some((value) => typeof value === "string" && relatedGlobalIds.has(value))).map((command) => command.operation_id);
  const entityDependencies = pendingCommands.filter((command) => command.payload[`${input.entityType}GlobalId`] === entityMapping!.global_id).length;
  await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: input.actorId, action: `sync.${input.domain}.${input.action}.queued`, entity_type: input.entityType, entity_id: entityMapping.global_id, details: JSON.stringify({ operationId, payloadHash }) });
  await tx.insert(syncOutbox).values({
    operation_id: operationId,
    organization_id: device.organization_id,
    device_id: device.id,
    branch_id: device.branch_id,
    register_id: device.register_id,
    actor_global_id: actorIdentity!.global_id,
    domain: input.domain,
    action: input.action,
    schema_version: 1,
    payload,
    payload_hash: payloadHash,
    idempotency_key: idempotencyKey,
    base_revision: entityMapping.server_revision + entityDependencies,
    dependencies,
    device_timestamp: new Date(),
  });
  return result;
}
