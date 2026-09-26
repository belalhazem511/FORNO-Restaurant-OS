import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { desktopPaths } from "../src/runtime-paths.js";

describe("desktop local data paths", () => {
  test("uses the per-user SOLO directory and separates all durable stores", () => {
    const paths = desktopPaths("C:\\Users\\tester\\AppData\\Roaming", {} as NodeJS.ProcessEnv);
    expect(paths.root).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS");
    expect(paths.database).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\data\\pglite");
    expect(paths.media).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\media\\products");
    expect(paths.documents).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\documents");
    expect(paths.sync).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\sync");
    expect(paths.backups).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\backups");
    expect(paths.logs).toBe("C:\\Users\\tester\\AppData\\Roaming\\SOLO Restaurant OS\\logs");
  });

  test("continues using existing FORNO data without moving or deleting it", async () => {
    const appDataDirectory = await mkdtemp(join(tmpdir(), "solo-legacy-path-"));
    const legacyRoot = join(appDataDirectory, "FORNO Restaurant OS");
    await mkdir(legacyRoot);
    try {
      expect(desktopPaths(appDataDirectory).root).toBe(legacyRoot);
    } finally {
      await rm(appDataDirectory, { recursive: true, force: true });
    }
  });

  test("allows only an absolute isolated data override in test mode", () => {
    expect(desktopPaths("unused", { NODE_ENV: "test", FORNO_DESKTOP_DATA_DIR: "C:\\Temp\\forno-desktop-test" } as NodeJS.ProcessEnv).root)
      .toBe("C:\\Temp\\forno-desktop-test");
    expect(() => desktopPaths("unused", { FORNO_DESKTOP_DATA_DIR: "C:\\Temp\\not-a-test" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => desktopPaths("unused", { NODE_ENV: "test", FORNO_DESKTOP_DATA_DIR: "relative" } as NodeJS.ProcessEnv)).toThrow();
  });
});
