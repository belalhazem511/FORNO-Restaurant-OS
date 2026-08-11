import { rm } from "node:fs/promises";
import { databaseConfig } from "../src/lib/db/config";

const CONFIRMATION = "--confirm-delete-runtime-database";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Database reset is disabled in production.");
  if (!process.argv.includes(CONFIRMATION)) {
    throw new Error(`DESTRUCTIVE DEVELOPMENT COMMAND: this permanently deletes the selected local PGLite database. Re-run with ${CONFIRMATION} only after creating and verifying a backup.`);
  }
  const { directory, role } = databaseConfig();
  if (role === "build") throw new Error("The runtime reset command cannot target a build database.");
  console.warn(`DELETING ${role} PGLite database after explicit confirmation: ${directory}`);
  await rm(directory, { recursive: true, force: true });
  console.warn("Database deleted. Run bun run db:push and bun run db:seed explicitly if a fresh demo database is intended.");
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
