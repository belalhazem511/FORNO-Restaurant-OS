"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BanknoteIcon, CircleDollarSignIcon, LockKeyholeIcon, ScaleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@forno/ui/components/select";
import { Skeleton } from "@forno/ui/components/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { formatCurrency } from "@/lib/utils";
import { PrintSettings } from "@/components/printing/print-settings";

function minorUnits(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export default function CashierShiftsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const isArabic = locale === "ar";
  const t = useTranslations("cashier");
  const tc = useTranslations("common");
  const { data: restaurant, isLoading: restaurantLoading } = useQuery(trpc.restaurant.model.queryOptions());
  const branch = restaurant?.[0];
  const contextQuery = useQuery({ ...trpc.shifts.context.queryOptions({ branchId: branch?.id ?? 0 }), enabled: Boolean(branch) });
  const historyQuery = useQuery({ ...trpc.shifts.history.queryOptions({ branchId: branch?.id ?? 0 }), enabled: Boolean(branch) });
  const context = contextQuery.data;
  const shift = context?.currentShift;
  const [registerId, setRegisterId] = useState("");
  const [openingFloat, setOpeningFloat] = useState("0");
  const [movementType, setMovementType] = useState<"cash_in" | "cash_out">("cash_in");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [closingCash, setClosingCash] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.shifts.context.queryOptions({ branchId: branch!.id }).queryKey }),
      queryClient.invalidateQueries({ queryKey: trpc.shifts.history.queryOptions({ branchId: branch!.id }).queryKey }),
      queryClient.invalidateQueries({ queryKey: trpc.restaurant.model.queryOptions().queryKey }),
    ]);
  };
  const openMutation = useMutation(trpc.shifts.open.mutationOptions({ onSuccess: refresh, onError: (cause) => setError(cause.message) }));
  const moveMutation = useMutation(trpc.shifts.moveCash.mutationOptions({
    onSuccess: async () => { setMovementAmount(""); setMovementReason(""); await refresh(); },
    onError: (cause) => setError(cause.message),
  }));
  const closeMutation = useMutation(trpc.shifts.close.mutationOptions({ onSuccess: refresh, onError: (cause) => setError(cause.message) }));

  if (restaurantLoading || contextQuery.isLoading) {
    return <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  }
  if (!branch) return <Card><CardContent className="p-6">{t("branchRequired")}</CardContent></Card>;
  if (contextQuery.error) return <Card><CardContent className="p-6 text-destructive">{contextQuery.error.message}</CardContent></Card>;

  const selectedRegister = registerId || String(context?.registers[0]?.id ?? "");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-2xl font-bold">{t("shiftTitle")}</h2><p className="text-muted-foreground">{branch.name_en} · {t(`role_${context?.role ?? "cashier"}`)}</p></div>
        {shift && <div className="rounded-full bg-emerald-100 px-4 py-2 font-medium text-emerald-800">{t("shiftOpen")} #{shift.id}</div>}
      </div>
      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {!shift ? (
        <Card className="max-w-xl">
          <CardHeader><CardTitle>{t("openShift")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2"><Label htmlFor="register">{t("register")}</Label><Select value={selectedRegister} onValueChange={setRegisterId}><SelectTrigger id="register" className="min-h-12"><SelectValue /></SelectTrigger><SelectContent>{context?.registers.map((register) => <SelectItem key={register.id} value={String(register.id)}>{isArabic ? register.name_ar : register.name_en}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="opening-float">{t("openingFloat")}</Label><Input id="opening-float" className="min-h-12 text-lg" inputMode="decimal" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} /></div>
            <Button className="min-h-14 w-full text-base" disabled={!selectedRegister || openMutation.isPending} onClick={() => { setError(""); openMutation.mutate({ branchId: branch.id, registerId: Number(selectedRegister), openingFloat: minorUnits(openingFloat) }); }}>{openMutation.isPending ? tc("loading") : t("openShiftAction")}</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={<BanknoteIcon />} label={t("openingFloat")} value={formatCurrency(shift.opening_float, locale)} />
            <SummaryCard icon={<CircleDollarSignIcon />} label={t("cashSales")} value={formatCurrency(shift.summary.cashSales, locale)} />
            <SummaryCard icon={<LockKeyholeIcon />} label={t("cashAdjustments")} value={`${formatCurrency(shift.summary.cashIn, locale)} / ${formatCurrency(shift.summary.cashOut, locale)}`} />
            <SummaryCard icon={<ScaleIcon />} label={t("expectedCash")} value={formatCurrency(shift.summary.expectedCash, locale)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>{t("paymentSummary")}</CardTitle></CardHeader><CardContent className="space-y-3">{shift.summary.byPaymentMethod.map((method) => <div key={method.paymentMethodId} className="flex items-center justify-between rounded-lg border p-3"><span>{method.name}</span><span className="font-semibold">{formatCurrency(method.net, locale)}</span></div>)}</CardContent></Card>
            {context?.canAdjustCash && <Card><CardHeader><CardTitle>{t("cashMovement")}</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid grid-cols-2 gap-2"><Button type="button" variant={movementType === "cash_in" ? "default" : "outline"} className="min-h-12" onClick={() => setMovementType("cash_in")}>{t("cashIn")}</Button><Button type="button" variant={movementType === "cash_out" ? "default" : "outline"} className="min-h-12" onClick={() => setMovementType("cash_out")}>{t("cashOut")}</Button></div><div className="space-y-2"><Label htmlFor="movement-amount">{tc("amount")}</Label><Input id="movement-amount" inputMode="decimal" className="min-h-12" value={movementAmount} onChange={(event) => setMovementAmount(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="movement-reason">{t("mandatoryReason")}</Label><Input id="movement-reason" className="min-h-12" value={movementReason} onChange={(event) => setMovementReason(event.target.value)} /></div><Button className="min-h-12 w-full" disabled={moveMutation.isPending || minorUnits(movementAmount) <= 0 || movementReason.trim().length < 3} onClick={() => { setError(""); moveMutation.mutate({ shiftId: shift.id, type: movementType, amount: minorUnits(movementAmount), reason: movementReason }); }}>{t("recordMovement")}</Button></CardContent></Card>}
          </div>

          <Card><CardHeader><CardTitle>{t("closeShift")}</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"><div className="space-y-2"><Label htmlFor="closing-cash">{t("closingCash")}</Label><Input id="closing-cash" inputMode="decimal" className="min-h-12 text-lg" value={closingCash} onChange={(event) => setClosingCash(event.target.value)} /></div><Button variant="destructive" className="min-h-12 px-8" disabled={closeMutation.isPending || closingCash === ""} onClick={() => { setError(""); closeMutation.mutate({ shiftId: shift.id, closingCash: minorUnits(closingCash) }); }}>{t("closeAndReconcile")}</Button></CardContent></Card>
        </>
      )}

      <PrintSettings branchId={branch.id} />
      <Card><CardHeader><CardTitle>{t("shiftHistory")}</CardTitle></CardHeader><CardContent className="space-y-3">{historyQuery.data?.length ? historyQuery.data.map((entry) => <div key={entry.id} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-5"><strong>#{entry.id} · {entry.register.code}</strong><span>{entry.status === "open" ? t("shiftOpen") : t("shiftClosed")}</span><span>{t("expectedCash")}: {formatCurrency(entry.summary.expectedCash, locale)}</span><span>{t("closingCash")}: {entry.closing_cash == null ? "—" : formatCurrency(entry.closing_cash, locale)}</span><span>{t("variance")}: {entry.variance == null ? "—" : formatCurrency(entry.variance, locale)}</span></div>) : <p className="text-muted-foreground">{t("noShiftHistory")}</p>}</CardContent></Card>
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <Card><CardContent className="flex items-center gap-3 p-5"><div className="rounded-xl bg-primary/10 p-3 text-primary">{icon}</div><div><p className="text-sm text-muted-foreground">{label}</p><p className="text-xl font-bold">{value}</p></div></CardContent></Card>;
}
