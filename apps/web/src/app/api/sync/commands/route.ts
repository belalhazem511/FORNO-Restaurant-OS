import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { authenticatePairedDevice } from "@/lib/sync/paired-device";
import { hasPermission } from "@/lib/permissions";
import {
  auditLogs,
  cashierRegisters,
  cashierShifts,
  customers,
  orderPayments,
  orderCheckouts,
  orderCancellations,
  orderInventoryIssues,
  orders,
  orderItems,
  orderItemModifiers,
  orderStatusHistory,
  restaurantTables,
  kitchenStations,
  menuItems,
  paymentMethods,
  products,
  staffAssignments,
  syncChangeLog,
  syncCommandInbox,
  syncConflicts,
  syncDevices,
  syncEntityMappings,
  syncGlobalEntities,
  shiftCashMovements,
  printJobs,
  registerPrintPreferences,
  transactions,
  ingredients,
  inventoryLocations,
  stockBalances,
  stockMovements,
  suppliers,
  ingredientCategories,
  unitsOfMeasure,
  recipeVersions,
  recipeComponents,
  menuItemVariants,
  menuItemModifierGroups,
  modifierOptions,
  ingredientPackageConversions,
  purchaseOrders,
  purchaseOrderLines,
  purchaseReceipts,
  purchaseReceiptLines,
  purchaseReceiptReversals,
  supplierReturns,
  supplierReturnLines,
  supplierReturnReversals,
  supplierReturnStatusHistory,
} from "@/lib/db/schema";
import { createOrder } from "@/lib/trpc/routers/orders/create";
import { payOrder } from "@/lib/trpc/routers/checkout/payment";
import { assertOrderTransition } from "@/lib/orders/lifecycle";
import { issueOrderInventory } from "@/lib/inventory/service";
import { cancelOrder } from "@/lib/trpc/routers/checkout/cancellation";
import { postStockIncrease } from "@/lib/inventory/service";
import { convertScaledQuantity, costMinorForQuantity, movingWeightedAverage, multiplyDivide, multiplyDivideFactors } from "@/lib/inventory/exact";

export const runtime = "nodejs";

const valuesSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().max(20).nullable(),
  status: z.enum(["active", "inactive"]).nullable(),
});
const productValuesSchema = z.object({ name: z.string().min(1).max(255), description: z.string().nullable(), price: z.number().int().nonnegative(), in_stock: z.number().int().nonnegative(), category: z.string().max(50).nullable(), imageKey: z.string().max(200).nullable() });
const supplierValuesSchema = z.object({ code: z.string().min(2).max(40), nameEn: z.string().min(2).max(160), nameAr: z.string().min(2).max(160), contactName: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable(), address: z.string().nullable(), notes: z.string().nullable() });
const ingredientValuesSchema = z.object({ sku: z.string().min(2).max(40), nameEn: z.string().min(2).max(120), nameAr: z.string().min(2).max(120), dimension: z.enum(["mass", "volume", "count"]), tracked: z.boolean(), reorderLevel: z.number().int().nonnegative(), lowStockThreshold: z.number().int().nonnegative(), parLevel: z.number().int().nonnegative().nullable(), allowNegative: z.boolean(), categoryCode: z.string(), locationCode: z.string(), unitCode: z.string() });
const recipeComponentSchema = z.object({ ingredientGlobalId: z.string().uuid(), locationGlobalId: z.string().uuid(), unitGlobalId: z.string().uuid(), modifierOptionGlobalId: z.string().uuid().nullable(), quantityScaled: z.number().int().refine((value) => value !== 0) });
const purchaseOrderLineCommand = z.object({ ingredientGlobalId: z.string().uuid(), unitGlobalId: z.string().uuid(), packageConversionGlobalId: z.string().uuid().nullable(), packageConversionCode: z.string().nullable(), quantityScaled: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative(), notes: z.string().nullable() });
const receiptLineCommand = z.object({ poLineIndex: z.number().int().nonnegative(), acceptedQuantityScaled: z.number().int().nonnegative(), rejectedQuantityScaled: z.number().int().nonnegative(), damagedQuantityScaled: z.number().int().nonnegative(), actualUnitPriceMinor: z.number().int().nonnegative().nullable(), notes: z.string().nullable() });
const payloadSchemas = {
  "customers.create": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.update": z.object({ customerGlobalId: z.string().uuid(), values: valuesSchema }),
  "customers.delete": z.object({ customerGlobalId: z.string().uuid() }),
  "products.create": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.update": z.object({ productGlobalId: z.string().uuid(), values: productValuesSchema }),
  "products.delete": z.object({ productGlobalId: z.string().uuid() }),
  "inventory.adjust": z.object({ movementGlobalId: z.string().uuid(), ingredientGlobalId: z.string().uuid(), locationGlobalId: z.string().uuid(), direction: z.enum(["positive", "negative"]), opening: z.boolean(), quantityBase: z.number().int().positive(), unitCostMicros: z.number().int().nonnegative(), reason: z.string().trim().min(3).max(500), override: z.boolean(), idempotencyKey: z.string().trim().min(8).max(140) }),
  "suppliers.create": z.object({ supplierGlobalId: z.string().uuid(), values: supplierValuesSchema }),
  "suppliers.update": z.object({ supplierGlobalId: z.string().uuid(), values: supplierValuesSchema, baseRevision: z.number().int().nonnegative() }),
  "suppliers.archive": z.object({ supplierGlobalId: z.string().uuid(), reason: z.string().trim().min(3).max(500), baseRevision: z.number().int().nonnegative(), values: supplierValuesSchema.extend({ isActive: z.boolean() }) }),
  "inventory.ingredient_create": z.object({ ingredientGlobalId: z.string().uuid(), values: ingredientValuesSchema }),
  "inventory.ingredient_update": z.object({ ingredientGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), values: ingredientValuesSchema }),
  "inventory.ingredient_archive": z.object({ ingredientGlobalId: z.string().uuid(), reason: z.string().trim().min(3).max(500), baseRevision: z.number().int().nonnegative(), values: z.object({ sku: z.string(), isActive: z.boolean() }) }),
  "inventory.recipe_create": z.object({ recipeVersionGlobalId: z.string().uuid(), menuItemGlobalId: z.string().uuid(), variantGlobalId: z.string().uuid().nullable(), version: z.number().int().positive(), yieldLossBps: z.number().int().min(0).max(9999), components: z.array(recipeComponentSchema).min(1) }),
  "inventory.recipe_activate": z.object({ recipeVersionGlobalId: z.string().uuid(), reason: z.string().trim().min(3).max(500), baseRevision: z.number().int().nonnegative() }),
  "procurement.purchase_order_create": z.object({ purchaseOrderGlobalId: z.string().uuid(), supplierGlobalId: z.string().uuid(), poNumber: z.string().min(2).max(48), expectedDate: z.string().datetime().nullable(), notes: z.string().nullable(), supplierSnapshot: z.object({ code: z.string(), nameEn: z.string(), nameAr: z.string() }), lines: z.array(purchaseOrderLineCommand).min(1) }),
  "procurement.purchase_order_lines_update": z.object({ purchaseOrderGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), poNumber: z.string(), lines: z.array(purchaseOrderLineCommand).min(1) }),
  "procurement.purchase_order_submit": z.object({ purchaseOrderGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), expectedStatus: z.string() }),
  "procurement.purchase_order_approve": z.object({ purchaseOrderGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), expectedStatus: z.string() }),
  "procurement.purchase_order_cancel": z.object({ purchaseOrderGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), expectedStatus: z.string(), reason: z.string().min(3).max(500) }),
  "receiving.receipt_create": z.object({ receiptGlobalId: z.string().uuid(), purchaseOrderGlobalId: z.string().uuid(), locationGlobalId: z.string().uuid(), receiptNumber: z.string().min(3).max(48), supplierDeliveryNote: z.string().nullable(), supplierInvoiceReference: z.string().nullable(), receivedAt: z.string().datetime(), notes: z.string().nullable(), lines: z.array(receiptLineCommand).min(1) }),
  "receiving.receipt_edit": z.object({ receiptGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), supplierDeliveryNote: z.string().nullable(), supplierInvoiceReference: z.string().nullable(), notes: z.string().nullable(), lines: z.array(receiptLineCommand).min(1) }),
  "receiving.receipt_post": z.object({ receiptGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), approveVariance: z.boolean(), varianceReason: z.string().nullable(), overreceive: z.boolean(), overreceiveReason: z.string().nullable() }),
  "receiving.receipt_reverse": z.object({ reversalGlobalId: z.string().uuid(), receiptGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().min(3).max(500), idempotencyKey: z.string().min(8).max(140) }),
  "supplier_returns.return_create": z.object({ supplierReturnGlobalId: z.string().uuid(), receiptGlobalId: z.string().uuid(), returnNumber: z.string().min(3).max(48), reasonCode: z.enum(["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"]), reason: z.string().nullable(), notes: z.string().nullable(), evidenceMetadata: z.array(z.unknown()), lines: z.array(z.object({ receiptLineIndex: z.number().int().nonnegative(), quantityScaled: z.number().int().positive(), notes: z.string().nullable() })).min(1) }),
  "supplier_returns.return_edit": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reasonCode: z.enum(["damaged", "expired", "wrong_item", "quality_issue", "over_delivery", "other"]).nullable(), reason: z.string().nullable(), notes: z.string().nullable(), evidenceMetadata: z.array(z.unknown()).nullable(), quantities: z.array(z.object({ lineIndex: z.number().int().nonnegative(), quantityScaled: z.number().int().positive(), notes: z.string().nullable() })).min(1) }),
  "supplier_returns.return_submit": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().nullable(), idempotencyKey: z.string().min(8).max(140) }),
  "supplier_returns.return_approve": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().min(3).max(500), idempotencyKey: z.string().min(8).max(140) }),
  "supplier_returns.return_dispatch": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().nullable(), idempotencyKey: z.string().min(8).max(140) }),
  "supplier_returns.return_cancel": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().min(3).max(500), idempotencyKey: z.string().min(8).max(140) }),
  "supplier_returns.return_reverse": z.object({ supplierReturnGlobalId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), reason: z.string().min(3).max(500), idempotencyKey: z.string().min(8).max(140) }),
  "shifts.open": z.object({ shiftGlobalId: z.string().uuid(), registerGlobalId: z.string().uuid(), openingFloat: z.number().int().nonnegative(), openedAt: z.string().datetime() }),
  "shifts.close": z.object({ shiftGlobalId: z.string().uuid(), expectedCash: z.number().int(), closingCash: z.number().int().nonnegative(), closedAt: z.string().datetime() }),
  "shifts.drawer_adjust": z.object({ cashMovementGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), type: z.enum(["cash_in", "cash_out"]), amount: z.number().int().positive(), reason: z.string().trim().min(3).max(500), createdAt: z.string().datetime() }),
  "orders.create": z.object({ orderGlobalId: z.string().uuid(), branchGlobalId: z.string().uuid(), customerGlobalId: z.string().uuid().nullable(), diningTableGlobalId: z.string().uuid().nullable(), orderType: z.enum(["dine_in", "takeaway", "delivery"]), deliveryAddress: z.string().nullable(), clientRequestId: z.string().min(8).max(80), shiftGlobalId: z.string().uuid().nullable(), items: z.array(z.object({ menuItemGlobalId: z.string().uuid(), variantGlobalId: z.string().uuid().nullable(), modifierOptionGlobalIds: z.array(z.string().uuid()), quantity: z.number().int().positive(), notes: z.string().nullable() })).min(1) }),
  "orders.transition": z.object({ orderGlobalId: z.string().uuid(), status: z.enum(["pending", "confirmed", "preparing", "ready", "served", "collected", "delivered", "completed", "cancelled"]), note: z.string().nullable(), inventoryOverrideReason: z.string().nullable() }),
  "orders.update": z.object({ orderGlobalId: z.string().uuid(), status: z.enum(["pending", "confirmed", "preparing", "ready", "served", "collected", "delivered", "completed", "cancelled"]).nullable(), note: z.string().nullable(), inventoryOverrideReason: z.string().nullable() }),
  "checkout.pay": z.object({ checkoutGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), discount: z.object({ type: z.enum(["percentage", "fixed"]), value: z.number().int().positive(), reason: z.string().min(3).max(500) }).nullable(), payments: z.array(z.object({ code: z.string().min(1).max(50), amount: z.number().int().positive(), tenderedAmount: z.number().int().positive().nullable() })).min(1).max(3), paymentGlobalIds: z.array(z.string().uuid()).min(1).max(3), transactionGlobalIds: z.array(z.string().uuid()).min(1).max(3) }),
  "checkout.cancel": z.object({ cancellationGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid().nullable(), checkoutGlobalId: z.string().uuid().nullable(), originalPaymentGlobalIds: z.array(z.string().uuid()), reason: z.string().min(3).max(500), inventoryDisposition: z.enum(["returned_unused", "prepared_discarded"]).nullable(), refundGlobalIds: z.array(z.string().uuid()), transactionGlobalIds: z.array(z.string().uuid()) }),
  "printing.request": z.object({ jobGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid().nullable(), stationGlobalId: z.string().uuid().nullable(), documentType: z.enum(["receipt", "order_summary", "kot", "refund", "reversal"]), isReprint: z.boolean(), reprintReason: z.string().nullable(), copyCount: z.number().int().min(1).max(5), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]) }),
  "printing.transition": z.object({ jobGlobalId: z.string().uuid(), orderGlobalId: z.string().uuid(), status: z.enum(["previewed", "acknowledged", "failed", "cancelled"]), errorMessage: z.string().nullable() }),
  "printing.settings_update": z.object({ preferenceGlobalId: z.string().uuid(), registerGlobalId: z.string().uuid(), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]), receiptCopies: z.number().int().min(1).max(5), kotCopies: z.number().int().min(1).max(5), updatedAt: z.string().datetime() }),
};

