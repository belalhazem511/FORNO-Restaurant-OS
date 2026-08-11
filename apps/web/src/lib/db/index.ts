import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { databaseConfig, databaseFailureMessage, isPGliteDatabaseDirectory } from "./config";

const globalForPGlite = globalThis as unknown as {
  pglite: PGlite | undefined;
};

const configuredDatabase = databaseConfig();

function buildAccessForbidden<T>(name: string): T {
  return new Proxy({}, {
    get() {
      throw new Error(`${name} access is forbidden during production build. Move this query to request-time execution.`);
    },
  }) as T;
}

function initializePGlite() {
  if (!isPGliteDatabaseDirectory(configuredDatabase.directory)) {
    throw new Error(`PGLite ${configuredDatabase.role} database does not exist at ${configuredDatabase.directory}. No database was created automatically. Run bun run db:push explicitly, then bun run db:seed when demo data is intended.`);
  }
  try {
    return globalForPGlite.pglite ?? new PGlite(configuredDatabase.directory);
  } catch (cause) {
    throw new Error(databaseFailureMessage("Database initialization", configuredDatabase.directory, cause), { cause });
  }
}

export const pglite = configuredDatabase.role === "build"
  ? buildAccessForbidden<PGlite>("PGLite")
  : initializePGlite();

if (configuredDatabase.role !== "build") globalForPGlite.pglite = pglite;

export const db = configuredDatabase.role === "build"
  ? buildAccessForbidden<ReturnType<typeof drizzle<typeof schema>>>("Database")
  : drizzle({ client: pglite, schema });
