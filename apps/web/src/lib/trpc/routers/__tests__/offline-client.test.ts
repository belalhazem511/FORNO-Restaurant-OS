import { describe, expect, it } from "bun:test";
import { buildOfflineKots, buildOfflineSummary, kotContainsFinancialData } from "@/lib/offline/documents";
import { classifySyncError, createQueueEntry, OfflineSyncEngine, retryDelayMs, snapshotAgeState, type QueueLock } from "@/lib/offline/queue";
import { MemoryOfflineStore } from "@/lib/offline/storage";

const now = new Date("2026-08-11T12:00:00Z");
const payload = (id: string, kind: "order" | "cash_sale" = "order") => ({
  kind,
  clientOperationId: id,
  snapshotRevision: "revision-12345678",
  branchId: 1,
  registerId: 2,
  shiftId: 3,
  order: { clientRequestId: `request-${id}`, orderType: "takeaway" as const, diningTableId: null, deliveryAddress: null, deliveryContact: null, expectedTotal: 10_000, items: [{ menuItemId: 11, variantId: null, modifierOptionIds: [], quantity: 1, notes: null }] },
  cash: kind === "cash_sale" ? { checkoutIdempotencyKey: `checkout-${id}`, tenderedAmount: 12_000 } : null,
  kotAcknowledgements: [],
});

const snapshot = {
  version: 1,
  revision: "revision-12345678",
  createdAt: new Date("2026-08-11T11:00:00Z"),
  staleAt: new Date("2026-08-11T13:00:00Z"),
  expiresAt: new Date("2026-08-12T11:00:00Z"),
  userId: "user-1",
  role: "cashier",
  permissions: ["order:create"],
  branch: {
    id: 1, name_en: "FORNO", name_ar: "فورنو",
    diningAreas: [{ id: 8, tables: [{ id: 9, name_en: "T1", name_ar: "طاولة" }] }],
    kitchenStations: [
      { id: 1, code: "PIZZA", name_en: "Pizza", name_ar: "بيتزا" },
      { id: 2, code: "DONER", name_en: "Doner", name_ar: "دونر" },
      { id: 3, code: "CAFE", name_en: "Cafe", name_ar: "كافيه" },
    ],
    menuCategories: [{ menuItems: [
      { id: 11, kitchen_station_id: 1 },
      { id: 12, kitchen_station_id: 2 },
      { id: 13, kitchen_station_id: 3 },
    ] }],
  },
  register: { id: 2 }, shift: { id: 3 }, printing: { paperWidth: 80, language: "bilingual", receiptCopies: 1, kotCopies: 1 },
} as any;

describe("durable offline client data", () => {
  it("persists queue entries and bootstrap snapshots across engine reconstruction", async () => {
    const store = new MemoryOfflineStore();
    await store.putSnapshot(snapshot);
    await store.putQueue(createQueueEntry({ payload: payload("operation-persist-0001"), userId: "user-1", now }));
    const reloadedEngine = new OfflineSyncEngine(store, async (input) => ({ status: "accepted", duplicate: false, operationId: input.clientOperationId, orderId: 44, checkoutId: null, receiptJobId: null, conflict: null }), async () => true, async (task) => task(), () => now);
    expect((await store.getSnapshot("user-1", 1))?.revision).toBe(snapshot.revision);
    expect(await store.listQueue()).toHaveLength(1);
    await reloadedEngine.syncOnce("user-1");
    expect((await store.getQueue("operation-persist-0001"))?.authoritativeOrderId).toBe(44);
  });

  it("classifies fresh, stale, and expired snapshots", () => {
    expect(snapshotAgeState(snapshot, now)).toBe("fresh");
    expect(snapshotAgeState(snapshot, new Date("2026-08-11T14:00:00Z"))).toBe("stale");
    expect(snapshotAgeState(snapshot, new Date("2026-08-12T12:00:00Z"))).toBe("expired");
  });

  it("stores locally generated order and cash operations with dependency ordering", async () => {
    const store = new MemoryOfflineStore();
    const order = createQueueEntry({ payload: payload("operation-order-0001"), userId: "user-1", now });
    const cash = createQueueEntry({ payload: payload("operation-cash-0001", "cash_sale"), userId: "user-1", dependencies: [order.id], now });
    await store.putQueue(order);
    await store.putQueue(cash);
    const calls: string[] = [];
    const engine = new OfflineSyncEngine(store, async (input) => { calls.push(input.kind); return { status: "accepted", duplicate: false, operationId: input.clientOperationId, orderId: 7, checkoutId: input.kind === "cash_sale" ? 8 : null, receiptJobId: input.kind === "cash_sale" ? 9 : null, conflict: null }; }, async () => true, async (task) => task(), () => now);
    await engine.syncOnce("user-1");
    expect(calls).toEqual(["order", "cash_sale"]);
    expect((await store.getQueue(cash.id))?.authoritativeReceiptJobId).toBe(9);
  });

  it("recovers interrupted synchronization without discarding the operation", async () => {
    const store = new MemoryOfflineStore();
    await store.putQueue({ ...createQueueEntry({ payload: payload("operation-interrupt-01"), userId: "user-1", now }), state: "syncing" });
    const engine = new OfflineSyncEngine(store, async () => { throw new Error("unused"); }, async () => false);
    await engine.recoverInterrupted();
    expect((await store.getQueue("operation-interrupt-01"))?.state).toBe("pending");
    expect((await store.getQueue("operation-interrupt-01"))?.lastError).toContain("interrupted");
  });

  it("uses bounded exponential backoff with jitter and classifies retry errors", () => {
    expect(retryDelayMs(1, () => 0)).toBe(750);
    expect(retryDelayMs(2, () => 1)).toBe(2_500);
    expect(retryDelayMs(20, () => 1)).toBe(75_000);
    expect(classifySyncError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifySyncError({ data: { code: "FORBIDDEN", httpStatus: 403 } })).toBe("permission");
    expect(classifySyncError({ data: { code: "BAD_REQUEST", httpStatus: 400 } })).toBe("validation");
    expect(classifySyncError({ data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } })).toBe("temporary");
  });

  it("moves permission and validation failures to Needs Review, while retaining network failures", async () => {
    const store = new MemoryOfflineStore();
    for (const id of ["operation-permission-1", "operation-network-001"]) await store.putQueue(createQueueEntry({ payload: payload(id), userId: "user-1", now }));
    const engine = new OfflineSyncEngine(store, async (input) => { if (input.clientOperationId.includes("permission")) throw Object.assign(new Error("Forbidden"), { data: { code: "FORBIDDEN", httpStatus: 403 } }); throw new TypeError("Failed to fetch"); }, async () => true, async (task) => task(), () => now, () => 0);
    await engine.syncOnce("user-1");
    expect((await store.getQueue("operation-permission-1"))?.state).toBe("needs_review");
    expect((await store.getQueue("operation-network-001"))?.state).toBe("failed");
    expect((await store.getQueue("operation-network-001"))?.nextAttemptAt).not.toBeNull();
  });

  it("permits only one synchronization leader and isolates users", async () => {
    const store = new MemoryOfflineStore();
    await store.putQueue(createQueueEntry({ payload: payload("operation-user-one"), userId: "user-1", now }));
    await store.putQueue(createQueueEntry({ payload: payload("operation-user-two"), userId: "user-2", now }));
    let held = false;
    const lock: QueueLock = async (task) => { if (held) return null; held = true; try { return await task(); } finally { held = false; } };
    const calls: string[] = [];
    const engine = new OfflineSyncEngine(store, async (input) => { calls.push(input.clientOperationId); return { status: "accepted", duplicate: false, operationId: input.clientOperationId, orderId: 1, checkoutId: null, receiptJobId: null, conflict: null }; }, async () => true, lock, () => now);
    await Promise.all([engine.syncOnce("user-1"), engine.syncOnce("user-1")]);
    expect(calls).toEqual(["operation-user-one"]);
    expect((await store.getQueue("operation-user-two"))?.state).toBe("pending");
  });
});

