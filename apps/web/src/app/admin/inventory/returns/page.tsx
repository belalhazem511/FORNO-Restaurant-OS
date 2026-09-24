"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

const reasons = ["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"] as const;
const reasonLabel: Record<string, string> = { damaged: "Damaged", expired: "Expired", wrong_item: "Wrong item", quality_issue: "Quality issue", over_delivery: "Over-delivery", other: "Other" };

export default function SupplierReturnsPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const locale = useLocale();
  const ar = locale === "ar";
  const search = useSearchParams();
  const supplierId = Number(search.get("supplierId")) || undefined;
  const purchaseOrderId = Number(search.get("purchaseOrderId")) || undefined;
  const receiptIdFilter = Number(search.get("receiptId")) || undefined;
  const inventory = useQuery(trpc.inventory.context.queryOptions());
  const branchId = inventory.data?.branch.id ?? 0;
  const context = useQuery(trpc.supplierReturns.context.queryOptions());
  const sources = useQuery({ ...trpc.supplierReturns.sourceReceipts.queryOptions({ branchId }), enabled: branchId > 0 });
  const listInput = { branchId, supplierId, purchaseOrderId, receiptId: receiptIdFilter };
  const returns = useQuery({ ...trpc.supplierReturns.list.queryOptions(listInput), enabled: branchId > 0 });
  const [receiptId, setReceiptId] = useState("");
  const [reasonCode, setReasonCode] = useState<(typeof reasons)[number]>("damaged");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const receipt = sources.data?.find((entry) => entry.id === Number(receiptId));
  const create = useMutation(trpc.supplierReturns.createDraft.mutationOptions({
    onSuccess: async (row) => { toast.success(ar ? "تم إنشاء مسودة المرتجع" : "Supplier return draft created"); await qc.invalidateQueries({ queryKey: trpc.supplierReturns.list.queryOptions({ branchId }).queryKey }); window.location.assign(`/admin/inventory/returns/${row.id}`); },
    onError: (error) => toast.error(error.message),
  }));
  const createReturn = () => {
    try {
      if (!receipt) throw new Error("Select a posted receipt");
      const lines = receipt.lines.filter((line) => quantities[line.id]).map((line) => ({ receiptLineId: line.id, quantityScaled: parseDecimalToScaled(quantities[line.id]!) }));
      if (!lines.length) throw new Error("Enter a return quantity");
      create.mutate({ branchId, receiptId: receipt.id, returnNumber: `RTV-${branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, reasonCode, reason: reason || null, notes: notes || null, evidenceMetadata: [], idempotencyKey: `rtv:${crypto.randomUUID()}`, lines });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid return"); }
  };
  return <div>
    <InventoryNav />
    <InventoryPageHeader titleEn="Supplier returns" titleAr="مرتجعات الموردين" descriptionEn="Create returns only from posted receipts. Inventory changes only when an approved return is physically dispatched." descriptionAr="إنشاء المرتجعات من إشعارات الاستلام المرحلة فقط. لا يتغير المخزون إلا عند إرسال مرتجع معتمد فعلياً." />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
      <Card><CardHeader><CardTitle>{ar ? "سجل المرتجعات" : "Return history"}</CardTitle></CardHeader><CardContent className="space-y-2">
        {returns.data?.map((row) => <Link key={row.id} href={`/admin/inventory/returns/${row.id}`} className="block min-h-14 rounded-lg border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex justify-between gap-2"><strong>{row.return_number}</strong><span className="rounded bg-muted px-2 py-1 text-xs">{row.status.replaceAll("_", " ")}</span></div><p className="text-sm text-muted-foreground">{row.receipt_number_snapshot} · {reasonLabel[row.reason_code]} · {new Date(row.created_at).toLocaleString(locale)}</p></Link>)}
        {returns.data?.length === 0 && <p className="text-sm text-muted-foreground">{ar ? "لا توجد مرتجعات بعد" : "No supplier returns yet"}</p>}
      </CardContent></Card>
      {context.data?.canCreate && <Card><CardHeader><CardTitle>{ar ? "إنشاء مرتجع من استلام مرحل" : "Create from a posted receipt"}</CardTitle></CardHeader><CardContent className="space-y-4">
        <Field label={ar ? "إشعار الاستلام" : "Posted receipt"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={receiptId} onChange={(event) => { setReceiptId(event.target.value); setQuantities({}); }}><option value="">{ar ? "اختر إشعاراً" : "Select a receipt"}</option>{sources.data?.map((source) => <option key={source.id} value={source.id}>{source.receipt_number} · {source.supplier.name_en} · {source.purchaseOrder.po_number}</option>)}</select></Field>
        <Field label={ar ? "السبب" : "Reason"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={reasonCode} onChange={(event) => setReasonCode(event.target.value as (typeof reasons)[number])}>{reasons.map((key) => <option key={key} value={key}>{reasonLabel[key]}</option>)}</select></Field>
        {reasonCode === "other" && <Field label={ar ? "وصف السبب (إلزامي)" : "Reason detail (required)"}><Input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>}
        {receipt?.lines.map((line) => <div key={line.id} className="rounded-lg border p-3"><div className="flex justify-between gap-2"><strong>{ar ? line.ingredient_name_ar : line.ingredient_name_en}</strong><span>{formatExactQuantity(line.returnable_base, line.dimension)} {line.unit_code}</span></div><p className="text-xs text-muted-foreground">{ar ? "المقبول / المرتجع / المحجوز / المتاح" : "Accepted / returned / reserved / returnable"}: {formatExactQuantity(line.accepted_quantity_base, line.dimension)} / {formatExactQuantity(line.previously_returned_base, line.dimension)} / {formatExactQuantity(line.reserved_base, line.dimension)} / {formatExactQuantity(line.returnable_base, line.dimension)}</p><Label className="sr-only" htmlFor={`return-qty-${line.id}`}>{`Return quantity ${line.ingredient_name_en}`}</Label><Input id={`return-qty-${line.id}`} inputMode="decimal" aria-label={`Return quantity ${line.ingredient_name_en}`} placeholder={ar ? "الكمية" : "Quantity to return"} value={quantities[line.id] ?? ""} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))} /></div>)}
        <Field label={ar ? "ملاحظات" : "Notes"}><Input value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
        <Button className="min-h-11 w-full" disabled={create.isPending || !receiptId} onClick={createReturn}>{ar ? "إنشاء مسودة" : "Create draft return"}</Button>
      </CardContent></Card>}
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
