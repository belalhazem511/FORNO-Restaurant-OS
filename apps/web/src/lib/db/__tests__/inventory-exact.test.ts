import { describe, expect, it } from "bun:test";
import { applyYieldLoss, convertScaledQuantity, costMinorForQuantity, movingWeightedAverage, multiplyDivide, parseDecimalToScaled, rational, roundHalfAwayFromZero } from "@/lib/inventory/exact";

describe("exact inventory quantities and costing", () => {
  it("converts mass, volume, count, and ingredient package quantities exactly", () => {
    expect(convertScaledQuantity({ quantityScaled: parseDecimalToScaled("1.25"), fromDimension: "mass", toDimension: "mass", factor: rational(1_000_000, 1) })).toBe(1_250_000_000);
    expect(convertScaledQuantity({ quantityScaled: parseDecimalToScaled("2.5"), fromDimension: "volume", toDimension: "volume", factor: rational(1_000, 1) })).toBe(2_500_000);
    expect(convertScaledQuantity({ quantityScaled: parseDecimalToScaled("3"), fromDimension: "count", toDimension: "count", factor: rational(1, 1) })).toBe(3_000);
    expect(convertScaledQuantity({ quantityScaled: parseDecimalToScaled("2"), fromDimension: "mass", toDimension: "mass", factor: rational(25_000_000, 1) })).toBe(50_000_000_000);
  });

  it("rejects incompatible dimensions, invalid factors, precision loss, and overflow", () => {
    expect(() => convertScaledQuantity({ quantityScaled: 1_000, fromDimension: "mass", toDimension: "volume", factor: rational(1, 1) })).toThrow("Cannot convert");
    expect(() => rational(0, 1)).toThrow("positive");
    expect(() => parseDecimalToScaled("1.0001")).toThrow("at most 3");
    expect(() => multiplyDivide(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow("exact integer range");
  });

  it("uses deterministic half-away-from-zero monetary and yield rounding", () => {
    expect(roundHalfAwayFromZero(5, 2)).toBe(3);
    expect(roundHalfAwayFromZero(-5, 2)).toBe(-3);
    expect(costMinorForQuantity(1_500, 1_000_000)).toBe(2);
    expect(applyYieldLoss(9_800, 200)).toBe(10_000);
  });

  it("calculates moving weighted-average unit cost without floating point", () => {
    expect(movingWeightedAverage({ existingQuantity: 10_000, existingUnitCostMicros: 2_000_000, addedQuantity: 5_000, addedUnitCostMicros: 5_000_000 })).toBe(3_000_000);
    expect(movingWeightedAverage({ existingQuantity: 0, existingUnitCostMicros: 0, addedQuantity: 7_000, addedUnitCostMicros: 1_234_567 })).toBe(1_234_567);
  });
});
