"use client";

import type { Dispatch, SetStateAction } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@forno/ui/components/dialog";
import { Label } from "@forno/ui/components/label";
import { formatCurrency } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type MenuItem = RouterOutputs["restaurant"]["model"][number]["menuCategories"][number]["menuItems"][number];
type ModifierGroup = MenuItem["modifierGroups"][number]["modifierGroup"];

export function ItemConfiguratorDialog({
  item,
  editingKey,
  variantId,
  modifierIds,
  quantity,
  notes,
  error,
  inventoryStatus,
  inventoryAllows,
  optionAllows,
  optionReason,
  variantReason,
  maximumQuantity,
  onClose,
  onVariantChange,
  onToggleModifier,
  onQuantityChange,
  onNotesChange,
  onSave,
}: {
  item: MenuItem | null;
  editingKey: string | null;
  variantId: number | null;
  modifierIds: number[];
  quantity: number;
  notes: string;
  error: string | null;
  inventoryStatus: (menuItemId: number, variantId: number | null) => string;
  inventoryAllows: (menuItemId: number, variantId: number | null) => boolean;
  optionAllows: (optionId: number, group: ModifierGroup) => boolean;
  optionReason: (optionId: number, group: ModifierGroup) => string;
  variantReason: (menuItemId: number, variantId: number) => string;
  maximumQuantity: number;
  onClose: () => void;
  onVariantChange: (id: number) => void;
  onToggleModifier: (group: ModifierGroup, id: number) => void;
  onQuantityChange: Dispatch<SetStateAction<number>>;
  onNotesChange: (notes: string) => void;
  onSave: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("pos");
  const tc = useTranslations("common");
  const isArabic = locale.startsWith("ar");
  const displayName = (entry: { name_en: string; name_ar: string }) => isArabic ? entry.name_ar : entry.name_en;
  const secondaryName = (entry: { name_en: string; name_ar: string }) => isArabic ? entry.name_en : entry.name_ar;

  return <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-2xl p-0"><DialogHeader className="border-b p-5 pe-12 text-start"><DialogTitle className="text-xl">{item && displayName(item)}</DialogTitle><DialogDescription>{item && secondaryName(item)}</DialogDescription></DialogHeader>{item && <div className="space-y-6 px-5 pb-2">
      {item.variants.length > 0 && <fieldset><legend className="mb-3 font-semibold">{t("chooseVariant")}</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{item.variants.map((variant) => { const status = inventoryStatus(item.id, variant.id); const reason = variantReason(item.id, variant.id); return <Button key={variant.id} type="button" disabled={!inventoryAllows(item.id, variant.id)} variant={variantId === variant.id ? "default" : "outline"} className="min-h-14 flex-col gap-0" aria-pressed={variantId === variant.id} title={!inventoryAllows(item.id, variant.id) ? reason : undefined} onClick={() => onVariantChange(variant.id)}><span>{displayName(variant)}</span><span className="text-xs opacity-80">{formatCurrency(variant.price, locale)} · {t(`availability.${status}`)}</span>{!inventoryAllows(item.id, variant.id) && <span className="text-xs text-destructive">{reason}</span>}</Button>; })}</div></fieldset>}
      {item.modifierGroups.filter((link) => link.modifierGroup.is_active).map((link) => { const group = link.modifierGroup; return <fieldset key={group.id}><div className="mb-3 flex items-center justify-between gap-2"><legend className="font-semibold">{displayName(group)}</legend><span className="text-xs text-muted-foreground">{group.min_selections > 0 ? t("requiredSelections", { min: group.min_selections, max: group.max_selections }) : t("optionalSelections", { max: group.max_selections })}</span></div><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{group.options.filter((option) => option.is_available).map((option) => { const selected = modifierIds.includes(option.id); const allowed = optionAllows(option.id, group); return <Button key={option.id} type="button" disabled={!selected && !allowed} variant={selected ? "default" : "outline"} className="min-h-12 justify-between whitespace-normal text-start" aria-pressed={selected} title={!selected && !allowed ? optionReason(option.id, group) : undefined} onClick={() => onToggleModifier(group, option.id)}><span>{displayName(option)}{!allowed && <span className="block text-xs text-destructive">{optionReason(option.id, group)}</span>}</span><span>{option.price_delta > 0 ? `+${formatCurrency(option.price_delta, locale)}` : t("included")}</span></Button>; })}</div></fieldset>; })}
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]"><div><Label className="mb-2 block">{t("quantity")}</Label><div className="flex items-center"><Button type="button" variant="outline" size="icon" className="h-12 w-12" disabled={quantity <= 1} onClick={() => onQuantityChange((value) => Math.max(1, value - 1))}><MinusIcon /></Button><span className="w-14 text-center text-xl font-bold">{quantity}</span><Button type="button" variant="outline" size="icon" className="h-12 w-12" disabled={quantity >= maximumQuantity} title={quantity >= maximumQuantity ? t("maximumAvailability", { quantity: maximumQuantity }) : undefined} onClick={() => onQuantityChange((value) => value + 1)}><PlusIcon /></Button></div><p className="mt-1 text-xs text-muted-foreground">{t("maximumAvailability", { quantity: maximumQuantity })}</p></div><div><Label htmlFor="kitchen-notes" className="mb-2 block">{t("kitchenNotes")}</Label><textarea id="kitchen-notes" className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={notes} onChange={(event) => onNotesChange(event.target.value)} maxLength={500} placeholder={t("kitchenNotesPlaceholder")} /></div></div>
      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
    </div>}<DialogFooter className="border-t p-5"><Button type="button" variant="outline" className="min-h-11" onClick={onClose}>{tc("cancel")}</Button><Button type="button" className="min-h-11" onClick={onSave}>{editingKey ? t("updateCartItem") : t("addToCart")}</Button></DialogFooter></DialogContent>
  </Dialog>;
}
