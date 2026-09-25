import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { desktopPaths } from "./runtime-paths.js";
import { createLocalBackup, restoreLocalBackup } from "./local-backups.js";
import { CURRENT_LOCAL_SCHEMA_VERSION, readLocalSchemaVersion, writeLocalSchemaVersion } from "./local-schema-version.js";

app.setName("FORNO Restaurant OS");
if (process.env.NODE_ENV === "test" && process.env.FORNO_DESKTOP_DATA_DIR) {
  app.setPath("userData", join(process.env.FORNO_DESKTOP_DATA_DIR, "electron-profile"));
}
const SERVER_PORT = 43127;
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const localPaths = desktopPaths(app.getPath("appData"));
const hasSingleInstance = app.requestSingleInstanceLock();
let localServer: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let runtimeState: "setup_required" | "upgrade_required" | "starting" | "ready" | "failed" = "setup_required";
let shutdownStarted = false;
let syncTimer: NodeJS.Timeout | undefined;
let syncRunning = false;
let syncFailureCount = 0;
let synchronizationState: "local_only" | "offline" | "pending" | "syncing" | "synced" | "failed" | "needs_review" = "local_only";
const setupToken = randomBytes(32).toString("hex");
const schemaVersionPath = join(localPaths.sync, "schema-version.json");

if (!hasSingleInstance) app.quit();

function isDatabasePresent() {
  return stat(join(localPaths.database, "PG_VERSION")).then(() => true, () => false);
}

function packagedWebRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, "app", "apps", "web")
    : resolve(__dirname, "../../web");
}

