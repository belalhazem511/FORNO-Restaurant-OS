# Database safety and operations

FORNO uses an embedded PGLite database locally. Restaurant orders, payments, shifts, and audit records are runtime data and must never be treated as disposable build artifacts.

## Database roles and paths

- **Runtime:** defaults to `apps/web/data/pglite`. The development server uses this database unless `FORNO_DATABASE_DIR` is explicitly set.
- **Test:** tests use in-memory databases or a unique temporary directory with `FORNO_DATABASE_ROLE=test`. Test configuration is rejected if it points to the runtime directory.
- **Build:** `bun run build` creates a unique directory under the operating-system temporary directory and sets `FORNO_DATABASE_ROLE=build`. It never opens, migrates, seeds, or locks the runtime database. The isolated directory is removed after the build.

`FORNO_DATABASE_DIR` may be set to an absolute disposable path for smoke tests. `FORNO_DATABASE_ROLE` accepts `runtime`, `test`, or `build`; test/build roles must never resolve to the runtime path.

## Runtime startup

`bun run dev:web` performs a read-only validation when a database already exists. A lock, permission problem, damaged file, or startup error stops with an actionable message. No file is deleted, renamed, reset, or recreated.

Startup does not migrate or seed. For a new checkout, run the explicit migration and seed commands before starting the server.

## Migration

Run `bun run db:push` explicitly while every process using the selected database is stopped. The command validates the existing database first and refuses build-role databases. Any validation or migration error is reported without automatic reset or recovery.

Create and verify a backup before every schema migration. PGLite/PostgreSQL transactional behavior protects migration statements, but an operator should not retry a failed migration blindly: preserve the database and logs, diagnose the failure, and restore only from a verified backup when required.

## Seed

Run `bun run db:seed` explicitly. No startup or production build invokes the seed. FORNO seed records use stable unique keys and upserts, so repeated execution does not duplicate branches, users, menu records, orders, payments, or shifts.

## Production build

`bun run build` invokes `apps/web/scripts/build.ts`. It provides an isolated temporary build database path to Next.js and does not call database validation, migration, or seed against the runtime path. Build failure removes only that temporary build directory.

## Backup and restore

1. Stop the development/application server and any migration, seed, studio, or reporting process.
2. Copy the complete `apps/web/data/pglite` directory to dated, access-controlled storage.
3. Verify the backup exists and can be opened in an isolated location.
4. Restore only while all database users are stopped. Preserve the failed database separately for diagnosis; do not overwrite it until the backup is verified.

For live operations, schedule frequent backups and copy them off the application host. Financial exports are useful but do not replace a complete database backup.

## Explicit development reset

Automatic destructive recovery does not exist. The only reset is the intentionally named development command:

```bash
cd apps/web
bun run db:reset:dev
```

It is disabled when `NODE_ENV=production`, prints the exact target, and requires the explicit destructive confirmation flag embedded in that dedicated script. It permanently deletes the selected local database. Back up first, then run `bun run db:push` and `bun run db:seed` explicitly if a fresh demo database is truly intended.

## Concurrency

Only one application process should use a file-backed runtime PGLite directory. Builds and tests are isolated and safe to run concurrently. Schema migration, seed, backup, restore, and reset should run with the runtime server stopped; lock errors are failures and never trigger deletion.
