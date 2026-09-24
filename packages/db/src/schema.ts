import { relations, sql } from "drizzle-orm";
import {
  bigint,
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
export const PRINT_DOCUMENT_TYPES = ["receipt", "order_summary", "kot", "refund", "reversal"] as const;
export const PRINT_JOB_STATUSES = ["requested", "previewed", "acknowledged", "failed", "cancelled"] as const;
export const PRINT_LANGUAGES = ["ar", "en", "bilingual"] as const;
export const PRINT_PAPER_WIDTHS = [58, 80] as const;
export const OFFLINE_SYNC_STATUSES = ["accepted", "needs_review", "resolved"] as const;
export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];
export type PrintLanguage = (typeof PRINT_LANGUAGES)[number];
export type PrintPaperWidth = (typeof PRINT_PAPER_WIDTHS)[number];
export type OfflineSyncStatus = (typeof OFFLINE_SYNC_STATUSES)[number];
export const INVENTORY_DIMENSIONS = ["mass", "volume", "count"] as const;
export const STOCK_MOVEMENT_TYPES = ["opening_balance", "manual_positive", "manual_negative", "sale_consumption", "sale_consumption_reversal", "waste_discard", "negative_override", "purchase_receipt", "purchase_receipt_reversal", "supplier_return", "supplier_return_reversal"] as const;
export const RECIPE_STATUSES = ["draft", "active", "retired"] as const;
export const PURCHASE_ORDER_STATUSES = ["draft", "submitted", "approved", "cancelled"] as const;
export const PURCHASE_ORDER_RECEIVING_STATUSES = ["not_received", "partially_received", "fully_received"] as const;
export const PURCHASE_RECEIPT_STATUSES = ["draft", "posted", "reversed", "needs_review"] as const;
export const SUPPLIER_RETURN_STATUSES = ["draft", "submitted", "approved", "dispatched", "cancelled", "needs_review", "reversed"] as const;
export const SUPPLIER_RETURN_REASONS = ["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"] as const;
export type InventoryDimension = (typeof INVENTORY_DIMENSIONS)[number];
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export type PurchaseOrderReceivingStatus = (typeof PURCHASE_ORDER_RECEIVING_STATUSES)[number];
export type PurchaseReceiptStatus = (typeof PURCHASE_RECEIPT_STATUSES)[number];
export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];
export type SupplierReturnReason = (typeof SUPPLIER_RETURN_REASONS)[number];

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

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 40 }).notNull(),
    name_en: varchar("name_en", { length: 160 }).notNull(),
    name_ar: varchar("name_ar", { length: 160 }).notNull(),
    contact_name: varchar("contact_name", { length: 120 }),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 160 }),
    address: text("address"),
    notes: text("notes"),
    is_active: boolean("is_active").default(true).notNull(),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    updated_by: text("updated_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("suppliers_branch_code_uidx").on(table.branch_id, table.code),
    index("suppliers_branch_active_idx").on(table.branch_id, table.is_active),
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

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    supplier_id: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    supplier_code_snapshot: varchar("supplier_code_snapshot", { length: 40 }).notNull(),
    supplier_name_en_snapshot: varchar("supplier_name_en_snapshot", { length: 160 }).notNull(),
    supplier_name_ar_snapshot: varchar("supplier_name_ar_snapshot", { length: 160 }).notNull(),
    po_number: varchar("po_number", { length: 48 }).notNull(),
      status: varchar("status", { length: 20 }).$type<PurchaseOrderStatus>().default("draft").notNull(),
      receiving_status: varchar("receiving_status", { length: 24 }).$type<PurchaseOrderReceivingStatus>().default("not_received").notNull(),
    order_date: timestamp("order_date").defaultNow().notNull(),
    expected_date: timestamp("expected_date"),
    currency: varchar("currency", { length: 3 }).default("EGP").notNull(),
    subtotal_amount: integer("subtotal_amount").default(0).notNull(),
    total_amount: integer("total_amount").default(0).notNull(),
    notes: text("notes"),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    submitted_by: text("submitted_by").references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    cancelled_by: text("cancelled_by").references(() => user.id, { onDelete: "restrict" }),
    cancellation_reason: text("cancellation_reason"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("purchase_orders_branch_number_uidx").on(table.branch_id, table.po_number),
    uniqueIndex("purchase_orders_idempotency_uidx").on(table.idempotency_key),
    index("purchase_orders_branch_status_created_idx").on(table.branch_id, table.status, table.created_at),
      check("purchase_orders_status_check", sql`${table.status} in ('draft', 'submitted', 'approved', 'cancelled')`),
      check("purchase_orders_receiving_status_check", sql`${table.receiving_status} in ('not_received', 'partially_received', 'fully_received')`),
    check("purchase_orders_amounts_check", sql`${table.subtotal_amount} >= 0 and ${table.total_amount} = ${table.subtotal_amount} and ${table.subtotal_amount} <= 2147483647`),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: serial("id").primaryKey(),
    purchase_order_id: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    package_conversion_id: integer("package_conversion_id").references(() => ingredientPackageConversions.id, { onDelete: "restrict" }),
    unit_id: integer("unit_id").notNull().references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    ingredient_sku: varchar("ingredient_sku", { length: 40 }).notNull(),
    ingredient_name_en: varchar("ingredient_name_en", { length: 160 }).notNull(),
    ingredient_name_ar: varchar("ingredient_name_ar", { length: 160 }).notNull(),
    unit_code: varchar("unit_code", { length: 24 }).notNull(),
    quantity_input_scaled: bigint("quantity_input_scaled", { mode: "number" }).notNull(),
      quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
      conversion_numerator_snapshot: bigint("conversion_numerator_snapshot", { mode: "number" }),
      conversion_denominator_snapshot: bigint("conversion_denominator_snapshot", { mode: "number" }),
    unit_price_minor: integer("unit_price_minor").notNull(),
    line_total_amount: integer("line_total_amount").notNull(),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("purchase_order_lines_order_idx").on(table.purchase_order_id),
    index("purchase_order_lines_ingredient_idx").on(table.ingredient_id),
      check("purchase_order_lines_values_check", sql`${table.quantity_input_scaled} > 0 and ${table.quantity_base} > 0 and ${table.unit_price_minor} >= 0 and ${table.line_total_amount} >= 0 and ${table.line_total_amount} <= 2147483647`),
      check("purchase_order_lines_conversion_snapshot_check", sql`(${table.conversion_numerator_snapshot} is null and ${table.conversion_denominator_snapshot} is null) or (${table.conversion_numerator_snapshot} > 0 and ${table.conversion_denominator_snapshot} > 0)`),
    ],
  );

