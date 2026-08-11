"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { Card, CardContent } from "@forno/ui/components/card";
import { useTRPC } from "@/lib/trpc/client";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";

export default function MovementsPage() {
  const trpc = useTRPC(); const ar = useLocale() === "ar"; const context = useQuery(trpc.inventory.context.queryOptions()); const branchId = context.data?.branch.id ?? 0;
  const movements = useQuery({ ...trpc.inventory.movements.queryOptions({ branchId }), enabled: branchId > 0 });
  return <div><InventoryNav /><InventoryPageHeader titleEn="Stock movement ledger" titleAr="سجل حركات المخزون" descriptionEn="Append-only opening, adjustment, sale, reversal, waste, and override records." descriptionAr="سجل ترحيل غير قابل للتعديل للأرصدة والتسويات والمبيعات والمرتجعات والهالك والتجاوزات." /><Card><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead><tr className="border-b text-start"><th className="p-3">{ar ? "التاريخ" : "Date"}</th><th className="p-3">{ar ? "المكون" : "Ingredient"}</th><th className="p-3">{ar ? "الموقع" : "Location"}</th><th className="p-3">{ar ? "الحركة" : "Movement"}</th><th className="p-3">{ar ? "الكمية الدقيقة" : "Exact quantity"}</th><th className="p-3">{ar ? "السبب" : "Reason"}</th></tr></thead><tbody>{movements.data?.map((row) => <tr key={row.id} className="border-b"><td className="p-3">{new Date(row.created_at).toLocaleString()}</td><td className="p-3 font-medium">{ar ? row.ingredient.name_ar : row.ingredient.name_en}</td><td className="p-3">{ar ? row.location.name_ar : row.location.name_en}</td><td className="p-3">{row.movement_type.replaceAll("_", " ")}</td><td className="p-3 font-mono">{row.direction > 0 ? "+" : row.direction < 0 ? "−" : ""}{formatExactQuantity(row.quantity_base, row.ingredient.dimension)}</td><td className="p-3">{row.reason ?? "—"}</td></tr>)}</tbody></table></div></CardContent></Card></div>;
}
