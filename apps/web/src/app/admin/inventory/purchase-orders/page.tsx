"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { multiplyDivide, parseDecimalToScaled } from "@/lib/inventory/exact";
import { formatCurrency } from "@/lib/utils";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";

type DraftLine = {
  ingredientId: string;
  packageConversionId: string;
  quantity: string;
  unitPrice: string;
  notes: string;
};
const emptyLine = (): DraftLine => ({
  ingredientId: "",
  packageConversionId: "",
  quantity: "",
  unitPrice: "",
  notes: "",
});
const formatQuantity = (scaled: number) => {
  const whole = Math.floor(scaled / 1_000);
  const fraction = String(scaled % 1_000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
};

export default function PurchaseOrdersPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const ar = locale === "ar";
  const inventoryContext = useQuery(trpc.inventory.context.queryOptions());
  const branchId = inventoryContext.data?.branch.id ?? 0;
  const context = useQuery(trpc.procurement.context.queryOptions());
  const suppliers = useQuery({
    ...trpc.procurement.suppliers.queryOptions({ branchId }),
    enabled: branchId > 0,
  });
  const ingredients = useQuery({
    ...trpc.inventory.ingredients.queryOptions({
      branchId,
      includeArchived: false,
    }),
    enabled: branchId > 0,
  });
  const orders = useQuery({
    ...trpc.procurement.purchaseOrders.queryOptions({ branchId }),
    enabled: branchId > 0,
  });
  const [supplierId, setSupplierId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.procurement.purchaseOrders.queryOptions({ branchId }).queryKey,
    });
  };
  const create = useMutation(
    trpc.procurement.createPurchaseOrder.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تم إنشاء أمر الشراء" : "Purchase order created");
        setPoNumber("");
        setExpectedDate("");
        setNotes("");
        setLines([emptyLine()]);
        await invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const submit = useMutation(
    trpc.procurement.submitPurchaseOrder.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تم إرسال الأمر" : "Purchase order submitted");
        await invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const approve = useMutation(
    trpc.procurement.approvePurchaseOrder.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تم اعتماد الأمر" : "Purchase order approved");
        await invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const cancel = useMutation(
    trpc.procurement.cancelPurchaseOrder.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تم إلغاء الأمر" : "Purchase order cancelled");
        await invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const selectedRows = useMemo(
    () =>
      lines.map((line) => {
        const ingredient = ingredients.data?.find((row) => row.id === Number(line.ingredientId));
        const packageConversion = ingredient?.packages.find((row) => row.id === Number(line.packageConversionId));
        let amount = 0;
        try {
          if (line.unitPrice && line.quantity) {
            amount = multiplyDivide(parseDecimalToScaled(line.quantity), parseDecimalToScaled(line.unitPrice, 100), 1_000);
          }
        } catch {
          amount = 0;
        }
        return { ingredient, packageConversion, amount };
      }),
    [ingredients.data, lines],
  );
  const total = selectedRows.reduce((sum, row) => sum + row.amount, 0);
  const submitCreate = () => {
    try {
      const payload = lines.map((line) => {
        const ingredient = ingredients.data?.find((row) => row.id === Number(line.ingredientId));
        if (!ingredient) throw new Error(ar ? "اختر مكوناً لكل سطر" : "Select an ingredient for every line");
        const unitPriceMinor = parseDecimalToScaled(line.unitPrice, 100);
        return {
          ingredientId: ingredient.id,
          packageConversionId: line.packageConversionId ? Number(line.packageConversionId) : null,
          unitId: ingredient.base_unit_id,
          quantityScaled: parseDecimalToScaled(line.quantity),
          unitPriceMinor,
          notes: line.notes || null,
        };
      });
      create.mutate({
        branchId,
        supplierId: Number(supplierId),
        poNumber,
        expectedDate: expectedDate ? new Date(`${expectedDate}T00:00:00.000Z`).toISOString() : null,
        notes: notes || null,
        idempotencyKey: `po-ui:${crypto.randomUUID()}`,
        lines: payload,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid purchase order");
    }
  };
  return (
    <div>
      <InventoryNav />
      <InventoryPageHeader
        titleEn="Purchase orders"
        titleAr="أوامر الشراء"
        descriptionEn="Plan supplier purchases, then receive approved orders through audited goods-receipt notes."
        descriptionAr="خطط لمشتريات الموردين واستلم الأوامر المعتمدة بإشعارات استلام موثقة."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_480px]">
        <Card>
          <CardHeader>
            <CardTitle>{ar ? "الأوامر" : "Purchase-order register"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {orders.data?.map((order) => (
              <div key={order.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <strong>{order.po_number}</strong>
                    <span className="ms-2 text-sm text-muted-foreground">
                      {ar ? order.supplier_name_ar_snapshot : order.supplier_name_en_snapshot}
                    </span>
                  </div>
                  <span className="rounded bg-muted px-2 py-1 text-xs font-semibold">{order.status}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {order.lines.length} {ar ? "بنود" : "lines"} · {formatCurrency(order.total_amount, locale)} · {ar ? "الاستلام" : "receiving"}: {order.receiving_status.replaceAll("_", " ")}
                </p>
                <div className="mt-3 space-y-1 border-t pt-2 text-sm">
                  {order.lines.map((line) => (
                    <div key={line.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <span>
                        {ar ? line.ingredient_name_ar : line.ingredient_name_en} · {formatQuantity(line.quantity_input_scaled)}{" "}
                        {line.unit_code}
                        <small className="ms-2 block text-muted-foreground">{ar ? "مقبول / متبقٍ" : "Received / remaining"}: {formatExactQuantity(order.receipts.filter((receipt) => ["posted", "needs_review"].includes(receipt.status)).flatMap((receipt) => receipt.lines).filter((receiptLine) => receiptLine.purchase_order_line_id === line.id).reduce((sum, receiptLine) => sum + receiptLine.accepted_quantity_base, 0), line.ingredient.dimension)} / {formatExactQuantity(Math.max(0, line.quantity_base - order.receipts.filter((receipt) => ["posted", "needs_review"].includes(receipt.status)).flatMap((receipt) => receipt.lines).filter((receiptLine) => receiptLine.purchase_order_line_id === line.id).reduce((sum, receiptLine) => sum + receiptLine.accepted_quantity_base, 0)), line.ingredient.dimension)}</small>
                      </span>
                      <span>{formatCurrency(line.line_total_amount, locale)}</span>
                    </div>
                  ))}
                </div>
                {order.receipts.length > 0 && <div className="mt-2 flex flex-wrap gap-2 border-t pt-2 text-sm"><strong>{ar ? "سجل الاستلام" : "Receiving history"}:</strong>{order.receipts.map((receipt) => <Link key={receipt.id} href={`/admin/inventory/receiving/${receipt.id}`} className="underline">{receipt.receipt_number} · {receipt.status}</Link>)}</div>}
                {order.receipts.some((receipt) => receipt.status === "posted") && <Link href={`/admin/inventory/returns?purchaseOrderId=${order.id}`} className="mt-2 inline-flex min-h-11 items-center text-sm underline">{ar ? "سجل مرتجعات أمر الشراء" : "Purchase-order return history"}</Link>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {order.status === "approved" && <Link href="/admin/inventory/receiving" className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted">{ar ? "استلام أمر الشراء" : "Receive purchase order"}</Link>}
                  {order.status === "draft" && context.data?.canCreateOrders && (
                    <Button size="sm" onClick={() => submit.mutate({ branchId, purchaseOrderId: order.id })}>
                      {ar ? "إرسال" : "Submit"}
                    </Button>
                  )}
                  {order.status === "submitted" && context.data?.canApproveOrders && (
                    <Button
                      size="sm"
                      onClick={() =>
                        approve.mutate({
                          branchId,
                          purchaseOrderId: order.id,
                        })
                      }
                    >
                      {ar ? "اعتماد" : "Approve"}
                    </Button>
                  )}
                  {["draft", "submitted"].includes(order.status) && context.data?.canApproveOrders && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const reason = window.prompt(ar ? "سبب الإلغاء" : "Cancellation reason");
                        if (reason)
                          cancel.mutate({
                            branchId,
                            purchaseOrderId: order.id,
                            reason,
                          });
                      }}
                    >
                      {ar ? "إلغاء" : "Cancel"}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        {context.data?.canCreateOrders && (
          <Card>
            <CardHeader>
              <CardTitle>{ar ? "أمر شراء جديد" : "New purchase order"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label={ar ? "المورد" : "Supplier"}>
                <select
                  className="min-h-11 w-full rounded-md border bg-background px-3"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">—</option>
                  {suppliers.data
                    ?.filter((row) => row.is_active)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {ar ? row.name_ar : row.name_en}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={ar ? "رقم الأمر" : "PO number"}>
                <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value.toUpperCase())} placeholder="PO-2026-001" />
              </Field>
              <Field label={ar ? "تاريخ التسليم المتوقع" : "Expected delivery"}>
                <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
              </Field>
              <Field label={ar ? "ملاحظات" : "Notes"}>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <div className="space-y-3">
                {lines.map((line, index) => (
                  <div className="rounded-lg border p-3" key={index}>
                    <div className="mb-2 flex items-center justify-between">
                      <strong>{ar ? `البند ${index + 1}` : `Line ${index + 1}`}</strong>
                      {lines.length > 1 && (
                        <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, rowIndex) => rowIndex !== index))}>
                          ×
                        </Button>
                      )}
                    </div>
                    <select
                      aria-label="Ingredient"
                      className="min-h-11 w-full rounded-md border bg-background px-3"
                      value={line.ingredientId}
                      onChange={(e) => {
                        const next = [...lines];
                        next[index] = {
                          ...line,
                          ingredientId: e.target.value,
                          packageConversionId: "",
                        };
                        setLines(next);
                      }}
                    >
                      <option value="">{ar ? "اختر المكون" : "Select ingredient"}</option>
                      {ingredients.data
                        ?.filter((row) => row.is_active)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {ar ? row.name_ar : row.name_en} · {row.sku}
                          </option>
                        ))}
                    </select>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Input
                        aria-label="Quantity"
                        inputMode="decimal"
                        placeholder={ar ? "الكمية" : "Quantity"}
                        value={line.quantity}
                        onChange={(e) => {
                          const next = [...lines];
                          next[index] = { ...line, quantity: e.target.value };
                          setLines(next);
                        }}
                      />
                      <Input
                        aria-label="Unit price"
                        inputMode="decimal"
                        placeholder={ar ? "سعر الوحدة" : "Unit price EGP"}
                        value={line.unitPrice}
                        onChange={(e) => {
                          const next = [...lines];
                          next[index] = { ...line, unitPrice: e.target.value };
                          setLines(next);
                        }}
                      />
                    </div>
                    {ingredients.data?.find((row) => row.id === Number(line.ingredientId))?.packages.length ? (
                      <select
                        aria-label="Package"
                        className="mt-2 min-h-11 w-full rounded-md border bg-background px-3"
                        value={line.packageConversionId}
                        onChange={(e) => {
                          const next = [...lines];
                          next[index] = {
                            ...line,
                            packageConversionId: e.target.value,
                          };
                          setLines(next);
                        }}
                      >
                        <option value="">{ar ? "وحدة أساسية" : "Base unit"}</option>
                        {ingredients.data
                          ?.find((row) => row.id === Number(line.ingredientId))
                          ?.packages.map((pkg) => (
                            <option key={pkg.id} value={pkg.id}>
                              {ar ? pkg.name_ar : pkg.name_en}
                            </option>
                          ))}
                      </select>
                    ) : null}
                  </div>
                ))}
              </div>
              <Button variant="outline" className="min-h-11 w-full" onClick={() => setLines([...lines, emptyLine()])}>
                {ar ? "إضافة بند" : "Add line"}
              </Button>
              <div className="flex items-center justify-between rounded bg-muted p-3">
                <strong>{ar ? "الإجمالي" : "Total"}</strong>
                <strong>{formatCurrency(total, locale)}</strong>
              </div>
              <Button
                className="min-h-11 w-full"
                disabled={
                  create.isPending ||
                  !supplierId ||
                  !poNumber ||
                  lines.some((line) => !line.ingredientId || !line.quantity || !line.unitPrice)
                }
                onClick={submitCreate}
              >
                {ar ? "إنشاء مسودة" : "Create draft"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
