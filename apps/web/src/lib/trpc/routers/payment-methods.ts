import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { db } from "@/lib/db";
import { paymentMethods } from "@/lib/db/schema";

const paymentMethodSchema = z.object({
  id: z.number(),
  code: z.string().nullable(),
  name: z.string(),
  affects_drawer: z.boolean(),
  is_active: z.boolean(),
  created_at: z.date().nullable(),
});

export const paymentMethodsRouter = router({
  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/payment-methods", tags: ["Payment Methods"], summary: "List all payment methods" } })
    .input(z.void())
    .output(z.array(paymentMethodSchema))
    .query(async () => {
      return db.select().from(paymentMethods);
    }),

  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/payment-methods", tags: ["Payment Methods"], summary: "Create a payment method" } })
    .input(z.object({ name: z.string().min(1) }))
    .output(paymentMethodSchema)
    .mutation(async () => {
      throw new Error("Payment methods are system-managed financial configuration");
    }),

  update: protectedProcedure
    .meta({ openapi: { method: "PATCH", path: "/payment-methods/{id}", tags: ["Payment Methods"], summary: "Update a payment method" } })
    .input(z.object({ id: z.number(), name: z.string().min(1) }))
    .output(paymentMethodSchema)
    .mutation(async () => {
      throw new Error("Payment methods referenced by financial records are immutable");
    }),

  delete: protectedProcedure
    .meta({ openapi: { method: "DELETE", path: "/payment-methods/{id}", tags: ["Payment Methods"], summary: "Delete a payment method" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async () => {
      throw new Error("Payment methods referenced by financial records cannot be deleted");
    }),
});
