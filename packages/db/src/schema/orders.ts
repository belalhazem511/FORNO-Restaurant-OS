import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { OrderType, OrderStatus, PaymentStatus } from "./constants";
import { branches, customers, restaurantTables, products, menuItems, menuItemVariants, modifierOptions } from "./restaurant";

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    customer_id: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    dining_table_id: integer("dining_table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
    client_request_id: varchar("client_request_id", { length: 80 }),
    offline_receipt_reference: varchar("offline_receipt_reference", { length: 80 }),
    inventory_issued_at: timestamp("inventory_issued_at"),
    total_cogs_amount: integer("total_cogs_amount"),
    order_type: varchar("order_type", { length: 20 }).$type<OrderType>().default("takeaway").notNull(),
    subtotal_amount: integer("subtotal_amount").default(0).notNull(),
    discount_type: varchar("discount_type", { length: 20 }),
    discount_value: integer("discount_value").default(0).notNull(),
    discount_amount: integer("discount_amount").default(0).notNull(),
    discount_reason: text("discount_reason"),
    discount_applied_by: text("discount_applied_by"),
    discount_approved_by: text("discount_approved_by"),
    total_amount: integer("total_amount").notNull(),
    payment_status: varchar("payment_status", { length: 20 }).$type<PaymentStatus>().default("unpaid").notNull(),
    paid_at: timestamp("paid_at"),
    delivery_address: text("delivery_address"),
    user_uid: varchar("user_uid", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).$type<OrderStatus>().default("pending").notNull(),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("orders_client_request_uidx").on(table.client_request_id),
    uniqueIndex("orders_offline_receipt_reference_uidx").on(table.offline_receipt_reference),
    index("orders_branch_status_idx").on(table.branch_id, table.status),
    index("orders_customer_idx").on(table.customer_id),
    index("orders_table_idx").on(table.dining_table_id),
    index("orders_user_idx").on(table.user_uid),
    check("orders_total_check", sql`${table.total_amount} >= 0`),
    check("orders_subtotal_check", sql`${table.subtotal_amount} >= 0`),
    check("orders_discount_amount_check", sql`${table.discount_amount} >= 0 and ${table.discount_amount} <= ${table.subtotal_amount}`),
    check("orders_discount_type_check", sql`${table.discount_type} is null or ${table.discount_type} in ('percentage', 'fixed')`),
    check("orders_payment_status_check", sql`${table.payment_status} in ('unpaid', 'paid', 'refunded')`),
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
