import type { OrderType, PrintDocumentType, PrintLanguage, PrintPaperWidth } from "@/lib/db/schema";

export type LocalizedText = { en: string; ar: string };

export type PrintableModifier = LocalizedText & { priceDelta: number };

export type PrintableItem = LocalizedText & {
  quantity: number;
  unitPrice: number;
  variant: LocalizedText | null;
  modifiers: PrintableModifier[];
  notes: string | null;
  station: LocalizedText & { code: string };
};

export type PrintablePayment = {
  method: string;
  kind: "payment" | "refund";
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
};

export type ReceiptState = "paid" | "unpaid" | "refunded" | "reversed";

export type TrustedPrintDocument = {
  job: {
    number: string;
    documentType: PrintDocumentType;
    status: "requested" | "previewed" | "acknowledged" | "failed" | "cancelled";
    isReprint: boolean;
    copyCount: number;
    paperWidth: PrintPaperWidth;
    language: PrintLanguage;
    requestedAt: Date;
  };
  restaurant: {
    name: LocalizedText;
    branch: LocalizedText;
    address: LocalizedText;
    phone: string | null;
  };
  order: {
    number: string;
    createdAt: Date;
    type: OrderType;
    area: LocalizedText | null;
    table: LocalizedText | null;
    customerName: string | null;
    customerPhone: string | null;
    deliveryAddress: string | null;
  };
  operator: {
    cashier: string | null;
    register: LocalizedText | null;
    shiftNumber: string | null;
  };
  station: LocalizedText & { code: string } | null;
  items: PrintableItem[];
  financial: null | {
    state: ReceiptState;
    receiptNumber: string;
    offlineReceiptReference: string | null;
    subtotal: number;
    discount: number;
    discountReason: string | null;
    total: number;
    payments: PrintablePayment[];
    cashReceived: number;
    change: number;
    reversalReason: string | null;
    reversedAt: Date | null;
    transactionAt: Date | null;
  };
};

export function calculatePrintableLineTotal(item: Pick<PrintableItem, "quantity" | "unitPrice" | "modifiers">) {
  return (item.unitPrice + item.modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0)) * item.quantity;
}

export function paymentBreakdown(payments: PrintablePayment[]) {
  return payments.reduce<Record<string, { paid: number; refunded: number }>>((result, payment) => {
    const current = result[payment.method] ?? { paid: 0, refunded: 0 };
    if (payment.kind === "payment") current.paid += payment.amount;
    else current.refunded += payment.amount;
    result[payment.method] = current;
    return result;
  }, {});
}

export function classifyReceiptState(input: { paymentStatus: "unpaid" | "paid" | "refunded"; wasPaidCancellation: boolean }): ReceiptState {
  if (input.paymentStatus === "paid") return "paid";
  if (input.paymentStatus === "refunded") return input.wasPaidCancellation ? "reversed" : "refunded";
  return "unpaid";
}

export function itemsForStation(items: PrintableItem[], stationCode: string) {
  return items.filter((item) => item.station.code === stationCode);
}

export function assertKotContainsNoFinancialData(document: TrustedPrintDocument) {
  if (document.job.documentType !== "kot") return;
  if (document.financial !== null) throw new Error("KOT documents must not contain financial data");
}
