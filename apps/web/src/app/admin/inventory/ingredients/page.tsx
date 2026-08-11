"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { convertScaledQuantity, multiplyDivide, parseDecimalToScaled } from "@/lib/inventory/exact";
import { InventoryNav, InventoryPageHeader, formatExactQuantity } from "@/components/inventory/inventory-nav";
import { formatCurrency } from "@/lib/utils";

export default function IngredientsPage() {
  const trpc = useTRPC(); const queryClient = useQueryClient(); const locale = useLocale(); const ar = locale === "ar";
  const context = useQuery(trpc.inventory.context.queryOptions()); const branchId = context.data?.branch.id ?? 0;
  const refs = useQuery({ ...trpc.inventory.referenceData.queryOptions({ branchId }), enabled: branchId > 0 });
  const list = useQuery({ ...trpc.inventory.ingredients.queryOptions({ branchId, includeArchived: true }), enabled: branchId > 0 });
  const [create, setCreate] = useState({ sku: "", en: "", ar: "", dimension: "mass" as "mass" | "volume" | "count", categoryId: "", locationId: "" });
  const [adjust, setAdjust] = useState({ ingredientId: "", unitId: "", quantity: "", cost: "", reason: "Opening balance", direction: "positive" as "positive" | "negative", opening: true });
  const units = useMemo(() => refs.data?.units.filter((unit) => unit.dimension === create.dimension) ?? [], [refs.data, create.dimension]);
  const invalidate = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: trpc.inventory.ingredients.queryOptions({ branchId }).queryKey }), queryClient.invalidateQueries({ queryKey: trpc.inventory.overview.queryOptions({ branchId }).queryKey })]); };
  const createMutation = useMutation(trpc.inventory.createIngredient.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم إنشاء المكون" : "Ingredient created"); setCreate({ ...create, sku: "", en: "", ar: "" }); await invalidate(); }, onError: (error) => toast.error(error.message) }));
  const adjustMutation = useMutation(trpc.inventory.adjust.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تم ترحيل الحركة" : "Movement posted"); setAdjust({ ...adjust, quantity: "", cost: "" }); await invalidate(); }, onError: (error) => toast.error(error.message) }));
  const selectedIngredient = list.data?.find((row) => row.id === Number(adjust.ingredientId));
  const selectedUnit = refs.data?.units.find((row) => row.id === Number(adjust.unitId));
  const submitAdjustment = () => {
    if (!selectedIngredient || !selectedUnit || selectedUnit.dimension !== selectedIngredient.dimension) return toast.error(ar ? "اختر مكوناً ووحدة متوافقة" : "Select an ingredient and compatible unit");
    try {
      const quantityBase = convertScaledQuantity({ quantityScaled: parseDecimalToScaled(adjust.quantity), fromDimension: selectedUnit.dimension, toDimension: selectedIngredient.dimension, factor: { numerator: selectedUnit.base_numerator, denominator: selectedUnit.base_denominator } });
      const costMinor = adjust.cost ? parseDecimalToScaled(adjust.cost, 100) : 0;
      const unitCostMicros = adjust.direction === "positive" ? multiplyDivide(costMinor * 1_000_000, selectedUnit.base_denominator, selectedUnit.base_numerator) : undefined;
      adjustMutation.mutate({ branchId, ingredientId: selectedIngredient.id, locationId: selectedIngredient.default_location_id, quantityBase, unitCostMicros, direction: adjust.direction, opening: adjust.opening, idempotencyKey: `ui-adjust:${crypto.randomUUID()}`, reason: adjust.reason, override: false });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Invalid exact quantity"); }
  };
  return <div><InventoryNav /><InventoryPageHeader titleEn="Ingredients and stock balances" titleAr="المكونات وأرصدة المخزون" descriptionEn="Archive-safe ingredient master data and exact balances by location." descriptionAr="بيانات مكونات قابلة للأرشفة وأرصدة دقيقة حسب الموقع." />
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <Card><CardHeader><CardTitle>{ar ? "المكونات" : "Ingredients"}</CardTitle></CardHeader><CardContent className="space-y-2">{list.data?.map((row) => { const onHand = row.balances.reduce((sum, balance) => sum + balance.quantity_base, 0); return <Link href={`/admin/inventory/ingredients/${row.id}`} key={row.id} className={`grid min-h-14 grid-cols-[1fr_auto] items-center rounded-lg border px-3 hover:bg-muted ${!row.is_active ? "opacity-60" : ""}`}><span><strong>{ar ? row.name_ar : row.name_en}</strong><small className="ms-2 text-muted-foreground">{row.sku} · {ar ? row.defaultLocation.name_ar : row.defaultLocation.name_en}</small></span><span className="text-end"><strong>{formatExactQuantity(onHand, row.dimension)}</strong>{row.average_unit_cost_micros != null && <small className="block text-muted-foreground">{formatCurrency(row.balances.reduce((sum, balance) => sum + Math.round(balance.quantity_base * (balance.average_unit_cost_micros ?? 0) / 1_000 / 1_000_000), 0), locale)}</small>}</span></Link>; })}</CardContent></Card>
      <div className="space-y-4">
        {context.data?.canManage && <Card><CardHeader><CardTitle>{ar ? "مكون جديد" : "New ingredient"}</CardTitle></CardHeader><CardContent className="space-y-3">
          <Field label={ar ? "الكود" : "SKU"}><Input value={create.sku} onChange={(e) => setCreate({ ...create, sku: e.target.value.toUpperCase() })} /></Field><Field label="English name"><Input value={create.en} onChange={(e) => setCreate({ ...create, en: e.target.value })} /></Field><Field label="الاسم العربي"><Input dir="rtl" value={create.ar} onChange={(e) => setCreate({ ...create, ar: e.target.value })} /></Field>
          <Field label={ar ? "البعد" : "Dimension"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={create.dimension} onChange={(e) => setCreate({ ...create, dimension: e.target.value as typeof create.dimension })}><option value="mass">Mass</option><option value="volume">Volume</option><option value="count">Count</option></select></Field>
          <Field label={ar ? "التصنيف" : "Category"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={create.categoryId} onChange={(e) => setCreate({ ...create, categoryId: e.target.value })}><option value="">—</option>{refs.data?.categories.map((row) => <option key={row.id} value={row.id}>{ar ? row.name_ar : row.name_en}</option>)}</select></Field>
          <Field label={ar ? "الموقع الافتراضي" : "Default location"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={create.locationId} onChange={(e) => setCreate({ ...create, locationId: e.target.value })}><option value="">—</option>{refs.data?.locations.map((row) => <option key={row.id} value={row.id}>{ar ? row.name_ar : row.name_en}</option>)}</select></Field>
          <Button className="min-h-11 w-full" disabled={!create.sku || !create.en || !create.ar || !create.categoryId || !create.locationId || !units[0]} onClick={() => createMutation.mutate({ branchId, categoryId: Number(create.categoryId), sku: create.sku, nameEn: create.en, nameAr: create.ar, baseUnitId: units[0].id, dimension: create.dimension, defaultLocationId: Number(create.locationId), tracked: true, reorderLevel: 0, lowStockThreshold: 0, parLevel: null, allowNegative: false })}>{ar ? "إنشاء" : "Create ingredient"}</Button>
        </CardContent></Card>}
        {context.data?.canAdjust && <Card><CardHeader><CardTitle>{ar ? "رصيد افتتاحي أو تسوية" : "Opening balance / adjustment"}</CardTitle></CardHeader><CardContent className="space-y-3">
          <Field label={ar ? "المكون" : "Ingredient"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={adjust.ingredientId} onChange={(e) => { const row = list.data?.find((item) => item.id === Number(e.target.value)); const unit = refs.data?.units.find((entry) => entry.dimension === row?.dimension && ["KG", "L", "PC"].includes(entry.code)); setAdjust({ ...adjust, ingredientId: e.target.value, unitId: String(unit?.id ?? "") }); }}><option value="">—</option>{list.data?.filter((row) => row.is_active).map((row) => <option key={row.id} value={row.id}>{ar ? row.name_ar : row.name_en}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label={ar ? "الكمية" : "Quantity"}><Input inputMode="decimal" value={adjust.quantity} onChange={(e) => setAdjust({ ...adjust, quantity: e.target.value })} /></Field><Field label={ar ? "الوحدة" : "Unit"}><select className="min-h-11 w-full rounded-md border bg-background px-3" value={adjust.unitId} onChange={(e) => setAdjust({ ...adjust, unitId: e.target.value })}>{refs.data?.units.filter((row) => row.dimension === selectedIngredient?.dimension).map((row) => <option key={row.id} value={row.id}>{row.code}</option>)}</select></Field></div>
          <Field label={ar ? "تكلفة الوحدة بالجنيه" : "Trusted unit cost (EGP)"}><Input inputMode="decimal" value={adjust.cost} onChange={(e) => setAdjust({ ...adjust, cost: e.target.value })} disabled={adjust.direction === "negative"} /></Field>
          <Field label={ar ? "السبب" : "Reason"}><Input value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} /></Field>
          <Button className="min-h-11 w-full" disabled={!adjust.quantity || (adjust.direction === "positive" && !adjust.cost) || adjust.reason.length < 3} onClick={submitAdjustment}>{ar ? "ترحيل حركة غير قابلة للتعديل" : "Post immutable movement"}</Button>
        </CardContent></Card>}
      </div>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
