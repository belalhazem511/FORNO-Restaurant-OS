"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PrinterIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@forno/ui/components/select";
import { useLocale, useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc/client";

export function PrintSettings({ branchId }: { branchId: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const t = useTranslations("printing");
  const query = useQuery(trpc.printing.registerSettings.queryOptions({ branchId }));
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80);
  const [language, setLanguage] = useState<"ar" | "en" | "bilingual">("bilingual");
  const [receiptCopies, setReceiptCopies] = useState(1);
  const [kotCopies, setKotCopies] = useState(1);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!query.data) return;
    setPaperWidth(query.data.preferences.paperWidth);
    setLanguage(query.data.preferences.language);
    setReceiptCopies(query.data.preferences.receiptCopies);
    setKotCopies(query.data.preferences.kotCopies);
  }, [query.data]);
  const mutation = useMutation(trpc.printing.updatePreferences.mutationOptions({
    onSuccess: async () => {
      setMessage(t("settingsSaved"));
      await queryClient.invalidateQueries({ queryKey: trpc.printing.registerSettings.queryOptions({ branchId }).queryKey });
    },
    onError: (cause) => setMessage(cause.message),
  }));
  if (!query.data?.register) return null;
  const disabled = !query.data.canManageSettings || mutation.isPending;
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><PrinterIcon />{t("settings")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">{locale === "ar" ? query.data.register.name_ar : query.data.register.name_en}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2"><Label>{t("paperWidth")}</Label><Select disabled={disabled} value={String(paperWidth)} onValueChange={(value) => setPaperWidth(Number(value) as 58 | 80)}><SelectTrigger className="min-h-12"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="80">{t("width80")}</SelectItem><SelectItem value="58">{t("width58")}</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label>{t("language")}</Label><Select disabled={disabled} value={language} onValueChange={(value) => setLanguage(value as typeof language)}><SelectTrigger className="min-h-12"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ar">{t("languageAr")}</SelectItem><SelectItem value="en">{t("languageEn")}</SelectItem><SelectItem value="bilingual">{t("languageBilingual")}</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="receipt-copies">{t("receiptCopies")}</Label><Input id="receipt-copies" type="number" min={1} max={5} disabled={disabled} className="min-h-12" value={receiptCopies} onChange={(event) => setReceiptCopies(Number(event.target.value))} /></div>
        <div className="space-y-2"><Label htmlFor="kot-copies">{t("kotCopies")}</Label><Input id="kot-copies" type="number" min={1} max={5} disabled={disabled} className="min-h-12" value={kotCopies} onChange={(event) => setKotCopies(Number(event.target.value))} /></div>
      </div>
      {!query.data.canManageSettings && <p className="text-sm text-muted-foreground">{t("settingsReadOnly")}</p>}
      {query.data.canManageSettings && <Button className="min-h-12" disabled={disabled || receiptCopies < 1 || receiptCopies > 5 || kotCopies < 1 || kotCopies > 5} onClick={() => mutation.mutate({ registerId: query.data!.register!.id, paperWidth, language, receiptCopies, kotCopies })}>{t("saveSettings")}</Button>}
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </CardContent>
  </Card>;
}