async function readOrCreateAuthSecret() {
  const secretPath = join(localPaths.sync, "auth-secret.bin");
  try {
    const encrypted = await readFile(secretPath);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows protected storage is unavailable.");
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows protected storage is unavailable.");
  await mkdir(localPaths.sync, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  await writeFile(secretPath, safeStorage.encryptString(secret), { flag: "wx" });
  return secret;
}

async function readOrCreateDeviceId() {
  const path = join(localPaths.sync, "device-id");
  try {
    const deviceId = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw new Error("The local device identity is invalid and was preserved.");
    return deviceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(localPaths.sync, { recursive: true });
  const deviceId = randomUUID();
  try {
    await writeFile(path, deviceId, { flag: "wx", mode: 0o600 });
    return deviceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readOrCreateDeviceId();
    throw error;
  }
}

async function readOrCreateDeviceCredential() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows protected credential storage is unavailable.");
  const path = join(localPaths.sync, "device-credential.bin");
  try {
    return safeStorage.decryptString(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential = randomBytes(32).toString("base64url");
  await writeFile(path, safeStorage.encryptString(credential), { flag: "wx", mode: 0o600 });
  return credential;
}

async function synchronizeDevice() {
  if (syncRunning || runtimeState !== "ready") return;
  syncRunning = true;
  synchronizationState = "syncing";
  try {
    const deviceId = await readOrCreateDeviceId();
    const localHeaders = { "x-forno-desktop-setup": setupToken };
    const queueResponse = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/queue`, { headers: localHeaders, signal: AbortSignal.timeout(10_000) });
    if (!queueResponse.ok) { synchronizationState = "offline"; return; }
    const queue = await queueResponse.json() as { paired: boolean; cursor: number; commands: unknown[] };
    if (!queue.paired) { synchronizationState = "local_only"; return; }
    const centralUrl = (await readFile(join(localPaths.sync, "central-url"), "utf8")).trim().replace(/\/$/, "");
    const credential = await readOrCreateDeviceCredential();
    if (queue.commands.length) {
      const upload = await fetch(`${centralUrl}/api/sync/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId },
        body: JSON.stringify({ commands: queue.commands }),
        signal: AbortSignal.timeout(30_000),
      });
      if (upload.ok) {
        const response = await upload.json() as { results?: Array<{ operationId: string; status: string }> };
        const resultsByOperation = new Map((response.results ?? []).map((result) => [result.operationId, result]));
        for (const raw of queue.commands as Array<{ operationId: string; domain: string; action: string; payload: Record<string, unknown> }>) {
          const result = resultsByOperation.get(raw.operationId);
          const values = raw.payload.values as { imageKey?: unknown } | undefined;
          const productGlobalId = raw.payload.productGlobalId;
          if (!result || (result.status !== "accepted" && result.status !== "already_applied") || raw.domain !== "products" || typeof values?.imageKey !== "string" || typeof productGlobalId !== "string") continue;
          const key = values.imageKey;
          const localImageUrl = `${SERVER_ORIGIN}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
          const image = await fetch(localImageUrl, { signal: AbortSignal.timeout(15_000) });
          if (!image.ok) throw new Error("A locally referenced product image could not be read for synchronization.");
          const bytes = Buffer.from(await image.arrayBuffer());
          const contentHash = createHash("sha256").update(bytes).digest("hex");
          const form = new FormData();
          form.set("productGlobalId", productGlobalId);
          form.set("key", key);
          form.set("file", new Blob([bytes], { type: image.headers.get("content-type") ?? "application/octet-stream" }), basename(key));
          const mediaUpload = await fetch(`${centralUrl}/api/sync/media`, {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId, "x-forno-content-sha256": contentHash },
            body: form,
            signal: AbortSignal.timeout(30_000),
          });
          if (!mediaUpload.ok) throw new Error("Central product media upload failed.");
        }
        const acknowledged = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/queue`, { method: "POST", headers: { ...localHeaders, "content-type": "application/json" }, body: JSON.stringify({ results: response.results ?? [] }), signal: AbortSignal.timeout(10_000) });
        if (!acknowledged.ok) throw new Error("Local command acknowledgements could not be saved.");
      } else throw new Error("Central command upload failed.");
    }
    let cursor = queue.cursor;
    let hasMore = true;
    while (hasMore) {
      const pull = await fetch(`${centralUrl}/api/sync/commands?cursor=${encodeURIComponent(cursor)}`, {
        headers: { authorization: `Bearer ${credential}`, "x-forno-device-id": deviceId },
        signal: AbortSignal.timeout(30_000),
      });
      if (!pull.ok) throw new Error("Central change download failed.");
      const page = await pull.json() as { changes: unknown[]; nextCursor: number; hasMore: boolean };
      if (!page.changes.length && page.hasMore) throw new Error("Central change pagination did not advance.");
      for (const raw of page.changes as Array<{ domain?: string; entityType?: string; snapshot?: { imageKey?: unknown } | null }>) {
        const key = raw.domain === "products" && raw.entityType === "product" && typeof raw.snapshot?.imageKey === "string" ? raw.snapshot.imageKey : null;
        if (!key) continue;
        const mediaUrl = `${centralUrl}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
        const image = await fetch(mediaUrl, { signal: AbortSignal.timeout(15_000) });
        if (image.status === 404) continue;
        if (!image.ok) throw new Error("Product media download failed; the change cursor was not advanced.");
        const bytes = Buffer.from(await image.arrayBuffer());
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        const form = new FormData();
        form.set("key", key);
        form.set("file", new Blob([bytes], { type: image.headers.get("content-type") ?? "application/octet-stream" }), basename(key));
        const cached = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/media`, {
          method: "POST",
          headers: { ...localHeaders, "x-forno-content-sha256": contentHash },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
        if (!cached.ok) throw new Error("Product media could not be cached locally; the change cursor was not advanced.");
      }
      const applied = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/apply`, { method: "POST", headers: { ...localHeaders, "content-type": "application/json" }, body: JSON.stringify(page), signal: AbortSignal.timeout(30_000) });
      if (!applied.ok) throw new Error("Pulled changes could not be applied locally.");
      if (page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor)) throw new Error("Central change cursor did not advance.");
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
    const latest = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/queue`, { headers: localHeaders, signal: AbortSignal.timeout(10_000) });
    if (!latest.ok) throw new Error("Local synchronization state could not be read.");
    const finalQueue = await latest.json() as { paired: boolean; pendingCount: number; needsReviewCount: number; rejectedCount: number };
    synchronizationState = finalQueue.needsReviewCount ? "needs_review" : finalQueue.rejectedCount ? "failed" : finalQueue.pendingCount ? "pending" : "synced";
    syncFailureCount = 0;
  } catch {
    synchronizationState = "offline";
    syncFailureCount = Math.min(syncFailureCount + 1, 5);
  } finally {
    syncRunning = false;
  }
}

async function getSynchronizationStatus() {
  if (syncRunning) return { state: "syncing" as const };
  try {
    const response = await fetch(`${SERVER_ORIGIN}/api/desktop/sync/queue`, { headers: { "x-forno-desktop-setup": setupToken }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: synchronizationState };
    const queue = await response.json() as { paired: boolean; pendingCount: number; needsReviewCount: number; rejectedCount: number };
    const state = !queue.paired ? "local_only" : queue.needsReviewCount ? "needs_review" : queue.rejectedCount ? "failed" : queue.pendingCount ? "pending" : synchronizationState === "offline" ? "offline" : "synced";
    synchronizationState = state;
    return { state, pendingCount: queue.pendingCount, needsReviewCount: queue.needsReviewCount };
  } catch {
    return { state: synchronizationState === "local_only" ? "local_only" as const : "offline" as const };
  }
}

function scheduleSynchronization(delayMs = 30_000) {
  if (syncTimer) clearTimeout(syncTimer);
  const backoff = Math.min(15 * 60_000, delayMs * (2 ** syncFailureCount));
  const delayWithJitter = backoff + Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 5)));
  syncTimer = setTimeout(() => {
    void synchronizeDevice().finally(() => scheduleSynchronization());
  }, delayWithJitter);
}

