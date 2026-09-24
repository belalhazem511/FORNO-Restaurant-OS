import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CURRENT_LOCAL_SCHEMA_VERSION = 2;

export async function readLocalSchemaVersion(path: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new Error("The local schema version record is invalid. Data was preserved.");
    return Number(value.version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLocalSchemaVersion(path: string, version = CURRENT_LOCAL_SCHEMA_VERSION) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("A valid local schema version is required.");
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.schema-version-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ version }, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}
