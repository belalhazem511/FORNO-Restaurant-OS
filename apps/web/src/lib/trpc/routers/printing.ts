import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  auditLogs,
  cashierRegisters,
  cashierShifts,
  orders,
  printJobs,
  registerPrintPreferences,
  type PrintDocumentType,
  type PrintLanguage,
  type PrintPaperWidth,
} from "@/lib/db/schema";
import { assertKotContainsNoFinancialData, classifyReceiptState, type PrintableItem, type TrustedPrintDocument } from "@/lib/printing/documents";
import { hasPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

const paperWidthSchema = z.union([z.literal(58), z.literal(80)]);
const languageSchema = z.enum(["ar", "en", "bilingual"]);
const documentTypeSchema = z.enum(["receipt", "order_summary", "kot", "refund", "reversal"]);
const jobStatusSchema = z.enum(["previewed", "acknowledged", "failed", "cancelled"]);

async function loadOrder(orderId: number) {
  return db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: {
      branch: true,
      customer: true,
      diningTable: { with: { diningArea: true } },
      orderItems: {
        with: {
          product: true,
          menuItem: { with: { kitchenStation: true } },
          variant: true,
          modifiers: true,
        },
      },
      checkouts: { with: { shift: { with: { register: true } }, payments: { with: { paymentMethod: true } } } },
      payments: { with: { paymentMethod: true } },
      cancellations: true,
    },
  });
}

function validateDocument(order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>, type: PrintDocumentType, stationId: number | null) {
  if (type === "receipt" && order.payment_status !== "paid") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only fully paid orders can generate a payment receipt" });
  }
  if (type === "order_summary" && order.payment_status !== "unpaid") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Paid orders must use a payment receipt" });
  }
  if ((type === "refund" || type === "reversal") && order.payment_status !== "refunded") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A refund or reversal document requires refunded financial records" });
  }
  if (type === "kot") {
    if (order.status === "cancelled") throw new TRPCError({ code: "BAD_REQUEST", message: "Cancelled orders cannot generate a new KOT" });
    if (!stationId || !order.orderItems.some((item) => item.menuItem?.kitchen_station_id === stationId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "The selected station has no items on this order" });
    }
  } else if (stationId !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only KOT documents can select a kitchen station" });
  }
}

async function resolvePrintContext(order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>, userId: string) {
  if (!order.branch_id) throw new TRPCError({ code: "NOT_FOUND", message: "Order branch not found" });
  const shift = order.checkouts[0]?.shift ?? await db.query.cashierShifts.findFirst({
    where: and(eq(cashierShifts.branch_id, order.branch_id), eq(cashierShifts.cashier_user_id, userId), eq(cashierShifts.status, "open")),
    with: { register: true },
  });
  const register = shift?.register ?? await db.query.cashierRegisters.findFirst({
    where: and(eq(cashierRegisters.branch_id, order.branch_id), eq(cashierRegisters.is_active, true)),
  });
  const preference = register ? await db.query.registerPrintPreferences.findFirst({
    where: eq(registerPrintPreferences.register_id, register.id),
  }) : null;
  return { branchId: order.branch_id, shift: shift ?? null, register: register ?? null, preference };
}

function defaultsFor(type: PrintDocumentType, preference: Awaited<ReturnType<typeof resolvePrintContext>>["preference"]) {
  return {
    paperWidth: (preference?.paper_width ?? 80) as PrintPaperWidth,
    language: (preference?.language ?? "bilingual") as PrintLanguage,
    copyCount: type === "kot" ? preference?.kot_copies ?? 1 : preference?.receipt_copies ?? 1,
  };
}

function documentNumber(type: PrintDocumentType, orderId: number, checkoutId: number | null, jobId: number) {
  if (type === "receipt") return `R-${String(checkoutId ?? orderId).padStart(6, "0")}`;
  if (type === "order_summary") return `OS-${String(orderId).padStart(6, "0")}`;
  if (type === "kot") return `K-${String(orderId).padStart(6, "0")}-${String(jobId).padStart(4, "0")}`;
  if (type === "refund") return `RF-${String(checkoutId ?? orderId).padStart(6, "0")}`;
  return `RV-${String(checkoutId ?? orderId).padStart(6, "0")}`;
}

