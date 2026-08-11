import { join } from "node:path";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { databaseConfig, databaseFailureMessage } from "../src/lib/db/config";
import { validateExistingDatabase } from "./ensure-db";

export type SchemaPushRunner = (env: NodeJS.ProcessEnv) => Promise<number>;

const runDrizzlePush: SchemaPushRunner = async (env) => {
  const child = Bun.spawn(["bun", "x", "drizzle-kit", "push"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export async function runSchemaPush(
  runner: SchemaPushRunner = runDrizzlePush,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { directory, role } = databaseConfig(env);
  if (role === "build") throw new Error("Schema migration is forbidden during production builds.");
  await validateExistingDatabase(directory);
  await mkdir(dirname(directory), { recursive: true });
  try {
    const exitCode = await runner(env);
    if (exitCode !== 0) throw new Error(`drizzle-kit exited with code ${exitCode}`);
  } catch (cause) {
    throw new Error(databaseFailureMessage("Explicit schema migration", directory, cause), { cause });
  }
}

if (import.meta.main) {
  runSchemaPush().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
