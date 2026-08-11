import { db } from "@/lib/db";
import { assertOrderTransition, validateOrderFulfilment } from "@/lib/orders/lifecycle";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  branches,
  customers,
  menuItems,
  orderItemModifiers,
  orderItems,
  orders,
  orderStatusHistory,
  restaurantTables,
  staffAssignments,
  type OrderStatus,
  type OrderType,
} from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { assertPermission, hasPermission } from "@/lib/permissions";
import { issueOrderInventory } from "@/lib/inventory/service";

const orderTypeSchema = z.enum(ORDER_TYPES);
const orderStatusSchema = z.enum(ORDER_STATUSES);

const orderBaseSchema = z.object({
  id: z.number(),
  branch_id: z.number().nullable(),
  customer_id: z.number().nullable(),
  dining_table_id: z.number().nullable(),
  client_request_id: z.string().nullable(),
  offline_receipt_reference: z.string().nullable(),
  order_type: orderTypeSchema,
  subtotal_amount: z.number(),
  discount_type: z.string().nullable(),
  discount_value: z.number(),
  discount_amount: z.number(),
  discount_reason: z.string().nullable(),
  total_amount: z.number(),
  payment_status: z.enum(["unpaid", "paid", "refunded"]),
  paid_at: z.date().nullable(),
  inventory_issued_at: z.date().nullable(),
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
    menuItem: z.object({ name_en: z.string(), name_ar: z.string() }).nullable(),
    variant: z.object({ name_en: z.string(), name_ar: z.string() }).nullable(),
    modifiers: z.array(z.object({
      id: z.number(),
      modifier_option_id: z.number(),
      name_en: z.string(),
      name_ar: z.string(),
      price_delta: z.number(),
    })),
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
          orderItems: { with: {
            product: { columns: { name: true, category: true } },
            menuItem: { columns: { name_en: true, name_ar: true } },
            variant: { columns: { name_en: true, name_ar: true } },
            modifiers: true,
          } },
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
    .meta({ openapi: { method: "POST", path: "/orders", tags: ["Orders"], summary: "Create a POS order" } })
    .input(z.object({
      branchId: z.number().int().positive(),
      customerId: z.number().int().positive().nullable().optional(),
      orderType: orderTypeSchema.default("takeaway"),
      diningTableId: z.number().int().positive().nullable().optional(),
      deliveryAddress: z.string().trim().min(1).nullable().optional(),
      clientRequestId: z.string().trim().min(8).max(80),
      items: z.array(z.object({
        menuItemId: z.number().int().positive(),
        variantId: z.number().int().positive().nullable().optional(),
        modifierOptionIds: z.array(z.number().int().positive()).default([]),
        quantity: z.number().int().positive(),
        notes: z.string().trim().max(500).optional(),
      })).min(1),
    }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.orders.findFirst({
        where: eq(orders.client_request_id, input.clientRequestId),
        with: { customer: { columns: { name: true } } },
      });
      if (existing) {
        if (existing.user_uid !== ctx.user.id) throw new Error("Client request ID is already in use");
        return existing;
      }

      validateOrderFulfilment({
        orderType: input.orderType,
        diningTableId: input.diningTableId,
        deliveryAddress: input.deliveryAddress,
        customerId: input.customerId,
      });
      const branch = await db.query.branches.findFirst({
        where: and(eq(branches.id, input.branchId), eq(branches.is_active, true)),
      });
      if (!branch) throw new Error("Active restaurant branch not found");

      if (input.customerId) {
        const customer = await db.query.customers.findFirst({
          where: and(eq(customers.id, input.customerId), eq(customers.user_uid, ctx.user.id)),
        });
        if (!customer) throw new Error("Customer not found");
      }

      if (input.diningTableId) {
        const table = await db.query.restaurantTables.findFirst({
          where: eq(restaurantTables.id, input.diningTableId),
          with: { diningArea: { columns: { branch_id: true } } },
        });
        if (!table) throw new Error("Restaurant table not found");
        if (!table.is_active || table.status !== "available") throw new Error("Restaurant table is not available");
        if (table.diningArea.branch_id !== input.branchId) {
          throw new Error("Restaurant table does not belong to the order branch");
        }
      }

      const preparedItems: Array<{
        requestedItem: (typeof input.items)[number];
        menuItemId: number;
        productId: number | null;
        selectedVariantId: number | null;
        selectedModifiers: Array<{ id: number; name_en: string; name_ar: string; price_delta: number }>;
        basePrice: number;
        modifierTotal: number;
      }> = [];
      for (const requestedItem of input.items) {
        const menuItem = await db.query.menuItems.findFirst({
          where: eq(menuItems.id, requestedItem.menuItemId),
          with: {
            category: true,
            kitchenStation: true,
            variants: true,
            modifierGroups: { with: { modifierGroup: { with: { options: true } } } },
          },
        });
        if (!menuItem || menuItem.category.branch_id !== input.branchId) throw new Error("Menu item not found in this branch");
        if (!menuItem.is_available || !menuItem.category.is_active || !menuItem.kitchenStation.is_active) {
          throw new Error(`Menu item ${menuItem.code} is unavailable`);
        }

        const availableVariants = menuItem.variants.filter((variant) => variant.is_available);
        let selectedVariant = requestedItem.variantId
          ? availableVariants.find((variant) => variant.id === requestedItem.variantId) ?? null
          : null;
        if (requestedItem.variantId && !selectedVariant) throw new Error("Selected variant does not belong to this menu item");
        if (!selectedVariant && availableVariants.length === 1) selectedVariant = availableVariants[0];
        if (!selectedVariant && availableVariants.length > 1) throw new Error("A variant selection is required");

        const uniqueOptionIds = [...new Set(requestedItem.modifierOptionIds)];
        if (uniqueOptionIds.length !== requestedItem.modifierOptionIds.length) throw new Error("Duplicate modifier options are not allowed");
        const selectedModifiers: Array<{ id: number; name_en: string; name_ar: string; price_delta: number }> = [];
        const allowedOptionIds = new Set<number>();
        for (const link of menuItem.modifierGroups) {
          const group = link.modifierGroup;
          if (!group.is_active) continue;
          const availableOptions = group.options.filter((option) => option.is_available);
          for (const option of availableOptions) allowedOptionIds.add(option.id);
          const selected = availableOptions.filter((option) => uniqueOptionIds.includes(option.id));
          if (selected.length < group.min_selections || selected.length > group.max_selections) {
            throw new Error(`Modifier group ${group.code} requires ${group.min_selections}-${group.max_selections} selections`);
          }
          selectedModifiers.push(...selected.map((option) => ({
            id: option.id,
            name_en: option.name_en,
            name_ar: option.name_ar,
            price_delta: option.price_delta,
          })));
        }
        if (uniqueOptionIds.some((id) => !allowedOptionIds.has(id))) {
          throw new Error("Selected modifier does not belong to this menu item");
        }

        const basePrice = selectedVariant?.price ?? menuItem.base_price;
        const modifierTotal = selectedModifiers.reduce((sum, modifier) => sum + modifier.price_delta, 0);
        preparedItems.push({
          requestedItem,
          menuItemId: menuItem.id,
          productId: menuItem.product_id,
          selectedVariantId: selectedVariant?.id ?? null,
          selectedModifiers,
          basePrice,
          modifierTotal,
        });
      }
      const totalAmount = preparedItems.reduce(
        (sum, item) => sum + (item.basePrice + item.modifierTotal) * item.requestedItem.quantity,
        0,
      );

      return db.transaction(async (tx) => {
        const [orderData] = await tx.insert(orders).values({
          branch_id: input.branchId,
          customer_id: input.customerId ?? null,
          dining_table_id: input.diningTableId ?? null,
          client_request_id: input.clientRequestId,
          order_type: input.orderType,
          subtotal_amount: totalAmount,
          discount_value: 0,
          discount_amount: 0,
          total_amount: totalAmount,
          payment_status: "unpaid",
          delivery_address: input.deliveryAddress ?? null,
          user_uid: ctx.user.id,
          status: "pending",
        }).onConflictDoNothing({ target: orders.client_request_id }).returning();

        if (!orderData) {
          const duplicate = await tx.query.orders.findFirst({
            where: and(eq(orders.client_request_id, input.clientRequestId), eq(orders.user_uid, ctx.user.id)),
            with: { customer: { columns: { name: true } } },
          });
          if (!duplicate) throw new Error("Client request ID is already in use");
          return duplicate;
        }

        if (input.diningTableId) {
          const [claimedTable] = await tx.update(restaurantTables).set({ status: "occupied" })
            .where(and(
              eq(restaurantTables.id, input.diningTableId),
              eq(restaurantTables.status, "available"),
              eq(restaurantTables.is_active, true),
            )).returning({ id: restaurantTables.id });
          if (!claimedTable) throw new Error("Restaurant table is no longer available");
        }

        for (const item of preparedItems) {
          const [createdItem] = await tx.insert(orderItems).values({
            order_id: orderData.id,
            product_id: item.productId,
            menu_item_id: item.menuItemId,
            variant_id: item.selectedVariantId,
            quantity: item.requestedItem.quantity,
            price: item.basePrice,
            notes: item.requestedItem.notes || null,
          }).returning();
          if (item.selectedModifiers.length > 0) {
            await tx.insert(orderItemModifiers).values(item.selectedModifiers.map((modifier) => ({
              order_item_id: createdItem.id,
              modifier_option_id: modifier.id,
              name_en: modifier.name_en,
              name_ar: modifier.name_ar,
              price_delta: modifier.price_delta,
            })));
          }
        }
        await tx.insert(orderStatusHistory).values({
          order_id: orderData.id,
          from_status: null,
          to_status: "pending",
          changed_by: ctx.user.id,
          note: "POS order created",
        });

        const customer = input.customerId ? await tx.query.customers.findFirst({
          where: eq(customers.id, input.customerId), columns: { name: true },
        }) : null;
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
      inventoryOverrideReason: z.string().trim().min(3).max(500).optional(),
    }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)),
      });
      if (!current) throw new Error("Order not found");
      if (input.total_amount !== undefined) throw new Error("Order totals are server-calculated and cannot be edited");
      if (input.status === "cancelled") throw new Error("Use the audited cancellation workflow");

      if (input.status && input.status !== current.status) {
        assertOrderTransition(current.status as OrderStatus, input.status, current.order_type as OrderType);
        if (input.status === "confirmed") {
          const assignment = await tx.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.branch_id, current.branch_id!), eq(staffAssignments.is_active, true)) });
          if (!assignment) throw new Error("No active staff assignment for this branch");
          assertPermission(assignment.role, "order:create");
          if (input.inventoryOverrideReason && !hasPermission(assignment.role, "inventory:override")) throw new Error("Cashiers cannot override insufficient stock");
          await issueOrderInventory(tx, { orderId: current.id, actorUserId: ctx.user.id, idempotencyKey: `order-confirm:${current.id}`, allowNegative: Boolean(input.inventoryOverrideReason), overrideReason: input.inventoryOverrideReason });
        }
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
        if (["completed", "cancelled"].includes(input.status) && current.dining_table_id) {
          await tx.update(restaurantTables).set({ status: "available" })
            .where(eq(restaurantTables.id, current.dining_table_id));
        }
      }
      const customer = updated.customer_id
        ? await tx.query.customers.findFirst({ where: eq(customers.id, updated.customer_id), columns: { name: true } })
        : null;
      return { ...updated, customer: customer ?? null };
    })),

  transition: protectedProcedure
    .input(z.object({ id: z.number(), status: orderStatusSchema, note: z.string().max(500).optional(), inventoryOverrideReason: z.string().trim().min(3).max(500).optional() }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)),
      });
      if (!current) throw new Error("Order not found");
      if (input.status === "cancelled") throw new Error("Use the audited cancellation workflow");
      assertOrderTransition(current.status as OrderStatus, input.status, current.order_type as OrderType);
      if (input.status === "confirmed") {
        const assignment = await tx.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.branch_id, current.branch_id!), eq(staffAssignments.is_active, true)) });
        if (!assignment) throw new Error("No active staff assignment for this branch");
        assertPermission(assignment.role, "order:create");
        if (input.inventoryOverrideReason && !hasPermission(assignment.role, "inventory:override")) throw new Error("Cashiers cannot override insufficient stock");
        await issueOrderInventory(tx, { orderId: current.id, actorUserId: ctx.user.id, idempotencyKey: `order-confirm:${current.id}`, allowNegative: Boolean(input.inventoryOverrideReason), overrideReason: input.inventoryOverrideReason });
      }

      const [updated] = await tx.update(orders).set({ status: input.status, updated_at: new Date() })
        .where(eq(orders.id, input.id)).returning();
      await tx.insert(orderStatusHistory).values({
        order_id: input.id,
        from_status: current.status,
        to_status: input.status,
        changed_by: ctx.user.id,
        note: input.note,
      });
      if (["completed", "cancelled"].includes(input.status) && current.dining_table_id) {
        await tx.update(restaurantTables).set({ status: "available" })
          .where(eq(restaurantTables.id, current.dining_table_id));
      }
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
      const current = await db.query.orders.findFirst({ where: and(eq(orders.id, input.id), eq(orders.user_uid, ctx.user.id)) });
      if (!current) return { success: true };
      throw new Error("Orders are immutable financial documents; cancel the order instead");
    }),
});
