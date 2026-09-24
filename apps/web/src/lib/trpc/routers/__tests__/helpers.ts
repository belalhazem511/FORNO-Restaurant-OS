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
  schema.suppliers,
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
  schema.inventoryLocations,
  schema.ingredientCategories,
  schema.unitsOfMeasure,
  schema.ingredients,
  schema.ingredientPackageConversions,
  schema.purchaseOrders,
  schema.purchaseOrderLines,
  schema.purchaseReceipts,
  schema.purchaseReceiptLines,
  schema.purchaseReceiptReversals,
  schema.supplierReturns,
  schema.supplierReturnLines,
  schema.supplierReturnStatusHistory,
  schema.supplierReturnReversals,
  schema.stockTransfers,
  schema.stockTransferLines,
  schema.stockTransferDispatches,
  schema.stockTransferDispatchLines,
  schema.stockTransferReceipts,
  schema.stockTransferReceiptLines,
  schema.stockTransferReversals,
  schema.stockTransferStatusHistory,
  schema.stockCounts,
  schema.stockCountLines,
  schema.stockCountEntries,
  schema.stockCountReversals,
  schema.stockCountStatusHistory,
  schema.stockBalances,
  schema.recipeVersions,
  schema.recipeComponents,
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
  schema.orderInventoryIssues,
  schema.orderInventoryConsumptions,
  schema.orderItemCogs,
  schema.stockMovements,
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
CREATE UNIQUE INDEX IF NOT EXISTS offline_sync_records_receipt_number_uidx ON offline_sync_records (offline_receipt_number);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_branch_code_uidx ON inventory_locations (branch_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS ingredient_categories_branch_code_uidx ON ingredient_categories (branch_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS units_of_measure_code_uidx ON units_of_measure (code);
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_branch_sku_uidx ON ingredients (branch_id, sku);
CREATE UNIQUE INDEX IF NOT EXISTS ingredient_packages_ingredient_code_uidx ON ingredient_package_conversions (ingredient_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_branch_code_uidx ON suppliers (branch_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_branch_number_uidx ON purchase_orders (branch_id, po_number);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_idempotency_uidx ON purchase_orders (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipts_branch_number_uidx ON purchase_receipts (branch_id, receipt_number);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipts_idempotency_uidx ON purchase_receipts (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipt_lines_receipt_po_line_uidx ON purchase_receipt_lines (receipt_id, purchase_order_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipt_reversals_receipt_uidx ON purchase_receipt_reversals (receipt_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipt_reversals_idempotency_uidx ON purchase_receipt_reversals (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_location_ingredient_uidx ON stock_balances (location_id, ingredient_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_branch_number_uidx ON stock_transfers (branch_id, transfer_number);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_idempotency_uidx ON stock_transfers (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_lines_transfer_ingredient_uidx ON stock_transfer_lines (transfer_id, ingredient_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_dispatches_transfer_uidx ON stock_transfer_dispatches (transfer_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_dispatches_idempotency_uidx ON stock_transfer_dispatches (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_dispatch_lines_transfer_line_uidx ON stock_transfer_dispatch_lines (transfer_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_receipts_idempotency_uidx ON stock_transfer_receipts (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_reversals_transfer_uidx ON stock_transfer_reversals (transfer_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_reversals_idempotency_uidx ON stock_transfer_reversals (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_status_history_idempotency_uidx ON stock_transfer_status_history (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_branch_number_uidx ON stock_counts (branch_id, count_number);
CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_idempotency_uidx ON stock_counts (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_active_location_uidx ON stock_counts (branch_id, location_id) WHERE status in ('draft', 'counting', 'submitted', 'approved', 'needs_review');
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_lines_count_ingredient_uidx ON stock_count_lines (count_id, ingredient_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_entries_idempotency_uidx ON stock_count_entries (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_reversals_count_uidx ON stock_count_reversals (count_id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_reversals_idempotency_uidx ON stock_count_reversals (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_status_history_idempotency_uidx ON stock_count_status_history (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_configuration_version_uidx ON recipe_versions (menu_item_id, variant_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_base_version_uidx ON recipe_versions (menu_item_id, version) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_active_base_uidx ON recipe_versions (menu_item_id) WHERE status = 'active' AND variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_active_variant_uidx ON recipe_versions (menu_item_id, variant_id) WHERE status = 'active' AND variant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recipe_components_unambiguous_uidx ON recipe_components (recipe_version_id, ingredient_id, source_location_id, modifier_option_id);
CREATE UNIQUE INDEX IF NOT EXISTS recipe_components_base_uidx ON recipe_components (recipe_version_id, ingredient_id, source_location_id) WHERE modifier_option_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_inventory_issues_order_uidx ON order_inventory_issues (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_inventory_issues_idempotency_uidx ON order_inventory_issues (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS order_inventory_consumptions_snapshot_uidx ON order_inventory_consumptions (issue_id, order_item_id, ingredient_id, location_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_item_cogs_item_uidx ON order_item_cogs (order_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_returns_branch_number_uidx ON supplier_returns (branch_id, return_number);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_returns_idempotency_uidx ON supplier_returns (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_return_lines_return_receipt_line_uidx ON supplier_return_lines (supplier_return_id, receipt_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_return_status_history_idempotency_uidx ON supplier_return_status_history (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_return_reversals_return_uidx ON supplier_return_reversals (supplier_return_id);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_return_reversals_idempotency_uidx ON supplier_return_reversals (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_idempotency_uidx ON stock_movements (idempotency_key);`;

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
