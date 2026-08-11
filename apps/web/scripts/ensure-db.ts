import { PGlite } from "@electric-sql/pglite";
import { databaseConfig, databaseFailureMessage, isPGliteDatabaseDirectory } from "../src/lib/db/config";

export type DatabaseOpener = (directory: string) => Promise<{ query(sql: string): Promise<unknown>; close(): Promise<void> }>;

const openPGlite: DatabaseOpener = async (directory) => new PGlite(directory);

export async function validateExistingDatabase(
  directory: string,
  opener: DatabaseOpener = openPGlite,
) {
  if (!isPGliteDatabaseDirectory(directory)) return { exists: false as const };
  let database: Awaited<ReturnType<DatabaseOpener>> | undefined;
  try {
    database = await opener(directory);
    await database.query("SELECT 1");
    await database.close();
    return { exists: true as const };
  } catch (cause) {
    if (database) {
      try { await database.close(); } catch { /* Preserve the original failure. */ }
    }
    throw new Error(databaseFailureMessage("Database validation", directory, cause), { cause });
  }
}

async function main() {
  const { directory, role } = databaseConfig();
  const result = await validateExistingDatabase(directory);
  if (!result.exists) throw new Error(`PGLite ${role} database does not exist at ${directory}. No database was created. Run bun run db:push explicitly, then bun run db:seed when demo data is intended.`);
  console.log(`PGLite ${role} database validated without modification: ${directory}`);
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
