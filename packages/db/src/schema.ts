import { relations, sql } from "drizzle-orm";
import {
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

export {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
} from "./auth-schema";

export const ORDER_TYPES = ["dine_in", "takeaway", "delivery"] as const;
export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "served",
  "collected",
  "delivered",
  "completed",
  "cancelled",
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

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

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    customer_id: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    dining_table_id: integer("dining_table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
    client_request_id: varchar("client_request_id", { length: 80 }),
    order_type: varchar("order_type", { length: 20 }).$type<OrderType>().default("takeaway").notNull(),
    total_amount: integer("total_amount").notNull(),
    delivery_address: text("delivery_address"),
    user_uid: varchar("user_uid", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).$type<OrderStatus>().default("pending").notNull(),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("orders_client_request_uidx").on(table.client_request_id),
    index("orders_branch_status_idx").on(table.branch_id, table.status),
    index("orders_customer_idx").on(table.customer_id),
    index("orders_table_idx").on(table.dining_table_id),
    index("orders_user_idx").on(table.user_uid),
    check("orders_total_check", sql`${table.total_amount} >= 0`),
    check("orders_type_check", sql`${table.order_type} in ('dine_in', 'takeaway', 'delivery')`),
    check("orders_status_check", sql`${table.status} in ('pending', 'confirmed', 'preparing', 'ready', 'served', 'collected', 'delivered', 'completed', 'cancelled')`),
    check("orders_fulfilment_check", sql`(${table.order_type} = 'dine_in' and ${table.dining_table_id} is not null and ${table.delivery_address} is null) or (${table.order_type} = 'takeaway' and ${table.dining_table_id} is null and ${table.delivery_address} is null) or (${table.order_type} = 'delivery' and ${table.dining_table_id} is null and ${table.delivery_address} is not null)`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    product_id: integer("product_id").references(() => products.id, { onDelete: "restrict" }),
    menu_item_id: integer("menu_item_id").references(() => menuItems.id, { onDelete: "restrict" }),
    variant_id: integer("variant_id").references(() => menuItemVariants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    price: integer("price").notNull(),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("order_items_order_idx").on(table.order_id),
    index("order_items_product_idx").on(table.product_id),
    check("order_items_quantity_check", sql`${table.quantity} > 0`),
    check("order_items_price_check", sql`${table.price} >= 0`),
    check("order_items_source_check", sql`${table.product_id} is not null or ${table.menu_item_id} is not null`),
  ],
);

export const orderItemModifiers = pgTable(
  "order_item_modifiers",
  {
    id: serial("id").primaryKey(),
    order_item_id: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
    modifier_option_id: integer("modifier_option_id").notNull().references(() => modifierOptions.id, { onDelete: "restrict" }),
    name_en: varchar("name_en", { length: 100 }).notNull(),
    name_ar: varchar("name_ar", { length: 100 }).notNull(),
    price_delta: integer("price_delta").notNull(),
  },
  (table) => [
    uniqueIndex("order_item_modifiers_uidx").on(table.order_item_id, table.modifier_option_id),
    index("order_item_modifiers_item_idx").on(table.order_item_id),
    check("order_item_modifiers_price_check", sql`${table.price_delta} >= 0`),
  ],
);

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: serial("id").primaryKey(),
    order_id: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    from_status: varchar("from_status", { length: 20 }).$type<OrderStatus>(),
    to_status: varchar("to_status", { length: 20 }).$type<OrderStatus>().notNull(),
    changed_by: varchar("changed_by", { length: 255 }).notNull(),
    note: text("note"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("order_status_history_order_created_idx").on(table.order_id, table.created_at)],
);

export const paymentMethods = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  description: text("description"),
  order_id: integer("order_id").references(() => orders.id),
  payment_method_id: integer("payment_method_id").references(() => paymentMethods.id),
  amount: integer("amount").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  type: varchar("type", { length: 20 }),
  category: varchar("category", { length: 100 }),
  status: varchar("status", { length: 20 }),
  created_at: timestamp("created_at").defaultNow(),
});