async function childEnvironment(secret: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    NODE_ENV: "production",
    FORNO_DESKTOP_MODE: "1",
    FORNO_DESKTOP_DEVICE_ID: await readOrCreateDeviceId(),
    FORNO_DATABASE_ROLE: "runtime",
    FORNO_DATABASE_DIR: localPaths.database,
    FORNO_MEDIA_DIR: join(localPaths.root, "media"),
    BASE_URL: SERVER_ORIGIN,
    BETTER_AUTH_SECRET: secret,
    FORNO_DESKTOP_SETUP_TOKEN: setupToken,
    PORT: String(SERVER_PORT),
    HOSTNAME: "127.0.0.1",
  };
}

function runElectronNode(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => { void appendFile(join(localPaths.logs, "setup.log"), chunk).catch(() => undefined); });
    child.stderr?.on("data", (chunk: Buffer) => { void appendFile(join(localPaths.logs, "setup.log"), chunk).catch(() => undefined); });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Local setup command exited with code ${code ?? "unknown"}.`)));
  });
}

async function applyInitialSchema() {
  if (await isDatabasePresent()) return;
  try {
    await stat(localPaths.database);
    throw new Error("A database directory already exists but is not initialized. It was preserved; restore or inspect it before retrying.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const webRoot = packagedWebRoot();
  const env = await childEnvironment(await readOrCreateAuthSecret());
  await mkdir(localPaths.root, { recursive: true });
  await mkdir(dirname(localPaths.database), { recursive: true });
  await mkdir(localPaths.logs, { recursive: true });
  await runElectronNode(join(webRoot, "node_modules", "drizzle-kit", "bin.cjs"), ["push"], webRoot, env);
  if (!(await isDatabasePresent())) throw new Error("Schema setup completed without creating a verifiable PGLite database.");
  await writeLocalSchemaVersion(schemaVersionPath);
}

async function startLocalServer() {
  if (localServer && localServer.exitCode === null) return;
  runtimeState = "starting";
  const webRoot = packagedWebRoot();
  const env = await childEnvironment(await readOrCreateAuthSecret());
  await Promise.all([
    mkdir(join(localPaths.root, "data"), { recursive: true }),
    mkdir(join(localPaths.root, "media"), { recursive: true }),
    mkdir(localPaths.documents, { recursive: true }),
    mkdir(localPaths.backups, { recursive: true }),
  ]);
  await mkdir(localPaths.logs, { recursive: true });
  localServer = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(SERVER_PORT)], {
    cwd: webRoot,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  localServer.stdout?.on("data", (chunk: Buffer) => { void appendFile(join(localPaths.logs, "application.log"), chunk).catch(() => undefined); });
  localServer.stderr?.on("data", (chunk: Buffer) => { void appendFile(join(localPaths.logs, "application.log"), chunk).catch(() => undefined); });
  localServer.once("exit", () => {
    localServer = null;
    if (runtimeState !== "setup_required") runtimeState = "failed";
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (localServer.exitCode !== null) throw new Error("The local application server stopped during startup.");
    try {
      const response = await fetch(`${SERVER_ORIGIN}/login`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { runtimeState = "ready"; scheduleSynchronization(1_000); return; }
    } catch { /* Local startup is still in progress. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  runtimeState = "failed";
  throw new Error("The local application server did not become ready.");
}

function assertStoragePage(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || new URL(frame.url).origin !== SERVER_ORIGIN || new URL(frame.url).pathname !== "/admin/storage") {
    throw new Error("Local storage actions are available only from the protected storage page.");
  }
}

async function pauseLocalServer() {
  const child = localServer;
  if (!child || child.exitCode !== null) throw new Error("The local application server is not running.");
  const response = await fetch(`${SERVER_ORIGIN}/api/desktop/shutdown`, {
    method: "POST",
    headers: { "x-forno-desktop-setup": setupToken },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The database could not be safely paused.");
  child.kill();
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("The local server did not stop after database shutdown.")), 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
  });
  localServer = null;
}

async function withPausedDatabase<T>(operation: () => Promise<T>, allowUpgradeGate = false) {
  await pauseLocalServer();
  try {
    return await operation();
  } finally {
    if (allowUpgradeGate) {
      const version = await readLocalSchemaVersion(schemaVersionPath);
      if (version === null || version < CURRENT_LOCAL_SCHEMA_VERSION) {
        runtimeState = "upgrade_required";
        await mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(upgradeHtml())}`);
      } else if (version > CURRENT_LOCAL_SCHEMA_VERSION) {
        throw new Error("The restored database belongs to a newer FORNO version. Existing recovery data was preserved.");
      } else {
        await startLocalServer();
        await mainWindow?.loadURL(`${SERVER_ORIGIN}/admin/storage`);
      }
    } else {
      await startLocalServer();
      await mainWindow?.loadURL(`${SERVER_ORIGIN}/admin/storage`);
    }
  }
}

