"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
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

export default function StockTransferDetailPage() {
  const trpc = useTRPC(); const params = useParams<{ id: string }>(); const locale = useLocale(); const ar = locale === "ar"; const qc = useQueryClient();
  const inventory = useQuery(trpc.inventory.context.queryOptions()); const branchId = inventory.data?.branch.id ?? 0; const transferId = Number(params.id);
  const context = useQuery(trpc.stockTransfers.context.queryOptions()); const detailOptions = trpc.stockTransfers.detail.queryOptions({ branchId, transferId }); const detail = useQuery({ ...detailOptions, enabled: branchId > 0 && Number.isInteger(transferId) });
  const [editQty, setEditQty] = useState<Record<number, string>>({}); const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});
  const refresh = async () => Promise.all([qc.invalidateQueries({ queryKey: detailOptions.queryKey }), qc.invalidateQueries({ queryKey: trpc.stockTransfers.list.queryOptions({ branchId }).queryKey }), qc.invalidateQueries({ queryKey: trpc.inventory.overview.queryOptions({ branchId }).queryKey }), qc.invalidateQueries({ queryKey: trpc.inventory.movements.queryOptions({ branchId }).queryKey })]);
  const submit = useMutation(trpc.stockTransfers.submit.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const edit = useMutation(trpc.stockTransfers.editDraft.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const approve = useMutation(trpc.stockTransfers.approve.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const dispatch = useMutation(trpc.stockTransfers.dispatch.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const receive = useMutation(trpc.stockTransfers.receive.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const cancel = useMutation(trpc.stockTransfers.cancel.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const reverse = useMutation(trpc.stockTransfers.reverse.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const row = detail.data; const transferLines = row?.lines ?? [];
  const anyBusy = [submit, edit, approve, dispatch, receive, cancel, reverse].some((m) => m.isPending);
  const key = (action: string) => `stock-transfer:${transferId}:${action}:${crypto.randomUUID()}`;
  const asScaled = (raw: string) => parseDecimalToScaled(raw);
  const quantityString = (scaled: number) => (scaled / 1_000).toLocaleString("en-US", { maximumFractionDigits: 3, useGrouping: false });
  const saveDraft = () => { try { const lines = transferLines.map((line) => ({ ingredientId: line.ingredient_id, unitId: line.unit_id, packageConversionId: line.package_conversion_id, quantityScaled: asScaled(editQty[line.id] ?? quantityString(line.quantity_input_scaled)), notes: line.notes })); edit.mutate({ branchId, transferId, lines }); } catch (e) { toast.error(e instanceof Error ? e.message : "Invalid quantity"); } };
  const receiveNow = () => {
    try {
      const lines = transferLines.filter((line) => (receiveQty[line.id] ?? "").trim()).map((line) => ({ transferLineId: line.id, quantityScaled: asScaled(receiveQty[line.id]!) }));
      if (!lines.length) throw new Error(ar ? "أدخل كمية مستلمة واحدة على الأقل" : "Enter at least one received quantity");
      if (!window.confirm(ar ? "تأكيد إضافة الكميات المستلمة إلى مخزون الوجهة؟" : "Confirm adding received quantities into destination stock?")) return;
      receive.mutate({ branchId, transferId, lines, reason: window.prompt(ar ? "سبب أو ملاحظة الاستلام (اختياري)" : "Receipt note (optional)") ?? undefined, idempotencyKey: key("receive") });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Invalid quantity"); }
  };
  const promptReason = (title: string) => { const value = window.prompt(title); return value?.trim() || null; };
  if (!row) return <div className="p-5"><InventoryNav /><p>{detail.isLoading ? (ar ? "جارٍ التحميل…" : "Loading…") : (ar ? "التحويل غير موجود أو غير متاح" : "Transfer not found or unavailable")}</p><Link className="underline" href="/admin/inventory/transfers">{ar ? "عودة" : "Back"}</Link></div>;
  return <div className="p-4 sm:p-6"><InventoryNav /><InventoryPageHeader titleEn={`${row.transfer_number} · ${row.status.replaceAll("_", " ")}`} titleAr={`${row.transfer_number} · ${row.status}`} descriptionEn="Dispatch removes source stock. Only recorded receipts add destination stock; unreceived quantities remain in transit." descriptionAr="يخصم الإرسال من المصدر. يضيف الاستلام المسجل فقط إلى الوجهة؛ وتبقى الكميات غير المستلمة بالطريق." />
    <div className="mb-4 flex flex-wrap gap-2 text-sm"><span>{ar ? "من" : "From"}: {ar ? row.source_name_ar_snapshot : row.source_name_en_snapshot}</span><span>→</span><span>{ar ? "إلى" : "To"}: {ar ? row.destination_name_ar_snapshot : row.destination_name_en_snapshot}</span><span>· {ar ? "الحالة" : "Status"}: {row.status}</span></div>
    {row.needs_review_reason && <p role="alert" className="mb-4 rounded border border-amber-500 p-3">{row.needs_review_reason}</p>}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]"><Card><CardHeader><CardTitle>{ar ? "الكميات واللقطات" : "Quantities and snapshots"}</CardTitle></CardHeader><CardContent className="space-y-3">{transferLines.map((line) => <div className="rounded-lg border p-3" key={line.id}><div className="flex flex-wrap justify-between gap-2"><strong>{ar ? line.ingredient_name_ar_snapshot : line.ingredient_name_en_snapshot} · {line.package_code_snapshot ?? line.unit_code_snapshot}</strong><span>{formatExactQuantity(line.quantity_base, line.dimension)}</span></div>{line.package_code_snapshot && <p className="text-xs text-muted-foreground">1 {line.package_code_snapshot} = {line.conversion_numerator_snapshot}/{line.conversion_denominator_snapshot} base units</p>}<p className="text-sm">{ar ? "مرسل" : "Dispatched"}: {formatExactQuantity(line.dispatched_base, line.dimension)} · {ar ? "مستلم" : "Received"}: {formatExactQuantity(line.received_base, line.dimension)} · {ar ? "متبقٍ بالطريق" : "Remaining in transit"}: {formatExactQuantity(line.in_transit_base, line.dimension)}</p>{row.status === "draft" && context.data?.canCreate && <><Label htmlFor={`edit-${line.id}`}>{ar ? "كمية التحويل" : "Transfer quantity"}</Label><Input id={`edit-${line.id}`} inputMode="decimal" aria-label={`Transfer quantity ${line.ingredient_name_en_snapshot}`} value={editQty[line.id] ?? quantityString(line.quantity_input_scaled)} onChange={(e) => setEditQty((old) => ({ ...old, [line.id]: e.target.value }))} /></>}{(row.status === "dispatched" || row.status === "partially_received") && line.in_transit_base > 0 && context.data?.canReceive && <><Label htmlFor={`receive-${line.id}`}>{ar ? "الكمية المستلمة الآن" : "Quantity received now"}</Label><Input id={`receive-${line.id}`} inputMode="decimal" aria-label={`Receive quantity ${line.ingredient_name_en_snapshot}`} value={receiveQty[line.id] ?? ""} onChange={(e) => setReceiveQty((old) => ({ ...old, [line.id]: e.target.value }))} /></>}</div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{ar ? "الإجراءات والسجل" : "Actions and history"}</CardTitle></CardHeader><CardContent className="space-y-2">
        {row.status === "draft" && context.data?.canCreate && <Button className="min-h-11 w-full" disabled={anyBusy} onClick={saveDraft}>{ar ? "حفظ المسودة" : "Save draft"}</Button>}
        {row.status === "draft" && context.data?.canSubmit && <Button className="min-h-11 w-full" disabled={anyBusy} onClick={() => submit.mutate({ branchId, transferId, idempotencyKey: key("submit") })}>{ar ? "إرسال للموافقة" : "Submit for approval"}</Button>}
        {row.status === "submitted" && context.data?.canApprove && <Button className="min-h-11 w-full" disabled={anyBusy} onClick={() => { const reason = promptReason(ar ? "سبب الموافقة" : "Approval reason"); if (reason) approve.mutate({ branchId, transferId, reason, idempotencyKey: key("approve") }); }}>{ar ? "اعتماد" : "Approve"}</Button>}
        {row.status === "approved" && context.data?.canDispatch && <Button className="min-h-11 w-full" disabled={anyBusy} onClick={() => { if (window.confirm(ar ? "إرسال جميع الكميات وخصمها من المصدر؟" : "Dispatch all quantities and deduct source stock?")) dispatch.mutate({ branchId, transferId, reason: promptReason(ar ? "ملاحظة الإرسال (اختياري)" : "Dispatch note (optional)") ?? undefined, idempotencyKey: key("dispatch") }); }}>{ar ? "إرسال المخزون" : "Dispatch stock"}</Button>}
        {(row.status === "dispatched" || row.status === "partially_received") && context.data?.canReceive && <Button className="min-h-11 w-full" disabled={anyBusy} onClick={receiveNow}>{ar ? "تسجيل الاستلام" : "Record receipt"}</Button>}
        {["draft", "submitted", "approved"].includes(row.status) && context.data?.canCancel && <Button variant="outline" className="min-h-11 w-full" disabled={anyBusy} onClick={() => { const reason = promptReason(ar ? "سبب الإلغاء" : "Cancellation reason"); if (reason && window.confirm(ar ? "إلغاء التحويل قبل الإرسال؟" : "Cancel this transfer before dispatch?")) cancel.mutate({ branchId, transferId, reason, idempotencyKey: key("cancel") }); }}>{ar ? "إلغاء قبل الإرسال" : "Cancel before dispatch"}</Button>}
        {["dispatched", "partially_received", "received"].includes(row.status) && context.data?.canReverse && <Button variant="destructive" className="min-h-11 w-full" disabled={anyBusy} onClick={() => { const reason = promptReason(ar ? "سبب العكس" : "Reversal reason"); if (reason && window.confirm(ar ? "إنشاء حركات تعويضية؟" : "Create compensating stock movements?")) reverse.mutate({ branchId, transferId, reason, idempotencyKey: key("reverse") }); }}>{ar ? "عكس التحويل" : "Reverse transfer"}</Button>}
        <div className="mt-3 border-t pt-3"><h4 className="font-semibold">{ar ? "سجل الحالة" : "Status history"}</h4>{row.statusHistory.map((item) => <p className="mt-1 text-xs" key={item.id}>{item.from_status ?? "—"} → {item.to_status} · {item.reason ?? ""}</p>)}{row.receipts.map((receipt) => <p className="mt-1 text-xs" key={receipt.id}>{ar ? "إيصال" : "Receipt"} #{receipt.id} · {receipt.lines.length} {ar ? "أسطر" : "lines"}</p>)}</div>
      </CardContent></Card>
    </div>
  </div>;
}
