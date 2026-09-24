"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";
import { useTRPC } from "@/lib/trpc/client";
import { convertScaledQuantity, multiplyDivide, parseDecimalToScaled } from "@/lib/inventory/exact";
import { formatCurrency } from "@/lib/utils";

type ReceiptInputLine = { poLineId: number; accepted: string; rejected: string; damaged: string; price: string };
const zeroLine = (poLineId: number): ReceiptInputLine => ({ poLineId, accepted: "", rejected: "", damaged: "", price: "" });

export default function ReceivingPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const locale = useLocale();
  const ar = locale === "ar";
  const searchParams = useSearchParams();
  const supplierFilter = Number(searchParams.get("supplierId")) || null;
  const inventory = useQuery(trpc.inventory.context.queryOptions());
  const branchId = inventory.data?.branch.id ?? 0;
  const context = useQuery(trpc.receiving.context.queryOptions());
  const locations = useQuery({ ...trpc.receiving.locations.queryOptions({ branchId }), enabled: branchId > 0 });
  const orders = useQuery({ ...trpc.receiving.approvedOrders.queryOptions({ branchId }), enabled: branchId > 0 });
  const receipts = useQuery({ ...trpc.receiving.receipts.queryOptions({ branchId }), enabled: branchId > 0 });
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [invoice, setInvoice] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ReceiptInputLine[]>([]);
  const selectedOrder = useMemo(() => orders.data?.find((order) => order.id === Number(purchaseOrderId)), [orders.data, purchaseOrderId]);
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.receiving.receipts.queryOptions({ branchId }).queryKey }),
      qc.invalidateQueries({ queryKey: trpc.receiving.approvedOrders.queryOptions({ branchId }).queryKey }),
      qc.invalidateQueries({ queryKey: trpc.inventory.overview.queryOptions({ branchId }).queryKey }),
      qc.invalidateQueries({ queryKey: trpc.inventory.movements.queryOptions({ branchId }).queryKey }),
    ]);
  };
  const create = useMutation(trpc.receiving.createDraft.mutationOptions({
    onSuccess: async (receipt) => {
      toast.success(ar ? "تم إنشاء مسودة الاستلام" : "Receipt draft created");
      setLines([]); setDeliveryNote(""); setInvoice(""); setNotes("");
      await refresh();
      window.location.assign(`/admin/inventory/receiving/${receipt.id}`);
    },
    onError: (error) => toast.error(error.message),
  }));
  const createReceipt = () => {
    try {
      if (!selectedOrder) throw new Error(ar ? "اختر أمر شراء معتمداً" : "Select an approved purchase order");
      const payload = lines.filter((line) => line.accepted || line.rejected || line.damaged).map((line) => {
        const acceptedQuantityScaled = line.accepted ? parseDecimalToScaled(line.accepted) : 0;
        const rejectedQuantityScaled = line.rejected ? parseDecimalToScaled(line.rejected) : 0;
        const damagedQuantityScaled = line.damaged ? parseDecimalToScaled(line.damaged) : 0;
        return { purchaseOrderLineId: line.poLineId, acceptedQuantityScaled, rejectedQuantityScaled, damagedQuantityScaled, actualUnitPriceMinor: line.price ? parseDecimalToScaled(line.price, 100) : undefined };
      });
      if (!payload.length) throw new Error(ar ? "أدخل كمية مستلمة واحدة على الأقل" : "Enter at least one received quantity");
      create.mutate({
        branchId, purchaseOrderId: selectedOrder.id, locationId: Number(locationId),
        receiptNumber: `GRN-${branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
        supplierDeliveryNote: deliveryNote || null, supplierInvoiceReference: invoice || null, notes: notes || null,
        idempotencyKey: `grn:${crypto.randomUUID()}`, lines: payload,
      });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid receipt"); }
  };
  return <div>
    <InventoryNav />
    <InventoryPageHeader titleEn="Purchase receiving" titleAr="استلام المشتريات" descriptionEn={supplierFilter ? `Receipt history for supplier ${supplierFilter}. Drafts have no inventory effect; posting adds accepted quantities to stock.` : "Create goods receipt notes against approved purchase orders. Drafts have no inventory effect; posting adds accepted quantities to stock."} descriptionAr={supplierFilter ? `سجل استلامات المورد ${supplierFilter}.` : "إنشاء إشعارات استلام لأوامر الشراء المعتمدة. المسودات لا تؤثر على المخزون؛ الترحيل يضيف الكميات المقبولة."} />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
      <Card><CardHeader><CardTitle>{ar ? "سجل الاستلامات" : "Receipt history"}</CardTitle></CardHeader><CardContent className="space-y-2">
        {receipts.data?.filter((receipt) => supplierFilter == null || receipt.supplier_id === supplierFilter).map((receipt) => <Link key={receipt.id} href={`/admin/inventory/receiving/${receipt.id}`} className="block min-h-14 rounded-lg border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="flex flex-wrap justify-between gap-2"><strong>{receipt.receipt_number}</strong><span className="rounded bg-muted px-2 py-1 text-xs">{receipt.status.replaceAll("_", " ")}</span></div>
          <p className="text-sm text-muted-foreground">{receipt.po_number_snapshot} · {ar ? receipt.supplier_name_ar_snapshot : receipt.supplier_name_en_snapshot} · {receipt.lines.length} {ar ? "بنود" : "lines"}</p>
          {receipt.needs_review_reason && <p className="text-sm text-destructive">{receipt.needs_review_reason}</p>}
        </Link>)}
        {!receipts.data?.filter((receipt) => supplierFilter == null || receipt.supplier_id === supplierFilter).length && <p className="text-sm text-muted-foreground">{ar ? "لا توجد استلامات بعد" : "No receipts yet"}</p>}
      </CardContent></Card>
      {context.data?.canCreate && <Card><CardHeader><CardTitle>{ar ? "إنشاء مسودة استلام" : "Create receipt draft"}</CardTitle></CardHeader><CardContent className="space-y-3">
        <Field label={ar ? "أمر الشراء المعتمد" : "Approved purchase order"}><select aria-label="Approved purchase order" className="min-h-11 w-full rounded-md border bg-background px-3" value={purchaseOrderId} onChange={(event) => { setPurchaseOrderId(event.target.value); const order = orders.data?.find((row) => row.id === Number(event.target.value)); setLines(order?.lines.map((line) => zeroLine(line.id)) ?? []); }}><option value="">—</option>{orders.data?.map((order) => <option key={order.id} value={order.id}>{order.po_number} · {order.supplier_name_en_snapshot} · {order.receiving_status.replaceAll("_", " ")}</option>)}</select></Field>
        <Field label={ar ? "موقع التخزين" : "Destination location"}><select aria-label="Destination location" className="min-h-11 w-full rounded-md border bg-background px-3" value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">—</option>{locations.data?.map((location) => <option key={location.id} value={location.id}>{ar ? location.name_ar : location.name_en}</option>)}</select></Field>
        <div className="grid gap-2 sm:grid-cols-2"><Field label={ar ? "إذن التسليم" : "Supplier delivery note"}><Input value={deliveryNote} onChange={(event) => setDeliveryNote(event.target.value)} /></Field><Field label={ar ? "رقم الفاتورة (اختياري)" : "Invoice reference (optional)"}><Input value={invoice} onChange={(event) => setInvoice(event.target.value)} /></Field></div>
        {selectedOrder && <div className="rounded-md bg-muted p-3 text-sm"><strong>{ar ? "سجل الاستلام" : "Receiving timeline"}</strong>{selectedOrder.receipts.filter((receipt) => receipt.status !== "draft").map((receipt) => <Link key={receipt.id} href={`/admin/inventory/receiving/${receipt.id}`} className="ms-2 inline-flex min-h-9 items-center underline">{receipt.receipt_number} · {receipt.status}</Link>)}{selectedOrder.receipts.filter((receipt) => receipt.status !== "draft").length === 0 && <span className="ms-2 text-muted-foreground">{ar ? "لا يوجد سجل بعد" : "No receipt history yet"}</span>}</div>}
        {selectedOrder?.lines.map((poLine) => {
          const line = lines.find((entry) => entry.poLineId === poLine.id) ?? zeroLine(poLine.id);
          const update = (key: keyof Omit<ReceiptInputLine, "poLineId">, value: string) => setLines((current) => current.map((entry) => entry.poLineId === poLine.id ? { ...entry, [key]: value } : entry));
          const acceptedCost = (() => { try { return multiplyDivide(line.accepted ? parseDecimalToScaled(line.accepted) : 0, line.price ? parseDecimalToScaled(line.price, 100) : poLine.unit_price_minor, 1_000); } catch { return 0; } })();
          const previousBase = selectedOrder.receipts.filter((receipt) => ["posted", "needs_review"].includes(receipt.status)).flatMap((receipt) => receipt.lines).filter((receiptLine) => receiptLine.purchase_order_line_id === poLine.id).reduce((sum, receiptLine) => sum + receiptLine.accepted_quantity_base, 0);
          const factor = { numerator: poLine.conversion_numerator_snapshot ?? poLine.packageConversion?.base_numerator ?? poLine.unit.base_numerator, denominator: poLine.conversion_denominator_snapshot ?? poLine.packageConversion?.base_denominator ?? poLine.unit.base_denominator };
          let currentBase = 0;
          try { currentBase = convertScaledQuantity({ quantityScaled: line.accepted ? parseDecimalToScaled(line.accepted) : 0, fromDimension: poLine.ingredient.dimension, toDimension: poLine.ingredient.dimension, factor }); } catch { currentBase = 0; }
          const remainingBase = Math.max(0, poLine.quantity_base - previousBase - currentBase);
          return <div key={poLine.id} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap justify-between gap-2"><strong>{ar ? poLine.ingredient_name_ar : poLine.ingredient_name_en} · {poLine.unit_code}</strong><span className="text-sm text-muted-foreground">{ar ? "سعر الطلب" : "PO price"}: {formatCurrency(poLine.unit_price_minor, locale)}</span></div>
            <p className="text-xs text-muted-foreground">{ar ? "بالطلب / سبق استلامه / هذا الإشعار / المتبقي" : "Ordered / previously received / this receipt / remaining"}: {formatExactQuantity(poLine.quantity_base, poLine.ingredient.dimension)} / {formatExactQuantity(previousBase, poLine.ingredient.dimension)} / {formatExactQuantity(currentBase, poLine.ingredient.dimension)} / {formatExactQuantity(remainingBase, poLine.ingredient.dimension)}</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Input aria-label={`Accepted quantity ${poLine.ingredient_name_en} ${poLine.unit_code}`} inputMode="decimal" placeholder={ar ? "مقبول" : "Accepted"} value={line.accepted} onChange={(event) => update("accepted", event.target.value)} />
              <Input aria-label={`Rejected quantity ${poLine.ingredient_name_en} ${poLine.unit_code}`} inputMode="decimal" placeholder={ar ? "مرفوض" : "Rejected"} value={line.rejected} onChange={(event) => update("rejected", event.target.value)} />
              <Input aria-label={`Damaged quantity ${poLine.ingredient_name_en} ${poLine.unit_code}`} inputMode="decimal" placeholder={ar ? "تالف" : "Damaged"} value={line.damaged} onChange={(event) => update("damaged", event.target.value)} />
              <Input aria-label={`Actual unit price ${poLine.ingredient_name_en} ${poLine.unit_code} EGP`} inputMode="decimal" placeholder={formatCurrency(poLine.unit_price_minor, locale)} value={line.price} onChange={(event) => update("price", event.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">{ar ? "الإجمالي المقبول المتوقع" : "Accepted line total"}: {formatCurrency(acceptedCost, locale)}</p>
          </div>;
        })}
        <Field label={ar ? "ملاحظات" : "Notes"}><Input value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
        <Button className="min-h-11 w-full" disabled={create.isPending || !purchaseOrderId || !locationId} onClick={createReceipt}>{ar ? "إنشاء مسودة الاستلام" : "Create receipt draft"}</Button>
      </CardContent></Card>}
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