describe("offline documents and PWA policy", () => {
  it("routes deterministic Pizza, Doner, and Cafe KOTs and contains no financial fields", () => {
    const cart = [11, 12, 13].map((menuItemId, index) => ({ key: String(index), menuItemId, productId: null, nameEn: `Item ${index}`, nameAr: `صنف ${index}`, variantId: null, variantNameEn: null, variantNameAr: null, basePrice: 10_000, modifiers: [], quantity: 1, notes: index === 0 ? "No onions" : "" }));
    const kots = buildOfflineKots({ operationId: "operation-doc-0001", orderReference: "OFF-1", orderType: "takeaway", tableId: null, cart, snapshot, createdAt: now });
    expect(kots.map((kot) => kot.station.code)).toEqual(["PIZZA", "DONER", "CAFE"]);
    expect(new Set(kots.map((kot) => kot.id)).size).toBe(3);
    expect(kots.every((kot) => !kotContainsFinancialData(kot))).toBe(true);
    expect(JSON.stringify(kots)).not.toMatch(/price|total|payment|cash|change|receipt/i);
  });

  it("labels the only offline customer document as an unpaid provisional summary with estimated change", () => {
    const summary = buildOfflineSummary({ operationId: "operation-summary-1", orderReference: "OFF-2", orderType: "takeaway", cart: [], provisionalTotal: 10_000, cashReceived: 12_000, createdAt: now });
    expect(summary.kind).toBe("order_summary");
    expect(summary.estimatedChange).toBe(2_000);
    expect(summary).not.toHaveProperty("receiptNumber");
    expect(summary).not.toHaveProperty("paid");
  });

  it("service worker caches only application shell/static assets and bypasses authenticated APIs", async () => {
    const source = await Bun.file(`${process.cwd()}/public/sw.js`).text();
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain("fetch(request)");
    expect(source).not.toMatch(/cache\.put\([^\n]*api/i);
    expect(source).not.toContain('SHELL_URLS = ["/admin/pos"');
    expect(source).toContain('url.pathname === "/admin/pos"');
  });

  it("POS source explicitly blocks unsupported offline actions and final receipts", async () => {
    const source = await Bun.file(`${process.cwd()}/src/app/admin/pos/page.tsx`).text();
    for (const blocked of ["Card", "InstaPay", "split", "discounts", "cancellation", "refund", "shift changes", "reprints"]) expect(source).toContain(blocked);
    expect(source).toContain("not a final receipt");
    expect(source).toContain("cash_sale");
    expect(source).toContain("OfflineKotDialog");
    expect(source).toContain("NO PRICES — KITCHEN USE ONLY");
  });

  it("recovers a unique cached user identity for a full offline reload", async () => {
    const source = await Bun.file(`${process.cwd()}/src/components/offline/offline-provider.tsx`).text();
    expect(source).toContain("snapshotUsers.length === 1");
    expect(source).toContain("setUserId((current) => current ?? snapshotUsers[0])");
  });
});
