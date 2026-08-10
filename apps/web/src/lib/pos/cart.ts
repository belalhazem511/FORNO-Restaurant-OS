export interface CartModifier {
  id: number;
  groupId: number;
  nameEn: string;
  nameAr: string;
  priceDelta: number;
}

export interface CartLine {
  key: string;
  menuItemId: number;
  productId: number | null;
  nameEn: string;
  nameAr: string;
  variantId: number | null;
  variantNameEn: string | null;
  variantNameAr: string | null;
  basePrice: number;
  modifiers: CartModifier[];
  quantity: number;
  notes: string;
}

export type CartLineInput = Omit<CartLine, "key">;

function normalizeNotes(notes: string) {
  return notes.trim().replace(/\s+/g, " ");
}

export function createCartLineKey(input: Pick<CartLineInput, "menuItemId" | "variantId" | "modifiers" | "notes">) {
  const modifierIds = input.modifiers.map((modifier) => modifier.id).sort((a, b) => a - b);
  return `${input.menuItemId}:${input.variantId ?? "base"}:${modifierIds.join(",")}:${normalizeNotes(input.notes)}`;
}

export function createCartLine(input: CartLineInput): CartLine {
  return { ...input, notes: normalizeNotes(input.notes), key: createCartLineKey(input) };
}

export function calculateUnitPrice(line: Pick<CartLine, "basePrice" | "modifiers">) {
  return line.basePrice + line.modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0);
}

export function calculateLineTotal(line: CartLine) {
  return calculateUnitPrice(line) * line.quantity;
}

export function calculateCartTotal(lines: CartLine[]) {
  return lines.reduce((sum, line) => sum + calculateLineTotal(line), 0);
}

export function addCartLine(lines: CartLine[], input: CartLineInput) {
  const incoming = createCartLine(input);
  const existing = lines.find((line) => line.key === incoming.key);
  if (!existing) return [...lines, incoming];
  return lines.map((line) => line.key === incoming.key
    ? { ...line, quantity: line.quantity + incoming.quantity }
    : line);
}

export function replaceCartLine(lines: CartLine[], originalKey: string, input: CartLineInput) {
  return addCartLine(lines.filter((line) => line.key !== originalKey), input);
}

export function setCartLineQuantity(lines: CartLine[], key: string, quantity: number) {
  if (quantity <= 0) return lines.filter((line) => line.key !== key);
  return lines.map((line) => line.key === key ? { ...line, quantity } : line);
}
