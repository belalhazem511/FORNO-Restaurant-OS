import type { OrderStatus, OrderType } from "@forno/db/schema";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["confirmed", "completed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "collected", "delivered", "completed", "cancelled"],
  served: ["completed", "cancelled"],
  collected: ["completed", "cancelled"],
  delivered: ["completed", "cancelled"],
  completed: ["cancelled"],
  cancelled: [],
};

const FULFILMENT_STATUS: Record<OrderType, OrderStatus> = {
  dine_in: "served",
  takeaway: "collected",
  delivery: "delivered",
};

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
  orderType: OrderType,
): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  if (["served", "collected", "delivered"].includes(to)) {
    return FULFILMENT_STATUS[orderType] === to;
  }
  return true;
}

export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus,
  orderType: OrderType,
): void {
  if (!canTransitionOrder(from, to, orderType)) {
    throw new Error(`Invalid ${orderType} order transition: ${from} -> ${to}`);
  }
}

export function validateOrderFulfilment(input: {
  orderType: OrderType;
  diningTableId?: number | null;
  deliveryAddress?: string | null;
  customerId?: number | null;
}): void {
  const hasTable = input.diningTableId != null;
  const hasAddress = Boolean(input.deliveryAddress?.trim());

  if (input.orderType === "dine_in" && (!hasTable || hasAddress)) {
    throw new Error("Dine-in orders require a table and cannot have a delivery address");
  }
  if (input.orderType === "takeaway" && (hasTable || hasAddress)) {
    throw new Error("Takeaway orders cannot have a table or delivery address");
  }
  if (input.orderType === "delivery" && (hasTable || !hasAddress)) {
    throw new Error("Delivery orders require an address and cannot have a table");
  }
  if (input.orderType === "delivery" && input.customerId == null) {
    throw new Error("Delivery orders require customer information");
  }
}