export const SYNC_COMMAND_REGISTRY = {
  "orders.create": { schema: payloadSchemas["orders.create"], permission: "order:create", handler: "createOrder", importer: "order" },
  "orders.transition": { schema: payloadSchemas["orders.transition"], permission: "order:create", handler: "transitionOrder", importer: "order" },
  "orders.update": { schema: payloadSchemas["orders.update"], permission: null, handler: "updateOrder", importer: "order" },
  "checkout.pay": { schema: payloadSchemas["checkout.pay"], permission: "checkout:create", handler: "payOrder", importer: "checkout" },
  "checkout.cancel": { schema: payloadSchemas["checkout.cancel"], permission: "order:cancel", handler: "cancelOrder", importer: "cancellation" },
  "printing.request": { schema: payloadSchemas["printing.request"], permission: "print:initial", handler: "requestPrintJob", importer: "print_job" },
  "printing.transition": { schema: payloadSchemas["printing.transition"], permission: "print:initial", handler: "transitionPrintJob", importer: "print_job" },
  "printing.settings_update": { schema: payloadSchemas["printing.settings_update"], permission: "print:settings", handler: "updatePrintSettings", importer: "register_print_preferences" },
  "shifts.open": { schema: payloadSchemas["shifts.open"], permission: "shift:own", handler: "openShift", importer: "cashier_shift" },
  "shifts.drawer_adjust": { schema: payloadSchemas["shifts.drawer_adjust"], permission: "cash:adjust", handler: "adjustDrawer", importer: "cash_movement" },
  "shifts.close": { schema: payloadSchemas["shifts.close"], permission: "shift:review", handler: "closeShift", importer: "cashier_shift" },
  "customers.create": { schema: payloadSchemas["customers.create"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "customers.update": { schema: payloadSchemas["customers.update"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "customers.delete": { schema: payloadSchemas["customers.delete"], permission: null, handler: "mutateCustomer", importer: "customer" },
  "products.create": { schema: payloadSchemas["products.create"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "products.update": { schema: payloadSchemas["products.update"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "products.delete": { schema: payloadSchemas["products.delete"], permission: "product:manage", handler: "mutateProduct", importer: "product" },
  "inventory.adjust": { schema: payloadSchemas["inventory.adjust"], permission: "inventory:adjust", handler: "adjustStock", importer: "stock_movement" },
  "suppliers.create": { schema: payloadSchemas["suppliers.create"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
  "suppliers.update": { schema: payloadSchemas["suppliers.update"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
  "suppliers.archive": { schema: payloadSchemas["suppliers.archive"], permission: "supplier:manage", handler: "mutateSupplier", importer: "supplier" },
  "inventory.ingredient_create": { schema: payloadSchemas["inventory.ingredient_create"], permission: "inventory:configure", handler: "mutateIngredient", importer: "ingredient" },
  "inventory.ingredient_update": { schema: payloadSchemas["inventory.ingredient_update"], permission: "inventory:configure", handler: "mutateIngredient", importer: "ingredient" },
  "inventory.ingredient_archive": { schema: payloadSchemas["inventory.ingredient_archive"], permission: "inventory:configure", handler: "mutateIngredient", importer: "ingredient" },
  "inventory.recipe_create": { schema: payloadSchemas["inventory.recipe_create"], permission: "recipe:manage", handler: "mutateRecipe", importer: "recipe_version" },
  "inventory.recipe_activate": { schema: payloadSchemas["inventory.recipe_activate"], permission: "recipe:manage", handler: "mutateRecipe", importer: "recipe_version" },
  "procurement.purchase_order_create": { schema: payloadSchemas["procurement.purchase_order_create"], permission: "purchase-order:create", handler: "mutatePurchaseOrder", importer: "purchase_order" },
  "procurement.purchase_order_lines_update": { schema: payloadSchemas["procurement.purchase_order_lines_update"], permission: "purchase-order:create", handler: "mutatePurchaseOrder", importer: "purchase_order" },
  "procurement.purchase_order_submit": { schema: payloadSchemas["procurement.purchase_order_submit"], permission: "purchase-order:create", handler: "mutatePurchaseOrder", importer: "purchase_order" },
  "procurement.purchase_order_approve": { schema: payloadSchemas["procurement.purchase_order_approve"], permission: "purchase-order:approve", handler: "mutatePurchaseOrder", importer: "purchase_order" },
  "procurement.purchase_order_cancel": { schema: payloadSchemas["procurement.purchase_order_cancel"], permission: "purchase-order:approve", handler: "mutatePurchaseOrder", importer: "purchase_order" },
  "receiving.receipt_create": { schema: payloadSchemas["receiving.receipt_create"], permission: "purchase-receipt:create", handler: "mutateReceipt", importer: "purchase_receipt" },
  "receiving.receipt_edit": { schema: payloadSchemas["receiving.receipt_edit"], permission: "purchase-receipt:create", handler: "mutateReceipt", importer: "purchase_receipt" },
  "receiving.receipt_post": { schema: payloadSchemas["receiving.receipt_post"], permission: "purchase-receipt:post", handler: "mutateReceipt", importer: "purchase_receipt" },
  "receiving.receipt_reverse": { schema: payloadSchemas["receiving.receipt_reverse"], permission: "purchase-receipt:reverse", handler: "reverseReceipt", importer: "purchase_receipt_reversal" },
  "supplier_returns.return_create": { schema: payloadSchemas["supplier_returns.return_create"], permission: "supplier-return:create", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_edit": { schema: payloadSchemas["supplier_returns.return_edit"], permission: "supplier-return:create", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_submit": { schema: payloadSchemas["supplier_returns.return_submit"], permission: "supplier-return:submit", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_approve": { schema: payloadSchemas["supplier_returns.return_approve"], permission: "supplier-return:approve", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_dispatch": { schema: payloadSchemas["supplier_returns.return_dispatch"], permission: "supplier-return:dispatch", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_cancel": { schema: payloadSchemas["supplier_returns.return_cancel"], permission: "supplier-return:cancel", handler: "mutateSupplierReturn", importer: "supplier_return" },
  "supplier_returns.return_reverse": { schema: payloadSchemas["supplier_returns.return_reverse"], permission: "supplier-return:reverse", handler: "reverseSupplierReturn", importer: "supplier_return_reversal" },
} as const satisfies Record<keyof typeof payloadSchemas, { schema: z.ZodType; permission: string | null; handler: string; importer: string }>;
const commandSchema = z.object({
  operationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  organizationId: z.string().uuid(),
  branchGlobalId: z.string().uuid(),
  registerGlobalId: z.string().uuid(),
  actorGlobalId: z.string().uuid(),
  domain: z.enum(["customers", "products", "shifts", "orders", "checkout", "printing", "inventory", "suppliers", "procurement", "receiving", "supplier_returns"]),
  action: z.enum(["create", "update", "delete", "open", "drawer_adjust", "close", "pay", "cancel", "request", "transition", "settings_update", "adjust", "archive", "ingredient_create", "ingredient_update", "ingredient_archive", "recipe_create", "recipe_activate", "purchase_order_create", "purchase_order_lines_update", "purchase_order_submit", "purchase_order_approve", "purchase_order_cancel", "receipt_create", "receipt_edit", "receipt_post", "receipt_reverse", "return_create", "return_edit", "return_submit", "return_approve", "return_dispatch", "return_cancel", "return_reverse"]),
  schemaVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().trim().min(8).max(120),
  baseRevision: z.number().int().nonnegative(),
  dependencies: z.array(z.string().uuid()).max(100),
  deviceTimestamp: z.string().datetime(),
});

type Command = z.infer<typeof commandSchema>;
type CommandResult = { operationId: string; status: "accepted" | "already_applied" | "needs_review" | "rejected" | "retry_later"; result?: Record<string, unknown>; error?: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function auditRejectedCommand(device: { id: string; organization_id: string; branch_id: number }, actorGlobalId: string, operationId: string, reason: string) {
  await db.transaction(async (tx) => {
    const [actor] = await tx.select().from(syncGlobalEntities).where(and(
      eq(syncGlobalEntities.organization_id, device.organization_id),
      eq(syncGlobalEntities.entity_type, "user"),
      eq(syncGlobalEntities.global_id, actorGlobalId),
    )).limit(1);
    if (!actor) return;
    await tx.insert(auditLogs).values({
      branch_id: device.branch_id,
      actor_user_id: actor.local_id,
      action: "sync.command.rejected",
      entity_type: "sync_device",
      entity_id: device.id,
      details: JSON.stringify({ operationId, reason }),
    });
  });
}

export async function POST(request: NextRequest) {
  const device = await authenticatePairedDevice(request);
  if (!device) return NextResponse.json({ error: "Paired device authentication failed." }, { status: 401, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null) as { commands?: unknown } | null;
  if (!body || !Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 100) {
    return NextResponse.json({ error: "A batch of 1 to 100 typed commands is required." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const results = new Map<string, CommandResult>();
  for (const raw of body.commands) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      results.set(typeof (raw as { operationId?: unknown })?.operationId === "string" ? String((raw as { operationId: string }).operationId) : "invalid", {
        operationId: typeof (raw as { operationId?: unknown })?.operationId === "string" ? String((raw as { operationId: string }).operationId) : "invalid",
        status: "rejected", error: "Command envelope is invalid.",
      });
      continue;
    }
    const command = parsed.data;
    if (command.deviceId !== device.id || command.organizationId !== device.organization_id || command.branchGlobalId.length !== 36) {
      await auditRejectedCommand(device, command.actorGlobalId, command.operationId, "scope_mismatch");
      results.set(command.operationId, { operationId: command.operationId, status: "rejected", error: "Command scope does not match the paired device." });
      continue;
    }
    const computedHash = createHash("sha256").update(stableJson(command.payload)).digest("hex");
    if (computedHash !== command.payloadHash) {
      await auditRejectedCommand(device, command.actorGlobalId, command.operationId, "payload_hash_mismatch");
      results.set(command.operationId, { operationId: command.operationId, status: "rejected", error: "Payload hash mismatch." });
      continue;
    }
    let dependenciesReady = true;
    for (const dependency of command.dependencies) {
      const inBatch = results.get(dependency);
      if (inBatch) {
        if (inBatch.status !== "accepted" && inBatch.status !== "already_applied") dependenciesReady = false;
        continue;
      }
      const prior = await db.query.syncCommandInbox.findFirst({ where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.operation_id, dependency)) });
      if (prior?.state !== "accepted" && prior?.state !== "already_applied") dependenciesReady = false;
    }
    if (!dependenciesReady) {
      results.set(command.operationId, { operationId: command.operationId, status: "retry_later", error: "A dependency has not been accepted." });
      continue;
    }
    try {
      const result = await db.transaction(async (tx): Promise<CommandResult> => {
        const existing = await tx.query.syncCommandInbox.findFirst({
          where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.operation_id, command.operationId)),
        });
        const existingKey = existing ?? await tx.query.syncCommandInbox.findFirst({
          where: and(eq(syncCommandInbox.device_id, device.id), eq(syncCommandInbox.idempotency_key, command.idempotencyKey)),
        });
        if (existingKey) {
          if (existingKey.payload_hash !== command.payloadHash || existingKey.operation_id !== command.operationId) {
            const [owner] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
            if (owner) await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: owner.local_id, action: "sync.command.identity_mismatch", entity_type: "sync_device", entity_id: device.id, details: JSON.stringify({ operationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Operation or idempotency key was reused with different content." };
          }
          const status = existingKey.state === "needs_review" ? "needs_review" : existingKey.state === "rejected" ? "rejected" : "already_applied";
          return { operationId: command.operationId, status, result: existingKey.result ?? undefined };
        }
        const [branchMapping] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "branch"),
          eq(syncGlobalEntities.global_id, command.branchGlobalId),
        )).limit(1);
        const [registerMapping] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "register"),
          eq(syncGlobalEntities.global_id, command.registerGlobalId),
        )).limit(1);
        const [actor] = await tx.select().from(syncGlobalEntities).where(and(
          eq(syncGlobalEntities.organization_id, device.organization_id),
          eq(syncGlobalEntities.entity_type, "user"),
          eq(syncGlobalEntities.global_id, command.actorGlobalId),
        )).limit(1);
        if (!branchMapping || branchMapping.local_id !== String(device.branch_id) || !registerMapping || registerMapping.local_id !== String(device.register_id) || !actor) return { operationId: command.operationId, status: "rejected", error: "Branch, register, or actor identity is invalid." };
        const assignment = await tx.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, actor.local_id), eq(staffAssignments.branch_id, device.branch_id), eq(staffAssignments.is_active, true)) });
        if (!assignment) return { operationId: command.operationId, status: "rejected", error: "Actor has no active assignment in this branch." };

        const payloadSchema = payloadSchemas[`${command.domain}.${command.action}` as keyof typeof payloadSchemas];
        if (!payloadSchema) return { operationId: command.operationId, status: "rejected", error: "Command type is not supported." };
        const payload = payloadSchema.safeParse(command.payload);
        if (!payload.success) return { operationId: command.operationId, status: "rejected", error: "Customer command payload is invalid." };
        if (command.domain === "orders" && command.action === "create") {
          const orderPayload = payload.data as z.infer<typeof payloadSchemas["orders.create"]>;
          if (orderPayload.branchGlobalId !== command.branchGlobalId || orderPayload.orderGlobalId.length !== 36) return { operationId: command.operationId, status: "rejected", error: "Order branch identity is invalid." };
          if (!hasPermission(assignment.role, "order:create")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "order", entity_id: orderPayload.orderGlobalId, reason: "order:create", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks order creation permission." };
          }
          const resolveLocalId = async (entityType: string, globalId: string | null) => {
            if (globalId === null) return null;
            const [mapping] = await tx.select().from(syncGlobalEntities).where(and(
              eq(syncGlobalEntities.organization_id, device.organization_id),
              eq(syncGlobalEntities.entity_type, entityType),
              eq(syncGlobalEntities.global_id, globalId),
            )).limit(1);
            if (!mapping || mapping.branch_id !== device.branch_id) throw new Error(`Order dependency ${entityType} is not synchronized.`);
            return Number(mapping.local_id);
          };
          const branchId = Number(branchMapping.local_id);
          const customerId = await resolveLocalId("customer", orderPayload.customerGlobalId);
          const diningTableId = await resolveLocalId("restaurant_table", orderPayload.diningTableGlobalId);
          const items = await Promise.all(orderPayload.items.map(async (item) => ({
            menuItemId: (await resolveLocalId("menu_item", item.menuItemGlobalId))!,
            variantId: await resolveLocalId("menu_item_variant", item.variantGlobalId),
            modifierOptionIds: await Promise.all(item.modifierOptionGlobalIds.map((id) => resolveLocalId("modifier_option", id).then((value) => value!))),
            quantity: item.quantity,
            notes: item.notes ?? undefined,
          })));
          const [priorIdentity] = await tx.select().from(syncGlobalEntities).where(and(
            eq(syncGlobalEntities.organization_id, device.organization_id),
            eq(syncGlobalEntities.entity_type, "order"),
            eq(syncGlobalEntities.global_id, orderPayload.orderGlobalId),
          )).limit(1);
          if (priorIdentity) return { operationId: command.operationId, status: "rejected", error: "Order global identity already exists." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const created = await createOrder({ branchId, customerId, diningTableId, orderType: orderPayload.orderType, deliveryAddress: orderPayload.deliveryAddress, clientRequestId: orderPayload.clientRequestId, items }, actor.local_id, tx);
          const globalValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order", global_id: orderPayload.orderGlobalId, local_id: String(created.id), server_revision: 1 };
          await tx.insert(syncGlobalEntities).values(globalValues);
          await tx.insert(syncEntityMappings).values({ ...globalValues, device_id: device.id, local_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.created", entity_type: "order", entity_id: orderPayload.orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, orderType: orderPayload.orderType }) });
          const result = { orderGlobalId: orderPayload.orderGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: orderPayload.orderGlobalId, action: "create", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "orders" && (command.action === "transition" || command.action === "update")) {
          const transition = payload.data as z.infer<typeof payloadSchemas["orders.transition"]> | z.infer<typeof payloadSchemas["orders.update"]>;
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, transition.orderGlobalId))).for("update").limit(1);
          const [deviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, transition.orderGlobalId))).for("update").limit(1);
          const [order] = identity ? await tx.select().from(orders).where(and(eq(orders.id, Number(identity.local_id)), eq(orders.branch_id, device.branch_id))).for("update").limit(1) : [undefined];
          if (!order || !deviceIdentity) return { operationId: command.operationId, status: "rejected", error: "Order identity is invalid for this branch." };
          if (deviceIdentity.server_revision !== command.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const serverSnapshot = { status: order.status, paymentStatus: order.payment_status, totalAmount: order.total_amount, updatedAt: order.updated_at?.toISOString() ?? null };
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order", entity_global_id: transition.orderGlobalId, local_payload: command.payload, server_snapshot: serverSnapshot, reason: "The order changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.needs_review", entity_type: "order", entity_id: transition.orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: deviceIdentity.server_revision }) });
            return { operationId: command.operationId, status: "needs_review", result: { orderGlobalId: transition.orderGlobalId } };
          }
          if (transition.status === "cancelled") return { operationId: command.operationId, status: "rejected", error: "Use the cancellation workflow for cancelled orders." };
          if (transition.status && transition.status !== order.status) {
            try { assertOrderTransition(order.status, transition.status, order.order_type); } catch (error) { return { operationId: command.operationId, status: "rejected", error: error instanceof Error ? error.message : "Order transition is invalid." }; }
          }
          if (transition.status === "confirmed" && transition.status !== order.status) {
            if (!hasPermission(assignment.role, "order:create")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks order transition permission." };
            if (transition.inventoryOverrideReason && !hasPermission(assignment.role, "inventory:override")) return { operationId: command.operationId, status: "rejected", error: "Actor cannot override insufficient stock." };
            await issueOrderInventory(tx, { orderId: order.id, actorUserId: actor.local_id, idempotencyKey: `order-confirm:${order.id}`, allowNegative: Boolean(transition.inventoryOverrideReason), overrideReason: transition.inventoryOverrideReason ?? undefined });
          }
          const [updated] = await tx.update(orders).set({ status: transition.status ?? order.status, updated_at: new Date() }).where(eq(orders.id, order.id)).returning();
          if (transition.status && transition.status !== order.status) await tx.insert(orderStatusHistory).values({ order_id: order.id, from_status: order.status, to_status: transition.status, changed_by: actor.local_id, note: transition.note });
          if (transition.status && ["completed", "cancelled"].includes(transition.status) && order.dining_table_id) await tx.update(restaurantTables).set({ status: "available" }).where(eq(restaurantTables.id, order.dining_table_id));
          const revision = deviceIdentity.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceIdentity.id));
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.transition", entity_type: "order", entity_id: transition.orderGlobalId, reason: transition.note, details: JSON.stringify({ sourceOperationId: command.operationId, from: order.status, to: transition.status, inventoryOverrideReason: transition.inventoryOverrideReason }) });
          const result = { orderGlobalId: transition.orderGlobalId, revision, status: updated!.status };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: transition.orderGlobalId, action: "transition", server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "checkout" && command.action === "pay") {
          const checkoutPayload = payload.data as z.infer<typeof payloadSchemas["checkout.pay"]>;
          if (!hasPermission(assignment.role, "checkout:create") || checkoutPayload.discount && !hasPermission(assignment.role, "discount:apply")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "order_checkout", entity_id: checkoutPayload.checkoutGlobalId, reason: checkoutPayload.discount ? "discount:apply" : "checkout:create", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks checkout permission." };
          }
          const [orderMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, checkoutPayload.orderGlobalId))).limit(1);
          const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, checkoutPayload.shiftGlobalId))).limit(1);
          const order = orderMapping && await tx.query.orders.findFirst({ where: and(eq(orders.id, Number(orderMapping.local_id)), eq(orders.branch_id, device.branch_id)) });
          const shift = shiftMapping && await tx.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.id, Number(shiftMapping.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open")) });
          if (!order || !shift || shift.cashier_user_id !== actor.local_id) return { operationId: command.operationId, status: "rejected", error: "Checkout order or active shift is invalid." };
          const methods = await tx.select().from(paymentMethods).where(and(inArray(paymentMethods.code, checkoutPayload.payments.map((payment) => payment.code)), eq(paymentMethods.is_active, true)));
          if (methods.length !== checkoutPayload.payments.length) return { operationId: command.operationId, status: "rejected", error: "A payment method is unavailable." };
          const methodByCode = new Map(methods.map((method) => [method.code, method]));
          const allocations = checkoutPayload.payments.map((payment) => {
            const method = methodByCode.get(payment.code);
            if (!method) throw new Error("A payment method is unavailable.");
            return { paymentMethodId: method.id, amount: payment.amount, tenderedAmount: payment.tenderedAmount };
          });
          const [existingCheckout] = await tx.select().from(orderCheckouts).where(eq(orderCheckouts.idempotency_key, command.idempotencyKey)).limit(1);
          if (existingCheckout) return { operationId: command.operationId, status: "rejected", error: "Checkout idempotency identity already exists without its command record." };
          const result = await payOrder({ idempotencyKey: command.idempotencyKey, discount: checkoutPayload.discount, payments: allocations }, order, shift, new Map(methods.map((method) => [method.id, method])), actor.local_id, tx);
          const rows = await tx.select().from(orderPayments).where(and(eq(orderPayments.checkout_id, result.checkoutId), eq(orderPayments.kind, "payment")));
          if (rows.length !== checkoutPayload.paymentGlobalIds.length) throw new Error("Checkout payment identity count does not match its records.");
          const paymentSnapshots: Array<{ globalId: string; localId: number }> = [];
          const transactionSnapshots: Array<{ globalId: string; localId: number }> = [];
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            const paymentGlobalId = checkoutPayload.paymentGlobalIds[index]!;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: paymentGlobalId, local_id: String(row.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: paymentGlobalId, local_id: String(row.id), local_revision: 1, server_revision: 1 });
            paymentSnapshots.push({ globalId: paymentGlobalId, localId: row.id });
            const [financial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, row.id)).limit(1);
            const transactionGlobalId = checkoutPayload.transactionGlobalIds[index]!;
            if (financial) {
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: transactionGlobalId, local_id: String(financial.id), server_revision: 1 });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: transactionGlobalId, local_id: String(financial.id), local_revision: 1, server_revision: 1 });
              transactionSnapshots.push({ globalId: transactionGlobalId, localId: financial.id });
            }
          }
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: checkoutPayload.checkoutGlobalId, local_id: String(result.checkoutId), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: checkoutPayload.checkoutGlobalId, local_id: String(result.checkoutId), local_revision: 1, server_revision: 1 });
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, order_id: order.id, actor_user_id: actor.local_id, action: "sync.checkout.paid", entity_type: "order_checkout", entity_id: checkoutPayload.checkoutGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, paymentCount: rows.length }) });
          const response = { checkoutGlobalId: checkoutPayload.checkoutGlobalId, revision: 1, subtotalAmount: result.subtotalAmount, discountAmount: result.discountAmount, payableAmount: result.payableAmount, paymentGlobalIds: paymentSnapshots.map((item) => item.globalId), transactionGlobalIds: transactionSnapshots.map((item) => item.globalId) };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "checkout", entity_type: "order_checkout", entity_global_id: checkoutPayload.checkoutGlobalId, action: "pay", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "checkout" && command.action === "cancel") {
          const cancellationPayload = payload.data as z.infer<typeof payloadSchemas["checkout.cancel"]>;
          if (!hasPermission(assignment.role, "order:cancel")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks order cancellation permission." };
          const [orderIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, cancellationPayload.orderGlobalId))).for("update").limit(1);
          const [orderDeviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, cancellationPayload.orderGlobalId))).for("update").limit(1);
          const [order] = orderIdentity ? await tx.select().from(orders).where(and(eq(orders.id, Number(orderIdentity.local_id)), eq(orders.branch_id, device.branch_id))).for("update").limit(1) : [undefined];
          if (!order || order.status === "cancelled") return { operationId: command.operationId, status: "rejected", error: "Order is missing or already cancelled." };
          const wasPaid = order.payment_status === "paid";
          if (wasPaid && !hasPermission(assignment.role, "payment:refund")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks refund permission." };
          if (wasPaid && !cancellationPayload.shiftGlobalId) return { operationId: command.operationId, status: "rejected", error: "A cashier shift is required for a financial reversal." };
          const [shiftIdentity] = cancellationPayload.shiftGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, cancellationPayload.shiftGlobalId))).limit(1) : [undefined];
          const [shift] = shiftIdentity ? await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftIdentity.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1) : [undefined];
          if (cancellationPayload.shiftGlobalId && (!shift || shift!.cashier_user_id !== actor.local_id)) return { operationId: command.operationId, status: "rejected", error: "Cancellation shift is not open for the authorized actor." };
          const originalPayments = await tx.select().from(orderPayments).where(and(eq(orderPayments.order_id, order.id), eq(orderPayments.kind, "payment")));
          const mappedOriginals = await Promise.all(originalPayments.map(async (payment) => tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(payment.id))) })));
          if (wasPaid && (mappedOriginals.some((mapping) => !mapping) || mappedOriginals.map((mapping) => mapping!.global_id).sort().join(",") !== cancellationPayload.originalPaymentGlobalIds.slice().sort().join(","))) return { operationId: command.operationId, status: "rejected", error: "Original payment identities do not match the immutable checkout." };
          if (cancellationPayload.checkoutGlobalId && !await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_checkout"), eq(syncGlobalEntities.global_id, cancellationPayload.checkoutGlobalId)) })) return { operationId: command.operationId, status: "rejected", error: "Original checkout identity is unavailable." };
          const issue = await tx.query.orderInventoryIssues.findFirst({ where: eq(orderInventoryIssues.order_id, order.id) });
          if (issue && !cancellationPayload.inventoryDisposition) return { operationId: command.operationId, status: "rejected", error: "Cancellation after production requires an inventory disposition." };
          if (wasPaid && cancellationPayload.refundGlobalIds.length !== originalPayments.length) return { operationId: command.operationId, status: "rejected", error: "Refund identities do not match original payments." };
          const result = await cancelOrder({ idempotencyKey: command.idempotencyKey, reason: cancellationPayload.reason, inventoryDisposition: cancellationPayload.inventoryDisposition ?? undefined }, order, wasPaid, shift ?? null, actor.local_id, tx);
          const [cancellation] = await tx.select().from(orderCancellations).where(eq(orderCancellations.id, result.cancellationId)).limit(1);
          const refundRows = await tx.select().from(orderPayments).where(and(eq(orderPayments.order_id, order.id), eq(orderPayments.kind, "refund")));
          for (let index = 0; index < refundRows.length; index += 1) {
            const refund = refundRows[index]!;
            const refundGlobalId = cancellationPayload.refundGlobalIds[index]!;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refundGlobalId, local_id: String(refund.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refundGlobalId, local_id: String(refund.id), local_revision: 1, server_revision: 1 });
            const [financial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, refund.id)).limit(1);
            const financialGlobalId = cancellationPayload.transactionGlobalIds[index];
            if (financial && financialGlobalId) {
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: financialGlobalId, local_id: String(financial.id), server_revision: 1 });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: financialGlobalId, local_id: String(financial.id), local_revision: 1, server_revision: 1 });
            }
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: cancellationPayload.cancellationGlobalId, local_id: String(cancellation!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: cancellationPayload.cancellationGlobalId, local_id: String(cancellation!.id), local_revision: 1, server_revision: 1 });
          const response = { cancellationGlobalId: cancellationPayload.cancellationGlobalId, orderGlobalId: cancellationPayload.orderGlobalId, revision: 1, refundedAmount: result.refundedAmount };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          const orderRevision = (orderDeviceIdentity?.server_revision ?? 0) + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: orderRevision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, orderIdentity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: orderRevision, updated_at: new Date() }).where(eq(syncEntityMappings.id, orderDeviceIdentity!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "orders", entity_type: "order", entity_global_id: cancellationPayload.orderGlobalId, action: "cancel", server_revision: orderRevision, source_operation_id: command.operationId });
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "checkout", entity_type: "order_cancellation", entity_global_id: cancellationPayload.cancellationGlobalId, action: "cancel", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "printing" && command.action === "settings_update") {
          const settings = payload.data as z.infer<typeof payloadSchemas["printing.settings_update"]>;
          if (!hasPermission(assignment.role, "print:settings")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks print settings permission." };
          if (settings.registerGlobalId !== command.registerGlobalId) return { operationId: command.operationId, status: "rejected", error: "Print settings register is outside the paired device scope." };
          const [registerIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.global_id, settings.registerGlobalId))).limit(1);
          const [register] = registerIdentity ? await tx.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, Number(registerIdentity.local_id)), eq(cashierRegisters.branch_id, device.branch_id))).limit(1) : [undefined];
          if (!register || register.id !== device.register_id) return { operationId: command.operationId, status: "rejected", error: "Print settings register is not assigned to this device." };
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register_print_preferences"), eq(syncGlobalEntities.global_id, settings.preferenceGlobalId))).for("update").limit(1);
          const [deviceIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register_print_preferences"), eq(syncEntityMappings.global_id, settings.preferenceGlobalId))).for("update").limit(1);
          if (identity && (!deviceIdentity || deviceIdentity.server_revision !== command.baseRevision)) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const [current] = await tx.select().from(registerPrintPreferences).where(eq(registerPrintPreferences.register_id, register.id)).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "register_print_preferences", entity_global_id: settings.preferenceGlobalId, local_payload: command.payload, server_snapshot: current ?? {}, reason: "Print preferences changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.print_settings.needs_review", entity_type: "register_print_preferences", entity_id: settings.preferenceGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "needs_review", result: { preferenceGlobalId: settings.preferenceGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const [preference] = await tx.insert(registerPrintPreferences).values({ register_id: register.id, paper_width: settings.paperWidth, language: settings.language, receipt_copies: settings.receiptCopies, kot_copies: settings.kotCopies, updated_by: actor.local_id, updated_at: new Date(settings.updatedAt) }).onConflictDoUpdate({ target: registerPrintPreferences.register_id, set: { paper_width: settings.paperWidth, language: settings.language, receipt_copies: settings.receiptCopies, kot_copies: settings.kotCopies, updated_by: actor.local_id, updated_at: new Date(settings.updatedAt) } }).returning();
          const revision = (deviceIdentity?.server_revision ?? 0) + 1;
          if (identity) await tx.update(syncGlobalEntities).set({ local_id: String(preference!.id), server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
          else await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: settings.preferenceGlobalId, local_id: String(preference!.id), server_revision: revision });
          if (deviceIdentity) await tx.update(syncEntityMappings).set({ local_id: String(preference!.id), server_revision: revision, local_revision: deviceIdentity.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceIdentity.id));
          else await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: settings.preferenceGlobalId, local_id: String(preference!.id), local_revision: 1, server_revision: revision });
          const result = { preferenceGlobalId: settings.preferenceGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.print.settings_updated", entity_type: "register_print_preferences", entity_id: settings.preferenceGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "register_print_preferences", entity_global_id: settings.preferenceGlobalId, action: "settings_update", server_revision: revision, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "printing" && command.action === "request") {
          const requestPayload = payload.data as z.infer<typeof payloadSchemas["printing.request"]>;
          if (!hasPermission(assignment.role, requestPayload.isReprint ? "print:reprint" : "print:initial")) return { operationId: command.operationId, status: "rejected", error: "Actor lacks print permission." };
          if (requestPayload.isReprint && (!requestPayload.reprintReason || requestPayload.reprintReason.trim().length < 3)) return { operationId: command.operationId, status: "rejected", error: "A reprint reason is required." };
          const [orderIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, requestPayload.orderGlobalId))).limit(1);
          const [order] = orderIdentity ? await tx.select().from(orders).where(and(eq(orders.id, Number(orderIdentity.local_id)), eq(orders.branch_id, device.branch_id))).limit(1) : [undefined];
          const [shiftIdentity] = requestPayload.shiftGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, requestPayload.shiftGlobalId))).limit(1) : [undefined];
          const [stationIdentity] = requestPayload.stationGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "kitchen_station"), eq(syncGlobalEntities.global_id, requestPayload.stationGlobalId))).limit(1) : [undefined];
          if (!order || requestPayload.shiftGlobalId && !shiftIdentity || requestPayload.stationGlobalId && !stationIdentity) return { operationId: command.operationId, status: "retry_later", error: "Print order, shift, or station dependency is unavailable." };
          if (requestPayload.documentType === "receipt" && order.payment_status !== "paid" || requestPayload.documentType === "order_summary" && order.payment_status !== "unpaid" || ["refund", "reversal"].includes(requestPayload.documentType) && order.payment_status !== "refunded") return { operationId: command.operationId, status: "rejected", error: "Print document does not match the current order financial state." };
          if (requestPayload.documentType === "kot" && (!stationIdentity || order.status === "cancelled")) return { operationId: command.operationId, status: "rejected", error: "KOT requires an active order and mapped kitchen station." };
          if (requestPayload.documentType !== "kot" && stationIdentity) return { operationId: command.operationId, status: "rejected", error: "Only KOT documents may select a station." };
          if (requestPayload.documentType === "kot") {
            const [station] = await tx.select().from(kitchenStations).where(and(eq(kitchenStations.id, Number(stationIdentity!.local_id)), eq(kitchenStations.branch_id, device.branch_id), eq(kitchenStations.is_active, true))).limit(1);
            const routedItems = await tx.select({ id: orderItems.id }).from(orderItems).innerJoin(menuItems, eq(orderItems.menu_item_id, menuItems.id)).where(and(eq(orderItems.order_id, order.id), eq(menuItems.kitchen_station_id, Number(stationIdentity!.local_id))));
            if (!station || routedItems.length === 0) return { operationId: command.operationId, status: "rejected", error: "KOT station is not active for this order." };
          }
          if (!requestPayload.isReprint) {
            const initial = await tx.query.printJobs.findFirst({ where: requestPayload.documentType === "kot" ? and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, Number(stationIdentity?.local_id)), eq(printJobs.is_reprint, false)) : and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, requestPayload.documentType), eq(printJobs.is_reprint, false)) });
            if (initial) return { operationId: command.operationId, status: "rejected", error: "Initial print document already exists." };
          } else {
            const initial = await tx.query.printJobs.findFirst({ where: requestPayload.documentType === "kot" ? and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, Number(stationIdentity?.local_id)), eq(printJobs.is_reprint, false)) : and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, requestPayload.documentType), eq(printJobs.is_reprint, false)) });
            if (!initial) return { operationId: command.operationId, status: "rejected", error: "An initial document must exist before reprinting." };
          }
          const [created] = await tx.insert(printJobs).values({ order_id: order.id, station_id: stationIdentity ? Number(stationIdentity.local_id) : null, register_id: device.register_id, shift_id: shiftIdentity ? Number(shiftIdentity.local_id) : null, requested_by: actor.local_id, approved_by: requestPayload.isReprint ? actor.local_id : null, document_type: requestPayload.documentType, status: "requested", is_reprint: requestPayload.isReprint, idempotency_key: command.idempotencyKey, copy_count: requestPayload.copyCount, paper_width: requestPayload.paperWidth, language: requestPayload.language, reprint_reason: requestPayload.isReprint ? requestPayload.reprintReason : null }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "print_job", global_id: requestPayload.jobGlobalId, local_id: String(created!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "print_job", global_id: requestPayload.jobGlobalId, local_id: String(created!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: created!.shift_id, order_id: order.id, actor_user_id: actor.local_id, approver_user_id: requestPayload.isReprint ? actor.local_id : null, action: requestPayload.isReprint ? "sync.print.reprint.request" : "sync.print.initial.request", entity_type: "print_job", entity_id: requestPayload.jobGlobalId, reason: requestPayload.reprintReason, details: JSON.stringify({ sourceOperationId: command.operationId, documentType: requestPayload.documentType, stationGlobalId: requestPayload.stationGlobalId }) });
          const response = { jobGlobalId: requestPayload.jobGlobalId, revision: 1 };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "print_job", entity_global_id: requestPayload.jobGlobalId, action: "request", server_revision: 1, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "printing" && command.action === "transition") {
          const transition = payload.data as z.infer<typeof payloadSchemas["printing.transition"]>;
          const [jobIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "print_job"), eq(syncGlobalEntities.global_id, transition.jobGlobalId))).for("update").limit(1);
          const [job] = jobIdentity ? await tx.select().from(printJobs).where(eq(printJobs.id, Number(jobIdentity.local_id))).for("update").limit(1) : [undefined];
          const [requester] = job ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.requested_by))).limit(1) : [undefined];
          if (!job || !requester || job.order_id !== Number((await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.global_id, transition.orderGlobalId))).limit(1))[0]?.local_id)) return { operationId: command.operationId, status: "rejected", error: "Print job identity is invalid." };
          if (job.requested_by !== actor.local_id && !hasPermission(assignment.role, "print:reprint")) return { operationId: command.operationId, status: "rejected", error: "Actor cannot acknowledge this print request." };
          const allowed: Record<string, string[]> = { requested: ["previewed", "failed", "cancelled"], previewed: ["acknowledged", "failed", "cancelled"], acknowledged: [], failed: [], cancelled: [] };
          if (!allowed[job.status]?.includes(transition.status) || transition.status === "failed" && !transition.errorMessage) return { operationId: command.operationId, status: "rejected", error: "Print transition is invalid." };
          await tx.update(printJobs).set({ status: transition.status, error_message: transition.status === "failed" ? transition.errorMessage : null, previewed_at: transition.status === "previewed" ? new Date() : job.previewed_at, acknowledged_at: transition.status === "acknowledged" ? new Date() : null, updated_at: new Date() }).where(eq(printJobs.id, job.id));
          const revision = Number((await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "print_job"), eq(syncEntityMappings.global_id, transition.jobGlobalId))).limit(1))[0]?.server_revision ?? 0) + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, jobIdentity!.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "print_job"), eq(syncEntityMappings.global_id, transition.jobGlobalId)));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: job.shift_id, order_id: job.order_id, actor_user_id: actor.local_id, action: `sync.print.${transition.status}`, entity_type: "print_job", entity_id: transition.jobGlobalId, details: transition.errorMessage });
          const response = { jobGlobalId: transition.jobGlobalId, revision };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "printing", entity_type: "print_job", entity_global_id: transition.jobGlobalId, action: transition.status, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        if (command.domain === "shifts") {
          if (command.action === "drawer_adjust") {
            const movementPayload = payload.data as z.infer<typeof payloadSchemas["shifts.drawer_adjust"]>;
            if (!hasPermission(assignment.role, "cash:adjust")) {
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "cash_movement", entity_id: movementPayload.cashMovementGlobalId, reason: "cash:adjust", details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "rejected", error: "Actor lacks cash adjustment permission." };
            }
            const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, movementPayload.shiftGlobalId))).for("update").limit(1);
            const [shift] = await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftMapping?.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1);
            if (!shiftMapping || !shift) return { operationId: command.operationId, status: "rejected", error: "Open shift identity is invalid." };
            const [existingMovement] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cash_movement"), eq(syncGlobalEntities.global_id, movementPayload.cashMovementGlobalId))).limit(1);
            if (existingMovement) return { operationId: command.operationId, status: "rejected", error: "Cash movement identity already exists." };
            const cashMethod = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, "CASH"), eq(paymentMethods.is_active, true)) });
            if (!cashMethod) return { operationId: command.operationId, status: "retry_later", error: "Cash payment method is not configured centrally." };
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const [movement] = await tx.insert(shiftCashMovements).values({ shift_id: shift.id, type: movementPayload.type, amount: movementPayload.amount, reason: movementPayload.reason, created_by: actor.local_id, created_at: new Date(movementPayload.createdAt) }).returning();
            await tx.insert(transactions).values({ shift_id: shift.id, payment_method_id: cashMethod.id, amount: movementPayload.amount, user_uid: actor.local_id, type: movementPayload.type === "cash_in" ? "income" : "expense", category: movementPayload.type, status: "completed", description: movementPayload.reason });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: movementPayload.cashMovementGlobalId, local_id: String(movement!.id), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: movementPayload.cashMovementGlobalId, local_id: String(movement!.id), local_revision: 1, server_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: `shift.${movementPayload.type}`, entity_type: "cash_movement", entity_id: movementPayload.cashMovementGlobalId, reason: movementPayload.reason, details: JSON.stringify({ sourceOperationId: command.operationId, amount: movementPayload.amount }) });
            const result = { cashMovementGlobalId: movementPayload.cashMovementGlobalId, revision: 1 };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cash_movement", entity_global_id: movementPayload.cashMovementGlobalId, action: command.action, server_revision: 1, source_operation_id: command.operationId });
            await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
            return { operationId: command.operationId, status: "accepted", result };
          }
          if (command.action === "close") {
            const closePayload = payload.data as z.infer<typeof payloadSchemas["shifts.close"]>;
            const [shiftMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, closePayload.shiftGlobalId))).for("update").limit(1);
            const [shift] = await tx.select().from(cashierShifts).where(and(eq(cashierShifts.id, Number(shiftMapping?.local_id)), eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"))).for("update").limit(1);
            if (!shiftMapping || !shift) return { operationId: command.operationId, status: "rejected", error: "Open shift identity is invalid." };
            if (shift.cashier_user_id !== actor.local_id && !hasPermission(assignment.role, "shift:review")) {
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, reason: "shift:review", details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "rejected", error: "Actor lacks shift review permission." };
            }
            const [methods, payments, movements] = await Promise.all([
              tx.select().from(paymentMethods),
              tx.select().from(orderPayments).where(eq(orderPayments.shift_id, shift.id)),
              tx.select().from(shiftCashMovements).where(eq(shiftCashMovements.shift_id, shift.id)),
            ]);
            const cashMethodIds = new Set(methods.filter((method) => method.affects_drawer).map((method) => method.id));
            const cashSales = payments.filter((payment) => payment.kind === "payment" && cashMethodIds.has(payment.payment_method_id)).reduce((sum, payment) => sum + payment.amount, 0);
            const cashRefunds = payments.filter((payment) => payment.kind === "refund" && cashMethodIds.has(payment.payment_method_id)).reduce((sum, payment) => sum + payment.amount, 0);
            const cashIn = movements.filter((movement) => movement.type === "cash_in").reduce((sum, movement) => sum + movement.amount, 0);
            const cashOut = movements.filter((movement) => movement.type === "cash_out").reduce((sum, movement) => sum + movement.amount, 0);
            const serverExpectedCash = shift.opening_float + cashSales - cashRefunds + cashIn - cashOut;
            if (serverExpectedCash !== closePayload.expectedCash) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "cash_snapshot_mismatch" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", entity_global_id: closePayload.shiftGlobalId, local_payload: command.payload, server_snapshot: { expectedCash: serverExpectedCash }, reason: "The central shift cash total differs from the device snapshot." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: "sync.shift.needs_review", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, localExpectedCash: closePayload.expectedCash, serverExpectedCash }) });
              return { operationId: command.operationId, status: "needs_review", result: { shiftGlobalId: closePayload.shiftGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const variance = closePayload.closingCash - serverExpectedCash;
            await tx.update(cashierShifts).set({ status: "closed", expected_cash: serverExpectedCash, closing_cash: closePayload.closingCash, variance, closed_by: actor.local_id, closed_at: new Date(closePayload.closedAt) }).where(eq(cashierShifts.id, shift.id));
            const revision = (shiftMapping.server_revision ?? 0) + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, shiftMapping.id));
            const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, closePayload.shiftGlobalId))).for("update").limit(1);
            if (deviceMapping) await tx.update(syncEntityMappings).set({ server_revision: revision, local_revision: deviceMapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift.id, actor_user_id: actor.local_id, action: "sync.shift.closed", entity_type: "cashier_shift", entity_id: closePayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, expectedCash: serverExpectedCash, closingCash: closePayload.closingCash, variance }) });
            const result = { shiftGlobalId: closePayload.shiftGlobalId, revision };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cashier_shift", entity_global_id: closePayload.shiftGlobalId, action: "close", server_revision: revision, source_operation_id: command.operationId });
            await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
            return { operationId: command.operationId, status: "accepted", result };
          }
          const shiftPayload = payload.data as z.infer<typeof payloadSchemas["shifts.open"]>;
          if (command.action !== "open" || shiftPayload.registerGlobalId !== command.registerGlobalId) return { operationId: command.operationId, status: "rejected", error: "Shift command scope is invalid." };
          const [registerMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.global_id, shiftPayload.registerGlobalId))).limit(1);
          const registerId = Number(registerMapping?.local_id);
          const [register] = await tx.select().from(cashierRegisters).where(and(eq(cashierRegisters.id, registerId), eq(cashierRegisters.branch_id, device.branch_id), eq(cashierRegisters.is_active, true))).limit(1);
          if (!registerMapping || registerMapping.local_id !== String(device.register_id) || !register) return { operationId: command.operationId, status: "rejected", error: "Shift register is not assigned to the paired device." };
          const [existingMapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.global_id, shiftPayload.shiftGlobalId))).for("update").limit(1);
          if (existingMapping) return { operationId: command.operationId, status: "rejected", error: "Shift global identity already exists." };
          const activeShift = await tx.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.status, "open"), eq(cashierShifts.branch_id, device.branch_id), or(eq(cashierShifts.register_id, register.id), eq(cashierShifts.cashier_user_id, actor.local_id))) });
          if (activeShift) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            await tx.update(syncCommandInbox).set({ result: { reason: "overlapping_shift" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", entity_global_id: shiftPayload.shiftGlobalId, local_payload: command.payload, server_snapshot: { activeShiftId: activeShift.id }, reason: "A conflicting open shift already exists for this register or cashier." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.shift.needs_review", entity_type: "cashier_shift", entity_id: shiftPayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, activeShiftId: activeShift.id }) });
            return { operationId: command.operationId, status: "needs_review", result: { shiftGlobalId: shiftPayload.shiftGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const [shift] = await tx.insert(cashierShifts).values({ branch_id: device.branch_id, register_id: register.id, cashier_user_id: actor.local_id, opened_by: actor.local_id, opening_float: shiftPayload.openingFloat, status: "open", opened_at: new Date(shiftPayload.openedAt) }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: shiftPayload.shiftGlobalId, local_id: String(shift!.id), server_revision: 1 });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: shiftPayload.shiftGlobalId, local_id: String(shift!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift!.id, actor_user_id: actor.local_id, action: "sync.shift.opened", entity_type: "cashier_shift", entity_id: shiftPayload.shiftGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, openingFloat: shiftPayload.openingFloat }) });
          const result = { shiftGlobalId: shiftPayload.shiftGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "shifts", entity_type: "cashier_shift", entity_global_id: shiftPayload.shiftGlobalId, action: "open", server_revision: 1, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "inventory" && command.action === "adjust") {
          const adjustment = payload.data as z.infer<typeof payloadSchemas["inventory.adjust"]>;
          if (!hasPermission(assignment.role, "inventory:adjust") || adjustment.override && !hasPermission(assignment.role, "inventory:override")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "stock_movement", entity_id: adjustment.movementGlobalId, reason: adjustment.override ? "inventory:override" : "inventory:adjust", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks stock adjustment permission." };
          }
          const [ingredientIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.global_id, adjustment.ingredientGlobalId), eq(syncGlobalEntities.branch_id, device.branch_id))).limit(1);
          const [locationIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.global_id, adjustment.locationGlobalId), eq(syncGlobalEntities.branch_id, device.branch_id))).limit(1);
          const ingredientId = ingredientIdentity ? Number(ingredientIdentity.local_id) : 0;
          const locationId = locationIdentity ? Number(locationIdentity.local_id) : 0;
          const ingredient = ingredientId ? await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, ingredientId), eq(ingredients.branch_id, device.branch_id), eq(ingredients.is_active, true)) }) : undefined;
          const location = locationId ? await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.branch_id, device.branch_id), eq(inventoryLocations.is_active, true)) }) : undefined;
          const priorMovement = await tx.query.stockMovements.findFirst({ where: eq(stockMovements.idempotency_key, adjustment.idempotencyKey) });
          if (priorMovement) return { operationId: command.operationId, status: "rejected", error: "Stock adjustment idempotency key already exists outside this command." };
          if (!ingredient || !location) return { operationId: command.operationId, status: "rejected", error: "Ingredient or inventory location is not available in this branch." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          let movement;
          if (adjustment.direction === "positive") {
            movement = await postStockIncrease(tx, { branchId: device.branch_id, locationId, ingredientId, quantityBase: adjustment.quantityBase, unitCostMicros: adjustment.unitCostMicros, actorUserId: actor.local_id, idempotencyKey: adjustment.idempotencyKey, movementType: adjustment.opening ? "opening_balance" : "manual_positive", reason: adjustment.reason });
          } else {
            await tx.execute(sql`select id from stock_balances where ingredient_id = ${ingredientId} and location_id = ${locationId} for update`);
            const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, locationId), eq(stockBalances.ingredient_id, ingredientId)) });
            if (!balance) throw new Error("Stock balance is unavailable centrally.");
            if (balance.quantity_base < adjustment.quantityBase && (!adjustment.override || !ingredient.allow_negative)) throw new Error("Negative stock override is not permitted for this ingredient.");
            const [createdMovement] = await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: locationId, ingredient_id: ingredientId, movement_type: balance.quantity_base < adjustment.quantityBase ? "negative_override" : "manual_negative", direction: -1, quantity_base: adjustment.quantityBase, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: costMinorForQuantity(adjustment.quantityBase, balance.average_unit_cost_micros), source_type: "inventory_adjustment", source_id: adjustment.idempotencyKey, idempotency_key: adjustment.idempotencyKey, actor_user_id: actor.local_id, reason: adjustment.reason }).returning();
            await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - adjustment.quantityBase, updated_at: new Date() }).where(eq(stockBalances.id, balance.id));
            movement = createdMovement!;
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: balance.quantity_base < adjustment.quantityBase ? actor.local_id : null, action: balance.quantity_base < adjustment.quantityBase ? "inventory.negative_override" : "inventory.adjustment", entity_type: "stock_movement", entity_id: String(movement.id), reason: adjustment.reason });
          }
          const movementValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "stock_movement", global_id: adjustment.movementGlobalId, local_id: String(movement.id), server_revision: 1 };
          await tx.insert(syncGlobalEntities).values(movementValues);
          await tx.insert(syncEntityMappings).values({ ...movementValues, device_id: device.id, local_revision: 1 });
          const result = { movementGlobalId: adjustment.movementGlobalId, revision: 1 };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "stock_movement", entity_global_id: adjustment.movementGlobalId, action: "adjust", server_revision: 1, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "inventory" && ["ingredient_create", "ingredient_update", "ingredient_archive"].includes(command.action)) {
          const data = payload.data as z.infer<typeof payloadSchemas["inventory.ingredient_create"]> | z.infer<typeof payloadSchemas["inventory.ingredient_update"]> | z.infer<typeof payloadSchemas["inventory.ingredient_archive"]>;
          if (!hasPermission(assignment.role, "inventory:configure")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "ingredient", entity_id: data.ingredientGlobalId, reason: "inventory:configure", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks ingredient configuration permission." };
          }
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.global_id, data.ingredientGlobalId))).for("update").limit(1);
          const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "ingredient"), eq(syncEntityMappings.global_id, data.ingredientGlobalId))).for("update").limit(1);
          let ingredientId: number;
          let revision = 1;
          if (command.action === "ingredient_create") {
            if (identity) return { operationId: command.operationId, status: "rejected", error: "Ingredient identity already exists." };
            const values = (data as z.infer<typeof payloadSchemas["inventory.ingredient_create"]>).values;
            const [category] = await tx.select().from(ingredientCategories).where(and(eq(ingredientCategories.branch_id, device.branch_id), eq(ingredientCategories.code, values.categoryCode))).limit(1);
            const [location] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.branch_id, device.branch_id), eq(inventoryLocations.code, values.locationCode), eq(inventoryLocations.is_active, true))).limit(1);
            const [unit] = await tx.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.code, values.unitCode)).limit(1);
            if (!category || !location || !unit || unit.dimension !== values.dimension) return { operationId: command.operationId, status: "rejected", error: "Ingredient reference data is unavailable or incompatible." };
            const [duplicate] = await tx.select().from(ingredients).where(and(eq(ingredients.branch_id, device.branch_id), eq(ingredients.sku, values.sku))).limit(1);
            if (duplicate) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "ingredient_sku_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "ingredient", entity_global_id: data.ingredientGlobalId, local_payload: command.payload, server_snapshot: { sku: duplicate.sku, nameEn: duplicate.name_en }, reason: "The ingredient SKU is already used in this branch." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.ingredient.needs_review", entity_type: "ingredient", entity_id: data.ingredientGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "needs_review", result: { ingredientGlobalId: data.ingredientGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const [created] = await tx.insert(ingredients).values({ branch_id: device.branch_id, category_id: category.id, sku: values.sku, name_en: values.nameEn, name_ar: values.nameAr, base_unit_id: unit.id, dimension: values.dimension, default_location_id: location.id, is_active: true, is_tracked: values.tracked, reorder_level: values.reorderLevel, low_stock_threshold: values.lowStockThreshold, par_level: values.parLevel, allow_negative: values.allowNegative, average_unit_cost_micros: 0, created_by: actor.local_id, updated_by: actor.local_id }).returning();
            ingredientId = created!.id;
            await tx.insert(stockBalances).values({ branch_id: device.branch_id, location_id: location.id, ingredient_id: ingredientId, quantity_base: 0, average_unit_cost_micros: 0 });
            const shared = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "ingredient", global_id: data.ingredientGlobalId, local_id: String(ingredientId), server_revision: 1 };
            await tx.insert(syncGlobalEntities).values(shared);
            await tx.insert(syncEntityMappings).values({ ...shared, device_id: device.id, local_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.inventory.ingredient_created", entity_type: "ingredient", entity_id: data.ingredientGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            const result = { ingredientGlobalId: data.ingredientGlobalId, revision };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "ingredient", entity_global_id: data.ingredientGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: "accepted", result };
          }
          if (command.action === "ingredient_update") {
            const update = data as z.infer<typeof payloadSchemas["inventory.ingredient_update"]>;
            if (!identity || !deviceMapping || deviceMapping.server_revision !== update.baseRevision) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              const [current] = identity ? await tx.select().from(ingredients).where(and(eq(ingredients.id, Number(identity.local_id)), eq(ingredients.branch_id, device.branch_id))).limit(1) : [undefined];
              await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "ingredient", entity_global_id: update.ingredientGlobalId, local_payload: command.payload, server_snapshot: current ? { sku: current.sku, nameEn: current.name_en, nameAr: current.name_ar, isActive: current.is_active } : {}, reason: "The ingredient changed or is unavailable centrally." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.ingredient.needs_review", entity_type: "ingredient", entity_id: update.ingredientGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: update.baseRevision }) });
              return { operationId: command.operationId, status: "needs_review", result: { ingredientGlobalId: update.ingredientGlobalId } };
            }
            const values = update.values;
            const [category] = await tx.select().from(ingredientCategories).where(and(eq(ingredientCategories.branch_id, device.branch_id), eq(ingredientCategories.code, values.categoryCode))).limit(1);
            const [location] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.branch_id, device.branch_id), eq(inventoryLocations.code, values.locationCode), eq(inventoryLocations.is_active, true))).limit(1);
            const [unit] = await tx.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.code, values.unitCode)).limit(1);
            const current = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, Number(identity.local_id)), eq(ingredients.branch_id, device.branch_id)) });
            if (!category || !location || !unit || !current || unit.dimension !== values.dimension || current.dimension !== values.dimension || current.base_unit_id !== unit.id) return { operationId: command.operationId, status: "rejected", error: "Ingredient references or immutable base unit are invalid." };
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            await tx.update(ingredients).set({ name_en: values.nameEn, name_ar: values.nameAr, category_id: category.id, default_location_id: location.id, is_tracked: values.tracked, reorder_level: values.reorderLevel, low_stock_threshold: values.lowStockThreshold, par_level: values.parLevel, allow_negative: values.allowNegative, updated_by: actor.local_id, updated_at: new Date() }).where(eq(ingredients.id, current.id));
            revision = deviceMapping.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.inventory.ingredient_updated", entity_type: "ingredient", entity_id: update.ingredientGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            const result = { ingredientGlobalId: update.ingredientGlobalId, revision };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "ingredient", entity_global_id: update.ingredientGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: "accepted", result };
          }
          const archive = data as z.infer<typeof payloadSchemas["inventory.ingredient_archive"]>;
          if (!identity || !deviceMapping || deviceMapping.server_revision !== archive.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const [current] = identity ? await tx.select().from(ingredients).where(and(eq(ingredients.id, Number(identity.local_id)), eq(ingredients.branch_id, device.branch_id))).limit(1) : [undefined];
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "ingredient", entity_global_id: archive.ingredientGlobalId, local_payload: command.payload, server_snapshot: current ? { sku: current.sku, isActive: current.is_active } : {}, reason: "The ingredient changed or is unavailable centrally." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.ingredient.needs_review", entity_type: "ingredient", entity_id: archive.ingredientGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "needs_review", result: { ingredientGlobalId: archive.ingredientGlobalId } };
          }
          ingredientId = Number(identity.local_id);
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(ingredients).set({ is_active: false, updated_by: actor.local_id, updated_at: new Date() }).where(and(eq(ingredients.id, ingredientId), eq(ingredients.branch_id, device.branch_id)));
          revision = deviceMapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.inventory.ingredient_archived", entity_type: "ingredient", entity_id: archive.ingredientGlobalId, reason: archive.reason });
          const result = { ingredientGlobalId: archive.ingredientGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "ingredient", entity_global_id: archive.ingredientGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "inventory" && (command.action === "recipe_create" || command.action === "recipe_activate")) {
          const recipePayload = payload.data as z.infer<typeof payloadSchemas["inventory.recipe_create"]> | z.infer<typeof payloadSchemas["inventory.recipe_activate"]>;
          if (!hasPermission(assignment.role, "recipe:manage")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "recipe_version", entity_id: recipePayload.recipeVersionGlobalId, reason: "recipe:manage", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks recipe management permission." };
          }
          const [recipeIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "recipe_version"), eq(syncGlobalEntities.global_id, recipePayload.recipeVersionGlobalId))).for("update").limit(1);
          const [recipeMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "recipe_version"), eq(syncEntityMappings.global_id, recipePayload.recipeVersionGlobalId))).for("update").limit(1);
          if (command.action === "recipe_create") {
            const draft = recipePayload as z.infer<typeof payloadSchemas["inventory.recipe_create"]>;
            if (recipeIdentity) return { operationId: command.operationId, status: "rejected", error: "Recipe version identity already exists." };
            const resolve = async (type: string, globalId: string) => {
              const [mapped] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, type), eq(syncGlobalEntities.global_id, globalId), eq(syncGlobalEntities.branch_id, device.branch_id))).limit(1);
              return mapped ? Number(mapped.local_id) : 0;
            };
            const menuItemId = await resolve("menu_item", draft.menuItemGlobalId);
            const variantId = draft.variantGlobalId ? await resolve("menu_item_variant", draft.variantGlobalId) : null;
            if (!menuItemId || (draft.variantGlobalId && !variantId)) return { operationId: command.operationId, status: "retry_later", error: "Recipe menu dependencies have not synchronized." };
            const menuItem = await tx.query.menuItems.findFirst({ where: eq(menuItems.id, menuItemId), with: { category: true } });
            if (!menuItem || menuItem.category.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Recipe menu item is outside the paired branch." };
            if (variantId) {
              const variant = await tx.query.menuItemVariants.findFirst({ where: and(eq(menuItemVariants.id, variantId), eq(menuItemVariants.menu_item_id, menuItemId)) });
              if (!variant) return { operationId: command.operationId, status: "rejected", error: "Recipe variant does not belong to the menu item." };
            }
            const resolved = [];
            for (const component of draft.components) {
              const ingredientId = await resolve("ingredient", component.ingredientGlobalId);
              const locationId = await resolve("inventory_location", component.locationGlobalId);
              const unitId = await resolve("unit_of_measure", component.unitGlobalId);
              const modifierOptionId = component.modifierOptionGlobalId ? await resolve("modifier_option", component.modifierOptionGlobalId) : null;
              if (!ingredientId || !locationId || !unitId || (component.modifierOptionGlobalId && !modifierOptionId)) return { operationId: command.operationId, status: "retry_later", error: "Recipe inventory dependencies have not synchronized." };
              if (modifierOptionId) {
                const option = await tx.query.modifierOptions.findFirst({ where: eq(modifierOptions.id, modifierOptionId) });
                const link = option && await tx.query.menuItemModifierGroups.findFirst({ where: and(eq(menuItemModifierGroups.menu_item_id, menuItemId), eq(menuItemModifierGroups.modifier_group_id, option.modifier_group_id)) });
                if (!link) return { operationId: command.operationId, status: "rejected", error: "Recipe modifier is not configured for the menu item." };
              }
              const [ingredient] = await tx.select().from(ingredients).where(and(eq(ingredients.id, ingredientId), eq(ingredients.branch_id, device.branch_id))).limit(1);
              const [unit] = await tx.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, unitId)).limit(1);
              const [location] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.branch_id, device.branch_id))).limit(1);
              if (!ingredient || !unit || !location) return { operationId: command.operationId, status: "rejected", error: "Recipe component is outside the paired branch." };
              const quantityBase = convertScaledQuantity({ quantityScaled: component.quantityScaled, fromDimension: unit.dimension, toDimension: ingredient.dimension, factor: { numerator: unit.base_numerator, denominator: unit.base_denominator } });
              resolved.push({ ingredientId, locationId, unitId, modifierOptionId, quantityScaled: component.quantityScaled, quantityBase });
            }
            const latest = await tx.select().from(recipeVersions).where(and(eq(recipeVersions.menu_item_id, menuItemId), variantId ? eq(recipeVersions.variant_id, variantId) : sql`${recipeVersions.variant_id} is null`)).orderBy(sql`${recipeVersions.version} desc`).limit(1);
            if ((latest[0]?.version ?? 0) + 1 !== draft.version) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              const current = latest[0];
              await tx.update(syncCommandInbox).set({ result: { reason: "recipe_version_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "recipe_version", entity_global_id: draft.recipeVersionGlobalId, local_payload: command.payload, server_snapshot: { latestVersion: current?.version ?? 0 }, reason: "The recipe version sequence differs from the central history." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.recipe.needs_review", entity_type: "recipe_version", entity_id: draft.recipeVersionGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, expectedVersion: (current?.version ?? 0) + 1, receivedVersion: draft.version }) });
              return { operationId: command.operationId, status: "needs_review", result: { recipeVersionGlobalId: draft.recipeVersionGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const [created] = await tx.insert(recipeVersions).values({ branch_id: device.branch_id, menu_item_id: menuItemId, variant_id: variantId, version: draft.version, status: "draft", effective_at: null, yield_loss_bps: draft.yieldLossBps, authored_by: actor.local_id }).returning();
            await tx.insert(recipeComponents).values(resolved.map((row) => ({ recipe_version_id: created!.id, ingredient_id: row.ingredientId, source_location_id: row.locationId, unit_id: row.unitId, modifier_option_id: row.modifierOptionId, quantity_input_scaled: row.quantityScaled, quantity_base: row.quantityBase })));
            const entityValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "recipe_version", global_id: draft.recipeVersionGlobalId, local_id: String(created!.id), server_revision: 1 };
            await tx.insert(syncGlobalEntities).values(entityValues);
            await tx.insert(syncEntityMappings).values({ ...entityValues, device_id: device.id, local_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.recipe.created", entity_type: "recipe_version", entity_id: draft.recipeVersionGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, componentCount: resolved.length }) });
            const result = { recipeVersionGlobalId: draft.recipeVersionGlobalId, revision: 1 };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "recipe_version", entity_global_id: draft.recipeVersionGlobalId, action: command.action, server_revision: 1, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: "accepted", result };
          }
          const activation = recipePayload as z.infer<typeof payloadSchemas["inventory.recipe_activate"]>;
          if (!recipeIdentity || !recipeMapping || recipeMapping.server_revision !== activation.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "recipe_version", entity_global_id: activation.recipeVersionGlobalId, local_payload: command.payload, server_snapshot: { serverRevision: recipeMapping?.server_revision ?? null }, reason: "The recipe changed after the device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.recipe.needs_review", entity_type: "recipe_version", entity_id: activation.recipeVersionGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: activation.baseRevision, serverRevision: recipeMapping?.server_revision ?? null }) });
            return { operationId: command.operationId, status: "needs_review", result: { recipeVersionGlobalId: activation.recipeVersionGlobalId } };
          }
          const version = await tx.query.recipeVersions.findFirst({ where: and(eq(recipeVersions.id, Number(recipeIdentity.local_id)), eq(recipeVersions.branch_id, device.branch_id)), with: { components: true } });
          if (!version || version.status !== "draft" || !version.components.length) return { operationId: command.operationId, status: "rejected", error: "Only a complete draft recipe can be activated." };
          const base = new Map<string, number>();
          for (const component of version.components.filter((row) => row.modifier_option_id === null)) base.set(`${component.ingredient_id}:${component.source_location_id}`, (base.get(`${component.ingredient_id}:${component.source_location_id}`) ?? 0) + component.quantity_base);
          if ([...base.values()].some((quantity) => quantity <= 0) || version.components.some((row) => row.modifier_option_id !== null && row.quantity_base < 0 && (base.get(`${row.ingredient_id}:${row.source_location_id}`) ?? 0) + row.quantity_base <= 0)) return { operationId: command.operationId, status: "rejected", error: "Recipe modifier quantities are invalid." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          await tx.update(recipeVersions).set({ status: "retired" }).where(and(eq(recipeVersions.menu_item_id, version.menu_item_id), version.variant_id ? eq(recipeVersions.variant_id, version.variant_id) : sql`${recipeVersions.variant_id} is null`, eq(recipeVersions.status, "active")));
          await tx.update(recipeVersions).set({ status: "active", effective_at: new Date(), approved_by: actor.local_id, approved_at: new Date() }).where(eq(recipeVersions.id, version.id));
          const revision = recipeMapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, recipeIdentity.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, recipeMapping.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: actor.local_id, action: "sync.recipe.activated", entity_type: "recipe_version", entity_id: activation.recipeVersionGlobalId, reason: activation.reason });
          const result = { recipeVersionGlobalId: activation.recipeVersionGlobalId, revision, status: "active" };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "inventory", entity_type: "recipe_version", entity_global_id: activation.recipeVersionGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "procurement" && command.action.startsWith("purchase_order_")) {
          const data = payload.data as z.infer<typeof payloadSchemas["procurement.purchase_order_create"]> | z.infer<typeof payloadSchemas["procurement.purchase_order_lines_update"]> | z.infer<typeof payloadSchemas["procurement.purchase_order_submit"]> | z.infer<typeof payloadSchemas["procurement.purchase_order_approve"]> | z.infer<typeof payloadSchemas["procurement.purchase_order_cancel"]>;
          const orderGlobalId = data.purchaseOrderGlobalId;
          const permission = SYNC_COMMAND_REGISTRY[`${command.domain}.${command.action}` as keyof typeof SYNC_COMMAND_REGISTRY].permission;
          if (permission && !hasPermission(assignment.role, permission)) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "purchase_order", entity_id: orderGlobalId, reason: permission, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks purchase-order permission." };
          }
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_order"), eq(syncGlobalEntities.global_id, orderGlobalId), eq(syncGlobalEntities.branch_id, device.branch_id))).for("update").limit(1);
          const [mapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "purchase_order"), eq(syncEntityMappings.global_id, orderGlobalId))).for("update").limit(1);
          const action = command.action;
          if (!identity && action !== "purchase_order_create" && action !== "purchase_order_lines_update") {
            const foreignOrder = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_order"), eq(syncGlobalEntities.global_id, orderGlobalId)) });
            if (foreignOrder && foreignOrder.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Purchase order belongs to another branch." };
          }
          if (action === "purchase_order_create" || action === "purchase_order_lines_update") {
            const draft = data as z.infer<typeof payloadSchemas["procurement.purchase_order_create"]> | z.infer<typeof payloadSchemas["procurement.purchase_order_lines_update"]>;
            const creating = action === "purchase_order_create";
            if ((creating && identity) || (!creating && (!identity || !mapping || mapping.server_revision !== ("baseRevision" in draft ? draft.baseRevision : -1)))) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              const serverSnapshot: Record<string, unknown> = identity ? (await tx.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, Number(identity.local_id)), with: { lines: true } })) ?? {} : {};
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_order", entity_global_id: orderGlobalId, local_payload: command.payload, server_snapshot: serverSnapshot, reason: "The purchase order revision conflicts with central state." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.purchase_order.needs_review", entity_type: "purchase_order", entity_id: orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: "baseRevision" in draft ? draft.baseRevision : 0 }) });
              return { operationId: command.operationId, status: "needs_review", result: { purchaseOrderGlobalId: orderGlobalId } };
            }
            const supplierGlobalId = creating ? (draft as z.infer<typeof payloadSchemas["procurement.purchase_order_create"]>).supplierGlobalId : null;
            const supplierIdentity = supplierGlobalId ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.global_id, supplierGlobalId)) }) : undefined;
            const foreignSupplier = supplierGlobalId && !supplierIdentity ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.global_id, supplierGlobalId)) }) : undefined;
            if (foreignSupplier && foreignSupplier.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Purchase order supplier belongs to another branch." };
            const supplier = supplierIdentity ? await tx.query.suppliers.findFirst({ where: and(eq(suppliers.id, Number(supplierIdentity.local_id)), eq(suppliers.branch_id, device.branch_id), eq(suppliers.is_active, true)) }) : undefined;
            if (creating && !supplier) return { operationId: command.operationId, status: "retry_later", error: "Supplier dependency has not synchronized." };
            const lines = [];
            let total = 0;
            for (const inputLine of draft.lines) {
              const ingredientIdentity = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.global_id, inputLine.ingredientGlobalId)) });
              const foreignIngredient = !ingredientIdentity ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.global_id, inputLine.ingredientGlobalId)) }) : undefined;
              if (foreignIngredient && foreignIngredient.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Purchase-order ingredient belongs to another branch." };
              const unitIdentity = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "unit_of_measure"), eq(syncGlobalEntities.global_id, inputLine.unitGlobalId)) });
              if (!ingredientIdentity || !unitIdentity) return { operationId: command.operationId, status: "retry_later", error: "Ingredient or unit dependency has not synchronized." };
              const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, Number(ingredientIdentity.local_id)), eq(ingredients.branch_id, device.branch_id), eq(ingredients.is_active, true)) });
              const unit = await tx.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, Number(unitIdentity.local_id)) });
              const packageRow = inputLine.packageConversionCode && ingredient ? await tx.query.ingredientPackageConversions.findFirst({ where: and(eq(ingredientPackageConversions.ingredient_id, ingredient.id), eq(ingredientPackageConversions.code, inputLine.packageConversionCode), eq(ingredientPackageConversions.is_active, true)) }) : undefined;
              if (!ingredient || !unit || unit.dimension !== ingredient.dimension || (inputLine.packageConversionCode && !packageRow)) return { operationId: command.operationId, status: "rejected", error: "Purchase-order line references are invalid for this branch." };
              const factor = packageRow ? { numerator: packageRow.base_numerator, denominator: packageRow.base_denominator } : { numerator: unit.base_numerator, denominator: unit.base_denominator };
              const quantityBase = convertScaledQuantity({ quantityScaled: inputLine.quantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor });
              const lineTotalAmount = multiplyDivide(inputLine.quantityScaled, inputLine.unitPriceMinor, 1_000);
              total += lineTotalAmount;
              if (!Number.isSafeInteger(total) || total > 2_147_483_647) return { operationId: command.operationId, status: "rejected", error: "Purchase order total exceeds supported range." };
              lines.push({ ingredient, unit, packageRow, inputLine, factor, quantityBase, lineTotalAmount });
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            let orderId: number;
            let revision: number;
            if (creating) {
              const create = draft as z.infer<typeof payloadSchemas["procurement.purchase_order_create"]>;
              const [created] = await tx.insert(purchaseOrders).values({ branch_id: device.branch_id, supplier_id: supplier!.id, supplier_code_snapshot: supplier!.code, supplier_name_en_snapshot: supplier!.name_en, supplier_name_ar_snapshot: supplier!.name_ar, po_number: create.poNumber, status: "draft", receiving_status: "not_received", order_date: new Date(), currency: "EGP", expected_date: create.expectedDate ? new Date(create.expectedDate) : null, subtotal_amount: total, total_amount: total, notes: create.notes, idempotency_key: command.idempotencyKey, created_by: actor.local_id }).returning();
              orderId = created!.id;
              revision = 1;
            } else {
              orderId = Number(identity!.local_id);
              const current = await tx.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.branch_id, device.branch_id)) });
              if (!current || current.status !== "draft") return { operationId: command.operationId, status: "rejected", error: "Only draft purchase orders can be edited." };
              await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchase_order_id, orderId));
              await tx.update(purchaseOrders).set({ subtotal_amount: total, total_amount: total, updated_at: new Date() }).where(eq(purchaseOrders.id, orderId));
              revision = mapping!.server_revision + 1;
            }
            await tx.insert(purchaseOrderLines).values(lines.map(({ ingredient, unit, packageRow, inputLine, factor, quantityBase, lineTotalAmount }) => ({ purchase_order_id: orderId, ingredient_id: ingredient.id, package_conversion_id: packageRow?.id ?? null, unit_id: unit.id, ingredient_sku: ingredient.sku, ingredient_name_en: ingredient.name_en, ingredient_name_ar: ingredient.name_ar, unit_code: packageRow?.code ?? unit.code, quantity_input_scaled: inputLine.quantityScaled, quantity_base: quantityBase, conversion_numerator_snapshot: factor.numerator, conversion_denominator_snapshot: factor.denominator, unit_price_minor: inputLine.unitPriceMinor, line_total_amount: lineTotalAmount, notes: inputLine.notes })));
            const shared = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_order", global_id: orderGlobalId, local_id: String(orderId), server_revision: revision };
            if (creating) {
              await tx.insert(syncGlobalEntities).values(shared);
              await tx.insert(syncEntityMappings).values({ ...shared, device_id: device.id, local_revision: 1 });
            } else {
              await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity!.id));
              await tx.update(syncEntityMappings).set({ server_revision: revision, local_revision: mapping!.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping!.id));
            }
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: creating ? "sync.purchase_order.created" : "sync.purchase_order.lines_updated", entity_type: "purchase_order", entity_id: orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, lineCount: lines.length, totalMinor: total }) });
            const result = { purchaseOrderGlobalId: orderGlobalId, revision };
            await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "procurement", entity_type: "purchase_order", entity_global_id: orderGlobalId, action, server_revision: revision, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: "accepted", result };
          }
          const baseRevision = "baseRevision" in data ? data.baseRevision : -1;
          if (!identity || !mapping || mapping.server_revision !== baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            const serverSnapshot: Record<string, unknown> = identity ? (await tx.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, Number(identity.local_id)) })) ?? {} : {};
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_order", entity_global_id: orderGlobalId, local_payload: command.payload, server_snapshot: serverSnapshot, reason: "The purchase-order lifecycle revision conflicts with central state." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.purchase_order.needs_review", entity_type: "purchase_order", entity_id: orderGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "needs_review", result: { purchaseOrderGlobalId: orderGlobalId } };
          }
          const order = await tx.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.id, Number(identity.local_id)), eq(purchaseOrders.branch_id, device.branch_id)) });
          const validTransition = action === "purchase_order_submit" ? order?.status === "draft" : action === "purchase_order_approve" ? order?.status === "submitted" : !!order && ["draft", "submitted"].includes(order.status);
          if (!order || !validTransition) return { operationId: command.operationId, status: "rejected", error: "Purchase-order lifecycle transition is invalid." };
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const nextStatus = action === "purchase_order_submit" ? "submitted" : action === "purchase_order_approve" ? "approved" : "cancelled";
          const extra = action === "purchase_order_cancel" ? { cancelled_by: actor.local_id, cancellation_reason: (data as z.infer<typeof payloadSchemas["procurement.purchase_order_cancel"]>).reason } : action === "purchase_order_submit" ? { submitted_by: actor.local_id } : { approved_by: actor.local_id };
          await tx.update(purchaseOrders).set({ status: nextStatus, ...extra, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id));
          const revision = mapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: action === "purchase_order_approve" ? actor.local_id : null, action: `sync.purchase_order.${nextStatus}`, entity_type: "purchase_order", entity_id: orderGlobalId, reason: action === "purchase_order_cancel" ? (data as z.infer<typeof payloadSchemas["procurement.purchase_order_cancel"]>).reason : null });
          const result = { purchaseOrderGlobalId: orderGlobalId, revision, status: nextStatus };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "procurement", entity_type: "purchase_order", entity_global_id: orderGlobalId, action, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "receiving") {
          const receipt = payload.data as z.infer<typeof payloadSchemas["receiving.receipt_create"]> | z.infer<typeof payloadSchemas["receiving.receipt_edit"]> | z.infer<typeof payloadSchemas["receiving.receipt_post"]> | z.infer<typeof payloadSchemas["receiving.receipt_reverse"]>;
          const receiptGlobalId = "receiptGlobalId" in receipt ? receipt.receiptGlobalId : "";
          if (command.action === "receipt_reverse") {
            const reversal = receipt as z.infer<typeof payloadSchemas["receiving.receipt_reverse"]>;
            if (!hasPermission(assignment.role, "purchase-receipt:reverse")) {
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "purchase_receipt", entity_id: receiptGlobalId, reason: "purchase-receipt:reverse", details: JSON.stringify({ sourceOperationId: command.operationId }) });
              return { operationId: command.operationId, status: "rejected", error: "Actor lacks receipt-reversal permission." };
            }
            const [receiptIdentity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, reversal.receiptGlobalId))).for("update").limit(1);
            const [receiptMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "purchase_receipt"), eq(syncEntityMappings.global_id, reversal.receiptGlobalId))).for("update").limit(1);
            if (!receiptIdentity) {
              const foreignReceipt = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, reversal.receiptGlobalId)) });
              if (foreignReceipt && foreignReceipt.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Receipt belongs to another branch." };
            }
            if (!receiptIdentity || !receiptMapping) return { operationId: command.operationId, status: "retry_later", error: "Receipt dependency has not synchronized." };
            if (receiptMapping.server_revision !== reversal.baseRevision) {
              const current = await tx.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, Number(receiptIdentity.local_id)) });
              const [conflictInbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              const result = { receiptGlobalId: reversal.receiptGlobalId, reason: "revision_conflict" };
              await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, conflictInbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: conflictInbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_receipt", entity_global_id: reversal.receiptGlobalId, local_payload: command.payload, server_snapshot: current ?? {}, reason: "The receipt changed centrally after the device's base revision." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "purchase_receipt.needs_review", entity_type: "purchase_receipt", entity_id: reversal.receiptGlobalId, reason: reversal.reason, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: reversal.baseRevision, serverRevision: receiptMapping.server_revision }) });
              return { operationId: command.operationId, status: "needs_review", result };
            }
            const [sourceReceipt] = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.id, Number(receiptIdentity.local_id)), eq(purchaseReceipts.branch_id, device.branch_id))).for("update").limit(1);
            if (!sourceReceipt || sourceReceipt.status !== "posted" || !sourceReceipt.posted_at) return { operationId: command.operationId, status: "rejected", error: "Only a posted receipt can be reversed." };
            const duplicate = await tx.query.purchaseReceiptReversals.findFirst({ where: eq(purchaseReceiptReversals.idempotency_key, reversal.idempotencyKey) });
            if (duplicate) return { operationId: command.operationId, status: "already_applied", result: { receiptGlobalId: reversal.receiptGlobalId, reversalStatus: duplicate.status } };
            const lines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, sourceReceipt.id), orderBy: [desc(purchaseReceiptLines.id)] });
            const ingredientTotals = new Map<number, number>();
            for (const line of lines) if (line.accepted_quantity_base > 0) ingredientTotals.set(line.ingredient_id, (ingredientTotals.get(line.ingredient_id) ?? 0) + line.accepted_quantity_base);
            let safe = true;
            let reviewReason = "";
            for (const ingredientId of [...ingredientTotals.keys()].sort((a, b) => a - b)) {
              await tx.execute(sql`select id from stock_balances where branch_id = ${device.branch_id} and location_id = ${sourceReceipt.location_id} and ingredient_id = ${ingredientId} for update`);
              const later = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.branch_id, device.branch_id), eq(stockMovements.location_id, sourceReceipt.location_id), eq(stockMovements.ingredient_id, ingredientId), sql`${stockMovements.created_at} >= ${sourceReceipt.posted_at}`, sql`not (${stockMovements.purchase_receipt_id} = ${sourceReceipt.id} and ${stockMovements.movement_type} = 'purchase_receipt')`)).limit(1);
              const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, sourceReceipt.location_id), eq(stockBalances.ingredient_id, ingredientId)) });
              const missingSnapshot = lines.some((line) => line.ingredient_id === ingredientId && line.accepted_quantity_base > 0 && (line.balance_quantity_before == null || line.balance_unit_cost_before == null || line.ingredient_average_unit_cost_before == null));
              if (later.length || !balance || balance.quantity_base < ingredientTotals.get(ingredientId)! || missingSnapshot) { safe = false; reviewReason = later.length ? "Later inventory activity exists; manual valuation review is required" : "Insufficient stock or missing receipt valuation snapshot"; break; }
            }
            const status = safe ? "reversed" : "needs_review";
            const [record] = await tx.insert(purchaseReceiptReversals).values({ receipt_id: sourceReceipt.id, branch_id: device.branch_id, reason: reversal.reason, status, actor_user_id: actor.local_id, idempotency_key: reversal.idempotencyKey }).returning();
            const now = new Date();
            if (safe) for (const line of lines) {
              if (!line.accepted_quantity_base) continue;
              const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, sourceReceipt.location_id), eq(stockBalances.ingredient_id, line.ingredient_id))).for("update").limit(1);
              await tx.update(stockBalances).set({ quantity_base: balance!.quantity_base - line.accepted_quantity_base, average_unit_cost_micros: line.balance_unit_cost_before!, updated_at: now }).where(eq(stockBalances.id, balance!.id));
              await tx.update(ingredients).set({ average_unit_cost_micros: line.ingredient_average_unit_cost_before!, updated_by: actor.local_id, updated_at: now }).where(eq(ingredients.id, line.ingredient_id));
              await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: sourceReceipt.location_id, ingredient_id: line.ingredient_id, movement_type: "purchase_receipt_reversal", direction: -1, quantity_base: line.accepted_quantity_base, unit_cost_micros: line.accepted_unit_cost_micros_snapshot, total_cost_amount: line.line_total_amount, source_type: "purchase_receipt_reversal", source_id: String(record!.id), idempotency_key: `purchase-receipt-reversal:${record!.id}:line:${line.id}`, actor_user_id: actor.local_id, reason: reversal.reason, purchase_receipt_id: sourceReceipt.id, purchase_receipt_line_id: line.id, created_at: now });
            }
            await tx.update(purchaseReceipts).set({ status, reversal_reason: safe ? reversal.reason : null, needs_review_reason: safe ? null : `${reversal.reason}: ${reviewReason}`, updated_at: now }).where(eq(purchaseReceipts.id, sourceReceipt.id));
            if (safe) {
              const receiptRows = await tx.select({ id: purchaseReceipts.id, status: purchaseReceipts.status, postedAt: purchaseReceipts.posted_at }).from(purchaseReceipts).where(eq(purchaseReceipts.purchase_order_id, sourceReceipt.purchase_order_id));
              const postedReceiptIds = receiptRows.filter((item) => item.status === "posted" || item.status === "needs_review" && item.postedAt !== null);
              const postedLines = postedReceiptIds.length ? await tx.select({ poLineId: purchaseReceiptLines.purchase_order_line_id, accepted: purchaseReceiptLines.accepted_quantity_base }).from(purchaseReceiptLines).where(inArray(purchaseReceiptLines.receipt_id, postedReceiptIds.map((item) => item.id))) : [];
              const receivedByLine = new Map<number, number>(); for (const postedLine of postedLines) receivedByLine.set(postedLine.poLineId, (receivedByLine.get(postedLine.poLineId) ?? 0) + postedLine.accepted);
              const orderedLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, sourceReceipt.purchase_order_id) });
              const anyReceived = [...receivedByLine.values()].some((quantity) => quantity > 0);
              const fullyReceived = orderedLines.length > 0 && orderedLines.every((line) => (receivedByLine.get(line.id) ?? 0) >= line.quantity_base);
              await tx.update(purchaseOrders).set({ receiving_status: fullyReceived ? "fully_received" : anyReceived ? "partially_received" : "not_received", updated_at: now }).where(eq(purchaseOrders.id, sourceReceipt.purchase_order_id));
            }
            const reversalValues = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_receipt_reversal", global_id: reversal.reversalGlobalId, local_id: String(record!.id), server_revision: 1 };
            await tx.insert(syncGlobalEntities).values(reversalValues); await tx.insert(syncEntityMappings).values({ ...reversalValues, device_id: device.id, local_revision: 1 });
            const nextRevision = receiptMapping.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: nextRevision, updated_at: now }).where(eq(syncGlobalEntities.id, receiptIdentity.id));
            await tx.update(syncEntityMappings).set({ server_revision: nextRevision, local_revision: receiptMapping.local_revision + 1, updated_at: now }).where(eq(syncEntityMappings.id, receiptMapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: actor.local_id, action: safe ? "purchase_receipt.reverse" : "purchase_receipt.needs_review", entity_type: "purchase_receipt", entity_id: reversal.receiptGlobalId, reason: reversal.reason, details: JSON.stringify({ reversalGlobalId: reversal.reversalGlobalId, status, reviewReason: safe ? null : reviewReason }) });
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: 1, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: safe ? "accepted" : "needs_review" }).returning();
            const result = { receiptGlobalId: reversal.receiptGlobalId, reversalGlobalId: reversal.reversalGlobalId, status, revision: nextRevision }; await tx.update(syncCommandInbox).set({ result, processed_at: now }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "receiving", entity_type: "purchase_receipt", entity_global_id: reversal.receiptGlobalId, action: "receipt_reverse", server_revision: nextRevision, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: safe ? "accepted" : "needs_review", result };
          }
          if (!hasPermission(assignment.role, command.action === "receipt_post" ? "purchase-receipt:post" : "purchase-receipt:create") || command.action === "receipt_post" && (receipt as z.infer<typeof payloadSchemas["receiving.receipt_post"]>).approveVariance && !hasPermission(assignment.role, "purchase-receipt:variance:approve")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "purchase_receipt", entity_id: receiptGlobalId, reason: "purchase-receipt", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks receiving permission." };
          }
          const creating = command.action === "receipt_create";
          const orderGlobalId = creating ? (receipt as z.infer<typeof payloadSchemas["receiving.receipt_create"]>).purchaseOrderGlobalId : "";
          const orderIdentity = creating ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "purchase_order"), eq(syncGlobalEntities.global_id, orderGlobalId)) }) : undefined;
          const foreignOrder = creating && !orderIdentity ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_order"), eq(syncGlobalEntities.global_id, orderGlobalId)) }) : undefined;
          if (foreignOrder && foreignOrder.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Receipt purchase order belongs to another branch." };
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, receiptGlobalId))).for("update").limit(1);
          const [mapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "purchase_receipt"), eq(syncEntityMappings.global_id, receiptGlobalId))).for("update").limit(1);
          if (!creating && !identity) {
            const foreignReceipt = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, receiptGlobalId)) });
            if (foreignReceipt && foreignReceipt.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Receipt belongs to another branch." };
          }
          if (command.action === "receipt_create") {
            const draft = receipt as z.infer<typeof payloadSchemas["receiving.receipt_create"]>;
            if (identity) return { operationId: command.operationId, status: "rejected", error: "Receipt identity already exists." };
            const locationIdentity = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.global_id, draft.locationGlobalId)) });
            const foreignLocation = !locationIdentity ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.global_id, draft.locationGlobalId)) }) : undefined;
            if (foreignLocation && foreignLocation.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Receipt location belongs to another branch." };
            const order = orderIdentity && await tx.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.id, Number(orderIdentity.local_id)), eq(purchaseOrders.branch_id, device.branch_id), eq(purchaseOrders.status, "approved")) });
            const location = locationIdentity && await tx.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, Number(locationIdentity.local_id)), eq(inventoryLocations.branch_id, device.branch_id), eq(inventoryLocations.is_active, true)) });
            if (!order || !location) return { operationId: command.operationId, status: "retry_later", error: "Approved purchase-order or inventory-location dependency is unavailable." };
            const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, order.id), orderBy: [asc(purchaseOrderLines.id)] });
            const receiptLines = [];
            for (const line of draft.lines) {
              const poLine = poLines[line.poLineIndex];
              if (!poLine) return { operationId: command.operationId, status: "rejected", error: "Receipt references an unknown purchase-order line." };
              const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, poLine.ingredient_id), eq(ingredients.branch_id, device.branch_id)) });
              if (!ingredient) return { operationId: command.operationId, status: "rejected", error: "Receipt ingredient is outside the paired branch." };
              const accepted = convertScaledQuantity({ quantityScaled: line.acceptedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: poLine.conversion_numerator_snapshot ?? 1, denominator: poLine.conversion_denominator_snapshot ?? 1 } });
              const rejected = convertScaledQuantity({ quantityScaled: line.rejectedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: poLine.conversion_numerator_snapshot ?? 1, denominator: poLine.conversion_denominator_snapshot ?? 1 } });
              const damaged = convertScaledQuantity({ quantityScaled: line.damagedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: poLine.conversion_numerator_snapshot ?? 1, denominator: poLine.conversion_denominator_snapshot ?? 1 } });
              const actualPrice = line.actualUnitPriceMinor ?? poLine.unit_price_minor;
              receiptLines.push({ poLine, ingredient, line, accepted, rejected, damaged, actualPrice, cost: multiplyDivideFactors(actualPrice, [1_000_000, poLine.conversion_denominator_snapshot ?? 1], [poLine.conversion_numerator_snapshot ?? 1]), total: multiplyDivide(line.acceptedQuantityScaled, actualPrice, 1_000) });
            }
            const [row] = await tx.insert(purchaseReceipts).values({ branch_id: device.branch_id, purchase_order_id: order.id, supplier_id: order.supplier_id, supplier_code_snapshot: order.supplier_code_snapshot, supplier_name_en_snapshot: order.supplier_name_en_snapshot, supplier_name_ar_snapshot: order.supplier_name_ar_snapshot, po_number_snapshot: order.po_number, receipt_number: draft.receiptNumber, location_id: location.id, supplier_delivery_note: draft.supplierDeliveryNote, supplier_invoice_reference: draft.supplierInvoiceReference, received_at: new Date(draft.receivedAt), received_by: actor.local_id, notes: draft.notes, status: "draft", idempotency_key: command.idempotencyKey }).returning(); if (!row) throw new Error("Receipt insert failed.");
            await tx.insert(purchaseReceiptLines).values(receiptLines.map(({ poLine, ingredient, line, accepted, rejected, damaged, actualPrice, cost, total }) => ({ receipt_id: row.id, purchase_order_line_id: poLine.id, ingredient_id: ingredient.id, ingredient_sku_snapshot: poLine.ingredient_sku, ingredient_name_en_snapshot: poLine.ingredient_name_en, ingredient_name_ar_snapshot: poLine.ingredient_name_ar, package_conversion_id: poLine.package_conversion_id, unit_id: poLine.unit_id, unit_code_snapshot: poLine.unit_code, conversion_numerator_snapshot: poLine.conversion_numerator_snapshot ?? 1, conversion_denominator_snapshot: poLine.conversion_denominator_snapshot ?? 1, ordered_quantity_base_snapshot: poLine.quantity_base, po_unit_price_minor_snapshot: poLine.unit_price_minor, quantity_input_scaled: line.acceptedQuantityScaled + line.rejectedQuantityScaled + line.damagedQuantityScaled, accepted_quantity_base: accepted, rejected_quantity_base: rejected, damaged_quantity_base: damaged, actual_unit_price_minor: actualPrice, accepted_unit_cost_micros_snapshot: cost, line_total_amount: total, notes: line.notes })));
            const values = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "purchase_receipt", global_id: receiptGlobalId, local_id: String(row.id), server_revision: 1 };
            await tx.insert(syncGlobalEntities).values(values); await tx.insert(syncEntityMappings).values({ ...values, device_id: device.id, local_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.purchase_receipt.created", entity_type: "purchase_receipt", entity_id: receiptGlobalId });
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: 1, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            const result = { receiptGlobalId, revision: 1, status: "draft" }; await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "receiving", entity_type: "purchase_receipt", entity_global_id: receiptGlobalId, action: command.action, server_revision: 1, source_operation_id: command.operationId });
            return { operationId: command.operationId, status: "accepted", result };
          }
          if (!identity || !mapping || mapping.server_revision !== ("baseRevision" in receipt ? receipt.baseRevision : command.baseRevision)) return { operationId: command.operationId, status: "needs_review", result: { receiptGlobalId } };
          const current = await tx.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, Number(identity.local_id)), eq(purchaseReceipts.branch_id, device.branch_id)) });
          if (!current) return { operationId: command.operationId, status: "rejected", error: "Receipt is unavailable in this branch." };
          if (command.action === "receipt_edit") {
            const edit = receipt as z.infer<typeof payloadSchemas["receiving.receipt_edit"]>;
            if (current.status !== "draft") return { operationId: command.operationId, status: "rejected", error: "Only draft receipts can be edited." };
            const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, current.purchase_order_id), orderBy: [asc(purchaseOrderLines.id)] });
            const existingLines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, current.id) });
            const byPoLine = new Map(existingLines.map((line) => [line.purchase_order_line_id, line]));
            for (const value of edit.lines) {
              const poLine = poLines[value.poLineIndex]; const saved = poLine && byPoLine.get(poLine.id);
              if (!poLine || !saved) return { operationId: command.operationId, status: "rejected", error: "Receipt line identity does not match the saved PO snapshot." };
              const ingredient = await tx.query.ingredients.findFirst({ where: eq(ingredients.id, saved.ingredient_id) });
              if (!ingredient) throw new Error("Receipt ingredient is unavailable.");
              const factor = { numerator: saved.conversion_numerator_snapshot, denominator: saved.conversion_denominator_snapshot };
              const accepted = convertScaledQuantity({ quantityScaled: value.acceptedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor });
              const rejected = convertScaledQuantity({ quantityScaled: value.rejectedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor });
              const damaged = convertScaledQuantity({ quantityScaled: value.damagedQuantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor });
              const actual = value.actualUnitPriceMinor ?? saved.po_unit_price_minor_snapshot;
              await tx.update(purchaseReceiptLines).set({ quantity_input_scaled: value.acceptedQuantityScaled + value.rejectedQuantityScaled + value.damagedQuantityScaled, accepted_quantity_base: accepted, rejected_quantity_base: rejected, damaged_quantity_base: damaged, actual_unit_price_minor: actual, accepted_unit_cost_micros_snapshot: multiplyDivideFactors(actual, [1_000_000, factor.denominator], [factor.numerator]), line_total_amount: multiplyDivide(value.acceptedQuantityScaled, actual, 1_000), notes: value.notes }).where(eq(purchaseReceiptLines.id, saved.id));
            }
            await tx.update(purchaseReceipts).set({ supplier_delivery_note: edit.supplierDeliveryNote, supplier_invoice_reference: edit.supplierInvoiceReference, notes: edit.notes, updated_at: new Date() }).where(eq(purchaseReceipts.id, current.id));
          } else if (command.action === "receipt_post") {
            const post = receipt as z.infer<typeof payloadSchemas["receiving.receipt_post"]>;
            if (current.status === "posted") return { operationId: command.operationId, status: "already_applied", result: { receiptGlobalId, status: "posted" } };
            if (current.status !== "draft") return { operationId: command.operationId, status: "rejected", error: "Only draft receipts can be posted." };
            const order = await tx.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.id, current.purchase_order_id), eq(purchaseOrders.branch_id, device.branch_id), eq(purchaseOrders.status, "approved")) });
            if (!order) return { operationId: command.operationId, status: "rejected", error: "Receipt purchase order is not approved." };
            const lines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, current.id), orderBy: [asc(purchaseReceiptLines.id)] });
            const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, order.id) });
            const previousReceipts = await tx.query.purchaseReceipts.findMany({ where: and(eq(purchaseReceipts.purchase_order_id, order.id), eq(purchaseReceipts.status, "posted")), with: { lines: true } });
            const previous = new Map<number, number>();
            for (const prior of previousReceipts) for (const line of prior.lines) previous.set(line.purchase_order_line_id, (previous.get(line.purchase_order_line_id) ?? 0) + line.accepted_quantity_base);
            const over = lines.some((line) => (previous.get(line.purchase_order_line_id) ?? 0) + line.accepted_quantity_base > (poLines.find((p) => p.id === line.purchase_order_line_id)?.quantity_base ?? 0));
            const variance = lines.some((line) => Math.abs(line.actual_unit_price_minor - line.po_unit_price_minor_snapshot) * 100 > line.po_unit_price_minor_snapshot * 10);
            if (over && (!post.overreceive || !post.overreceiveReason || !hasPermission(assignment.role, "purchase-receipt:overreceive"))) return { operationId: command.operationId, status: "rejected", error: "Over-receiving requires an authorized override and reason." };
            if (variance && (!post.approveVariance || !post.varianceReason || !hasPermission(assignment.role, "purchase-receipt:variance:approve"))) return { operationId: command.operationId, status: "rejected", error: "Price variance requires authorized approval and a reason." };
            const now = new Date();
            for (const line of lines) {
              const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, device.branch_id)) });
              if (!ingredient) throw new Error("Receipt ingredient escaped branch scope.");
              await tx.insert(stockBalances).values({ branch_id: device.branch_id, location_id: current.location_id, ingredient_id: ingredient.id, quantity_base: 0, average_unit_cost_micros: 0 }).onConflictDoNothing();
              await tx.execute(sql`select id from stock_balances where branch_id = ${device.branch_id} and location_id = ${current.location_id} and ingredient_id = ${ingredient.id} for update`);
              const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, current.location_id), eq(stockBalances.ingredient_id, ingredient.id))).limit(1);
              if (!balance) throw new Error("Receipt balance lock failed.");
              const afterCost = line.accepted_quantity_base > 0 ? balance.quantity_base > 0 ? movingWeightedAverage({ existingQuantity: balance.quantity_base, existingUnitCostMicros: balance.average_unit_cost_micros, addedQuantity: line.accepted_quantity_base, addedUnitCostMicros: line.accepted_unit_cost_micros_snapshot }) : line.accepted_unit_cost_micros_snapshot : balance.average_unit_cost_micros;
              await tx.update(purchaseReceiptLines).set({ balance_quantity_before: balance.quantity_base, balance_unit_cost_before: balance.average_unit_cost_micros, ingredient_average_unit_cost_before: ingredient.average_unit_cost_micros }).where(eq(purchaseReceiptLines.id, line.id));
              if (line.accepted_quantity_base > 0) {
                await tx.update(stockBalances).set({ quantity_base: balance.quantity_base + line.accepted_quantity_base, average_unit_cost_micros: afterCost, updated_at: now }).where(eq(stockBalances.id, balance.id));
                await tx.update(ingredients).set({ average_unit_cost_micros: afterCost, updated_by: actor.local_id, updated_at: now }).where(eq(ingredients.id, ingredient.id));
                await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: current.location_id, ingredient_id: ingredient.id, movement_type: "purchase_receipt", direction: 1, quantity_base: line.accepted_quantity_base, unit_cost_micros: line.accepted_unit_cost_micros_snapshot, total_cost_amount: line.line_total_amount, source_type: "purchase_receipt", source_id: String(current.id), idempotency_key: `purchase-receipt:${current.id}:line:${line.id}`, actor_user_id: actor.local_id, reason: line.notes, purchase_receipt_id: current.id, purchase_receipt_line_id: line.id, created_at: now });
              }
            }
            await tx.update(purchaseReceipts).set({ status: "posted", posted_at: now, posted_by: actor.local_id, variance_approved_by: variance ? actor.local_id : null, variance_reason: post.varianceReason, overreceive_approved_by: over ? actor.local_id : null, overreceive_reason: post.overreceiveReason, updated_at: now }).where(eq(purchaseReceipts.id, current.id));
            const receiptRows = await tx.select({ id: purchaseReceipts.id, status: purchaseReceipts.status, postedAt: purchaseReceipts.posted_at }).from(purchaseReceipts).where(eq(purchaseReceipts.purchase_order_id, order.id));
            const postedReceiptIds = receiptRows.filter((item) => item.status === "posted" || item.status === "needs_review" && item.postedAt !== null);
            const postedLines = postedReceiptIds.length ? await tx.select({ poLineId: purchaseReceiptLines.purchase_order_line_id, accepted: purchaseReceiptLines.accepted_quantity_base }).from(purchaseReceiptLines).where(inArray(purchaseReceiptLines.receipt_id, postedReceiptIds.map((item) => item.id))) : [];
            const receivedByLine = new Map<number, number>();
            for (const postedLine of postedLines) receivedByLine.set(postedLine.poLineId, (receivedByLine.get(postedLine.poLineId) ?? 0) + postedLine.accepted);
            const orderedLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, order.id) });
            const anyReceived = [...receivedByLine.values()].some((quantity) => quantity > 0);
            const fullyReceived = orderedLines.length > 0 && orderedLines.every((line) => (receivedByLine.get(line.id) ?? 0) >= line.quantity_base);
            await tx.update(purchaseOrders).set({ receiving_status: fullyReceived ? "fully_received" : anyReceived ? "partially_received" : "not_received", updated_at: now }).where(eq(purchaseOrders.id, order.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: variance || over ? actor.local_id : null, action: "purchase_receipt.post", entity_type: "purchase_receipt", entity_id: receiptGlobalId, reason: over ? post.overreceiveReason : variance ? post.varianceReason : null, details: JSON.stringify({ sourceOperationId: command.operationId, lineCount: lines.length }) });
          } else return { operationId: command.operationId, status: "rejected", error: "Unsupported receipt action." };
          const nextRevision = mapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: nextRevision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
          await tx.update(syncEntityMappings).set({ server_revision: nextRevision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: 1, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          const result = { receiptGlobalId, revision: nextRevision }; await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "receiving", entity_type: "purchase_receipt", entity_global_id: receiptGlobalId, action: command.action, server_revision: nextRevision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "supplier_returns") {
          const action = command.action;
          const returnGlobalId = (payload.data as { supplierReturnGlobalId?: string }).supplierReturnGlobalId ?? "";
          const requiredPermission = SYNC_COMMAND_REGISTRY[`${command.domain}.${action}` as keyof typeof SYNC_COMMAND_REGISTRY].permission;
          if (requiredPermission && !hasPermission(assignment.role, requiredPermission as Parameters<typeof hasPermission>[1])) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier_return.permission_denied", entity_type: "supplier_return", entity_id: returnGlobalId, reason: requiredPermission, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks supplier-return permission." };
          }
          const [identity] = returnGlobalId ? await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "supplier_return"), eq(syncGlobalEntities.global_id, returnGlobalId))).for("update").limit(1) : [undefined];
          const [mapping] = returnGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "supplier_return"), eq(syncEntityMappings.global_id, returnGlobalId))).for("update").limit(1) : [undefined];
          const create = action === "return_create";
          if (!create && !identity) {
            const foreignReturn = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier_return"), eq(syncGlobalEntities.global_id, returnGlobalId)) });
            if (foreignReturn && foreignReturn.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Supplier return belongs to another branch." };
          }
          let operationStatus: "accepted" | "needs_review" = "accepted";
          if (create) {
            const draft = payload.data as z.infer<typeof payloadSchemas["supplier_returns.return_create"]>;
            if (identity) return { operationId: command.operationId, status: "rejected", error: "Supplier-return identity already exists." };
            const receiptIdentity = await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.branch_id, device.branch_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, draft.receiptGlobalId)) });
            const foreignReceipt = !receiptIdentity ? await tx.query.syncGlobalEntities.findFirst({ where: and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_receipt"), eq(syncGlobalEntities.global_id, draft.receiptGlobalId)) }) : undefined;
            if (foreignReceipt && foreignReceipt.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Supplier-return receipt belongs to another branch." };
            const source = receiptIdentity && await tx.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, Number(receiptIdentity.local_id)), eq(purchaseReceipts.branch_id, device.branch_id)), with: { lines: true } });
            if (!source || source.status !== "posted") return { operationId: command.operationId, status: "retry_later", error: "A posted source receipt must synchronize before its return." };
            const sourceLines = [...source.lines].sort((a, b) => a.id - b.id);
            const returnLines = [];
            for (const entry of draft.lines) {
              const sourceLine = sourceLines[entry.receiptLineIndex];
              if (!sourceLine || sourceLine.accepted_quantity_base <= 0) return { operationId: command.operationId, status: "rejected", error: "Return source line is invalid." };
              const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, sourceLine.ingredient_id), eq(ingredients.branch_id, device.branch_id)) });
              if (!ingredient) return { operationId: command.operationId, status: "rejected", error: "Return ingredient is outside this branch." };
              const quantityBase = convertScaledQuantity({ quantityScaled: entry.quantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: sourceLine.conversion_numerator_snapshot, denominator: sourceLine.conversion_denominator_snapshot } });
              const expectedCredit = costMinorForQuantity(quantityBase, sourceLine.accepted_unit_cost_micros_snapshot);
              returnLines.push({ sourceLine, ingredient, entry, quantityBase, expectedCredit });
            }
            const priorReturns = await tx.query.supplierReturns.findMany({ where: and(eq(supplierReturns.receipt_id, source.id), inArray(supplierReturns.status, ["submitted", "approved", "dispatched"])) , with: { lines: true } });
            const reserved = new Map<number, number>();
            for (const prior of priorReturns) for (const line of prior.lines) reserved.set(line.receipt_line_id, (reserved.get(line.receipt_line_id) ?? 0) + line.quantity_base);
            for (const line of returnLines) if (line.quantityBase + (reserved.get(line.sourceLine.id) ?? 0) > line.sourceLine.accepted_quantity_base) return { operationId: command.operationId, status: "rejected", error: "Return quantity exceeds the source receipt's remaining accepted quantity." };
            const supplier = await tx.query.suppliers.findFirst({ where: eq(suppliers.id, source.supplier_id) });
            const order = await tx.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, source.purchase_order_id) });
            if (!supplier || !order) throw new Error("Receipt supplier or purchase-order snapshot is missing.");
            const expectedCredit = returnLines.reduce((sum, line) => sum + line.expectedCredit, 0);
            const [created] = await tx.insert(supplierReturns).values({ branch_id: device.branch_id, supplier_id: source.supplier_id, purchase_order_id: source.purchase_order_id, receipt_id: source.id, location_id: source.location_id, return_number: draft.returnNumber, supplier_code_snapshot: source.supplier_code_snapshot, supplier_name_en_snapshot: source.supplier_name_en_snapshot, supplier_name_ar_snapshot: source.supplier_name_ar_snapshot, po_number_snapshot: source.po_number_snapshot, receipt_number_snapshot: source.receipt_number, reason_code: draft.reasonCode, reason: draft.reason, notes: draft.notes, evidence_metadata: JSON.stringify(draft.evidenceMetadata), status: "draft", idempotency_key: command.idempotencyKey, expected_credit_amount: expectedCredit, created_by: actor.local_id }).returning();
            await tx.insert(supplierReturnLines).values(returnLines.map(({ sourceLine, ingredient, entry, quantityBase, expectedCredit: credit }) => ({ supplier_return_id: created!.id, receipt_line_id: sourceLine.id, ingredient_id: ingredient.id, ingredient_sku_snapshot: sourceLine.ingredient_sku_snapshot, ingredient_name_en_snapshot: sourceLine.ingredient_name_en_snapshot, ingredient_name_ar_snapshot: sourceLine.ingredient_name_ar_snapshot, dimension_snapshot: ingredient.dimension, unit_id: sourceLine.unit_id, unit_code_snapshot: sourceLine.unit_code_snapshot, package_conversion_id: sourceLine.package_conversion_id, conversion_numerator_snapshot: sourceLine.conversion_numerator_snapshot, conversion_denominator_snapshot: sourceLine.conversion_denominator_snapshot, quantity_input_scaled: entry.quantityScaled, quantity_base: quantityBase, accepted_quantity_base_snapshot: sourceLine.accepted_quantity_base, original_unit_cost_micros_snapshot: sourceLine.accepted_unit_cost_micros_snapshot, expected_credit_amount: credit, notes: entry.notes })));
            await tx.insert(supplierReturnStatusHistory).values({ supplier_return_id: created!.id, branch_id: device.branch_id, from_status: null, to_status: "draft", actor_user_id: actor.local_id, reason: draft.reason, idempotency_key: `${command.idempotencyKey}:created` });
            const values = { organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier_return", global_id: draft.supplierReturnGlobalId, local_id: String(created!.id), server_revision: 1 };
            await tx.insert(syncGlobalEntities).values(values); await tx.insert(syncEntityMappings).values({ ...values, device_id: device.id, local_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier_return.create", entity_type: "supplier_return", entity_id: draft.supplierReturnGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, lineCount: returnLines.length, expectedCredit }) });
          } else {
            const data = payload.data as z.infer<typeof payloadSchemas["supplier_returns.return_edit"]> | z.infer<typeof payloadSchemas["supplier_returns.return_submit"]> | z.infer<typeof payloadSchemas["supplier_returns.return_approve"]> | z.infer<typeof payloadSchemas["supplier_returns.return_dispatch"]> | z.infer<typeof payloadSchemas["supplier_returns.return_cancel"]> | z.infer<typeof payloadSchemas["supplier_returns.return_reverse"]>;
            if (!identity || !mapping) return { operationId: command.operationId, status: "retry_later", error: "Supplier-return identity has not synchronized." };
            if ("baseRevision" in data && mapping.server_revision !== data.baseRevision) {
              const current = identity && await tx.query.supplierReturns.findFirst({ where: eq(supplierReturns.id, Number(identity.local_id)), with: { lines: true, statusHistory: true } });
              const [conflictInbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              const result = { supplierReturnGlobalId: returnGlobalId, reason: "revision_conflict" };
              await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, conflictInbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: conflictInbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier_return", entity_global_id: returnGlobalId, local_payload: command.payload, server_snapshot: current ?? {}, reason: "The supplier return changed centrally after the device's base revision." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier_return.needs_review", entity_type: "supplier_return", entity_id: returnGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: data.baseRevision, serverRevision: mapping.server_revision }) });
              return { operationId: command.operationId, status: "needs_review", result };
            }
            const row = await tx.query.supplierReturns.findFirst({ where: and(eq(supplierReturns.id, Number(identity.local_id)), eq(supplierReturns.branch_id, device.branch_id)) });
            if (!row) return { operationId: command.operationId, status: "rejected", error: "Supplier return is outside this branch." };
            if (action === "return_edit") {
              const edit = data as z.infer<typeof payloadSchemas["supplier_returns.return_edit"]>;
              if (row.status !== "draft") return { operationId: command.operationId, status: "rejected", error: "Only Draft returns can be edited." };
              const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.receipt_line_id)] });
              let credit = 0;
              for (const q of edit.quantities) {
                const line = lines[q.lineIndex]; if (!line) return { operationId: command.operationId, status: "rejected", error: "Return line snapshot does not match." };
                const ingredient = await tx.query.ingredients.findFirst({ where: eq(ingredients.id, line.ingredient_id) });
                if (!ingredient || ingredient.dimension !== line.dimension_snapshot) return { operationId: command.operationId, status: "needs_review", result: { supplierReturnGlobalId: returnGlobalId } };
                const quantityBase = convertScaledQuantity({ quantityScaled: q.quantityScaled, fromDimension: ingredient.dimension, toDimension: ingredient.dimension, factor: { numerator: line.conversion_numerator_snapshot, denominator: line.conversion_denominator_snapshot } });
                if (quantityBase > line.accepted_quantity_base_snapshot) return { operationId: command.operationId, status: "rejected", error: "Return exceeds accepted receipt quantity." };
                const amount = costMinorForQuantity(quantityBase, line.original_unit_cost_micros_snapshot); credit += amount;
                await tx.update(supplierReturnLines).set({ quantity_input_scaled: q.quantityScaled, quantity_base: quantityBase, expected_credit_amount: amount, notes: q.notes }).where(eq(supplierReturnLines.id, line.id));
              }
              await tx.update(supplierReturns).set({ reason_code: edit.reasonCode ?? row.reason_code, reason: edit.reason, notes: edit.notes, evidence_metadata: edit.evidenceMetadata == null ? row.evidence_metadata : JSON.stringify(edit.evidenceMetadata), expected_credit_amount: credit, updated_at: new Date() }).where(eq(supplierReturns.id, row.id));
            } else if (action === "return_submit" || action === "return_approve" || action === "return_cancel") {
              const transition = data as z.infer<typeof payloadSchemas["supplier_returns.return_submit"]>;
              const target = action === "return_submit" ? "submitted" : action === "return_approve" ? "approved" : "cancelled";
              const valid = target === "submitted" ? row.status === "draft" : target === "approved" ? row.status === "submitted" : ["draft", "submitted", "approved"].includes(row.status);
              if (!valid) return { operationId: command.operationId, status: "rejected", error: "Supplier-return lifecycle transition is invalid." };
              await tx.update(supplierReturns).set(target === "submitted" ? { status: "submitted", submitted_by: actor.local_id, submitted_at: new Date() } : target === "approved" ? { status: "approved", approved_by: actor.local_id, approved_at: new Date() } : { status: "cancelled", cancelled_by: actor.local_id, cancelled_at: new Date(), cancellation_reason: transition.reason }).where(eq(supplierReturns.id, row.id));
              await tx.insert(supplierReturnStatusHistory).values({ supplier_return_id: row.id, branch_id: device.branch_id, from_status: row.status, to_status: target, actor_user_id: actor.local_id, reason: transition.reason, idempotency_key: transition.idempotencyKey });
            } else if (action === "return_dispatch") {
              if (row.status !== "approved") return { operationId: command.operationId, status: "rejected", error: "Only Approved returns can be dispatched." };
              const [sourceReceipt] = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.id, row.receipt_id), eq(purchaseReceipts.branch_id, device.branch_id))).for("update").limit(1);
              if (!sourceReceipt || sourceReceipt.status !== "posted") return { operationId: command.operationId, status: "needs_review", result: { supplierReturnGlobalId: returnGlobalId, reason: "source_receipt_not_posted" } };
              const receiptLines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, row.receipt_id) });
              const otherReturns = await tx.query.supplierReturns.findMany({ where: and(eq(supplierReturns.receipt_id, row.receipt_id), inArray(supplierReturns.status, ["submitted", "approved", "dispatched", "needs_review"])) , with: { lines: true } });
              const reserved = new Map<number, number>();
              for (const other of otherReturns) if (other.id !== row.id) for (const line of other.lines) reserved.set(line.receipt_line_id, (reserved.get(line.receipt_line_id) ?? 0) + line.quantity_base);
              const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.id)] });
              for (const line of lines) {
                const sourceLine = receiptLines.find((entry) => entry.id === line.receipt_line_id);
                if (!sourceLine || line.quantity_base + (reserved.get(line.receipt_line_id) ?? 0) > sourceLine.accepted_quantity_base) return { operationId: command.operationId, status: "rejected", error: "Return quantity exceeds the source receipt's remaining accepted quantity." };
              }
              const totals = new Map<number, number>(); for (const line of lines) totals.set(line.ingredient_id, (totals.get(line.ingredient_id) ?? 0) + line.quantity_base);
              for (const ingredientId of [...totals.keys()].sort((a, b) => a - b)) await tx.execute(sql`select id from stock_balances where branch_id = ${device.branch_id} and location_id = ${row.location_id} and ingredient_id = ${ingredientId} for update`);
              const balances = new Map<number, typeof stockBalances.$inferSelect>();
              for (const [ingredientId, qty] of totals) { const b = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, ingredientId)) }); if (!b || b.quantity_base < qty) return { operationId: command.operationId, status: "rejected", error: "Insufficient on-hand stock for supplier return." }; balances.set(ingredientId, b); }
              let valuation = 0; const now = new Date();
              for (const line of lines) { const b = balances.get(line.ingredient_id)!; const amount = costMinorForQuantity(line.quantity_base, b.average_unit_cost_micros); valuation += amount; await tx.update(supplierReturnLines).set({ dispatch_unit_cost_micros_snapshot: b.average_unit_cost_micros, dispatch_valuation_amount: amount }).where(eq(supplierReturnLines.id, line.id)); await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: row.location_id, ingredient_id: line.ingredient_id, movement_type: "supplier_return", direction: -1, quantity_base: line.quantity_base, unit_cost_micros: b.average_unit_cost_micros, total_cost_amount: amount, source_type: "supplier_return", source_id: String(row.id), idempotency_key: `supplier-return-dispatch:${row.id}:line:${line.id}`, actor_user_id: actor.local_id, reason: (data as z.infer<typeof payloadSchemas["supplier_returns.return_dispatch"]>).reason ?? row.reason, supplier_return_id: row.id, supplier_return_line_id: line.id, purchase_receipt_id: row.receipt_id, purchase_receipt_line_id: line.receipt_line_id, created_at: now }); }
              for (const [ingredientId, qty] of totals) { const b = balances.get(ingredientId)!; await tx.update(stockBalances).set({ quantity_base: b.quantity_base - qty, updated_at: now }).where(eq(stockBalances.id, b.id)); }
              await tx.update(supplierReturns).set({ status: "dispatched", dispatched_by: actor.local_id, dispatched_at: now, valuation_amount: valuation, cost_variance_amount: valuation - row.expected_credit_amount, updated_at: now }).where(eq(supplierReturns.id, row.id));
              const dispatch = data as z.infer<typeof payloadSchemas["supplier_returns.return_dispatch"]>; await tx.insert(supplierReturnStatusHistory).values({ supplier_return_id: row.id, branch_id: device.branch_id, from_status: "approved", to_status: "dispatched", actor_user_id: actor.local_id, reason: dispatch.reason, idempotency_key: dispatch.idempotencyKey });
            } else if (action === "return_reverse") {
              const reverse = data as z.infer<typeof payloadSchemas["supplier_returns.return_reverse"]>;
              if (row.status !== "dispatched") return { operationId: command.operationId, status: "rejected", error: "Only dispatched returns can be reversed." };
              const lines = await tx.query.supplierReturnLines.findMany({ where: eq(supplierReturnLines.supplier_return_id, row.id), orderBy: [asc(supplierReturnLines.id)] });
              const totals = new Map<number, number>(); for (const line of lines) totals.set(line.ingredient_id, (totals.get(line.ingredient_id) ?? 0) + line.quantity_base);
              let safe = lines.every((line) => line.dispatch_unit_cost_micros_snapshot !== null && line.dispatch_valuation_amount !== null);
              for (const ingredientId of [...totals.keys()].sort((a, b) => a - b)) { await tx.execute(sql`select id from stock_balances where branch_id = ${device.branch_id} and location_id = ${row.location_id} and ingredient_id = ${ingredientId} for update`); const b = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, ingredientId)) }); const later = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.branch_id, device.branch_id), eq(stockMovements.location_id, row.location_id), eq(stockMovements.ingredient_id, ingredientId), gt(stockMovements.created_at, row.dispatched_at ?? row.updated_at), sql`not (${stockMovements.supplier_return_id} = ${row.id} and ${stockMovements.movement_type} = 'supplier_return')`)).limit(1); if (!b || later.length) safe = false; }
              const reversalStatus = safe ? "reversed" : "needs_review";
              if (!safe) operationStatus = "needs_review";
              const [reversalRow] = await tx.insert(supplierReturnReversals).values({ supplier_return_id: row.id, branch_id: device.branch_id, reason: reverse.reason, status: reversalStatus, actor_user_id: actor.local_id, idempotency_key: reverse.idempotencyKey }).returning();
              if (safe) for (const line of lines) { const [b] = await tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, device.branch_id), eq(stockBalances.location_id, row.location_id), eq(stockBalances.ingredient_id, line.ingredient_id))).for("update").limit(1); const average = movingWeightedAverage({ existingQuantity: b!.quantity_base, existingUnitCostMicros: b!.average_unit_cost_micros, addedQuantity: line.quantity_base, addedUnitCostMicros: line.dispatch_unit_cost_micros_snapshot! }); await tx.update(stockBalances).set({ quantity_base: b!.quantity_base + line.quantity_base, average_unit_cost_micros: average, updated_at: new Date() }).where(eq(stockBalances.id, b!.id)); await tx.insert(stockMovements).values({ branch_id: device.branch_id, location_id: row.location_id, ingredient_id: line.ingredient_id, movement_type: "supplier_return_reversal", direction: 1, quantity_base: line.quantity_base, unit_cost_micros: line.dispatch_unit_cost_micros_snapshot!, total_cost_amount: line.dispatch_valuation_amount!, source_type: "supplier_return_reversal", source_id: String(reversalRow!.id), idempotency_key: `supplier-return-reversal:${reversalRow!.id}:line:${line.id}`, actor_user_id: actor.local_id, reason: reverse.reason, supplier_return_id: row.id, supplier_return_line_id: line.id, purchase_receipt_id: row.receipt_id, purchase_receipt_line_id: line.receipt_line_id }); }
              await tx.update(supplierReturns).set({ status: reversalStatus, reversed_by: safe ? actor.local_id : null, reversed_at: safe ? new Date() : null, needs_review_reason: safe ? null : "Later stock activity prevents safe reversal.", updated_at: new Date() }).where(eq(supplierReturns.id, row.id));
              await tx.insert(supplierReturnStatusHistory).values({ supplier_return_id: row.id, branch_id: device.branch_id, from_status: "dispatched", to_status: reversalStatus, actor_user_id: actor.local_id, reason: reverse.reason, idempotency_key: `${reverse.idempotencyKey}:status` });
            }
            const nextRevision = mapping.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: nextRevision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
            await tx.update(syncEntityMappings).set({ server_revision: nextRevision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, approver_user_id: action === "return_approve" ? actor.local_id : null, action: `sync.supplier_return.${action}`, entity_type: "supplier_return", entity_id: returnGlobalId, reason: "reason" in (payload.data as object) ? String((payload.data as { reason?: string }).reason ?? "") : null, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          }
          const finalRevision = create ? 1 : mapping!.server_revision + 1;
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action, schema_version: 1, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: operationStatus }).returning();
          const result = { supplierReturnGlobalId: returnGlobalId, revision: finalRevision }; await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "supplier_returns", entity_type: "supplier_return", entity_global_id: returnGlobalId, action, server_revision: finalRevision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: operationStatus, result };
        }
        if (command.domain === "suppliers") {
          const supplierPayload = payload.data as z.infer<typeof payloadSchemas["suppliers.create"]> | z.infer<typeof payloadSchemas["suppliers.update"]> | z.infer<typeof payloadSchemas["suppliers.archive"]>;
          if (!hasPermission(assignment.role, "supplier:manage")) {
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.permission_denied", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, reason: "supplier:manage", details: JSON.stringify({ sourceOperationId: command.operationId }) });
            return { operationId: command.operationId, status: "rejected", error: "Actor lacks supplier management permission." };
          }
          const [identity] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.global_id, supplierPayload.supplierGlobalId))).for("update").limit(1);
          const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "supplier"), eq(syncEntityMappings.global_id, supplierPayload.supplierGlobalId))).for("update").limit(1);
          let revision = 1;
          let supplierId = identity ? Number(identity.local_id) : 0;
          let inboxId: number;
          if (command.action === "create") {
            if (identity) return { operationId: command.operationId, status: "rejected", error: "Supplier global identity already exists." };
            const values = (supplierPayload as z.infer<typeof payloadSchemas["suppliers.create"]>).values;
            const duplicateCode = await tx.query.suppliers.findFirst({ where: and(eq(suppliers.branch_id, device.branch_id), eq(suppliers.code, values.code)) });
            if (duplicateCode) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              await tx.update(syncCommandInbox).set({ result: { reason: "supplier_code_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, local_payload: command.payload, server_snapshot: duplicateCode, reason: "The supplier code is already used in this branch." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.supplier.needs_review", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, conflictingSupplierId: duplicateCode.id }) });
              return { operationId: command.operationId, status: "needs_review", result: { supplierGlobalId: supplierPayload.supplierGlobalId } };
            }
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            inboxId = inbox!.id;
            const [created] = await tx.insert(suppliers).values({ branch_id: device.branch_id, code: values.code, name_en: values.nameEn, name_ar: values.nameAr, contact_name: values.contactName, phone: values.phone, email: values.email, address: values.address, notes: values.notes, is_active: true, created_by: actor.local_id, updated_by: actor.local_id }).returning();
            supplierId = created!.id;
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", global_id: supplierPayload.supplierGlobalId, local_id: String(supplierId), server_revision: 1 });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "supplier", global_id: supplierPayload.supplierGlobalId, local_id: String(supplierId), local_revision: 1, server_revision: 1 });
          } else {
            if (!identity || !deviceMapping || identity.branch_id !== device.branch_id) return { operationId: command.operationId, status: "rejected", error: "Supplier identity is unavailable in this branch." };
            const baseRevision = "baseRevision" in supplierPayload ? supplierPayload.baseRevision : command.baseRevision;
            if (deviceMapping.server_revision !== baseRevision) {
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
              inboxId = inbox!.id;
              const serverSupplier = await tx.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
              await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
              await tx.insert(syncConflicts).values({ inbox_id: inboxId, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, local_payload: command.payload, server_snapshot: serverSupplier ?? {}, reason: "Supplier was changed on the central server after this device's base revision." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.supplier.needs_review", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision, serverRevision: deviceMapping.server_revision }) });
              return { operationId: command.operationId, status: "needs_review", result: { supplierGlobalId: supplierPayload.supplierGlobalId } };
            }
            if (command.action === "archive") {
              const archive = supplierPayload as z.infer<typeof payloadSchemas["suppliers.archive"]>;
              await tx.update(suppliers).set({ is_active: false, updated_by: actor.local_id, updated_at: new Date() }).where(eq(suppliers.id, supplierId));
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier.archive", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId, reason: archive.reason });
            } else {
              const values = (supplierPayload as z.infer<typeof payloadSchemas["suppliers.update"]>).values;
              await tx.update(suppliers).set({ code: values.code, name_en: values.nameEn, name_ar: values.nameAr, contact_name: values.contactName, phone: values.phone, email: values.email, address: values.address, notes: values.notes, updated_by: actor.local_id, updated_at: new Date() }).where(eq(suppliers.id, supplierId));
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "supplier.update", entity_type: "supplier", entity_id: supplierPayload.supplierGlobalId });
            }
            revision = deviceMapping.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, identity.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping.id));
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
            inboxId = inbox!.id;
          }
          const result = { supplierGlobalId: supplierPayload.supplierGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "suppliers", entity_type: "supplier", entity_global_id: supplierPayload.supplierGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
          return { operationId: command.operationId, status: "accepted", result };
        }
        if (command.domain === "products") {
          const productPayload = payload.data as z.infer<typeof payloadSchemas["products.create"]>;
          const productGlobalId = productPayload.productGlobalId;
          const [mapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "product"), eq(syncGlobalEntities.global_id, productGlobalId))).for("update").limit(1);
          const [deviceMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.global_id, productGlobalId))).for("update").limit(1);
          if (command.action === "create" && mapping) return { operationId: command.operationId, status: "rejected", error: "Product global identity already exists." };
          if (command.action !== "create" && (!mapping || !deviceMapping || deviceMapping.server_revision !== command.baseRevision)) {
            if (!mapping) return { operationId: command.operationId, status: "rejected", error: "Product mapping does not exist." };
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review" }).returning();
            const [serverProduct] = await tx.select().from(products).where(eq(products.id, Number(mapping.local_id))).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "product", entity_global_id: productGlobalId, local_payload: command.payload, server_snapshot: serverProduct ?? {}, reason: "Product was changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.needs_review", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: deviceMapping?.server_revision ?? null }) });
            return { operationId: command.operationId, status: "needs_review", result: { productGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId, branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain, action: command.action, schema_version: command.schemaVersion, payload: command.payload, payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted" }).returning();
          let revision = 1;
          if (command.action === "create") {
            const { imageKey, ...productValues } = productPayload.values;
            const [product] = await tx.insert(products).values({ ...productValues, image_key: imageKey, user_uid: actor.local_id }).returning();
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "product", global_id: productGlobalId, local_id: String(product!.id) });
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "product", global_id: productGlobalId, local_id: String(product!.id), local_revision: 1, server_revision: 1 });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.created", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else if (command.action === "delete") {
            await tx.delete(products).where(eq(products.id, Number(mapping!.local_id)));
            revision = deviceMapping!.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping!.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping!.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.deleted", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else {
            const { imageKey, ...productValues } = productPayload.values;
            const [updated] = await tx.update(products).set({ ...productValues, image_key: imageKey, user_uid: actor.local_id }).where(eq(products.id, Number(mapping!.local_id))).returning();
            revision = deviceMapping!.server_revision + 1;
            await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping!.id));
            await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, deviceMapping!.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.product.updated", entity_type: "product", entity_id: productGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
            void updated;
          }
          const response = { productGlobalId, revision };
          await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
          await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "products", entity_type: "product", entity_global_id: productGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
          await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
          return { operationId: command.operationId, status: "accepted", result: response };
        }
        const customerPayload = payload.data as z.infer<typeof payloadSchemas["customers.create"]>;
        const customerGlobalId = customerPayload.customerGlobalId;
        let revision = 1;
        let inboxId = 0;
        if (command.action === "create") {
          const [inbox] = await tx.insert(syncCommandInbox).values({
            organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
            branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
            action: command.action, schema_version: command.schemaVersion, payload: command.payload,
            payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted",
          }).returning();
          inboxId = inbox!.id;
          const [customer] = await tx.insert(customers).values({ ...customerPayload.values, user_uid: actor.local_id }).returning();
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", global_id: customerGlobalId, local_id: String(customer!.id) });
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "customer", global_id: customerGlobalId, local_id: String(customer!.id), local_revision: 1, server_revision: 1 });
          await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.created", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
        } else {
          const [mapping] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "customer"), eq(syncGlobalEntities.global_id, customerGlobalId))).for("update").limit(1);
          if (!mapping) return { operationId: command.operationId, status: "rejected", error: "Customer mapping does not exist." };
          const [entityMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, customerGlobalId))).for("update").limit(1);
          if (!entityMapping || entityMapping.server_revision !== command.baseRevision) {
            const [inbox] = await tx.insert(syncCommandInbox).values({
              organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
              branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
              action: command.action, schema_version: command.schemaVersion, payload: command.payload,
              payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "needs_review",
            }).returning();
            inboxId = inbox!.id;
            const [serverCustomer] = await tx.select().from(customers).where(eq(customers.id, Number(mapping.local_id))).limit(1);
            await tx.update(syncCommandInbox).set({ result: { reason: "revision_conflict" }, processed_at: new Date() }).where(eq(syncCommandInbox.id, inbox!.id));
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "customer", entity_global_id: customerGlobalId, local_payload: command.payload, server_snapshot: serverCustomer ?? {}, reason: "Customer was changed on the central server after this device's base revision." });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.needs_review", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId, baseRevision: command.baseRevision, serverRevision: entityMapping?.server_revision ?? null }) });
            return { operationId: command.operationId, status: "needs_review", result: { customerGlobalId } };
          }
          const [inbox] = await tx.insert(syncCommandInbox).values({
            organization_id: device.organization_id, device_id: device.id, operation_id: command.operationId,
            branch_id: device.branch_id, actor_global_id: command.actorGlobalId, domain: command.domain,
            action: command.action, schema_version: command.schemaVersion, payload: command.payload,
            payload_hash: command.payloadHash, idempotency_key: command.idempotencyKey, state: "accepted",
          }).returning();
          inboxId = inbox!.id;
          if (command.action === "delete") {
            await tx.delete(customers).where(eq(customers.id, Number(mapping.local_id)));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.deleted", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          } else {
            await tx.update(customers).set(customerPayload.values).where(eq(customers.id, Number(mapping.local_id)));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.customer.updated", entity_type: "customer", entity_id: customerGlobalId, details: JSON.stringify({ sourceOperationId: command.operationId }) });
          }
          revision = entityMapping.server_revision + 1;
          await tx.update(syncGlobalEntities).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncGlobalEntities.id, mapping.id));
          await tx.update(syncEntityMappings).set({ server_revision: revision, updated_at: new Date() }).where(eq(syncEntityMappings.id, entityMapping.id));
        }
        const response = { customerGlobalId, revision };
        await tx.update(syncCommandInbox).set({ result: response, processed_at: new Date() }).where(eq(syncCommandInbox.id, inboxId));
        await tx.insert(syncChangeLog).values({ organization_id: device.organization_id, branch_id: device.branch_id, domain: "customers", entity_type: "customer", entity_global_id: customerGlobalId, action: command.action, server_revision: revision, source_operation_id: command.operationId });
        await tx.update(syncDevices).set({ last_seen_at: new Date(), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
        return { operationId: command.operationId, status: "accepted", result: response };
      });
      results.set(command.operationId, result);
    } catch (error) {
      results.set(command.operationId, { operationId: command.operationId, status: "retry_later", error: error instanceof Error ? error.message : "Command processing failed." });
    }
  }
  return NextResponse.json({ results: [...results.values()] }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const device = await authenticatePairedDevice(request);
  if (!device) return NextResponse.json({ error: "Paired device authentication failed." }, { status: 401, headers: { "cache-control": "no-store" } });
  const rawCursor = Number(request.nextUrl.searchParams.get("cursor") ?? "0");
  if (!Number.isSafeInteger(rawCursor) || rawCursor < 0) return NextResponse.json({ error: "Change cursor is invalid." }, { status: 400, headers: { "cache-control": "no-store" } });
  const changes = await db.select().from(syncChangeLog).where(and(
    eq(syncChangeLog.organization_id, device.organization_id),
    eq(syncChangeLog.branch_id, device.branch_id),
    gt(syncChangeLog.cursor, rawCursor),
  )).orderBy(asc(syncChangeLog.cursor)).limit(200);
  const exported = [];
  for (const change of changes) {
    const isShift = change.domain === "shifts" && change.entity_type === "cashier_shift";
    const isCashMovement = change.domain === "shifts" && change.entity_type === "cash_movement";
    const isOrder = change.domain === "orders" && change.entity_type === "order";
    const isPrintJob = change.domain === "printing" && change.entity_type === "print_job";
    const isPrintPreferences = change.domain === "printing" && change.entity_type === "register_print_preferences";
    const isCheckout = change.domain === "checkout" && change.entity_type === "order_checkout";
    const isCancellation = change.domain === "checkout" && change.entity_type === "order_cancellation";
    const isStockMovement = change.domain === "inventory" && change.entity_type === "stock_movement";
    const isSupplier = change.domain === "suppliers" && change.entity_type === "supplier";
    const isIngredient = change.domain === "inventory" && change.entity_type === "ingredient";
    const isRecipe = change.domain === "inventory" && change.entity_type === "recipe_version";
    const isPurchaseOrder = change.domain === "procurement" && change.entity_type === "purchase_order";
    const isReceipt = change.domain === "receiving" && change.entity_type === "purchase_receipt";
    const isSupplierReturn = change.domain === "supplier_returns" && change.entity_type === "supplier_return";
    if (!isShift && !isCashMovement && !isOrder && !isPrintJob && !isPrintPreferences && !isCheckout && !isCancellation && !isStockMovement && !isSupplier && !isIngredient && !isRecipe && !isPurchaseOrder && !isReceipt && !isSupplierReturn && ((change.domain !== "customers" && change.domain !== "products") || (change.entity_type !== "customer" && change.entity_type !== "product"))) {
      exported.push({ cursor: change.cursor, domain: change.domain, entityType: change.entity_type, entityGlobalId: change.entity_global_id, action: change.action, revision: change.server_revision, snapshot: null });
      continue;
    }
    const [mapping] = await db.select().from(syncGlobalEntities).where(and(
      eq(syncGlobalEntities.organization_id, device.organization_id),
      eq(syncGlobalEntities.entity_type, change.entity_type),
      eq(syncGlobalEntities.global_id, change.entity_global_id),
    )).limit(1);
    let snapshot: Record<string, unknown> | null = null;
    if (change.action === "delete") snapshot = null;
    else if (isShift && mapping) {
      const shift = await db.query.cashierShifts.findFirst({ where: eq(cashierShifts.id, Number(mapping.local_id)) });
      if (shift) {
        if (change.action === "close" && shift.status === "closed" && shift.closed_at && shift.expected_cash !== null && shift.closing_cash !== null && shift.variance !== null) {
          const [closedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, shift.closed_by ?? ""))).limit(1);
          if (closedBy) snapshot = { closedByGlobalId: closedBy.global_id, expectedCash: shift.expected_cash, closingCash: shift.closing_cash, variance: shift.variance, closedAt: shift.closed_at.toISOString() };
        } else {
          const [register] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(shift.register_id)))).limit(1);
          const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, shift.cashier_user_id))).limit(1);
          if (register && actor) snapshot = { registerGlobalId: register.global_id, actorGlobalId: actor.global_id, openingFloat: shift.opening_float, openedAt: shift.opened_at.toISOString() };
        }
      }
    }
    else if (isCashMovement && mapping) {
      const movement = await db.query.shiftCashMovements.findFirst({ where: eq(shiftCashMovements.id, Number(mapping.local_id)) });
      if (movement) {
        const [shiftMapping] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(movement.shift_id)))).limit(1);
        const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, movement.created_by))).limit(1);
        if (shiftMapping && actor) snapshot = { shiftGlobalId: shiftMapping.global_id, actorGlobalId: actor.global_id, type: movement.type, amount: movement.amount, reason: movement.reason, createdAt: movement.created_at.toISOString() };
      }
    }
    else if (isStockMovement && mapping) {
      const movement = await db.query.stockMovements.findFirst({ where: eq(stockMovements.id, Number(mapping.local_id)) });
      if (!movement) throw new Error("A stock movement change has no authoritative ledger record.");
      {
        const [ingredient] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.local_id, String(movement.ingredient_id)))).limit(1);
        const [location] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.local_id, String(movement.location_id)))).limit(1);
        const [actor] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, movement.actor_user_id))).limit(1);
        if (!ingredient || !location || !actor) throw new Error("A stock movement change is missing a global ingredient, location, or actor mapping.");
        snapshot = { ingredientGlobalId: ingredient.global_id, locationGlobalId: location.global_id, actorGlobalId: actor.global_id, movementType: movement.movement_type, direction: movement.direction, quantityBase: movement.quantity_base, unitCostMicros: movement.unit_cost_micros, totalCostAmount: movement.total_cost_amount, sourceType: movement.source_type, sourceId: movement.source_id, idempotencyKey: movement.idempotency_key, reason: movement.reason, createdAt: movement.created_at.toISOString() };
      }
    }
    else if (isSupplier && mapping) {
      const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, Number(mapping.local_id)) });
      if (!supplier) throw new Error("A supplier change has no authoritative record.");
      const [updatedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, supplier.updated_by))).limit(1);
      if (!updatedBy) throw new Error("A supplier change is missing its actor identity mapping.");
      snapshot = { code: supplier.code, nameEn: supplier.name_en, nameAr: supplier.name_ar, contactName: supplier.contact_name, phone: supplier.phone, email: supplier.email, address: supplier.address, notes: supplier.notes, isActive: supplier.is_active, updatedByGlobalId: updatedBy.global_id };
    }
    else if (isIngredient && mapping) {
      const ingredient = await db.query.ingredients.findFirst({ where: eq(ingredients.id, Number(mapping.local_id)), with: { category: true, baseUnit: true, defaultLocation: true } });
      if (ingredient) {
        const [updatedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, ingredient.updated_by))).limit(1);
        if (updatedBy) snapshot = { sku: ingredient.sku, nameEn: ingredient.name_en, nameAr: ingredient.name_ar, dimension: ingredient.dimension, tracked: ingredient.is_tracked, reorderLevel: ingredient.reorder_level, lowStockThreshold: ingredient.low_stock_threshold, parLevel: ingredient.par_level, allowNegative: ingredient.allow_negative, isActive: ingredient.is_active, categoryCode: ingredient.category.code, locationCode: ingredient.defaultLocation.code, unitCode: ingredient.baseUnit.code, updatedByGlobalId: updatedBy.global_id };
      }
    }
    else if (isRecipe && mapping) {
      const recipe = await db.query.recipeVersions.findFirst({ where: eq(recipeVersions.id, Number(mapping.local_id)), with: { components: true } });
      if (recipe) {
        const identity = async (entityType: string, localId: string | number | null) => localId === null ? null : db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.local_id, String(localId)))).limit(1).then(([row]) => row?.global_id ?? null);
        const menuItemGlobalId = await identity("menu_item", recipe.menu_item_id);
        const variantGlobalId = await identity("menu_item_variant", recipe.variant_id);
        const authoredByGlobalId = await identity("user", recipe.authored_by);
        const approvedByGlobalId = await identity("user", recipe.approved_by);
        const components = await Promise.all(recipe.components.map(async (component) => ({ ingredientGlobalId: await identity("ingredient", component.ingredient_id), locationGlobalId: await identity("inventory_location", component.source_location_id), unitGlobalId: await identity("unit_of_measure", component.unit_id), modifierOptionGlobalId: await identity("modifier_option", component.modifier_option_id), quantityScaled: component.quantity_input_scaled })));
        if (menuItemGlobalId && authoredByGlobalId && components.every((component) => component.ingredientGlobalId && component.locationGlobalId && component.unitGlobalId)) snapshot = { menuItemGlobalId, variantGlobalId, version: recipe.version, status: recipe.status, yieldLossBps: recipe.yield_loss_bps, effectiveAt: recipe.effective_at?.toISOString() ?? null, authoredByGlobalId, approvedByGlobalId, approvedAt: recipe.approved_at?.toISOString() ?? null, components };
      }
    }
    else if (isPurchaseOrder && mapping) {
      const order = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, Number(mapping.local_id)), with: { lines: true } });
      if (order) {
        const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, order.supplier_id) });
        const supplierGlobalId = supplier && await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.local_id, String(supplier.id)))).limit(1).then(([row]) => row?.global_id);
        const createdByGlobalId = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, order.created_by))).limit(1).then(([row]) => row?.global_id);
        const lines = await Promise.all(order.lines.map(async (line) => {
          const ingredientGlobalId = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "ingredient"), eq(syncGlobalEntities.local_id, String(line.ingredient_id)))).limit(1).then(([row]) => row?.global_id);
          return { ingredientGlobalId, unitCode: (await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id) }))?.code, packageConversionCode: line.unit_code === (await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id) }))?.code ? null : line.unit_code, quantityScaled: line.quantity_input_scaled, quantityBase: line.quantity_base, conversionNumerator: line.conversion_numerator_snapshot, conversionDenominator: line.conversion_denominator_snapshot, unitPriceMinor: line.unit_price_minor, lineTotalAmount: line.line_total_amount, ingredientSku: line.ingredient_sku, ingredientNameEn: line.ingredient_name_en, ingredientNameAr: line.ingredient_name_ar, notes: line.notes };
        }));
        if (supplierGlobalId && createdByGlobalId && lines.every((line) => line.ingredientGlobalId && line.unitCode)) snapshot = { supplierGlobalId, createdByGlobalId, poNumber: order.po_number, status: order.status, receivingStatus: order.receiving_status, orderDate: order.order_date.toISOString(), expectedDate: order.expected_date?.toISOString() ?? null, currency: order.currency, subtotalAmount: order.subtotal_amount, totalAmount: order.total_amount, notes: order.notes, supplierCodeSnapshot: order.supplier_code_snapshot, supplierNameEnSnapshot: order.supplier_name_en_snapshot, supplierNameArSnapshot: order.supplier_name_ar_snapshot, submittedByGlobalId: await (async () => order.submitted_by ? db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, order.submitted_by))).limit(1).then(([row]) => row?.global_id ?? null) : null)(), approvedByGlobalId: await (async () => order.approved_by ? db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, order.approved_by))).limit(1).then(([row]) => row?.global_id ?? null) : null)(), cancelledByGlobalId: await (async () => order.cancelled_by ? db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, order.cancelled_by))).limit(1).then(([row]) => row?.global_id ?? null) : null)(), cancellationReason: order.cancellation_reason, lines };
      }
    }
    else if (change.domain === "receiving" && change.entity_type === "purchase_receipt" && mapping) {
      const receipt = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.id, Number(mapping.local_id)) });
      if (receipt) {
        const globalFor = async (entityType: string, localId: string | number | null) => {
          if (localId === null) return null;
          const [identity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.local_id, String(localId)))).limit(1);
          return identity?.global_id ?? null;
        };
        const lines = await db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receipt_id, receipt.id)).orderBy(asc(purchaseReceiptLines.id));
        const poLines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchase_order_id, receipt.purchase_order_id)).orderBy(asc(purchaseOrderLines.id));
        const lineSnapshots = await Promise.all(lines.map(async (line) => ({
          poLineIndex: poLines.findIndex((item) => item.id === line.purchase_order_line_id),
          ingredientGlobalId: await globalFor("ingredient", line.ingredient_id),
          packageConversionCode: line.package_conversion_id ? (await db.query.ingredientPackageConversions.findFirst({ where: eq(ingredientPackageConversions.id, line.package_conversion_id) }))?.code ?? null : null,
          unitCode: (await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id) }))?.code,
          ingredientSku: line.ingredient_sku_snapshot, ingredientNameEn: line.ingredient_name_en_snapshot,
          ingredientNameAr: line.ingredient_name_ar_snapshot, conversionNumerator: line.conversion_numerator_snapshot,
          conversionDenominator: line.conversion_denominator_snapshot, orderedQuantityBase: line.ordered_quantity_base_snapshot,
          poUnitPriceMinor: line.po_unit_price_minor_snapshot, quantityScaled: line.quantity_input_scaled,
          acceptedQuantityBase: line.accepted_quantity_base, rejectedQuantityBase: line.rejected_quantity_base,
          damagedQuantityBase: line.damaged_quantity_base, actualUnitPriceMinor: line.actual_unit_price_minor,
          acceptedUnitCostMicros: line.accepted_unit_cost_micros_snapshot, balanceQuantityBefore: line.balance_quantity_before,
          balanceUnitCostBefore: line.balance_unit_cost_before, ingredientAverageUnitCostBefore: line.ingredient_average_unit_cost_before,
          lineTotalAmount: line.line_total_amount, notes: line.notes,
        })));
        const [reversal] = await db.select().from(purchaseReceiptReversals).where(eq(purchaseReceiptReversals.receipt_id, receipt.id)).limit(1);
        const movements = await db.select().from(stockMovements).where(and(eq(stockMovements.purchase_receipt_id, receipt.id), inArray(stockMovements.movement_type, ["purchase_receipt", "purchase_receipt_reversal"]))).orderBy(asc(stockMovements.id));
        const [poGlobalId] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "purchase_order"), eq(syncGlobalEntities.local_id, String(receipt.purchase_order_id)))).limit(1);
        const [supplierGlobalId] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "supplier"), eq(syncGlobalEntities.local_id, String(receipt.supplier_id)))).limit(1);
        const [locationGlobalId] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "inventory_location"), eq(syncGlobalEntities.local_id, String(receipt.location_id)))).limit(1);
        const actorGlobalId = await globalFor("user", receipt.received_by);
        const postedByGlobalId = await globalFor("user", receipt.posted_by);
        if (poGlobalId && supplierGlobalId && locationGlobalId && actorGlobalId && lineSnapshots.every((line) => line.ingredientGlobalId && line.unitCode)) snapshot = {
          receiptGlobalId: change.entity_global_id, purchaseOrderGlobalId: poGlobalId.global_id, supplierGlobalId: supplierGlobalId.global_id,
          locationGlobalId: locationGlobalId.global_id, receivedByGlobalId: actorGlobalId, postedByGlobalId,
          supplierCodeSnapshot: receipt.supplier_code_snapshot, supplierNameEnSnapshot: receipt.supplier_name_en_snapshot,
          supplierNameArSnapshot: receipt.supplier_name_ar_snapshot, poNumberSnapshot: receipt.po_number_snapshot,
          receiptNumber: receipt.receipt_number, supplierDeliveryNote: receipt.supplier_delivery_note,
          supplierInvoiceReference: receipt.supplier_invoice_reference, receivedAt: receipt.received_at.toISOString(),
          notes: receipt.notes, status: receipt.status, idempotencyKey: receipt.idempotency_key,
          postedAt: receipt.posted_at?.toISOString() ?? null, varianceApprovedByGlobalId: await globalFor("user", receipt.variance_approved_by),
          varianceReason: receipt.variance_reason, overreceiveApprovedByGlobalId: await globalFor("user", receipt.overreceive_approved_by),
          overreceiveReason: receipt.overreceive_reason, reversalReason: receipt.reversal_reason,
          needsReviewReason: receipt.needs_review_reason, lines: lineSnapshots,
          reversal: reversal ? { reason: reversal.reason, status: reversal.status, actorGlobalId: await globalFor("user", reversal.actor_user_id), idempotencyKey: reversal.idempotency_key, createdAt: reversal.created_at.toISOString() } : null,
          movements: await Promise.all(movements.map(async (movement) => ({ movementType: movement.movement_type, direction: movement.direction, quantityBase: movement.quantity_base, unitCostMicros: movement.unit_cost_micros, totalCostAmount: movement.total_cost_amount, idempotencyKey: movement.idempotency_key, actorGlobalId: await globalFor("user", movement.actor_user_id), reason: movement.reason, createdAt: movement.created_at.toISOString(), lineIndex: lines.findIndex((line) => line.id === movement.purchase_receipt_line_id), reversal: movement.movement_type === "purchase_receipt_reversal" }))),
        };
      }
    }
    else if (change.domain === "supplier_returns" && change.entity_type === "supplier_return" && mapping) {
      const item = await db.query.supplierReturns.findFirst({ where: eq(supplierReturns.id, Number(mapping.local_id)) });
      if (item) {
        const globalFor = async (entityType: string, localId: string | number | null) => {
          if (localId === null) return null;
          const [identity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.local_id, String(localId)))).limit(1);
          return identity?.global_id ?? null;
        };
        const lines = await db.select().from(supplierReturnLines).where(eq(supplierReturnLines.supplier_return_id, item.id)).orderBy(asc(supplierReturnLines.id));
        const receiptLines = await db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receipt_id, item.receipt_id)).orderBy(asc(purchaseReceiptLines.id));
        const histories = await db.select().from(supplierReturnStatusHistory).where(eq(supplierReturnStatusHistory.supplier_return_id, item.id)).orderBy(asc(supplierReturnStatusHistory.id));
        const [reversal] = await db.select().from(supplierReturnReversals).where(eq(supplierReturnReversals.supplier_return_id, item.id)).limit(1);
        const movements = await db.select().from(stockMovements).where(and(eq(stockMovements.supplier_return_id, item.id), inArray(stockMovements.movement_type, ["supplier_return", "supplier_return_reversal"]))).orderBy(asc(stockMovements.id));
        const ids = await Promise.all([globalFor("supplier", item.supplier_id), globalFor("purchase_order", item.purchase_order_id), globalFor("purchase_receipt", item.receipt_id), globalFor("inventory_location", item.location_id), globalFor("user", item.created_by)]);
        const lineSnapshots = await Promise.all(lines.map(async (line) => ({ receiptLineIndex: receiptLines.findIndex((row) => row.id === line.receipt_line_id), ingredientGlobalId: await globalFor("ingredient", line.ingredient_id), sku: line.ingredient_sku_snapshot, nameEn: line.ingredient_name_en_snapshot, nameAr: line.ingredient_name_ar_snapshot, dimension: line.dimension_snapshot, unitCode: (await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, line.unit_id) }))?.code ?? line.unit_code_snapshot, packageConversionCode: line.package_conversion_id ? (await db.query.ingredientPackageConversions.findFirst({ where: eq(ingredientPackageConversions.id, line.package_conversion_id) }))?.code ?? null : null, quantityScaled: line.quantity_input_scaled, quantityBase: line.quantity_base, acceptedQuantityBase: line.accepted_quantity_base_snapshot, conversionNumerator: line.conversion_numerator_snapshot, conversionDenominator: line.conversion_denominator_snapshot, originalUnitCostMicros: line.original_unit_cost_micros_snapshot, expectedCreditAmount: line.expected_credit_amount, dispatchUnitCostMicros: line.dispatch_unit_cost_micros_snapshot, dispatchValuationAmount: line.dispatch_valuation_amount, notes: line.notes })));
        if (ids.every(Boolean) && lineSnapshots.every((line) => line.ingredientGlobalId)) snapshot = { supplierReturnGlobalId: change.entity_global_id, supplierGlobalId: ids[0], purchaseOrderGlobalId: ids[1], receiptGlobalId: ids[2], locationGlobalId: ids[3], createdByGlobalId: ids[4], returnNumber: item.return_number, supplierCodeSnapshot: item.supplier_code_snapshot, supplierNameEnSnapshot: item.supplier_name_en_snapshot, supplierNameArSnapshot: item.supplier_name_ar_snapshot, poNumberSnapshot: item.po_number_snapshot, receiptNumberSnapshot: item.receipt_number_snapshot, reasonCode: item.reason_code, reason: item.reason, notes: item.notes, evidenceMetadata: item.evidence_metadata, status: item.status, idempotencyKey: item.idempotency_key, expectedCreditAmount: item.expected_credit_amount, valuationAmount: item.valuation_amount, costVarianceAmount: item.cost_variance_amount, submittedByGlobalId: await globalFor("user", item.submitted_by), approvedByGlobalId: await globalFor("user", item.approved_by), dispatchedByGlobalId: await globalFor("user", item.dispatched_by), cancelledByGlobalId: await globalFor("user", item.cancelled_by), reversedByGlobalId: await globalFor("user", item.reversed_by), submittedAt: item.submitted_at?.toISOString() ?? null, approvedAt: item.approved_at?.toISOString() ?? null, dispatchedAt: item.dispatched_at?.toISOString() ?? null, cancelledAt: item.cancelled_at?.toISOString() ?? null, reversedAt: item.reversed_at?.toISOString() ?? null, cancellationReason: item.cancellation_reason, needsReviewReason: item.needs_review_reason, lines: lineSnapshots, histories: await Promise.all(histories.map(async (entry) => ({ fromStatus: entry.from_status, toStatus: entry.to_status, actorGlobalId: await globalFor("user", entry.actor_user_id), reason: entry.reason, idempotencyKey: entry.idempotency_key, createdAt: entry.created_at.toISOString() }))), reversal: reversal ? { reason: reversal.reason, status: reversal.status, actorGlobalId: await globalFor("user", reversal.actor_user_id), idempotencyKey: reversal.idempotency_key, createdAt: reversal.created_at.toISOString() } : null, movements: await Promise.all(movements.map(async (movement) => ({ lineIndex: lines.findIndex((line) => line.id === movement.supplier_return_line_id), direction: movement.direction, quantityBase: movement.quantity_base, unitCostMicros: movement.unit_cost_micros, totalCostAmount: movement.total_cost_amount, idempotencyKey: movement.idempotency_key, actorGlobalId: await globalFor("user", movement.actor_user_id), reason: movement.reason, createdAt: movement.created_at.toISOString(), reversal: movement.movement_type === "supplier_return_reversal" }))) };
      }
    }
    else if (isOrder && mapping) {
      const order = await db.query.orders.findFirst({ where: eq(orders.id, Number(mapping.local_id)), with: { orderItems: { with: { modifiers: true } }, statusHistory: true } });
      if (order?.branch_id) {
        const globalFor = async (entityType: string, localId: string | number | null) => {
          if (localId === null) return null;
          const [identity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.local_id, String(localId)))).limit(1);
          return identity?.global_id ?? null;
        };
        const actorGlobalId = await globalFor("user", order.user_uid);
        const itemSnapshots = await Promise.all(order.orderItems.map(async (item) => ({
          productGlobalId: await globalFor("product", item.product_id),
          menuItemGlobalId: await globalFor("menu_item", item.menu_item_id),
          variantGlobalId: await globalFor("menu_item_variant", item.variant_id),
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          modifiers: await Promise.all(item.modifiers.map(async (modifier) => ({ modifierOptionGlobalId: await globalFor("modifier_option", modifier.modifier_option_id), name_en: modifier.name_en, name_ar: modifier.name_ar, price_delta: modifier.price_delta }))),
        })));
        const history = await Promise.all(order.statusHistory.map(async (entry) => ({ fromStatus: entry.from_status, toStatus: entry.to_status, actorGlobalId: await globalFor("user", entry.changed_by), note: entry.note, createdAt: entry.created_at.toISOString() })));
        if (actorGlobalId && itemSnapshots.every((item) => item.menuItemGlobalId) && itemSnapshots.every((item) => item.modifiers.every((modifier) => modifier.modifierOptionGlobalId))) {
          snapshot = {
            branchGlobalId: await globalFor("branch", order.branch_id),
            customerGlobalId: await globalFor("customer", order.customer_id),
            diningTableGlobalId: await globalFor("restaurant_table", order.dining_table_id),
            actorGlobalId,
            clientRequestId: order.client_request_id,
            orderType: order.order_type,
            deliveryAddress: order.delivery_address,
            status: order.status,
            paymentStatus: order.payment_status,
            subtotalAmount: order.subtotal_amount,
            discountType: order.discount_type,
            discountValue: order.discount_value,
            discountAmount: order.discount_amount,
            discountReason: order.discount_reason,
            totalAmount: order.total_amount,
            createdAt: order.created_at?.toISOString() ?? order.updated_at.toISOString(),
            updatedAt: order.updated_at.toISOString(),
            items: itemSnapshots,
            history,
          };
        }
      }
    }
    else if (isPrintJob && mapping) {
      const job = await db.query.printJobs.findFirst({ where: eq(printJobs.id, Number(mapping.local_id)) });
      if (job) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(job.order_id)))).limit(1);
        const [requestedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.requested_by))).limit(1);
        const [approvedBy] = job.approved_by ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, job.approved_by))).limit(1) : [undefined];
        const [station] = job.station_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "kitchen_station"), eq(syncGlobalEntities.local_id, String(job.station_id)))).limit(1) : [undefined];
        const [shift] = job.shift_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(job.shift_id)))).limit(1) : [undefined];
        if (orderIdentity && requestedBy) snapshot = { orderGlobalId: orderIdentity.global_id, stationGlobalId: station?.global_id ?? null, shiftGlobalId: shift?.global_id ?? null, requestedByGlobalId: requestedBy.global_id, approvedByGlobalId: approvedBy?.global_id ?? null, documentType: job.document_type, status: job.status, isReprint: job.is_reprint, idempotencyKey: job.idempotency_key, copyCount: job.copy_count, paperWidth: job.paper_width, language: job.language, reprintReason: job.reprint_reason, errorMessage: job.error_message, requestedAt: job.requested_at.toISOString(), previewedAt: job.previewed_at?.toISOString() ?? null, acknowledgedAt: job.acknowledged_at?.toISOString() ?? null };
      }
    }
    else if (isPrintPreferences && mapping) {
      const preference = await db.query.registerPrintPreferences.findFirst({ where: eq(registerPrintPreferences.id, Number(mapping.local_id)) });
      if (preference) {
        const [register] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "register"), eq(syncGlobalEntities.local_id, String(preference.register_id)))).limit(1);
        const [updatedBy] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, preference.updated_by))).limit(1);
        if (register && updatedBy) snapshot = { registerGlobalId: register.global_id, updatedByGlobalId: updatedBy.global_id, paperWidth: preference.paper_width, language: preference.language, receiptCopies: preference.receipt_copies, kotCopies: preference.kot_copies, updatedAt: preference.updated_at.toISOString() };
      }
    }
    else if (isCheckout && mapping) {
      const checkout = await db.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.id, Number(mapping.local_id)) });
      if (checkout) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(checkout.order_id)))).limit(1);
        const [shiftIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(checkout.shift_id)))).limit(1);
        const [actorIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, checkout.created_by))).limit(1);
        const [approverIdentity] = checkout.approved_by ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, checkout.approved_by))).limit(1) : [undefined];
        const payments = await db.select().from(orderPayments).where(and(eq(orderPayments.checkout_id, checkout.id), eq(orderPayments.kind, "payment")));
        const paymentSnapshots = await Promise.all(payments.map(async (payment) => {
          const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, payment.payment_method_id) });
          const [paymentIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(payment.id)))).limit(1);
          const [transaction] = await db.select().from(transactions).where(eq(transactions.order_payment_id, payment.id)).limit(1);
          const [transactionIdentity] = transaction ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "transaction"), eq(syncGlobalEntities.local_id, String(transaction.id)))).limit(1) : [undefined];
          if (!method || !paymentIdentity || !transaction || !transactionIdentity) return null;
          return { paymentGlobalId: paymentIdentity.global_id, transactionGlobalId: transactionIdentity.global_id, methodCode: method.code, amount: payment.amount, tenderedAmount: payment.tendered_amount, changeAmount: payment.change_amount, createdAt: payment.created_at.toISOString() };
        }));
        if (orderIdentity && shiftIdentity && actorIdentity && paymentSnapshots.every(Boolean)) snapshot = { orderGlobalId: orderIdentity.global_id, shiftGlobalId: shiftIdentity.global_id, actorGlobalId: actorIdentity.global_id, idempotencyKey: checkout.idempotency_key, subtotalAmount: checkout.subtotal_amount, discountAmount: checkout.discount_amount, payableAmount: checkout.payable_amount, approvedByGlobalId: approverIdentity?.global_id ?? null, createdAt: checkout.created_at.toISOString(), payments: paymentSnapshots };
      }
    }
    else if (isCancellation && mapping) {
      const cancellation = await db.query.orderCancellations.findFirst({ where: eq(orderCancellations.id, Number(mapping.local_id)) });
      if (cancellation) {
        const [orderIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order"), eq(syncGlobalEntities.local_id, String(cancellation.order_id)))).limit(1);
        const [shiftIdentity] = cancellation.shift_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "cashier_shift"), eq(syncGlobalEntities.local_id, String(cancellation.shift_id)))).limit(1) : [undefined];
        const [actorIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"), eq(syncGlobalEntities.local_id, cancellation.cancelled_by))).limit(1);
        const refundRows = await db.select().from(orderPayments).where(and(eq(orderPayments.order_id, cancellation.order_id), eq(orderPayments.kind, "refund")));
        const refunds = await Promise.all(refundRows.map(async (refund) => {
          const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, refund.payment_method_id) });
          const [refundIdentity] = await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(refund.id)))).limit(1);
          const [originalIdentity] = refund.original_payment_id ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "order_payment"), eq(syncGlobalEntities.local_id, String(refund.original_payment_id)))).limit(1) : [undefined];
          const [financial] = await db.select().from(transactions).where(eq(transactions.order_payment_id, refund.id)).limit(1);
          const [transactionIdentity] = financial ? await db.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "transaction"), eq(syncGlobalEntities.local_id, String(financial.id)))).limit(1) : [undefined];
          if (!method || !refundIdentity || !originalIdentity || !transactionIdentity) return null;
          return { refundGlobalId: refundIdentity.global_id, originalPaymentGlobalId: originalIdentity.global_id, transactionGlobalId: transactionIdentity.global_id, methodCode: method.code, amount: refund.amount, createdAt: refund.created_at.toISOString() };
        }));
        if (orderIdentity && actorIdentity && refunds.every(Boolean)) snapshot = { orderGlobalId: orderIdentity.global_id, shiftGlobalId: shiftIdentity?.global_id ?? null, actorGlobalId: actorIdentity.global_id, idempotencyKey: cancellation.idempotency_key, reason: cancellation.reason, wasPaid: cancellation.was_paid, inventoryDisposition: cancellation.inventory_disposition, createdAt: cancellation.created_at.toISOString(), refunds };
      }
    }
    else if (mapping && change.entity_type === "customer") {
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, Number(mapping.local_id)) });
      if (customer) snapshot = { name: customer.name, email: customer.email, phone: customer.phone, status: customer.status };
    } else if (mapping) {
      const product = await db.query.products.findFirst({ where: eq(products.id, Number(mapping.local_id)) });
      if (product) snapshot = { name: product.name, description: product.description, price: product.price, in_stock: product.in_stock, category: product.category, imageKey: product.image_key };
    }
    exported.push({
      cursor: change.cursor,
      domain: change.domain,
      entityType: change.entity_type,
      entityGlobalId: change.entity_global_id,
      action: change.action,
      revision: change.server_revision,
      snapshot,
    });
  }
  return NextResponse.json({ changes: exported, nextCursor: changes.at(-1)?.cursor ?? rawCursor, hasMore: changes.length === 200 }, { headers: { "cache-control": "no-store" } });
}
