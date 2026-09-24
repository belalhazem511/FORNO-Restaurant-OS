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
import type { RecipeStatus } from "./constants";
import {
  branches,
  menuItems,
  menuItemVariants,
  modifierOptions,
} from "./restaurant";
import {
  orders,
  orderItems,
} from "./orders";
import {
  ingredients,
  inventoryLocations,
  unitsOfMeasure,
} from "./inventory";
import { user } from "../auth-schema";

export const recipeVersions = pgTable(
  "recipe_versions",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    menu_item_id: integer("menu_item_id").notNull().references(() => menuItems.id, { onDelete: "restrict" }),
    variant_id: integer("variant_id").references(() => menuItemVariants.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: varchar("status", { length: 12 }).$type<RecipeStatus>().default("draft").notNull(),
    effective_at: timestamp("effective_at"),
    yield_loss_bps: integer("yield_loss_bps").default(0).notNull(),
    authored_by: text("authored_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    approved_at: timestamp("approved_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("recipe_versions_configuration_version_uidx").on(table.menu_item_id, table.variant_id, table.version),
    uniqueIndex("recipe_versions_base_version_uidx").on(table.menu_item_id, table.version).where(sql`${table.variant_id} is null`),
    uniqueIndex("recipe_versions_active_base_uidx").on(table.menu_item_id).where(sql`${table.status} = 'active' and ${table.variant_id} is null`),
    uniqueIndex("recipe_versions_active_variant_uidx").on(table.menu_item_id, table.variant_id).where(sql`${table.status} = 'active' and ${table.variant_id} is not null`),
    index("recipe_versions_branch_status_idx").on(table.branch_id, table.status),
    check("recipe_versions_version_check", sql`${table.version} > 0`),
    check("recipe_versions_status_check", sql`${table.status} in ('draft', 'active', 'retired')`),
    check("recipe_versions_yield_check", sql`${table.yield_loss_bps} >= 0 and ${table.yield_loss_bps} < 10000`),
  ],
);

export const recipeComponents = pgTable(
  "recipe_components",
  {
    id: serial("id").primaryKey(),
    recipe_version_id: integer("recipe_version_id").notNull().references(() => recipeVersions.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    source_location_id: integer("source_location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    modifier_option_id: integer("modifier_option_id").references(() => modifierOptions.id, { onDelete: "restrict" }),
    unit_id: integer("unit_id").notNull().references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    quantity_input_scaled: bigint("quantity_input_scaled", { mode: "number" }).notNull(),
    quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("recipe_components_unambiguous_uidx").on(table.recipe_version_id, table.ingredient_id, table.source_location_id, table.modifier_option_id),
    uniqueIndex("recipe_components_base_uidx").on(table.recipe_version_id, table.ingredient_id, table.source_location_id).where(sql`${table.modifier_option_id} is null`),
    index("recipe_components_recipe_idx").on(table.recipe_version_id),
    check("recipe_components_quantity_check", sql`${table.quantity_input_scaled} <> 0 and ${table.quantity_base} <> 0`),
  ],
);

export const orderInventoryIssues = pgTable(
  "order_inventory_issues",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    idempotency_key: varchar("idempotency_key", { length: 120 }).notNull(),
    status: varchar("status", { length: 16 }).default("issued").notNull(),
    total_cogs_amount: integer("total_cogs_amount").notNull(),
    issued_by: text("issued_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    issued_at: timestamp("issued_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("order_inventory_issues_order_uidx").on(table.order_id),
    uniqueIndex("order_inventory_issues_idempotency_uidx").on(table.idempotency_key),
    check("order_inventory_issues_status_check", sql`${table.status} in ('issued', 'returned', 'discarded')`),
    check("order_inventory_issues_cost_check", sql`${table.total_cogs_amount} >= 0`),
  ],
);

export const orderInventoryConsumptions = pgTable(
  "order_inventory_consumptions",
  {
    id: serial("id").primaryKey(),
    issue_id: integer("issue_id").notNull().references(() => orderInventoryIssues.id, { onDelete: "restrict" }),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    order_item_id: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
    recipe_version_id: integer("recipe_version_id").notNull().references(() => recipeVersions.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
    unit_cost_micros: bigint("unit_cost_micros", { mode: "number" }).notNull(),
    total_cost_amount: integer("total_cost_amount").notNull(),
  },
  (table) => [
    uniqueIndex("order_inventory_consumptions_snapshot_uidx").on(table.issue_id, table.order_item_id, table.ingredient_id, table.location_id),
    index("order_inventory_consumptions_order_idx").on(table.order_id),
    check("order_inventory_consumptions_values_check", sql`${table.quantity_base} > 0 and ${table.unit_cost_micros} >= 0 and ${table.total_cost_amount} >= 0`),
  ],
);

export const orderItemCogs = pgTable(
  "order_item_cogs",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    order_item_id: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
    recipe_version_id: integer("recipe_version_id").notNull().references(() => recipeVersions.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    total_cogs_amount: integer("total_cogs_amount").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("order_item_cogs_item_uidx").on(table.order_item_id),
    check("order_item_cogs_values_check", sql`${table.quantity} > 0 and ${table.total_cogs_amount} >= 0`),
  ],
);
