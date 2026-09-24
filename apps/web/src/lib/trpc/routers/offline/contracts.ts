import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const OFFLINE_SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;
export const OFFLINE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function offlinePriceSnapshotTtlMs() {
  const configured = Number(process.env.FORNO_OFFLINE_PRICE_SNAPSHOT_TTL_MS ?? OFFLINE_SNAPSHOT_MAX_AGE_MS);
  return Number.isFinite(configured) ? Math.max(5 * 60 * 1000, Math.min(configured, 7 * 24 * 60 * 60 * 1000)) : OFFLINE_SNAPSHOT_MAX_AGE_MS;
}

export const OFFLINE_CONFLICT_CODES = [
  "menu_price_changed",
  "menu_item_unavailable",
  "variant_unavailable",
  "modifier_unavailable",
  "table_occupied",
  "shift_closed",
  "register_unavailable",
  "permission_changed",
  "user_branch_mismatch",
  "cash_insufficient",
  "price_snapshot_invalid",
  "price_snapshot_expired",
  "receipt_payload_tampered",
  "duplicate_already_accepted",
  "invalid_order",
  "recipe_missing",
  "stock_unavailable",
  "insufficient_stock",
  "invalid_recipe",
] as const;

export type OfflineConflictCode = (typeof OFFLINE_CONFLICT_CODES)[number];

export class OfflineConflict extends Error {
  constructor(
    readonly code: OfflineConflictCode,
    message: string,
    readonly financial = false,
  ) {
    super(message);
  }
}

export const offlineItemSchema = z.object({
  menuItemId: z.number().int().positive(),
  variantId: z.number().int().positive().nullable(),
  modifierOptionIds: z.array(z.number().int().positive()).max(20),
  quantity: z.number().int().min(1).max(100),
  notes: z.string().trim().max(500).nullable(),
});

export const offlineOperationSchema = z.object({
  kind: z.enum(["order", "cash_sale"]),
  clientOperationId: z.string().trim().min(12).max(100),
  snapshotRevision: z.string().trim().min(8).max(100),
  priceSnapshotReference: z.string().trim().min(12).max(80),
  priceSnapshotRevision: z.string().trim().min(16).max(64),
  branchId: z.number().int().positive(),
  registerId: z.number().int().positive(),
  shiftId: z.number().int().positive(),
  order: z.object({
    clientRequestId: z.string().trim().min(12).max(80),
    orderType: z.enum(["dine_in", "takeaway", "delivery"]),
    diningTableId: z.number().int().positive().nullable(),
    deliveryAddress: z.string().trim().min(3).max(500).nullable(),
    deliveryContact: z.object({
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(6).max(24),
    }).nullable(),
    expectedTotal: z.number().int().nonnegative(),
    items: z.array(offlineItemSchema).min(1).max(100),
  }),
  cash: z.object({
    checkoutIdempotencyKey: z.string().trim().min(12).max(100),
    tenderedAmount: z.number().int().positive(),
  }).nullable(),
  offlineReceipt: z.object({
    number: z.string().trim().regex(/^OFF-[A-Z0-9-]{12,76}$/),
    deviceInstanceId: z.string().trim().min(16).max(100),
    checkoutAt: z.string().datetime({ offset: true }),
    subtotal: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    cashReceived: z.number().int().positive(),
    change: z.number().int().nonnegative(),
    printIdempotencyKey: z.string().trim().min(12).max(120),
    previewedAt: z.string().datetime({ offset: true }).nullable(),
  }).nullable(),
  kotAcknowledgements: z.array(z.object({
    stationId: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(12).max(120),
    previewed: z.boolean(),
    acknowledged: z.boolean(),
  })).max(20),
}).superRefine((value, ctx) => {
  if ((value.kind === "cash_sale") !== Boolean(value.cash)) {
    ctx.addIssue({ code: "custom", message: "Cash details are required only for an offline cash sale" });
  }
  if ((value.kind === "cash_sale") !== Boolean(value.offlineReceipt)) {
    ctx.addIssue({ code: "custom", message: "An immutable offline cash receipt is required only for an offline cash sale" });
  }
  if (value.order.orderType === "dine_in" && !value.order.diningTableId) {
    ctx.addIssue({ code: "custom", message: "Dine-in orders require a table" });
  }
  if (value.order.orderType !== "dine_in" && value.order.diningTableId) {
    ctx.addIssue({ code: "custom", message: "Only dine-in orders may select a table" });
  }
  if (value.order.orderType === "delivery" && (!value.order.deliveryAddress || !value.order.deliveryContact)) {
    ctx.addIssue({ code: "custom", message: "Delivery orders require a minimal delivery contact and address" });
  }
  if (value.order.orderType !== "delivery" && (value.order.deliveryAddress || value.order.deliveryContact)) {
    ctx.addIssue({ code: "custom", message: "Only delivery orders may contain delivery data" });
  }
});

export type OfflineSyncInput = z.infer<typeof offlineOperationSchema>;

export function snapshotRevision(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function conflictCategory(code: OfflineConflictCode) {
  if (["shift_closed", "register_unavailable"].includes(code)) return "temporary" as const;
  if (["permission_changed", "user_branch_mismatch"].includes(code)) return "permission" as const;
  if (["menu_price_changed", "cash_insufficient", "price_snapshot_invalid", "price_snapshot_expired", "receipt_payload_tampered", "recipe_missing", "stock_unavailable", "insufficient_stock"].includes(code)) return "financial" as const;
  return "validation" as const;
}

export function stableDeliveryEmail(branchId: number, userId: string, phone: string) {
  const digest = createHash("sha256").update(`${branchId}:${userId}:${phone}`).digest("hex").slice(0, 24);
  return `offline-${digest}@forno.local`;
}

export type OfflinePricingPayload = {
  items: Array<{
    id: number;
    basePrice: number;
    variants: Array<{ id: number; price: number }>;
    modifiers: Array<{ id: number; priceDelta: number }>;
  }>;
};

export function expectedOfflineReceiptNumber(input: { branchCode: string; registerCode: string; branchId: number; registerId: number; deviceInstanceId: string; checkoutIdempotencyKey: string; checkoutAt: string }) {
  const date = input.checkoutAt.slice(0, 10).replaceAll("-", "");
  const digest = createHash("sha256").update(`${input.branchId}:${input.registerId}:${input.deviceInstanceId}:${input.checkoutIdempotencyKey}`).digest("hex").slice(0, 16).toUpperCase();
  const branchCode = input.branchCode.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "BRANCH";
  const registerCode = input.registerCode.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "REG";
  return `OFF-${branchCode}-${registerCode}-${date}-${digest}`;
}
