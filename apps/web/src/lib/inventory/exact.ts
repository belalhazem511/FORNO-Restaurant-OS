export const QUANTITY_SCALE = 1_000;
export const MONEY_MICRO_SCALE = 1_000_000;
export const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

export type Dimension = "mass" | "volume" | "count";
export type Rational = { numerator: number; denominator: number };

function exact(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds the exact integer range`);
  return value;
}

export function gcd(a: number, b: number) {
  let left = Math.abs(exact(a, "gcd value"));
  let right = Math.abs(exact(b, "gcd value"));
  while (right !== 0) [left, right] = [right, left % right];
  return left || 1;
}

export function rational(numerator: number, denominator: number): Rational {
  exact(numerator, "conversion numerator");
  exact(denominator, "conversion denominator");
  if (numerator <= 0 || denominator <= 0) throw new Error("Conversion factors must be positive");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function roundHalfAwayFromZero(numerator: number, denominator: number) {
  exact(numerator, "rounding numerator");
  exact(denominator, "rounding denominator");
  if (denominator <= 0) throw new Error("Rounding denominator must be positive");
  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  return exact(sign * Math.floor((absolute + Math.floor(denominator / 2)) / denominator), "rounded value");
}

export function multiplyDivide(value: number, numerator: number, denominator: number) {
  exact(value, "quantity");
  const factor = rational(numerator, denominator);
  const divisor = gcd(Math.abs(value), factor.denominator);
  const reducedValue = value / divisor;
  const reducedDenominator = factor.denominator / divisor;
  return roundHalfAwayFromZero(exact(reducedValue * factor.numerator, "converted quantity"), reducedDenominator);
}

export function multiplyDivideFactors(value: number, numerators: number[], denominators: number[]) {
  exact(value, "quantity");
  let top = [value, ...numerators].map((part) => exact(part, "multiplication factor"));
  let bottom = denominators.map((part) => exact(part, "division factor"));
  if (bottom.some((part) => part <= 0)) throw new Error("Division factors must be positive");
  for (let i = 0; i < top.length; i++) for (let j = 0; j < bottom.length; j++) {
    const divisor = gcd(Math.abs(top[i]), bottom[j]);
    top[i] /= divisor;
    bottom[j] /= divisor;
  }
  const numerator = top.reduce((product, part) => exact(product * part, "rational product"), 1);
  const denominator = bottom.reduce((product, part) => exact(product * part, "rational divisor"), 1);
  return roundHalfAwayFromZero(numerator, denominator);
}

export function convertScaledQuantity(input: {
  quantityScaled: number;
  fromDimension: Dimension;
  toDimension: Dimension;
  factor: Rational;
}) {
  if (input.fromDimension !== input.toDimension) throw new Error(`Cannot convert ${input.fromDimension} to ${input.toDimension}`);
  return multiplyDivide(input.quantityScaled, input.factor.numerator, input.factor.denominator);
}

export function costMicrosForQuantity(quantityBase: number, unitCostMicros: number) {
  if (quantityBase < 0 || unitCostMicros < 0) throw new Error("Quantity and unit cost must be non-negative");
  return multiplyDivide(quantityBase, unitCostMicros, QUANTITY_SCALE);
}

export function costMinorForQuantity(quantityBase: number, unitCostMicros: number) {
  return roundHalfAwayFromZero(costMicrosForQuantity(quantityBase, unitCostMicros), MONEY_MICRO_SCALE);
}

export function movingWeightedAverage(input: {
  existingQuantity: number;
  existingUnitCostMicros: number;
  addedQuantity: number;
  addedUnitCostMicros: number;
}) {
  const { existingQuantity, existingUnitCostMicros, addedQuantity, addedUnitCostMicros } = input;
  for (const [label, value] of Object.entries(input)) {
    exact(value, label);
    if (value < 0) throw new Error(`${label} must be non-negative`);
  }
  const totalQuantity = exact(existingQuantity + addedQuantity, "weighted quantity");
  if (totalQuantity === 0) return 0;
  const oldValue = exact(existingQuantity * existingUnitCostMicros, "existing inventory value");
  const addedValue = exact(addedQuantity * addedUnitCostMicros, "added inventory value");
  return roundHalfAwayFromZero(exact(oldValue + addedValue, "weighted inventory value"), totalQuantity);
}

export function applyYieldLoss(quantityBase: number, yieldLossBps: number) {
  if (!Number.isSafeInteger(yieldLossBps) || yieldLossBps < 0 || yieldLossBps >= 10_000) throw new Error("Yield loss must be between 0 and 9,999 basis points");
  return multiplyDivide(quantityBase, 10_000, 10_000 - yieldLossBps);
}

export function parseDecimalToScaled(value: string, scale = QUANTITY_SCALE) {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("Enter a positive decimal quantity");
  const [whole, fraction = ""] = value.trim().split(".");
  const digits = String(scale).length - 1;
  if (fraction.length > digits) throw new Error(`Use at most ${digits} decimal places`);
  return exact(Number(whole) * scale + Number(fraction.padEnd(digits, "0")), "parsed quantity");
}
