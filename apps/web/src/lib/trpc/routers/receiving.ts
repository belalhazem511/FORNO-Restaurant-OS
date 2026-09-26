import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  auditLogs,
  ingredientPackageConversions,
  ingredients,
  inventoryLocations,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceiptLines,
  purchaseReceiptReversals,
  purchaseReceipts,
  stockBalances,
  stockMovements,
  staffAssignments,
  suppliers,
  syncDevices,
  unitsOfMeasure,
} from "@/lib/db/schema";
import { costMinorForQuantity, convertScaledQuantity, movingWeightedAverage, multiplyDivide, multiplyDivideFactors } from "@/lib/inventory/exact";
import { hasPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";
import { ensureLocalGlobalMapping, executeLocalCommand } from "@/lib/sync/local-command";

const branchInput = z.object({ branchId: z.number().int().positive() });
const lineInput = z.object({
  purchaseOrderLineId: z.number().int().positive(),
  acceptedQuantityScaled: z.number().int().nonnegative(),
  rejectedQuantityScaled: z.number().int().nonnegative().default(0),
  damagedQuantityScaled: z.number().int().nonnegative().default(0),
  actualUnitPriceMinor: z.number().int().nonnegative().max(2_147_483_647).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
}).refine((line) => line.acceptedQuantityScaled + line.rejectedQuantityScaled + line.damagedQuantityScaled > 0, "Enter a received quantity");
const MAX_POSTGRES_INTEGER = 2_147_483_647;
type PurchaseReceiptWithLines = typeof purchaseReceipts.$inferSelect & { lines: (typeof purchaseReceiptLines.$inferSelect)[] };

function safeAdd(left: number, right: number, label: string) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} exceeds the exact integer range` });
  return result;
}

function safeSignedAdd(left: number, right: number, label: string) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} exceeds the exact integer range` });
  return result;
}

