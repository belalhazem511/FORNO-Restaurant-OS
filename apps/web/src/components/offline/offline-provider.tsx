"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { OfflineSyncEngine } from "@/lib/offline/queue";
import { offlineStore } from "@/lib/offline/storage";
import type { ConnectionState, OfflineBootstrapSnapshot, OfflineDocument, OfflineQueueEntry } from "@/lib/offline/types";

interface OfflineContextValue {
  connection: ConnectionState;
  serverReachable: boolean;
  userId: string | null;
  queue: OfflineQueueEntry[];
  pendingCount: number;
  financialPendingCount: number;
  needsReviewCount: number;
  snapshots: OfflineBootstrapSnapshot[];
  refresh(): Promise<void>;
  cacheSnapshot(snapshot: OfflineBootstrapSnapshot): Promise<void>;
  enqueue(entry: OfflineQueueEntry, documents?: OfflineDocument[]): Promise<void>;
  retry(id: string): Promise<void>;
  syncNow(): Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

async function checkServerHealth() {
  if (typeof navigator !== "undefined" && !navigator.onLine) return { ok: false, userId: null };
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/offline-health`, { cache: "no-store", credentials: "include" });
    if (!response.ok) return { ok: false, userId: null };
    const body = await response.json() as { ok: boolean; userId: string };
    return { ok: body.ok, userId: body.userId };
  } catch {
    return { ok: false, userId: null };
  }
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const trpc = useTRPC();
  const syncMutation = useMutation(trpc.offline.sync.mutationOptions());
  const [serverReachable, setServerReachable] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [queue, setQueue] = useState<OfflineQueueEntry[]>([]);
  const [snapshots, setSnapshots] = useState<OfflineBootstrapSnapshot[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const engineRef = useRef<OfflineSyncEngine | null>(null);
  const mutateAsyncRef = useRef(syncMutation.mutateAsync);
  mutateAsyncRef.current = syncMutation.mutateAsync;

  const refresh = useCallback(async () => {
    if (typeof indexedDB === "undefined") return;
    const store = offlineStore();
    const [nextQueue, nextSnapshots] = await Promise.all([store.listQueue(), store.listSnapshots()]);
    setQueue(nextQueue);
    setSnapshots(nextSnapshots);
    // A full offline reload cannot call the session endpoint. Recover only an
    // unambiguous, previously server-authorized user scope; if multiple users
    // have snapshots on this browser, online authentication is required.
    const snapshotUsers = [...new Set(nextSnapshots.map((snapshot) => snapshot.userId))];
    if (snapshotUsers.length === 1) setUserId((current) => current ?? snapshotUsers[0]);
  }, []);

  const health = useCallback(async () => {
    const status = await checkServerHealth();
    setServerReachable(status.ok);
    if (status.userId) setUserId(status.userId);
    return status.ok;
  }, []);

  const ensureEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new OfflineSyncEngine(
        offlineStore(),
        (payload) => mutateAsyncRef.current(payload),
        health,
      );
    }
    return engineRef.current;
  }, [health]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !userId || typeof indexedDB === "undefined") return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await ensureEngine().syncOnce(userId);
      await refresh();
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [ensureEngine, refresh, userId]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/sw.js`, { scope: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/` }).catch(() => undefined);
    ensureEngine().recoverInterrupted().then(refresh).catch(() => undefined);
    health().then((ok) => { if (ok) void syncNow(); });
    const handleOnline = () => { health().then((ok) => { if (ok) void syncNow(); }); };
    const handleOffline = () => setServerReachable(false);
    const handleRefresh = () => { void refresh(); };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("forno-offline-change", handleRefresh);
    const interval = window.setInterval(() => { health().then((ok) => { if (ok) void syncNow(); }); }, 15_000);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("forno-offline-change", handleRefresh);
      window.clearInterval(interval);
    };
  }, [ensureEngine, health, refresh, syncNow]);

  useEffect(() => {
    if (!serverReachable || typeof document === "undefined") return;
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "Offline receipt print shell cache";
    frame.src = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/offline-print/__warmup__`;
    frame.onload = () => window.setTimeout(() => frame.remove(), 500);
    document.body.appendChild(frame);
    return () => frame.remove();
  }, [serverReachable]);

  const pendingCount = queue.filter((entry) => entry.state !== "synced").length;
  const financialPendingCount = queue.filter((entry) => entry.financial && entry.state !== "synced").length;
  const needsReviewCount = queue.filter((entry) => entry.state === "needs_review").length;

  useEffect(() => {
    if (!financialPendingCount) return;
    const block = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", block);
    return () => window.removeEventListener("beforeunload", block);
  }, [financialPendingCount]);

  const connection: ConnectionState = needsReviewCount > 0
    ? "needs_review"
    : syncing
      ? "syncing"
      : queue.some((entry) => entry.state === "failed")
        ? "failed"
        : !serverReachable
          ? "offline"
          : queue.some((entry) => entry.state === "synced" && entry.acknowledgedAt)
            ? "synced"
            : "online";

  const value = useMemo<OfflineContextValue>(() => ({
    connection,
    serverReachable,
    userId,
    queue,
    pendingCount,
    financialPendingCount,
    needsReviewCount,
    snapshots,
    refresh,
    cacheSnapshot: async (snapshot) => { await offlineStore().putSnapshot(snapshot); await refresh(); },
    enqueue: async (entry, documents = []) => {
      const store = offlineStore();
      await store.putQueue(entry);
      for (const document of documents) await store.putDocument(document);
      window.dispatchEvent(new Event("forno-offline-change"));
      await refresh();
    },
    retry: async (id) => { await ensureEngine().manualRetry(id); await refresh(); await syncNow(); },
    syncNow,
  }), [connection, ensureEngine, financialPendingCount, needsReviewCount, pendingCount, queue, refresh, serverReachable, snapshots, syncNow, userId]);

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline() {
  const value = useContext(OfflineContext);
  if (!value) throw new Error("useOffline must be used within OfflineProvider");
  return value;
}
