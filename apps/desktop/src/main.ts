import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { desktopPaths } from "./runtime-paths.js";

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
let runtimeState: "setup_required" | "starting" | "ready" | "failed" = "setup_required";
let shutdownStarted = false;
const setupToken = randomBytes(32).toString("hex");

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

function childEnvironment(secret: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    FORNO_DESKTOP_MODE: "1",
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
  const env = childEnvironment(await readOrCreateAuthSecret());
  await mkdir(localPaths.root, { recursive: true });
  await mkdir(dirname(localPaths.database), { recursive: true });
  await mkdir(localPaths.logs, { recursive: true });
  await runElectronNode(join(webRoot, "node_modules", "drizzle-kit", "bin.cjs"), ["push"], webRoot, env);
  if (!(await isDatabasePresent())) throw new Error("Schema setup completed without creating a verifiable PGLite database.");
}

async function startLocalServer() {
  if (localServer && localServer.exitCode === null) return;
  runtimeState = "starting";
  const webRoot = packagedWebRoot();
  const env = childEnvironment(await readOrCreateAuthSecret());
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
      if (response.ok) { runtimeState = "ready"; return; }
    } catch { /* Local startup is still in progress. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  runtimeState = "failed";
  throw new Error("The local application server did not become ready.");
}

async function completeOwnerSetup(input: { name: string; email: string; password: string; branchName: string; registerName: string; locale: "en" | "ar" }) {
  const response = await fetch(`${SERVER_ORIGIN}/api/desktop/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forno-desktop-setup": setupToken },
    body: JSON.stringify(input),
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
