import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type DesktopPaths = {
  root: string;
  database: string;
  media: string;
  documents: string;
  sync: string;
  backups: string;
  logs: string;
};

export function desktopPaths(appDataDirectory: string, env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  const testDirectory = env.FORNO_DESKTOP_DATA_DIR;
  if (testDirectory && env.NODE_ENV !== "test") {
    throw new Error("FORNO_DESKTOP_DATA_DIR is available only to isolated desktop tests.");
  }
  if (testDirectory && !isAbsolute(testDirectory)) {
    throw new Error("FORNO_DESKTOP_DATA_DIR must be an absolute isolated test path.");
  }
  const soloRoot = join(appDataDirectory, "SOLO Restaurant OS");
  const legacyFornoRoot = join(appDataDirectory, "FORNO Restaurant OS");
  const root = resolve(testDirectory ?? (existsSync(soloRoot) || !existsSync(legacyFornoRoot) ? soloRoot : legacyFornoRoot));
  return {
    root,
    database: join(root, "data", "pglite"),
    media: join(root, "media", "products"),
    documents: join(root, "documents"),
    sync: join(root, "sync"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
  };
}
