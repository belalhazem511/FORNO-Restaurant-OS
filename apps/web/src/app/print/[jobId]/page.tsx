"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckIcon, PrinterIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import { Input } from "@forno/ui/components/input";
import { useLocale, useTranslations } from "next-intl";
import enMessages from "@/messages/en";
import arMessages from "@/messages/ar";
import type { TrustedPrintDocument, LocalizedText } from "@/lib/printing/documents";
import { calculatePrintableLineTotal } from "@/lib/printing/documents";
import { useTRPC } from "@/lib/trpc/client";
import styles from "./print.module.css";

type PrintLabels = { [Key in keyof typeof enMessages.printing]: string };

function localized(value: LocalizedText | null, language: TrustedPrintDocument["job"]["language"]) {
  if (!value) return null;
  if (language === "ar") return value.ar;
  if (language === "en") return value.en;
  return `${value.ar} / ${value.en}`;
}

function labelsFor(language: TrustedPrintDocument["job"]["language"]): PrintLabels {
  if (language === "ar") return arMessages.printing;
  return enMessages.printing;
}

function label(labels: PrintLabels, arabicLabels: PrintLabels, key: keyof PrintLabels, language: TrustedPrintDocument["job"]["language"]) {
  if (language === "bilingual") return `${arabicLabels[key]} / ${labels[key]}`;
  return labels[key];
}

function money(amount: number, language: TrustedPrintDocument["job"]["language"]) {
  return new Intl.NumberFormat(language === "en" ? "en-EG" : "ar-EG", { style: "currency", currency: "EGP", minimumFractionDigits: 2 }).format(amount / 100);
}

export default function PrintPreviewPage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ copy?: string }> }) {
  const { jobId } = use(params);
  const { copy } = use(searchParams);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const t = useTranslations("printing");
  const id = Number(jobId);
  const documentQuery = useQuery(trpc.printing.document.queryOptions({ jobId: id }));
  const [errorMessage, setErrorMessage] = useState("");
  const [showFailure, setShowFailure] = useState(false);
  const transition = useMutation(trpc.printing.transition.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.printing.document.queryOptions({ jobId: id }).queryKey }),
  }));

  if (documentQuery.isLoading) return <main className={styles.state}>{t("loadingDocument")}</main>;
  if (!documentQuery.data || documentQuery.error) return <main className={styles.state}><AlertTriangleIcon /><strong>{t("documentUnavailable")}</strong><span>{documentQuery.error?.message}</span></main>;
  const document = documentQuery.data;
  const requestedCopy = Math.max(1, Math.min(document.job.copyCount, Number(copy) || 1));
  const copies = copy ? [requestedCopy] : Array.from({ length: document.job.copyCount }, (_, index) => index + 1);

  const openPrintDialog = async () => {
    if (document.job.status === "requested") await transition.mutateAsync({ jobId: id, status: "previewed" });
    window.print();
  };

  return <main className={styles.previewShell} data-testid="standalone-print-preview">
    <style media="print">{`@page { size: ${document.job.paperWidth}mm auto; margin: 3mm; }`}</style>
    <section className={styles.toolbar} aria-label={t("settings")}>
      <div><strong>{document.job.paperWidth} mm · {document.job.language}</strong><p>{t("browserLimitation")}</p></div>
      <div className={styles.toolbarActions}>
        <Button className="min-h-12" onClick={openPrintDialog} disabled={transition.isPending}><PrinterIcon />{t("openPrintDialog")}</Button>
        {document.job.status === "previewed" && <Button variant="outline" className="min-h-12" onClick={() => transition.mutate({ jobId: id, status: "acknowledged" })}><CheckIcon />{t("acknowledge")}</Button>}
        <Button variant="ghost" className="min-h-12" onClick={() => setShowFailure((value) => !value)}>{t("reportFailure")}</Button>
      </div>
      {showFailure && <div className={styles.failure}><Input aria-label={t("errorDetails")} value={errorMessage} onChange={(event) => setErrorMessage(event.target.value)} placeholder={t("errorDetails")} /><Button variant="destructive" disabled={errorMessage.trim().length === 0} onClick={() => transition.mutate({ jobId: id, status: "failed", errorMessage })}>{t("reportFailure")}</Button></div>}
      <small>{t("acknowledgedHelp")}</small>
    </section>
    {copies.map((copyNumber) => <ThermalDocument key={copyNumber} document={document} copyNumber={copyNumber} locale={locale} />)}
  </main>;
}

