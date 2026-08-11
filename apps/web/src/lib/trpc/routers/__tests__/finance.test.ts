import { describe, expect, it } from "bun:test";
import { calculateDiscount, calculateExpectedCash } from "@/lib/finance";
import { assertPermission, hasPermission } from "@/lib/permissions";

describe("financial calculations", () => {
  it("calculates expected drawer cash without card or Instapay values", () => {
    expect(calculateExpectedCash({ openingFloat: 5000, cashSales: 12000, cashRefunds: 2000, cashIn: 1000, cashOut: 500 })).toBe(15500);
  });

  it("calculates fixed minor-unit and percentage basis-point discounts", () => {
    expect(calculateDiscount(10000, { type: "fixed", value: 1500, reason: "Service recovery" })).toBe(1500);
    expect(calculateDiscount(9999, { type: "percentage", value: 1250, reason: "Promotion" })).toBe(1249);
  });

  it("enforces reasons and maximum discounts", () => {
    expect(() => calculateDiscount(10000, { type: "fixed", value: 6000, reason: "Too high" })).toThrow("maximum");
    expect(() => calculateDiscount(10000, { type: "percentage", value: 5001, reason: "Too high" })).toThrow("maximum");
    expect(() => calculateDiscount(10000, { type: "fixed", value: 100, reason: "" })).toThrow("reason");
  });
});

describe("role permissions", () => {
  it("allows managers restricted actions and denies cashier self-authorization", () => {
    expect(hasPermission("manager", "discount:apply")).toBe(true);
    expect(hasPermission("cashier", "checkout:create")).toBe(true);
    expect(() => assertPermission("cashier", "discount:apply")).toThrow("cannot perform");
    expect(() => assertPermission("cashier", "payment:refund")).toThrow("cannot perform");
  });
});
