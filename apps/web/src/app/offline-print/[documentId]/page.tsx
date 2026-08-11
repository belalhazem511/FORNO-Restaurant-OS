"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PrinterIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import { offlineStore } from "@/lib/offline/storage";
import type { OfflineCashReceiptDocument, OfflineDocument } from "@/lib/offline/types";
import { formatCurrency } from "@/lib/utils";
import styles from "./offline-print.module.css";

type Language = "ar" | "en" | "bilingual";
const localized = (value: { en: string; ar: string }, language: Language) => language === "en" ? value.en : language === "ar" ? value.ar : `${value.ar} / ${value.en}`;

export default function OfflinePrintPage() {
  const params = useParams<{ documentId: string }>();
  const [document, setDocument] = useState<OfflineDocument | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // The service worker serves the cached warm-up shell for a dynamic receipt
    // URL while offline. Read the visible URL so that shell never looks up the
    // warm-up placeholder instead of the requested immutable document.
    const pathDocumentId = window.location.pathname.split("/").filter(Boolean).at(-1);
    const id = decodeURIComponent(pathDocumentId || params.documentId);
    offlineStore().getDocument(id).then(async (value) => {
      setDocument(value);
      if (value?.kind === "offline_cash_receipt") {
        await offlineStore().markReceiptPreview(value.operationId, new Date().toISOString());
        window.dispatchEvent(new Event("forno-offline-change"));
      }
    }).finally(() => setLoaded(true));
  }, [params.documentId]);

  if (!loaded) return <main className={styles.state}>Loading offline document…</main>;
  if (!document) return <main className={styles.state}>Offline document not found / المستند غير موجود</main>;
  if (document.kind !== "offline_cash_receipt") return <LegacyOfflineDocument document={document} />;
  return <OfflineCashReceiptPreview document={document} error={error} setError={setError} />;
}

