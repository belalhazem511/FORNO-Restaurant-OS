import { describe, expect, it } from "bun:test";
import {
  addCartLine,
  calculateCartTotal,
  calculateLineTotal,
  calculateUnitPrice,
  createCartLine,
  createCartLineKey,
  replaceCartLine,
  setCartLineQuantity,
} from "@/lib/pos/cart";

const baseLine = (overrides: Partial<Parameters<typeof createCartLine>[0]> = {}) => ({
  menuItemId: 1,
  productId: 1,
  nameEn: "Margherita",
  nameAr: "مارجريتا",
  variantId: 10,
  variantNameEn: "Large",
  variantNameAr: "كبير",
  basePrice: 15000,
  modifiers: [{ id: 100, groupId: 20, nameEn: "Olives", nameAr: "زيتون", priceDelta: 1000 }],
  quantity: 1,
  notes: "",
  ...overrides,
});

describe("POS cart identity and quantities", () => {
  it("uses menu item, variant, sorted modifiers and normalized notes as line identity", () => {
    const first = baseLine({ modifiers: [
      { id: 101, groupId: 21, nameEn: "Cheddar", nameAr: "شيدر", priceDelta: 2000 },
      { id: 100, groupId: 20, nameEn: "Olives", nameAr: "زيتون", priceDelta: 1000 },
    ], notes: "  no onions  " });
    const reordered = baseLine({ modifiers: [...first.modifiers].reverse(), notes: "no onions" });
    expect(createCartLineKey(first)).toBe(createCartLineKey(reordered));
    expect(createCartLineKey(first)).not.toBe(createCartLineKey(baseLine({ variantId: 11, notes: "no onions" })));
    expect(createCartLineKey(first)).not.toBe(createCartLineKey(baseLine({ notes: "extra onions" })));
  });

  it("merges identical configurations and keeps different configurations separate", () => {
    const first = createCartLine(baseLine({ quantity: 2 }));
    const merged = addCartLine([first], baseLine({ quantity: 3 }));
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe(5);

    const separate = addCartLine(merged, baseLine({ notes: "well done" }));
    expect(separate).toHaveLength(2);
  });

  it("updates quantities, removes at zero, and merges after editing into an existing identity", () => {
    const plain = createCartLine(baseLine());
    const noted = createCartLine(baseLine({ notes: "well done", quantity: 2 }));
    expect(setCartLineQuantity([plain, noted], plain.key, 4).find((line) => line.key === plain.key)?.quantity).toBe(4);
    expect(setCartLineQuantity([plain, noted], plain.key, 0)).toEqual([noted]);

    const edited = replaceCartLine([plain, noted], noted.key, baseLine({ quantity: 2 }));
    expect(edited).toHaveLength(1);
    expect(edited[0].quantity).toBe(3);
  });
});

describe("POS cart pricing", () => {
  it("calculates unit, line, and cart totals in integer minor units", () => {
    const pizza = createCartLine(baseLine({ quantity: 2 }));
    const drink = createCartLine(baseLine({
      menuItemId: 2, variantId: null, variantNameEn: null, variantNameAr: null,
      basePrice: 3500, modifiers: [], quantity: 3,
    }));
    expect(calculateUnitPrice(pizza)).toBe(16000);
    expect(calculateLineTotal(pizza)).toBe(32000);
    expect(calculateCartTotal([pizza, drink])).toBe(42500);
  });
});
