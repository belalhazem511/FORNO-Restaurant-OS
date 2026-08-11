import type { CartLine } from "@/lib/pos/cart";
import type { OfflineBootstrapSnapshot, OfflineKotDocument, OfflineOrderSummaryDocument } from "./types";

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

export function kotContainsFinancialData(document: OfflineKotDocument) {
  return Object.keys(document).some((key) => /price|total|payment|cash|change|receipt/i.test(key))
    || document.items.some((item) => Object.keys(item).some((key) => /price|total|payment|cash|change|receipt/i.test(key)));
}
