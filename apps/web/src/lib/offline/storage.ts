import {
  OFFLINE_DB_VERSION,
  type OfflineBootstrapSnapshot,
  type OfflineDocument,
  type OfflineQueueEntry,
} from "./types";

const DB_NAME = "forno-offline-pos";
const SNAPSHOTS = "snapshots";
const QUEUE = "queue";
const DOCUMENTS = "documents";

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export interface OfflineStore {
  putSnapshot(snapshot: OfflineBootstrapSnapshot): Promise<void>;
  getSnapshot(userId: string, branchId: number): Promise<OfflineBootstrapSnapshot | null>;
  listSnapshots(): Promise<OfflineBootstrapSnapshot[]>;
  putQueue(entry: OfflineQueueEntry): Promise<void>;
  getQueue(id: string): Promise<OfflineQueueEntry | null>;
  listQueue(): Promise<OfflineQueueEntry[]>;
  putDocument(document: OfflineDocument): Promise<void>;
  getDocument(id: string): Promise<OfflineDocument | null>;
}

export class IndexedDbOfflineStore implements OfflineStore {
  private database: Promise<IDBDatabase> | null = null;

  private open() {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, OFFLINE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SNAPSHOTS)) database.createObjectStore(SNAPSHOTS, { keyPath: "storageKey" });
        if (!database.objectStoreNames.contains(QUEUE)) {
          const queue = database.createObjectStore(QUEUE, { keyPath: "id" });
          queue.createIndex("state", "state");
          queue.createIndex("createdAt", "createdAt");
          queue.createIndex("userBranch", ["userId", "branchId"]);
        }
        if (!database.objectStoreNames.contains(DOCUMENTS)) database.createObjectStore(DOCUMENTS, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open FORNO offline storage"));
      request.onblocked = () => reject(new Error("FORNO offline storage upgrade is blocked by another tab"));
    });
    return this.database;
  }

  async putSnapshot(snapshot: OfflineBootstrapSnapshot) {
    const database = await this.open();
    const transaction = database.transaction(SNAPSHOTS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(SNAPSHOTS).put({ ...snapshot, storageKey: `${snapshot.userId}:${snapshot.branch.id}` });
    await done;
  }

  async getSnapshot(userId: string, branchId: number) {
    const database = await this.open();
    const transaction = database.transaction(SNAPSHOTS, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult<any>(transaction.objectStore(SNAPSHOTS).get(`${userId}:${branchId}`));
    await done;
    if (!value) return null;
    const { storageKey: _storageKey, ...snapshot } = value;
    return snapshot as OfflineBootstrapSnapshot;
  }

  async listSnapshots() {
    const database = await this.open();
    const transaction = database.transaction(SNAPSHOTS, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult<any[]>(transaction.objectStore(SNAPSHOTS).getAll());
    await done;
    return values.map(({ storageKey: _storageKey, ...snapshot }) => snapshot as OfflineBootstrapSnapshot);
  }

  async putQueue(entry: OfflineQueueEntry) {
    const database = await this.open();
    const transaction = database.transaction(QUEUE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(QUEUE).put(entry);
    await done;
  }

  async getQueue(id: string) {
    const database = await this.open();
    const transaction = database.transaction(QUEUE, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult<OfflineQueueEntry | undefined>(transaction.objectStore(QUEUE).get(id));
    await done;
    return value ?? null;
  }

  async listQueue() {
    const database = await this.open();
    const transaction = database.transaction(QUEUE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult<OfflineQueueEntry[]>(transaction.objectStore(QUEUE).getAll());
    await done;
    return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async putDocument(document: OfflineDocument) {
    const database = await this.open();
    const transaction = database.transaction(DOCUMENTS, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(DOCUMENTS).put(document);
    await done;
  }

  async getDocument(id: string) {
    const database = await this.open();
    const transaction = database.transaction(DOCUMENTS, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult<OfflineDocument | undefined>(transaction.objectStore(DOCUMENTS).get(id));
    await done;
    return value ?? null;
  }
}

export class MemoryOfflineStore implements OfflineStore {
  readonly snapshots = new Map<string, OfflineBootstrapSnapshot>();
  readonly queue = new Map<string, OfflineQueueEntry>();
  readonly documents = new Map<string, OfflineDocument>();

  async putSnapshot(snapshot: OfflineBootstrapSnapshot) { this.snapshots.set(`${snapshot.userId}:${snapshot.branch.id}`, structuredClone(snapshot)); }
  async getSnapshot(userId: string, branchId: number) { return structuredClone(this.snapshots.get(`${userId}:${branchId}`) ?? null); }
  async listSnapshots() { return [...this.snapshots.values()].map((value) => structuredClone(value)); }
  async putQueue(entry: OfflineQueueEntry) { this.queue.set(entry.id, structuredClone(entry)); }
  async getQueue(id: string) { return structuredClone(this.queue.get(id) ?? null); }
  async listQueue() { return [...this.queue.values()].map((value) => structuredClone(value)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async putDocument(document: OfflineDocument) { this.documents.set(document.id, structuredClone(document)); }
  async getDocument(id: string) { return structuredClone(this.documents.get(id) ?? null); }
}

let sharedStore: IndexedDbOfflineStore | null = null;
export function offlineStore() {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable in this browser");
  sharedStore ??= new IndexedDbOfflineStore();
  return sharedStore;
}
