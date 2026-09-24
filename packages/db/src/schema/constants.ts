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
export const STOCK_MOVEMENT_TYPES = ["opening_balance", "manual_positive", "manual_negative", "sale_consumption", "sale_consumption_reversal", "waste_discard", "negative_override", "purchase_receipt", "purchase_receipt_reversal", "supplier_return", "supplier_return_reversal", "stock_transfer_out", "stock_transfer_in", "stock_transfer_reversal_out", "stock_transfer_reversal_in", "stock_count_positive", "stock_count_negative", "stock_count_reversal_positive", "stock_count_reversal_negative"] as const;
export const RECIPE_STATUSES = ["draft", "active", "retired"] as const;
export const PURCHASE_ORDER_STATUSES = ["draft", "submitted", "approved", "cancelled"] as const;
export const PURCHASE_ORDER_RECEIVING_STATUSES = ["not_received", "partially_received", "fully_received"] as const;
export const PURCHASE_RECEIPT_STATUSES = ["draft", "posted", "reversed", "needs_review"] as const;
export const SUPPLIER_RETURN_STATUSES = ["draft", "submitted", "approved", "dispatched", "cancelled", "needs_review", "reversed"] as const;
export const SUPPLIER_RETURN_REASONS = ["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"] as const;
export const STOCK_TRANSFER_STATUSES = ["draft", "submitted", "approved", "dispatched", "partially_received", "received", "cancelled", "needs_review", "reversed"] as const;
export const STOCK_COUNT_STATUSES = ["draft", "counting", "submitted", "approved", "posted", "cancelled", "needs_review", "reversed"] as const;
export type InventoryDimension = (typeof INVENTORY_DIMENSIONS)[number];
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export type PurchaseOrderReceivingStatus = (typeof PURCHASE_ORDER_RECEIVING_STATUSES)[number];
export type PurchaseReceiptStatus = (typeof PURCHASE_RECEIPT_STATUSES)[number];
export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];
export type SupplierReturnReason = (typeof SUPPLIER_RETURN_REASONS)[number];
