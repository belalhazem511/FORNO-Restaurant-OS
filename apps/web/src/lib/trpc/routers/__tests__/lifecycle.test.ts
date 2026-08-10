import { describe, expect, it } from "bun:test";
import { assertOrderTransition, canTransitionOrder, validateOrderFulfilment } from "@/lib/orders/lifecycle";

describe("order lifecycle", () => {
  it("supports the normal kitchen path", () => {
    expect(canTransitionOrder("pending", "confirmed", "dine_in")).toBe(true);
    expect(canTransitionOrder("confirmed", "preparing", "dine_in")).toBe(true);
    expect(canTransitionOrder("preparing", "ready", "dine_in")).toBe(true);
    expect(canTransitionOrder("ready", "served", "dine_in")).toBe(true);
    expect(canTransitionOrder("served", "completed", "dine_in")).toBe(true);
  });

  it("enforces fulfilment-specific completion states and terminal cancellation", () => {
    expect(() => assertOrderTransition("ready", "served", "takeaway")).toThrow();
    expect(canTransitionOrder("ready", "collected", "takeaway")).toBe(true);
    expect(canTransitionOrder("ready", "delivered", "delivery")).toBe(true);
    expect(canTransitionOrder("cancelled", "pending", "delivery")).toBe(false);
  });

  it("validates table and address requirements for every order type", () => {
    expect(() => validateOrderFulfilment({ orderType: "dine_in", diningTableId: 1 })).not.toThrow();
    expect(() => validateOrderFulfilment({ orderType: "dine_in" })).toThrow();
    expect(() => validateOrderFulfilment({ orderType: "takeaway" })).not.toThrow();
    expect(() => validateOrderFulfilment({ orderType: "takeaway", diningTableId: 1 })).toThrow();
    expect(() => validateOrderFulfilment({ orderType: "delivery", deliveryAddress: "New Cairo", customerId: 1 })).not.toThrow();
    expect(() => validateOrderFulfilment({ orderType: "delivery", deliveryAddress: "New Cairo" })).toThrow();
    expect(() => validateOrderFulfilment({ orderType: "delivery" })).toThrow();
  });
});