export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    purchase_order_id: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    supplier_id: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    supplier_code_snapshot: varchar("supplier_code_snapshot", { length: 40 }).notNull(),
    supplier_name_en_snapshot: varchar("supplier_name_en_snapshot", { length: 160 }).notNull(),
    supplier_name_ar_snapshot: varchar("supplier_name_ar_snapshot", { length: 160 }).notNull(),
    po_number_snapshot: varchar("po_number_snapshot", { length: 48 }).notNull(),
    receipt_number: varchar("receipt_number", { length: 48 }).notNull(),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    supplier_delivery_note: varchar("supplier_delivery_note", { length: 120 }),
    supplier_invoice_reference: varchar("supplier_invoice_reference", { length: 120 }),
    received_at: timestamp("received_at").defaultNow().notNull(),
    received_by: text("received_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    notes: text("notes"),
    status: varchar("status", { length: 20 }).$type<PurchaseReceiptStatus>().default("draft").notNull(),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    posted_at: timestamp("posted_at"),
    posted_by: text("posted_by").references(() => user.id, { onDelete: "restrict" }),
    variance_approved_by: text("variance_approved_by").references(() => user.id, { onDelete: "restrict" }),
    variance_reason: text("variance_reason"),
    overreceive_approved_by: text("overreceive_approved_by").references(() => user.id, { onDelete: "restrict" }),
    overreceive_reason: text("overreceive_reason"),
    reversal_reason: text("reversal_reason"),
    needs_review_reason: text("needs_review_reason"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("purchase_receipts_branch_number_uidx").on(table.branch_id, table.receipt_number),
    uniqueIndex("purchase_receipts_idempotency_uidx").on(table.idempotency_key),
    index("purchase_receipts_branch_status_created_idx").on(table.branch_id, table.status, table.created_at),
    index("purchase_receipts_po_idx").on(table.purchase_order_id, table.created_at),
    check("purchase_receipts_status_check", sql`${table.status} in ('draft', 'posted', 'reversed', 'needs_review')`),
    check("purchase_receipts_reversal_reason_check", sql`${table.status} not in ('reversed', 'needs_review') or length(trim(coalesce(${table.reversal_reason}, ${table.needs_review_reason}, ''))) > 0`),
  ],
);

export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: serial("id").primaryKey(),
    receipt_id: integer("receipt_id").notNull().references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    purchase_order_line_id: integer("purchase_order_line_id").notNull().references(() => purchaseOrderLines.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    ingredient_sku_snapshot: varchar("ingredient_sku_snapshot", { length: 40 }).notNull(),
    ingredient_name_en_snapshot: varchar("ingredient_name_en_snapshot", { length: 160 }).notNull(),
    ingredient_name_ar_snapshot: varchar("ingredient_name_ar_snapshot", { length: 160 }).notNull(),
    package_conversion_id: integer("package_conversion_id").references(() => ingredientPackageConversions.id, { onDelete: "restrict" }),
    unit_id: integer("unit_id").notNull().references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    unit_code_snapshot: varchar("unit_code_snapshot", { length: 24 }).notNull(),
    conversion_numerator_snapshot: bigint("conversion_numerator_snapshot", { mode: "number" }).notNull(),
    conversion_denominator_snapshot: bigint("conversion_denominator_snapshot", { mode: "number" }).notNull(),
    ordered_quantity_base_snapshot: bigint("ordered_quantity_base_snapshot", { mode: "number" }).notNull(),
    po_unit_price_minor_snapshot: integer("po_unit_price_minor_snapshot").notNull(),
    quantity_input_scaled: bigint("quantity_input_scaled", { mode: "number" }).notNull(),
    accepted_quantity_base: bigint("accepted_quantity_base", { mode: "number" }).notNull(),
    rejected_quantity_base: bigint("rejected_quantity_base", { mode: "number" }).notNull(),
    damaged_quantity_base: bigint("damaged_quantity_base", { mode: "number" }).notNull(),
    actual_unit_price_minor: integer("actual_unit_price_minor").notNull(),
    accepted_unit_cost_micros_snapshot: bigint("accepted_unit_cost_micros_snapshot", { mode: "number" }).notNull(),
    balance_quantity_before: bigint("balance_quantity_before", { mode: "number" }),
    balance_unit_cost_before: bigint("balance_unit_cost_before", { mode: "number" }),
    ingredient_average_unit_cost_before: bigint("ingredient_average_unit_cost_before", { mode: "number" }),
    line_total_amount: integer("line_total_amount").notNull(),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("purchase_receipt_lines_receipt_po_line_uidx").on(table.receipt_id, table.purchase_order_line_id),
    index("purchase_receipt_lines_po_line_idx").on(table.purchase_order_line_id),
    check("purchase_receipt_lines_conversion_check", sql`${table.conversion_numerator_snapshot} > 0 and ${table.conversion_denominator_snapshot} > 0`),
    check("purchase_receipt_lines_values_check", sql`${table.quantity_input_scaled} > 0 and ${table.accepted_quantity_base} >= 0 and ${table.rejected_quantity_base} >= 0 and ${table.damaged_quantity_base} >= 0 and ${table.actual_unit_price_minor} >= 0 and ${table.po_unit_price_minor_snapshot} >= 0 and ${table.accepted_unit_cost_micros_snapshot} >= 0 and ${table.line_total_amount} >= 0 and ${table.line_total_amount} <= 2147483647`),
  ],
);

