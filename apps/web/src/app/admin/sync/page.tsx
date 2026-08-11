"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon, RefreshCwIcon, WifiIcon, WifiOffIcon } from "lucide-react";
import { Badge } from "@forno/ui/components/badge";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { useOffline } from "@/components/offline/offline-provider";
import { OfflineReceiptAction } from "@/components/offline/offline-receipt-action";
import { snapshotAgeState } from "@/lib/offline/queue";
import { useTRPC } from "@/lib/trpc/client";

const conflictText: Record<string, { en: string; ar: string }> = {
  menu_price_changed: { en: "Menu price changed; server repricing needs approval.", ar: "تغير سعر القائمة؛ إعادة تسعير الخادم تحتاج موافقة." },
  menu_item_unavailable: { en: "A menu item is no longer available.", ar: "عنصر في القائمة لم يعد متاحاً." },
  variant_unavailable: { en: "A selected variant is unavailable.", ar: "الخيار المحدد لم يعد متاحاً." },
  modifier_unavailable: { en: "A selected modifier is unavailable.", ar: "إضافة محددة لم تعد متاحة." },
  table_occupied: { en: "The selected table is already occupied.", ar: "الطاولة المحددة مشغولة بالفعل." },
  shift_closed: { en: "The cached shift was closed or changed.", ar: "تم إغلاق الوردية المحفوظة أو تغييرها." },
  register_unavailable: { en: "The cached register is unavailable.", ar: "جهاز الكاشير المحفوظ غير متاح." },
  permission_changed: { en: "The user's permission changed.", ar: "تغيرت صلاحية المستخدم." },
  user_branch_mismatch: { en: "User or branch no longer matches.", ar: "المستخدم أو الفرع لم يعد مطابقاً." },
  cash_insufficient: { en: "Cash received no longer covers the authoritative total.", ar: "النقد المستلم لم يعد يغطي الإجمالي الرسمي." },
  duplicate_already_accepted: { en: "The request was already accepted under a conflicting scope.", ar: "تم قبول الطلب سابقاً ضمن نطاق متعارض." },
};

