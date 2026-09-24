import type { RouterInputs, RouterOutputs } from "@/lib/trpc/router";

export const OFFLINE_DB_VERSION = 2;
export const OFFLINE_QUEUE_VERSION = 2;

export type OfflineBootstrapSnapshot = RouterOutputs["offline"]["bootstrap"];
export type OfflineSyncPayload = RouterInputs["offline"]["sync"];
export type OfflineSyncResponse = RouterOutputs["offline"]["sync"];

export type OfflineQueueState = "pending" | "syncing" | "synced" | "failed" | "needs_review";
export type ConnectionState = "local" | "online" | "offline" | "syncing" | "synced" | "failed" | "needs_review";

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

export interface OfflineCashReceiptDocument {
  version: 1;
  id: string;
  kind: "offline_cash_receipt";
  operationId: string;
  orderReference: string;
  offlineReceiptNumber: string;
  checkoutIdempotencyKey: string;
  priceSnapshot: { reference: string; revision: string; expiresAt: string };
  checkoutAt: string;
  restaurant: {
    name: { en: string; ar: string };
    branch: { en: string; ar: string };
    address: { en: string; ar: string };
    phone: string | null;
  };
  operator: {
    cashier: string;
    register: { en: string; ar: string; code: string };
    shiftNumber: string;
  };
  order: {
    type: "dine_in" | "takeaway" | "delivery";
    area: { en: string; ar: string } | null;
    table: { en: string; ar: string } | null;
    customerName: string | null;
    customerPhone: string | null;
    deliveryAddress: string | null;
  };
  items: Array<{
    name: { en: string; ar: string };
    variant: { en: string; ar: string } | null;
    modifiers: Array<{ name: { en: string; ar: string }; priceDelta: number }>;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    notes: string | null;
  }>;
  financial: {
    subtotal: number;
    total: number;
    cashReceived: number;
    change: number;
  };
  printing: {
    paperWidth: 58 | 80;
    language: "ar" | "en" | "bilingual";
    copyCount: number;
  };
  printIdempotencyKey: string;
  createdAt: string;
}

export type OfflineDocument = OfflineKotDocument | OfflineOrderSummaryDocument | OfflineCashReceiptDocument;

export function newOfflineId(prefix: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}
