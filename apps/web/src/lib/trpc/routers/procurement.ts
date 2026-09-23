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
  unitsOfMeasure,
} from "@/lib/db/schema";
import { convertScaledQuantity, multiplyDivide } from "@/lib/inventory/exact";
import { hasPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

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

async function assertSupplier(branchId: number, supplierId: number) {
  const supplier = await db.query.suppliers.findFirst({
    where: and(eq(suppliers.id, supplierId), eq(suppliers.branch_id, branchId)),
  });
  if (!supplier)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Supplier not found in this branch",
    });
  return supplier;
}

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
      const [supplier] = await tx
        .insert(suppliers)
        .values({
          branch_id: input.branchId,
          code: input.code,
          name_en: input.nameEn,
          name_ar: input.nameAr,
          is_active: true,
          contact_name: input.contactName ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          address: input.address ?? null,
          notes: input.notes ?? null,
          created_by: ctx.user.id,
          updated_by: ctx.user.id,
        })
        .returning();
      await tx.insert(auditLogs).values({
        branch_id: input.branchId,
        actor_user_id: ctx.user.id,
        action: "supplier.create",
        entity_type: "supplier",
        entity_id: String(supplier.id),
        details: JSON.stringify({ code: supplier.code }),
      });
      return supplier;
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
        const [supplier] = await tx
          .update(suppliers)
          .set({
            code: input.code,
            name_en: input.nameEn,
            name_ar: input.nameAr,
            contact_name: input.contactName ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            address: input.address ?? null,
            notes: input.notes ?? null,
            updated_by: ctx.user.id,
            updated_at: new Date(),
          })
          .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.branch_id, input.branchId)))
          .returning();
        if (!supplier) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found in this branch" });
        await tx.insert(auditLogs).values({
          branch_id: input.branchId,
          actor_user_id: ctx.user.id,
          action: "supplier.update",
          entity_type: "supplier",
          entity_id: String(supplier.id),
        });
        return supplier;
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
        const [updated] = await tx
          .update(suppliers)
          .set({ is_active: false, updated_by: ctx.user.id, updated_at: new Date() })
          .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.branch_id, input.branchId)))
          .returning();
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found in this branch" });
        await tx.insert(auditLogs).values({
          branch_id: input.branchId,
          actor_user_id: ctx.user.id,
          action: "supplier.archive",
          entity_type: "supplier",
          entity_id: String(updated.id),
          reason: input.reason,
        });
        return updated;
      });
    }),

  purchaseOrders: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "purchase-order:view");
    return db.query.purchaseOrders.findMany({
      where: eq(purchaseOrders.branch_id, input.branchId),
      with: { supplier: true, lines: true },
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
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(purchaseOrders).where(and(
          eq(purchaseOrders.id, input.purchaseOrderId),
          eq(purchaseOrders.branch_id, input.branchId),
        )).for("update");
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
        if (order.status !== "draft") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only draft purchase orders can be submitted" });
        const [line] = await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchase_order_id, order.id)).limit(1);
        if (!line || order.total_amount <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A purchase order must contain priced lines before submission" });
        const [updated] = await tx.update(purchaseOrders).set({ status: "submitted", submitted_by: ctx.user.id, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
        await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "purchase_order.submit", entity_type: "purchase_order", entity_id: String(order.id) });
        return updated;
      });
    }),

  approvePurchaseOrder: protectedProcedure
    .input(branchInput.extend({ purchaseOrderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "purchase-order:approve");
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(purchaseOrders).where(and(
          eq(purchaseOrders.id, input.purchaseOrderId),
          eq(purchaseOrders.branch_id, input.branchId),
        )).for("update");
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
        if (order.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only submitted purchase orders can be approved" });
        const [updated] = await tx.update(purchaseOrders).set({ status: "approved", approved_by: ctx.user.id, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
        await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: ctx.user.id, action: "purchase_order.approve", entity_type: "purchase_order", entity_id: String(order.id) });
        return updated;
      });
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
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(purchaseOrders).where(and(
          eq(purchaseOrders.id, input.purchaseOrderId),
          eq(purchaseOrders.branch_id, input.branchId),
        )).for("update");
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Purchase order not found in this branch" });
        if (order.status === "cancelled" || order.status === "approved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This purchase order cannot be cancelled" });
        const [updated] = await tx.update(purchaseOrders).set({ status: "cancelled", cancelled_by: ctx.user.id, cancellation_reason: input.reason, updated_at: new Date() }).where(eq(purchaseOrders.id, order.id)).returning();
        await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "purchase_order.cancel", entity_type: "purchase_order", entity_id: String(order.id), reason: input.reason });
        return updated;
      });
    }),
});