export default function SyncCenterPage() {
  const locale = useLocale();
  const ar = locale.startsWith("ar");
  const offline = useOffline();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const snapshot = offline.snapshots.find((entry) => entry.userId === offline.userId) ?? null;
  const entries = useMemo(() => offline.queue.filter((entry) => !offline.userId || entry.userId === offline.userId), [offline.queue, offline.userId]);
  const centerQuery = useQuery({ ...trpc.offline.center.queryOptions({ branchId: snapshot?.branch.id ?? 0, limit: 100 }), enabled: Boolean(snapshot && offline.serverReachable) });
  const resolve = useMutation(trpc.offline.resolveReview.mutationOptions({ onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.offline.center.queryOptions({ branchId: snapshot?.branch.id ?? 0, limit: 100 }).queryKey }); } }));

  const approveAndRetry = async (entryId: string, recordId: number) => {
    const reason = reasonById[entryId]?.trim() ?? "";
    if (reason.length < 3) return;
    await resolve.mutateAsync({ recordId, reason });
    await offline.retry(entryId);
  };

  return <div className="mx-auto max-w-5xl space-y-4 pb-12">
    <Card><CardHeader><CardTitle className="flex items-center gap-2">{offline.serverReachable ? <WifiIcon className="text-emerald-600" /> : <WifiOffIcon className="text-amber-600" />}{ar ? "مركز المزامنة" : "Sync Center"}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-4"><Metric label={ar ? "الحالة" : "Connection"} value={offline.connection.replace("_", " ")} /><Metric label={ar ? "قيد الانتظار" : "Pending"} value={String(offline.pendingCount)} /><Metric label={ar ? "تحتاج مراجعة" : "Needs review"} value={String(offline.needsReviewCount)} /><Metric label={ar ? "عمر النسخة" : "Snapshot"} value={snapshot ? `${snapshotAgeState(snapshot)} · ${new Date(snapshot.createdAt).toLocaleString(locale)}` : (ar ? "لا توجد" : "None")} /></CardContent></Card>
    {snapshot && snapshotAgeState(snapshot) !== "fresh" && <div role="alert" className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-950"><AlertTriangleIcon className="me-2 inline h-5 w-5" />{snapshotAgeState(snapshot) === "expired" ? (ar ? "انتهت صلاحية النسخة ولا يمكن إنشاء طلبات دون اتصال." : "The snapshot expired; offline order creation is blocked.") : (ar ? "النسخة قديمة؛ تحقق من توفر القائمة عند عودة الاتصال." : "The snapshot is stale; verify menu availability when connectivity returns.")}</div>}
    <div className="flex justify-end"><Button className="min-h-11" onClick={() => void offline.syncNow()} disabled={!offline.serverReachable}><RefreshCwIcon />{ar ? "مزامنة الآن" : "Sync now"}</Button></div>
    {entries.length === 0 ? <Card><CardContent className="p-10 text-center text-muted-foreground"><CheckCircle2Icon className="mx-auto mb-3 h-10 w-10 text-emerald-600" />{ar ? "لا توجد عمليات محلية." : "No local operations."}</CardContent></Card> : entries.map((entry) => {
      const detail = entry.conflict?.code ? conflictText[entry.conflict.code]?.[ar ? "ar" : "en"] : null;
      return <Card key={entry.id} className={entry.state === "needs_review" ? "border-amber-500" : ""}><CardContent className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-xs text-muted-foreground">{entry.id}</p><h2 className="font-bold">{entry.kind === "cash_sale" ? (ar ? "بيع نقدي دون اتصال" : "Offline cash sale") : (ar ? "طلب دون اتصال" : "Offline order")}</h2></div><Badge variant={entry.state === "synced" ? "default" : entry.state === "needs_review" || entry.state === "failed" ? "destructive" : "secondary"}>{entry.state.replace("_", " ")}</Badge></div><p className="text-sm text-muted-foreground">{new Date(entry.createdAt).toLocaleString(locale)} · {ar ? "المحاولات" : "Attempts"}: {entry.attempts}</p>{entry.payload.offlineReceipt && <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-blue-950"><p className="font-semibold">{entry.state === "synced" ? (ar ? "تمت مزامنة النقد وربط الإيصال المحلي بالإيصال الرسمي" : "Cash synchronized — offline receipt mapped to the final receipt") : (ar ? "تم استلام النقد محلياً — بانتظار مزامنة الخادم" : "Cash received locally — pending server synchronization")}</p><p className="font-mono text-xs">{entry.payload.offlineReceipt.number}</p>{(entry.state !== "synced" || !entry.payload.offlineReceipt.previewedAt) && <OfflineReceiptAction className="mt-2" documentId={`offline-cash-receipt:${entry.id}`} label={ar ? "طباعة إيصال نقدي دون اتصال" : "Print Offline Cash Receipt"} />}</div>}{(detail || entry.lastError) && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{detail ?? entry.lastError}</p>}{entry.state === "synced" && entry.authoritativeOrderId && <div className="rounded-lg bg-emerald-50 p-3 text-emerald-900"><Link className="font-bold underline" href={`/admin/orders/${entry.authoritativeOrderId}`}>{ar ? `الطلب الرسمي #${entry.authoritativeOrderId}` : `Authoritative order #${entry.authoritativeOrderId}`}</Link>{entry.authoritativeReceiptJobId && <p className="text-sm">{ar ? `الإيصال النهائي الرسمي متاح — مهمة #${entry.authoritativeReceiptJobId}` : `Final authoritative receipt available — job #${entry.authoritativeReceiptJobId}`}</p>}</div>}{entry.state === "failed" && <Button variant="outline" className="min-h-11" onClick={() => void offline.retry(entry.id)}>{ar ? "إعادة المحاولة" : "Retry"}</Button>}{entry.state === "needs_review" && <div className="space-y-2 rounded-lg border p-3"><p className="text-sm font-semibold">{ar ? "يتطلب مديراً أو مالكاً/مسؤولاً وسبب تدقيق. لا يمكن حذف السجل المالي أو تغيير قيم الإيصال المطبوع." : "Requires Manager or Owner/Admin and an audit reason. The financial record and printed receipt values cannot be deleted or changed."}</p><Input label={ar ? "سبب المعالجة" : "Resolution reason"} value={reasonById[entry.id] ?? ""} onChange={(event) => setReasonById((current) => ({ ...current, [entry.id]: event.target.value }))} /><Button disabled={!entry.conflict?.recordId || (reasonById[entry.id]?.trim().length ?? 0) < 3 || resolve.isPending} onClick={() => entry.conflict?.recordId && void approveAndRetry(entry.id, entry.conflict.recordId)}>{ar ? "اعتماد وإعادة التحقق" : "Approve and revalidate"}</Button></div>}</CardContent></Card>;
    })}
    {centerQuery.data && <p className="text-xs text-muted-foreground">{ar ? "سجلات الخادم" : "Server records"}: {centerQuery.data.length}</p>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="break-words font-bold capitalize">{value}</p></div>;
}