async function completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }) {
  const response = await fetch(`${SERVER_ORIGIN}/api/desktop/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forno-desktop-setup": setupToken },
    body: JSON.stringify({ ...input, deviceId: await readOrCreateDeviceId() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Local Owner setup failed.");
  await mainWindow?.loadURL(`${SERVER_ORIGIN}/login`);
}

function setupHtml() {
  return setupHtmlDocument().replace("<title>", "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\"><title>");
}

function setupHtmlDocument() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FORNO offline setup</title><body style="font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem"><h1>Set up this FORNO device</h1><p>This wizard creates a new local database on this Windows device. It does not connect to the internet or add demo users.</p><p>Existing data is never overwritten. If an uninitialized database directory exists, setup stops and preserves it.</p><label>Language <select id="locale"><option value="en">English</option><option value="ar">العربية</option></select></label><p><label><input id="confirm" type="checkbox"> I confirm this is a new device-local FORNO data store.</label></p><p><button id="setup" disabled>Create local data store</button></p><output id="result" aria-live="polite"></output><script>const c=document.querySelector('#confirm'),b=document.querySelector('#setup'),o=document.querySelector('#result');c.onchange=()=>b.disabled=!c.checked;b.onclick=async()=>{b.disabled=true;o.textContent='Preparing local schema…';try{const r=await window.fornoDesktop.initializeLocalData({confirmed:true,locale:document.querySelector('#locale').value});if(!r.ready)throw new Error(r.error||'Local setup failed.');location.href='${SERVER_ORIGIN}/setup?locale='+document.querySelector('#locale').value;}catch(e){o.textContent=e.message||'Setup failed. Existing files were preserved.';b.disabled=false;}}</script></body></html>`;
}

function startupErrorHtml(message: string) {
  const escaped = message.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>FORNO local data needs attention</title><body style="font:16px system-ui;max-width:46rem;margin:4rem auto;padding:0 1rem"><h1>Local data was preserved</h1><p>FORNO could not start its local application. It did not delete, reset, or replace the database.</p><pre style="white-space:pre-wrap">${escaped}</pre><p>Logs: ${localPaths.logs}</p><p>Restore only from a verified backup or contact support. Do not remove the local data directory.</p></body></html>`;
}

function upgradeHtml() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>FORNO database upgrade</title><body style="font:16px system-ui;max-width:46rem;margin:4rem auto;padding:0 1rem"><h1>Database upgrade requires confirmation</h1><p>This device already contains local data. FORNO will first create and verify a complete backup, then apply the application schema update.</p><p>If an update fails, the original database and backup are preserved. FORNO will not reset this database.</p><p><label><input id="confirm" type="checkbox"> I confirm that FORNO may back up and update this local database.</label></p><button id="upgrade" disabled>Back up and upgrade</button><p id="result" role="status" aria-live="polite"></p><script>const c=document.querySelector('#confirm'),b=document.querySelector('#upgrade'),o=document.querySelector('#result');c.onchange=()=>b.disabled=!c.checked;b.onclick=async()=>{b.disabled=true;o.textContent='Creating and verifying backup…';try{const r=await window.fornoDesktop.upgradeLocalDatabase(true);if(!r.ready)throw new Error(r.error||'Upgrade did not complete.');location.href='/login';}catch(e){o.textContent=e.message||'Upgrade failed. Existing data was preserved.';b.disabled=false;}}</script></body></html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("focus", () => scheduleSynchronization(1_000));
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: [`${SERVER_ORIGIN}/*`] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'"],
      },
    });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("data:text/html;charset=utf-8,") || new URL(url).origin === SERVER_ORIGIN) return;
    event.preventDefault();
  });
  void (async () => {
    if (await isDatabasePresent()) {
      const version = await readLocalSchemaVersion(schemaVersionPath);
      if (version === null || version < CURRENT_LOCAL_SCHEMA_VERSION) {
        runtimeState = "upgrade_required";
        await mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(upgradeHtml())}`);
        return;
      }
      if (version > CURRENT_LOCAL_SCHEMA_VERSION) throw new Error("This local database was opened by a newer FORNO version. It was preserved; install a compatible application version.");
      await startLocalServer();
      const setupResponse = await fetch(`${SERVER_ORIGIN}/api/desktop/setup`, { headers: { "x-forno-desktop-setup": setupToken } });
      const setup = await setupResponse.json() as { complete: boolean };
      await mainWindow?.loadURL(`${SERVER_ORIGIN}/${setup.complete ? "login" : "setup"}`);
    } else {
      await mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(setupHtml())}`);
    }
  })().catch(async (error) => {
    runtimeState = "failed";
    await mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupErrorHtml(error instanceof Error ? error.message : "Local startup failed."))}`);
  });
}

ipcMain.handle("desktop:runtime-status", () => ({ state: runtimeState, version: app.getVersion() }));
ipcMain.handle("desktop:device-status", async () => ({
  deviceId: await readOrCreateDeviceId(),
  paired: await stat(join(localPaths.sync, "remote-organization-id")).then(() => true, () => false),
  remoteOrganizationId: await readFile(join(localPaths.sync, "remote-organization-id"), "utf8").catch(() => null),
}));

ipcMain.handle("desktop:sync-status", async (event) => {
  assertStoragePage(event);
  return getSynchronizationStatus();
});

ipcMain.handle("desktop:sync-now", async (event) => {
  assertStoragePage(event);
  await synchronizeDevice();
  return getSynchronizationStatus();
});
ipcMain.handle("desktop:pair-device", async (event, input: { centralUrl: string; pairingCode: string; deviceName: string }) => {
  assertStoragePage(event);
  const central = new URL(input.centralUrl);
  const localHttp = central.protocol === "http:" && ["localhost", "127.0.0.1"].includes(central.hostname);
  if ((central.protocol !== "https:" && !localHttp) || central.username || central.password || central.search || central.hash || input.pairingCode.trim().length < 16 || input.pairingCode.trim().length > 100 || input.deviceName.trim().length < 2 || input.deviceName.trim().length > 120) {
    throw new Error("Enter a secure central server URL, valid one-time pairing code, and device name.");
  }
  const deviceId = await readOrCreateDeviceId();
  const credential = await readOrCreateDeviceCredential();
  const centralBasePath = central.pathname.replace(/\/$/, "");
  const response = await fetch(new URL(`${centralBasePath}/api/sync/pair`, central.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId, credential, pairingCode: input.pairingCode.trim(), deviceName: input.deviceName.trim() }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => null) as { organizationId?: string; globalBranchId?: string; globalRegisterId?: string; globalActorId?: string; error?: string } | null;
  if (!response.ok || !result?.organizationId || !result.globalBranchId || !result.globalRegisterId || !result.globalActorId) throw new Error(result?.error ?? "Device pairing failed; local operations remain available.");
  const localResult = await fetch(`${SERVER_ORIGIN}/api/desktop/pairing-complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forno-desktop-setup": setupToken },
    body: JSON.stringify({ deviceId, organizationId: result.organizationId, globalBranchId: result.globalBranchId, globalRegisterId: result.globalRegisterId, globalActorId: result.globalActorId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!localResult.ok) throw new Error((await localResult.json().catch(() => null))?.error ?? "Central pairing succeeded, but local identity reconciliation must be retried.");
  await writeFile(join(localPaths.sync, "remote-organization-id"), result.organizationId, { mode: 0o600 });
  await writeFile(join(localPaths.sync, "central-url"), `${central.origin}${centralBasePath}`.replace(/\/$/, ""), { mode: 0o600 });
  void synchronizeDevice();
  return { paired: true as const, deviceId, organizationId: result.organizationId };
});
ipcMain.handle("desktop:create-backup", async (event) => {
  assertStoragePage(event);
  return withPausedDatabase(() => createLocalBackup(localPaths.root));
});
ipcMain.handle("desktop:restore-backup", async (event, confirmed: boolean) => {
  assertStoragePage(event);
  if (confirmed !== true) throw new Error("Explicit restore confirmation is required.");
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: "Select a FORNO backup",
    defaultPath: localPaths.backups,
    properties: ["openFile"],
    filters: [{ name: "FORNO backup", extensions: ["tar"] }],
  });
  if (selection.canceled || selection.filePaths.length !== 1) return { restored: false as const };
  const result = await withPausedDatabase(() => restoreLocalBackup(localPaths.root, selection.filePaths[0]!), true);
  return { restored: true as const, recoveryPath: result.recoveryPath };
});
ipcMain.handle("desktop:initialize-local-data", async (_event, input: { confirmed: true; locale: "en" | "ar" }) => {
  if (input?.confirmed !== true || !["en", "ar"].includes(input.locale)) throw new Error("Explicit local setup confirmation is required.");
  try {
    if (!(await isDatabasePresent())) await applyInitialSchema();
    await startLocalServer();
    await mainWindow?.loadURL(`${SERVER_ORIGIN}/setup?locale=${input.locale}`);
    return { ready: true as const };
  } catch (error) {
    runtimeState = "failed";
    return { ready: false as const, error: error instanceof Error ? error.message : "Local setup failed." };
  }
});

ipcMain.handle("desktop:upgrade-local-database", async (_event, confirmed: boolean) => {
  if (confirmed !== true || runtimeState !== "upgrade_required") throw new Error("Explicit database upgrade confirmation is required.");
  try {
    const backup = await createLocalBackup(localPaths.root);
    const webRoot = packagedWebRoot();
    const env = await childEnvironment(await readOrCreateAuthSecret());
    await runElectronNode(join(webRoot, "node_modules", "drizzle-kit", "bin.cjs"), ["push"], webRoot, env);
    await writeLocalSchemaVersion(schemaVersionPath);
    await startLocalServer();
    const setupResponse = await fetch(`${SERVER_ORIGIN}/api/desktop/setup`, { headers: { "x-forno-desktop-setup": setupToken } });
    const setup = await setupResponse.json() as { complete: boolean };
    await mainWindow?.loadURL(`${SERVER_ORIGIN}/${setup.complete ? "login" : "setup"}`);
    return { ready: true as const, backup: backup.filename };
  } catch (error) {
    return { ready: false as const, error: error instanceof Error ? error.message : "Upgrade failed; local data was preserved." };
  }
});

ipcMain.handle("desktop:complete-owner-setup", async (_event, input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }) => {
  if (!input || typeof input !== "object" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.password.length < 12 || input.password.length > 128 || input.name.trim().length < 2 || input.branchName.trim().length < 2 || input.registerName.trim().length < 2 || !["en", "ar"].includes(input.locale)) {
    throw new Error("Enter a valid Owner name, email, 12-character password, branch, register, and language.");
  }
  await completeOwnerSetup(input);
});

app.on("second-instance", () => mainWindow?.focus());
if (hasSingleInstance) app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (syncTimer) clearTimeout(syncTimer);
  if (!localServer || shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const child = localServer;
  const shutdown = fetch(`${SERVER_ORIGIN}/api/desktop/shutdown`, { method: "POST", headers: { "x-forno-desktop-setup": setupToken }, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  void shutdown.then(() => new Promise<void>((resolveExit) => {
    if (child.exitCode !== null) return resolveExit();
    const timeout = setTimeout(() => { child.kill(); resolveExit(); }, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
  })).finally(() => { localServer = null; app.quit(); });
});
