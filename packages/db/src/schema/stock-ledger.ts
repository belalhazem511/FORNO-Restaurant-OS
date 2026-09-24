import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  StockMovementType,
} from "./constants";
import { branches } from "./restaurant";
import {
  orders,
  orderItems,
} from "./orders";
import { inventoryLocations, ingredients } from "./inventory";
import {
  supplierReturns,
  supplierReturnLines,
  purchaseReceipts,
  purchaseReceiptLines,
} from "./procurement";
import { recipeVersions } from "./recipes";
import {
  stockTransfers,
  stockTransferLines,
  stockTransferDispatches,
  stockTransferDispatchLines,
  stockTransferReceipts,
  stockTransferReceiptLines,
  stockTransferReversals,
  stockCounts,
  stockCountLines,
  stockCountReversals,
} from "./stock-control";
import { user } from "../auth-schema";

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    movement_type: varchar("movement_type", { length: 32 }).$type<StockMovementType>().notNull(),
    direction: integer("direction").notNull(),
    quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
    unit_cost_micros: bigint("unit_cost_micros", { mode: "number" }).notNull(),
    total_cost_amount: integer("total_cost_amount").notNull(),
    source_type: varchar("source_type", { length: 40 }).notNull(),
    source_id: varchar("source_id", { length: 100 }).notNull(),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    reason: text("reason"),
    order_id: integer("order_id").references(() => orders.id, { onDelete: "restrict" }),
    order_item_id: integer("order_item_id").references(() => orderItems.id, { onDelete: "restrict" }),
    recipe_version_id: integer("recipe_version_id").references(() => recipeVersions.id, { onDelete: "restrict" }),
    supplier_return_id: integer("supplier_return_id").references(() => supplierReturns.id, { onDelete: "restrict" }),
    supplier_return_line_id: integer("supplier_return_line_id").references(() => supplierReturnLines.id, { onDelete: "restrict" }),
    purchase_receipt_id: integer("purchase_receipt_id").references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    purchase_receipt_line_id: integer("purchase_receipt_line_id").references(() => purchaseReceiptLines.id, { onDelete: "restrict" }),
    stock_transfer_id: integer("stock_transfer_id").references(() => stockTransfers.id, { onDelete: "restrict" }),
    stock_transfer_line_id: integer("stock_transfer_line_id").references(() => stockTransferLines.id, { onDelete: "restrict" }),
    stock_transfer_dispatch_id: integer("stock_transfer_dispatch_id").references(() => stockTransferDispatches.id, { onDelete: "restrict" }),
    stock_transfer_dispatch_line_id: integer("stock_transfer_dispatch_line_id").references(() => stockTransferDispatchLines.id, { onDelete: "restrict" }),
    stock_transfer_receipt_id: integer("stock_transfer_receipt_id").references(() => stockTransferReceipts.id, { onDelete: "restrict" }),
    stock_transfer_receipt_line_id: integer("stock_transfer_receipt_line_id").references(() => stockTransferReceiptLines.id, { onDelete: "restrict" }),
    stock_transfer_reversal_id: integer("stock_transfer_reversal_id").references(() => stockTransferReversals.id, { onDelete: "restrict" }),
    stock_count_id: integer("stock_count_id").references(() => stockCounts.id, { onDelete: "restrict" }),
    stock_count_line_id: integer("stock_count_line_id").references(() => stockCountLines.id, { onDelete: "restrict" }),
    stock_count_reversal_id: integer("stock_count_reversal_id").references(() => stockCountReversals.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stock_movements_idempotency_uidx").on(table.idempotency_key),
    index("stock_movements_ingredient_created_idx").on(table.ingredient_id, table.created_at),
    index("stock_movements_order_idx").on(table.order_id),
    check("stock_movements_type_check", sql`${table.movement_type} in ('opening_balance', 'manual_positive', 'manual_negative', 'sale_consumption', 'sale_consumption_reversal', 'waste_discard', 'negative_override', 'purchase_receipt', 'purchase_receipt_reversal', 'supplier_return', 'supplier_return_reversal', 'stock_transfer_out', 'stock_transfer_in', 'stock_transfer_reversal_out', 'stock_transfer_reversal_in', 'stock_count_positive', 'stock_count_negative', 'stock_count_reversal_positive', 'stock_count_reversal_negative')`),
    check("stock_movements_values_check", sql`${table.direction} in (-1, 0, 1) and ${table.quantity_base} > 0 and ${table.unit_cost_micros} >= 0 and ${table.total_cost_amount} >= 0`),
  ],
);
