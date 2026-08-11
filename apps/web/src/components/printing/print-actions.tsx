"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChefHatIcon, PrinterIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@forno/ui/components/dialog";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useTranslations } from "next-intl";
import { browserPrintPreviewAdapter, PopupBlockedError } from "@/lib/printing/client";
import { useTRPC } from "@/lib/trpc/client";

type ReprintTarget = { documentType: "receipt" | "order_summary" | "refund" | "reversal" | "kot"; stationId: number | null };

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function PrintActions({ orderId, compact = false }: { orderId: number; compact?: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const t = useTranslations("printing");
  const tc = useTranslations("common");
  const options = useQuery(trpc.printing.options.queryOptions({ orderId }));
  const [message, setMessage] = useState("");
  const [reprintTarget, setReprintTarget] = useState<ReprintTarget | null>(null);
  const [reprintReason, setReprintReason] = useState("");

  const mutation = useMutation(trpc.printing.request.mutationOptions());
  const request = (target: ReprintTarget, reprint = false) => {
    setMessage("");
    let popup: Window;
    try {
      popup = browserPrintPreviewAdapter.reservePreview();
    } catch (cause) {
      setMessage(cause instanceof PopupBlockedError ? t("popupBlocked") : t("requestFailed"));
      return;
    }
    mutation.mutate({
      orderId,
      documentType: target.documentType,
      stationId: target.stationId,
      idempotencyKey: requestId(reprint ? "reprint" : "print"),
      reprint,
      reprintReason: reprint ? reprintReason : null,
    }, {
      onSuccess: (result) => {
        browserPrintPreviewAdapter.showPreview(popup, { jobId: result.jobId });
        void queryClient.invalidateQueries({ queryKey: trpc.printing.options.queryOptions({ orderId }).queryKey });
        setMessage(t("previewOpened"));
        setReprintTarget(null);
        setReprintReason("");
      },
      onError: (cause) => {
        popup.close();
        setMessage(cause.message || t("requestFailed"));
      },
    });
  };

  if (options.isLoading) return null;
  if (!options.data) return <p role="alert" className="text-sm text-destructive">{options.error?.message}</p>;
  const financialDocument: ReprintTarget = {
    documentType: options.data.paymentStatus === "paid" ? "receipt" : options.data.paymentStatus === "refunded" ? "reversal" : "order_summary",
    stationId: null,
  };
  const wasInitiallyRequested = (target: ReprintTarget) => options.data.initialDocuments.some((document) =>
    document.documentType === target.documentType && document.stationId === target.stationId,
  );

  return <div className={compact ? "space-y-2" : "space-y-3 rounded-xl border p-4"}>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-12" disabled={mutation.isPending || wasInitiallyRequested(financialDocument)} onClick={() => request(financialDocument)}><PrinterIcon />{wasInitiallyRequested(financialDocument) ? t("alreadyRequested") : options.data.paymentStatus === "paid" ? t("printReceipt") : options.data.paymentStatus === "refunded" ? t("reversalDocument") : t("printSummary")}</Button>
      {options.data.stations.map((station) => {
        const target: ReprintTarget = { documentType: "kot", stationId: station.id };
        return <Button key={station.id} type="button" variant="outline" className="min-h-12" disabled={mutation.isPending || options.data.orderStatus === "cancelled" || wasInitiallyRequested(target)} onClick={() => request(target)}><ChefHatIcon />{wasInitiallyRequested(target) ? t("alreadyRequested") : t("printKot")} · {station.code}</Button>;
      })}
      {options.data.canReprint && <>
        <Button type="button" variant="ghost" className="min-h-12" onClick={() => setReprintTarget(financialDocument)}><RotateCcwIcon />{t("reprintReceipt")}</Button>
        {options.data.stations.map((station) => <Button key={`reprint-${station.id}`} type="button" variant="ghost" className="min-h-12" onClick={() => setReprintTarget({ documentType: "kot", stationId: station.id })}><RotateCcwIcon />{t("reprintKot")} · {station.code}</Button>)}
      </>}
    </div>
    {!options.data.canReprint && <p className="text-sm text-muted-foreground">{t("reprintPermission")}</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    <Dialog open={Boolean(reprintTarget)} onOpenChange={(open) => { if (!open) setReprintTarget(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{reprintTarget?.documentType === "kot" ? t("reprintKot") : t("reprintReceipt")}</DialogTitle></DialogHeader><div className="space-y-2"><Label htmlFor={`reprint-reason-${orderId}`}>{t("reprintReason")}</Label><Input id={`reprint-reason-${orderId}`} className="min-h-12" value={reprintReason} onChange={(event) => setReprintReason(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setReprintTarget(null)}>{tc("cancel")}</Button><Button disabled={!reprintTarget || reprintReason.trim().length < 3 || mutation.isPending} onClick={() => reprintTarget && request(reprintTarget, true)}>{t("reprint")}</Button></DialogFooter></DialogContent>
    </Dialog>
  </div>;
}
