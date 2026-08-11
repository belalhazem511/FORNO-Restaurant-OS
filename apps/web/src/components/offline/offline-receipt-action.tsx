"use client";

import { useState } from "react";
import { PrinterIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";

export function OfflineReceiptAction({ documentId, label, className = "" }: { documentId: string; label: string; className?: string }) {
  const [popupBlocked, setPopupBlocked] = useState(false);
  const open = () => {
    setPopupBlocked(false);
    const popup = window.open(`/offline-print/${encodeURIComponent(documentId)}`, "_blank");
    if (!popup) setPopupBlocked(true);
    else popup.opener = null;
  };
  return <div className={`space-y-2 ${className}`}>
    <Button type="button" size="lg" className="min-h-14 w-full" onClick={open}><PrinterIcon />{label}</Button>
    {popupBlocked && <p role="alert" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">Pop-up blocked. Allow pop-ups for FORNO, then reopen this same receipt. / تم حظر النافذة. اسمح بالنوافذ المنبثقة ثم أعد فتح نفس الإيصال.</p>}
  </div>;
}
