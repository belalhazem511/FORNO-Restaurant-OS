"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";
import { useTRPC } from "@/lib/trpc/client";
import { multiplyDivide, multiplyDivideFactors, parseDecimalToScaled } from "@/lib/inventory/exact";
import { formatCurrency } from "@/lib/utils";

type EditLine = { purchaseOrderLineId: number; accepted: string; rejected: string; damaged: string; price: string };
const decimal = (scaled: number) => `${Math.floor(scaled / 1000)}${scaled % 1000 ? `.${String(scaled % 1000).padStart(3, "0").replace(/0+$/, "")}` : ""}`;

export default function ReceiptDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const locale = useLocale();
  const ar = locale === "ar";
  const [id, setId] = useState(0);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [invoice, setInvoice] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [overreceive, setOverreceive] = useState(false);
  const [approveVariance, setApproveVariance] = useState(false);
  useEffect(() => { void params.then(({ id: receiptId }) => setId(Number(receiptId))); }, [params]);
  const context = useQuery(trpc.receiving.context.queryOptions());
  const branchId = context.data?.branchId ?? 0;
  const receipt = useQuery({ ...trpc.receiving.receipt.queryOptions({ branchId, receiptId: id }), enabled: branchId > 0 && id > 0 });
  useEffect(() => {
    const row = receipt.data;
    if (!row || row.status !== "draft") return;
    setDeliveryNote(row.supplier_delivery_note ?? ""); setInvoice(row.supplier_invoice_reference ?? ""); setNotes(row.notes ?? "");
    setEditLines(row.lines.map((line) => ({
      purchaseOrderLineId: line.purchase_order_line_id,
      accepted: decimal(multiplyDivideFactors(line.accepted_quantity_base, [line.conversion_denominator_snapshot], [line.conversion_numerator_snapshot])),
      rejected: decimal(multiplyDivideFactors(line.rejected_quantity_base, [line.conversion_denominator_snapshot], [line.conversion_numerator_snapshot])),
      damaged: decimal(multiplyDivideFactors(line.damaged_quantity_base, [line.conversion_denominator_snapshot], [line.conversion_numerator_snapshot])),
      price: `${Math.floor(line.actual_unit_price_minor / 100)}.${String(line.actual_unit_price_minor % 100).padStart(2, "0")}`,
    })));
  }, [receipt.data]);
  const invalidate = async () => Promise.all([
    qc.invalidateQueries({ queryKey: trpc.receiving.receipt.queryOptions({ branchId, receiptId: id }).queryKey }),
    qc.invalidateQueries({ queryKey: trpc.receiving.receipts.queryOptions({ branchId }).queryKey }),
    qc.invalidateQueries({ queryKey: trpc.receiving.approvedOrders.queryOptions({ branchId }).queryKey }),
    qc.invalidateQueries({ queryKey: trpc.inventory.overview.queryOptions({ branchId }).queryKey }),
    qc.invalidateQueries({ queryKey: trpc.inventory.movements.queryOptions({ branchId }).queryKey }),
  ]);
  const edit = useMutation(trpc.receiving.editDraft.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم حفظ المسودة" : "Draft saved"); await invalidate(); }, onError: (error) => toast.error(error.message) }));
  const post = useMutation(trpc.receiving.post.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم ترحيل الاستلام وإضافة المقبول للمخزون" : "Receipt posted; accepted goods added to inventory"); await invalidate(); }, onError: (error) => toast.error(error.message) }));
  const reverse = useMutation(trpc.receiving.reverse.mutationOptions({ onSuccess: async (result) => { toast.success(result.status === "reversed" ? (ar ? "تم عكس الاستلام بأمان" : "Receipt safely reversed") : (ar ? "تتطلب الحالة مراجعة يدوية" : "Receipt requires manual review")); await invalidate(); }, onError: (error) => toast.error(error.message) }));
  const saveDraft = () => {
    try {
      edit.mutate({ branchId, receiptId: id, supplierDeliveryNote: deliveryNote || null, supplierInvoiceReference: invoice || null, notes: notes || null, lines: editLines.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, acceptedQuantityScaled: line.accepted ? parseDecimalToScaled(line.accepted) : 0, rejectedQuantityScaled: line.rejected ? parseDecimalToScaled(line.rejected) : 0, damagedQuantityScaled: line.damaged ? parseDecimalToScaled(line.damaged) : 0, actualUnitPriceMinor: line.price ? parseDecimalToScaled(line.price, 100) : undefined })) });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid receipt quantities"); }
  };
  const row = receipt.data;
  return <div><InventoryNav /><Link href="/admin/inventory/receiving" className="mb-3 inline-flex min-h-11 items-center underline">← {ar ? "سجل الاستلامات" : "Receipt history"}</Link>
    <InventoryPageHeader titleEn={row?.receipt_number ?? "Purchase receipt"} titleAr={row?.receipt_number ?? "إشعار استلام"} descriptionEn={row ? `${row.po_number_snapshot} · ${row.supplier_name_en_snapshot} · ${row.status.replaceAll("_", " ")}` : "Loading receipt"} descriptionAr={row ? `${row.po_number_snapshot} · ${row.supplier_name_ar_snapshot} · ${row.status}` : "جارٍ تحميل الإشعار"} />
    {row && <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card><CardHeader><CardTitle>{ar ? "لقطة الاستلام" : "Receipt snapshot"}</CardTitle></CardHeader><CardContent className="space-y-3">
        <div className="grid gap-2 text-sm sm:grid-cols-2"><p><strong>{ar ? "المورد" : "Supplier"}:</strong> {ar ? row.supplier_name_ar_snapshot : row.supplier_name_en_snapshot}</p><p><strong>{ar ? "أمر الشراء" : "Purchase order"}:</strong> {row.po_number_snapshot}</p><p><strong>{ar ? "الموقع" : "Location"}:</strong> {ar ? row.location.name_ar : row.location.name_en}</p><p><strong>{ar ? "الحالة" : "State"}:</strong> {row.status}</p><p><strong>{ar ? "إذن التسليم" : "Delivery note"}:</strong> {row.supplier_delivery_note || "—"}</p><p><strong>{ar ? "الفاتورة" : "Invoice ref."}:</strong> {row.supplier_invoice_reference || "—"}</p></div>
        {row.lines.map((line) => <div key={line.id} className="rounded-lg border p-3"><div className="flex flex-wrap justify-between gap-2"><strong>{ar ? line.ingredient_name_ar_snapshot : line.ingredient_name_en_snapshot} · {line.unit_code_snapshot}</strong><span>{formatCurrency(line.line_total_amount, locale)}</span></div>
          {(() => {
            const orderLine = line.purchaseOrderLine;
            const previous = row.purchaseOrder.receipts.filter((entry) => entry.id !== row.id && ["posted", "needs_review"].includes(entry.status)).flatMap((entry) => entry.lines).filter((entry) => entry.purchase_order_line_id === line.purchase_order_line_id).reduce((sum, entry) => sum + entry.accepted_quantity_base, 0);
            const remaining = Math.max(0, orderLine.quantity_base - previous - line.accepted_quantity_base);
            return <p className="mt-1 text-xs text-muted-foreground">{ar ? "بالطلب / سبق استلامه / هذا الإشعار / المتبقي" : "Ordered / previously received / this receipt / remaining"}: {formatExactQuantity(orderLine.quantity_base, line.ingredient.dimension)} / {formatExactQuantity(previous, line.ingredient.dimension)} / {formatExactQuantity(line.accepted_quantity_base, line.ingredient.dimension)} / {formatExactQuantity(remaining, line.ingredient.dimension)}</p>;
          })()}
          <p className="mt-1 text-xs text-muted-foreground">{ar ? "مقبول" : "Accepted"}: {formatExactQuantity(line.accepted_quantity_base, line.ingredient.dimension)} · {ar ? "مرفوض" : "Rejected"}: {formatExactQuantity(line.rejected_quantity_base, line.ingredient.dimension)} · {ar ? "تالف" : "Damaged"}: {formatExactQuantity(line.damaged_quantity_base, line.ingredient.dimension)}</p>
          <p className="text-xs text-muted-foreground">{ar ? "سعر الأمر / السعر الفعلي" : "PO / actual unit price"}: {formatCurrency(line.po_unit_price_minor_snapshot, locale)} / {formatCurrency(line.actual_unit_price_minor, locale)} · {ar ? "عامل التحويل" : "Conversion"}: {line.conversion_numerator_snapshot}/{line.conversion_denominator_snapshot}</p>
          {row.status === "draft" && <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">{(["accepted", "rejected", "damaged", "price"] as const).map((key) => <Input key={key} aria-label={`${key} ${line.ingredient_name_en_snapshot} ${line.unit_code_snapshot}`} inputMode="decimal" placeholder={key === "price" ? "Actual price EGP" : `${key} (${line.unit_code_snapshot})`} value={editLines.find((entry) => entry.purchaseOrderLineId === line.purchase_order_line_id)?.[key] ?? ""} onChange={(event) => setEditLines((current) => current.map((entry) => entry.purchaseOrderLineId === line.purchase_order_line_id ? { ...entry, [key]: event.target.value } : entry))} />)}</div>}
        </div>)}
        {row.needs_review_reason && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{row.needs_review_reason}</p>}
        {row.status === "draft" && <div className="space-y-2 border-t pt-3"><Field label={ar ? "إذن التسليم" : "Supplier delivery note"}><Input value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} /></Field><Field label={ar ? "مرجع الفاتورة" : "Invoice reference"}><Input value={invoice} onChange={(event) => setInvoice(event.target.value)} /></Field><Field label={ar ? "ملاحظات" : "Notes"}><Input value={notes} onChange={(event) => setNotes(event.target.value)} /></Field></div>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{ar ? "الإجراءات" : "Actions"}</CardTitle></CardHeader><CardContent className="space-y-3">
        {row.status === "draft" && context.data?.canCreate && <>
          <Button className="min-h-11 w-full" variant="outline" disabled={edit.isPending} onClick={saveDraft}>{ar ? "حفظ تعديلات المسودة" : "Save draft edits"}</Button>
          {context.data.canPost && <><Field label={ar ? "سبب الموافقة أو التجاوز" : "Approval / override reason"}><Input value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
            {context.data.canApproveVariance && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={approveVariance} onChange={(event) => setApproveVariance(event.target.checked)} />{ar ? "اعتماد فرق السعر الكبير" : "Approve significant price variance"}</label>}
            {context.data.canOverreceive && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={overreceive} onChange={(event) => setOverreceive(event.target.checked)} />{ar ? "السماح بالاستلام الزائد" : "Allow over-receiving"}</label>}
            <Button className="min-h-11 w-full" disabled={post.isPending} onClick={() => post.mutate({ branchId, receiptId: id, approveVariance: approveVariance && !!reason, varianceReason: approveVariance && reason ? reason : undefined, overreceive, overreceiveReason: overreceive && reason ? reason : undefined })}>{ar ? "ترحيل وإضافة المقبول للمخزون" : "Post accepted goods to stock"}</Button></>}
        </>}
        {row.status === "posted" && context.data?.canReverse && <><Field label={ar ? "سبب العكس" : "Reversal reason"}><Input value={reason} onChange={(event) => setReason(event.target.value)} /></Field><Button variant="destructive" className="min-h-11 w-full" disabled={reverse.isPending || reason.trim().length < 3} onClick={() => reverse.mutate({ branchId, receiptId: id, reason, idempotencyKey: `receipt-reversal:${id}:${crypto.randomUUID()}` })}>{ar ? "طلب عكس آمن" : "Reverse receipt"}</Button><p className="text-xs text-muted-foreground">{ar ? "إذا حدثت حركة مخزون لاحقة، سيُحظر العكس التلقائي وتُحال الحالة للمراجعة." : "Later inventory activity blocks automatic reversal and moves the case to Needs Review."}</p></>}
        {row.status === "posted" && <p className="rounded bg-muted p-3 text-sm">{ar ? "تم ترحيل الكميات المقبولة فقط. المرفوض والتالف لا يغيران المخزون." : "Only accepted quantities were posted. Rejected and damaged quantities did not change stock."}</p>}
        {row.status === "reversed" && <p className="rounded bg-muted p-3 text-sm">{ar ? "تم الاحتفاظ بالإشعار الأصلي وسجل العكس." : "The original receipt and append-only reversal record are retained."}</p>}
      </CardContent></Card>
    </div>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
