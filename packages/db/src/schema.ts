import { relations, sql } from "drizzle-orm";
import {
  boolean,
  type AnyPgColumn,
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
import { user } from "./auth-schema";

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
export const STAFF_ROLES = ["owner", "admin", "manager", "cashier"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const PAYMENT_STATUSES = ["unpaid", "paid", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

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

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    customer_id: integer("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    dining_table_id: integer("dining_table_id").references(() => restaurantTables.id, { onDelete: "restrict" }),
    client_request_id: varchar("client_request_id", { length: 80 }),
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
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("order_cancellations_order_uidx").on(table.order_id),
    uniqueIndex("order_cancellations_idempotency_uidx").on(table.idempotency_key),
    check("order_cancellations_reason_check", sql`length(trim(${table.reason})) > 0`),
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
export const staffAssignmentsRelations = relations(staffAssignments, ({ one }) => ({ branch: one(branches, { fields: [staffAssignments.branch_id], references: [branches.id] }), user: one(user, { fields: [staffAssignments.user_id], references: [user.id] }) }));
export const cashierRegistersRelations = relations(cashierRegisters, ({ one, many }) => ({ branch: one(branches, { fields: [cashierRegisters.branch_id], references: [branches.id] }), shifts: many(cashierShifts) }));
export const cashierShiftsRelations = relations(cashierShifts, ({ one, many }) => ({ branch: one(branches, { fields: [cashierShifts.branch_id], references: [branches.id] }), register: one(cashierRegisters, { fields: [cashierShifts.register_id], references: [cashierRegisters.id] }), movements: many(shiftCashMovements), payments: many(orderPayments), checkouts: many(orderCheckouts) }));
export const shiftCashMovementsRelations = relations(shiftCashMovements, ({ one }) => ({ shift: one(cashierShifts, { fields: [shiftCashMovements.shift_id], references: [cashierShifts.id] }) }));
export const orderCheckoutsRelations = relations(orderCheckouts, ({ one, many }) => ({ order: one(orders, { fields: [orderCheckouts.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderCheckouts.shift_id], references: [cashierShifts.id] }), payments: many(orderPayments) }));
export const orderPaymentsRelations = relations(orderPayments, ({ one }) => ({ checkout: one(orderCheckouts, { fields: [orderPayments.checkout_id], references: [orderCheckouts.id] }), order: one(orders, { fields: [orderPayments.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderPayments.shift_id], references: [cashierShifts.id] }), paymentMethod: one(paymentMethods, { fields: [orderPayments.payment_method_id], references: [paymentMethods.id] }), originalPayment: one(orderPayments, { fields: [orderPayments.original_payment_id], references: [orderPayments.id], relationName: "payment_refund" }) }));
export const orderCancellationsRelations = relations(orderCancellations, ({ one }) => ({ order: one(orders, { fields: [orderCancellations.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderCancellations.shift_id], references: [cashierShifts.id] }) }));
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({ branch: one(branches, { fields: [auditLogs.branch_id], references: [branches.id] }), shift: one(cashierShifts, { fields: [auditLogs.shift_id], references: [cashierShifts.id] }), order: one(orders, { fields: [auditLogs.order_id], references: [orders.id] }) }));
