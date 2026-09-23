"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import { BoxesIcon, ChefHatIcon, ClipboardListIcon, FactoryIcon, HistoryIcon, LayoutDashboardIcon } from "lucide-react";

const links = [
  { href: "/admin/inventory", en: "Overview", ar: "نظرة عامة", icon: LayoutDashboardIcon },
  { href: "/admin/inventory/ingredients", en: "Ingredients & balances", ar: "المكونات والأرصدة", icon: BoxesIcon },
  { href: "/admin/inventory/recipes", en: "Recipes & costing", ar: "الوصفات والتكلفة", icon: ChefHatIcon },
  { href: "/admin/inventory/movements", en: "Movement ledger", ar: "سجل الحركات", icon: HistoryIcon },
  { href: "/admin/inventory/suppliers", en: "Suppliers", ar: "الموردون", icon: FactoryIcon },
  { href: "/admin/inventory/purchase-orders", en: "Purchase orders", ar: "أوامر الشراء", icon: ClipboardListIcon },
];

export function InventoryNav() {
  const ar = useLocale() === "ar";
  return <nav aria-label={ar ? "أقسام المخزون" : "Inventory sections"} className="mb-4 flex gap-2 overflow-x-auto pb-1">
    {links.map(({ href, en, ar: arabic, icon: Icon }) => <Link key={href} href={href} className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border bg-background px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon className="h-4 w-4" />{ar ? arabic : en}</Link>)}
  </nav>;
}

export function InventoryPageHeader({ titleEn, titleAr, descriptionEn, descriptionAr }: { titleEn: string; titleAr: string; descriptionEn: string; descriptionAr: string }) {
  const ar = useLocale() === "ar";
  return <div className="mb-5"><h2 className="text-2xl font-bold">{ar ? titleAr : titleEn}</h2><p className="mt-1 text-sm text-muted-foreground">{ar ? descriptionAr : descriptionEn}</p></div>;
}

export function formatExactQuantity(quantity: number, dimension: string) {
  if (dimension === "mass") return Math.abs(quantity) >= 1_000_000_000 ? `${(quantity / 1_000_000_000).toFixed(3)} kg` : `${(quantity / 1_000_000).toFixed(1)} g`;
  if (dimension === "volume") return Math.abs(quantity) >= 1_000_000 ? `${(quantity / 1_000_000).toFixed(3)} L` : `${(quantity / 1_000).toFixed(1)} ml`;
  return `${(quantity / 1_000).toFixed(3)} pc`;
}
