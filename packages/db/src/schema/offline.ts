import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { OfflineSyncStatus } from "./constants";
import { branches } from "./restaurant";
import { orders } from "./orders";
import { cashierRegisters, cashierShifts, orderCheckouts } from "./finance";
import { user } from "../auth-schema";

export const offlinePriceSnapshots = pgTable(
  "offline_price_snapshots",
  {
    id: serial("id").primaryKey(),
    reference: varchar("reference", { length: 80 }).notNull(),
    revision: varchar("revision", { length: 64 }).notNull(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    register_id: integer("register_id").notNull().references(() => cashierRegisters.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").notNull().references(() => cashierShifts.id, { onDelete: "restrict" }),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    pricing_payload: text("pricing_payload").notNull(),
    issued_at: timestamp("issued_at").defaultNow().notNull(),
    expires_at: timestamp("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("offline_price_snapshots_reference_uidx").on(table.reference),
    index("offline_price_snapshots_scope_idx").on(table.branch_id, table.register_id, table.actor_user_id, table.expires_at),
    check("offline_price_snapshots_expiry_check", sql`${table.expires_at} > ${table.issued_at}`),
  ],
);

export const offlineSyncRecords = pgTable(
  "offline_sync_records",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    register_id: integer("register_id").references(() => cashierRegisters.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").references(() => cashierShifts.id, { onDelete: "restrict" }),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    client_operation_id: varchar("client_operation_id", { length: 100 }).notNull(),
    order_client_request_id: varchar("order_client_request_id", { length: 80 }).notNull(),
    checkout_idempotency_key: varchar("checkout_idempotency_key", { length: 100 }),
    price_snapshot_reference: varchar("price_snapshot_reference", { length: 80 }),
    offline_receipt_number: varchar("offline_receipt_number", { length: 80 }),
    printed_subtotal_amount: integer("printed_subtotal_amount"),
    printed_total_amount: integer("printed_total_amount"),
    printed_tendered_amount: integer("printed_tendered_amount"),
    printed_change_amount: integer("printed_change_amount"),
    status: varchar("status", { length: 20 }).$type<OfflineSyncStatus>().notNull(),
    conflict_code: varchar("conflict_code", { length: 60 }),
    conflict_details: text("conflict_details"),
    order_id: integer("order_id").references(() => orders.id, { onDelete: "restrict" }),
    checkout_id: integer("checkout_id").references(() => orderCheckouts.id, { onDelete: "restrict" }),
    resolved_by: text("resolved_by").references(() => user.id, { onDelete: "restrict" }),
    resolution_reason: text("resolution_reason"),
    resolved_at: timestamp("resolved_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("offline_sync_records_operation_uidx").on(table.client_operation_id),
    index("offline_sync_records_order_request_idx").on(table.order_client_request_id),
    uniqueIndex("offline_sync_records_checkout_key_uidx").on(table.checkout_idempotency_key),
    uniqueIndex("offline_sync_records_receipt_number_uidx").on(table.offline_receipt_number),
    index("offline_sync_records_branch_status_idx").on(table.branch_id, table.status, table.updated_at),
    index("offline_sync_records_actor_idx").on(table.actor_user_id, table.created_at),
    check("offline_sync_records_status_check", sql`${table.status} in ('accepted', 'needs_review', 'resolved')`),
    check("offline_sync_records_conflict_check", sql`(${table.status} = 'accepted' and ${table.conflict_code} is null and ${table.order_id} is not null and (${table.checkout_idempotency_key} is null or ${table.checkout_id} is not null)) or (${table.status} = 'needs_review' and ${table.conflict_code} is not null) or (${table.status} = 'resolved' and ${table.resolved_by} is not null and length(trim(${table.resolution_reason})) >= 3 and ${table.resolved_at} is not null)`),
    check("offline_sync_records_printed_amounts_check", sql`${table.offline_receipt_number} is null or (${table.price_snapshot_reference} is not null and ${table.checkout_idempotency_key} is not null and ${table.printed_subtotal_amount} >= 0 and ${table.printed_total_amount} >= 0 and ${table.printed_tendered_amount} >= ${table.printed_total_amount} and ${table.printed_change_amount} = ${table.printed_tendered_amount} - ${table.printed_total_amount})`),
  ],
);
