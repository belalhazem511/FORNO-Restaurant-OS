import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBackup, restoreLocalBackup, validateBackupEntries } from "../src/local-backups.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

describe("local storage backups", () => {
  test("rejects traversal and unexpected archive roots", () => {
    expect(() => validateBackupEntries(["data/pglite/PG_VERSION", "../outside.txt"])).toThrow();
    expect(() => validateBackupEntries(["C:/outside.txt"])).toThrow();
    expect(() => validateBackupEntries(["arbitrary/secrets.txt"])).toThrow();
    expect(() => validateBackupEntries(["media/products/image.webp"])).not.toThrow();
  });

  test("creates a verified archive and restores while retaining the previous local stores", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "forno-desktop-backup-test-"));
    for (const store of ["data", "media", "documents", "sync", "backups"]) await mkdir(join(temporaryRoot, store), { recursive: true });
    await writeFile(join(temporaryRoot, "data", "pglite-marker.txt"), "original");
    await writeFile(join(temporaryRoot, "media", "product.webp"), "image");
    await writeFile(join(temporaryRoot, "documents", "receipt.txt"), "receipt");
    await writeFile(join(temporaryRoot, "sync", "auth-secret.bin"), "encrypted-secret");

    const backup = await createLocalBackup(temporaryRoot, new Date("2026-09-25T12:30:00"));
    await writeFile(join(temporaryRoot, "data", "pglite-marker.txt"), "changed");
    const restored = await restoreLocalBackup(temporaryRoot, backup.path);

    expect(await readFile(join(temporaryRoot, "data", "pglite-marker.txt"), "utf8")).toBe("original");
    expect(await readFile(join(temporaryRoot, "media", "product.webp"), "utf8")).toBe("image");
    expect(await readFile(join(restored.recoveryPath, "data", "pglite-marker.txt"), "utf8")).toBe("changed");
    expect(backup.filename).toMatch(/^solo-backup-20260925-123000-[a-f0-9]{8}\.tar$/);
  });
});
