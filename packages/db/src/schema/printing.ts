import { boolean, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PrintDocumentType, PrintJobStatus, PrintPaperWidth, PrintLanguage } from "./constants";
import { orders } from "./orders";
import { kitchenStations } from "./restaurant";
import { cashierRegisters, cashierShifts } from "./finance";
import { user } from "../auth-schema";

export const printJobs = pgTable(
  "print_jobs",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    station_id: integer("station_id").references(() => kitchenStations.id, { onDelete: "restrict" }),
    register_id: integer("register_id").references(() => cashierRegisters.id, { onDelete: "restrict" }),
    shift_id: integer("shift_id").references(() => cashierShifts.id, { onDelete: "restrict" }),
    requested_by: text("requested_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    document_type: varchar("document_type", { length: 20 }).$type<PrintDocumentType>().notNull(),
    status: varchar("status", { length: 20 }).$type<PrintJobStatus>().default("requested").notNull(),
    is_reprint: boolean("is_reprint").default(false).notNull(),
    idempotency_key: varchar("idempotency_key", { length: 120 }).notNull(),
    copy_count: integer("copy_count").notNull(),
    paper_width: integer("paper_width").$type<PrintPaperWidth>().notNull(),
    language: varchar("language", { length: 12 }).$type<PrintLanguage>().notNull(),
    reprint_reason: text("reprint_reason"),
    error_message: text("error_message"),
    requested_at: timestamp("requested_at").defaultNow().notNull(),
    previewed_at: timestamp("previewed_at"),
    acknowledged_at: timestamp("acknowledged_at"),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("print_jobs_idempotency_uidx").on(table.idempotency_key),
    uniqueIndex("print_jobs_initial_kot_uidx").on(table.order_id, table.station_id).where(sql`${table.document_type} = 'kot' and ${table.is_reprint} = false`),
    uniqueIndex("print_jobs_initial_document_uidx").on(table.order_id, table.document_type).where(sql`${table.document_type} <> 'kot' and ${table.is_reprint} = false`),
    index("print_jobs_order_requested_idx").on(table.order_id, table.requested_at),
    index("print_jobs_branch_register_idx").on(table.register_id, table.requested_at),
    index("print_jobs_status_idx").on(table.status),
    check("print_jobs_document_type_check", sql`${table.document_type} in ('receipt', 'order_summary', 'kot', 'refund', 'reversal')`),
    check("print_jobs_status_check", sql`${table.status} in ('requested', 'previewed', 'acknowledged', 'failed', 'cancelled')`),
    check("print_jobs_station_check", sql`(${table.document_type} = 'kot' and ${table.station_id} is not null) or (${table.document_type} <> 'kot' and ${table.station_id} is null)`),
    check("print_jobs_width_check", sql`${table.paper_width} in (58, 80)`),
    check("print_jobs_language_check", sql`${table.language} in ('ar', 'en', 'bilingual')`),
    check("print_jobs_copy_count_check", sql`${table.copy_count} between 1 and 5`),
    check("print_jobs_reprint_check", sql`(${table.is_reprint} = true and length(trim(${table.reprint_reason})) >= 3 and ${table.approved_by} is not null) or (${table.is_reprint} = false and ${table.reprint_reason} is null)`),
  ],
);
