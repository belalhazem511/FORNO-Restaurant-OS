import { db } from "@/lib/db";
import { assertOrderTransition, validateOrderFulfilment } from "@/lib/orders/lifecycle";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  branches,
  customers,
  orderItems,
  orders,
  orderStatusHistory,
  restaurantTables,
  transactions,
  type OrderStatus,
  type OrderType,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";

const orderTypeSchema = z.enum(ORDER_TYPES);
const orderStatusSchema = z.enum(ORDER_STATUSES);

const orderBaseSchema = z.object({
  id: z.number(),
  branch_id: z.number().nullable(),
  customer_id: z.number().nullable(),
  dining_table_id: z.number().nullable(),
  client_request_id: z.string().nullable(),
  order_type: orderTypeSchema,
  total_amount: z.number(),
  delivery_address: z.string().nullable(),
  status: orderStatusSchema,
  user_uid: z.string(),
  created_at: z.date().nullable(),
  updated_at: z.date(),
});

const orderWithCustomerSchema = orderBaseSchema.extend({
  customer: z.object({ name: z.string() }).nullable(),
});

const orderDetailSchema = orderWithCustomerSchema.extend({
  orderItems: z.array(z.object({
    id: z.number(),
    product_id: z.number().nullable(),
    menu_item_id: z.number().nullable(),
    variant_id: z.number().nullable(),
    quantity: z.number(),
    price: z.number(),
    notes: z.string().nullable(),
    product: z.object({ name: z.string(), category: z.string().nullable() }).nullable(),
  })),
  statusHistory: z.array(z.object({
    id: z.number(),
    from_status: z.string().nullable(),
    to_status: z.string(),
    changed_by: z.string(),
    note: z.string().nullable(),
    created_at: z.date(),
  })),
});

async function defaultBranchId(): Promise<number | null> {
  const branch = await db.query.branches.findFirst({
    where: eq(branches.is_active, true),
    columns: { id: true },
  });
  return branch?.id ?? null;
}