export const purchaseReceiptReversals = pgTable(
  "purchase_receipt_reversals",
  {
    id: serial("id").primaryKey(),
    receipt_id: integer("receipt_id").notNull().references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("purchase_receipt_reversals_receipt_uidx").on(table.receipt_id),
    uniqueIndex("purchase_receipt_reversals_idempotency_uidx").on(table.idempotency_key),
    check("purchase_receipt_reversals_reason_check", sql`length(trim(${table.reason})) >= 3`),
    check("purchase_receipt_reversals_status_check", sql`${table.status} in ('reversed', 'needs_review')`),
  ],
);

export const supplierReturns = pgTable(
  "supplier_returns",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    supplier_id: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    purchase_order_id: integer("purchase_order_id").notNull().references(() => purchaseOrders.id, { onDelete: "restrict" }),
    receipt_id: integer("receipt_id").notNull().references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    return_number: varchar("return_number", { length: 48 }).notNull(),
    supplier_code_snapshot: varchar("supplier_code_snapshot", { length: 40 }).notNull(),
    supplier_name_en_snapshot: varchar("supplier_name_en_snapshot", { length: 160 }).notNull(),
    supplier_name_ar_snapshot: varchar("supplier_name_ar_snapshot", { length: 160 }).notNull(),
    po_number_snapshot: varchar("po_number_snapshot", { length: 48 }).notNull(),
    receipt_number_snapshot: varchar("receipt_number_snapshot", { length: 48 }).notNull(),
    reason_code: varchar("reason_code", { length: 24 }).$type<SupplierReturnReason>().notNull(),
    reason: text("reason"),
    notes: text("notes"),
    evidence_metadata: text("evidence_metadata"),
    status: varchar("status", { length: 20 }).$type<SupplierReturnStatus>().default("draft").notNull(),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    expected_credit_amount: integer("expected_credit_amount").default(0).notNull(),
    valuation_amount: integer("valuation_amount"),
    cost_variance_amount: integer("cost_variance_amount"),
    created_by: text("created_by").notNull().references(() => user.id, { onDelete: "restrict" }),
    submitted_by: text("submitted_by").references(() => user.id, { onDelete: "restrict" }),
    approved_by: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    dispatched_by: text("dispatched_by").references(() => user.id, { onDelete: "restrict" }),
    cancelled_by: text("cancelled_by").references(() => user.id, { onDelete: "restrict" }),
    reversed_by: text("reversed_by").references(() => user.id, { onDelete: "restrict" }),
    submitted_at: timestamp("submitted_at"),
    approved_at: timestamp("approved_at"),
    dispatched_at: timestamp("dispatched_at"),
    cancelled_at: timestamp("cancelled_at"),
    reversed_at: timestamp("reversed_at"),
    cancellation_reason: text("cancellation_reason"),
    needs_review_reason: text("needs_review_reason"),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("supplier_returns_branch_number_uidx").on(table.branch_id, table.return_number),
    uniqueIndex("supplier_returns_idempotency_uidx").on(table.idempotency_key),
    index("supplier_returns_branch_status_created_idx").on(table.branch_id, table.status, table.created_at),
    index("supplier_returns_receipt_idx").on(table.receipt_id, table.created_at),
    check("supplier_returns_status_check", sql`${table.status} in ('draft', 'submitted', 'approved', 'dispatched', 'cancelled', 'needs_review', 'reversed')`),
    check("supplier_returns_reason_check", sql`${table.reason_code} in ('damaged', 'expired', 'wrong_item', 'quality_issue', 'over_delivery', 'other')`),
    check("supplier_returns_money_check", sql`${table.expected_credit_amount} >= 0 and (${table.valuation_amount} is null or ${table.valuation_amount} >= 0) and (${table.cost_variance_amount} is null or ${table.cost_variance_amount} between -2147483647 and 2147483647)`),
    check("supplier_returns_review_reason_check", sql`${table.status} <> 'needs_review' or length(trim(coalesce(${table.needs_review_reason}, ''))) > 0`),
  ],
);