export const receivingRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)) });
    if (!assignment) throw new TRPCError({ code: "FORBIDDEN", message: "No active staff assignment" });
    await requireStaff(ctx.user.id, assignment.branch_id, "purchase-receipt:view");
    return {
      branchId: assignment.branch_id,
      canCreate: hasPermission(assignment.role, "purchase-receipt:create"),
      canPost: hasPermission(assignment.role, "purchase-receipt:post"),
      canReverse: hasPermission(assignment.role, "purchase-receipt:reverse"),
      canApproveVariance: hasPermission(assignment.role, "purchase-receipt:variance:approve"),
      canOverreceive: hasPermission(assignment.role, "purchase-receipt:overreceive") || hasPermission(assignment.role, "inventory:override"),
    };
  }),

  locations: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:view");
    return db.query.inventoryLocations.findMany({ where: and(eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)), orderBy: [inventoryLocations.code] });
  }),

  approvedOrders: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:view");
    return db.query.purchaseOrders.findMany({
      where: and(eq(purchaseOrders.branch_id, input.branchId), eq(purchaseOrders.status, "approved")),
      with: { supplier: true, lines: { with: { ingredient: true, unit: true, packageConversion: true } }, receipts: { with: { lines: true } } },
      orderBy: [desc(purchaseOrders.created_at)],
    });
  }),

  receipts: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:view");
    return db.query.purchaseReceipts.findMany({ where: eq(purchaseReceipts.branch_id, input.branchId), with: { purchaseOrder: true, supplier: true, location: true, lines: true, reversals: true }, orderBy: [desc(purchaseReceipts.created_at)] });
  }),

  receipt: protectedProcedure.input(branchInput.extend({ receiptId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:view");
    const receipt = await db.query.purchaseReceipts.findFirst({ where: and(eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.branch_id, input.branchId)), with: { purchaseOrder: { with: { lines: true, receipts: { with: { lines: true } } } }, supplier: true, location: true, lines: { with: { ingredient: true, purchaseOrderLine: true } }, reversals: true } });
    if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase receipt not found in this branch" });
    return receipt;
  }),

  createDraft: protectedProcedure.input(branchInput.extend({
    purchaseOrderId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    receiptNumber: z.string().trim().min(3).max(48),
    supplierDeliveryNote: z.string().trim().max(120).nullable().optional(),
    supplierInvoiceReference: z.string().trim().max(120).nullable().optional(),
    receivedAt: z.string().datetime().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    idempotencyKey: z.string().trim().min(8).max(140),
    lines: z.array(lineInput).min(1),
  })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:create");
    const duplicate = await db.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.idempotency_key, input.idempotencyKey), with: { lines: true } });
    if (duplicate) {
      if (duplicate.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
      return duplicate;
    }
    const [order, location] = await Promise.all([
      db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.id, input.purchaseOrderId), eq(purchaseOrders.branch_id, input.branchId)), with: { supplier: true, lines: true } }),
      db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.locationId), eq(inventoryLocations.branch_id, input.branchId), eq(inventoryLocations.is_active, true)) }),
    ]);
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
    if (order.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only approved purchase orders can be received" });
    if (!location) throw new TRPCError({ code: "NOT_FOUND", message: "Destination location not found in this branch" });
    const poLines = new Map(order.lines.map((line) => [line.id, line]));
    const seen = new Set<number>();
    const resolved: Array<{
      poLine: (typeof order.lines)[number]; input: z.infer<typeof lineInput>; numerator: number; denominator: number;
      quantityInputScaled: number; accepted: number; rejected: number; damaged: number; actualPrice: number;
      unitCostMicros: number; acceptedPrice: number;
    }> = [];
    for (const line of input.lines) {
      if (seen.has(line.purchaseOrderLineId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A purchase-order line may appear only once per receipt" });
      seen.add(line.purchaseOrderLineId);
      const poLine = poLines.get(line.purchaseOrderLineId);
      if (!poLine) throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt line does not belong to this purchase order" });
      const packageRow = poLine.package_conversion_id ? await db.query.ingredientPackageConversions.findFirst({ where: eq(ingredientPackageConversions.id, poLine.package_conversion_id) }) : null;
      const unitRow = await db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, poLine.unit_id) });
      const numerator = poLine.conversion_numerator_snapshot ?? packageRow?.base_numerator ?? unitRow?.base_numerator;
      const denominator = poLine.conversion_denominator_snapshot ?? packageRow?.base_denominator ?? unitRow?.base_denominator;
      if (!numerator || !denominator) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PO conversion snapshot is unavailable" });
      const quantityInputScaled = safeAdd(safeAdd(line.acceptedQuantityScaled, line.rejectedQuantityScaled, "Receipt quantity"), line.damagedQuantityScaled, "Receipt quantity");
      const factor = { numerator, denominator };
      const accepted = convertScaledQuantity({ quantityScaled: line.acceptedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor });
      const rejected = convertScaledQuantity({ quantityScaled: line.rejectedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor });
      const damaged = convertScaledQuantity({ quantityScaled: line.damagedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor });
      const actualPrice = line.actualUnitPriceMinor ?? poLine.unit_price_minor;
      const unitCostMicros = multiplyDivideFactors(actualPrice, [1_000_000, denominator], [numerator]);
      const acceptedPrice = multiplyDivide(line.acceptedQuantityScaled, actualPrice, 1_000);
      if (acceptedPrice > MAX_POSTGRES_INTEGER) throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt total exceeds supported EGP range" });
      resolved.push({ poLine, input: line, numerator, denominator, quantityInputScaled, accepted, rejected, damaged, actualPrice, unitCostMicros, acceptedPrice });
    }
    const poLineIndex = new Map(order.lines.map((line, index) => [line.id, index]));
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Receiving must use the paired device branch" });
      const poMapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_order", localId: order.id }) : undefined;
      const locationMapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "inventory_location", localId: location.id }) : undefined;
      return executeLocalCommand<PurchaseReceiptWithLines>(tx, {
        actorId: ctx.user.id, domain: "receiving", action: "receipt_create", entityType: "purchase_receipt", localId: (row) => String(row.id), idempotencyKey: input.idempotencyKey,
        dependsOnGlobalIds: () => [poMapping?.global_id, locationMapping?.global_id].filter((id): id is string => Boolean(id)),
        payload: (receiptGlobalId, row) => ({ receiptGlobalId, purchaseOrderGlobalId: poMapping?.global_id, locationGlobalId: locationMapping?.global_id, receiptNumber: input.receiptNumber, supplierDeliveryNote: input.supplierDeliveryNote ?? null, supplierInvoiceReference: input.supplierInvoiceReference ?? null, receivedAt: input.receivedAt ?? new Date().toISOString(), notes: input.notes ?? null, lines: resolved.map((line) => ({ poLineIndex: poLineIndex.get(line.poLine.id), acceptedQuantityScaled: line.input.acceptedQuantityScaled, rejectedQuantityScaled: line.input.rejectedQuantityScaled, damagedQuantityScaled: line.input.damagedQuantityScaled, actualUnitPriceMinor: line.actualPrice, notes: line.input.notes ?? null })) }),
      }, async (tx) => {
      const [lockedOrder] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, order.id), eq(purchaseOrders.branch_id, input.branchId))).for("update");
      if (!lockedOrder || lockedOrder.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only approved purchase orders can be received" });
      const [receipt] = await tx.insert(purchaseReceipts).values({
        branch_id: input.branchId,
        purchase_order_id: order.id,
        supplier_id: order.supplier_id,
        supplier_code_snapshot: order.supplier_code_snapshot,
        supplier_name_en_snapshot: order.supplier_name_en_snapshot,
        supplier_name_ar_snapshot: order.supplier_name_ar_snapshot,
        po_number_snapshot: order.po_number,
        receipt_number: input.receiptNumber,
        location_id: location.id,
        supplier_delivery_note: input.supplierDeliveryNote ?? null,
        supplier_invoice_reference: input.supplierInvoiceReference ?? null,
        received_at: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        received_by: ctx.user.id,
        notes: input.notes ?? null,
        status: "draft",
        idempotency_key: input.idempotencyKey,
      }).onConflictDoNothing({ target: purchaseReceipts.idempotency_key }).returning();
      if (!receipt) {
        const existing = await tx.query.purchaseReceipts.findFirst({ where: eq(purchaseReceipts.idempotency_key, input.idempotencyKey), with: { lines: true } });
        if (!existing) throw new TRPCError({ code: "CONFLICT", message: "Receipt number is already in use" });
        if (existing.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
        return existing;
      }
      await tx.insert(purchaseReceiptLines).values(resolved.map(({ poLine, input: line, numerator, denominator, quantityInputScaled, accepted, rejected, damaged, actualPrice, unitCostMicros, acceptedPrice }) => ({
        receipt_id: receipt.id,
        purchase_order_line_id: poLine.id,
        ingredient_id: poLine.ingredient_id,
        ingredient_sku_snapshot: poLine.ingredient_sku,
        ingredient_name_en_snapshot: poLine.ingredient_name_en,
        ingredient_name_ar_snapshot: poLine.ingredient_name_ar,
        package_conversion_id: poLine.package_conversion_id,
        unit_id: poLine.unit_id,
        unit_code_snapshot: poLine.unit_code,
        conversion_numerator_snapshot: numerator,
        conversion_denominator_snapshot: denominator,
        ordered_quantity_base_snapshot: poLine.quantity_base,
        po_unit_price_minor_snapshot: poLine.unit_price_minor,
        quantity_input_scaled: quantityInputScaled,
        accepted_quantity_base: accepted,
        rejected_quantity_base: rejected,
        damaged_quantity_base: damaged,
        actual_unit_price_minor: actualPrice,
        accepted_unit_cost_micros_snapshot: unitCostMicros,
        line_total_amount: acceptedPrice,
        notes: line.notes ?? null,
      })));
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "purchase_receipt.create", entity_type: "purchase_receipt", entity_id: String(receipt.id), details: JSON.stringify({ receiptNumber: receipt.receipt_number, purchaseOrderId: order.id, lineCount: resolved.length }) });
      return { ...receipt, lines: await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id) }) };
      });
    });
  }),

  editDraft: protectedProcedure.input(branchInput.extend({
    receiptId: z.number().int().positive(),
    supplierDeliveryNote: z.string().trim().max(120).nullable().optional(),
    supplierInvoiceReference: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(lineInput).min(1),
  })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:create");
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Receipt edits must use the paired device branch" });
      const mapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_receipt", localId: input.receiptId }) : undefined;
      const poLinePositions = new Map<number, number>();
      return executeLocalCommand<typeof purchaseReceipts.$inferSelect>(tx, {
        actorId: ctx.user.id, domain: "receiving", action: "receipt_edit", entityType: "purchase_receipt", localId: (row) => String(row.id),
        payload: (receiptGlobalId) => ({ receiptGlobalId, baseRevision: mapping?.server_revision ?? 0, supplierDeliveryNote: input.supplierDeliveryNote ?? null, supplierInvoiceReference: input.supplierInvoiceReference ?? null, notes: input.notes ?? null, lines: input.lines.map((line) => ({ poLineIndex: poLinePositions.get(line.purchaseOrderLineId), acceptedQuantityScaled: line.acceptedQuantityScaled, rejectedQuantityScaled: line.rejectedQuantityScaled, damagedQuantityScaled: line.damagedQuantityScaled, actualUnitPriceMinor: line.actualUnitPriceMinor ?? null, notes: line.notes ?? null })) }),
      }, async (tx) => {
      const [receipt] = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.branch_id, input.branchId))).for("update");
      if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found in this branch" });
      if (receipt.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only draft receipts can be edited" });
      const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, receipt.purchase_order_id), orderBy: [asc(purchaseOrderLines.id)] });
      poLines.forEach((line, index) => poLinePositions.set(line.id, index));
      // Draft line identity and conversion snapshots are immutable to clients; edit amounts against the saved snapshots.
      const oldLines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id) });
      const oldByPoLine = new Map(oldLines.map((line) => [line.purchase_order_line_id, line]));
      const seen = new Set<number>();
      for (const inputLine of input.lines) {
        if (seen.has(inputLine.purchaseOrderLineId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A PO line may appear once" });
        seen.add(inputLine.purchaseOrderLineId);
        const old = oldByPoLine.get(inputLine.purchaseOrderLineId);
        if (!old) throw new TRPCError({ code: "BAD_REQUEST", message: "Draft edits cannot add a PO line; create a new draft receipt" });
        const totalScaled = safeAdd(safeAdd(inputLine.acceptedQuantityScaled, inputLine.rejectedQuantityScaled, "Receipt quantity"), inputLine.damagedQuantityScaled, "Receipt quantity");
        const accepted = convertScaledQuantity({ quantityScaled: inputLine.acceptedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor: { numerator: old.conversion_numerator_snapshot, denominator: old.conversion_denominator_snapshot } });
        const rejected = convertScaledQuantity({ quantityScaled: inputLine.rejectedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor: { numerator: old.conversion_numerator_snapshot, denominator: old.conversion_denominator_snapshot } });
        const damaged = convertScaledQuantity({ quantityScaled: inputLine.damagedQuantityScaled, fromDimension: "mass", toDimension: "mass", factor: { numerator: old.conversion_numerator_snapshot, denominator: old.conversion_denominator_snapshot } });
        const price = inputLine.actualUnitPriceMinor ?? old.po_unit_price_minor_snapshot;
        const cost = multiplyDivideFactors(price, [1_000_000, old.conversion_denominator_snapshot], [old.conversion_numerator_snapshot]);
        const total = multiplyDivide(inputLine.acceptedQuantityScaled, price, 1_000);
        if (total > MAX_POSTGRES_INTEGER) throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt total exceeds supported EGP range" });
        await tx.update(purchaseReceiptLines).set({ quantity_input_scaled: totalScaled, accepted_quantity_base: accepted, rejected_quantity_base: rejected, damaged_quantity_base: damaged, actual_unit_price_minor: price, accepted_unit_cost_micros_snapshot: cost, line_total_amount: total, notes: inputLine.notes ?? null }).where(eq(purchaseReceiptLines.id, old.id));
      }
      if (seen.size !== oldLines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Draft edit must include every original PO line" });
      const [updated] = await tx.update(purchaseReceipts).set({ supplier_delivery_note: input.supplierDeliveryNote ?? null, supplier_invoice_reference: input.supplierInvoiceReference ?? null, notes: input.notes ?? null, updated_at: new Date() }).where(eq(purchaseReceipts.id, receipt.id)).returning();
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "purchase_receipt.draft_update", entity_type: "purchase_receipt", entity_id: String(receipt.id) });
      return updated;
      });
    });
  }),

  post: protectedProcedure.input(branchInput.extend({ receiptId: z.number().int().positive(), approveVariance: z.boolean().default(false), varianceReason: z.string().trim().min(3).max(500).optional(), overreceive: z.boolean().default(false), overreceiveReason: z.string().trim().min(3).max(500).optional() })).mutation(async ({ ctx, input }) => {
    const actor = await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:post");
    if (input.approveVariance) await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:variance:approve");
    if (input.overreceive) {
      if (!hasPermission(actor.role, "purchase-receipt:overreceive") && !hasPermission(actor.role, "inventory:override")) throw new TRPCError({ code: "FORBIDDEN", message: "Role cannot approve over-receiving" });
      if (!input.overreceiveReason) throw new TRPCError({ code: "BAD_REQUEST", message: "An over-receiving reason is required" });
    }
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Receiving must use the paired device branch" });
      const mapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_receipt", localId: input.receiptId }) : undefined;
      return executeLocalCommand<PurchaseReceiptWithLines>(tx, {
        actorId: ctx.user.id, domain: "receiving", action: "receipt_post", entityType: "purchase_receipt", localId: (row) => String(row.id), idempotencyKey: `receipt-post:${input.receiptId}`,
        payload: (receiptGlobalId) => ({ receiptGlobalId, baseRevision: mapping?.server_revision ?? 0, approveVariance: input.approveVariance, varianceReason: input.varianceReason ?? null, overreceive: input.overreceive, overreceiveReason: input.overreceiveReason ?? null }),
      }, async (tx) => {
      const [receipt] = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.branch_id, input.branchId))).for("update");
      if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found in this branch" });
      if (receipt.status === "posted") return { ...receipt, lines: await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id) }) };
      if (receipt.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only draft receipts can be posted" });
      const [order] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, receipt.purchase_order_id), eq(purchaseOrders.branch_id, input.branchId))).for("update");
      if (!order || order.status !== "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only approved, non-cancelled POs can be received" });
      const lines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id), orderBy: [asc(purchaseReceiptLines.id)] });
      if (!lines.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A receipt must have at least one line" });
      const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, order.id) });
      const poById = new Map(poLines.map((line) => [line.id, line]));
      const allReceipts = await tx.query.purchaseReceipts.findMany({ where: and(eq(purchaseReceipts.purchase_order_id, order.id), inArray(purchaseReceipts.status, ["posted", "needs_review"]) ), with: { lines: true } });
      const receivedByLine = new Map<number, number>();
      for (const posted of allReceipts) for (const line of posted.lines) receivedByLine.set(line.purchase_order_line_id, safeAdd(receivedByLine.get(line.purchase_order_line_id) ?? 0, line.accepted_quantity_base, "Previously received quantity"));
      let hasOverreceive = false;
      let hasSignificantVariance = false;
      const quantityVariances: Array<{ receiptLineId: number; purchaseOrderLineId: number; remainingOrderedBase: number; deliveredBase: number; acceptedBase: number; rejectedBase: number; damagedBase: number }> = [];
      for (const line of lines) {
        const poLine = poById.get(line.purchase_order_line_id);
        if (!poLine) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Receipt references a missing PO line" });
        const previous = receivedByLine.get(poLine.id) ?? 0;
        const totalAccepted = safeAdd(previous, line.accepted_quantity_base, "Received quantity");
        if (totalAccepted > poLine.quantity_base) hasOverreceive = true;
        const deliveredBase = safeAdd(safeAdd(line.accepted_quantity_base, line.rejected_quantity_base, "Delivered quantity"), line.damaged_quantity_base, "Delivered quantity");
        const remainingOrderedBase = Math.max(0, poLine.quantity_base - previous);
        if (deliveredBase !== remainingOrderedBase) quantityVariances.push({ receiptLineId: line.id, purchaseOrderLineId: poLine.id, remainingOrderedBase, deliveredBase, acceptedBase: line.accepted_quantity_base, rejectedBase: line.rejected_quantity_base, damagedBase: line.damaged_quantity_base });
        const delta = Math.abs(line.actual_unit_price_minor - line.po_unit_price_minor_snapshot);
        if (delta > 0 && (line.po_unit_price_minor_snapshot === 0 || delta * 100 > line.po_unit_price_minor_snapshot * 10)) hasSignificantVariance = true;
      }
      if (hasOverreceive && (!input.overreceive || !input.overreceiveReason)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Receiving exceeds the remaining ordered quantity; an authorized override and reason are required" });
      if (hasSignificantVariance && (!input.approveVariance || !input.varianceReason)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Price variance over 10% requires authorized approval and a reason" });
      const postedAt = new Date();
      let receiptCost = 0;
      for (const line of lines) {
        const ingredient = await tx.query.ingredients.findFirst({ where: and(eq(ingredients.id, line.ingredient_id), eq(ingredients.branch_id, input.branchId)) });
        if (!ingredient) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt ingredient is not in this branch" });
        const [insertedBalance] = await tx.insert(stockBalances).values({ branch_id: input.branchId, location_id: receipt.location_id, ingredient_id: line.ingredient_id, quantity_base: 0, average_unit_cost_micros: 0 }).onConflictDoNothing().returning();
        void insertedBalance;
        await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${receipt.location_id} and ingredient_id = ${line.ingredient_id} for update`);
        const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, receipt.location_id), eq(stockBalances.ingredient_id, line.ingredient_id)));
        if (!balance) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Inventory balance could not be locked" });
        const beforeQuantity = balance.quantity_base;
        const beforeCost = balance.average_unit_cost_micros;
        const afterCost = line.accepted_quantity_base > 0 ? beforeQuantity > 0 ? movingWeightedAverage({ existingQuantity: beforeQuantity, existingUnitCostMicros: beforeCost, addedQuantity: line.accepted_quantity_base, addedUnitCostMicros: line.accepted_unit_cost_micros_snapshot }) : line.accepted_unit_cost_micros_snapshot : beforeCost;
        if (line.accepted_quantity_base > 0) {
          const afterQuantity = safeSignedAdd(beforeQuantity, line.accepted_quantity_base, "Stock balance");
          await tx.update(stockBalances).set({ quantity_base: afterQuantity, average_unit_cost_micros: afterCost, updated_at: postedAt }).where(eq(stockBalances.id, balance.id));
          await tx.update(ingredients).set({ average_unit_cost_micros: afterCost, updated_by: ctx.user.id, updated_at: postedAt }).where(eq(ingredients.id, ingredient.id));
          await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: receipt.location_id, ingredient_id: line.ingredient_id, movement_type: "purchase_receipt", direction: 1, quantity_base: line.accepted_quantity_base, unit_cost_micros: line.accepted_unit_cost_micros_snapshot, total_cost_amount: line.line_total_amount, source_type: "purchase_receipt", source_id: String(receipt.id), idempotency_key: `purchase-receipt:${receipt.id}:line:${line.id}`, actor_user_id: ctx.user.id, reason: line.notes ?? null, created_at: postedAt });
        }
        await tx.update(purchaseReceiptLines).set({ balance_quantity_before: beforeQuantity, balance_unit_cost_before: beforeCost, ingredient_average_unit_cost_before: ingredient.average_unit_cost_micros }).where(eq(purchaseReceiptLines.id, line.id));
        receiptCost = safeAdd(receiptCost, line.line_total_amount, "Receipt total");
      }
      if (receiptCost > MAX_POSTGRES_INTEGER) throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt total exceeds the supported EGP range" });
      const [updated] = await tx.update(purchaseReceipts).set({ status: "posted", posted_at: postedAt, posted_by: ctx.user.id, variance_approved_by: hasSignificantVariance ? ctx.user.id : null, variance_reason: (hasSignificantVariance || lines.some((line) => line.actual_unit_price_minor !== line.po_unit_price_minor_snapshot)) ? input.varianceReason ?? null : null, overreceive_approved_by: hasOverreceive ? ctx.user.id : null, overreceive_reason: hasOverreceive ? input.overreceiveReason : null, updated_at: postedAt }).where(eq(purchaseReceipts.id, receipt.id)).returning();
      let fullyReceived = true;
      let anyReceived = false;
      for (const poLine of poLines) {
        const previous = receivedByLine.get(poLine.id) ?? 0;
        const current = lines.filter((line) => line.purchase_order_line_id === poLine.id).reduce((sum, line) => safeAdd(sum, line.accepted_quantity_base, "Received quantity"), 0);
        const total = safeAdd(previous, current, "Received quantity");
        anyReceived ||= total > 0;
        fullyReceived &&= total >= poLine.quantity_base;
      }
      await tx.update(purchaseOrders).set({ receiving_status: fullyReceived ? "fully_received" : anyReceived ? "partially_received" : "not_received", updated_at: postedAt }).where(eq(purchaseOrders.id, order.id));
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: hasOverreceive || (hasSignificantVariance && input.approveVariance) ? ctx.user.id : null, action: "purchase_receipt.post", entity_type: "purchase_receipt", entity_id: String(receipt.id), reason: hasOverreceive ? input.overreceiveReason : hasSignificantVariance ? input.varianceReason : null, details: JSON.stringify({ receiptNumber: receipt.receipt_number, acceptedCostMinor: receiptCost, lineCount: lines.length, significantVariance: hasSignificantVariance, quantityVarianceCount: quantityVariances.length, overreceive: hasOverreceive }) });
      if (quantityVariances.length) await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: hasOverreceive ? ctx.user.id : null, action: "purchase_receipt.quantity_variance", entity_type: "purchase_receipt", entity_id: String(receipt.id), reason: hasOverreceive ? input.overreceiveReason : null, details: JSON.stringify(quantityVariances) });
      if (lines.some((line) => line.actual_unit_price_minor !== line.po_unit_price_minor_snapshot)) await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: hasSignificantVariance ? ctx.user.id : null, action: "purchase_receipt.price_variance", entity_type: "purchase_receipt", entity_id: String(receipt.id), reason: input.varianceReason ?? null, details: JSON.stringify(lines.filter((line) => line.actual_unit_price_minor !== line.po_unit_price_minor_snapshot).map((line) => ({ lineId: line.id, poPriceMinor: line.po_unit_price_minor_snapshot, actualPriceMinor: line.actual_unit_price_minor }))) });
      if (hasOverreceive) await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: ctx.user.id, action: "purchase_receipt.overreceive", entity_type: "purchase_receipt", entity_id: String(receipt.id), reason: input.overreceiveReason });
      return { ...updated, lines };
      });
    });
  }),

  reverse: protectedProcedure.input(branchInput.extend({ receiptId: z.number().int().positive(), reason: z.string().trim().min(3).max(500), idempotencyKey: z.string().trim().min(8).max(140) })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-receipt:reverse");
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Receipt reversal must use the paired device branch" });
      const receiptMapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "purchase_receipt", localId: input.receiptId }) : undefined;
      return executeLocalCommand<typeof purchaseReceiptReversals.$inferSelect>(tx, {
        actorId: ctx.user.id, domain: "receiving", action: "receipt_reverse", entityType: "purchase_receipt_reversal", localId: (row) => String(row.id), idempotencyKey: input.idempotencyKey,
        dependsOnGlobalIds: () => [receiptMapping?.global_id].filter((id): id is string => Boolean(id)),
        payload: (reversalGlobalId) => ({ reversalGlobalId, receiptGlobalId: receiptMapping?.global_id, baseRevision: receiptMapping?.server_revision ?? 0, reason: input.reason, idempotencyKey: input.idempotencyKey }),
      }, async (tx) => {
      const duplicate = await tx.query.purchaseReceiptReversals.findFirst({ where: eq(purchaseReceiptReversals.idempotency_key, input.idempotencyKey) });
      if (duplicate) {
        if (duplicate.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key is already used" });
        return duplicate;
      }
      const [receipt] = await tx.select().from(purchaseReceipts).where(and(eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.branch_id, input.branchId))).for("update");
      if (!receipt) throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found in this branch" });
      const retriedReversal = await tx.query.purchaseReceiptReversals.findFirst({ where: eq(purchaseReceiptReversals.idempotency_key, input.idempotencyKey) });
      if (retriedReversal) {
        if (retriedReversal.branch_id !== input.branchId) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key is already used" });
        return retriedReversal;
      }
      if (receipt.status !== "posted" || !receipt.posted_at) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a posted receipt can be reversed" });
      await tx.execute(sql`select id from purchase_orders where id = ${receipt.purchase_order_id} and branch_id = ${input.branchId} for update`);
      const lines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id), orderBy: [desc(purchaseReceiptLines.id)] });
      let safe = true;
      let reviewReason = "";
      const totalsByIngredient = new Map<number, number>();
      for (const line of lines) if (line.accepted_quantity_base > 0) totalsByIngredient.set(line.ingredient_id, safeAdd(totalsByIngredient.get(line.ingredient_id) ?? 0, line.accepted_quantity_base, "Receipt reversal quantity"));
      for (const ingredientId of [...totalsByIngredient.keys()].sort((left, right) => left - right)) {
        await tx.execute(sql`select id from stock_balances where branch_id = ${input.branchId} and location_id = ${receipt.location_id} and ingredient_id = ${ingredientId} for update`);
      }
      for (const [ingredientId, acceptedQuantity] of totalsByIngredient) {
        const later = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.branch_id, input.branchId), eq(stockMovements.ingredient_id, ingredientId), sql`${stockMovements.created_at} >= ${receipt.posted_at}`, sql`${stockMovements.source_id} <> ${String(receipt.id)}`)).limit(1);
        if (later.length) { safe = false; reviewReason = "Later inventory activity exists; manual valuation review is required"; break; }
        const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, receipt.location_id), eq(stockBalances.ingredient_id, ingredientId)) });
        const missingSnapshot = lines.some((line) => line.ingredient_id === ingredientId && line.accepted_quantity_base > 0 && (line.balance_quantity_before == null || line.balance_unit_cost_before == null || line.ingredient_average_unit_cost_before == null));
        if (!balance || balance.quantity_base < acceptedQuantity || missingSnapshot) { safe = false; reviewReason = "Insufficient stock or missing posting snapshot; manual review is required"; break; }
      }
      const status = safe ? "reversed" : "needs_review";
      const [reversal] = await tx.insert(purchaseReceiptReversals).values({ receipt_id: receipt.id, branch_id: input.branchId, reason: input.reason, status, actor_user_id: ctx.user.id, idempotency_key: input.idempotencyKey }).returning();
      if (safe) {
        const postedLines = await tx.query.purchaseReceiptLines.findMany({ where: eq(purchaseReceiptLines.receipt_id, receipt.id), orderBy: [desc(purchaseReceiptLines.id)] });
        for (const line of postedLines) {
          if (!line.accepted_quantity_base) continue;
          const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.branch_id, input.branchId), eq(stockBalances.location_id, receipt.location_id), eq(stockBalances.ingredient_id, line.ingredient_id))).for("update");
          const quantity = balance.quantity_base - line.accepted_quantity_base;
          await tx.update(stockBalances).set({ quantity_base: quantity, average_unit_cost_micros: line.balance_unit_cost_before!, updated_at: new Date() }).where(eq(stockBalances.id, balance.id));
          await tx.update(ingredients).set({ average_unit_cost_micros: line.ingredient_average_unit_cost_before!, updated_by: ctx.user.id, updated_at: new Date() }).where(eq(ingredients.id, line.ingredient_id));
          await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: receipt.location_id, ingredient_id: line.ingredient_id, movement_type: "purchase_receipt_reversal", direction: -1, quantity_base: line.accepted_quantity_base, unit_cost_micros: line.accepted_unit_cost_micros_snapshot, total_cost_amount: line.line_total_amount, source_type: "purchase_receipt_reversal", source_id: String(reversal.id), idempotency_key: `purchase-receipt-reversal:${reversal.id}:line:${line.id}`, actor_user_id: ctx.user.id, reason: input.reason });
        }
      }
      await tx.update(purchaseReceipts).set({ status, reversal_reason: safe ? input.reason : null, needs_review_reason: safe ? null : `${input.reason}: ${reviewReason}`, updated_at: new Date() }).where(eq(purchaseReceipts.id, receipt.id));
      const poLines = await tx.query.purchaseOrderLines.findMany({ where: eq(purchaseOrderLines.purchase_order_id, receipt.purchase_order_id) });
      const remainingReceipts = await tx.query.purchaseReceipts.findMany({ where: and(eq(purchaseReceipts.purchase_order_id, receipt.purchase_order_id), inArray(purchaseReceipts.status, ["posted", "needs_review"])) , with: { lines: true } });
      const totals = new Map<number, number>();
      for (const other of remainingReceipts) for (const line of other.lines) totals.set(line.purchase_order_line_id, safeAdd(totals.get(line.purchase_order_line_id) ?? 0, line.accepted_quantity_base, "Received quantity"));
      const any = [...totals.values()].some((qty) => qty > 0);
      const full = poLines.length > 0 && poLines.every((line) => (totals.get(line.id) ?? 0) >= line.quantity_base);
      await tx.update(purchaseOrders).set({ receiving_status: full ? "fully_received" : any ? "partially_received" : "not_received", updated_at: new Date() }).where(eq(purchaseOrders.id, receipt.purchase_order_id));
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: ctx.user.id, action: safe ? "purchase_receipt.reverse" : "purchase_receipt.needs_review", entity_type: "purchase_receipt", entity_id: String(receipt.id), reason: input.reason, details: JSON.stringify({ reversalId: reversal.id, status, reviewReason: safe ? null : reviewReason }) });
      return reversal;
      });
    });
  }),
});
