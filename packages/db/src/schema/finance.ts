import { boolean, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PrintPaperWidth, PrintLanguage } from "./constants";
import { branches } from "./restaurant";
import { orders } from "./orders";
import { user } from "../auth-schema";

export const cashierRegisters = pgTable(
  "cashier_registers",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("cashier_registers_branch_code_uidx").on(table.branch_id, table.code),
    index("cashier_registers_branch_idx").on(table.branch_id),
  ],
);

export const registerPrintPreferences = pgTable(
  "register_print_preferences",
  {
    id: serial("id").primaryKey(),
    register_id: integer("register_id").notNull().references(() => cashierRegisters.id, { onDelete: "cascade" }),
    paper_width: integer("paper_width").$type<PrintPaperWidth>().default(80).notNull(),
    language: varchar("language", { length: 12 }).$type<PrintLanguage>().default("bilingual").notNull(),
    receipt_copies: integer("receipt_copies").default(1).notNull(),
    kot_copies: integer("kot_copies").default(1).notNull(),
    updated_by: text("updated_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("register_print_preferences_register_uidx").on(table.register_id),
    check("register_print_preferences_width_check", sql`${table.paper_width} in (58, 80)`),
    check("register_print_preferences_language_check", sql`${table.language} in ('ar', 'en', 'bilingual')`),
    check("register_print_preferences_copies_check", sql`${table.receipt_copies} between 1 and 5 and ${table.kot_copies} between 1 and 5`),
  ],
);

export const cashierShifts = pgTable(
  "cashier_shifts",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    register_id: integer("register_id").notNull().references(() => cashierRegisters.id, { onDelete: "restrict" }),
    cashier_user_id: text("cashier_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    opened_by: text("opened_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    closed_by: text("closed_by").references(() => user.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 12 }).default("open").notNull(),
    opening_float: integer("opening_float").notNull(),
    expected_cash: integer("expected_cash"),
    closing_cash: integer("closing_cash"),
    variance: integer("variance"),
    opened_at: timestamp("opened_at").defaultNow().notNull(),
    closed_at: timestamp("closed_at"),
  },
  (table) => [
    uniqueIndex("cashier_shifts_open_register_uidx").on(table.register_id).where(sql`${table.status} = 'open'`),
    uniqueIndex("cashier_shifts_open_cashier_uidx").on(table.cashier_user_id).where(sql`${table.status} = 'open'`),
    index("cashier_shifts_branch_opened_idx").on(table.branch_id, table.opened_at),
    check("cashier_shifts_status_check", sql`${table.status} in ('open', 'closed')`),
    check("cashier_shifts_opening_float_check", sql`${table.opening_float} >= 0`),
    check("cashier_shifts_close_check", sql`(${table.status} = 'open' and ${table.closed_at} is null and ${table.closing_cash} is null and ${table.variance} is null) or (${table.status} = 'closed' and ${table.closed_at} is not null and ${table.closing_cash} is not null and ${table.expected_cash} is not null and ${table.variance} is not null)`),
  ],
);

export const shiftCashMovements = pgTable(
  "shift_cash_movements",
  {
    id: serial("id").primaryKey(),
    shift_id: integer("shift_id").notNull().references(() => cashierShifts.id, { onDelete: "restrict" }),
    type: varchar("type", { length: 12 }).notNull(),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("shift_cash_movements_shift_idx").on(table.shift_id),
    check("shift_cash_movements_type_check", sql`${table.type} in ('cash_in', 'cash_out')`),
    check("shift_cash_movements_amount_check", sql`${table.amount} > 0`),
    check("shift_cash_movements_reason_check", sql`length(trim(${table.reason})) > 0`),
  ],
);

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 24 }),
    name: varchar("name", { length: 50 }).notNull().unique(),
    affects_drawer: boolean("affects_drawer").default(false).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [uniqueIndex("payment_methods_code_uidx").on(table.code)],
);

export const orderCheckouts = pgTable(
  "order_checkouts",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").notNull().references(() => cashierShifts.id, { onDelete: "restrict" }),
    idempotency_key: varchar("idempotency_key", { length: 100 }).notNull(),
    subtotal_amount: integer("subtotal_amount").notNull(),
    discount_amount: integer("discount_amount").default(0).notNull(),
    payable_amount: integer("payable_amount").notNull(),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("order_checkouts_order_uidx").on(table.order_id),
    uniqueIndex("order_checkouts_idempotency_uidx").on(table.idempotency_key),
    index("order_checkouts_shift_idx").on(table.shift_id),
    check("order_checkouts_amounts_check", sql`${table.subtotal_amount} >= 0 and ${table.discount_amount} >= 0 and ${table.payable_amount} >= 0 and ${table.payable_amount} = ${table.subtotal_amount} - ${table.discount_amount}`),
  ],
);

