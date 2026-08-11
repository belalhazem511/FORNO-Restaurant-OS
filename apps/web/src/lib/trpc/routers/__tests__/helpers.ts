import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// FK-safe order: referenced tables before referencing tables
const TABLES: PgTable[] = [
  schema.user,
  schema.branches,
  schema.staffAssignments,
  schema.diningAreas,
  schema.restaurantTables,
  schema.kitchenStations,
  schema.menuCategories,
  schema.products,
  schema.menuItems,
  schema.menuItemVariants,
  schema.modifierGroups,
  schema.modifierOptions,
  schema.menuItemModifierGroups,
  schema.customers,
  schema.cashierRegisters,
  schema.registerPrintPreferences,
  schema.cashierShifts,
  schema.shiftCashMovements,
  schema.paymentMethods,
  schema.orders,
  schema.orderItems,
  schema.orderItemModifiers,
  schema.orderStatusHistory,
  schema.orderCheckouts,
  schema.orderPayments,
  schema.orderCancellations,
  schema.auditLogs,
  schema.printJobs,
  schema.offlinePriceSnapshots,
  schema.offlineSyncRecords,
  schema.transactions,
];

function tableToDDL(table: PgTable): string {
  const { name, columns, foreignKeys } = getTableConfig(table);

  const colDefs = columns.map((col) => {
    const sqlType = col.getSQLType();
    const isSerial = sqlType === "serial";
    const parts: string[] = [`"${col.name}"`, sqlType];

    if (col.primary) parts.push("PRIMARY KEY");
    if (col.notNull && !isSerial) parts.push("NOT NULL");
    if (col.isUnique) parts.push("UNIQUE");
    if (col.hasDefault && !isSerial && sqlType.startsWith("timestamp")) {
      parts.push("DEFAULT NOW()");
    }

    return parts.join(" ");
  });

  const fkDefs = foreignKeys.map((fk) => {
    const ref = fk.reference();
    const col = ref.columns[0].name;
    const refTable = getTableName(ref.foreignColumns[0].table);
    const refCol = ref.foreignColumns[0].name;
    return `FOREIGN KEY ("${col}") REFERENCES "${refTable}"("${refCol}")`;
  });

  return `CREATE TABLE IF NOT EXISTS "${name}" (\n  ${[...colDefs, ...fkDefs].join(",\n  ")}\n);`;
}

export const SCHEMA_DDL = `${TABLES.map(tableToDDL).join("\n\n")}

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_request_uidx ON orders (client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_offline_receipt_reference_uidx ON orders (offline_receipt_reference);
CREATE UNIQUE INDEX IF NOT EXISTS staff_assignments_user_branch_uidx ON staff_assignments (user_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS cashier_shifts_open_register_uidx ON cashier_shifts (register_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS cashier_shifts_open_cashier_uidx ON cashier_shifts (cashier_user_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS order_checkouts_order_uidx ON order_checkouts (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_checkouts_idempotency_uidx ON order_checkouts (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS order_cancellations_order_uidx ON order_cancellations (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_cancellations_idempotency_uidx ON order_cancellations (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_refund_original_uidx ON order_payments (original_payment_id) WHERE kind = 'refund';
CREATE UNIQUE INDEX IF NOT EXISTS register_print_preferences_register_uidx ON register_print_preferences (register_id);
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_idempotency_uidx ON print_jobs (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_initial_kot_uidx ON print_jobs (order_id, station_id) WHERE document_type = 'kot' AND is_reprint = false;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_initial_document_uidx ON print_jobs (order_id, document_type) WHERE document_type <> 'kot' AND is_reprint = false;
CREATE UNIQUE INDEX IF NOT EXISTS offline_price_snapshots_reference_uidx ON offline_price_snapshots (reference);
CREATE UNIQUE INDEX IF NOT EXISTS offline_sync_records_operation_uidx ON offline_sync_records (client_operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS offline_sync_records_checkout_key_uidx ON offline_sync_records (checkout_idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS offline_sync_records_receipt_number_uidx ON offline_sync_records (offline_receipt_number);`;

export function createTestDb() {
  const pg = new PGlite();
  const db = drizzle({ client: pg, schema });
  return { pg, db };
}

export function makeUser(id: string) {
  return {
    id,
    name: "Test",
    email: `${id}@test.com`,
    emailVerified: false,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
