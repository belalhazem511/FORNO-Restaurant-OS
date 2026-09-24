import { boolean, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { StaffRole } from "./constants";
import { user } from "../auth-schema";

export const branches = pgTable(
  "branches",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 120 }).notNull(),
    name_ar: varchar("name_ar", { length: 120 }).notNull(),
    address_en: text("address_en"),
    address_ar: text("address_ar"),
    phone: varchar("phone", { length: 24 }),
    currency: varchar("currency", { length: 3 }).default("EGP").notNull(),
    timezone: varchar("timezone", { length: 64 }).default("Africa/Cairo").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("branches_code_uidx").on(table.code)],
);

export const staffAssignments = pgTable(
  "staff_assignments",
  {
    id: serial("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).$type<StaffRole>().notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("staff_assignments_user_branch_uidx").on(table.user_id, table.branch_id),
    index("staff_assignments_branch_role_idx").on(table.branch_id, table.role),
    check("staff_assignments_role_check", sql`${table.role} in ('owner', 'admin', 'manager', 'cashier')`),
  ],
);

export const diningAreas = pgTable(
  "dining_areas",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 120 }).notNull(),
    name_ar: varchar("name_ar", { length: 120 }).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("dining_areas_branch_code_uidx").on(table.branch_id, table.code),
    index("dining_areas_branch_idx").on(table.branch_id),
  ],
);

export const restaurantTables = pgTable(
  "restaurant_tables",
  {
    id: serial("id").primaryKey(),
    dining_area_id: integer("dining_area_id").notNull().references(() => diningAreas.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 80 }).notNull(),
    name_ar: varchar("name_ar", { length: 80 }).notNull(),
    capacity: integer("capacity").default(4).notNull(),
    status: varchar("status", { length: 20 }).default("available").notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("restaurant_tables_area_code_uidx").on(table.dining_area_id, table.code),
    index("restaurant_tables_area_idx").on(table.dining_area_id),
    check("restaurant_tables_capacity_check", sql`${table.capacity} > 0`),
    check("restaurant_tables_status_check", sql`${table.status} in ('available', 'occupied', 'reserved', 'out_of_service')`),
  ],
);

export const kitchenStations = pgTable(
  "kitchen_stations",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 80 }).notNull(),
    name_ar: varchar("name_ar", { length: 80 }).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("kitchen_stations_branch_code_uidx").on(table.branch_id, table.code),
    index("kitchen_stations_branch_idx").on(table.branch_id),
  ],
);

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("menu_categories_branch_code_uidx").on(table.branch_id, table.code),
    index("menu_categories_branch_idx").on(table.branch_id),
  ],
);

// Kept as a backwards-compatible inventory/POS view of saleable menu items.

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    price: integer("price").notNull(),
    in_stock: integer("in_stock").notNull(),
    user_uid: varchar("user_uid", { length: 255 }).notNull(),
    category: varchar("category", { length: 50 }),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("products_user_name_uidx").on(table.user_uid, table.name),
    index("products_user_idx").on(table.user_uid),
    check("products_price_check", sql`${table.price} >= 0`),
    check("products_stock_check", sql`${table.in_stock} >= 0`),
  ],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: serial("id").primaryKey(),
    category_id: integer("category_id").notNull().references(() => menuCategories.id, { onDelete: "restrict" }),
    kitchen_station_id: integer("kitchen_station_id").notNull().references(() => kitchenStations.id, { onDelete: "restrict" }),
    product_id: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    code: varchar("code", { length: 40 }).notNull(),
    name_en: varchar("name_en", { length: 160 }).notNull(),
    name_ar: varchar("name_ar", { length: 160 }).notNull(),
    description_en: text("description_en"),
    description_ar: text("description_ar"),
    base_price: integer("base_price").notNull(),
    is_available: boolean("is_available").default(true).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("menu_items_code_uidx").on(table.code),
    uniqueIndex("menu_items_product_uidx").on(table.product_id),
    index("menu_items_category_idx").on(table.category_id),
    index("menu_items_station_idx").on(table.kitchen_station_id),
    check("menu_items_base_price_check", sql`${table.base_price} >= 0`),
  ],
);

export const menuItemVariants = pgTable(
  "menu_item_variants",
  {
    id: serial("id").primaryKey(),
    menu_item_id: integer("menu_item_id").notNull().references(() => menuItems.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    price: integer("price").notNull(),
    is_default: boolean("is_default").default(false).notNull(),
    is_available: boolean("is_available").default(true).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("menu_item_variants_item_code_uidx").on(table.menu_item_id, table.code),
    index("menu_item_variants_item_idx").on(table.menu_item_id),
    check("menu_item_variants_price_check", sql`${table.price} >= 0`),
  ],
);

export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 40 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    min_selections: integer("min_selections").default(0).notNull(),
    max_selections: integer("max_selections").default(1).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    is_active: boolean("is_active").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("modifier_groups_branch_code_uidx").on(table.branch_id, table.code),
    index("modifier_groups_branch_idx").on(table.branch_id),
    check("modifier_groups_selection_check", sql`${table.min_selections} >= 0 and ${table.max_selections} >= ${table.min_selections}`),
  ],
);

export const modifierOptions = pgTable(
  "modifier_options",
  {
    id: serial("id").primaryKey(),
    modifier_group_id: integer("modifier_group_id").notNull().references(() => modifierGroups.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 40 }).notNull(),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    price_delta: integer("price_delta").default(0).notNull(),
    is_default: boolean("is_default").default(false).notNull(),
    is_available: boolean("is_available").default(true).notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("modifier_options_group_code_uidx").on(table.modifier_group_id, table.code),
    index("modifier_options_group_idx").on(table.modifier_group_id),
    check("modifier_options_price_check", sql`${table.price_delta} >= 0`),
  ],
);

export const menuItemModifierGroups = pgTable(
  "menu_item_modifier_groups",
  {
    menu_item_id: integer("menu_item_id").notNull().references(() => menuItems.id, { onDelete: "cascade" }),
    modifier_group_id: integer("modifier_group_id").notNull().references(() => modifierGroups.id, { onDelete: "cascade" }),
    sort_order: integer("sort_order").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("menu_item_modifier_groups_uidx").on(table.menu_item_id, table.modifier_group_id),
    index("menu_item_modifier_groups_group_idx").on(table.modifier_group_id),
  ],
);

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }),
  created_at: timestamp("created_at").defaultNow(),
});
