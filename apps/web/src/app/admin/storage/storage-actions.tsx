"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";

export function StorageActions() {
  const locale = useLocale();
  const ar = locale.startsWith("ar");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [device, setDevice] = useState<{ deviceId: string; paired: boolean; remoteOrganizationId: string | null } | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ state: string; pendingCount?: number; needsReviewCount?: number }>({ state: "local_only" });
  const [centralUrl, setCentralUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [registerId, setRegisterId] = useState("");
  const [issuedCode, setIssuedCode] = useState("");

  useEffect(() => {
    if (window.fornoDesktop) {
      void window.fornoDesktop.getDeviceStatus().then(setDevice).catch(() => undefined);
      void window.fornoDesktop.getSyncStatus().then(setSyncStatus).catch(() => undefined);
    }
  }, []);

  const syncNow = async () => {
    if (!window.fornoDesktop) return;
    setSyncStatus({ state: "syncing" });
    try {
      setSyncStatus(await window.fornoDesktop.syncNow());
    } catch {
      setSyncStatus({ state: "offline" });
    }
  };

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

  const pairThisDevice = async () => {
    if (!window.fornoDesktop) return;
    setBusy(true);
    setMessage("");
    try {
      await window.fornoDesktop.pairDevice({ centralUrl, pairingCode, deviceName });
      setDevice(await window.fornoDesktop.getDeviceStatus());
      setMessage(ar ? "تم إقران هذا الجهاز. سيظل العمل المحلي متاحاً أثناء انقطاع الاتصال." : "Device paired. Local operations remain available when disconnected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (ar ? "تعذر إقران الجهاز." : "Device pairing failed."));
    } finally {
      setBusy(false);
    }
  };

  const issuePairingCode = async () => {
    setBusy(true);
    setMessage("");
    setIssuedCode("");
    try {
      const response = await fetch("/api/sync/pairing-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branchId: Number(branchId), registerId: Number(registerId) }),
      });
      const result = await response.json() as { code?: string; error?: string; expiresAt?: string };
      if (!response.ok || !result.code) throw new Error(result.error ?? "Could not create a pairing code.");
      setIssuedCode(result.code);
      const expires = new Date(result.expiresAt!).toLocaleString(locale);
      setMessage(ar ? "ينتهي الرمز في " + expires + ". استخدمه مرة واحدة على الجهاز." : "Code expires " + expires + ". Enter it once on the device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (ar ? "تعذر إنشاء رمز الإقران." : "Could not create a pairing code."));
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
    <Card>
      <CardHeader><CardTitle>{ar ? "حالة الجهاز والإقران" : "Device status and pairing"}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {window.fornoDesktop ? <>
          <p className="break-all text-sm">{ar ? "معرّف الجهاز" : "Device ID"}: {device?.deviceId ?? (ar ? "جارٍ التحميل" : "Loading")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" aria-live="polite" className="text-sm">{ar ? "المزامنة" : "Synchronization"}: {syncStatus.state.replaceAll("_", " ")}{syncStatus.pendingCount ? ` (${syncStatus.pendingCount})` : ""}{syncStatus.needsReviewCount ? ` · ${ar ? "بحاجة إلى مراجعة" : "Needs Review"}: ${syncStatus.needsReviewCount}` : ""}</p>
            <Button variant="outline" disabled={busy || syncStatus.state === "syncing" || !device?.paired} onClick={() => void syncNow()}>{ar ? "مزامنة الآن" : "Sync now"}</Button>
          </div>
          <p className="text-sm">{ar ? "الحالة" : "Status"}: {device?.paired ? (ar ? "مقترن" : "Paired") : (ar ? "محلي فقط" : "Local Only")}</p>
          {!device?.paired && <>
            <Input label={ar ? "عنوان الخادم المركزي" : "Central server URL"} value={centralUrl} onChange={(event) => setCentralUrl(event.target.value)} />
            <Input label={ar ? "رمز الإقران لمرة واحدة" : "One-time pairing code"} value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} />
            <Input label={ar ? "اسم هذا الجهاز" : "Device name"} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
            <Button disabled={busy || !centralUrl || !pairingCode || !deviceName} onClick={() => void pairThisDevice()}>{ar ? "إقران الجهاز" : "Pair device"}</Button>
          </>}
        </> : <>
          <p className="text-sm text-muted-foreground">{ar ? "أنشئ رمزاً مؤقتاً لجهاز محلي. لا تشارك الرمز إلا مع الجهاز المقصود." : "Issue a temporary code for a local device. Share it only with the intended device."}</p>
          <Input label={ar ? "معرّف الفرع" : "Branch ID"} inputMode="numeric" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
          <Input label={ar ? "معرّف السجل" : "Register ID"} inputMode="numeric" value={registerId} onChange={(event) => setRegisterId(event.target.value)} />
          <Button disabled={busy || !branchId || !registerId} onClick={() => void issuePairingCode()}>{ar ? "إنشاء رمز مؤقت" : "Create one-time code"}</Button>
          {issuedCode && <p className="break-all rounded border bg-muted p-3 font-mono text-sm" role="status">{issuedCode}</p>}
        </>}
      </CardContent>
    </Card>
  </main>;
}
