import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runIsolatedBuild } from "../../../../scripts/build";
import { validateExistingDatabase } from "../../../../scripts/ensure-db";
import { runSchemaPush } from "../../../../scripts/push-schema";
import { DATABASE_DIR_ENV, DATABASE_ROLE_ENV, databaseConfig, defaultRuntimeDatabaseDir } from "../config";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function directoryDigest(directory: string) {
  const hash = createHash("sha256");
  async function visit(current: string) {
    const entries = (await readdir(current)).sort();
    for (const entry of entries) {
      const path = join(current, entry);
      const details = await stat(path);
      hash.update(entry);
      if (details.isDirectory()) await visit(path);
      else hash.update(await readFile(path));
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function createFinancialSentinels(directory: string) {
  const database = new PGlite(directory);
  await database.exec(`
    create table branches (id integer primary key, code text not null);
    create table orders (id integer primary key, total_amount integer not null);
    create table order_payments (id integer primary key, order_id integer not null, amount integer not null);
    create table audit_logs (id integer primary key, entity_id text not null, action text not null);
    insert into branches values (1, 'SENTINEL-BRANCH');
    insert into orders values (1, 12345);
    insert into order_payments values (1, 1, 12345);
    insert into audit_logs values (1, '1', 'sentinel.audit');
  `);
  await database.close();
}

async function sentinelCounts(directory: string) {
  const database = new PGlite(directory);
  const result: Record<string, number> = {};
  for (const table of ["branches", "orders", "order_payments", "audit_logs"]) {
    const rows = await database.query<{ count: number }>(`select count(*)::int as count from ${table}`);
    result[table] = rows.rows[0]?.count ?? -1;
  }
  await database.close();
  return result;
}

async function sentinelRows(directory: string) {
  const database = new PGlite(directory);
  const snapshot = {
    branches: (await database.query("select * from branches order by id")).rows,
    orders: (await database.query("select * from orders order by id")).rows,
    payments: (await database.query("select * from order_payments order by id")).rows,
    audits: (await database.query("select * from audit_logs order by id")).rows,
  };
  await database.close();
  return snapshot;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PGLite database safety", () => {
  it("keeps restaurant, order, payment, and audit sentinels unchanged during an isolated build", async () => {
    const runtimeDirectory = await temporaryDirectory("forno-runtime-sentinel-");
    await createFinancialSentinels(runtimeDirectory);
    const beforeCounts = await sentinelCounts(runtimeDirectory);
    const beforeRows = await sentinelRows(runtimeDirectory);

    await runIsolatedBuild(async (env) => {
      expect(env[DATABASE_ROLE_ENV]).toBe("build");
      expect(resolve(env[DATABASE_DIR_ENV]!)).not.toBe(resolve(runtimeDirectory));
      const buildDatabase = new PGlite(env[DATABASE_DIR_ENV]!);
      await buildDatabase.exec("create table build_only (id integer primary key); insert into build_only values (1);");
      await buildDatabase.close();
      return 0;
    }, { ...process.env, [DATABASE_ROLE_ENV]: "runtime", [DATABASE_DIR_ENV]: runtimeDirectory });

    expect(await sentinelCounts(runtimeDirectory)).toEqual(beforeCounts);
    expect(await sentinelRows(runtimeDirectory)).toEqual(beforeRows);
  }, 30_000);

  it("does not recreate or change a database after a simulated lock error", async () => {
    const directory = await temporaryDirectory("forno-lock-sentinel-");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "PG_VERSION"), "17");
    await writeFile(join(directory, "sentinel.txt"), "preserve-me");
    const before = await directoryDigest(directory);
    await expect(validateExistingDatabase(directory, async () => { throw new Error("database is locked"); })).rejects.toThrow("No automatic reset or recovery was attempted");
    expect(await directoryDigest(directory)).toBe(before);
  });

  it("preserves the original database when explicit migration fails", async () => {
    const directory = await temporaryDirectory("forno-migration-sentinel-");
    await createFinancialSentinels(directory);
    const before = await sentinelRows(directory);
    await expect(runSchemaPush(async () => { throw new Error("simulated migration failure"); }, {
      ...process.env,
      [DATABASE_ROLE_ENV]: "test",
      [DATABASE_DIR_ENV]: directory,
    })).rejects.toThrow("No automatic reset or recovery was attempted");
    expect(await sentinelRows(directory)).toEqual(before);
  });

  it("requires test and build databases to be isolated from runtime", () => {
    expect(databaseConfig({ [DATABASE_ROLE_ENV]: "runtime" }).directory).toBe(resolve(defaultRuntimeDatabaseDir));
    expect(() => databaseConfig({ [DATABASE_ROLE_ENV]: "test", [DATABASE_DIR_ENV]: defaultRuntimeDatabaseDir })).toThrow("must be isolated");
    expect(() => databaseConfig({ [DATABASE_ROLE_ENV]: "build", [DATABASE_DIR_ENV]: defaultRuntimeDatabaseDir })).toThrow("must be isolated");
  });

  it("keeps explicit FORNO seed execution idempotent", async () => {
    const directory = await temporaryDirectory("forno-seed-idempotency-");
    console.log(`Seeding isolated idempotency database: ${directory}`);
    const env = {
      ...process.env,
      [DATABASE_ROLE_ENV]: "test",
      [DATABASE_DIR_ENV]: directory,
    };
    await runSchemaPush(undefined, env);
    const webDirectory = resolve(import.meta.dir, "../../../..");
    const runSeed = async () => {
      const child = Bun.spawn([process.execPath, "src/lib/db/seed.ts"], {
        cwd: webDirectory,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
    };
    const counts = async () => {
      const database = new PGlite(directory);
      const rows = await database.query<{ users: number; branches: number; orders: number; payments: number; stock_transfers: number; transfer_lines: number; transfer_movements: number; stock_counts: number; count_lines: number; count_entries: number; count_movements: number }>(`
        select
          (select count(*)::int from "user") as users,
          (select count(*)::int from branches) as branches,
          (select count(*)::int from orders) as orders,
          (select count(*)::int from order_payments) as payments,
          (select count(*)::int from stock_transfers where idempotency_key = 'seed-stock-transfer-demo') as stock_transfers,
          (select count(*)::int from stock_transfer_lines where transfer_id = (select id from stock_transfers where idempotency_key = 'seed-stock-transfer-demo')) as transfer_lines,
          (select count(*)::int from stock_movements where stock_transfer_id = (select id from stock_transfers where idempotency_key = 'seed-stock-transfer-demo')) as transfer_movements,
          (select count(*)::int from stock_counts where idempotency_key = 'seed-stock-count-demo') as stock_counts,
          (select count(*)::int from stock_count_lines where count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo')) as count_lines,
          (select count(*)::int from stock_count_entries where count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo')) as count_entries,
          (select count(*)::int from stock_movements where stock_count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo')) as count_movements
      `);
      await database.close();
      return rows.rows[0];
    };

    const seedSnapshot = async () => {
      const database = new PGlite(directory);
      const snapshot = {
        demoAccounts: (await database.query(`
          select u.email, u.name, a.provider_id, a.account_id, a.password
          from "user" u join account a on a.user_id = u.id
          where u.email in ('admin@forno.local', 'cashier@forno.local', 'manager@forno.local')
          order by u.email
        `)).rows,
        suppliers: (await database.query(`select id, branch_id, code, name_en, is_active from suppliers where code = 'FRESH-FOODS' order by id`)).rows,
        purchaseOrders: (await database.query(`select id, po_number, status, receiving_status, total_amount, idempotency_key from purchase_orders where idempotency_key like 'seed-po-%' order by idempotency_key`)).rows,
        purchaseOrderLines: (await database.query(`
          select l.purchase_order_id, l.ingredient_id, l.unit_id, l.package_conversion_id, l.quantity_input_scaled, l.quantity_base, l.conversion_numerator_snapshot, l.conversion_denominator_snapshot, l.unit_price_minor, l.line_total_amount
          from purchase_order_lines l join purchase_orders p on p.id = l.purchase_order_id
          where p.idempotency_key like 'seed-po-%' order by p.idempotency_key, l.id
        `)).rows,
        receipts: (await database.query(`select * from purchase_receipts order by id`)).rows,
        balances: (await database.query(`select * from stock_balances order by location_id, ingredient_id`)).rows,
        movements: (await database.query(`select * from stock_movements order by id`)).rows,
        transfer: (await database.query(`select * from stock_transfers where idempotency_key = 'seed-stock-transfer-demo' order by id`)).rows,
        transferLines: (await database.query(`select * from stock_transfer_lines where transfer_id = (select id from stock_transfers where idempotency_key = 'seed-stock-transfer-demo') order by id`)).rows,
        transferHistory: (await database.query(`select * from stock_transfer_status_history where transfer_id = (select id from stock_transfers where idempotency_key = 'seed-stock-transfer-demo') order by id`)).rows,
        counts: (await database.query(`select * from stock_counts where idempotency_key = 'seed-stock-count-demo' order by id`)).rows,
        countLines: (await database.query(`select * from stock_count_lines where count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo') order by id`)).rows,
        countEntries: (await database.query(`select * from stock_count_entries where count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo') order by id`)).rows,
        countHistory: (await database.query(`select * from stock_count_status_history where count_id = (select id from stock_counts where idempotency_key = 'seed-stock-count-demo') order by id`)).rows,
        payments: (await database.query(`select * from order_payments order by id`)).rows,
        financialTransactions: (await database.query(`select * from transactions order by id`)).rows,
        audits: (await database.query(`select * from audit_logs order by id`)).rows,
      };
      await database.close();
      return snapshot;
    };

    const verifyDemoLogin = async () => {
      const child = Bun.spawn([process.execPath, "-e", `
        const { auth } = await import("./src/lib/auth.ts");
        const result = await auth.api.signInEmail({ body: { email: "admin@forno.local", password: "Forno123!" } });
        if (result.user.email !== "admin@forno.local") process.exitCode = 1;
      `], { cwd: webDirectory, env, stdout: "pipe", stderr: "pipe" });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
    };

    await runSeed();
    const firstCounts = await counts();
    const firstSnapshot = await seedSnapshot();
    await runSeed();
    expect(await counts()).toEqual(firstCounts);
    expect(await seedSnapshot()).toEqual(firstSnapshot);
    expect(firstSnapshot.demoAccounts.map((row) => (row as { email: string }).email)).toEqual([
      "admin@forno.local",
      "cashier@forno.local",
      "manager@forno.local",
    ]);
    expect(firstSnapshot.suppliers).toHaveLength(1);
    expect(firstSnapshot.purchaseOrders).toHaveLength(3);
    expect(firstSnapshot.purchaseOrderLines).toHaveLength(5);
    expect(firstSnapshot.receipts).toHaveLength(0);
    expect(firstSnapshot.balances.length).toBeGreaterThan(0);
    expect(firstSnapshot.movements.length).toBeGreaterThan(0);
    expect(firstSnapshot.transfer).toHaveLength(1);
    expect(firstSnapshot.transferLines).toHaveLength(2);
    expect(firstSnapshot.transferHistory).toHaveLength(1);
    expect(firstSnapshot.counts).toHaveLength(1);
    expect(firstSnapshot.countLines).toHaveLength(0);
    expect(firstSnapshot.countEntries).toHaveLength(0);
    expect(firstSnapshot.countHistory).toHaveLength(1);
    expect(firstSnapshot.payments).toHaveLength(3);
    expect(firstSnapshot.financialTransactions).toHaveLength(3);
    expect(firstSnapshot.audits).toHaveLength(21);
    await verifyDemoLogin();
    expect(firstCounts.stock_transfers).toBe(1);
    expect(firstCounts.transfer_lines).toBe(2);
    expect(firstCounts.transfer_movements).toBe(0);
    expect(firstCounts.stock_counts).toBe(1);
    expect(firstCounts.count_lines).toBe(0);
    expect(firstCounts.count_entries).toBe(0);
    expect(firstCounts.count_movements).toBe(0);
  }, 30_000);
});
