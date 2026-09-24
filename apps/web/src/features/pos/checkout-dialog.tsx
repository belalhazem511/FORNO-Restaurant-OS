"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@forno/ui/components/dialog";
import { Input } from "@forno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@forno/ui/components/select";
import { formatCurrency } from "@/lib/utils";
import { calculateDiscount } from "@/lib/finance";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/router";
import { createRequestId } from "./request-id";

type CheckoutResult = RouterOutputs["checkout"]["pay"];

export function POSCheckoutDialog({
  open,
  onOpenChange,
  orderId,
  subtotal,
  branchId,
  role,
  paymentMethods: methods,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: number;
  subtotal: number;
  branchId: number;
  role: "owner" | "admin" | "manager" | "cashier";
  paymentMethods: Array<{ id: number; code: string | null; name: string; affects_drawer: boolean }>;
  onSuccess: (result: CheckoutResult) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const t = useTranslations("pos");
  const tc = useTranslations("common");
  const [discountType, setDiscountType] = useState<"none" | "percentage" | "fixed">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [cashReceived, setCashReceived] = useState("");
  const [requestId] = useState(createRequestId);
  const [error, setError] = useState("");

  const discountInput = discountType === "none" ? null : {
    type: discountType,
    value: discountType === "percentage" ? Math.round(Number(discountValue || 0) * 100) : Math.round(Number(discountValue || 0) * 100),
    reason: discountReason,
  } as const;
  let discountAmount = 0;
  try { discountAmount = calculateDiscount(subtotal, discountInput); } catch { discountAmount = 0; }
  const payable = subtotal - discountAmount;
  const allocated = methods.reduce((sum, method) => sum + Math.round(Number(allocations[method.id] || 0) * 100), 0);
  const remaining = payable - allocated;
  const cashMethod = methods.find((method) => method.affects_drawer);
  const cashAllocation = cashMethod ? Math.round(Number(allocations[cashMethod.id] || 0) * 100) : 0;
  const cashTendered = Math.round(Number(cashReceived || 0) * 100);
  const changeDue = Math.max(0, cashTendered - cashAllocation);
  const canDiscount = role !== "cashier";

  const mutation = useMutation(trpc.checkout.pay.mutationOptions({
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.orders.list.queryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: trpc.shifts.context.queryOptions({ branchId }).queryKey }),
        queryClient.invalidateQueries({ queryKey: trpc.printing.options.queryOptions({ orderId }).queryKey }),
      ]);
      onSuccess(result);
    },
    onError: (cause) => setError(cause.message),
  }));

  const setFullPayment = (methodId: number) => {
    setAllocations({ [methodId]: (payable / 100).toFixed(2) });
    const method = methods.find((entry) => entry.id === methodId);
    setCashReceived(method?.affects_drawer ? (payable / 100).toFixed(2) : "");
  };

  const confirm = () => {
    setError("");
    if (discountType !== "none" && !canDiscount) { setError(t("permissionDenied")); return; }
    let serverDiscount: { type: "percentage" | "fixed"; value: number; reason: string } | null = null;
    if (discountInput) {
      try {
        calculateDiscount(subtotal, discountInput);
        serverDiscount = discountInput;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("invalidDiscount"));
        return;
      }
    }
    const payments = methods.flatMap((method) => {
      const amount = Math.round(Number(allocations[method.id] || 0) * 100);
      if (amount <= 0) return [];
      return [{ paymentMethodId: method.id, amount, tenderedAmount: method.affects_drawer ? cashTendered || amount : null }];
    });
    mutation.mutate({ orderId, idempotencyKey: requestId, discount: serverDiscount, payments });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[95vh] max-w-2xl overflow-y-auto p-0">
      <DialogHeader className="border-b p-5 text-start"><DialogTitle>{t("checkoutTitle")}</DialogTitle><DialogDescription>{t("checkoutOrderNumber", { number: orderId })}</DialogDescription></DialogHeader>
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("subtotal")}</p><strong>{formatCurrency(subtotal, locale)}</strong></div><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("discount")}</p><strong>{formatCurrency(discountAmount, locale)}</strong></div><div className="rounded-lg border border-primary p-3"><p className="text-xs text-muted-foreground">{t("payable")}</p><strong className="text-primary">{formatCurrency(payable, locale)}</strong></div></div>
        <fieldset className="space-y-3"><legend className="font-semibold">{t("discountAuthorization")}</legend><Select value={discountType} onValueChange={(value) => setDiscountType(value as typeof discountType)} disabled={!canDiscount}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("noDiscount")}</SelectItem><SelectItem value="percentage">{t("percentageDiscount")}</SelectItem><SelectItem value="fixed">{t("fixedDiscount")}</SelectItem></SelectContent></Select>{discountType !== "none" && <div className="grid gap-3 sm:grid-cols-2"><Input aria-label={discountType === "percentage" ? t("discountPercent") : t("discountAmount")} className="min-h-11" inputMode="decimal" label={discountType === "percentage" ? t("discountPercent") : t("discountAmount")} value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} /><Input aria-label={t("discountReason")} className="min-h-11" label={t("discountReason")} value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} /></div>}{!canDiscount && <p className="text-sm text-muted-foreground">{t("managerApprovalRequired")}</p>}</fieldset>
        <fieldset className="space-y-3"><legend className="font-semibold">{t("paymentAllocation")}</legend>{methods.map((method) => <div key={method.id} className="grid grid-cols-[1fr_140px_auto] items-end gap-2 rounded-lg border p-3"><div><p className="font-medium">{method.name}</p><button type="button" className="text-sm text-primary underline" onClick={() => setFullPayment(method.id)}>{t("payFull")}</button></div><Input aria-label={`${method.name} ${t("allocation")}`} inputMode="decimal" value={allocations[method.id] ?? ""} onChange={(event) => setAllocations((current) => ({ ...current, [method.id]: event.target.value }))} /><span className="pb-3 text-sm">EGP</span></div>)}</fieldset>
        {cashAllocation > 0 && <div className="grid gap-3 rounded-lg bg-muted p-4 sm:grid-cols-2"><Input aria-label={t("cashReceived")} className="min-h-11" inputMode="decimal" label={t("cashReceived")} value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /><div><p className="text-sm text-muted-foreground">{t("changeDue")}</p><p className="text-xl font-bold">{formatCurrency(changeDue, locale)}</p></div></div>}
        <div className={`rounded-lg p-3 text-center font-semibold ${remaining === 0 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{remaining === 0 ? t("allocationComplete") : t("remainingAmount", { amount: formatCurrency(remaining, locale) })}</div>
        {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter className="border-t p-5"><Button variant="outline" className="min-h-12" onClick={() => onOpenChange(false)}>{tc("cancel")}</Button><Button className="min-h-12" disabled={mutation.isPending || remaining !== 0 || allocated <= 0 || (cashAllocation > 0 && cashTendered < cashAllocation)} onClick={confirm}>{mutation.isPending ? t("confirmingPayment") : t("confirmCheckout")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