const requestInput = z.object({
  orderId: z.number().int().positive(),
  documentType: documentTypeSchema,
  stationId: z.number().int().positive().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
  reprint: z.boolean().default(false),
  reprintReason: z.string().trim().min(3).max(500).nullable().optional(),
  paperWidth: paperWidthSchema.optional(),
  language: languageSchema.optional(),
  copyCount: z.number().int().min(1).max(5).optional(),
});

export const printingRouter = router({
  registerSettings: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const assignment = await requireStaff(ctx.user.id, input.branchId, "print:initial");
      const shift = await db.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.branch_id, input.branchId), eq(cashierShifts.cashier_user_id, ctx.user.id), eq(cashierShifts.status, "open")), with: { register: true } });
      const register = shift?.register ?? await db.query.cashierRegisters.findFirst({ where: and(eq(cashierRegisters.branch_id, input.branchId), eq(cashierRegisters.is_active, true)) });
      if (!register) return { register: null, canManageSettings: hasPermission(assignment.role, "print:settings"), preferences: { paperWidth: 80 as const, language: "bilingual" as const, receiptCopies: 1, kotCopies: 1 } };
      const preference = await db.query.registerPrintPreferences.findFirst({ where: eq(registerPrintPreferences.register_id, register.id) });
      return { register: { id: register.id, name_en: register.name_en, name_ar: register.name_ar }, canManageSettings: hasPermission(assignment.role, "print:settings"), preferences: { paperWidth: preference?.paper_width ?? 80, language: preference?.language ?? "bilingual", receiptCopies: preference?.receipt_copies ?? 1, kotCopies: preference?.kot_copies ?? 1 } };
    }),

  options: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const order = await loadOrder(input.orderId);
      if (!order || !order.branch_id) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const assignment = await requireStaff(ctx.user.id, order.branch_id, "print:initial");
      const printContext = await resolvePrintContext(order, ctx.user.id);
      const defaults = defaultsFor("receipt", printContext.preference);
      const initialDocuments = await db.select({ documentType: printJobs.document_type, stationId: printJobs.station_id })
        .from(printJobs)
        .where(and(eq(printJobs.order_id, order.id), eq(printJobs.is_reprint, false)));
      const stations = [...new Map(order.orderItems.flatMap((item) => item.menuItem?.kitchenStation ? [[item.menuItem.kitchenStation.id, item.menuItem.kitchenStation] as const] : [])).values()];
      return {
        branchId: order.branch_id,
        canReprint: hasPermission(assignment.role, "print:reprint"),
        canManageSettings: hasPermission(assignment.role, "print:settings"),
        paymentStatus: order.payment_status,
        orderStatus: order.status,
        register: printContext.register ? { id: printContext.register.id, name_en: printContext.register.name_en, name_ar: printContext.register.name_ar } : null,
        preferences: { ...defaults, receiptCopies: printContext.preference?.receipt_copies ?? 1, kotCopies: printContext.preference?.kot_copies ?? 1 },
        initialDocuments,
        stations: stations.map((station) => ({ id: station.id, code: station.code, name_en: station.name_en, name_ar: station.name_ar })),
      };
    }),

  updatePreferences: protectedProcedure
    .input(z.object({ registerId: z.number().int().positive(), paperWidth: paperWidthSchema, language: languageSchema, receiptCopies: z.number().int().min(1).max(5), kotCopies: z.number().int().min(1).max(5) }))
    .mutation(async ({ ctx, input }) => {
      const register = await db.query.cashierRegisters.findFirst({ where: eq(cashierRegisters.id, input.registerId) });
      if (!register) throw new TRPCError({ code: "NOT_FOUND", message: "Register not found" });
      await requireStaff(ctx.user.id, register.branch_id, "print:settings");
      return db.transaction(async (tx) => {
        const [preference] = await tx.insert(registerPrintPreferences).values({
          register_id: register.id,
          paper_width: input.paperWidth,
          language: input.language,
          receipt_copies: input.receiptCopies,
          kot_copies: input.kotCopies,
          updated_by: ctx.user.id,
        }).onConflictDoUpdate({
          target: registerPrintPreferences.register_id,
          set: { paper_width: input.paperWidth, language: input.language, receipt_copies: input.receiptCopies, kot_copies: input.kotCopies, updated_by: ctx.user.id, updated_at: new Date() },
        }).returning();
        await tx.insert(auditLogs).values({ branch_id: register.branch_id, actor_user_id: ctx.user.id, action: "print.settings.update", entity_type: "cashier_register", entity_id: String(register.id), details: JSON.stringify(input) });
        return preference;
      });
    }),

  request: protectedProcedure
    .input(requestInput)
    .mutation(async ({ ctx, input }) => {
      const existingKey = await db.query.printJobs.findFirst({ where: eq(printJobs.idempotency_key, input.idempotencyKey) });
      if (existingKey) {
        if (existingKey.order_id !== input.orderId || existingKey.requested_by !== ctx.user.id) throw new TRPCError({ code: "CONFLICT", message: "Print idempotency key is already in use" });
        return { jobId: existingKey.id, existing: true, copyCount: existingKey.copy_count };
      }
      const order = await loadOrder(input.orderId);
      if (!order || !order.branch_id) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      const permission = input.reprint ? "print:reprint" : "print:initial";
      await requireStaff(ctx.user.id, order.branch_id, permission);
      if (input.reprint && !input.reprintReason) throw new TRPCError({ code: "BAD_REQUEST", message: "A reprint reason is required" });
      const stationId = input.stationId ?? null;
      validateDocument(order, input.documentType, stationId);
      const printContext = await resolvePrintContext(order, ctx.user.id);
      const defaults = defaultsFor(input.documentType, printContext.preference);
      if (!input.reprint) {
        const initial = await db.query.printJobs.findFirst({ where: input.documentType === "kot"
          ? and(eq(printJobs.order_id, input.orderId), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, stationId!), eq(printJobs.is_reprint, false))
          : and(eq(printJobs.order_id, input.orderId), eq(printJobs.document_type, input.documentType), eq(printJobs.is_reprint, false)) });
        if (initial) throw new TRPCError({ code: "CONFLICT", message: "The initial document already exists; an authorized reprint is required" });
      } else {
        const initial = await db.query.printJobs.findFirst({ where: input.documentType === "kot"
          ? and(eq(printJobs.order_id, input.orderId), eq(printJobs.document_type, "kot"), eq(printJobs.station_id, stationId!), eq(printJobs.is_reprint, false))
          : and(eq(printJobs.order_id, input.orderId), eq(printJobs.document_type, input.documentType), eq(printJobs.is_reprint, false)) });
        if (!initial) throw new TRPCError({ code: "BAD_REQUEST", message: "An initial document must exist before it can be reprinted" });
      }
      return db.transaction(async (tx) => {
        const [job] = await tx.insert(printJobs).values({
          order_id: order.id,
          station_id: stationId,
          register_id: printContext.register?.id ?? null,
          shift_id: printContext.shift?.id ?? null,
          requested_by: ctx.user.id,
          approved_by: input.reprint ? ctx.user.id : null,
          document_type: input.documentType,
          status: "requested",
          is_reprint: input.reprint,
          idempotency_key: input.idempotencyKey,
          copy_count: input.copyCount ?? defaults.copyCount,
          paper_width: input.paperWidth ?? defaults.paperWidth,
          language: input.language ?? defaults.language,
          reprint_reason: input.reprint ? input.reprintReason : null,
        }).returning();
        await tx.insert(auditLogs).values({
          branch_id: order.branch_id,
          shift_id: printContext.shift?.id ?? null,
          order_id: order.id,
          actor_user_id: ctx.user.id,
          approver_user_id: input.reprint ? ctx.user.id : null,
          action: input.reprint ? "print.reprint.request" : "print.initial.request",
          entity_type: "print_job",
          entity_id: String(job.id),
          reason: input.reprint ? input.reprintReason : null,
          details: JSON.stringify({ documentType: input.documentType, stationId, paperWidth: job.paper_width, language: job.language, copies: job.copy_count }),
        });
        return { jobId: job.id, existing: false, copyCount: job.copy_count };
      });
    }),

  document: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }): Promise<TrustedPrintDocument> => {
      const job = await db.query.printJobs.findFirst({ where: eq(printJobs.id, input.jobId), with: { station: true } });
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Print job not found" });
      const order = await loadOrder(job.order_id);
      if (!order || !order.branch || !order.branch_id) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      await requireStaff(ctx.user.id, order.branch_id, "print:initial");
      validateDocument(order, job.document_type, job.station_id);
      const checkout = order.checkouts[0] ?? null;
      const cancellation = order.cancellations[0] ?? null;
      const cashier = checkout ? await db.query.user.findFirst({ where: (users, { eq: equals }) => equals(users.id, checkout.created_by) }) : null;
      const allItems: PrintableItem[] = order.orderItems.flatMap((item) => {
        if (!item.menuItem?.kitchenStation) return job.document_type === "kot" ? [] : [{
          en: item.product?.name ?? "Menu item",
          ar: item.product?.name ?? "صنف",
          quantity: item.quantity,
          unitPrice: item.price,
          variant: item.variant ? { en: item.variant.name_en, ar: item.variant.name_ar } : null,
          modifiers: item.modifiers.map((modifier) => ({ en: modifier.name_en, ar: modifier.name_ar, priceDelta: modifier.price_delta })),
          notes: item.notes,
          station: { code: "UNROUTED", en: "Unrouted", ar: "غير موجه" },
        }];
        return [{
          en: item.menuItem.name_en,
          ar: item.menuItem.name_ar,
          quantity: item.quantity,
          unitPrice: item.price,
          variant: item.variant ? { en: item.variant.name_en, ar: item.variant.name_ar } : null,
          modifiers: item.modifiers.map((modifier) => ({ en: modifier.name_en, ar: modifier.name_ar, priceDelta: modifier.price_delta })),
          notes: item.notes,
          station: { code: item.menuItem.kitchenStation.code, en: item.menuItem.kitchenStation.name_en, ar: item.menuItem.kitchenStation.name_ar },
        }];
      });
      const items = job.document_type === "kot" ? allItems.filter((item) => item.station.code === job.station?.code) : allItems;
      const payments = order.payments.map((payment) => ({
        method: payment.paymentMethod.name,
        kind: payment.kind as "payment" | "refund",
        amount: payment.amount,
        tenderedAmount: payment.tendered_amount,
        changeAmount: payment.change_amount,
      })) ?? [];
      const financial = job.document_type === "kot" ? null : {
        state: classifyReceiptState({ paymentStatus: order.payment_status, wasPaidCancellation: cancellation?.was_paid ?? false }),
        receiptNumber: documentNumber(job.document_type, order.id, checkout?.id ?? null, job.id),
        subtotal: checkout?.subtotal_amount ?? order.subtotal_amount,
        discount: checkout?.discount_amount ?? order.discount_amount,
        discountReason: order.discount_reason,
        total: checkout?.payable_amount ?? order.total_amount,
        payments,
        cashReceived: order.payments.filter((payment) => payment.kind === "payment" && payment.paymentMethod.affects_drawer).reduce((sum, payment) => sum + (payment.tendered_amount ?? payment.amount), 0),
        change: payments.filter((payment) => payment.kind === "payment").reduce((sum, payment) => sum + payment.changeAmount, 0),
        reversalReason: cancellation?.reason ?? null,
        reversedAt: cancellation?.created_at ?? null,
        transactionAt: checkout?.created_at ?? null,
      };
      const document: TrustedPrintDocument = {
        job: { number: documentNumber(job.document_type, order.id, checkout?.id ?? null, job.id), documentType: job.document_type, status: job.status, isReprint: job.is_reprint, copyCount: job.copy_count, paperWidth: job.paper_width, language: job.language, requestedAt: job.requested_at },
        restaurant: { name: { en: "FORNO Restaurant", ar: "مطعم فورنو" }, branch: { en: order.branch.name_en, ar: order.branch.name_ar }, address: { en: order.branch.address_en ?? "", ar: order.branch.address_ar ?? "" }, phone: order.branch.phone },
        order: { number: String(order.id).padStart(6, "0"), createdAt: order.created_at ?? order.updated_at, type: order.order_type, area: order.diningTable ? { en: order.diningTable.diningArea.name_en, ar: order.diningTable.diningArea.name_ar } : null, table: order.diningTable ? { en: order.diningTable.name_en, ar: order.diningTable.name_ar } : null, customerName: order.order_type === "delivery" ? order.customer?.name ?? null : null, customerPhone: order.order_type === "delivery" ? order.customer?.phone ?? null : null, deliveryAddress: order.order_type === "delivery" ? order.delivery_address : null },
        operator: { cashier: cashier?.name ?? null, register: checkout?.shift.register ? { en: checkout.shift.register.name_en, ar: checkout.shift.register.name_ar } : null, shiftNumber: checkout ? String(checkout.shift.id) : null },
        station: job.station ? { code: job.station.code, en: job.station.name_en, ar: job.station.name_ar } : null,
        items,
        financial,
      };
      assertKotContainsNoFinancialData(document);
      return document;
    }),

  transition: protectedProcedure
    .input(z.object({ jobId: z.number().int().positive(), status: jobStatusSchema, errorMessage: z.string().trim().min(1).max(1000).nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const job = await db.query.printJobs.findFirst({ where: eq(printJobs.id, input.jobId), with: { order: true } });
      if (!job?.order.branch_id) throw new TRPCError({ code: "NOT_FOUND", message: "Print job not found" });
      const assignment = await requireStaff(ctx.user.id, job.order.branch_id, "print:initial");
      if (job.requested_by !== ctx.user.id && !hasPermission(assignment.role, "print:reprint")) throw new TRPCError({ code: "FORBIDDEN", message: "Only the requester or a manager can update this print request" });
      const allowed: Record<typeof job.status, string[]> = { requested: ["previewed", "failed", "cancelled"], previewed: ["acknowledged", "failed", "cancelled"], acknowledged: [], failed: [], cancelled: [] };
      if (!allowed[job.status].includes(input.status)) throw new TRPCError({ code: "CONFLICT", message: `Cannot change print status from ${job.status} to ${input.status}` });
      if (input.status === "failed" && !input.errorMessage) throw new TRPCError({ code: "BAD_REQUEST", message: "A printer error message is required" });
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(printJobs).set({ status: input.status, error_message: input.status === "failed" ? input.errorMessage : null, previewed_at: input.status === "previewed" ? new Date() : job.previewed_at, acknowledged_at: input.status === "acknowledged" ? new Date() : null, updated_at: new Date() }).where(and(eq(printJobs.id, job.id), eq(printJobs.status, job.status))).returning();
        if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Print request was updated concurrently" });
        await tx.insert(auditLogs).values({ branch_id: job.order.branch_id, shift_id: job.shift_id, order_id: job.order_id, actor_user_id: ctx.user.id, action: `print.${input.status}`, entity_type: "print_job", entity_id: String(job.id), details: input.errorMessage ?? null });
        return { id: updated.id, status: updated.status };
      });
    }),

  recent: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "print:initial");
      const rows = await db.select({ id: printJobs.id, orderId: printJobs.order_id, documentType: printJobs.document_type, status: printJobs.status, isReprint: printJobs.is_reprint, requestedAt: printJobs.requested_at, error: printJobs.error_message }).from(printJobs).innerJoin(orders, eq(printJobs.order_id, orders.id)).where(eq(orders.branch_id, input.branchId)).orderBy(desc(printJobs.requested_at)).limit(input.limit);
      return rows;
    }),
});
