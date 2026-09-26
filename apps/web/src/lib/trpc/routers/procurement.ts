import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  auditLogs,
  ingredientPackageConversions,
  ingredients,
  purchaseOrderLines,
  purchaseOrders,
  staffAssignments,
  suppliers,
  syncDevices,
  unitsOfMeasure,
} from "@/lib/db/schema";
import { convertScaledQuantity, multiplyDivide } from "@/lib/inventory/exact";
import { hasPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";
import { approvePurchaseOrder, cancelPurchaseOrder, submitPurchaseOrder } from "./procurement/purchase-order-lifecycle";
import { archiveSupplier, assertSupplier, createSupplier, updateSupplier } from "./procurement/suppliers";
import { ensureLocalGlobalMapping, executeLocalCommand } from "@/lib/sync/local-command";

const branchInput = z.object({ branchId: z.number().int().positive() });
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const supplierFields = {
  code: z.string().trim().min(2).max(40),
  nameEn: z.string().trim().min(2).max(160),
  nameAr: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().email().max(160).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
};
const lineInput = z.object({
  ingredientId: z.number().int().positive(),
  packageConversionId: z.number().int().positive().nullable().optional(),
  unitId: z.number().int().positive(),
  quantityScaled: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative().max(MAX_POSTGRES_INTEGER),
  notes: z.string().trim().max(500).nullable().optional(),
});

async function resolveLines(branchId: number, lines: z.infer<typeof lineInput>[]) {
  if (!lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A purchase order needs at least one line",
    });
  const ingredientIds = [...new Set(lines.map((line) => line.ingredientId))];
  const unitIds = [...new Set(lines.map((line) => line.unitId))];
  const packageIds = [...new Set(lines.flatMap((line) => (line.packageConversionId ? [line.packageConversionId] : [])))];
  const [ingredientRows, unitRows, packageRows] = await Promise.all([
    db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.branch_id, branchId), inArray(ingredients.id, ingredientIds))),
    db.select().from(unitsOfMeasure).where(inArray(unitsOfMeasure.id, unitIds)),
    packageIds.length ? db.select().from(ingredientPackageConversions).where(inArray(ingredientPackageConversions.id, packageIds)) : [],
  ]);
  const ingredientById = new Map(ingredientRows.map((row) => [row.id, row]));
  const unitById = new Map(unitRows.map((row) => [row.id, row]));
  const packageById = new Map(packageRows.map((row) => [row.id, row]));
  return lines.map((line) => {
    const ingredient = ingredientById.get(line.ingredientId);
    const unit = unitById.get(line.unitId);
    const packageConversion = line.packageConversionId ? packageById.get(line.packageConversionId) : null;
    if (!ingredient || !ingredient.is_active || !unit || unit.dimension !== ingredient.dimension)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Purchase order line has an invalid ingredient or unit",
      });
    if (
      line.packageConversionId &&
      (!packageConversion || packageConversion.ingredient_id !== ingredient.id || !packageConversion.is_active)
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Package conversion does not belong to the selected ingredient",
      });
    const factor = packageConversion
      ? {
          numerator: packageConversion.base_numerator,
          denominator: packageConversion.base_denominator,
        }
      : { numerator: unit.base_numerator, denominator: unit.base_denominator };
    const quantityBase = convertScaledQuantity({
      quantityScaled: line.quantityScaled,
      fromDimension: ingredient.dimension,
      toDimension: ingredient.dimension,
      factor,
    });
    const lineTotalAmount = multiplyDivide(line.quantityScaled, line.unitPriceMinor, 1_000);
    if (lineTotalAmount > MAX_POSTGRES_INTEGER)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Purchase order line total exceeds the supported EGP amount",
      });
    return {
      ...line,
      ingredient,
      unit,
      packageConversion,
      conversionNumeratorSnapshot: factor.numerator,
      conversionDenominatorSnapshot: factor.denominator,
      quantityBase,
      lineTotalAmount,
    };
  });
}

