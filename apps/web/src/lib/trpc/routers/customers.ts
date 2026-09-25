import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { executeLocalCommand } from "@/lib/sync/local-command";

const customerSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.string().nullable(),
  user_uid: z.string(),
  created_at: z.date().nullable(),
});

export const customersRouter = router({
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/customers", tags: ["Customers"], summary: "List all customers" } })
    .input(z.void())
    .output(z.array(customerSchema))
    .query(async ({ ctx }) => {
      return db.select().from(customers).where(eq(customers.user_uid, ctx.user.id));
    }),

  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/customers", tags: ["Customers"], summary: "Create a customer" } })
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      })
    )
    .output(customerSchema)
    .mutation(async ({ ctx, input }) => {
      if (process.env.FORNO_DESKTOP_MODE !== "1") {
        const [data] = await db.insert(customers).values({ ...input, user_uid: ctx.user.id }).returning();
        return data;
      }
      return db.transaction(async (tx) => {
        return executeLocalCommand(tx, {
          actorId: ctx.user.id,
          domain: "customers",
          action: "create",
          entityType: "customer",
          localId: (customer) => String(customer.id),
          payload: (customerGlobalId, customer) => ({ customerGlobalId, values: { name: customer.name, email: customer.email, phone: customer.phone, status: customer.status } }),
        }, async (transaction) => {
          const [created] = await transaction.insert(customers).values({ ...input, user_uid: ctx.user.id }).returning();
          return created!;
        });
      });
    }),

  update: protectedProcedure
    .meta({ openapi: { method: "PATCH", path: "/customers/{id}", tags: ["Customers"], summary: "Update a customer" } })
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      })
    )
    .output(customerSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      if (process.env.FORNO_DESKTOP_MODE === "1") {
        return db.transaction(async (tx) => executeLocalCommand(tx, {
          actorId: ctx.user.id,
          domain: "customers",
          action: "update",
          entityType: "customer",
          localId: (customer) => customer ? String(customer.id) : null,
          payload: (customerGlobalId, customer) => ({ customerGlobalId, values: { name: customer.name, email: customer.email, phone: customer.phone, status: customer.status } }),
        }, async (transaction) => {
          const [updated] = await transaction.update(customers)
            .set({ ...data, user_uid: ctx.user.id })
            .where(and(eq(customers.id, id), eq(customers.user_uid, ctx.user.id)))
            .returning();
          return updated;
        }));
      }
      const [updated] = await db
        .update(customers)
        .set({ ...data, user_uid: ctx.user.id })
        .where(and(eq(customers.id, id), eq(customers.user_uid, ctx.user.id)))
        .returning();
      return updated;
    }),

  delete: protectedProcedure
    .meta({ openapi: { method: "DELETE", path: "/customers/{id}", tags: ["Customers"], summary: "Delete a customer" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (process.env.FORNO_DESKTOP_MODE === "1") {
        return db.transaction(async (tx) => executeLocalCommand(tx, {
          actorId: ctx.user.id,
          domain: "customers",
          action: "delete",
          entityType: "customer",
          localId: (deleted) => deleted ? String(input.id) : null,
          payload: (customerGlobalId) => ({ customerGlobalId }),
        }, async (transaction) => {
          const deleted = await transaction.delete(customers)
            .where(and(eq(customers.id, input.id), eq(customers.user_uid, ctx.user.id)))
            .returning({ id: customers.id });
          return { success: true, deleted: deleted.length > 0 };
        }));
      }
      await db
        .delete(customers)
        .where(and(eq(customers.id, input.id), eq(customers.user_uid, ctx.user.id)));
      return { success: true };
    }),
});