export const orderPayments = pgTable(
  "order_payments",
  {
    id: serial("id").primaryKey(),
    checkout_id: integer("checkout_id").references(() => orderCheckouts.id, { onDelete: "restrict" }),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").notNull().references(() => cashierShifts.id, { onDelete: "restrict" }),
    payment_method_id: integer("payment_method_id").notNull().references(() => paymentMethods.id, { onDelete: "restrict" }),
    kind: varchar("kind", { length: 12 }).default("payment").notNull(),
    amount: integer("amount").notNull(),
    tendered_amount: integer("tendered_amount"),
    change_amount: integer("change_amount").default(0).notNull(),
    original_payment_id: integer("original_payment_id").references((): AnyPgColumn => orderPayments.id, { onDelete: "restrict" }),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("order_payments_order_idx").on(table.order_id),
    index("order_payments_shift_method_idx").on(table.shift_id, table.payment_method_id),
    uniqueIndex("order_payments_refund_original_uidx").on(table.original_payment_id).where(sql`${table.kind} = 'refund'`),
    check("order_payments_kind_check", sql`${table.kind} in ('payment', 'refund')`),
    check("order_payments_amount_check", sql`${table.amount} > 0`),
    check("order_payments_change_check", sql`${table.change_amount} >= 0 and (${table.tendered_amount} is null or ${table.tendered_amount} >= ${table.amount})`),
  ],
);

export const orderCancellations = pgTable(
  "order_cancellations",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").references(() => cashierShifts.id, { onDelete: "restrict" }),
    idempotency_key: varchar("idempotency_key", { length: 100 }).notNull(),
    reason: text("reason").notNull(),
    was_paid: boolean("was_paid").notNull(),
    cancelled_by: text("cancelled_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    inventory_disposition: varchar("inventory_disposition", { length: 24 }),
    inventory_resolved_by: text("inventory_resolved_by").references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("order_cancellations_order_uidx").on(table.order_id),
    uniqueIndex("order_cancellations_idempotency_uidx").on(table.idempotency_key),
    check("order_cancellations_reason_check", sql`length(trim(${table.reason})) > 0`),
    check("order_cancellations_inventory_disposition_check", sql`${table.inventory_disposition} is null or ${table.inventory_disposition} in ('returned_unused', 'prepared_discarded')`),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").references(() => cashierShifts.id, { onDelete: "restrict" }),
    order_id: integer("order_id").references(() => orders.id, { onDelete: "restrict" }),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    approver_user_id: text("approver_user_id").references(() => user.id, { onDelete: "restrict" }),
    action: varchar("action", { length: 60 }).notNull(),
    entity_type: varchar("entity_type", { length: 40 }).notNull(),
    entity_id: varchar("entity_id", { length: 80 }),
    reason: text("reason"),
    details: text("details"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_branch_created_idx").on(table.branch_id, table.created_at),
    index("audit_logs_order_idx").on(table.order_id),
    index("audit_logs_shift_idx").on(table.shift_id),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    description: text("description"),
    order_id: integer("order_id").references(() => orders.id),
    shift_id: integer("shift_id").references(() => cashierShifts.id, { onDelete: "restrict" }),
    order_payment_id: integer("order_payment_id").references(() => orderPayments.id, { onDelete: "restrict" }).unique(),
    original_transaction_id: integer("original_transaction_id").references((): AnyPgColumn => transactions.id, { onDelete: "restrict" }),
    payment_method_id: integer("payment_method_id").references(() => paymentMethods.id),
    amount: integer("amount").notNull(),
    user_uid: varchar("user_uid", { length: 255 }).notNull(),
    type: varchar("type", { length: 20 }),
    category: varchar("category", { length: 100 }),
    status: varchar("status", { length: 20 }),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("transactions_order_idx").on(table.order_id),
    index("transactions_shift_idx").on(table.shift_id),
    uniqueIndex("transactions_refund_original_uidx").on(table.original_transaction_id).where(sql`${table.category} = 'refund'`),
    check("transactions_amount_check", sql`${table.amount} > 0`),
    check("transactions_type_check", sql`${table.type} is null or ${table.type} in ('income', 'expense')`),
    check("transactions_status_check", sql`${table.status} is null or ${table.status} in ('pending', 'completed')`),
  ],
);
