import type { RouterInputs, RouterOutputs } from "@/lib/trpc/router";

export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_QUEUE_VERSION = 1;

export type OfflineBootstrapSnapshot = RouterOutputs["offline"]["bootstrap"];
export type OfflineSyncPayload = RouterInputs["offline"]["sync"];
export type OfflineSyncResponse = RouterOutputs["offline"]["sync"];

export type OfflineQueueState = "pending" | "syncing" | "synced" | "failed" | "needs_review";
export type ConnectionState = "online" | "offline" | "syncing" | "synced" | "failed" | "needs_review";

export interface OfflineQueueEntry {
  version: typeof OFFLINE_QUEUE_VERSION;
  id: string;
  userId: string;
  branchId: number;
  kind: "order" | "cash_sale";
  financial: boolean;
  dependencies: string[];
  payload: OfflineSyncPayload;
  state: OfflineQueueState;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  authoritativeOrderId: number | null;
  authoritativeCheckoutId: number | null;
  authoritativeReceiptJobId: number | null;
  conflict: OfflineSyncResponse["conflict"];
  lastError: string | null;
}

export interface OfflineKotDocument {
  version: 1;
  id: string;
  kind: "kot";
  operationId: string;
  stationId: number;
  station: { code: string; name_en: string; name_ar: string };
  orderReference: string;
  orderType: "dine_in" | "takeaway" | "delivery";
  table: { name_en: string; name_ar: string } | null;
  items: Array<{
    nameEn: string;
    nameAr: string;
    variantNameEn: string | null;
    variantNameAr: string | null;
    modifiers: Array<{ nameEn: string; nameAr: string }>;
    quantity: number;
    notes: string;
  }>;
  previewed: boolean;
  acknowledged: boolean;
  createdAt: string;
}

export interface OfflineOrderSummaryDocument {
  version: 1;
  id: string;
  kind: "order_summary";
  operationId: string;
  orderReference: string;
  orderType: "dine_in" | "takeaway" | "delivery";
  items: Array<{ nameEn: string; nameAr: string; quantity: number; provisionalLineTotal: number }>;
  provisionalTotal: number;
  cashReceived: number | null;
  estimatedChange: number | null;
  createdAt: string;
}

export type OfflineDocument = OfflineKotDocument | OfflineOrderSummaryDocument;

export function newOfflineId(prefix: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}