async function assertDraft(branchId: number, purchaseOrderId: number) {
  const order = await db.query.purchaseOrders.findFirst({
    where: and(eq(purchaseOrders.id, purchaseOrderId), eq(purchaseOrders.branch_id, branchId)),
    with: { lines: true, supplier: true },
  });
  if (!order)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Purchase order not found in this branch",
    });
  if (order.status !== "draft")
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Only draft purchase orders can be edited",
    });
  return order;
}

function purchaseOrderTotal(lines: Array<{ lineTotalAmount: number }>) {
  const total = lines.reduce((sum, line) => {
    const next = sum + line.lineTotalAmount;
    if (!Number.isSafeInteger(next) || next > MAX_POSTGRES_INTEGER)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Purchase order total exceeds the supported EGP amount",
      });
    return next;
  }, 0);
  return total;
}

export const procurementRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({
      where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)),
    });
    if (!assignment)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No active staff assignment",
      });
    await requireStaff(ctx.user.id, assignment.branch_id, "purchase-order:view");
    return {
      branchId: assignment.branch_id,
      canManageSuppliers: hasPermission(assignment.role, "supplier:manage"),
      canCreateOrders: hasPermission(assignment.role, "purchase-order:create"),
      canApproveOrders: hasPermission(assignment.role, "purchase-order:approve"),
    };
  }),

  suppliers: protectedProcedure.input(branchInput.extend({ includeArchived: z.boolean().optional() })).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "supplier:view");
    return db.query.suppliers.findMany({
      where: and(eq(suppliers.branch_id, input.branchId), input.includeArchived ? undefined : eq(suppliers.is_active, true)),
      orderBy: [suppliers.name_en],
    });
  }),

  createSupplier: protectedProcedure.input(branchInput.extend(supplierFields)).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "supplier:manage");
    const duplicate = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.branch_id, input.branchId), eq(suppliers.code, input.code)),
    });
    if (duplicate)
      throw new TRPCError({ code: "CONFLICT", message: "Supplier code already exists in this branch" });
    return db.transaction(async (tx) => {
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
      if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Supplier creation must use the paired device branch" });
      return executeLocalCommand<typeof suppliers.$inferSelect>(tx, {
      actorId: ctx.user.id,
      domain: "suppliers",
      action: "create",
      entityType: "supplier",
      localId: (supplier) => String(supplier.id),
      payload: (supplierGlobalId, supplier) => ({ supplierGlobalId, values: { code: supplier.code, nameEn: supplier.name_en, nameAr: supplier.name_ar, contactName: supplier.contact_name, phone: supplier.phone, email: supplier.email, address: supplier.address, notes: supplier.notes } }),
      }, (tx) => createSupplier(tx, input, ctx.user.id));
    });
  }),

  updateSupplier: protectedProcedure
    .input(
      branchInput.extend({
        supplierId: z.number().int().positive(),
        ...supplierFields,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "supplier:manage");
      const duplicate = await db.query.suppliers.findFirst({
        where: and(
          eq(suppliers.branch_id, input.branchId),
          eq(suppliers.code, input.code),
          sql`${suppliers.id} <> ${input.supplierId}`,
        ),
      });
      if (duplicate)
        throw new TRPCError({ code: "CONFLICT", message: "Supplier code already exists in this branch" });
      return db.transaction(async (tx) => {
        const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
        const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
        if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Supplier updates must use the paired device branch" });
        const mapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "supplier", localId: input.supplierId }) : undefined;
        return executeLocalCommand<typeof suppliers.$inferSelect>(tx, {
          actorId: ctx.user.id, domain: "suppliers", action: "update", entityType: "supplier", localId: (supplier) => String(supplier.id),
          payload: (supplierGlobalId, supplier) => ({ supplierGlobalId, values: { code: supplier.code, nameEn: supplier.name_en, nameAr: supplier.name_ar, contactName: supplier.contact_name, phone: supplier.phone, email: supplier.email, address: supplier.address, notes: supplier.notes }, baseRevision: mapping?.server_revision ?? 0 }),
        }, (tx) => updateSupplier(tx, input, ctx.user.id));
      });
    }),

  archiveSupplier: protectedProcedure
    .input(
      branchInput.extend({
        supplierId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "supplier:manage");
      await assertSupplier(input.branchId, input.supplierId);
      return db.transaction(async (tx) => {
        const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
        const device = deviceId && process.env.FORNO_DESKTOP_MODE === "1" ? await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) }) : undefined;
        if (device && device.branch_id !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "Supplier archive must use the paired device branch" });
        const mapping = device ? await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: input.branchId, entityType: "supplier", localId: input.supplierId }) : undefined;
        return executeLocalCommand<typeof suppliers.$inferSelect>(tx, {
          actorId: ctx.user.id, domain: "suppliers", action: "archive", entityType: "supplier", localId: (supplier) => String(supplier.id),
          payload: (supplierGlobalId, supplier) => ({ supplierGlobalId, reason: input.reason, baseRevision: mapping?.server_revision ?? 0, values: { code: supplier.code, nameEn: supplier.name_en, nameAr: supplier.name_ar, contactName: supplier.contact_name, phone: supplier.phone, email: supplier.email, address: supplier.address, notes: supplier.notes, isActive: supplier.is_active } }),
        }, (tx) => archiveSupplier(tx, input, ctx.user.id));
      });
    }),

  purchaseOrders: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-order:view");
    return db.query.purchaseOrders.findMany({
      where: eq(purchaseOrders.branch_id, input.branchId),
      with: { supplier: true, lines: { with: { ingredient: true } }, receipts: { with: { lines: true } } },
      orderBy: [desc(purchaseOrders.created_at)],
    });
  }),

  purchaseOrder: protectedProcedure
    .input(branchInput.extend({ purchaseOrderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:view");
      const order = await db.query.purchaseOrders.findFirst({
        where: and(eq(purchaseOrders.id, input.purchaseOrderId), eq(purchaseOrders.branch_id, input.branchId)),
        with: {
          supplier: true,
          lines: {
            with: { ingredient: true, unit: true, packageConversion: true },
          },
          receipts: { with: { lines: true } },
        },
      });
      if (!order)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Purchase order not found in this branch",
        });
      return order;
    }),

  createPurchaseOrder: protectedProcedure
    .input(
      branchInput.extend({
        supplierId: z.number().int().positive(),
        poNumber: z.string().trim().min(2).max(48),
        expectedDate: z.string().datetime().nullable().optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
        idempotencyKey: z.string().trim().min(8).max(140),
        lines: z.array(lineInput).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:create");
      const supplier = await assertSupplier(input.branchId, input.supplierId);
      if (!supplier.is_active)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Archived suppliers cannot receive new purchase orders",
        });
      const duplicate = await db.query.purchaseOrders.findFirst({
        where: eq(purchaseOrders.idempotency_key, input.idempotencyKey),
        with: { lines: true, supplier: true },
      });
      if (duplicate) {
        if (duplicate.branch_id !== input.branchId)
          throw new TRPCError({ code: "CONFLICT", message: "Idempotency key has already been used" });
        return duplicate;
      }
      const resolved = await resolveLines(input.branchId, input.lines);
      const subtotal = purchaseOrderTotal(resolved);
      return db.transaction(async (tx) => {
        const [order] = await tx
          .insert(purchaseOrders)
          .values({
            branch_id: input.branchId,
            supplier_id: input.supplierId,
            supplier_code_snapshot: supplier.code,
            supplier_name_en_snapshot: supplier.name_en,
            supplier_name_ar_snapshot: supplier.name_ar,
            po_number: input.poNumber,
            status: "draft",
            receiving_status: "not_received",
            order_date: new Date(),
            currency: "EGP",
            expected_date: input.expectedDate ? new Date(input.expectedDate) : null,
            subtotal_amount: subtotal,
            total_amount: subtotal,
            notes: input.notes ?? null,
            idempotency_key: input.idempotencyKey,
            created_by: ctx.user.id,
          })
          .returning();
        await tx.insert(purchaseOrderLines).values(
          resolved.map((line) => ({
            purchase_order_id: order.id,
            ingredient_id: line.ingredient.id,
            package_conversion_id: line.packageConversion?.id ?? null,
            unit_id: line.unit.id,
            ingredient_sku: line.ingredient.sku,
            ingredient_name_en: line.ingredient.name_en,
            ingredient_name_ar: line.ingredient.name_ar,
            unit_code: line.packageConversion?.code ?? line.unit.code,
            quantity_input_scaled: line.quantityScaled,
            quantity_base: line.quantityBase,
            conversion_numerator_snapshot: line.conversionNumeratorSnapshot,
            conversion_denominator_snapshot: line.conversionDenominatorSnapshot,
            unit_price_minor: line.unitPriceMinor,
            line_total_amount: line.lineTotalAmount,
            notes: line.notes ?? null,
          })),
        );
        await tx.insert(auditLogs).values({
          branch_id: input.branchId,
          actor_user_id: ctx.user.id,
          action: "purchase_order.create",
          entity_type: "purchase_order",
          entity_id: String(order.id),
          details: JSON.stringify({
            poNumber: order.po_number,
            lineCount: resolved.length,
            total: subtotal,
          }),
        });
        return order;
      });
    }),

  replaceDraftLines: protectedProcedure
    .input(
      branchInput.extend({
        purchaseOrderId: z.number().int().positive(),
        lines: z.array(lineInput).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:create");
      const order = await assertDraft(input.branchId, input.purchaseOrderId);
      const resolved = await resolveLines(input.branchId, input.lines);
      const subtotal = purchaseOrderTotal(resolved);
      return db.transaction(async (tx) => {
        const [lockedDraft] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(
          eq(purchaseOrders.id, order.id),
          eq(purchaseOrders.branch_id, input.branchId),
          eq(purchaseOrders.status, "draft"),
        )).for("update");
        if (!lockedDraft) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only draft purchase orders can be edited" });
        await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchase_order_id, order.id));
        await tx.insert(purchaseOrderLines).values(
          resolved.map((line) => ({
            purchase_order_id: order.id,
            ingredient_id: line.ingredient.id,
            package_conversion_id: line.packageConversion?.id ?? null,
            unit_id: line.unit.id,
            ingredient_sku: line.ingredient.sku,
            ingredient_name_en: line.ingredient.name_en,
            ingredient_name_ar: line.ingredient.name_ar,
            unit_code: line.packageConversion?.code ?? line.unit.code,
            quantity_input_scaled: line.quantityScaled,
            quantity_base: line.quantityBase,
            conversion_numerator_snapshot: line.conversionNumeratorSnapshot,
            conversion_denominator_snapshot: line.conversionDenominatorSnapshot,
            unit_price_minor: line.unitPriceMinor,
            line_total_amount: line.lineTotalAmount,
            notes: line.notes ?? null,
          })),
        );
        const [updated] = await tx
          .update(purchaseOrders)
          .set({
            subtotal_amount: subtotal,
            total_amount: subtotal,
            updated_at: new Date(),
          })
          .where(eq(purchaseOrders.id, order.id))
          .returning();
        await tx.insert(auditLogs).values({
          branch_id: input.branchId,
          actor_user_id: ctx.user.id,
          action: "purchase_order.lines_update",
          entity_type: "purchase_order",
          entity_id: String(order.id),
          details: JSON.stringify({
            lineCount: resolved.length,
            total: subtotal,
          }),
        });
        return updated;
      });
    }),

  submitPurchaseOrder: protectedProcedure
    .input(branchInput.extend({ purchaseOrderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:create");
      return submitPurchaseOrder(input, ctx.user.id);
    }),

  approvePurchaseOrder: protectedProcedure
    .input(branchInput.extend({ purchaseOrderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:approve");
      return approvePurchaseOrder(input, ctx.user.id);
    }),

  cancelPurchaseOrder: protectedProcedure
    .input(
      branchInput.extend({
        purchaseOrderId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:approve");
      return cancelPurchaseOrder(input, ctx.user.id);
    }),
});
