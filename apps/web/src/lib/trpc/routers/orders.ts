import { db } from "@/lib/db";
import { assertOrderTransition } from "@/lib/orders/lifecycle";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  customers,
  orders,
  orderStatusHistory,
  restaurantTables,
  cashierShifts,
  staffAssignments,
  syncDevices,
  type OrderStatus,
  type OrderType,
} from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { protectedProcedure, router } from "../init";
import { assertPermission, hasPermission } from "@/lib/permissions";
import { issueOrderInventory } from "@/lib/inventory/service";
import { createOrder } from "./orders/create";
import { executeLocalCommand, ensureLocalGlobalMapping } from "@/lib/sync/local-command";

type SyncedOrderResult = Awaited<ReturnType<typeof createOrder>> & {
  syncReferences: {
    branchGlobalId: string;
    customerGlobalId: string | null;
    diningTableGlobalId: string | null;
    orderType: "dine_in" | "takeaway" | "delivery";
    deliveryAddress: string | null;
    clientRequestId: string;
    items: Array<{
      menuItemGlobalId: string;
      variantGlobalId: string | null;
      modifierOptionGlobalIds: string[];
      quantity: number;
      notes: string | null;
    }>;
    shiftGlobalId: string | null;
  };
};

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
      if (process.env.FORNO_DESKTOP_MODE !== "1") return createOrder(input, ctx.user.id);
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      if (!deviceId) throw new Error("The desktop device identity is unavailable.");
      return db.transaction(async (tx) => {
        const device = await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
        if (!device) throw new Error("The local synchronization identity is unavailable.");
        return executeLocalCommand<SyncedOrderResult>(tx, {
          actorId: ctx.user.id,
          domain: "orders",
          action: "create",
          entityType: "order",
          idempotencyKey: input.clientRequestId,
          localId: (result) => String(result.id),
          dependsOnGlobalIds: (result) => [result.syncReferences.branchGlobalId, result.syncReferences.customerGlobalId, result.syncReferences.diningTableGlobalId, result.syncReferences.shiftGlobalId, ...result.syncReferences.items.flatMap((item) => [item.menuItemGlobalId, item.variantGlobalId, ...item.modifierOptionGlobalIds])].filter((globalId): globalId is string => Boolean(globalId)),
          payload: (orderGlobalId, result) => ({ orderGlobalId, ...result.syncReferences }),
        }, async (transaction) => {
          const order = await createOrder(input, ctx.user.id, transaction);
          const branch = await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "branch", localId: input.branchId });
          const customer = input.customerId ? await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "customer", localId: input.customerId }) : null;
          const table = input.diningTableId ? await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "restaurant_table", localId: input.diningTableId }) : null;
          const items = await Promise.all(input.items.map(async (item) => {
            const menuItem = await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "menu_item", localId: item.menuItemId });
            const variant = item.variantId ? await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "menu_item_variant", localId: item.variantId }) : null;
            const modifiers = await Promise.all(item.modifierOptionIds.map((id) => ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "modifier_option", localId: id })));
            return { menuItemGlobalId: menuItem.global_id, variantGlobalId: variant?.global_id ?? null, modifierOptionGlobalIds: modifiers.map((mapping) => mapping.global_id), quantity: item.quantity, notes: item.notes ?? null };
          }));
          const shift = await transaction.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.branch_id, input.branchId), eq(cashierShifts.cashier_user_id, ctx.user.id), eq(cashierShifts.status, "open")) });
          const shiftMapping = shift ? await ensureLocalGlobalMapping(transaction, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "cashier_shift", localId: shift.id }) : null;
          return { ...order, syncReferences: { branchGlobalId: branch.global_id, customerGlobalId: customer?.global_id ?? null, diningTableGlobalId: table?.global_id ?? null, orderType: input.orderType, deliveryAddress: input.deliveryAddress ?? null, clientRequestId: input.clientRequestId, items, shiftGlobalId: shiftMapping?.global_id ?? null } };
        });
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
    .mutation(async ({ ctx, input }) => {
      const updateOrder = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
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
      };
      if (process.env.FORNO_DESKTOP_MODE !== "1") return db.transaction(updateOrder);
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      if (!deviceId) throw new Error("The desktop device identity is unavailable.");
      return db.transaction(async (tx) => {
        const device = await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
        if (!device) throw new Error("The local synchronization identity is unavailable.");
        const orderIdentity = await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "order", localId: input.id });
        return executeLocalCommand(tx, {
          actorId: ctx.user.id,
          domain: "orders",
          action: "update",
          entityType: "order",
          idempotencyKey: `order-update:${input.id}:${input.status ?? "unchanged"}:${input.note ?? ""}:${input.inventoryOverrideReason ?? ""}`,
          localId: (order) => String(order.id),
          dependsOnGlobalIds: () => [orderIdentity.global_id],
          payload: (orderGlobalId, order) => ({ orderGlobalId, status: order.status, note: input.note ?? null, inventoryOverrideReason: input.inventoryOverrideReason ?? null }),
        }, updateOrder);
      });
    }),

  transition: protectedProcedure
    .input(z.object({ id: z.number(), status: orderStatusSchema, note: z.string().max(500).optional(), inventoryOverrideReason: z.string().trim().min(3).max(500).optional() }))
    .output(orderWithCustomerSchema)
    .mutation(async ({ ctx, input }) => {
      const performTransition = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
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
      };
      if (process.env.FORNO_DESKTOP_MODE !== "1") return db.transaction(performTransition);
      const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID;
      if (!deviceId) throw new Error("The desktop device identity is unavailable.");
      return db.transaction(async (tx) => {
        const device = await tx.query.syncDevices.findFirst({ where: eq(syncDevices.id, deviceId) });
        if (!device) throw new Error("The local synchronization identity is unavailable.");
        await ensureLocalGlobalMapping(tx, { organizationId: device.organization_id, deviceId: device.id, branchId: device.branch_id, entityType: "order", localId: input.id });
        return executeLocalCommand(tx, {
          actorId: ctx.user.id,
          domain: "orders",
          action: "transition",
          entityType: "order",
          idempotencyKey: `order-transition:${input.id}:${input.status}:${input.note ?? ""}:${input.inventoryOverrideReason ?? ""}`,
          localId: (result) => String(result.id),
          payload: (orderGlobalId) => ({ orderGlobalId, status: input.status, note: input.note ?? null, inventoryOverrideReason: input.inventoryOverrideReason ?? null }),
        }, performTransition);
      });
    }),

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
