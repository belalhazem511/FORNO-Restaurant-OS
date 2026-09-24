import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, customers, menuItems, orderItemModifiers, orderItems, orders, orderStatusHistory, restaurantTables } from "@/lib/db/schema";
import { validateOrderFulfilment } from "@/lib/orders/lifecycle";
import { TRPCError } from "@trpc/server";
import { menuAvailability } from "@/lib/inventory/service";

type CreateOrderInput = {
  branchId: number;
  customerId?: number | null;
  orderType: "dine_in" | "takeaway" | "delivery";
  diningTableId?: number | null;
  deliveryAddress?: string | null;
  clientRequestId: string;
  items: Array<{
    menuItemId: number;
    variantId?: number | null;
    modifierOptionIds: number[];
    quantity: number;
    notes?: string;
  }>;
};

export async function createOrder(input: CreateOrderInput, userId: string) {
  const existing = await db.query.orders.findFirst({
    where: eq(orders.client_request_id, input.clientRequestId),
    with: { customer: { columns: { name: true } } },
  });
  if (existing) {
    if (existing.user_uid !== userId) throw new Error("Client request ID is already in use");
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
      where: and(eq(customers.id, input.customerId), eq(customers.user_uid, userId)),
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
    if (table.diningArea.branch_id !== input.branchId) throw new Error("Restaurant table does not belong to the order branch");
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
    if (uniqueOptionIds.some((id) => !allowedOptionIds.has(id))) throw new Error("Selected modifier does not belong to this menu item");

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
    const stockConfigurations = new Map<string, { menuItemId: number; variantId: number | null; modifierOptionIds: number[]; quantity: number }>();
    for (const item of preparedItems) {
      const modifierOptionIds = item.selectedModifiers.map((modifier) => modifier.id).sort((a, b) => a - b);
      const key = `${item.menuItemId}:${item.selectedVariantId ?? "base"}:${modifierOptionIds.join(",")}`;
      const existing = stockConfigurations.get(key);
      const quantity = (existing?.quantity ?? 0) + item.requestedItem.quantity;
      if (!Number.isSafeInteger(quantity) || quantity > 1_000_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Combined menu quantity is outside the supported range" });
      stockConfigurations.set(key, { menuItemId: item.menuItemId, variantId: item.selectedVariantId, modifierOptionIds, quantity });
    }
    const stockAvailability = await menuAvailability(tx, input.branchId, {
      configurations: [...stockConfigurations.values()],
    });
    for (const config of stockConfigurations.values()) {
      const requested = stockAvailability.find((row) => row.menuItemId === config.menuItemId
        && row.variantId === config.variantId
        && row.requestedQuantity === config.quantity
        && [...row.modifierOptionIds].sort((a, b) => a - b).join(",") === config.modifierOptionIds.join(","));
      if (!requested || !["available", "low_stock"].includes(requested.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: requested?.status === "recipe_missing" ? "Menu item has no active approved recipe" : "Insufficient recipe ingredients for this order" });
      }
    }
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
      user_uid: userId,
      status: "pending",
    }).onConflictDoNothing({ target: orders.client_request_id }).returning();

    if (!orderData) {
      const duplicate = await tx.query.orders.findFirst({
        where: and(eq(orders.client_request_id, input.clientRequestId), eq(orders.user_uid, userId)),
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
      changed_by: userId,
      note: "POS order created",
    });

    const customer = input.customerId ? await tx.query.customers.findFirst({
      where: eq(customers.id, input.customerId), columns: { name: true },
    }) : null;
    return { ...orderData, customer: customer ?? null };
  });
}
