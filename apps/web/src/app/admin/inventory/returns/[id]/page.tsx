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
import { formatCurrency } from "@/lib/utils";

export default function SupplierReturnDetailPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const params = useParams<{ id: string }>();
  const locale = useLocale();
  const ar = locale === "ar";
  const inventory = useQuery(trpc.inventory.context.queryOptions());
  const branchId = inventory.data?.branch.id ?? 0;
  const returnId = Number(params.id);
  const context = useQuery(trpc.supplierReturns.context.queryOptions());
  const detailOptions = trpc.supplierReturns.detail.queryOptions({ branchId, returnId });
  const detail = useQuery({ ...detailOptions, enabled: branchId > 0 && Number.isInteger(returnId) });
  const [reason, setReason] = useState("");
  const [draftQuantities, setDraftQuantities] = useState<Record<number, string>>({});
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: detailOptions.queryKey }), qc.invalidateQueries({ queryKey: trpc.supplierReturns.list.queryOptions({ branchId }).queryKey }), qc.invalidateQueries({ queryKey: trpc.supplierReturns.sourceReceipts.queryOptions({ branchId }).queryKey }), qc.invalidateQueries({ queryKey: trpc.inventory.overview.queryOptions({ branchId }).queryKey }), qc.invalidateQueries({ queryKey: trpc.inventory.movements.queryOptions({ branchId }).queryKey })]); };
  const submit = useMutation(trpc.supplierReturns.submit.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const editDraft = useMutation(trpc.supplierReturns.editDraft.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم حفظ المسودة" : "Draft saved"); await refresh(); }, onError: (error) => toast.error(error.message) }));
  const approve = useMutation(trpc.supplierReturns.approve.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const dispatch = useMutation(trpc.supplierReturns.dispatch.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم تسجيل إرسال المرتجع وتأثير المخزون" : "Return dispatched; inventory updated"); await refresh(); }, onError: (error) => toast.error(error.message) }));
  const cancel = useMutation(trpc.supplierReturns.cancel.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const reverse = useMutation(trpc.supplierReturns.reverseDispatch.mutationOptions({ onSuccess: async (result) => { toast.success(result.status === "reversed" ? (ar ? "تم عكس الإرسال" : "Dispatch reversed") : (ar ? "تتطلب الحالة مراجعة يدوية" : "Return requires manual review")); await refresh(); }, onError: (error) => toast.error(error.message) }));
  const resolve = useMutation(trpc.supplierReturns.resolveNeedsReview.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const busy = editDraft.isPending || submit.isPending || approve.isPending || dispatch.isPending || cancel.isPending || reverse.isPending || resolve.isPending;
  const key = () => `supplier-return:${returnId}:${crypto.randomUUID()}`;
  if (!detail.data) return <div className="p-6"><InventoryNav /><p>{detail.isLoading ? (ar ? "جارٍ التحميل…" : "Loading…") : (ar ? "المرتجع غير موجود أو غير متاح" : "Return not found or unavailable")}</p><Link className="underline" href="/admin/inventory/returns">{ar ? "العودة" : "Back to returns"}</Link></div>;
  const row = detail.data;
  const reasonPrompt = reason.trim();
  return <div>
    <InventoryNav />
    <InventoryPageHeader titleEn={`${row.return_number} · ${row.status.replaceAll("_", " ")}`} titleAr={`${row.return_number} · ${row.status}`} descriptionEn="Source receipt snapshots remain preserved. Stock changes only on dispatch and explicit reversal." descriptionAr="تظل لقطات إيصال المصدر محفوظة. يتغير المخزون عند الإرسال والعكس الصريح فقط." />
    <div className="mb-4 flex flex-wrap gap-2 text-sm"><Link className="underline" href={`/admin/inventory/receiving/${row.receipt_id}`}>{ar ? "إيصال المصدر" : "Source receipt"}: {row.receipt_number_snapshot}</Link><span>· {ar ? "المورد" : "Supplier"}: {ar ? row.supplier_name_ar_snapshot : row.supplier_name_en_snapshot}</span><span>· {ar ? "السبب" : "Reason"}: {row.reason_code.replaceAll("_", " ")}{row.reason ? ` — ${row.reason}` : ""}</span><span>· {ar ? "الموقع" : "Location"}: {ar ? row.location?.name_ar : row.location?.name_en}</span></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
      <Card><CardHeader><CardTitle>{ar ? "تفاصيل وكميات المرتجع" : "Return lines and quantities"}</CardTitle></CardHeader><CardContent className="space-y-3">{row.lines.map((line) => <div key={line.id} className="rounded-lg border p-3"><div className="flex flex-wrap justify-between gap-2"><strong>{ar ? line.ingredient_name_ar_snapshot : line.ingredient_name_en_snapshot} · {line.unit_code}</strong><span>{formatExactQuantity(line.quantity_base, line.ingredient_dimension)}</span></div><p className="text-xs text-muted-foreground">{ar ? "المقبول عند الاستلام / المتاح حالياً في الموقع" : "Accepted at receipt / currently on hand at source location"}: {formatExactQuantity(line.accepted_quantity_base_snapshot, line.ingredient_dimension)} / {formatExactQuantity(line.current_on_hand_base, line.ingredient_dimension)}</p>{row.status === "draft" && <><Label htmlFor={`draft-qty-${line.id}`}>{ar ? "كمية المرتجع" : "Return quantity"}</Label><Input id={`draft-qty-${line.id}`} inputMode="decimal" aria-label={`Return quantity ${line.ingredient_name_en_snapshot}`} value={draftQuantities[line.id] ?? scaledToDecimal(line.quantity_input_scaled)} onChange={(event) => setDraftQuantities((current) => ({ ...current, [line.id]: event.target.value }))} /></>}{context.data?.canViewCosts && <p className="text-sm">{ar ? "تكلفة الاستلام الأصلية / تقييم الإرسال" : "Original receipt cost / dispatch valuation"}: {line.original_unit_cost_micros_snapshot ?? "—"} / {line.dispatch_unit_cost_micros_snapshot ?? "—"} µEGP · {formatCurrency(line.expected_credit_amount ?? 0, locale)} / {formatCurrency(line.dispatch_valuation_amount ?? 0, locale)}</p>}</div>)}{row.status === "draft" && context.data?.canCreate && <Button className="min-h-11" disabled={busy} onClick={() => { try { editDraft.mutate({ branchId, returnId, lines: row.lines.map((line) => ({ receiptLineId: line.receipt_line_id, quantityScaled: parseDecimalToScaled(draftQuantities[line.id] ?? scaledToDecimal(line.quantity_input_scaled)), notes: line.notes })) }); } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid quantity"); } }}>{ar ? "حفظ تغييرات المسودة" : "Save draft changes"}</Button>}{row.notes && <p className="text-sm">{ar ? "ملاحظات" : "Notes"}: {row.notes}</p>}
        {row.status === "needs_review" && <div role="alert" className="rounded-md border border-destructive p-3">{row.needs_review_reason}{row.reversals.some((entry) => entry.status === "needs_review") && <p className="mt-1">{ar ? "يتطلب عكس المخزون مراجعة وتسوية يدوية؛ لن يتم الإلغاء تلقائياً." : "This dispatched return needs manual inventory reconciliation; it cannot be cancelled automatically."}</p>}</div>}
      </CardContent></Card>
      <div className="space-y-4"><Card><CardHeader><CardTitle>{ar ? "سجل الحالة وتأثير التكلفة" : "Status, valuation and actions"}</CardTitle></CardHeader><CardContent className="space-y-3">{context.data?.canViewCosts && <div className="rounded-md bg-muted p-3 text-sm"><p>{ar ? "الائتمان المتوقع (مرجع فقط)" : "Expected supplier credit (reference only)"}: {formatCurrency(row.expected_credit_amount ?? 0, locale)}</p><p>{ar ? "تقييم المخزون عند الإرسال" : "Inventory valuation at dispatch"}: {formatCurrency(row.valuation_amount ?? 0, locale)}</p><p>{ar ? "فرق التكلفة" : "Return-cost variance"}: {formatCurrency(row.cost_variance_amount ?? 0, locale)}</p></div>}
        {(row.status !== "draft" || context.data?.canCancel) && <div><Label htmlFor="return-action-reason">{ar ? "سبب الإجراء" : "Action reason (required for sensitive actions)"}</Label><Input id="return-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={ar ? "أدخل السبب" : "Enter reason"} /></div>}
        <div className="flex flex-wrap gap-2">{row.status === "draft" && context.data?.canSubmit && <Button disabled={busy} onClick={() => submit.mutate({ branchId, returnId, idempotencyKey: key() })}>{ar ? "إرسال للموافقة" : "Submit for approval"}</Button>}{row.status === "submitted" && context.data?.canApprove && <Button disabled={busy || reason.trim().length < 3} onClick={() => approve.mutate({ branchId, returnId, reason: reasonPrompt, idempotencyKey: key() })}>{ar ? "اعتماد" : "Approve"}</Button>}{row.status === "approved" && context.data?.canDispatch && <Button disabled={busy} onClick={() => dispatch.mutate({ branchId, returnId, reason: reason.trim() || undefined, idempotencyKey: key() })}>{ar ? "تسجيل الإرسال الفعلي" : "Record physical dispatch"}</Button>}{["draft", "submitted", "approved"].includes(row.status) && context.data?.canCancel && <Button variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => cancel.mutate({ branchId, returnId, reason: reasonPrompt, idempotencyKey: key() })}>{ar ? "إلغاء" : "Cancel"}</Button>}{row.status === "dispatched" && context.data?.canReverse && <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => reverse.mutate({ branchId, returnId, reason: reasonPrompt, idempotencyKey: key() })}>{ar ? "عكس الإرسال" : "Reverse dispatch"}</Button>}{row.status === "needs_review" && !row.reversals.some((entry) => entry.status === "needs_review") && context.data?.canResolve && <Button variant="outline" disabled={busy || reason.trim().length < 3} onClick={() => resolve.mutate({ branchId, returnId, reason: reasonPrompt, idempotencyKey: key() })}>{ar ? "حل بالمراجعة / إلغاء" : "Resolve by cancellation"}</Button>}</div>
        {row.status === "dispatched" && <p className="text-sm text-muted-foreground">{ar ? "تم خصم الكمية مرة واحدة من المخزون. لا ينشأ قيد محاسبي أو ائتماني." : "Quantity was deducted once from inventory. No accounting or supplier-credit transaction was created."}</p>}
        <ol className="space-y-2 border-s ps-4 text-sm">{row.statusHistory.map((event) => <li key={event.id}>{event.from_status ?? "Created"} → {event.to_status} · {new Date(event.created_at).toLocaleString(locale)}{event.reason ? ` · ${event.reason}` : ""}</li>)}</ol>
      </CardContent></Card></div>
    </div>
  </div>;
}

function scaledToDecimal(value: number) { const whole = Math.floor(value / 1_000); const fraction = String(value % 1_000).padStart(3, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : String(whole); }
