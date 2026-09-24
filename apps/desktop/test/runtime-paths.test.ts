import { describe, expect, test } from "bun:test";
import { desktopPaths } from "../src/runtime-paths.js";

describe("desktop local data paths", () => {
  test("uses the per-user FORNO directory and separates all durable stores", () => {
    const paths = desktopPaths("C:\\Users\\tester\\AppData\\Roaming", {} as NodeJS.ProcessEnv);
    expect(paths.root).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS");
    expect(paths.database).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\data\\pglite");
    expect(paths.media).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\media\\products");
    expect(paths.documents).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\documents");
    expect(paths.sync).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\sync");
    expect(paths.backups).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\backups");
    expect(paths.logs).toBe("C:\\Users\\tester\\AppData\\Roaming\\FORNO Restaurant OS\\logs");
  });

  test("allows only an absolute isolated data override in test mode", () => {
    expect(desktopPaths("unused", { NODE_ENV: "test", FORNO_DESKTOP_DATA_DIR: "C:\\Temp\\forno-desktop-test" } as NodeJS.ProcessEnv).root)
      .toBe("C:\\Temp\\forno-desktop-test");
    expect(() => desktopPaths("unused", { FORNO_DESKTOP_DATA_DIR: "C:\\Temp\\not-a-test" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => desktopPaths("unused", { NODE_ENV: "test", FORNO_DESKTOP_DATA_DIR: "relative" } as NodeJS.ProcessEnv)).toThrow();
  });
});
