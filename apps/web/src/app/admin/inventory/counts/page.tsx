"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { InventoryNav, InventoryPageHeader } from "@/components/inventory/inventory-nav";
import { useTRPC } from "@/lib/trpc/client";

export default function StockCountsPage() {
  const trpc = useTRPC(); const ar = useLocale() === "ar"; const qc = useQueryClient();
  const inventory = useQuery(trpc.inventory.context.queryOptions()); const branchId = inventory.data?.branch.id ?? 0;
  const context = useQuery(trpc.stockCounts.context.queryOptions());
  const listOptions = trpc.stockCounts.list.queryOptions({ branchId }); const list = useQuery({ ...listOptions, enabled: branchId > 0 });
  const locations = useQuery({ ...trpc.stockCounts.locations.queryOptions({ branchId }), enabled: branchId > 0 });
  const [locationId, setLocationId] = useState(""); const [notes, setNotes] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: listOptions.queryKey });
  const create = useMutation(trpc.stockCounts.createDraft.mutationOptions({ onSuccess: async (row) => { await refresh(); window.location.href = `/admin/inventory/counts/${row.id}`; }, onError: (error) => toast.error(error.message) }));
  const number = `SC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
  return <main className="p-4 sm:p-6"><InventoryNav /><InventoryPageHeader titleEn="Full physical stock counts" titleAr="جرد المخزون الفعلي الشامل" descriptionEn="Blind counts snapshot every active tracked ingredient. Balances change only after approval and atomic posting." descriptionAr="يُخفي الجرد الأرصدة المتوقعة أثناء العد، ويشمل كل المكونات النشطة. لا تتغير الأرصدة إلا بعد الاعتماد والترحيل الذري." />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]"><section className="space-y-3"><h3 className="text-lg font-semibold">{ar ? "عمليات الجرد" : "Count sessions"}</h3>{(list.data ?? []).map((row) => <Card key={row.id}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><Link className="font-semibold underline focus-visible:outline-none focus-visible:ring-2" href={`/admin/inventory/counts/${row.id}`}>{row.count_number}</Link><p className="text-sm text-muted-foreground">{row.lines.length} {ar ? "مكون" : "ingredients"} · {row.lines.filter((line) => line.counted_quantity_base !== null).length} {ar ? "تم عدها" : "counted"}</p></div><span className="rounded-full border px-3 py-1 text-sm">{row.status.replaceAll("_", " ")}</span></CardContent></Card>)}{!list.data?.length && <p className="text-sm text-muted-foreground">{ar ? "لا توجد عمليات جرد" : "No stock counts yet."}</p>}</section>
      {context.data?.canCreate && <Card><CardHeader><CardTitle>{ar ? "إنشاء مسودة جرد" : "Create count draft"}</CardTitle></CardHeader><CardContent className="space-y-3"><div className="space-y-1"><Label htmlFor="count-location">{ar ? "موقع المخزون" : "Inventory location"}</Label><select id="count-location" className="h-11 w-full rounded-md border bg-background px-3" value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">{ar ? "اختر الموقع" : "Select a location"}</option>{locations.data?.map((location) => <option key={location.id} value={location.id}>{ar ? location.name_ar : location.name_en}</option>)}</select></div><div className="space-y-1"><Label htmlFor="count-notes">{ar ? "ملاحظات" : "Notes"}</Label><Input id="count-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div><Button className="min-h-11 w-full" disabled={!locationId || create.isPending} onClick={() => create.mutate({ branchId, countNumber: number, locationId: Number(locationId), notes: notes || null, idempotencyKey: `stock-count-create:${crypto.randomUUID()}` })}>{ar ? "إنشاء المسودة" : "Create draft"}</Button><p className="text-xs text-muted-foreground">{ar ? "يمكن وجود جرد نشط واحد فقط لكل موقع." : "Only one active count is allowed per location."}</p></CardContent></Card>}
    </div></main>;
}