export const ordersRouter = router({
  get: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/orders/{id}", tags: ["Orders"], summary: "Get order details" } })
    .input(z.object({ id: z.number() }))
    .output(orderDetailSchema.nullable())
    .query(async ({ ctx, input }) => {
      const result = await db.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)),
        with: {
          customer: { columns: { name: true } },
          orderItems: { with: { product: { columns: { name: true, category: true } } } },
          statusHistory: true,
        },
      });
      return result ?? null;
    }),

  list: protectedProcedure
    .meta({ openapi: { method: "GET", path: "/orders", tags: ["Orders"], summary: "List all orders" } })
    .input(z.void())
    .output(z.array(orderWithCustomerSchema))
    .query(async ({ ctx }) => db.query.orders.findMany({
      where: eq(orders.user_uid, ctx.user.id),
      with: { customer: { columns: { name: true } } },
    })),

  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: "/orders", tags: ["Orders"], summary: "Create a paid order with items" } })
    .input(z.object({
      branchId: z.number().int().positive().optional(),
      customerId: z.number().int().positive(),
      paymentMethodId: z.number().int().positive(),
      orderType: orderTypeSchema.default("takeaway"),
      diningTableId: z.number().int().positive().nullable().optional(),
      deliveryAddress: z.string().trim().min(1).nullable().optional(),
      clientRequestId: z.string().trim().min(1).max(80).optional(),
      products: z.array(z.object({
        id: z.number(),
        quantity: z.number().int().positive(),
        price: z.number().int().nonnegative(),
      })).min(1),
      total: z.number().int().nonnegative(),
    }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => {
      validateOrderFulfilment({
        orderType: input.orderType,
        diningTableId: input.diningTableId,
        deliveryAddress: input.deliveryAddress,
      });
      const branchId = input.branchId ?? await defaultBranchId();
      if (input.diningTableId) {
        const table = await db.query.restaurantTables.findFirst({
          where: eq(restaurantTables.id, input.diningTableId),
          with: { diningArea: { columns: { branch_id: true } } },
        });
        if (!table) throw new Error("Restaurant table not found");
        if (branchId != null && table.diningArea.branch_id !== branchId) {
          throw new Error("Restaurant table does not belong to the order branch");
        }
      }

      return db.transaction(async (tx) => {
        const [orderData] = await tx.insert(orders).values({
          branch_id: branchId,
          customer_id: input.customerId,
          dining_table_id: input.diningTableId ?? null,
          client_request_id: input.clientRequestId,
          order_type: input.orderType,
          total_amount: input.total,
          delivery_address: input.deliveryAddress ?? null,
          user_uid: ctx.user.id,
          status: "completed",
        }).returning();

        await tx.insert(orderItems).values(input.products.map((product) => ({
          order_id: orderData.id,
          product_id: product.id,
          quantity: product.quantity,
          price: product.price,
        })));
        await tx.insert(orderStatusHistory).values({
          order_id: orderData.id,
          from_status: null,
          to_status: "completed",
          changed_by: ctx.user.id,
          note: "Paid POS order",
        });
        await tx.insert(transactions).values({
          order_id: orderData.id,
          payment_method_id: input.paymentMethodId,
          amount: input.total,
          user_uid: ctx.user.id,
          status: "completed",
          category: "selling",
          type: "income",
          description: `Payment for order #${orderData.id}`,
        });

        const customer = await tx.query.customers.findFirst({
          where: eq(customers.id, input.customerId),
          columns: { name: true },
        });
        return { ...orderData, customer: customer ?? null };
      });
    }),

  update: protectedProcedure
    .meta({ openapi: { method: "PATCH", path: "/orders/{id}", tags: ["Orders"], summary: "Update an order" } })
    .input(z.object({
      id: z.number(),
      total_amount: z.number().int().nonnegative().optional(),
      status: orderStatusSchema.optional(),
      note: z.string().max(500).optional(),
    }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)),
      });
      if (!current) throw new Error("Order not found");

      if (input.status && input.status !== current.status) {
        assertOrderTransition(current.status as OrderStatus, input.status, current.order_type as OrderType);
      }
      const [updated] = await tx.update(orders).set({
        total_amount: input.total_amount,
        status: input.status,
        updated_at: new Date(),
      }).where(and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id))).returning();

      if (input.status && input.status !== current.status) {
        await tx.insert(orderStatusHistory).values({
          order_id: input.id,
          from_status: current.status,
          to_status: input.status,
          changed_by: ctx.user.id,
          note: input.note,
        });
      }
      const customer = updated.customer_id
        ? await tx.query.customers.findFirst({ where: eq(customers.id, updated.customer_id), columns: { name: true } })
        : null;
      return { ...updated, customer: customer ?? null };
    })),

  transition: protectedProcedure
    .input(z.object({ id: z.number(), status: orderStatusSchema, note: z.string().max(500).optional() }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)),
      });
      if (!current) throw new Error("Order not found");
      assertOrderTransition(current.status as OrderStatus, input.status, current.order_type as OrderType);

      const [updated] = await tx.update(orders).set({ status: input.status, updated_at: new Date() })
        .where(eq(orders.id, input.id)).returning();
      await tx.insert(orderStatusHistory).values({
        order_id: input.id,
        from_status: current.status,
        to_status: input.status,
        changed_by: ctx.user.id,
        note: input.note,
      });
      const customer = updated.customer_id
        ? await tx.query.customers.findFirst({ where: eq(customers.id, updated.customer_id), columns: { name: true } })
        : null;
      return { ...updated, customer: customer ?? null };
    })),

  delete: protectedProcedure
    .meta({ openapi: { method: "DELETE", path: "/orders/{id}", tags: ["Orders"], summary: "Delete an order and its items" } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db.transaction(async (tx) => {
        await tx.delete(orderStatusHistory).where(eq(orderStatusHistory.order_id, input.id));
        await tx.delete(orderItems).where(eq(orderItems.order_id, input.id));
        await tx.delete(orders).where(and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)));
      });
      return { success: true };
    }),
});