export const supplierReturnLines = pgTable(
  "supplier_return_lines",
  {
    id: serial("id").primaryKey(),
    supplier_return_id: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    receipt_line_id: integer("receipt_line_id").notNull().references(() => purchaseReceiptLines.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    ingredient_sku_snapshot: varchar("ingredient_sku_snapshot", { length: 40 }).notNull(),
    ingredient_name_en_snapshot: varchar("ingredient_name_en_snapshot", { length: 160 }).notNull(),
    ingredient_name_ar_snapshot: varchar("ingredient_name_ar_snapshot", { length: 160 }).notNull(),
    dimension_snapshot: varchar("dimension_snapshot", { length: 16 }).notNull(),
    unit_id: integer("unit_id").notNull().references(() => unitsOfMeasure.id, { onDelete: "restrict" }),
    unit_code_snapshot: varchar("unit_code_snapshot", { length: 24 }).notNull(),
    package_conversion_id: integer("package_conversion_id").references(() => ingredientPackageConversions.id, { onDelete: "restrict" }),
    conversion_numerator_snapshot: bigint("conversion_numerator_snapshot", { mode: "number" }).notNull(),
    conversion_denominator_snapshot: bigint("conversion_denominator_snapshot", { mode: "number" }).notNull(),
    quantity_input_scaled: bigint("quantity_input_scaled", { mode: "number" }).notNull(),
    quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
    accepted_quantity_base_snapshot: bigint("accepted_quantity_base_snapshot", { mode: "number" }).notNull(),
    original_unit_cost_micros_snapshot: bigint("original_unit_cost_micros_snapshot", { mode: "number" }).notNull(),
    expected_credit_amount: integer("expected_credit_amount").notNull(),
    dispatch_unit_cost_micros_snapshot: bigint("dispatch_unit_cost_micros_snapshot", { mode: "number" }),
    dispatch_valuation_amount: integer("dispatch_valuation_amount"),
    notes: text("notes"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("supplier_return_lines_return_receipt_line_uidx").on(table.supplier_return_id, table.receipt_line_id),
    index("supplier_return_lines_receipt_line_idx").on(table.receipt_line_id),
    check("supplier_return_lines_conversion_check", sql`${table.conversion_numerator_snapshot} > 0 and ${table.conversion_denominator_snapshot} > 0`),
    check("supplier_return_lines_dimension_check", sql`${table.dimension_snapshot} in ('mass', 'volume', 'count')`),
    check("supplier_return_lines_quantities_check", sql`${table.quantity_input_scaled} > 0 and ${table.quantity_base} > 0 and ${table.accepted_quantity_base_snapshot} >= ${table.quantity_base}`),
    check("supplier_return_lines_cost_check", sql`${table.original_unit_cost_micros_snapshot} >= 0 and ${table.expected_credit_amount} >= 0 and (${table.dispatch_unit_cost_micros_snapshot} is null or ${table.dispatch_unit_cost_micros_snapshot} >= 0) and (${table.dispatch_valuation_amount} is null or ${table.dispatch_valuation_amount} >= 0)`),
  ],
);

export const supplierReturnStatusHistory = pgTable(
  "supplier_return_status_history",
  {
    id: serial("id").primaryKey(),
    supplier_return_id: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    from_status: varchar("from_status", { length: 20 }),
    to_status: varchar("to_status", { length: 20 }).$type<SupplierReturnStatus>().notNull(),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    reason: text("reason"),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("supplier_return_status_history_idempotency_uidx").on(table.idempotency_key),
    index("supplier_return_status_history_return_idx").on(table.supplier_return_id, table.created_at),
  ],
);

export const supplierReturnReversals = pgTable(
  "supplier_return_reversals",
  {
    id: serial("id").primaryKey(),
    supplier_return_id: integer("supplier_return_id").notNull().references(() => supplierReturns.id, { onDelete: "restrict" }),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("supplier_return_reversals_return_uidx").on(table.supplier_return_id),
    uniqueIndex("supplier_return_reversals_idempotency_uidx").on(table.idempotency_key),
    check("supplier_return_reversals_reason_check", sql`length(trim(${table.reason})) >= 3`),
    check("supplier_return_reversals_status_check", sql`${table.status} in ('reversed', 'needs_review')`),
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

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    branch_id: integer("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    location_id: integer("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "restrict" }),
    ingredient_id: integer("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
    movement_type: varchar("movement_type", { length: 32 }).$type<StockMovementType>().notNull(),
    direction: integer("direction").notNull(),
    quantity_base: bigint("quantity_base", { mode: "number" }).notNull(),
    unit_cost_micros: bigint("unit_cost_micros", { mode: "number" }).notNull(),
    total_cost_amount: integer("total_cost_amount").notNull(),
    source_type: varchar("source_type", { length: 40 }).notNull(),
    source_id: varchar("source_id", { length: 100 }).notNull(),
    idempotency_key: varchar("idempotency_key", { length: 140 }).notNull(),
    actor_user_id: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    reason: text("reason"),
    order_id: integer("order_id").references(() => orders.id, { onDelete: "restrict" }),
    order_item_id: integer("order_item_id").references(() => orderItems.id, { onDelete: "restrict" }),
    recipe_version_id: integer("recipe_version_id").references(() => recipeVersions.id, { onDelete: "restrict" }),
    supplier_return_id: integer("supplier_return_id").references(() => supplierReturns.id, { onDelete: "restrict" }),
    supplier_return_line_id: integer("supplier_return_line_id").references(() => supplierReturnLines.id, { onDelete: "restrict" }),
    purchase_receipt_id: integer("purchase_receipt_id").references(() => purchaseReceipts.id, { onDelete: "restrict" }),
    purchase_receipt_line_id: integer("purchase_receipt_line_id").references(() => purchaseReceiptLines.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stock_movements_idempotency_uidx").on(table.idempotency_key),
    index("stock_movements_ingredient_created_idx").on(table.ingredient_id, table.created_at),
    index("stock_movements_order_idx").on(table.order_id),
    check("stock_movements_type_check", sql`${table.movement_type} in ('opening_balance', 'manual_positive', 'manual_negative', 'sale_consumption', 'sale_consumption_reversal', 'waste_discard', 'negative_override', 'purchase_receipt', 'purchase_receipt_reversal', 'supplier_return', 'supplier_return_reversal')`),
    check("stock_movements_values_check", sql`${table.direction} in (-1, 0, 1) and ${table.quantity_base} > 0 and ${table.unit_cost_micros} >= 0 and ${table.total_cost_amount} >= 0`),
  ],
);

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

export const branchesRelations = relations(branches, ({ many }) => ({ diningAreas: many(diningAreas), kitchenStations: many(kitchenStations), menuCategories: many(menuCategories), modifierGroups: many(modifierGroups), orders: many(orders), registers: many(cashierRegisters), suppliers: many(suppliers), purchaseOrders: many(purchaseOrders) }));
export const diningAreasRelations = relations(diningAreas, ({ one, many }) => ({ branch: one(branches, { fields: [diningAreas.branch_id], references: [branches.id] }), tables: many(restaurantTables) }));
export const restaurantTablesRelations = relations(restaurantTables, ({ one, many }) => ({ diningArea: one(diningAreas, { fields: [restaurantTables.dining_area_id], references: [diningAreas.id] }), orders: many(orders) }));
export const kitchenStationsRelations = relations(kitchenStations, ({ one, many }) => ({ branch: one(branches, { fields: [kitchenStations.branch_id], references: [branches.id] }), menuItems: many(menuItems), printJobs: many(printJobs) }));
export const menuCategoriesRelations = relations(menuCategories, ({ one, many }) => ({ branch: one(branches, { fields: [menuCategories.branch_id], references: [branches.id] }), menuItems: many(menuItems) }));
export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({ category: one(menuCategories, { fields: [menuItems.category_id], references: [menuCategories.id] }), kitchenStation: one(kitchenStations, { fields: [menuItems.kitchen_station_id], references: [kitchenStations.id] }), product: one(products, { fields: [menuItems.product_id], references: [products.id] }), variants: many(menuItemVariants), modifierGroups: many(menuItemModifierGroups), orderItems: many(orderItems), recipeVersions: many(recipeVersions) }));
export const menuItemVariantsRelations = relations(menuItemVariants, ({ one, many }) => ({ menuItem: one(menuItems, { fields: [menuItemVariants.menu_item_id], references: [menuItems.id] }), orderItems: many(orderItems) }));
export const modifierGroupsRelations = relations(modifierGroups, ({ one, many }) => ({ branch: one(branches, { fields: [modifierGroups.branch_id], references: [branches.id] }), options: many(modifierOptions), menuItems: many(menuItemModifierGroups) }));
export const modifierOptionsRelations = relations(modifierOptions, ({ one, many }) => ({ group: one(modifierGroups, { fields: [modifierOptions.modifier_group_id], references: [modifierGroups.id] }), orderItemModifiers: many(orderItemModifiers) }));
export const menuItemModifierGroupsRelations = relations(menuItemModifierGroups, ({ one }) => ({ menuItem: one(menuItems, { fields: [menuItemModifierGroups.menu_item_id], references: [menuItems.id] }), modifierGroup: one(modifierGroups, { fields: [menuItemModifierGroups.modifier_group_id], references: [modifierGroups.id] }) }));
export const ordersRelations = relations(orders, ({ one, many }) => ({ branch: one(branches, { fields: [orders.branch_id], references: [branches.id] }), customer: one(customers, { fields: [orders.customer_id], references: [customers.id] }), diningTable: one(restaurantTables, { fields: [orders.dining_table_id], references: [restaurantTables.id] }), orderItems: many(orderItems), statusHistory: many(orderStatusHistory), transactions: many(transactions), checkouts: many(orderCheckouts), payments: many(orderPayments), cancellations: many(orderCancellations), printJobs: many(printJobs), inventoryIssues: many(orderInventoryIssues), inventoryConsumptions: many(orderInventoryConsumptions) }));
export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({ order: one(orders, { fields: [orderItems.order_id], references: [orders.id] }), product: one(products, { fields: [orderItems.product_id], references: [products.id] }), menuItem: one(menuItems, { fields: [orderItems.menu_item_id], references: [menuItems.id] }), variant: one(menuItemVariants, { fields: [orderItems.variant_id], references: [menuItemVariants.id] }), modifiers: many(orderItemModifiers), inventoryConsumptions: many(orderInventoryConsumptions), cogs: many(orderItemCogs) }));
export const orderItemModifiersRelations = relations(orderItemModifiers, ({ one }) => ({ orderItem: one(orderItems, { fields: [orderItemModifiers.order_item_id], references: [orderItems.id] }), modifierOption: one(modifierOptions, { fields: [orderItemModifiers.modifier_option_id], references: [modifierOptions.id] }) }));
export const orderStatusHistoryRelations = relations(orderStatusHistory, ({ one }) => ({ order: one(orders, { fields: [orderStatusHistory.order_id], references: [orders.id] }) }));
export const transactionsRelations = relations(transactions, ({ one }) => ({ order: one(orders, { fields: [transactions.order_id], references: [orders.id] }), paymentMethod: one(paymentMethods, { fields: [transactions.payment_method_id], references: [paymentMethods.id] }) }));
export const customersRelations = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const productsRelations = relations(products, ({ one, many }) => ({ menuItem: one(menuItems), orderItems: many(orderItems) }));
export const paymentMethodsRelations = relations(paymentMethods, ({ many }) => ({ transactions: many(transactions) }));
export const staffAssignmentsRelations = relations(staffAssignments, ({ one }) => ({ branch: one(branches, { fields: [staffAssignments.branch_id], references: [branches.id] }), user: one(user, { fields: [staffAssignments.user_id], references: [user.id] }) }));
export const cashierRegistersRelations = relations(cashierRegisters, ({ one, many }) => ({ branch: one(branches, { fields: [cashierRegisters.branch_id], references: [branches.id] }), shifts: many(cashierShifts), printPreferences: many(registerPrintPreferences), printJobs: many(printJobs) }));
export const registerPrintPreferencesRelations = relations(registerPrintPreferences, ({ one }) => ({ register: one(cashierRegisters, { fields: [registerPrintPreferences.register_id], references: [cashierRegisters.id] }) }));
export const cashierShiftsRelations = relations(cashierShifts, ({ one, many }) => ({ branch: one(branches, { fields: [cashierShifts.branch_id], references: [branches.id] }), register: one(cashierRegisters, { fields: [cashierShifts.register_id], references: [cashierRegisters.id] }), movements: many(shiftCashMovements), payments: many(orderPayments), checkouts: many(orderCheckouts) }));
export const shiftCashMovementsRelations = relations(shiftCashMovements, ({ one }) => ({ shift: one(cashierShifts, { fields: [shiftCashMovements.shift_id], references: [cashierShifts.id] }) }));
export const orderCheckoutsRelations = relations(orderCheckouts, ({ one, many }) => ({ order: one(orders, { fields: [orderCheckouts.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderCheckouts.shift_id], references: [cashierShifts.id] }), payments: many(orderPayments) }));
export const orderPaymentsRelations = relations(orderPayments, ({ one }) => ({ checkout: one(orderCheckouts, { fields: [orderPayments.checkout_id], references: [orderCheckouts.id] }), order: one(orders, { fields: [orderPayments.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderPayments.shift_id], references: [cashierShifts.id] }), paymentMethod: one(paymentMethods, { fields: [orderPayments.payment_method_id], references: [paymentMethods.id] }), originalPayment: one(orderPayments, { fields: [orderPayments.original_payment_id], references: [orderPayments.id], relationName: "payment_refund" }) }));
export const orderCancellationsRelations = relations(orderCancellations, ({ one }) => ({ order: one(orders, { fields: [orderCancellations.order_id], references: [orders.id] }), shift: one(cashierShifts, { fields: [orderCancellations.shift_id], references: [cashierShifts.id] }) }));
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({ branch: one(branches, { fields: [auditLogs.branch_id], references: [branches.id] }), shift: one(cashierShifts, { fields: [auditLogs.shift_id], references: [cashierShifts.id] }), order: one(orders, { fields: [auditLogs.order_id], references: [orders.id] }) }));
export const printJobsRelations = relations(printJobs, ({ one }) => ({ order: one(orders, { fields: [printJobs.order_id], references: [orders.id] }), station: one(kitchenStations, { fields: [printJobs.station_id], references: [kitchenStations.id] }), register: one(cashierRegisters, { fields: [printJobs.register_id], references: [cashierRegisters.id] }), shift: one(cashierShifts, { fields: [printJobs.shift_id], references: [cashierShifts.id] }) }));
export const offlinePriceSnapshotsRelations = relations(offlinePriceSnapshots, ({ one }) => ({ branch: one(branches, { fields: [offlinePriceSnapshots.branch_id], references: [branches.id] }), register: one(cashierRegisters, { fields: [offlinePriceSnapshots.register_id], references: [cashierRegisters.id] }), shift: one(cashierShifts, { fields: [offlinePriceSnapshots.shift_id], references: [cashierShifts.id] }) }));
export const offlineSyncRecordsRelations = relations(offlineSyncRecords, ({ one }) => ({ branch: one(branches, { fields: [offlineSyncRecords.branch_id], references: [branches.id] }), register: one(cashierRegisters, { fields: [offlineSyncRecords.register_id], references: [cashierRegisters.id] }), shift: one(cashierShifts, { fields: [offlineSyncRecords.shift_id], references: [cashierShifts.id] }), order: one(orders, { fields: [offlineSyncRecords.order_id], references: [orders.id] }), checkout: one(orderCheckouts, { fields: [offlineSyncRecords.checkout_id], references: [orderCheckouts.id] }) }));
export const inventoryLocationsRelations = relations(inventoryLocations, ({ one, many }) => ({ branch: one(branches, { fields: [inventoryLocations.branch_id], references: [branches.id] }), ingredients: many(ingredients), balances: many(stockBalances), movements: many(stockMovements) }));
export const ingredientCategoriesRelations = relations(ingredientCategories, ({ one, many }) => ({ branch: one(branches, { fields: [ingredientCategories.branch_id], references: [branches.id] }), ingredients: many(ingredients) }));
export const unitsOfMeasureRelations = relations(unitsOfMeasure, ({ many }) => ({ ingredients: many(ingredients) }));
export const ingredientsRelations = relations(ingredients, ({ one, many }) => ({ branch: one(branches, { fields: [ingredients.branch_id], references: [branches.id] }), category: one(ingredientCategories, { fields: [ingredients.category_id], references: [ingredientCategories.id] }), baseUnit: one(unitsOfMeasure, { fields: [ingredients.base_unit_id], references: [unitsOfMeasure.id] }), defaultLocation: one(inventoryLocations, { fields: [ingredients.default_location_id], references: [inventoryLocations.id] }), packages: many(ingredientPackageConversions), balances: many(stockBalances), movements: many(stockMovements), recipeComponents: many(recipeComponents) }));
export const ingredientPackageConversionsRelations = relations(ingredientPackageConversions, ({ one }) => ({ ingredient: one(ingredients, { fields: [ingredientPackageConversions.ingredient_id], references: [ingredients.id] }) }));
export const suppliersRelations = relations(suppliers, ({ one, many }) => ({ branch: one(branches, { fields: [suppliers.branch_id], references: [branches.id] }), purchaseOrders: many(purchaseOrders) }));
export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({ branch: one(branches, { fields: [purchaseOrders.branch_id], references: [branches.id] }), supplier: one(suppliers, { fields: [purchaseOrders.supplier_id], references: [suppliers.id] }), lines: many(purchaseOrderLines), receipts: many(purchaseReceipts) }));
export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({ purchaseOrder: one(purchaseOrders, { fields: [purchaseOrderLines.purchase_order_id], references: [purchaseOrders.id] }), ingredient: one(ingredients, { fields: [purchaseOrderLines.ingredient_id], references: [ingredients.id] }), packageConversion: one(ingredientPackageConversions, { fields: [purchaseOrderLines.package_conversion_id], references: [ingredientPackageConversions.id] }), unit: one(unitsOfMeasure, { fields: [purchaseOrderLines.unit_id], references: [unitsOfMeasure.id] }) }));
export const purchaseReceiptsRelations = relations(purchaseReceipts, ({ one, many }) => ({ branch: one(branches, { fields: [purchaseReceipts.branch_id], references: [branches.id] }), purchaseOrder: one(purchaseOrders, { fields: [purchaseReceipts.purchase_order_id], references: [purchaseOrders.id] }), supplier: one(suppliers, { fields: [purchaseReceipts.supplier_id], references: [suppliers.id] }), location: one(inventoryLocations, { fields: [purchaseReceipts.location_id], references: [inventoryLocations.id] }), lines: many(purchaseReceiptLines), reversals: many(purchaseReceiptReversals) }));
export const purchaseReceiptLinesRelations = relations(purchaseReceiptLines, ({ one }) => ({ receipt: one(purchaseReceipts, { fields: [purchaseReceiptLines.receipt_id], references: [purchaseReceipts.id] }), purchaseOrderLine: one(purchaseOrderLines, { fields: [purchaseReceiptLines.purchase_order_line_id], references: [purchaseOrderLines.id] }), ingredient: one(ingredients, { fields: [purchaseReceiptLines.ingredient_id], references: [ingredients.id] }), packageConversion: one(ingredientPackageConversions, { fields: [purchaseReceiptLines.package_conversion_id], references: [ingredientPackageConversions.id] }), unit: one(unitsOfMeasure, { fields: [purchaseReceiptLines.unit_id], references: [unitsOfMeasure.id] }) }));
export const purchaseReceiptReversalsRelations = relations(purchaseReceiptReversals, ({ one }) => ({ receipt: one(purchaseReceipts, { fields: [purchaseReceiptReversals.receipt_id], references: [purchaseReceipts.id] }), branch: one(branches, { fields: [purchaseReceiptReversals.branch_id], references: [branches.id] }) }));
export const supplierReturnsRelations = relations(supplierReturns, ({ one, many }) => ({ branch: one(branches, { fields: [supplierReturns.branch_id], references: [branches.id] }), supplier: one(suppliers, { fields: [supplierReturns.supplier_id], references: [suppliers.id] }), purchaseOrder: one(purchaseOrders, { fields: [supplierReturns.purchase_order_id], references: [purchaseOrders.id] }), receipt: one(purchaseReceipts, { fields: [supplierReturns.receipt_id], references: [purchaseReceipts.id] }), location: one(inventoryLocations, { fields: [supplierReturns.location_id], references: [inventoryLocations.id] }), lines: many(supplierReturnLines), statusHistory: many(supplierReturnStatusHistory), reversals: many(supplierReturnReversals) }));
export const supplierReturnLinesRelations = relations(supplierReturnLines, ({ one }) => ({ supplierReturn: one(supplierReturns, { fields: [supplierReturnLines.supplier_return_id], references: [supplierReturns.id] }), receiptLine: one(purchaseReceiptLines, { fields: [supplierReturnLines.receipt_line_id], references: [purchaseReceiptLines.id] }), ingredient: one(ingredients, { fields: [supplierReturnLines.ingredient_id], references: [ingredients.id] }), unit: one(unitsOfMeasure, { fields: [supplierReturnLines.unit_id], references: [unitsOfMeasure.id] }), packageConversion: one(ingredientPackageConversions, { fields: [supplierReturnLines.package_conversion_id], references: [ingredientPackageConversions.id] }) }));
export const supplierReturnStatusHistoryRelations = relations(supplierReturnStatusHistory, ({ one }) => ({ supplierReturn: one(supplierReturns, { fields: [supplierReturnStatusHistory.supplier_return_id], references: [supplierReturns.id] }), branch: one(branches, { fields: [supplierReturnStatusHistory.branch_id], references: [branches.id] }) }));
export const supplierReturnReversalsRelations = relations(supplierReturnReversals, ({ one }) => ({ supplierReturn: one(supplierReturns, { fields: [supplierReturnReversals.supplier_return_id], references: [supplierReturns.id] }), branch: one(branches, { fields: [supplierReturnReversals.branch_id], references: [branches.id] }) }));
export const stockBalancesRelations = relations(stockBalances, ({ one }) => ({ branch: one(branches, { fields: [stockBalances.branch_id], references: [branches.id] }), location: one(inventoryLocations, { fields: [stockBalances.location_id], references: [inventoryLocations.id] }), ingredient: one(ingredients, { fields: [stockBalances.ingredient_id], references: [ingredients.id] }) }));
export const recipeVersionsRelations = relations(recipeVersions, ({ one, many }) => ({ menuItem: one(menuItems, { fields: [recipeVersions.menu_item_id], references: [menuItems.id] }), variant: one(menuItemVariants, { fields: [recipeVersions.variant_id], references: [menuItemVariants.id] }), components: many(recipeComponents) }));
export const recipeComponentsRelations = relations(recipeComponents, ({ one }) => ({ recipeVersion: one(recipeVersions, { fields: [recipeComponents.recipe_version_id], references: [recipeVersions.id] }), ingredient: one(ingredients, { fields: [recipeComponents.ingredient_id], references: [ingredients.id] }), sourceLocation: one(inventoryLocations, { fields: [recipeComponents.source_location_id], references: [inventoryLocations.id] }), modifierOption: one(modifierOptions, { fields: [recipeComponents.modifier_option_id], references: [modifierOptions.id] }), unit: one(unitsOfMeasure, { fields: [recipeComponents.unit_id], references: [unitsOfMeasure.id] }) }));
export const orderInventoryIssuesRelations = relations(orderInventoryIssues, ({ one, many }) => ({ order: one(orders, { fields: [orderInventoryIssues.order_id], references: [orders.id] }), consumptions: many(orderInventoryConsumptions) }));
export const orderInventoryConsumptionsRelations = relations(orderInventoryConsumptions, ({ one }) => ({ issue: one(orderInventoryIssues, { fields: [orderInventoryConsumptions.issue_id], references: [orderInventoryIssues.id] }), order: one(orders, { fields: [orderInventoryConsumptions.order_id], references: [orders.id] }), orderItem: one(orderItems, { fields: [orderInventoryConsumptions.order_item_id], references: [orderItems.id] }), recipeVersion: one(recipeVersions, { fields: [orderInventoryConsumptions.recipe_version_id], references: [recipeVersions.id] }), ingredient: one(ingredients, { fields: [orderInventoryConsumptions.ingredient_id], references: [ingredients.id] }), location: one(inventoryLocations, { fields: [orderInventoryConsumptions.location_id], references: [inventoryLocations.id] }) }));
export const orderItemCogsRelations = relations(orderItemCogs, ({ one }) => ({ order: one(orders, { fields: [orderItemCogs.order_id], references: [orders.id] }), orderItem: one(orderItems, { fields: [orderItemCogs.order_item_id], references: [orderItems.id] }), recipeVersion: one(recipeVersions, { fields: [orderItemCogs.recipe_version_id], references: [recipeVersions.id] }) }));
export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({ branch: one(branches, { fields: [stockMovements.branch_id], references: [branches.id] }), location: one(inventoryLocations, { fields: [stockMovements.location_id], references: [inventoryLocations.id] }), ingredient: one(ingredients, { fields: [stockMovements.ingredient_id], references: [ingredients.id] }), order: one(orders, { fields: [stockMovements.order_id], references: [orders.id] }), orderItem: one(orderItems, { fields: [stockMovements.order_item_id], references: [orderItems.id] }), recipeVersion: one(recipeVersions, { fields: [stockMovements.recipe_version_id], references: [recipeVersions.id] }) }));
