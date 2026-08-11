"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { useLocale } from "next-intl";
import { useTRPC } from "@/lib/trpc/client";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";
import { formatCurrency } from "@/lib/utils";

export default function InventoryOverviewPage() {
  const trpc = useTRPC();
  const locale = useLocale();
  const ar = locale === "ar";
  const context = useQuery(trpc.inventory.context.queryOptions());
  const branchId = context.data?.branch.id ?? 0;
  const overview = useQuery({ ...trpc.inventory.overview.queryOptions({ branchId }), enabled: branchId > 0 });
  const data = overview.data;
  const cards = [
    [ar ? "مكونات متتبعة" : "Tracked ingredients", data?.tracked ?? 0],
    [ar ? "متوفر" : "In stock", data?.inStock ?? 0],
    [ar ? "مخزون منخفض" : "Low stock", data?.lowStock ?? 0],
    [ar ? "نفد المخزون" : "Out of stock", data?.outOfStock ?? 0],
    [ar ? "تغطية الوصفات" : "Recipe coverage", `${data?.recipeCoverage.covered ?? 0}/${data?.recipeCoverage.total ?? 0}`],
    [ar ? "قيمة المخزون" : "Inventory valuation", data?.valuation == null ? "Restricted" : formatCurrency(data.valuation, locale)],
  ];
  return <div className="space-y-4"><InventoryNav /><InventoryPageHeader titleEn="Inventory overview" titleAr="نظرة عامة على المخزون" descriptionEn="Live branch stock, attention thresholds, recipe coverage, and immutable movement activity." descriptionAr="أرصدة الفرع الحالية وحدود التنبيه وتغطية الوصفات وحركات المخزون غير القابلة للتعديل." />
    {context.isError && <p role="alert" className="rounded-lg border border-destructive p-4 text-destructive">{context.error.message}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{cards.map(([label, value]) => <Card key={String(label)}><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className="text-3xl font-bold">{value}</CardContent></Card>)}</div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>{ar ? "تحتاج انتباهاً" : "Requires attention"}</CardTitle></CardHeader><CardContent className="space-y-2">{data?.attention.length ? data.attention.map((row) => <Link className="flex min-h-11 items-center justify-between rounded border px-3 hover:bg-muted" href={`/admin/inventory/ingredients/${row.id}`} key={row.id}><span>{ar ? row.name_ar : row.name_en}<small className="ms-2 text-muted-foreground">{row.sku}</small></span><strong>{formatExactQuantity(row.onHand, row.dimension)}</strong></Link>) : <p className="text-muted-foreground">{ar ? "لا توجد تنبيهات" : "No stock alerts"}</p>}</CardContent></Card>
      <Card><CardHeader><CardTitle>{ar ? "آخر الحركات" : "Recent movements"}</CardTitle></CardHeader><CardContent className="space-y-2">{data?.recent.map((row) => <div className="flex min-h-11 items-center justify-between border-b text-sm" key={row.id}><span>{row.movement_type.replaceAll("_", " ")} · {ar ? row.ingredient.name_ar : row.ingredient.name_en}</span><span className={row.direction < 0 ? "text-destructive" : "text-emerald-700"}>{row.direction > 0 ? "+" : row.direction < 0 ? "−" : ""}{formatExactQuantity(row.quantity_base, row.ingredient.dimension)}</span></div>)}</CardContent></Card>
    </div>
  </div>;
}
