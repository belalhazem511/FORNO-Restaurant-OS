import { check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar, bigserial } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./restaurant";
import { cashierRegisters } from "./finance";
import { user } from "../auth-schema";

export const syncOrganizations = pgTable("sync_organizations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  remote_organization_id: varchar("remote_organization_id", { length: 36 }),
  name: varchar("name", { length: 160 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const syncOrganizationBranches = pgTable("sync_organization_branches", {
  id: serial("id").primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  global_branch_id: varchar("global_branch_id", { length: 36 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sync_org_branches_branch_uidx").on(table.branch_id),
  uniqueIndex("sync_org_branches_global_uidx").on(table.organization_id, table.global_branch_id),
]);

export const syncGlobalEntities = pgTable("sync_global_entities", {
  id: serial("id").primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
  entity_type: varchar("entity_type", { length: 64 }).notNull(),
  global_id: varchar("global_id", { length: 36 }).notNull(),
  local_id: varchar("local_id", { length: 100 }).notNull(),
  server_revision: integer("server_revision").default(1).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sync_global_entities_id_uidx").on(table.organization_id, table.entity_type, table.global_id),
  uniqueIndex("sync_global_entities_local_uidx").on(table.organization_id, table.entity_type, table.local_id),
  index("sync_global_entities_branch_idx").on(table.organization_id, table.branch_id, table.entity_type),
  check("sync_global_entities_revision_check", sql`${table.server_revision} > 0`),
]);

export const syncDevices = pgTable("sync_devices", {
  id: varchar("id", { length: 36 }).primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  display_name: varchar("display_name", { length: 120 }).notNull(),
  credential_hash: varchar("credential_hash", { length: 64 }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  register_id: integer("register_id").notNull().references(() => cashierRegisters.id, { onDelete: "restrict" }),
  status: varchar("status", { length: 20 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  last_seen_at: timestamp("last_seen_at"),
  revoked_at: timestamp("revoked_at"),
  last_synchronized_at: timestamp("last_synchronized_at"),
}, (table) => [
  uniqueIndex("sync_devices_credential_hash_uidx").on(table.credential_hash),
  index("sync_devices_org_status_idx").on(table.organization_id, table.status),
  check("sync_devices_status_check", sql`${table.status} in ('local_only', 'paired', 'revoked')`),
]);

export const syncPairingCodes = pgTable("sync_pairing_codes", {
  id: serial("id").primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  register_id: integer("register_id").notNull().references(() => cashierRegisters.id, { onDelete: "restrict" }),
  code_hash: varchar("code_hash", { length: 64 }).notNull(),
  created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
  created_at: timestamp("created_at").defaultNow().notNull(),
  expires_at: timestamp("expires_at").notNull(),
  consumed_at: timestamp("consumed_at"),
}, (table) => [
  uniqueIndex("sync_pairing_codes_hash_uidx").on(table.code_hash),
  index("sync_pairing_codes_scope_idx").on(table.organization_id, table.expires_at),
  check("sync_pairing_codes_expiry_check", sql`${table.expires_at} > ${table.created_at}`),
]);

export const syncEntityMappings = pgTable("sync_entity_mappings", {
  id: serial("id").primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  device_id: varchar("device_id", { length: 36 }).notNull().references(() => syncDevices.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
  entity_type: varchar("entity_type", { length: 64 }).notNull(),
  global_id: varchar("global_id", { length: 36 }).notNull(),
  local_id: varchar("local_id", { length: 100 }).notNull(),
  local_revision: integer("local_revision").default(1).notNull(),
  server_revision: integer("server_revision").default(0).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sync_entity_mappings_local_uidx").on(table.device_id, table.entity_type, table.local_id),
  uniqueIndex("sync_entity_mappings_device_global_uidx").on(table.device_id, table.entity_type, table.global_id),
  index("sync_entity_mappings_branch_idx").on(table.organization_id, table.branch_id, table.entity_type),
  check("sync_entity_mappings_revision_check", sql`${table.local_revision} > 0 and ${table.server_revision} >= 0`),
]);

export const syncOutbox = pgTable("sync_outbox", {
  id: serial("id").primaryKey(),
  operation_id: varchar("operation_id", { length: 36 }).notNull(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  device_id: varchar("device_id", { length: 36 }).notNull().references(() => syncDevices.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  register_id: integer("register_id").references(() => cashierRegisters.id, { onDelete: "restrict" }),
  actor_global_id: varchar("actor_global_id", { length: 36 }).notNull(),
  domain: varchar("domain", { length: 40 }).notNull(),
  action: varchar("action", { length: 60 }).notNull(),
  schema_version: integer("schema_version").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  payload_hash: varchar("payload_hash", { length: 64 }).notNull(),
  idempotency_key: varchar("idempotency_key", { length: 120 }).notNull(),
  base_revision: integer("base_revision").default(0).notNull(),
  dependencies: jsonb("dependencies").$type<string[]>().default([]).notNull(),
  device_timestamp: timestamp("device_timestamp").notNull(),
  state: varchar("state", { length: 20 }).default("pending").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  last_error: text("last_error"),
  server_result: jsonb("server_result").$type<Record<string, unknown>>(),
  acknowledged_at: timestamp("acknowledged_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sync_outbox_operation_uidx").on(table.operation_id),
  uniqueIndex("sync_outbox_device_idempotency_uidx").on(table.device_id, table.idempotency_key),
  index("sync_outbox_pending_idx").on(table.device_id, table.state, table.id),
  check("sync_outbox_state_check", sql`${table.state} in ('pending', 'syncing', 'accepted', 'needs_review', 'rejected')`),
  check("sync_outbox_attempts_check", sql`${table.attempts} >= 0 and ${table.schema_version} > 0 and ${table.base_revision} >= 0`),
]);

export const syncCommandInbox = pgTable("sync_command_inbox", {
  id: serial("id").primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  device_id: varchar("device_id", { length: 36 }).notNull().references(() => syncDevices.id, { onDelete: "restrict" }),
  operation_id: varchar("operation_id", { length: 36 }).notNull(),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  actor_global_id: varchar("actor_global_id", { length: 36 }).notNull(),
  domain: varchar("domain", { length: 40 }).notNull(),
  action: varchar("action", { length: 60 }).notNull(),
  schema_version: integer("schema_version").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  payload_hash: varchar("payload_hash", { length: 64 }).notNull(),
  idempotency_key: varchar("idempotency_key", { length: 120 }).notNull(),
  state: varchar("state", { length: 20 }).notNull(),
  result: jsonb("result").$type<Record<string, unknown>>(),
  received_at: timestamp("received_at").defaultNow().notNull(),
  processed_at: timestamp("processed_at"),
}, (table) => [
  uniqueIndex("sync_inbox_device_operation_uidx").on(table.device_id, table.operation_id),
  uniqueIndex("sync_inbox_device_idempotency_uidx").on(table.device_id, table.idempotency_key),
  index("sync_inbox_branch_state_idx").on(table.organization_id, table.branch_id, table.state, table.received_at),
  check("sync_inbox_state_check", sql`${table.state} in ('accepted', 'already_applied', 'needs_review', 'rejected', 'retry_later')`),
]);

export const syncChangeLog = pgTable("sync_change_log", {
  cursor: bigserial("cursor", { mode: "number" }).primaryKey(),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  domain: varchar("domain", { length: 40 }).notNull(),
  entity_type: varchar("entity_type", { length: 64 }).notNull(),
  entity_global_id: varchar("entity_global_id", { length: 36 }).notNull(),
  action: varchar("action", { length: 60 }).notNull(),
  server_revision: integer("server_revision").notNull(),
  source_operation_id: varchar("source_operation_id", { length: 36 }).notNull(),
  changed_at: timestamp("changed_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sync_change_log_source_operation_uidx").on(table.organization_id, table.source_operation_id, table.entity_global_id),
  index("sync_change_log_pull_idx").on(table.organization_id, table.branch_id, table.cursor),
  check("sync_change_log_revision_check", sql`${table.server_revision} > 0`),
]);

export const syncConflicts = pgTable("sync_conflicts", {
  id: serial("id").primaryKey(),
  inbox_id: integer("inbox_id").notNull().references(() => syncCommandInbox.id, { onDelete: "restrict" }),
  organization_id: varchar("organization_id", { length: 36 }).notNull().references(() => syncOrganizations.id, { onDelete: "restrict" }),
  branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  entity_type: varchar("entity_type", { length: 64 }).notNull(),
  entity_global_id: varchar("entity_global_id", { length: 36 }).notNull(),
  local_payload: jsonb("local_payload").$type<Record<string, unknown>>().notNull(),
  server_snapshot: jsonb("server_snapshot").$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  state: varchar("state", { length: 20 }).default("needs_review").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  resolved_at: timestamp("resolved_at"),
}, (table) => [
  uniqueIndex("sync_conflicts_inbox_entity_uidx").on(table.inbox_id, table.entity_type, table.entity_global_id),
  index("sync_conflicts_review_idx").on(table.organization_id, table.branch_id, table.state, table.created_at),
  check("sync_conflicts_state_check", sql`${table.state} in ('needs_review', 'resolved')`),
]);
