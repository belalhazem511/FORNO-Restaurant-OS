"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@forno/ui/components/button";
import { offlineStore } from "@/lib/offline/storage";
import type { OfflineDocument } from "@/lib/offline/types";
import { formatCurrency } from "@/lib/utils";

export default function OfflinePrintPage() {
  const params = useParams<{ documentId: string }>();
  const [document, setDocument] = useState<OfflineDocument | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    offlineStore().getDocument(decodeURIComponent(params.documentId)).then(setDocument).finally(() => setLoaded(true));
  }, [params.documentId]);

  if (!loaded) return <main className="mx-auto max-w-md p-6 text-center">Loading offline document…</main>;
  if (!document) return <main className="mx-auto max-w-md p-6 text-center">Offline document not found / المستند غير موجود</main>;

  return <main className="mx-auto max-w-md bg-white p-5 text-black print:max-w-none print:p-0">
    <div className="mb-4 border-4 border-black p-3 text-center text-xl font-black">OFFLINE — PENDING SYNC<br /><span dir="rtl">غير متصل — بانتظار المزامنة</span></div>
    {document.kind === "kot" ? <>
      <h1 className="text-center text-2xl font-black">KOT — {document.station.name_en}<br /><span dir="rtl">{document.station.name_ar}</span></h1>
      <p className="my-3 border-y py-2 text-center font-bold">{document.orderReference} · {document.orderType}{document.table && <> · {document.table.name_en} / <span dir="rtl">{document.table.name_ar}</span></>}</p>
      <div className="divide-y-2 divide-black border-y-2 border-black">{document.items.map((item, index) => <section key={`${item.nameEn}-${index}`} className="py-3 text-lg"><strong>{item.quantity} × {item.nameEn}</strong><div dir="rtl" className="font-bold">{item.nameAr}</div>{item.variantNameEn && <p>{item.variantNameEn} / <span dir="rtl">{item.variantNameAr}</span></p>}{item.modifiers.map((modifier) => <p key={modifier.nameEn}>+ {modifier.nameEn} / <span dir="rtl">{modifier.nameAr}</span></p>)}{item.notes && <p className="mt-2 border-2 border-black p-2 font-black">NOTE: {item.notes}</p>}</section>)}</div>
      <p className="mt-4 text-center font-bold">NO PRICES — KITCHEN USE ONLY</p>
    </> : <>
      <h1 className="text-center text-2xl font-black">UNPAID OFFLINE ORDER SUMMARY</h1>
      <p dir="rtl" className="text-center text-xl font-black">ملخص طلب مؤقت غير مدفوع — ليس إيصالاً</p>
      <p className="my-3 text-center">{document.orderReference}</p>
      {document.items.map((item, index) => <div key={`${item.nameEn}-${index}`} className="flex justify-between border-b py-2"><span>{item.quantity} × {item.nameEn} / <span dir="rtl">{item.nameAr}</span></span><span>{formatCurrency(item.provisionalLineTotal, "en")}</span></div>)}
      <p className="mt-3 flex justify-between text-lg font-bold"><span>PROVISIONAL TOTAL</span><span>{formatCurrency(document.provisionalTotal, "en")}</span></p>
      {document.cashReceived != null && <><p>Cash received (provisional): {formatCurrency(document.cashReceived, "en")}</p><p>Estimated change: {formatCurrency(document.estimatedChange ?? 0, "en")}</p></>}
      <p className="mt-4 border-2 border-black p-3 text-center font-black">NOT A PAID RECEIPT / ليس إيصال دفع نهائي</p>
    </>}
    <Button className="mt-5 w-full print:hidden" onClick={() => window.print()}>Print / طباعة</Button>
  </main>;
}