function OfflineCashReceiptPreview({ document, error, setError }: { document: OfflineCashReceiptDocument; error: string; setError: (value: string) => void }) {
  const [paperWidth, setPaperWidth] = useState<58 | 80>(document.printing.paperWidth);
  const [language, setLanguage] = useState<Language>(document.printing.language);
  const copies = Array.from({ length: document.printing.copyCount }, (_, index) => index + 1);
  const print = () => {
    setError("");
    try { window.print(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The browser could not open printing."); }
  };
  return <main className={styles.previewShell} data-testid="offline-cash-receipt-preview">
    <style media="print">{`@page { size: ${paperWidth}mm auto; margin: 3mm; }`}</style>
    <section className={styles.toolbar} aria-label="Offline receipt print settings">
      <strong>Offline Cash Receipt / إيصال نقدي دون اتصال</strong>
      <div className={styles.settings}>
        <label>Paper / الورق<select value={paperWidth} onChange={(event) => setPaperWidth(Number(event.target.value) as 58 | 80)}><option value={80}>80 mm (default)</option><option value={58}>58 mm</option></select></label>
        <label>Language / اللغة<select value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="bilingual">Arabic + English</option><option value="ar">العربية</option><option value="en">English</option></select></label>
      </div>
      <Button className="min-h-12" onClick={print}><PrinterIcon />Open browser print dialog / فتح نافذة الطباعة</Button>
      <p>Copies configured for this register: {document.printing.copyCount}. Browser preview does not prove physical printing. If the dialog fails, keep this page open and retry the same receipt; no duplicate receipt or print job is created.</p>
      <p dir="rtl">عدد النسخ المضبوط: {document.printing.copyCount}. المعاينة لا تثبت الطباعة الفعلية. عند فشل الطابعة أعد المحاولة من نفس الإيصال.</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
    {copies.map((copy) => <OfflineReceiptPaper key={copy} document={document} width={paperWidth} language={language} copy={copy} />)}
  </main>;
}

function OfflineReceiptPaper({ document, width, language, copy }: { document: OfflineCashReceiptDocument; width: 58 | 80; language: Language; copy: number }) {
  const type = document.order.type === "dine_in" ? { en: "Dine-in", ar: "داخل المطعم" } : document.order.type === "delivery" ? { en: "Delivery", ar: "توصيل" } : { en: "Takeaway", ar: "استلام" };
  const money = (value: number) => formatCurrency(value, language === "ar" ? "ar" : "en");
  return <article className={`${styles.paper} ${width === 58 ? styles.paper58 : styles.paper80}`} dir={language === "en" ? "ltr" : "rtl"} lang={language === "bilingual" ? "ar" : language} data-paper-width={width} data-offline-receipt-number={document.offlineReceiptNumber}>
    <header className={styles.header}><h1>{localized(document.restaurant.name, language)}</h1><p>{localized(document.restaurant.branch, language)}</p>{localized(document.restaurant.address, language) && <p>{localized(document.restaurant.address, language)}</p>}{document.restaurant.phone && <p dir="ltr">{document.restaurant.phone}</p>}<div className={styles.title}>OFFLINE CASH RECEIPT<br /><span dir="rtl">إيصال نقدي دون اتصال</span></div><div className={styles.status}>CASH RECEIVED — OFFLINE<br />PENDING SERVER SYNCHRONIZATION<br /><span dir="rtl">تم استلام النقد — دون اتصال<br />بانتظار مزامنة الخادم</span></div></header>
    <dl className={styles.meta}><Row label="Offline receipt / الإيصال" value={document.offlineReceiptNumber} /><Row label="Date / التاريخ" value={new Date(document.checkoutAt).toLocaleString(language === "ar" ? "ar-EG" : "en-EG", { timeZone: "Africa/Cairo" })} /><Row label="Order / الطلب" value={document.orderReference} /><Row label="Type / النوع" value={localized(type, language)} /><Row label="Cashier / الكاشير" value={document.operator.cashier} /><Row label="Register / الكاشير" value={localized(document.operator.register, language)} /><Row label="Shift / الوردية" value={document.operator.shiftNumber} />{document.order.area && <Row label="Area / المنطقة" value={localized(document.order.area, language)} />}{document.order.table && <Row label="Table / الطاولة" value={localized(document.order.table, language)} />}{document.order.customerName && <Row label="Customer / العميل" value={document.order.customerName} />}{document.order.customerPhone && <Row label="Phone / الهاتف" value={document.order.customerPhone} />}{document.order.deliveryAddress && <Row label="Address / العنوان" value={document.order.deliveryAddress} />}</dl>
    <section className={styles.items}>{document.items.map((item, index) => <div className={styles.item} key={index}><div className={styles.itemHeading}><strong>{item.quantity} × {localized(item.name, language)}</strong><span>{money(item.lineTotal)}</span></div>{item.variant && <p>{localized(item.variant, language)}</p>}{item.modifiers.map((modifier, modifierIndex) => <p key={modifierIndex}>+ {localized(modifier.name, language)}{modifier.priceDelta ? ` (${money(modifier.priceDelta)})` : ""}</p>)}{item.notes && <p className={styles.notes}>Note / ملاحظة: {item.notes}</p>}</div>)}</section>
    <section className={styles.totals}><Row label="Subtotal / المجموع" value={money(document.financial.subtotal)} /><div className={styles.grandTotal}><span>Total collected / المحصل</span><strong>{money(document.financial.total)}</strong></div><Row label="Cash received / النقد المستلم" value={money(document.financial.cashReceived)} /><Row label="Change / الباقي" value={money(document.financial.change)} /></section>
    <footer><strong>NOT YET SERVER-SYNCHRONIZED / لم تتم المزامنة بعد</strong><br />No authoritative server receipt number assigned.<br /><span dir="rtl">لم يتم تعيين رقم إيصال خادم رسمي.</span><br />Copy {copy} / {document.printing.copyCount}</footer>
  </article>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function LegacyOfflineDocument({ document }: { document: Exclude<OfflineDocument, OfflineCashReceiptDocument> }) {
  return <main className={styles.legacy}><div className={styles.status}>OFFLINE — PENDING SYNC<br /><span dir="rtl">غير متصل — بانتظار المزامنة</span></div>{document.kind === "kot" ? <><h1>KOT — {document.station.name_en} / {document.station.name_ar}</h1>{document.items.map((item, index) => <p key={index}>{item.quantity} × {item.nameEn} / {item.nameAr}</p>)}<strong>NO PRICES — KITCHEN USE ONLY</strong></> : <><h1>UNPAID OFFLINE ORDER SUMMARY</h1><p>{document.orderReference}</p><strong>NOT A PAID RECEIPT</strong></>}<Button className="print:hidden" onClick={() => window.print()}>Print / طباعة</Button></main>;
}