export const branchesRelations = relations(branches, ({ many }) => ({ diningAreas: many(diningAreas), kitchenStations: many(kitchenStations), menuCategories: many(menuCategories), modifierGroups: many(modifierGroups), orders: many(orders) }));
export const diningAreasRelations = relations(diningAreas, ({ one, many }) => ({ branch: one(branches, { fields: [diningAreas.branch_id], references: [branches.id] }), tables: many(restaurantTables) }));
export const restaurantTablesRelations = relations(restaurantTables, ({ one, many }) => ({ diningArea: one(diningAreas, { fields: [restaurantTables.dining_area_id], references: [diningAreas.id] }), orders: many(orders) }));
export const kitchenStationsRelations = relations(kitchenStations, ({ one, many }) => ({ branch: one(branches, { fields: [kitchenStations.branch_id], references: [branches.id] }), menuItems: many(menuItems) }));
export const menuCategoriesRelations = relations(menuCategories, ({ one, many }) => ({ branch: one(branches, { fields: [menuCategories.branch_id], references: [branches.id] }), menuItems: many(menuItems) }));
export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({ category: one(menuCategories, { fields: [menuItems.category_id], references: [menuCategories.id] }), kitchenStation: one(kitchenStations, { fields: [menuItems.kitchen_station_id], references: [kitchenStations.id] }), product: one(products, { fields: [menuItems.product_id], references: [products.id] }), variants: many(menuItemVariants), modifierGroups: many(menuItemModifierGroups), orderItems: many(orderItems) }));
export const menuItemVariantsRelations = relations(menuItemVariants, ({ one, many }) => ({ menuItem: one(menuItems, { fields: [menuItemVariants.menu_item_id], references: [menuItems.id] }), orderItems: many(orderItems) }));
export const modifierGroupsRelations = relations(modifierGroups, ({ one, many }) => ({ branch: one(branches, { fields: [modifierGroups.branch_id], references: [branches.id] }), options: many(modifierOptions), menuItems: many(menuItemModifierGroups) }));
export const modifierOptionsRelations = relations(modifierOptions, ({ one, many }) => ({ group: one(modifierGroups, { fields: [modifierOptions.modifier_group_id], references: [modifierGroups.id] }), orderItemModifiers: many(orderItemModifiers) }));
export const menuItemModifierGroupsRelations = relations(menuItemModifierGroups, ({ one }) => ({ menuItem: one(menuItems, { fields: [menuItemModifierGroups.menu_item_id], references: [menuItems.id] }), modifierGroup: one(modifierGroups, { fields: [menuItemModifierGroups.modifier_group_id], references: [modifierGroups.id] }) }));
export const ordersRelations = relations(orders, ({ one, many }) => ({ branch: one(branches, { fields: [orders.branch_id], references: [branches.id] }), customer: one(customers, { fields: [orders.customer_id], references: [customers.id] }), diningTable: one(restaurantTables, { fields: [orders.dining_table_id], references: [restaurantTables.id] }), orderItems: many(orderItems), statusHistory: many(orderStatusHistory), transactions: many(transactions) }));
export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({ order: one(orders, { fields: [orderItems.order_id], references: [orders.id] }), product: one(products, { fields: [orderItems.product_id], references: [products.id] }), menuItem: one(menuItems, { fields: [orderItems.menu_item_id], references: [menuItems.id] }), variant: one(menuItemVariants, { fields: [orderItems.variant_id], references: [menuItemVariants.id] }), modifiers: many(orderItemModifiers) }));
export const orderItemModifiersRelations = relations(orderItemModifiers, ({ one }) => ({ orderItem: one(orderItems, { fields: [orderItemModifiers.order_item_id], references: [orderItems.id] }), modifierOption: one(modifierOptions, { fields: [orderItemModifiers.modifier_option_id], references: [modifierOptions.id] }) }));
export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({ order: one(orders, { fields: [orderStatusHistory.order_id], references: [orders.id] }) }));
export const transactionsRelations = relations(transactions, ({ one }) => ({ order: one(orders, { fields: [transactions.order_id], references: [orders.id] }), paymentMethod: one(paymentMethods, { fields: [transactions.payment_method_id], references: [paymentMethods.id] }) }));
export const customersRelations = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const productsRelations = relations(products, ({ one, many }) => ({ menuItem: one(menuItems), orderItems: many(orderItems) }));
export const paymentMethodsRelations = relations(paymentMethods, ({ many }) => ({ transactions: many(transactions) }));
