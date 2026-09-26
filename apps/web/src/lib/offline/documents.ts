import type { CartLine } from "@/lib/pos/cart";
import type { OfflineBootstrapSnapshot, OfflineCashReceiptDocument, OfflineKotDocument, OfflineOrderSummaryDocument } from "./types";

export async function offlineReceiptNumber(input: { branchId: number; branchCode: string; registerId: number; registerCode: string; deviceInstanceId: string; checkoutIdempotencyKey: string; checkoutAt: string }) {
  if (!globalThis.crypto?.subtle) throw new Error("Secure receipt identity is unavailable in this browser");
  const canonical = `${input.branchId}:${input.registerId}:${input.deviceInstanceId}:${input.checkoutIdempotencyKey}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const suffix = [...new Uint8Array(digest)].slice(0, 8).map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  const date = input.checkoutAt.slice(0, 10).replaceAll("-", "");
  const branch = input.branchCode.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "BRANCH";
  const register = input.registerCode.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "REG";
  return `OFF-${branch}-${register}-${date}-${suffix}`;
}

export function buildOfflineKots(input: {
  operationId: string;
  orderReference: string;
  orderType: "dine_in" | "takeaway" | "delivery";
  tableId: number | null;
  cart: CartLine[];
  snapshot: OfflineBootstrapSnapshot;
  createdAt?: Date;
}) {
  const itemsById = new Map(input.snapshot.branch.menuCategories.flatMap((category) => category.menuItems).map((item) => [item.id, item] as const));
  const table = input.snapshot.branch.diningAreas.flatMap((area) => area.tables).find((entry) => entry.id === input.tableId) ?? null;
  const grouped = new Map<number, OfflineKotDocument["items"]>();
  for (const line of input.cart) {
    const menuItem = itemsById.get(line.menuItemId);
    if (!menuItem) continue;
    const items = grouped.get(menuItem.kitchen_station_id) ?? [];
    items.push({ nameEn: line.nameEn, nameAr: line.nameAr, variantNameEn: line.variantNameEn, variantNameAr: line.variantNameAr, modifiers: line.modifiers.map((modifier) => ({ nameEn: modifier.nameEn, nameAr: modifier.nameAr })), quantity: line.quantity, notes: line.notes });
    grouped.set(menuItem.kitchen_station_id, items);
  }
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  return [...grouped.entries()].map(([stationId, items]): OfflineKotDocument => {
    const station = input.snapshot.branch.kitchenStations.find((entry) => entry.id === stationId)!;
    return { version: 1, id: `offline-kot:${input.operationId}:${stationId}`, kind: "kot", operationId: input.operationId, stationId, station: { code: station.code, name_en: station.name_en, name_ar: station.name_ar }, orderReference: input.orderReference, orderType: input.orderType, table: table ? { name_en: table.name_en, name_ar: table.name_ar } : null, items, previewed: false, acknowledged: false, createdAt };
  });
}

export function buildOfflineSummary(input: {
  operationId: string;
  orderReference: string;
  orderType: "dine_in" | "takeaway" | "delivery";
  cart: CartLine[];
  provisionalTotal: number;
  cashReceived: number | null;
  createdAt?: Date;
}): OfflineOrderSummaryDocument {
  return {
    version: 1,
    id: `offline-summary:${input.operationId}`,
    kind: "order_summary",
    operationId: input.operationId,
    orderReference: input.orderReference,
    orderType: input.orderType,
    items: input.cart.map((line) => ({ nameEn: line.nameEn, nameAr: line.nameAr, quantity: line.quantity, provisionalLineTotal: (line.basePrice + line.modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0)) * line.quantity })),
    provisionalTotal: input.provisionalTotal,
    cashReceived: input.cashReceived,
    estimatedChange: input.cashReceived == null ? null : Math.max(0, input.cashReceived - input.provisionalTotal),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function buildOfflineCashReceipt(input: {
  operationId: string;
  orderReference: string;
  offlineReceiptNumber: string;
  checkoutIdempotencyKey: string;
  printIdempotencyKey: string;
  checkoutAt: string;
  orderType: "dine_in" | "takeaway" | "delivery";
  areaId: number | null;
  tableId: number | null;
  delivery: { name: string; phone: string; address: string } | null;
  cart: CartLine[];
  total: number;
  cashReceived: number;
  snapshot: OfflineBootstrapSnapshot;
}): OfflineCashReceiptDocument {
  const area = input.snapshot.branch.diningAreas.find((entry) => entry.id === input.areaId) ?? null;
  const table = area?.tables.find((entry) => entry.id === input.tableId) ?? null;
  return {
    version: 1,
    id: `offline-cash-receipt:${input.operationId}`,
    kind: "offline_cash_receipt",
    operationId: input.operationId,
    orderReference: input.orderReference,
    offlineReceiptNumber: input.offlineReceiptNumber,
    checkoutIdempotencyKey: input.checkoutIdempotencyKey,
    priceSnapshot: { reference: input.snapshot.priceSnapshot.reference, revision: input.snapshot.priceSnapshot.revision, expiresAt: new Date(input.snapshot.priceSnapshot.expiresAt).toISOString() },
    checkoutAt: input.checkoutAt,
    restaurant: { name: { en: "SOLO Restaurant", ar: "مطعم SOLO" }, branch: { en: input.snapshot.branch.name_en, ar: input.snapshot.branch.name_ar }, address: { en: input.snapshot.branch.address_en ?? "", ar: input.snapshot.branch.address_ar ?? "" }, phone: input.snapshot.branch.phone },
    operator: { cashier: input.snapshot.cashier.name, register: { en: input.snapshot.register.name_en, ar: input.snapshot.register.name_ar, code: input.snapshot.register.code }, shiftNumber: String(input.snapshot.shift.id) },
    order: { type: input.orderType, area: area ? { en: area.name_en, ar: area.name_ar } : null, table: table ? { en: table.name_en, ar: table.name_ar } : null, customerName: input.delivery?.name ?? null, customerPhone: input.delivery?.phone ?? null, deliveryAddress: input.delivery?.address ?? null },
    items: input.cart.map((line) => {
      const unitPrice = line.basePrice + line.modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0);
      return { name: { en: line.nameEn, ar: line.nameAr }, variant: line.variantId ? { en: line.variantNameEn ?? "", ar: line.variantNameAr ?? "" } : null, modifiers: line.modifiers.map((modifier) => ({ name: { en: modifier.nameEn, ar: modifier.nameAr }, priceDelta: modifier.priceDelta })), quantity: line.quantity, unitPrice, lineTotal: unitPrice * line.quantity, notes: line.notes || null };
    }),
    financial: { subtotal: input.total, total: input.total, cashReceived: input.cashReceived, change: input.cashReceived - input.total },
    printing: { paperWidth: input.snapshot.printing.paperWidth, language: input.snapshot.printing.language, copyCount: input.snapshot.printing.receiptCopies },
    printIdempotencyKey: input.printIdempotencyKey,
    createdAt: input.checkoutAt,
  };
}

export function offlineReceiptContainsSensitiveData(receipt: OfflineCashReceiptDocument) {
  return /password|token|cookie|secret|audit|databaseId|internalId/i.test(JSON.stringify(receipt));
}

export function kotContainsFinancialData(document: OfflineKotDocument) {
  return Object.keys(document).some((key) => /price|total|payment|cash|change|receipt/i.test(key))
    || document.items.some((item) => Object.keys(item).some((key) => /price|total|payment|cash|change|receipt/i.test(key)));
}
