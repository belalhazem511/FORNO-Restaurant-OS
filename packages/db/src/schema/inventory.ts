import {
  bigint,
  boolean,
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
  InventoryDimension,
} from "./constants";
import {
  branches,
} from "./restaurant";
import { user } from "../auth-schema";

export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("inventory_locations_branch_code_uidx").on(table.branch_id, table.code), index("inventory_locations_branch_idx").on(table.branch_id)],
);

export const ingredientCategories = pgTable(
  "ingredient_categories",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [uniqueIndex("ingredient_categories_branch_code_uidx").on(table.branch_id, table.code)],
);

export const unitsOfMeasure = pgTable(
  "units_of_measure",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 20 }).notNull(),
    name_en: varchar("name_en", { length: 60 }).notNull(),
    name_ar: varchar("name_ar", { length: 60 }).notNull(),
    dimension: varchar("dimension", { length: 12 }).$type<InventoryDimension>().notNull(),
    base_numerator: bigint("base_numerator", { mode: "number" }).notNull(),
    base_denominator: bigint("base_denominator", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("units_of_measure_code_uidx").on(table.code),
    check("units_of_measure_dimension_check", sql`${table.dimension} in ('mass', 'volume', 'count')`),
    check("units_of_measure_factor_check", sql`${table.base_numerator} > 0 and ${table.base_denominator} > 0`),
  ],
);

export const ingredients = pgTable(
  "ingredients",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    category_id: integer("category_id").notNull().references(() => ingredientCategories.id, { onDelete: "restrict" }),
    sku: varchar("sku", { length: 40 }).notNull(),
    name_en: varchar("name_en", { length: 120 }).notNull(),
    name_ar: varchar("name_ar", { length: 120 }).notNull(),
    base_unit_id: integer("base_unit_id").notNull().references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    dimension: varchar("dimension", { length: 12 }).$type<InventoryDimension>().notNull(),
    default_location_id: integer("default_location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    is_active: boolean("is_active").default(true).notNull(),
    is_tracked: boolean("is_tracked").default(true).notNull(),
    reorder_level: bigint("reorder_level", { mode: "number" }).default(0).notNull(),
    low_stock_threshold: bigint("low_stock_threshold", { mode: "number" }).default(0).notNull(),
    par_level: bigint("par_level", { mode: "number" }),
    allow_negative: boolean("allow_negative").default(false).notNull(),
    average_unit_cost_micros: bigint("average_unit_cost_micros", { mode: "number" }).default(0).notNull(),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    updated_by: text("updated_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ingredients_branch_sku_uidx").on(table.branch_id, table.sku),
    index("ingredients_branch_category_idx").on(table.branch_id, table.category_id),
    check("ingredients_dimension_check", sql`${table.dimension} in ('mass', 'volume', 'count')`),
    check("ingredients_thresholds_check", sql`${table.reorder_level} >= 0 and ${table.low_stock_threshold} >= 0 and (${table.par_level} is null or ${table.par_level} >= 0)`),
    check("ingredients_average_cost_check", sql`${table.average_unit_cost_micros} >= 0`),
  ],
);

export const ingredientPackageConversions = pgTable(
  "ingredient_package_conversions",
  {
    id: serial("id").primaryKey(),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 24 }).notNull(),
    name_en: varchar("name_en", { length: 60 }).notNull(),
    name_ar: varchar("name_ar", { length: 60 }).notNull(),
    base_numerator: bigint("base_numerator", { mode: "number" }).notNull(),
    base_denominator: bigint("base_denominator", { mode: "number" }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("ingredient_packages_ingredient_code_uidx").on(table.ingredient_id, table.code),
    check("ingredient_packages_factor_check", sql`${table.base_numerator} > 0 and ${table.base_denominator} > 0`),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    quantity_base: bigint("quantity_base", { mode: "number" }).default(0).notNull(),
    average_unit_cost_micros: bigint("average_unit_cost_micros", { mode: "number" }).default(0).notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stock_balances_location_ingredient_uidx").on(table.location_id, table.ingredient_id),
    index("stock_balances_branch_idx").on(table.branch_id),
    check("stock_balances_average_cost_check", sql`${table.average_unit_cost_micros} >= 0`),
  ],
);
