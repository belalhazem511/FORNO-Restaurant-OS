import { resolve } from "node:path";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const DATABASE_DIR_ENV = "FORNO_DATABASE_DIR";
export const DATABASE_ROLE_ENV = "FORNO_DATABASE_ROLE";
export type DatabaseRole = "runtime" | "test" | "build";

export const defaultRuntimeDatabaseDir = resolve(process.cwd(), "data/pglite");

export function isPGliteDatabaseDirectory(directory: string) {
  return existsSync(join(directory, "PG_VERSION"));
}

export function databaseConfig(env: Record<string, string | undefined> = process.env) {
  const role = (env[DATABASE_ROLE_ENV] ?? "runtime") as DatabaseRole;
  if (!(["runtime", "test", "build"] as const).includes(role)) {
    throw new Error(`${DATABASE_ROLE_ENV} must be runtime, test, or build.`);
  }
  const directory = resolve(env[DATABASE_DIR_ENV] ?? defaultRuntimeDatabaseDir);
  if (role !== "runtime" && directory === resolve(defaultRuntimeDatabaseDir)) {
    throw new Error(`${role} database must be isolated from the runtime database. Set ${DATABASE_DIR_ENV}.`);
  }
  return { directory, role };
}

export function databaseFailureMessage(operation: string, directory: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `${operation} failed for PGLite database ${directory}. No automatic reset or recovery was attempted. Stop other processes using this database, verify permissions and free disk space, restore from a verified backup if necessary, then retry the explicit operation. Cause: ${detail}`;
}
