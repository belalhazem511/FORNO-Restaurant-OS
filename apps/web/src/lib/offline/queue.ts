import type { OfflineStore } from "./storage";
import { OFFLINE_QUEUE_VERSION, type OfflineQueueEntry, type OfflineSyncPayload, type OfflineSyncResponse } from "./types";

export function retryDelayMs(attempt: number, random = Math.random) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

export type RetryClassification = "network" | "temporary" | "validation" | "permission" | "permanent";

export function classifySyncError(cause: unknown): RetryClassification {
  const value = cause as { data?: { code?: string; httpStatus?: number }; message?: string } | null;
  const code = value?.data?.code;
  const status = value?.data?.httpStatus;
  const message = value?.message?.toLowerCase() ?? "";
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || status === 401 || status === 403) return "permission";
  if (code === "BAD_REQUEST" || code === "UNPROCESSABLE_CONTENT" || status === 400 || status === 422) return "validation";
  if (code === "CONFLICT" || status === 409) return "permanent";
  if (code === "TIMEOUT" || code === "INTERNAL_SERVER_ERROR" || status === 429 || (status != null && status >= 500)) return "temporary";
  if (/network|fetch|offline|connection/.test(message) || cause instanceof TypeError) return "network";
  return "temporary";
}

export function createQueueEntry(input: {
  payload: OfflineSyncPayload;
  userId: string;
  dependencies?: string[];
  now?: Date;
}): OfflineQueueEntry {
  const now = (input.now ?? new Date()).toISOString();
  return {
    version: OFFLINE_QUEUE_VERSION,
    id: input.payload.clientOperationId,
    userId: input.userId,
    branchId: input.payload.branchId,
    kind: input.payload.kind,
    financial: input.payload.kind === "cash_sale",
    dependencies: input.dependencies ?? [],
    payload: input.payload,
    state: "pending",
    attempts: 0,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
    authoritativeOrderId: null,
    authoritativeCheckoutId: null,
    authoritativeReceiptJobId: null,
    conflict: null,
    lastError: null,
  };
}

export function snapshotAgeState(snapshot: { staleAt: Date | string; expiresAt: Date | string }, now = new Date()) {
  const staleAt = new Date(snapshot.staleAt).getTime();
  const expiresAt = new Date(snapshot.expiresAt).getTime();
  if (now.getTime() >= expiresAt) return "expired" as const;
  if (now.getTime() >= staleAt) return "stale" as const;
  return "fresh" as const;
}

export type QueueLock = <T>(task: () => Promise<T>) => Promise<T | null>;

export const browserQueueLock: QueueLock = async (task) => {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("forno-offline-sync-v1", { ifAvailable: true }, async (lock) => lock ? task() : null);
  }
  if (typeof localStorage === "undefined") return task();
  const key = "forno-offline-sync-lease-v1";
  const owner = `${Date.now()}-${Math.random()}`;
  const now = Date.now();
  const current = JSON.parse(localStorage.getItem(key) ?? "null") as { owner: string; expires: number } | null;
  if (current && current.expires > now) return null;
  localStorage.setItem(key, JSON.stringify({ owner, expires: now + 15_000 }));
  try {
    const confirmed = JSON.parse(localStorage.getItem(key) ?? "null") as { owner: string } | null;
    return confirmed?.owner === owner ? await task() : null;
  } finally {
    const confirmed = JSON.parse(localStorage.getItem(key) ?? "null") as { owner: string } | null;
    if (confirmed?.owner === owner) localStorage.removeItem(key);
  }
};

function scrubAcknowledgedPayload(payload: OfflineSyncPayload): OfflineSyncPayload {
  if (payload.order.orderType !== "delivery") return payload;
  return {
    ...payload,
    order: { ...payload.order, deliveryAddress: null, deliveryContact: null },
  };
}

export class OfflineSyncEngine {
  constructor(
    private readonly store: OfflineStore,
    private readonly send: (payload: OfflineSyncPayload) => Promise<OfflineSyncResponse>,
    private readonly health: () => Promise<boolean>,
    private readonly lock: QueueLock = browserQueueLock,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async syncOnce(userId?: string) {
    return this.lock(async () => {
      if (!(await this.health())) return { processed: 0, online: false };
      const entries = await this.store.listQueue();
      const ownedEntries = userId ? entries.filter((entry) => entry.userId === userId) : entries;
      const acknowledged = new Set(ownedEntries.filter((entry) => entry.state === "synced").map((entry) => entry.id));
      let processed = 0;
      for (const entry of ownedEntries) {
        if (!["pending", "failed"].includes(entry.state)) continue;
        if (entry.nextAttemptAt && new Date(entry.nextAttemptAt) > this.now()) continue;
        if (entry.dependencies.some((dependency) => !acknowledged.has(dependency))) continue;
        const syncing = { ...entry, state: "syncing" as const, updatedAt: this.now().toISOString() };
        await this.store.putQueue(syncing);
        try {
          const response = await this.send(entry.payload);
          if (response.status === "accepted") {
            const synced: OfflineQueueEntry = {
              ...syncing,
              payload: scrubAcknowledgedPayload(syncing.payload),
              state: "synced",
              acknowledgedAt: this.now().toISOString(),
              authoritativeOrderId: response.orderId,
              authoritativeCheckoutId: response.checkoutId,
              authoritativeReceiptJobId: response.receiptJobId,
              conflict: null,
              lastError: null,
              updatedAt: this.now().toISOString(),
            };
            await this.store.putQueue(synced);
            acknowledged.add(entry.id);
          } else {
            await this.store.putQueue({ ...syncing, state: "needs_review", conflict: response.conflict, lastError: response.conflict?.message ?? "Needs review", updatedAt: this.now().toISOString() });
          }
        } catch (cause) {
          const classification = classifySyncError(cause);
          if (["validation", "permission", "permanent"].includes(classification)) {
            await this.store.putQueue({ ...syncing, state: "needs_review", lastError: cause instanceof Error ? cause.message : String(cause), updatedAt: this.now().toISOString() });
            processed += 1;
            continue;
          }
          const attempts = syncing.attempts + 1;
          const delay = retryDelayMs(attempts, this.random);
          await this.store.putQueue({ ...syncing, state: "failed", attempts, nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(), lastError: cause instanceof Error ? cause.message : String(cause), updatedAt: this.now().toISOString() });
        }
        processed += 1;
      }
      return { processed, online: true };
    });
  }

  async manualRetry(id: string) {
    const entry = await this.store.getQueue(id);
    if (!entry || entry.state === "synced" || entry.state === "syncing") return false;
    await this.store.putQueue({ ...entry, state: "pending", attempts: 0, nextAttemptAt: null, conflict: null, lastError: null, updatedAt: this.now().toISOString() });
    return true;
  }

  async recoverInterrupted() {
    const entries = await this.store.listQueue();
    for (const entry of entries.filter((value) => value.state === "syncing")) {
      await this.store.putQueue({ ...entry, state: "pending", nextAttemptAt: null, lastError: "Synchronization was interrupted and will safely retry", updatedAt: this.now().toISOString() });
    }
  }
}
