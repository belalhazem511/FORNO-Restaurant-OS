"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  Trash2Icon,
  UtensilsIcon,
  XCircleIcon,
  CreditCardIcon,
} from "lucide-react";
import { Badge } from "@forno/ui/components/badge";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@forno/ui/components/dialog";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@forno/ui/components/select";
import { Skeleton } from "@forno/ui/components/skeleton";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { formatCurrency } from "@/lib/utils";
import { validateOrderFulfilment } from "@/lib/orders/lifecycle";
import { calculateDiscount } from "@/lib/finance";
import {
  addCartLine,
  calculateCartTotal,
  calculateLineTotal,
  calculateUnitPrice,
  replaceCartLine,
  setCartLineQuantity,
  type CartLine,
  type CartLineInput,
} from "@/lib/pos/cart";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/router";
import { PrintActions } from "@/components/printing/print-actions";

type RestaurantBranch = RouterOutputs["restaurant"]["model"][number];
type MenuCategory = RestaurantBranch["menuCategories"][number];
type MenuItem = MenuCategory["menuItems"][number];
type OrderType = "dine_in" | "takeaway" | "delivery";
type CheckoutResult = RouterOutputs["checkout"]["pay"];

function createRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function POSPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const isArabic = locale.startsWith("ar");
  const t = useTranslations("pos");
  const tc = useTranslations("common");

  const restaurantQuery = useQuery(trpc.restaurant.model.queryOptions());
  const customersQuery = useQuery(trpc.customers.list.queryOptions());
  const branches = restaurantQuery.data ?? [];
  const branch = branches.find((entry) => entry.is_active) ?? branches[0];
  const customers = customersQuery.data ?? [];
  const shiftContextQuery = useQuery({
    ...trpc.shifts.context.queryOptions({ branchId: branch?.id ?? 0 }),
    enabled: Boolean(branch),
  });

  const [orderType, setOrderType] = useState<OrderType>("takeaway");
  const [areaId, setAreaId] = useState<number | null>(null);
  const [tableId, setTableId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [categoryId, setCategoryId] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [clearOpen, setClearOpen] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successOrderId, setSuccessOrderId] = useState<number | null>(null);
  const [successOrderSubtotal, setSuccessOrderSubtotal] = useState(0);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutResult, setCheckoutResult] = useState<CheckoutResult | null>(null);
  const [clientRequestId, setClientRequestId] = useState(createRequestId);

  const [configuringItem, setConfiguringItem] = useState<MenuItem | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [modifierIds, setModifierIds] = useState<number[]>([]);
  const [itemQuantity, setItemQuantity] = useState(1);
  const [itemNotes, setItemNotes] = useState("");
  const [configurationError, setConfigurationError] = useState<string | null>(null);

  const categories = useMemo(
    () => [...(branch?.menuCategories ?? [])].filter((category) => category.is_active)
      .sort((a, b) => a.sort_order - b.sort_order),
    [branch],
  );
  const menuItems = useMemo(() => categories.flatMap((category) => category.menuItems), [categories]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    return menuItems.filter((item) => {
      if (categoryId !== "all" && item.category_id !== categoryId) return false;
      if (!query) return true;
      return item.name_en.toLocaleLowerCase(locale).includes(query)
        || item.name_ar.toLocaleLowerCase(locale).includes(query)
        || item.code.toLocaleLowerCase(locale).includes(query);
    });
  }, [categoryId, locale, menuItems, search]);
  const selectedArea = branch?.diningAreas.find((area) => area.id === areaId) ?? null;
  const cartTotal = calculateCartTotal(cart);

  const displayName = (entry: { name_en: string; name_ar: string }) => isArabic ? entry.name_ar : entry.name_en;
  const secondaryName = (entry: { name_en: string; name_ar: string }) => isArabic ? entry.name_en : entry.name_ar;

  const changeOrderType = (nextType: OrderType) => {
    setOrderType(nextType);
    setContextError(null);
    if (nextType !== "dine_in") {
      setAreaId(null);
      setTableId(null);
    }
    if (nextType !== "delivery") setDeliveryAddress("");
  };

  const openConfigurator = (item: MenuItem, line?: CartLine) => {
    setConfiguringItem(item);
    setEditingKey(line?.key ?? null);
    const availableVariants = item.variants.filter((variant) => variant.is_available);
    const defaultVariant = availableVariants.find((variant) => variant.is_default) ?? availableVariants[0];
    setVariantId(line?.variantId ?? defaultVariant?.id ?? null);
    setModifierIds(line?.modifiers.map((modifier) => modifier.id) ?? item.modifierGroups.flatMap((link) => {
      if (!link.modifierGroup.is_active) return [];
      return link.modifierGroup.options
        .filter((option) => option.is_available && option.is_default)
        .slice(0, link.modifierGroup.max_selections)
        .map((option) => option.id);
    }));
    setItemQuantity(line?.quantity ?? 1);
    setItemNotes(line?.notes ?? "");
    setConfigurationError(null);
  };

  const toggleModifier = (group: MenuItem["modifierGroups"][number]["modifierGroup"], optionId: number) => {
    const groupOptionIds = new Set(group.options.map((option) => option.id));
    const selectedForGroup = modifierIds.filter((id) => groupOptionIds.has(id));
    if (selectedForGroup.includes(optionId)) {
      setModifierIds((current) => current.filter((id) => id !== optionId));
      return;
    }
    if (group.max_selections === 1) {
      setModifierIds((current) => [...current.filter((id) => !groupOptionIds.has(id)), optionId]);
      return;
    }
    if (selectedForGroup.length < group.max_selections) {
      setModifierIds((current) => [...current, optionId]);
    }
  };

  const saveConfiguredItem = () => {
    if (!configuringItem) return;
    const availableVariants = configuringItem.variants.filter((variant) => variant.is_available);
    const variant = availableVariants.find((entry) => entry.id === variantId) ?? null;
    if (availableVariants.length > 1 && !variant) {
      setConfigurationError(t("variantRequired"));
      return;
    }

    for (const link of configuringItem.modifierGroups) {
      const group = link.modifierGroup;
      if (!group.is_active) continue;
      const optionIds = new Set(group.options.filter((option) => option.is_available).map((option) => option.id));
      const count = modifierIds.filter((id) => optionIds.has(id)).length;
      if (count < group.min_selections || count > group.max_selections) {
        setConfigurationError(t("modifierRangeError", {
          name: displayName(group), min: group.min_selections, max: group.max_selections,
        }));
        return;
      }
    }

    const options = configuringItem.modifierGroups.flatMap((link) => link.modifierGroup.options.map((option) => ({
      ...option,
      groupId: link.modifierGroup.id,
    })));
    const selectedModifiers = options.filter((option) => modifierIds.includes(option.id)).map((option) => ({
      id: option.id,
      groupId: option.groupId,
      nameEn: option.name_en,
      nameAr: option.name_ar,
      priceDelta: option.price_delta,
    }));
    const input: CartLineInput = {
      menuItemId: configuringItem.id,
      productId: configuringItem.product_id,
      nameEn: configuringItem.name_en,
      nameAr: configuringItem.name_ar,
      variantId: variant?.id ?? null,
      variantNameEn: variant?.name_en ?? null,
      variantNameAr: variant?.name_ar ?? null,
      basePrice: variant?.price ?? configuringItem.base_price,
      modifiers: selectedModifiers,
      quantity: itemQuantity,
      notes: itemNotes,
    };
    setCart((current) => editingKey ? replaceCartLine(current, editingKey, input) : addCartLine(current, input));
    setConfiguringItem(null);
  };

  const mutation = useMutation(trpc.orders.create.mutationOptions({
    onSuccess: (order) => {
      setSuccessOrderId(order.id);
      setSuccessOrderSubtotal(order.subtotal_amount);
      setCart([]);
      setSubmitError(null);
      queryClient.invalidateQueries(trpc.orders.list.queryOptions());
      queryClient.invalidateQueries(trpc.restaurant.model.queryOptions());
    },
    onError: (error) => setSubmitError(error.message || t("createFailed")),
  }));

  const submitOrder = () => {
    setContextError(null);
    setSubmitError(null);
    if (!branch || cart.length === 0) {
      setContextError(t(cart.length === 0 ? "cartEmptyError" : "branchUnavailable"));
      return;
    }
    try {
      validateOrderFulfilment({ orderType, diningTableId: tableId, deliveryAddress, customerId });
    } catch {
      if (orderType === "dine_in") setContextError(t("tableRequired"));
      else if (orderType === "delivery" && !customerId) setContextError(t("deliveryCustomerRequired"));
      else setContextError(t("deliveryAddressRequired"));
      return;
    }
    mutation.mutate({
      branchId: branch.id,
      customerId,
      orderType,
      diningTableId: tableId,
      deliveryAddress: orderType === "delivery" ? deliveryAddress : null,
      clientRequestId,
      items: cart.map((line) => ({
        menuItemId: line.menuItemId,
        variantId: line.variantId,
        modifierOptionIds: line.modifiers.map((modifier) => modifier.id),
        quantity: line.quantity,
        notes: line.notes || undefined,
      })),
    });
  };

  const startNewOrder = () => {
    setSuccessOrderId(null);
    setSuccessOrderSubtotal(0);
    setCheckoutResult(null);
    setCheckoutOpen(false);
    setOrderType("takeaway");
    setAreaId(null);
    setTableId(null);
    setCustomerId(null);
    setDeliveryAddress("");
    setContextError(null);
    setSubmitError(null);
    setClientRequestId(createRequestId());
  };

  if (restaurantQuery.isLoading || customersQuery.isLoading) {
    return <POSLoading />;
  }

  if (restaurantQuery.error || customersQuery.error) {
    return (
      <Card className="mx-auto max-w-xl border-destructive/50">
        <CardContent className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
          <XCircleIcon className="h-12 w-12 text-destructive" />
          <div><h2 className="text-xl font-semibold">{t("loadErrorTitle")}</h2><p className="text-muted-foreground">{t("loadErrorDescription")}</p></div>
          <Button onClick={() => { restaurantQuery.refetch(); customersQuery.refetch(); }}>{tc("retry")}</Button>
        </CardContent>
      </Card>
    );
  }

  if (!branch) {
    return <Card><CardContent className="flex min-h-64 items-center justify-center text-muted-foreground">{t("branchUnavailable")}</CardContent></Card>;
  }

  if (successOrderId !== null) {
    const activeShift = shiftContextQuery.data?.currentShift ?? null;
    return (
      <>
      <Card className="mx-auto max-w-xl border-emerald-500/40">
        <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-5 p-8 text-center">
          <div className="rounded-full bg-emerald-100 p-4 text-emerald-700"><CheckCircle2Icon className="h-14 w-14" /></div>
          <div className="space-y-2"><h2 className="text-3xl font-bold">{t("orderCreated")}</h2><p className="text-lg text-muted-foreground">{t("orderNumber", { number: successOrderId })}</p></div>
          {checkoutResult ? <div className="w-full rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900"><p className="font-bold">{t("paymentComplete")}</p><p>{t("amountPaid")}: {formatCurrency(checkoutResult.payableAmount, locale)}</p>{checkoutResult.changeAmount > 0 && <p>{t("changeDue")}: {formatCurrency(checkoutResult.changeAmount, locale)}</p>}</div> : activeShift ? <Button size="lg" className="min-h-14 w-full text-base" onClick={() => setCheckoutOpen(true)}><CreditCardIcon />{t("checkoutOrder")}</Button> : <div className="w-full rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900"><p className="font-semibold">{t("activeShiftRequired")}</p><Button className="mt-3 min-h-11" variant="outline" asChild><Link href="/admin/cashier">{t("openShift")}</Link></Button></div>}
          <div className="w-full"><PrintActions orderId={successOrderId} compact /></div>
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
            <Button size="lg" className="min-h-12" onClick={startNewOrder}>{t("newOrder")}</Button>
            <Button size="lg" variant="outline" className="min-h-12" asChild><Link href={`/admin/orders/${successOrderId}`}>{t("viewOrder")}</Link></Button>
          </div>
        </CardContent>
      </Card>
      <POSCheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        orderId={successOrderId}
        subtotal={successOrderSubtotal}
        branchId={branch.id}
        role={shiftContextQuery.data?.role ?? "cashier"}
        paymentMethods={shiftContextQuery.data?.paymentMethods ?? []}
        onSuccess={(result) => { setCheckoutResult(result); setCheckoutOpen(false); }}
      />
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24 xl:pb-4">
      <section className="rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold">{t("orderContext")}</h2><p className="text-sm text-muted-foreground">{displayName(branch)}</p></div>
          <Badge variant="outline" className="hidden sm:inline-flex">{t("draftOrder")}</Badge>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {([
            ["dine_in", t("dineIn"), UtensilsIcon],
            ["takeaway", t("takeaway"), ShoppingBagIcon],
            ["delivery", t("delivery"), ShoppingCartIcon],
          ] as const).map(([value, label, Icon]) => (
            <Button key={value} type="button" variant={orderType === value ? "default" : "outline"} className="min-h-14 px-2 text-sm sm:text-base" onClick={() => changeOrderType(value)} aria-pressed={orderType === value}>
              <Icon className="h-5 w-5" />{label}
            </Button>
          ))}
        </div>

        {orderType === "dine_in" && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div><Label className="mb-2 block">{t("diningArea")}</Label><div className="flex flex-wrap gap-2">
              {branch.diningAreas.filter((area) => area.is_active).map((area) => <Button key={area.id} type="button" variant={areaId === area.id ? "default" : "outline"} className="min-h-11" onClick={() => { setAreaId(area.id); setTableId(null); }}>{displayName(area)}</Button>)}
            </div></div>
            <div><Label className="mb-2 block">{t("table")}</Label>{selectedArea ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
              {selectedArea.tables.filter((table) => table.is_active).map((table) => {
                const available = table.status === "available";
                return <Button key={table.id} type="button" variant={tableId === table.id ? "default" : "outline"} className="min-h-14 flex-col gap-0" disabled={!available} onClick={() => setTableId(table.id)}><span>{displayName(table)}</span><span className="text-[11px] opacity-70">{available ? t("available") : t("unavailable")}</span></Button>;
              })}
            </div> : <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t("selectAreaFirst")}</p>}</div>
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div><Label htmlFor="pos-customer" className="mb-2 block">{orderType === "delivery" ? t("customerRequired") : t("customerOptional")}</Label>
            <Select value={customerId?.toString() ?? "walk-in"} onValueChange={(value) => setCustomerId(value === "walk-in" ? null : Number(value))}>
              <SelectTrigger id="pos-customer" className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="walk-in">{t("walkInCustomer")}</SelectItem>{customers.map((customer) => <SelectItem key={customer.id} value={customer.id.toString()}>{customer.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {orderType === "delivery" && <Input id="delivery-address" className="min-h-11" label={t("deliveryAddress")} value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder={t("deliveryAddressPlaceholder")} />}
        </div>
        {contextError && <p role="alert" className="mt-3 text-sm font-medium text-destructive">{contextError}</p>}
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="min-w-0 space-y-3">
          <div className="sticky top-14 z-20 space-y-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
            <div className="relative"><SearchIcon className="absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" /><Input className="min-h-12 ps-11 text-base" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchMenu")} /></div>
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t("categories")}>
              <Button type="button" role="tab" aria-selected={categoryId === "all"} variant={categoryId === "all" ? "default" : "outline"} className="min-h-11 shrink-0" onClick={() => setCategoryId("all")}>{tc("all")}</Button>
              {categories.map((category) => <Button key={category.id} type="button" role="tab" aria-selected={categoryId === category.id} variant={categoryId === category.id ? "default" : "outline"} className="min-h-11 shrink-0" onClick={() => setCategoryId(category.id)}>{displayName(category)}</Button>)}
            </div>
          </div>

          {visibleItems.length === 0 ? <Card><CardContent className="flex min-h-52 flex-col items-center justify-center gap-2 text-center text-muted-foreground"><ShoppingBagIcon className="h-10 w-10" /><p>{search ? t("noSearchResults") : t("noMenuItems")}</p></CardContent></Card> : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
              {visibleItems.map((item) => {
                const availableVariants = item.variants.filter((variant) => variant.is_available);
                const fromPrice = availableVariants.length > 0 ? Math.min(...availableVariants.map((variant) => variant.price)) : item.base_price;
                return <button key={item.id} type="button" disabled={!item.is_available} onClick={() => openConfigurator(item)} className="group min-h-40 rounded-xl border bg-card p-4 text-start shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
                  <div className="flex h-full flex-col justify-between gap-4"><div><div className="mb-2 flex items-start justify-between gap-2"><h3 className="font-bold leading-tight">{displayName(item)}</h3>{!item.is_available && <Badge variant="destructive">{t("unavailable")}</Badge>}</div><p className="text-xs text-muted-foreground" dir={isArabic ? "ltr" : "rtl"}>{secondaryName(item)}</p></div><div className="flex items-end justify-between gap-2"><strong className="text-base text-primary">{availableVariants.length > 1 ? t("fromPrice", { price: formatCurrency(fromPrice, locale) }) : formatCurrency(fromPrice, locale)}</strong>{(availableVariants.length > 0 || item.modifierGroups.length > 0) && <ChevronDownIcon className="h-5 w-5 text-muted-foreground transition group-hover:text-primary" />}</div></div>
                </button>;
              })}
            </div>
          )}
        </section>

        <aside className="xl:sticky xl:top-[72px]">
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-4"><CardTitle className="flex items-center gap-2"><ShoppingCartIcon className="h-5 w-5" />{t("cart")}<Badge variant="secondary">{cart.reduce((sum, line) => sum + line.quantity, 0)}</Badge></CardTitle><Button type="button" variant="ghost" size="sm" disabled={cart.length === 0} onClick={() => setClearOpen(true)}>{t("clearCart")}</Button></CardHeader>
            <CardContent className="p-0">
              {cart.length === 0 ? <div className="flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"><ShoppingCartIcon className="h-12 w-12 opacity-40" /><p>{t("emptyCart")}</p></div> : <div className="max-h-[50vh] divide-y overflow-y-auto xl:max-h-[calc(100vh-390px)]">
                {cart.map((line) => <div key={line.key} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{isArabic ? line.nameAr : line.nameEn}</h3>{line.variantId && <p className="text-xs text-muted-foreground">{isArabic ? line.variantNameAr : line.variantNameEn}</p>}{line.modifiers.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{line.modifiers.map((modifier) => isArabic ? modifier.nameAr : modifier.nameEn).join("، ")}</p>}{line.notes && <p className="mt-1 rounded bg-muted px-2 py-1 text-xs">{t("notesLabel")}: {line.notes}</p>}</div><strong className="shrink-0">{formatCurrency(calculateLineTotal(line), locale)}</strong></div><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-1"><Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label={t("decreaseQuantity")} onClick={() => setCart((current) => setCartLineQuantity(current, line.key, line.quantity - 1))}><MinusIcon /></Button><span className="w-10 text-center text-lg font-bold tabular-nums">{line.quantity}</span><Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label={t("increaseQuantity")} onClick={() => setCart((current) => setCartLineQuantity(current, line.key, line.quantity + 1))}><PlusIcon /></Button></div><div className="flex"><Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={tc("edit")} onClick={() => { const item = menuItems.find((entry) => entry.id === line.menuItemId); if (item) openConfigurator(item, line); }}><PencilIcon /></Button><Button type="button" variant="ghost" size="icon" className="h-10 w-10 text-destructive" aria-label={tc("remove")} onClick={() => setCart((current) => current.filter((entry) => entry.key !== line.key))}><Trash2Icon /></Button></div></div><p className="text-xs text-muted-foreground">{formatCurrency(calculateUnitPrice(line), locale)} × {line.quantity}</p></div>)}
              </div>}
              <div className="space-y-3 border-t bg-muted/30 p-4"><div className="flex items-center justify-between text-sm"><span>{t("subtotal")}</span><span>{formatCurrency(cartTotal, locale)}</span></div><div className="flex items-center justify-between text-xl font-bold"><span>{tc("total")}</span><span>{formatCurrency(cartTotal, locale)}</span></div>{submitError && <p role="alert" className="text-sm font-medium text-destructive">{submitError}</p>}<Button type="button" size="lg" className="min-h-14 w-full text-base" disabled={cart.length === 0 || mutation.isPending} onClick={submitOrder}>{mutation.isPending ? t("creatingOrder") : t("sendOrder")}</Button></div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Dialog open={Boolean(configuringItem)} onOpenChange={(open) => { if (!open) setConfiguringItem(null); }}>
        <DialogContent className="max-w-2xl p-0"><DialogHeader className="border-b p-5 pe-12 text-start"><DialogTitle className="text-xl">{configuringItem && displayName(configuringItem)}</DialogTitle><DialogDescription>{configuringItem && secondaryName(configuringItem)}</DialogDescription></DialogHeader>{configuringItem && <div className="space-y-6 px-5 pb-2">
          {configuringItem.variants.filter((variant) => variant.is_available).length > 0 && <fieldset><legend className="mb-3 font-semibold">{t("chooseVariant")}</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{configuringItem.variants.filter((variant) => variant.is_available).map((variant) => <Button key={variant.id} type="button" variant={variantId === variant.id ? "default" : "outline"} className="min-h-14 flex-col gap-0" aria-pressed={variantId === variant.id} onClick={() => setVariantId(variant.id)}><span>{displayName(variant)}</span><span className="text-xs opacity-80">{formatCurrency(variant.price, locale)}</span></Button>)}</div></fieldset>}
          {configuringItem.modifierGroups.filter((link) => link.modifierGroup.is_active).map((link) => { const group = link.modifierGroup; return <fieldset key={group.id}><div className="mb-3 flex items-center justify-between gap-2"><legend className="font-semibold">{displayName(group)}</legend><span className="text-xs text-muted-foreground">{group.min_selections > 0 ? t("requiredSelections", { min: group.min_selections, max: group.max_selections }) : t("optionalSelections", { max: group.max_selections })}</span></div><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{group.options.filter((option) => option.is_available).map((option) => { const selected = modifierIds.includes(option.id); return <Button key={option.id} type="button" variant={selected ? "default" : "outline"} className="min-h-12 justify-between whitespace-normal text-start" aria-pressed={selected} onClick={() => toggleModifier(group, option.id)}><span>{displayName(option)}</span><span>{option.price_delta > 0 ? `+${formatCurrency(option.price_delta, locale)}` : t("included")}</span></Button>; })}</div></fieldset>; })}
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]"><div><Label className="mb-2 block">{t("quantity")}</Label><div className="flex items-center"><Button type="button" variant="outline" size="icon" className="h-12 w-12" disabled={itemQuantity <= 1} onClick={() => setItemQuantity((value) => Math.max(1, value - 1))}><MinusIcon /></Button><span className="w-14 text-center text-xl font-bold">{itemQuantity}</span><Button type="button" variant="outline" size="icon" className="h-12 w-12" onClick={() => setItemQuantity((value) => value + 1)}><PlusIcon /></Button></div></div><div><Label htmlFor="kitchen-notes" className="mb-2 block">{t("kitchenNotes")}</Label><textarea id="kitchen-notes" className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={itemNotes} onChange={(event) => setItemNotes(event.target.value)} maxLength={500} placeholder={t("kitchenNotesPlaceholder")} /></div></div>
          {configurationError && <p role="alert" className="text-sm font-medium text-destructive">{configurationError}</p>}
        </div>}<DialogFooter className="border-t p-5"><Button type="button" variant="outline" className="min-h-11" onClick={() => setConfiguringItem(null)}>{tc("cancel")}</Button><Button type="button" className="min-h-11" onClick={saveConfiguredItem}>{editingKey ? t("updateCartItem") : t("addToCart")}</Button></DialogFooter></DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={clearOpen} onOpenChange={setClearOpen} title={t("clearCartTitle")} description={t("clearCartDescription")} confirmLabel={t("clearCart")} onConfirm={() => { setCart([]); setClearOpen(false); }} />
    </div>
  );
}

function POSLoading() {
  return <div className="mx-auto max-w-[1600px] space-y-4"><Skeleton className="h-44 w-full rounded-xl" /><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]"><div className="space-y-3"><Skeleton className="h-28 w-full rounded-xl" /><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-40 rounded-xl" />)}</div></div><Skeleton className="h-[520px] rounded-xl" /></div></div>;
}

