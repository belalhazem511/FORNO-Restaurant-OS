"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@forno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@forno/ui/components/dialog";
import { Input } from "@forno/ui/components/input";
import { formatCurrency } from "@/lib/utils";
import { useOffline } from "@/components/offline/offline-provider";
import { buildOfflineCashReceipt, offlineReceiptNumber } from "@/lib/offline/documents";
import { createQueueEntry } from "@/lib/offline/queue";
import { offlineStore } from "@/lib/offline/storage";
import { newOfflineId, type OfflineBootstrapSnapshot, type OfflineCashReceiptDocument, type OfflineKotDocument } from "@/lib/offline/types";
import type { CartLine } from "@/lib/pos/cart";


export type OfflineSuccess = {
  operationId: string;
  orderReference: string;
  payload: Parameters<typeof createQueueEntry>[0]["payload"];
  kots: OfflineKotDocument[];
  provisionalTotal: number;
  cashReceived: number | null;
  cart: CartLine[];
  areaId: number | null;
  tableId: number | null;
  delivery: { name: string; phone: string; address: string } | null;
  receipt: OfflineCashReceiptDocument | null;
};

export function OfflineKotDialog({ document, onOpenChange }: { document: OfflineKotDocument | null; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={Boolean(document)} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[95vh] max-w-lg overflow-y-auto bg-white text-black">
      {document && <div className="space-y-4"><DialogHeader><div className="border-4 border-black p-3 text-center text-xl font-black">OFFLINE — PENDING SYNC<br /><span dir="rtl">غير متصل — بانتظار المزامنة</span></div><DialogTitle className="text-center text-2xl">KOT — {document.station.name_en} / <span dir="rtl">{document.station.name_ar}</span></DialogTitle><DialogDescription className="text-center text-black">{document.orderReference} · {document.orderType}</DialogDescription></DialogHeader><div className="divide-y-2 divide-black border-y-2 border-black">{document.items.map((item, index) => <section key={`${item.nameEn}-${index}`} className="py-3 text-lg"><strong>{item.quantity} × {item.nameEn}</strong><p dir="rtl" className="font-bold">{item.nameAr}</p>{item.variantNameEn && <p>{item.variantNameEn} / <span dir="rtl">{item.variantNameAr}</span></p>}{item.modifiers.map((modifier) => <p key={modifier.nameEn}>+ {modifier.nameEn} / <span dir="rtl">{modifier.nameAr}</span></p>)}{item.notes && <p className="mt-2 border-2 border-black p-2 font-black">NOTE: {item.notes}</p>}</section>)}</div><p className="text-center font-black">NO PRICES — KITCHEN USE ONLY / بدون أسعار</p><Button className="w-full print:hidden" onClick={() => window.print()}>Print / طباعة</Button></div>}
    </DialogContent>
  </Dialog>;
}

export function OfflineCashDialog({ open, onOpenChange, sale, snapshot, onQueued }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: OfflineSuccess;
  snapshot: OfflineBootstrapSnapshot;
  onQueued: (receipt: OfflineCashReceiptDocument) => void;
}) {
  const locale = useLocale();
  const isArabic = locale.startsWith("ar");
  const offline = useOffline();
  const [received, setReceived] = useState((sale.provisionalTotal / 100).toFixed(2));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const receivedMinor = Math.round(Number(received || 0) * 100);
  const change = Math.max(0, receivedMinor - sale.provisionalTotal);

  const confirm = async () => {
    setError("");
    if (new Date(snapshot.priceSnapshot.expiresAt).getTime() <= Date.now()) {
      setError(isArabic ? "انتهت صلاحية النسخة السعرية الآمنة. اتصل بالخادم لتحديثها قبل استلام النقد." : "The secure price snapshot expired. Reconnect and refresh it before accepting cash.");
      return;
    }
    if (!offline.userId || receivedMinor < sale.provisionalTotal) {
      setError(isArabic ? "المبلغ النقدي لا يغطي إجمالي الإيصال." : "Cash received does not cover the receipt total.");
      return;
    }
    setSaving(true);
    try {
      const checkoutAt = new Date().toISOString();
      const checkoutIdempotencyKey = newOfflineId("offline-checkout");
      const deviceInstanceId = await offlineStore().getOrCreateDeviceInstanceId();
      const number = await offlineReceiptNumber({ branchId: snapshot.branch.id, branchCode: snapshot.branch.code, registerId: snapshot.register.id, registerCode: snapshot.register.code, deviceInstanceId, checkoutIdempotencyKey, checkoutAt });
      const printIdempotencyKey = `offline-receipt-print:${sale.operationId}`;
      const receipt = buildOfflineCashReceipt({ operationId: sale.operationId, orderReference: sale.orderReference, offlineReceiptNumber: number, checkoutIdempotencyKey, printIdempotencyKey, checkoutAt, orderType: sale.payload.order.orderType, areaId: sale.areaId, tableId: sale.tableId, delivery: sale.delivery, cart: sale.cart, total: sale.provisionalTotal, cashReceived: receivedMinor, snapshot });
      const payload: OfflineSuccess["payload"] = {
        ...sale.payload,
        kind: "cash_sale",
        cash: { checkoutIdempotencyKey, tenderedAmount: receivedMinor },
        offlineReceipt: { number, deviceInstanceId, checkoutAt, subtotal: receipt.financial.subtotal, total: receipt.financial.total, cashReceived: receipt.financial.cashReceived, change: receipt.financial.change, printIdempotencyKey, previewedAt: null },
        kotAcknowledgements: sale.kots.map((kot) => ({ stationId: kot.stationId, idempotencyKey: kot.id, previewed: true, acknowledged: false })),
      };
      await offline.enqueue(createQueueEntry({ payload, userId: offline.userId, now: new Date(checkoutAt) }), [receipt]);
      onQueued(receipt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader><DialogTitle>{isArabic ? "دفع نقدي دون اتصال" : "Offline cash checkout"}</DialogTitle><DialogDescription>{isArabic ? "سيتم تثبيت المبالغ وإنشاء إيصال نقدي قابل للطباعة فور استلام النقد." : "Amounts will be frozen into an immediately printable Offline Cash Receipt when cash is accepted."}</DialogDescription></DialogHeader>
      <div className="space-y-4"><div className="rounded-lg bg-muted p-4 text-center"><p className="text-sm text-muted-foreground">{isArabic ? "إجمالي الإيصال" : "Receipt total"}</p><strong className="text-2xl">{formatCurrency(sale.provisionalTotal, locale)}</strong></div><Input inputMode="decimal" label={isArabic ? "النقد المستلم" : "Cash received"} value={received} onChange={(event) => setReceived(event.target.value)} /><p className="font-semibold">{isArabic ? "الباقي" : "Change"}: {formatCurrency(change, locale)}</p><div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-950">{isArabic ? "الأسعار معتمدة من نسخة خادم آمنة وصالحة حتى" : "Prices are bound to a secure server-issued snapshot valid until"} {new Date(snapshot.priceSnapshot.expiresAt).toLocaleString(locale)}. {isArabic ? "ستبقى القيم المطبوعة ثابتة، وأي تعارض ينتقل إلى مراجعة المدير ولا يُحذف." : "Printed values remain fixed; any conflict moves to manager review and is never discarded."}</div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>{isArabic ? "إلغاء" : "Cancel"}</Button><Button disabled={saving || receivedMinor < sale.provisionalTotal} onClick={() => void confirm()}>{saving ? (isArabic ? "جارٍ الحفظ…" : "Saving…") : (isArabic ? "استلام النقد وإنشاء الإيصال" : "Accept cash and create receipt")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
