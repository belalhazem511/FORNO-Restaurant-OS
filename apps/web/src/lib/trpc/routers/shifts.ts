import { TRPCError } from "@trpc/server";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  auditLogs,
  cashierRegisters,
  cashierShifts,
  orderPayments,
  paymentMethods,
  shiftCashMovements,
  transactions,
} from "@/lib/db/schema";
import { calculateExpectedCash } from "@/lib/finance";
import { assertPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";

const methodTotalSchema = z.object({
  paymentMethodId: z.number(),
  code: z.string().nullable(),
  name: z.string(),
  payments: z.number(),
  refunds: z.number(),
  net: z.number(),
});

const summarySchema = z.object({
  cashSales: z.number(),
  cashRefunds: z.number(),
  cashIn: z.number(),
  cashOut: z.number(),
  expectedCash: z.number(),
  byPaymentMethod: z.array(methodTotalSchema),
});

const shiftSchema = z.object({
  id: z.number(),
  branch_id: z.number(),
  register_id: z.number(),
  cashier_user_id: z.string(),
  opened_by: z.string(),
  closed_by: z.string().nullable(),
  status: z.string(),
  opening_float: z.number(),
  expected_cash: z.number().nullable(),
  closing_cash: z.number().nullable(),
  variance: z.number().nullable(),
  opened_at: z.date(),
  closed_at: z.date().nullable(),
  register: z.object({ name_en: z.string(), name_ar: z.string(), code: z.string() }),
  summary: summarySchema,
});

async function summarizeShift(executor: any, shift: { id: number; opening_float: number }) {
  const [methods, payments, movements] = await Promise.all([
    executor.select().from(paymentMethods),
    executor.select().from(orderPayments).where(eq(orderPayments.shift_id, shift.id)),
    executor.select().from(shiftCashMovements).where(eq(shiftCashMovements.shift_id, shift.id)),
  ]);
  const byMethod = methods.map((method: typeof paymentMethods.$inferSelect) => {
    const related = payments.filter((payment: typeof orderPayments.$inferSelect) => payment.payment_method_id === method.id);
    const paid = related.filter((payment: typeof orderPayments.$inferSelect) => payment.kind === "payment")
      .reduce((sum: number, payment: typeof orderPayments.$inferSelect) => sum + payment.amount, 0);
    const refunded = related.filter((payment: typeof orderPayments.$inferSelect) => payment.kind === "refund")
      .reduce((sum: number, payment: typeof orderPayments.$inferSelect) => sum + payment.amount, 0);
    return {
      paymentMethodId: method.id,
      code: method.code,
      name: method.name,
      payments: paid,
      refunds: refunded,
      net: paid - refunded,
      affectsDrawer: method.affects_drawer,
    };
  });
  const cashSales = byMethod.filter((method: (typeof byMethod)[number]) => method.affectsDrawer)
    .reduce((sum: number, method: (typeof byMethod)[number]) => sum + method.payments, 0);
  const cashRefunds = byMethod.filter((method: (typeof byMethod)[number]) => method.affectsDrawer)
    .reduce((sum: number, method: (typeof byMethod)[number]) => sum + method.refunds, 0);
  const cashIn = movements.filter((movement: typeof shiftCashMovements.$inferSelect) => movement.type === "cash_in")
    .reduce((sum: number, movement: typeof shiftCashMovements.$inferSelect) => sum + movement.amount, 0);
  const cashOut = movements.filter((movement: typeof shiftCashMovements.$inferSelect) => movement.type === "cash_out")
    .reduce((sum: number, movement: typeof shiftCashMovements.$inferSelect) => sum + movement.amount, 0);
  return {
    cashSales,
    cashRefunds,
    cashIn,
    cashOut,
    expectedCash: calculateExpectedCash({ openingFloat: shift.opening_float, cashSales, cashRefunds, cashIn, cashOut }),
    byPaymentMethod: byMethod.map(({ affectsDrawer: _affectsDrawer, ...method }: (typeof byMethod)[number]) => method),
  };
}

async function hydrateShift(executor: any, shift: typeof cashierShifts.$inferSelect) {
  const register = await executor.query.cashierRegisters.findFirst({
    where: eq(cashierRegisters.id, shift.register_id),
    columns: { name_en: true, name_ar: true, code: true },
  });
  if (!register) throw new Error("Cashier register not found");
  return { ...shift, register, summary: await summarizeShift(executor, shift) };
}

export const shiftsRouter = router({
  context: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .output(z.object({
      role: z.enum(["owner", "admin", "manager", "cashier"]),
      canReview: z.boolean(),
      canAdjustCash: z.boolean(),
      registers: z.array(z.object({ id: z.number(), code: z.string(), name_en: z.string(), name_ar: z.string() })),
      paymentMethods: z.array(z.object({ id: z.number(), code: z.string().nullable(), name: z.string(), affects_drawer: z.boolean() })),
      currentShift: shiftSchema.nullable(),
    }))
    .query(async ({ ctx, input }) => {
      const assignment = await requireStaff(ctx.user.id, input.branchId, "shift:own");
      const [registers, methods, current] = await Promise.all([
        db.select({ id: cashierRegisters.id, code: cashierRegisters.code, name_en: cashierRegisters.name_en, name_ar: cashierRegisters.name_ar })
          .from(cashierRegisters).where(and(eq(cashierRegisters.branch_id, input.branchId), eq(cashierRegisters.is_active, true))),
        db.select({ id: paymentMethods.id, code: paymentMethods.code, name: paymentMethods.name, affects_drawer: paymentMethods.affects_drawer })
          .from(paymentMethods).where(eq(paymentMethods.is_active, true)),
        db.query.cashierShifts.findFirst({ where: and(
          eq(cashierShifts.branch_id, input.branchId),
          eq(cashierShifts.cashier_user_id, ctx.user.id),
          eq(cashierShifts.status, "open"),
        ) }),
      ]);
      return {
        role: assignment.role,
        canReview: assignment.role !== "cashier",
        canAdjustCash: assignment.role !== "cashier",
        registers,
        paymentMethods: methods,
        currentShift: current ? await hydrateShift(db, current) : null,
      };
    }),

  open: protectedProcedure
    .input(z.object({
      branchId: z.number().int().positive(),
      registerId: z.number().int().positive(),
      openingFloat: z.number().int().nonnegative(),
    }))
    .output(shiftSchema)
    .mutation(async ({ ctx, input }) => {
      await requireStaff(ctx.user.id, input.branchId, "shift:own");
      const register = await db.query.cashierRegisters.findFirst({ where: and(
        eq(cashierRegisters.id, input.registerId),
        eq(cashierRegisters.branch_id, input.branchId),
        eq(cashierRegisters.is_active, true),
      ) });
      if (!register) throw new Error("Active cashier register not found in this branch");
      const activeShift = await db.query.cashierShifts.findFirst({ where: and(
        eq(cashierShifts.status, "open"),
        eq(cashierShifts.branch_id, input.branchId),
        or(eq(cashierShifts.register_id, input.registerId), eq(cashierShifts.cashier_user_id, ctx.user.id)),
      ) });
      if (activeShift) {
        throw new TRPCError({ code: "CONFLICT", message: "This cashier or register already has an open shift" });
      }
      try {
        const created = await db.transaction(async (tx) => {
          const [shift] = await tx.insert(cashierShifts).values({
            branch_id: input.branchId,
            register_id: input.registerId,
            cashier_user_id: ctx.user.id,
            opened_by: ctx.user.id,
            opening_float: input.openingFloat,
            status: "open",
          }).returning();
          await tx.insert(auditLogs).values({
            branch_id: input.branchId, shift_id: shift.id, actor_user_id: ctx.user.id,
            action: "shift.open", entity_type: "cashier_shift", entity_id: String(shift.id),
            details: JSON.stringify({ openingFloat: input.openingFloat, registerId: input.registerId }),
          });
          return shift;
        });
        return hydrateShift(db, created);
      } catch (error) {
        if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
          throw new TRPCError({ code: "CONFLICT", message: "This cashier or register already has an open shift" });
        }
        throw error;
      }
    }),

  moveCash: protectedProcedure
    .input(z.object({
      shiftId: z.number().int().positive(),
      type: z.enum(["cash_in", "cash_out"]),
      amount: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .output(shiftSchema)
    .mutation(async ({ ctx, input }) => {
      const shift = await db.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.id, input.shiftId), eq(cashierShifts.status, "open")) });
      if (!shift) throw new Error("Open shift not found");
      await requireStaff(ctx.user.id, shift.branch_id, "cash:adjust");
      const cashMethod = await db.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, "CASH"), eq(paymentMethods.is_active, true)) });
      if (!cashMethod) throw new Error("Cash payment method is not configured");
      await db.transaction(async (tx) => {
        const [movement] = await tx.insert(shiftCashMovements).values({
          shift_id: shift.id, type: input.type, amount: input.amount, reason: input.reason, created_by: ctx.user.id,
        }).returning();
        await tx.insert(transactions).values({
          shift_id: shift.id,
          payment_method_id: cashMethod.id,
          amount: input.amount,
          user_uid: ctx.user.id,
          type: input.type === "cash_in" ? "income" : "expense",
          category: input.type,
          status: "completed",
          description: input.reason,
        });
        await tx.insert(auditLogs).values({
          branch_id: shift.branch_id, shift_id: shift.id, actor_user_id: ctx.user.id,
          action: `shift.${input.type}`, entity_type: "cash_movement", entity_id: String(movement.id),
          reason: input.reason, details: JSON.stringify({ amount: input.amount }),
        });
      });
      const refreshed = await db.query.cashierShifts.findFirst({ where: eq(cashierShifts.id, shift.id) });
      return hydrateShift(db, refreshed!);
    }),

  close: protectedProcedure
    .input(z.object({ shiftId: z.number().int().positive(), closingCash: z.number().int().nonnegative() }))
    .output(shiftSchema)
    .mutation(async ({ ctx, input }) => {
      const shift = await db.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.id, input.shiftId), eq(cashierShifts.status, "open")) });
      if (!shift) throw new Error("Open shift not found");
      const assignment = await requireStaff(ctx.user.id, shift.branch_id, "shift:own");
      if (shift.cashier_user_id !== ctx.user.id) assertPermission(assignment.role, "shift:review");
      const summary = await summarizeShift(db, shift);
      const closed = await db.transaction(async (tx) => {
        const [updated] = await tx.update(cashierShifts).set({
          status: "closed",
          expected_cash: summary.expectedCash,
          closing_cash: input.closingCash,
          variance: input.closingCash - summary.expectedCash,
          closed_by: ctx.user.id,
          closed_at: new Date(),
        }).where(and(eq(cashierShifts.id, shift.id), eq(cashierShifts.status, "open"))).returning();
        if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Shift is already closed" });
        await tx.insert(auditLogs).values({
          branch_id: shift.branch_id, shift_id: shift.id, actor_user_id: ctx.user.id,
          action: "shift.close", entity_type: "cashier_shift", entity_id: String(shift.id),
          details: JSON.stringify({ expectedCash: summary.expectedCash, closingCash: input.closingCash, variance: input.closingCash - summary.expectedCash }),
        });
        return updated;
      });
      return { ...await hydrateShift(db, closed), summary };
    }),

  history: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .output(z.array(shiftSchema))
    .query(async ({ ctx, input }) => {
      const assignment = await requireStaff(ctx.user.id, input.branchId, "shift:own");
      const where = assignment.role === "cashier"
        ? and(eq(cashierShifts.branch_id, input.branchId), eq(cashierShifts.cashier_user_id, ctx.user.id))
        : eq(cashierShifts.branch_id, input.branchId);
      const shifts = await db.select().from(cashierShifts).where(where).orderBy(desc(cashierShifts.opened_at)).limit(30);
      return Promise.all(shifts.map((shift) => hydrateShift(db, shift)));
    }),
});