export function ThermalDocument({ document, copyNumber, locale }: { document: TrustedPrintDocument; copyNumber: number; locale: string }) {
  const language = document.job.language;
  const labels = labelsFor(language);
  const arLabels = arMessages.printing;
  const l = (key: keyof PrintLabels) => label(labels, arLabels, key, language);
  const direction = language === "en" ? "ltr" : "rtl";
  const typeLabel = document.order.type === "dine_in" ? l("dineIn") : document.order.type === "delivery" ? l("delivery") : l("takeaway");
  const titleKey = document.job.documentType === "receipt" ? "receipt" : document.job.documentType === "order_summary" ? "orderSummary" : document.job.documentType === "refund" ? "refundDocument" : document.job.documentType === "reversal" ? "reversalDocument" : "kitchenTicket";
  return <article className={`${styles.paper} ${document.job.paperWidth === 58 ? styles.paper58 : styles.paper80}`} dir={direction} lang={language === "bilingual" ? locale : language} data-paper-width={document.job.paperWidth} data-document-type={document.job.documentType}>
    <header className={styles.header}>
      <h1>{localized(document.restaurant.name, language)}</h1>
      <p>{localized(document.restaurant.branch, language)}</p>
      {document.restaurant.address.en || document.restaurant.address.ar ? <p>{localized(document.restaurant.address, language)}</p> : null}
      {document.restaurant.phone && <p dir="ltr">{document.restaurant.phone}</p>}
      <div className={styles.documentTitle}>{l(titleKey)}</div>
      {document.job.isReprint && <div className={styles.reprint}>{l("reprint")}</div>}
      {document.financial?.state !== "paid" && document.job.documentType !== "kot" && <div className={styles.warning}>{document.financial?.state === "reversed" ? l("reversed") : document.financial?.state === "refunded" ? l("refunded") : l("notPaid")}</div>}
    </header>

    <dl className={styles.meta}>
      <Meta label={l("orderNumber")} value={document.order.number} />
      {document.financial && <Meta label={l("receiptNumber")} value={document.financial.receiptNumber} />}
      <Meta label={l("dateTime")} value={new Intl.DateTimeFormat(language === "en" ? "en-EG" : "ar-EG", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(document.financial?.transactionAt ?? document.order.createdAt))} />
      <Meta label="" value={typeLabel} />
      {document.station && <Meta label={l("station")} value={localized(document.station, language) ?? document.station.code} />}
      {document.order.area && <Meta label={l("diningArea")} value={localized(document.order.area, language)!} />}
      {document.order.table && <Meta label={l("table")} value={localized(document.order.table, language)!} />}
      {document.order.customerName && <Meta label={l("customer")} value={document.order.customerName} />}
      {document.order.customerPhone && <Meta label={l("phone")} value={document.order.customerPhone} />}
      {document.order.deliveryAddress && <Meta label={l("address")} value={document.order.deliveryAddress} />}
      {document.operator.cashier && <Meta label={l("cashier")} value={document.operator.cashier} />}
      {document.operator.register && <Meta label={l("register")} value={localized(document.operator.register, language)!} />}
      {document.operator.shiftNumber && <Meta label={l("shift")} value={document.operator.shiftNumber} />}
    </dl>

    <section className={styles.items}>
      {document.items.length === 0 && <p>{l("noItems")}</p>}
      {document.items.map((item, index) => <div className={styles.item} key={`${item.station.code}-${index}`}>
        <div className={styles.itemHeading}><strong>{item.quantity} × {localized(item, language)}</strong>{document.financial && <span>{money(calculatePrintableLineTotal(item), language)}</span>}</div>
        {item.variant && <p>{localized(item.variant, language)}</p>}
        {item.modifiers.map((modifier, modifierIndex) => <p key={modifierIndex}>+ {localized(modifier, language)}{document.financial && modifier.priceDelta > 0 ? ` (${money(modifier.priceDelta, language)})` : ""}</p>)}
        {item.notes && <p className={styles.notes}><strong>{l("kitchenNotes")}:</strong> {item.notes}</p>}
      </div>)}
    </section>

    {document.financial && <section className={styles.totals}>
      <Meta label={l("subtotal")} value={money(document.financial.subtotal, language)} />
      {document.financial.discount > 0 && <><Meta label={l("discount")} value={`−${money(document.financial.discount, language)}`} />{document.financial.discountReason && <Meta label={l("discountReason")} value={document.financial.discountReason} />}</>}
      <div className={styles.grandTotal}><span>{l("total")}</span><strong>{money(document.financial.total, language)}</strong></div>
      {document.financial.payments.length > 0 && <><h2>{l("payments")}</h2>{document.financial.payments.map((payment, index) => <Meta key={index} label={`${payment.kind === "refund" ? "−" : ""}${payment.method}`} value={money(payment.amount, language)} />)}</>}
      {document.financial.cashReceived > 0 && <Meta label={l("cashReceived")} value={money(document.financial.cashReceived, language)} />}
      {document.financial.change > 0 && <Meta label={l("change")} value={money(document.financial.change, language)} />}
      {document.financial.reversalReason && <Meta label={l("reversalReason")} value={document.financial.reversalReason} />}
    </section>}
    <footer>{l("copy").replaceAll("{current}", String(copyNumber)).replaceAll("{total}", String(document.job.copyCount))}</footer>
  </article>;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
