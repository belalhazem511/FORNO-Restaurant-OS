import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const STORES = ["data", "media", "documents", "sync"] as const;
const BACKUP_NAME = /^forno-backup-\d{8}-\d{6}-[a-f0-9]{8}\.tar$/;

function runTar(args: string[]) {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn("tar.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveOutput(output) : reject(new Error(errorOutput.trim() || `Windows archive utility exited with code ${code ?? "unknown"}.`)));
  });
}

export function validateBackupEntries(entries: string[]) {
  if (entries.length === 0) throw new Error("The selected backup archive is empty.");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/").replace(/\/$/, "");
    if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("The backup contains an unsafe file path and was not restored.");
    }
    if (!STORES.some((store) => normalized === store || normalized.startsWith(`${store}/`))) {
      throw new Error("The backup contains an unexpected top-level file and was not restored.");
    }
  }
}

async function verifyNoLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error("The backup contains a symbolic link and was not restored.");
    if (details.isDirectory()) await verifyNoLinks(path);
  }
}

export async function createLocalBackup(root: string, now = new Date()) {
  const absoluteRoot = resolve(root);
  const backupDirectory = join(absoluteRoot, "backups");
  await mkdir(backupDirectory, { recursive: true });
  for (const store of STORES) await stat(join(absoluteRoot, store));
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const filename = `forno-backup-${stamp}-${randomUUID().slice(0, 8)}.tar`;
  const temporary = join(backupDirectory, `.${filename}.partial`);
  const destination = join(backupDirectory, filename);
  try {
    await runTar(["-cf", temporary, "-C", absoluteRoot, ...STORES]);
    const listing = await runTar(["-tf", temporary]);
    validateBackupEntries(listing.split(/\r?\n/).filter(Boolean));
    if ((await stat(temporary)).size === 0) throw new Error("The backup archive is empty.");
    await rename(temporary, destination);
    return { filename, path: destination };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function restoreLocalBackup(root: string, archivePath: string) {
  const absoluteRoot = resolve(root);
  const backups = resolve(absoluteRoot, "backups");
  const absoluteArchive = resolve(archivePath);
  const archiveRelative = relative(backups, absoluteArchive);
  if (!archiveRelative || archiveRelative.startsWith(`..${sep}`) || archiveRelative === ".." || !BACKUP_NAME.test(basename(absoluteArchive))) {
    throw new Error("Select a dated FORNO backup from this device.");
  }
  const listing = await runTar(["-tf", absoluteArchive]);
  validateBackupEntries(listing.split(/\r?\n/).filter(Boolean));
  const staging = join(absoluteRoot, `.restore-${randomUUID()}`);
  const recovery = join(absoluteRoot, `recovery-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(staging, { recursive: false });
  await mkdir(recovery, { recursive: false });
  await runTar(["-xf", absoluteArchive, "-C", staging]);
  await verifyNoLinks(staging);
  for (const store of STORES) await stat(join(staging, store));

  const movedCurrent: string[] = [];
  const installed: string[] = [];
  try {
    for (const store of STORES) {
      await rename(join(absoluteRoot, store), join(recovery, store));
      movedCurrent.push(store);
      await rename(join(staging, store), join(absoluteRoot, store));
      installed.push(store);
    }
  } catch (error) {
    for (const store of [...installed].reverse()) {
      await rename(join(absoluteRoot, store), join(staging, store)).catch(() => undefined);
    }
    for (const store of [...movedCurrent].reverse()) {
      await rename(join(recovery, store), join(absoluteRoot, store)).catch(() => undefined);
    }
    throw new Error(`Restore failed. The original local data was preserved where possible at ${recovery}. ${error instanceof Error ? error.message : ""}`);
  }
  return { recoveryPath: recovery };
}
