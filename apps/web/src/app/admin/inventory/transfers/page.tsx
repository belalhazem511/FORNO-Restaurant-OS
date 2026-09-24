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
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";
import { useTRPC } from "@/lib/trpc/client";
import { parseDecimalToScaled } from "@/lib/inventory/exact";

export default function StockTransfersPage() {
  const trpc = useTRPC(); const locale = useLocale(); const ar = locale === "ar"; const qc = useQueryClient();
  const inventory = useQuery(trpc.inventory.context.queryOptions()); const branchId = inventory.data?.branch.id ?? 0;
  const context = useQuery(trpc.stockTransfers.context.queryOptions());
  const listOptions = trpc.stockTransfers.list.queryOptions({ branchId }); const list = useQuery({ ...listOptions, enabled: branchId > 0 });
  const locations = useQuery({ ...trpc.stockTransfers.locations.queryOptions({ branchId }), enabled: branchId > 0 });
  const ingredients = useQuery({ ...trpc.stockTransfers.ingredients.queryOptions({ branchId }), enabled: branchId > 0 && Boolean(context.data?.canCreate) });
  const [number, setNumber] = useState(`ST-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
  const [sourceId, setSourceId] = useState(""); const [destinationId, setDestinationId] = useState(""); const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Record<number, { unitId: number; packageId: number | null; quantity: string }>>({});
  const refresh = async () => qc.invalidateQueries({ queryKey: listOptions.queryKey });
  const create = useMutation(trpc.stockTransfers.createDraft.mutationOptions({ onSuccess: async (row) => { await refresh(); window.location.href = `/admin/inventory/transfers/${row.id}`; }, onError: (e) => toast.error(e.message) }));
  const submit = async () => {
    const lineInputs = Object.entries(selected).filter(([, v]) => v.quantity.trim()).map(([id, v]) => ({ ingredientId: Number(id), unitId: v.unitId, packageConversionId: v.packageId, quantityScaled: parseDecimalToScaled(v.quantity) }));
    if (!lineInputs.length || !sourceId || !destinationId) { toast.error(ar ? "اختر الموقعين وأدخل كمية واحدة على الأقل" : "Choose both locations and enter at least one quantity"); return; }
    create.mutate({ branchId, transferNumber: number, sourceLocationId: Number(sourceId), destinationLocationId: Number(destinationId), notes: notes || null, idempotencyKey: `transfer-create:${crypto.randomUUID()}`, lines: lineInputs });
  };
  return <div className="p-4 sm:p-6"><InventoryNav /><InventoryPageHeader titleEn="Internal stock transfers" titleAr="تحويلات المخزون الداخلية" descriptionEn="Move exact quantities between active locations in this branch. Stock changes only when dispatched and received." descriptionAr="انقل كميات دقيقة بين مواقع الفرع. يتغير المخزون عند الإرسال والاستلام فقط." />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)]">
      <section className="space-y-3"><h3 className="text-lg font-semibold">{ar ? "التحويلات" : "Transfers"}</h3>{(list.data ?? []).map((row) => <Card key={row.id}><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><Link className="font-semibold underline" href={`/admin/inventory/transfers/${row.id}`}>{row.transfer_number}</Link><p className="text-sm text-muted-foreground">{ar ? row.source_name_ar_snapshot : row.source_name_en_snapshot} → {ar ? row.destination_name_ar_snapshot : row.destination_name_en_snapshot}</p></div><span className="rounded-full border px-3 py-1 text-sm">{statusLabel(row.status, ar)}</span><div className="w-full text-sm">{row.lines.map((line) => <p key={line.id}>{ar ? line.ingredient_name_ar_snapshot : line.ingredient_name_en_snapshot}: {formatExactQuantity(line.quantity_base, line.dimension)} · {ar ? "مرسل" : "sent"} {formatExactQuantity(line.dispatched_base, line.dimension)} · {ar ? "مستلم" : "received"} {formatExactQuantity(line.received_base, line.dimension)} · {ar ? "بالطريق" : "in transit"} {formatExactQuantity(line.in_transit_base, line.dimension)}</p>)}</div></CardContent></Card>)}{!list.data?.length && <p className="text-sm text-muted-foreground">{ar ? "لا توجد تحويلات بعد" : "No transfers yet"}</p>}</section>
      {context.data?.canCreate && <Card><CardHeader><CardTitle>{ar ? "إنشاء مسودة تحويل" : "Create transfer draft"}</CardTitle></CardHeader><CardContent className="space-y-3">
        <Field label={ar ? "رقم التحويل" : "Transfer reference"}><Input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label={ar ? "من الموقع" : "Source location"}><select aria-label="Source location" className="h-11 w-full rounded-md border bg-background px-3" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">{ar ? "اختر" : "Select"}</option>{locations.data?.map((l) => <option key={l.id} value={l.id}>{ar ? l.name_ar : l.name_en}</option>)}</select></Field>
        <Field label={ar ? "إلى الموقع" : "Destination location"}><select aria-label="Destination location" className="h-11 w-full rounded-md border bg-background px-3" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}><option value="">{ar ? "اختر" : "Select"}</option>{locations.data?.map((l) => <option key={l.id} value={l.id}>{ar ? l.name_ar : l.name_en}</option>)}</select></Field>
        {ingredients.data?.map((ingredient) => { const selectedLine = selected[ingredient.id] ?? { unitId: ingredient.base_unit_id, packageId: null, quantity: "" }; return <div key={ingredient.id} className="space-y-2 rounded-lg border p-3"><strong>{ar ? ingredient.name_ar : ingredient.name_en}</strong><Label htmlFor={`qty-${ingredient.id}`}>{ar ? "الكمية" : "Quantity"}</Label><div className="grid grid-cols-[minmax(0,1fr)_minmax(130px,0.8fr)] gap-2"><Input id={`qty-${ingredient.id}`} aria-label={`Quantity ${ingredient.name_en}`} inputMode="decimal" value={selectedLine.quantity} onChange={(e) => setSelected((old) => ({ ...old, [ingredient.id]: { ...selectedLine, quantity: e.target.value } }))} /><select aria-label={`Unit ${ingredient.name_en}`} className="h-11 rounded-md border bg-background px-2" value={selectedLine.packageId ? `p:${selectedLine.packageId}` : `u:${selectedLine.unitId}`} onChange={(e) => { const [kind, raw] = e.target.value.split(":"); setSelected((old) => ({ ...old, [ingredient.id]: { ...selectedLine, unitId: ingredient.base_unit_id, packageId: kind === "p" ? Number(raw) : null } })); }}><option value={`u:${ingredient.base_unit_id}`}>{ingredient.baseUnit?.code ?? "base"} · {ar ? "وحدة أساسية" : "Base unit"}</option>{ingredient.packageConversions.filter((p) => p.is_active).map((p) => <option key={p.id} value={`p:${p.id}`}>{p.code} · {ar ? p.name_ar : p.name_en} ({p.base_numerator}/{p.base_denominator})</option>)}</select></div></div>; })}
        <Field label={ar ? "ملاحظات" : "Notes"}><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field><Button className="min-h-11 w-full" disabled={create.isPending} onClick={submit}>{ar ? "إنشاء المسودة" : "Create draft"}</Button>
      </CardContent></Card>}
    </div>
  </div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
function statusLabel(status: string, ar: boolean) { const labels: Record<string, [string, string]> = { draft: ["Draft", "مسودة"], submitted: ["Submitted", "مرسل للموافقة"], approved: ["Approved", "معتمد"], dispatched: ["Dispatched", "تم الإرسال"], partially_received: ["Partially received", "مستلم جزئياً"], received: ["Received", "مستلم"], cancelled: ["Cancelled", "ملغي"], needs_review: ["Needs Review", "يتطلب مراجعة"], reversed: ["Reversed", "معكوس"] }; return labels[status]?.[ar ? 1 : 0] ?? status; }
