import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_LOCAL_SCHEMA_VERSION, readLocalSchemaVersion, writeLocalSchemaVersion } from "../src/local-schema-version.js";

let testDirectory = "";
afterEach(async () => {
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
  testDirectory = "";
});

describe("local schema version gate", () => {
  test("treats a missing marker as requiring explicit review", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "forno-schema-version-test-"));
    expect(await readLocalSchemaVersion(join(testDirectory, "sync", "schema-version.json"))).toBeNull();
  });

  test("writes and reads the current version without touching other data", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "forno-schema-version-test-"));
    const marker = join(testDirectory, "sync", "schema-version.json");
    await writeLocalSchemaVersion(marker);
    expect(await readLocalSchemaVersion(marker)).toBe(CURRENT_LOCAL_SCHEMA_VERSION);
    expect(JSON.parse(await readFile(marker, "utf8")).version).toBe(CURRENT_LOCAL_SCHEMA_VERSION);
  });

  test("preserves malformed version markers as errors", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "forno-schema-version-test-"));
    const marker = join(testDirectory, "schema-version.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(marker, "not-json");
    await expect(readLocalSchemaVersion(marker)).rejects.toThrow();
  });
});
