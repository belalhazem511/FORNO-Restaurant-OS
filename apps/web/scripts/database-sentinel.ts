import { PGlite } from "@electric-sql/pglite";
import { databaseConfig } from "../src/lib/db/config";

async function main() {
  const { directory, role } = databaseConfig();
  if (role !== "test") throw new Error("Sentinel tooling is restricted to an isolated test database.");
  const database = new PGlite(directory);
  if (process.argv.includes("--create")) {
    await database.exec(`
      insert into audit_logs (branch_id, order_id, actor_user_id, action, entity_type, entity_id, reason)
      select o.branch_id, o.id, o.user_uid, 'sentinel.concurrent-build', 'order', o.id::text, 'Disposable database concurrency sentinel'
      from orders o
      where not exists (select 1 from audit_logs where action = 'sentinel.concurrent-build')
      order by o.id
      limit 1
    `);
  }
  const result = await database.query<{
    branches: number;
    orders: number;
    payments: number;
    audits: number;
  }>(`
    select
      (select count(*)::int from branches) as branches,
      (select count(*)::int from orders) as orders,
      (select count(*)::int from order_payments) as payments,
      (select count(*)::int from audit_logs where action = 'sentinel.concurrent-build') as audits
  `);
  await database.close();
  console.log(JSON.stringify({ database: directory, ...result.rows[0] }));
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
