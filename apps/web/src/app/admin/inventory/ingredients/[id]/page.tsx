"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { InventoryNav, formatExactQuantity } from "@/components/inventory/inventory-nav";

export default function IngredientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const ingredientId = Number(id); const trpc = useTRPC(); const queryClient = useQueryClient(); const ar = useLocale() === "ar"; const [reason, setReason] = useState("");
  const context = useQuery(trpc.inventory.context.queryOptions()); const branchId = context.data?.branch.id ?? 0;
  const list = useQuery({ ...trpc.inventory.ingredients.queryOptions({ branchId, includeArchived: true }), enabled: branchId > 0 });
  const movements = useQuery({ ...trpc.inventory.movements.queryOptions({ branchId, ingredientId }), enabled: branchId > 0 && ingredientId > 0 });
  const row = list.data?.find((entry) => entry.id === ingredientId);
  const archive = useMutation(trpc.inventory.archiveIngredient.mutationOptions({ onSuccess: async () => { toast.success(ar ? "تمت أرشفة المكون" : "Ingredient archived"); await queryClient.invalidateQueries({ queryKey: trpc.inventory.ingredients.queryOptions({ branchId }).queryKey }); }, onError: (error) => toast.error(error.message) }));
  return <div><InventoryNav /><Link href="/admin/inventory/ingredients" className="mb-4 inline-flex min-h-11 items-center text-sm underline">← {ar ? "المكونات" : "Ingredients"}</Link>{row && <>
    <div className="mb-5"><h2 className="text-2xl font-bold">{ar ? row.name_ar : row.name_en}</h2><p className="text-muted-foreground">{row.sku} · {ar ? row.category.name_ar : row.category.name_en} · {row.dimension}</p></div>
    <div className="grid gap-4 lg:grid-cols-3"><Card><CardHeader><CardTitle>{ar ? "الرصيد حسب الموقع" : "Balances by location"}</CardTitle></CardHeader><CardContent className="space-y-2">{row.balances.map((balance) => <div key={balance.id} className="flex min-h-11 items-center justify-between border-b"><span>{balance.location_id === row.default_location_id ? (ar ? row.defaultLocation.name_ar : row.defaultLocation.name_en) : `#${balance.location_id}`}</span><strong>{formatExactQuantity(balance.quantity_base, row.dimension)}</strong></div>)}</CardContent></Card>
      <Card className="lg:col-span-2"><CardHeader><CardTitle>{ar ? "حركات غير قابلة للتعديل" : "Immutable movement history"}</CardTitle></CardHeader><CardContent className="space-y-2">{movements.data?.map((movement) => <div key={movement.id} className="grid min-h-12 grid-cols-[1fr_auto] items-center border-b text-sm"><span><strong>{movement.movement_type.replaceAll("_", " ")}</strong><small className="block text-muted-foreground">{movement.reason} · {new Date(movement.created_at).toLocaleString()}</small></span><span>{movement.direction > 0 ? "+" : movement.direction < 0 ? "−" : ""}{formatExactQuantity(movement.quantity_base, row.dimension)}</span></div>)}</CardContent></Card>
    </div>{context.data?.canManage && row.is_active && <Card className="mt-4"><CardHeader><CardTitle>{ar ? "أرشفة" : "Archive ingredient"}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2 sm:flex-row"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={ar ? "سبب إلزامي" : "Mandatory reason"} /><Button variant="destructive" className="min-h-11" disabled={reason.length < 3} onClick={() => archive.mutate({ branchId, ingredientId, reason })}>{ar ? "أرشفة دون حذف السجل" : "Archive without deleting history"}</Button></CardContent></Card>}</>}
  </div>;
}
