"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";

export function StorageActions() {
  const locale = useLocale();
  const ar = locale.startsWith("ar");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const createBackup = async () => {
    if (!window.fornoDesktop) return setMessage(ar ? "النسخ الاحتياطي متاح في تطبيق Windows فقط." : "Backups are available in the Windows application.");
    setBusy(true);
    setMessage("");
    try {
      const result = await window.fornoDesktop.createBackup();
      setMessage(ar ? `تم التحقق من النسخة: ${result.filename}` : `Backup verified: ${result.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (ar ? "فشل إنشاء النسخة." : "Backup failed."));
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    const confirmed = window.confirm(ar
      ? "سيتم حفظ نسخة استرداد من البيانات الحالية أولاً، ثم استعادة النسخة المختارة. هل تريد المتابعة؟"
      : "A recovery copy of the current data will be saved first. Restore the selected backup?");
    if (!confirmed || !window.fornoDesktop) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.fornoDesktop.restoreBackup(true);
      setMessage(result.restored
        ? (ar ? `تمت الاستعادة. نسخة البيانات السابقة محفوظة في: ${result.recoveryPath}` : `Restore complete. Previous data preserved at: ${result.recoveryPath}`)
        : (ar ? "تم إلغاء الاستعادة." : "Restore cancelled."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (ar ? "فشلت الاستعادة؛ تم الحفاظ على البيانات قدر الإمكان." : "Restore failed; existing data was preserved where possible."));
    } finally {
      setBusy(false);
    }
  };

  return <main className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6" dir={ar ? "rtl" : "ltr"}>
    <Card>
      <CardHeader><CardTitle>{ar ? "التخزين المحلي والنسخ الاحتياطي" : "Local storage and backups"}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{ar ? "تعمل بيانات هذا الجهاز محلياً. تتوقف قاعدة البيانات بأمان أثناء النسخ أو الاستعادة." : "This device keeps its business data locally. The database is safely paused during backup and restore."}</p>
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy || !window.fornoDesktop} onClick={() => void createBackup()}>{ar ? "إنشاء نسخة موثقة" : "Create verified backup"}</Button>
          <Button variant="outline" disabled={busy || !window.fornoDesktop} onClick={() => void restoreBackup()}>{ar ? "استعادة نسخة" : "Restore backup"}</Button>
        </div>
        {!window.fornoDesktop && <p className="text-sm">{ar ? "هذه الأدوات متاحة في تطبيق Windows فقط." : "These controls are available in the Windows desktop application."}</p>}
        <p role="status" aria-live="polite" className="break-words text-sm">{message}</p>
      </CardContent>
    </Card>
  </main>;
}