function POSCheckoutDialog({
  open,
  onOpenChange,
  orderId,
  subtotal,
  branchId,
  role,
  paymentMethods: methods,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: number;
  subtotal: number;
  branchId: number;
  role: "owner" | "admin" | "manager" | "cashier";
  paymentMethods: Array<{ id: number; code: string | null; name: string; affects_drawer: boolean }>;
  onSuccess: (result: CheckoutResult) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const t = useTranslations("pos");
  const tc = useTranslations("common");
  const [discountType, setDiscountType] = useState<"none" | "percentage" | "fixed">("none");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [cashReceived, setCashReceived] = useState("");
  const [requestId] = useState(createRequestId);
  const [error, setError] = useState("");

  const discountInput = discountType === "none" ? null : {
    type: discountType,
    value: discountType === "percentage" ? Math.round(Number(discountValue || 0) * 100) : Math.round(Number(discountValue || 0) * 100),
    reason: discountReason,
  } as const;
  let discountAmount = 0;
  try { discountAmount = calculateDiscount(subtotal, discountInput); } catch { discountAmount = 0; }
  const payable = subtotal - discountAmount;
  const allocated = methods.reduce((sum, method) => sum + Math.round(Number(allocations[method.id] || 0) * 100), 0);
  const remaining = payable - allocated;
  const cashMethod = methods.find((method) => method.affects_drawer);
  const cashAllocation = cashMethod ? Math.round(Number(allocations[cashMethod.id] || 0) * 100) : 0;
  const cashTendered = Math.round(Number(cashReceived || 0) * 100);
  const changeDue = Math.max(0, cashTendered - cashAllocation);
  const canDiscount = role !== "cashier";

  const mutation = useMutation(trpc.checkout.pay.mutationOptions({
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.orders.list.queryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: trpc.shifts.context.queryOptions({ branchId }).queryKey }),
        queryClient.invalidateQueries({ queryKey: trpc.printing.options.queryOptions({ orderId }).queryKey }),
      ]);
      onSuccess(result);
    },
    onError: (cause) => setError(cause.message),
  }));

  const setFullPayment = (methodId: number) => {
    setAllocations({ [methodId]: (payable / 100).toFixed(2) });
    const method = methods.find((entry) => entry.id === methodId);
    setCashReceived(method?.affects_drawer ? (payable / 100).toFixed(2) : "");
  };

  const confirm = () => {
    setError("");
    if (discountType !== "none" && !canDiscount) { setError(t("permissionDenied")); return; }
    let serverDiscount: { type: "percentage" | "fixed"; value: number; reason: string } | null = null;
    if (discountInput) {
      try {
        calculateDiscount(subtotal, discountInput);
        serverDiscount = discountInput;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("invalidDiscount"));
        return;
      }
    }
    const payments = methods.flatMap((method) => {
      const amount = Math.round(Number(allocations[method.id] || 0) * 100);
      if (amount <= 0) return [];
      return [{ paymentMethodId: method.id, amount, tenderedAmount: method.affects_drawer ? cashTendered || amount : null }];
    });
    mutation.mutate({ orderId, idempotencyKey: requestId, discount: serverDiscount, payments });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[95vh] max-w-2xl overflow-y-auto p-0">
      <DialogHeader className="border-b p-5 text-start"><DialogTitle>{t("checkoutTitle")}</DialogTitle><DialogDescription>{t("checkoutOrderNumber", { number: orderId })}</DialogDescription></DialogHeader>
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("subtotal")}</p><strong>{formatCurrency(subtotal, locale)}</strong></div><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("discount")}</p><strong>{formatCurrency(discountAmount, locale)}</strong></div><div className="rounded-lg border border-primary p-3"><p className="text-xs text-muted-foreground">{t("payable")}</p><strong className="text-primary">{formatCurrency(payable, locale)}</strong></div></div>

        <fieldset className="space-y-3"><legend className="font-semibold">{t("discountAuthorization")}</legend><Select value={discountType} onValueChange={(value) => setDiscountType(value as typeof discountType)} disabled={!canDiscount}><SelectTrigger className="min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t("noDiscount")}</SelectItem><SelectItem value="percentage">{t("percentageDiscount")}</SelectItem><SelectItem value="fixed">{t("fixedDiscount")}</SelectItem></SelectContent></Select>{discountType !== "none" && <div className="grid gap-3 sm:grid-cols-2"><Input aria-label={discountType === "percentage" ? t("discountPercent") : t("discountAmount")} className="min-h-11" inputMode="decimal" label={discountType === "percentage" ? t("discountPercent") : t("discountAmount")} value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} /><Input aria-label={t("discountReason")} className="min-h-11" label={t("discountReason")} value={discountReason} onChange={(event) => setDiscountReason(event.target.value)} /></div>}{!canDiscount && <p className="text-sm text-muted-foreground">{t("managerApprovalRequired")}</p>}</fieldset>

        <fieldset className="space-y-3"><legend className="font-semibold">{t("paymentAllocation")}</legend>{methods.map((method) => <div key={method.id} className="grid grid-cols-[1fr_140px_auto] items-end gap-2 rounded-lg border p-3"><div><p className="font-medium">{method.name}</p><button type="button" className="text-sm text-primary underline" onClick={() => setFullPayment(method.id)}>{t("payFull")}</button></div><Input aria-label={`${method.name} ${t("allocation")}`} inputMode="decimal" value={allocations[method.id] ?? ""} onChange={(event) => setAllocations((current) => ({ ...current, [method.id]: event.target.value }))} /><span className="pb-3 text-sm">EGP</span></div>)}</fieldset>

        {cashAllocation > 0 && <div className="grid gap-3 rounded-lg bg-muted p-4 sm:grid-cols-2"><Input aria-label={t("cashReceived")} className="min-h-11" inputMode="decimal" label={t("cashReceived")} value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /><div><p className="text-sm text-muted-foreground">{t("changeDue")}</p><p className="text-xl font-bold">{formatCurrency(changeDue, locale)}</p></div></div>}
        <div className={`rounded-lg p-3 text-center font-semibold ${remaining === 0 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{remaining === 0 ? t("allocationComplete") : t("remainingAmount", { amount: formatCurrency(remaining, locale) })}</div>
        {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter className="border-t p-5"><Button variant="outline" className="min-h-12" onClick={() => onOpenChange(false)}>{tc("cancel")}</Button><Button className="min-h-12" disabled={mutation.isPending || remaining !== 0 || allocated <= 0 || (cashAllocation > 0 && cashTendered < cashAllocation)} onClick={confirm}>{mutation.isPending ? t("confirmingPayment") : t("confirmCheckout")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
