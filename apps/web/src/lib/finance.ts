export const MAX_DISCOUNT_BASIS_POINTS = 5_000;

export type DiscountInput =
  | { type: "percentage"; value: number; reason: string }
  | { type: "fixed"; value: number; reason: string };

export function calculateDiscount(subtotal: number, discount?: DiscountInput | null) {
  if (!Number.isInteger(subtotal) || subtotal < 0) throw new Error("Invalid order subtotal");
  if (!discount) return 0;
  if (!discount.reason.trim()) throw new Error("Discount reason is required");
  if (!Number.isInteger(discount.value) || discount.value <= 0) throw new Error("Discount value must be positive");

  if (discount.type === "percentage") {
    if (discount.value > MAX_DISCOUNT_BASIS_POINTS) throw new Error("Percentage discount exceeds the maximum allowed");
    return Math.floor((subtotal * discount.value) / 10_000);
  }

  const maximumFixedDiscount = Math.floor(subtotal / 2);
  if (discount.value > maximumFixedDiscount) throw new Error("Fixed discount exceeds the maximum allowed");
  return discount.value;
}

export function calculateExpectedCash(input: {
  openingFloat: number;
  cashSales: number;
  cashRefunds: number;
  cashIn: number;
  cashOut: number;
}) {
  const expected = input.openingFloat + input.cashSales - input.cashRefunds + input.cashIn - input.cashOut;
  if (!Number.isInteger(expected)) throw new Error("Expected cash must use integer minor units");
  return expected;
}
