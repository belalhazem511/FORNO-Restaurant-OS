"use client";

import { useEffect, useMemo, useState } from "react";
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
import { useOffline } from "@/components/offline/offline-provider";
import { OfflineReceiptAction } from "@/components/offline/offline-receipt-action";
import { buildOfflineKots, buildOfflineSummary } from "@/lib/offline/documents";
import { createQueueEntry, snapshotAgeState } from "@/lib/offline/queue";
import { newOfflineId, type OfflineKotDocument } from "@/lib/offline/types";
import { ItemConfiguratorDialog } from "./item-configurator-dialog";
import { POSCheckoutDialog } from "./checkout-dialog";
import { OfflineCashDialog, OfflineKotDialog, type OfflineSuccess } from "./offline-dialogs";
import { createRequestId } from "./request-id";
import { ProductImage } from "@/components/products/product-image";

type RestaurantBranch = RouterOutputs["restaurant"]["model"][number];
type MenuCategory = RestaurantBranch["menuCategories"][number];
type MenuItem = MenuCategory["menuItems"][number];
type OrderType = "dine_in" | "takeaway" | "delivery";
type CheckoutResult = RouterOutputs["checkout"]["pay"];

export function PosScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const isArabic = locale.startsWith("ar");
  const t = useTranslations("pos");
  const tc = useTranslations("common");
  const offline = useOffline();

  const restaurantQuery = useQuery(trpc.restaurant.model.queryOptions());
  const customersQuery = useQuery(trpc.customers.list.queryOptions());
  const branches = restaurantQuery.data ?? [];
  const onlineBranch = branches.find((entry) => entry.is_active) ?? branches[0];
  const cachedSnapshot = offline.snapshots.find((entry) => entry.version === 2 && entry.userId === offline.userId && (!onlineBranch || entry.branch.id === onlineBranch.id)) ?? null;
  const branch = onlineBranch ?? cachedSnapshot?.branch;
  const isOfflineMode = !offline.serverReachable;
  const customers = customersQuery.data ?? [];
  const shiftContextQuery = useQuery({
    ...trpc.shifts.context.queryOptions({ branchId: branch?.id ?? 0 }),
    enabled: Boolean(branch),
  });
  const bootstrapQuery = useQuery({
    ...trpc.offline.bootstrap.queryOptions({ branchId: onlineBranch?.id ?? 0 }),
    enabled: Boolean(onlineBranch && offline.serverReachable),
  });
  const availabilityQuery = useQuery({
    ...trpc.inventory.availability.queryOptions({ branchId: onlineBranch?.id ?? 0 }),
    enabled: Boolean(onlineBranch && offline.serverReachable),
  });
  useEffect(() => {
    if (bootstrapQuery.data) void offline.cacheSnapshot(bootstrapQuery.data);
  }, [bootstrapQuery.data]);

  const [orderType, setOrderType] = useState<OrderType>("takeaway");
  const [areaId, setAreaId] = useState<number | null>(null);
  const [tableId, setTableId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryName, setDeliveryName] = useState("");
  const [deliveryPhone, setDeliveryPhone] = useState("");
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
  const [offlineSuccess, setOfflineSuccess] = useState<OfflineSuccess | null>(null);
  const [offlineCashOpen, setOfflineCashOpen] = useState(false);
  const [previewKot, setPreviewKot] = useState<OfflineKotDocument | null>(null);

  const [configuringItem, setConfiguringItem] = useState<MenuItem | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [modifierIds, setModifierIds] = useState<number[]>([]);
  const [itemQuantity, setItemQuantity] = useState(1);
  const [itemNotes, setItemNotes] = useState("");
  const [configurationError, setConfigurationError] = useState<string | null>(null);

  const configurations = useMemo(() => {
    const requested = cart.filter((line) => line.key !== editingKey).map((line) => ({ menuItemId: line.menuItemId, variantId: line.variantId, modifierOptionIds: line.modifiers.map((modifier) => modifier.id), quantity: line.quantity }));
    if (configuringItem) {
      requested.push({ menuItemId: configuringItem.id, variantId, modifierOptionIds: [...modifierIds], quantity: itemQuantity });
      for (const link of configuringItem.modifierGroups) for (const option of link.modifierGroup.options.filter((entry) => entry.is_available)) {
        const selected = modifierIds.includes(option.id);
        const candidateIds = selected
          ? modifierIds.filter((id) => id !== option.id)
          : link.modifierGroup.max_selections === 1
            ? [...modifierIds.filter((id) => !link.modifierGroup.options.some((entry) => entry.id === id)), option.id]
            : [...modifierIds, option.id];
        requested.push({ menuItemId: configuringItem.id, variantId, modifierOptionIds: candidateIds, quantity: itemQuantity });
      }
    }
    return requested;
  }, [cart, configuringItem, editingKey, itemQuantity, modifierIds, variantId]);
  const configurationAvailabilityQuery = useQuery({
    ...trpc.inventory.availability.queryOptions({ branchId: onlineBranch?.id ?? 0, configurations }),
    enabled: Boolean(onlineBranch && offline.serverReachable),
  });
  const detailedAvailability = isOfflineMode ? cachedSnapshot?.availability ?? [] : configurationAvailabilityQuery.data ?? availabilityQuery.data ?? [];
  const configuredAvailability = (menuItemId: number, selectedVariantId: number | null, selectedModifiers: number[]) => detailedAvailability.filter((row) => row.menuItemId === menuItemId && row.variantId === selectedVariantId && [...(row.modifierOptionIds ?? [])].sort((a, b) => a - b).join(",") === [...selectedModifiers].sort((a, b) => a - b).join(",")).at(-1);
  const selectedAvailability = configuredAvailability(configuringItem?.id ?? 0, variantId, modifierIds);
  const candidateAvailability = (optionId: number, group: MenuItem["modifierGroups"][number]["modifierGroup"]) => {
    if (!configuringItem) return undefined;
    const groupIds = new Set(group.options.map((option) => option.id));
    const selected = modifierIds.includes(optionId);
    const candidateIds = selected ? modifierIds.filter((id) => id !== optionId) : group.max_selections === 1 ? [...modifierIds.filter((id) => !groupIds.has(id)), optionId] : [...modifierIds, optionId];
    return configuredAvailability(configuringItem.id, variantId, candidateIds);
  };
  const cartConfigurationQuantity = (line: CartLine) => cart.filter((entry) => entry.menuItemId === line.menuItemId && entry.variantId === line.variantId && [...entry.modifiers.map((modifier) => modifier.id)].sort((a, b) => a - b).join(",") === [...line.modifiers.map((modifier) => modifier.id)].sort((a, b) => a - b).join(",")).reduce((sum, entry) => sum + entry.quantity, 0);

  const categories = useMemo(
    () => [...(branch?.menuCategories ?? [])].filter((category) => category.is_active)
      .sort((a, b) => a.sort_order - b.sort_order),
    [branch],
  );
  const menuItems = useMemo(() => categories.flatMap((category) => category.menuItems), [categories]);
  const availability = isOfflineMode ? cachedSnapshot?.availability ?? [] : availabilityQuery.data ?? [];
  const inventoryStatus = (menuItemId: number, variantId: number | null) => availability.find((row) => row.menuItemId === menuItemId && row.variantId === variantId && row.requestedQuantity === 1 && !(row.modifierOptionIds?.length))?.status ?? "unavailable";
  const inventoryAllows = (menuItemId: number, variantId: number | null) => ["available", "low_stock"].includes(inventoryStatus(menuItemId, variantId));
  const itemInventoryStatus = (item: MenuItem) => {
    if (!item.is_available) return "manually_disabled";
    const statuses = item.variants.length ? item.variants.map((variant) => inventoryStatus(item.id, variant.id)) : [inventoryStatus(item.id, null)];
    return statuses.includes("available") ? "available" : statuses.includes("low_stock") ? "low_stock" : statuses[0] ?? "unavailable";
  };
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
    const availableVariants = item.variants.filter((variant) => variant.is_available && inventoryAllows(item.id, variant.id));
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

    if (!isOfflineMode && (!selectedAvailability || selectedAvailability.status === "unavailable" || selectedAvailability.status === "recipe_missing" || selectedAvailability.status === "manually_disabled")) {
      const names = selectedAvailability?.blockingIngredients?.map((ingredient) => isArabic ? ingredient.nameAr : ingredient.nameEn).join(isArabic ? "، " : ", ");
      setConfigurationError(names || t("stockUnavailableReason"));
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

  const submitOrder = async () => {
    setContextError(null);
    setSubmitError(null);
    if (!branch || cart.length === 0) {
      setContextError(t(cart.length === 0 ? "cartEmptyError" : "branchUnavailable"));
      return;
    }
    try {
      if (isOfflineMode && orderType === "delivery") {
        if (!deliveryAddress.trim() || deliveryName.trim().length < 2 || deliveryPhone.trim().length < 6) throw new Error("offline-delivery");
      } else validateOrderFulfilment({ orderType, diningTableId: tableId, deliveryAddress, customerId });
    } catch {
      if (orderType === "dine_in") setContextError(t("tableRequired"));
      else if (orderType === "delivery" && !customerId) setContextError(t("deliveryCustomerRequired"));
      else setContextError(t("deliveryAddressRequired"));
      return;
    }
    if (isOfflineMode) {
      if (!cachedSnapshot || !offline.userId || snapshotAgeState(cachedSnapshot) === "expired") {
        setContextError(isArabic ? "يلزم اتصال سابق ونسخة نقطة بيع صالحة ووردية نشطة." : "A previous online sign-in, valid POS snapshot, and active cached shift are required.");
        return;
      }
      const operationId = newOfflineId("offline-order");
      const orderReference = clientRequestId.slice(0, 12).toUpperCase();
      const kots = buildOfflineKots({ operationId, orderReference, orderType, tableId, cart, snapshot: cachedSnapshot });
      const payload: OfflineSuccess["payload"] = {
        kind: "order",
        clientOperationId: operationId,
          snapshotRevision: cachedSnapshot.revision,
          priceSnapshotReference: cachedSnapshot.priceSnapshot.reference,
          priceSnapshotRevision: cachedSnapshot.priceSnapshot.revision,
        branchId: cachedSnapshot.branch.id,
        registerId: cachedSnapshot.register.id,
        shiftId: cachedSnapshot.shift.id,
        order: {
          clientRequestId,
          orderType,
          diningTableId: orderType === "dine_in" ? tableId : null,
          deliveryAddress: orderType === "delivery" ? deliveryAddress : null,
          deliveryContact: orderType === "delivery" ? { name: deliveryName, phone: deliveryPhone } : null,
          expectedTotal: cartTotal,
          items: cart.map((line) => ({ menuItemId: line.menuItemId, variantId: line.variantId, modifierOptionIds: line.modifiers.map((modifier) => modifier.id), quantity: line.quantity, notes: line.notes || null })),
        },
        cash: null,
        offlineReceipt: null,
        kotAcknowledgements: kots.map((kot) => ({ stationId: kot.stationId, idempotencyKey: kot.id, previewed: true, acknowledged: false })),
      };
      await offline.enqueue(createQueueEntry({ payload, userId: offline.userId }), [
        ...kots.map((kot) => ({ ...kot, previewed: true })),
        buildOfflineSummary({ operationId, orderReference, orderType, cart, provisionalTotal: cartTotal, cashReceived: null }),
      ]);
      setOfflineSuccess({ operationId, orderReference, payload, kots, provisionalTotal: cartTotal, cashReceived: null, cart: structuredClone(cart), areaId, tableId, delivery: orderType === "delivery" ? { name: deliveryName, phone: deliveryPhone, address: deliveryAddress } : null, receipt: null });
      setCart([]);
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
    setOfflineSuccess(null);
    setOfflineCashOpen(false);
    setPreviewKot(null);
    setOrderType("takeaway");
    setAreaId(null);
    setTableId(null);
    setCustomerId(null);
    setDeliveryAddress("");
    setContextError(null);
    setSubmitError(null);
    setClientRequestId(createRequestId());
  };

  if ((restaurantQuery.isLoading || customersQuery.isLoading) && !cachedSnapshot) {
    return <POSLoading />;
  }

  if ((restaurantQuery.error || customersQuery.error) && !cachedSnapshot) {
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

  if (offlineSuccess) {
    const synced = offline.queue.find((entry) => entry.id === offlineSuccess.operationId);
    return <>
      <Card className="mx-auto max-w-2xl border-amber-500/50">
        <CardContent className="space-y-5 p-7 text-center">
          <Badge className="bg-amber-500 text-black">OFFLINE — PENDING SYNC</Badge>
          <div><h2 className="text-2xl font-bold">{isArabic ? "طلب دون اتصال محفوظ بأمان" : "Offline order stored safely"}</h2><p className="text-muted-foreground">{offlineSuccess.receipt ? (isArabic ? "تم استلام النقد محلياً. الإيصال النقدي دون اتصال متاح الآن والمزامنة ما زالت معلقة." : "Cash was received locally. The Offline Cash Receipt is available now and server synchronization is still pending.") : (isArabic ? "هذا ملخص طلب غير مدفوع وليس إيصالاً نهائياً." : "This is an unpaid pending order summary, not a final receipt.")}</p></div>
          <p className="font-mono text-sm">{offlineSuccess.orderReference}</p>
          <div className="grid gap-2 sm:grid-cols-3">{offlineSuccess.kots.map((kot) => <Button key={kot.id} variant="outline" className="min-h-12" onClick={() => setPreviewKot(kot)}>{isArabic ? kot.station.name_ar : kot.station.name_en} KOT</Button>)}</div>
          {synced?.state === "synced" ? <div className="rounded-lg bg-emerald-50 p-4 text-emerald-900"><p className="font-bold">{isArabic ? "تمت المزامنة" : "Synchronized"}</p><Link className="underline" href={`/admin/orders/${synced.authoritativeOrderId}`}>{isArabic ? `الطلب الرسمي #${synced.authoritativeOrderId}` : `Authoritative order #${synced.authoritativeOrderId}`}</Link></div> : <div className="rounded-lg bg-amber-50 p-4 text-amber-900">{isArabic ? "سيعيد الخادم التحقق من النسخة السعرية الآمنة قبل القبول." : "The server will verify the secure issued price snapshot before acceptance."}</div>}
          {!offlineSuccess.cashReceived && synced?.state !== "synced" && <Button size="lg" className="min-h-14 w-full" onClick={() => setOfflineCashOpen(true)}>{isArabic ? "دفع نقدي دون اتصال" : "Offline cash checkout"}</Button>}
          {offlineSuccess.receipt && <OfflineReceiptAction documentId={offlineSuccess.receipt.id} label={isArabic ? "طباعة إيصال نقدي دون اتصال" : "Print Offline Cash Receipt"} />}
          <div className="flex flex-wrap justify-center gap-2"><Button onClick={startNewOrder}>{isArabic ? "طلب جديد" : "New order"}</Button><Button variant="outline" asChild><Link href="/admin/sync">{isArabic ? "مركز المزامنة" : "Sync Center"}</Link></Button></div>
        </CardContent>
      </Card>
      {cachedSnapshot && <OfflineCashDialog open={offlineCashOpen} onOpenChange={setOfflineCashOpen} sale={offlineSuccess} snapshot={cachedSnapshot} onQueued={(receipt) => { setOfflineSuccess((current) => current ? { ...current, cashReceived: receipt.financial.cashReceived, receipt } : current); setOfflineCashOpen(false); }} />}
      <OfflineKotDialog document={previewKot} onOpenChange={(open) => { if (!open) setPreviewKot(null); }} />
    </>;
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
      {isOfflineMode && <div role="status" className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-950"><strong>{isArabic ? "وضع عدم الاتصال" : "Offline mode"}</strong><p className="text-sm">{isArabic ? "النقد فقط. الأسعار مؤقتة وسيعيد الخادم التحقق منها. البطاقات وإنستاباي والتقسيم والخصومات والإلغاء والاسترداد والوردية وإعادة الطباعة معطلة." : "Cash only. Prices are provisional and will be revalidated. Card, InstaPay, split, discounts, cancellation, refund, shift changes, and reprints are disabled."}</p>{cachedSnapshot && <p className="mt-1 text-xs">{isArabic ? "حالة النسخة" : "Snapshot"}: {snapshotAgeState(cachedSnapshot)}</p>}</div>}
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
              <SelectTrigger id="pos-customer" className="min-h-11" disabled={isOfflineMode}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="walk-in">{t("walkInCustomer")}</SelectItem>{customers.map((customer) => <SelectItem key={customer.id} value={customer.id.toString()}>{customer.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {orderType === "delivery" && <Input id="delivery-address" className="min-h-11" label={t("deliveryAddress")} value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder={t("deliveryAddressPlaceholder")} />}
          {orderType === "delivery" && isOfflineMode && <><Input className="min-h-11" label={isArabic ? "اسم العميل المؤقت" : "Delivery contact name"} value={deliveryName} onChange={(event) => setDeliveryName(event.target.value)} /><Input className="min-h-11" label={isArabic ? "هاتف التوصيل" : "Delivery phone"} value={deliveryPhone} onChange={(event) => setDeliveryPhone(event.target.value)} /></>}
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
                const availableVariants = item.variants.filter((variant) => variant.is_available && inventoryAllows(item.id, variant.id));
                const fromPrice = availableVariants.length > 0 ? Math.min(...availableVariants.map((variant) => variant.price)) : item.base_price;
                const stockStatus = itemInventoryStatus(item);
                const sellable = item.is_available && ["available", "low_stock"].includes(stockStatus);
                const availabilityReason = availability.find((row) => row.menuItemId === item.id && row.status !== "available" && row.status !== "low_stock") ?? availability.find((row) => row.menuItemId === item.id);
                const blockedNames = availabilityReason?.blockingIngredients?.map((ingredient) => isArabic ? ingredient.nameAr : ingredient.nameEn) ?? [];
                return <button key={item.id} type="button" disabled={!sellable} onClick={() => openConfigurator(item)} className="group min-h-40 rounded-xl border bg-card p-4 text-start shadow-sm transition hover:-translate-y-0.5 hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
                  <div className="flex h-full flex-col justify-between gap-4"><div className="flex items-start gap-3"><ProductImage imageKey={item.product?.image_key} alt={displayName(item)} className="h-16 w-16 shrink-0 rounded-md object-cover" /><div className="min-w-0"><div className="mb-2 flex items-start justify-between gap-2"><h3 className="font-bold leading-tight">{displayName(item)}</h3><Badge variant={sellable ? "outline" : "destructive"}>{t(`availability.${stockStatus}`)}</Badge></div><p className="text-xs text-muted-foreground" dir={isArabic ? "ltr" : "rtl"}>{secondaryName(item)}</p>{!sellable && <p className="mt-2 text-xs text-destructive">{stockStatus === "recipe_missing" ? t("recipeMissingReason") : stockStatus === "manually_disabled" ? t("manuallyDisabledReason") : t("unavailableIngredients", { ingredients: blockedNames.join(isArabic ? "، " : ", ") || t("stockUnavailableReason") })}</p>}</div></div><div className="flex items-end justify-between gap-2"><strong className="text-base text-primary">{availableVariants.length > 1 ? t("fromPrice", { price: formatCurrency(fromPrice, locale) }) : formatCurrency(fromPrice, locale)}</strong>{(availableVariants.length > 0 || item.modifierGroups.length > 0) && <ChevronDownIcon className="h-5 w-5 text-muted-foreground transition group-hover:text-primary" />}</div></div>
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
                {cart.map((line) => { const lineAvailability = configuredAvailability(line.menuItemId, line.variantId, line.modifiers.map((modifier) => modifier.id)); const groupQuantity = cartConfigurationQuantity(line); return <div key={line.key} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{isArabic ? line.nameAr : line.nameEn}</h3>{line.variantId && <p className="text-xs text-muted-foreground">{isArabic ? line.variantNameAr : line.variantNameEn}</p>}{line.modifiers.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{line.modifiers.map((modifier) => isArabic ? modifier.nameAr : modifier.nameEn).join("، ")}</p>}{line.notes && <p className="mt-1 rounded bg-muted px-2 py-1 text-xs">{t("notesLabel", { notes: line.notes })}</p>}</div><strong className="shrink-0">{formatCurrency(calculateLineTotal(line), locale)}</strong></div><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-1"><Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label={t("decreaseQuantity")} onClick={() => setCart((current) => setCartLineQuantity(current, line.key, line.quantity - 1))}><MinusIcon /></Button><span className="w-10 text-center text-lg font-bold tabular-nums">{line.quantity}</span><Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label={t("increaseQuantity")} title={lineAvailability && groupQuantity >= lineAvailability.maxProducibleQuantity ? t("maximumAvailability", { quantity: lineAvailability.maxProducibleQuantity }) : undefined} disabled={!lineAvailability || groupQuantity >= lineAvailability.maxProducibleQuantity} onClick={() => setCart((current) => setCartLineQuantity(current, line.key, line.quantity + 1))}><PlusIcon /></Button></div><div className="flex"><Button type="button" variant="ghost" size="icon" className="h-10 w-10" aria-label={tc("edit")} onClick={() => { const item = menuItems.find((entry) => entry.id === line.menuItemId); if (item) openConfigurator(item, line); }}><PencilIcon /></Button><Button type="button" variant="ghost" size="icon" className="h-10 w-10 text-destructive" aria-label={tc("remove")} onClick={() => setCart((current) => current.filter((entry) => entry.key !== line.key))}><Trash2Icon /></Button></div></div>{lineAvailability?.blockingIngredients?.length ? <p role="status" className="text-xs text-destructive">{lineAvailability.blockingIngredients.map((ingredient) => isArabic ? ingredient.nameAr : ingredient.nameEn).join(isArabic ? "، " : ", ")}</p> : null}<p className="text-xs text-muted-foreground">{formatCurrency(calculateUnitPrice(line), locale)} × {line.quantity}</p></div>; })}
              </div>}
              <div className="space-y-3 border-t bg-muted/30 p-4"><div className="flex items-center justify-between text-sm"><span>{t("subtotal")}</span><span>{formatCurrency(cartTotal, locale)}</span></div><div className="flex items-center justify-between text-xl font-bold"><span>{tc("total")}</span><span>{formatCurrency(cartTotal, locale)}</span></div>{submitError && <p role="alert" className="text-sm font-medium text-destructive">{submitError}</p>}<Button type="button" size="lg" className="min-h-14 w-full text-base" disabled={cart.length === 0 || mutation.isPending} onClick={submitOrder}>{mutation.isPending ? t("creatingOrder") : t("sendOrder")}</Button></div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <ItemConfiguratorDialog item={configuringItem} editingKey={editingKey} variantId={variantId} modifierIds={modifierIds} quantity={itemQuantity} notes={itemNotes} error={configurationError} inventoryStatus={inventoryStatus} inventoryAllows={inventoryAllows} variantReason={(menuItemId, id) => { const row = availability.find((entry) => entry.menuItemId === menuItemId && entry.variantId === id); const names = row?.blockingIngredients?.map((ingredient) => isArabic ? ingredient.nameAr : ingredient.nameEn).join(isArabic ? "، " : ", "); return names || t(`availability.${row?.status ?? "unavailable"}`); }} optionAllows={(id, group) => { if (isOfflineMode) return true; const result = candidateAvailability(id, group); return Boolean(result && ["available", "low_stock"].includes(result.status)); }} optionReason={(id, group) => candidateAvailability(id, group)?.blockingIngredients?.map((ingredient) => isArabic ? ingredient.nameAr : ingredient.nameEn).join(isArabic ? "، " : ", ") ?? t("stockUnavailableReason")} maximumQuantity={isOfflineMode ? 1_000_000 : selectedAvailability?.maxProducibleQuantity ?? 0} onClose={() => setConfiguringItem(null)} onVariantChange={setVariantId} onToggleModifier={toggleModifier} onQuantityChange={setItemQuantity} onNotesChange={setItemNotes} onSave={saveConfiguredItem} />

      <DeleteConfirmationDialog open={clearOpen} onOpenChange={setClearOpen} title={t("clearCartTitle")} description={t("clearCartDescription")} confirmLabel={t("clearCart")} onConfirm={() => { setCart([]); setClearOpen(false); }} />
    </div>
  );
}

function POSLoading() {
  return <div className="mx-auto max-w-[1600px] space-y-4"><Skeleton className="h-44 w-full rounded-xl" /><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]"><div className="space-y-3"><Skeleton className="h-28 w-full rounded-xl" /><div className="grid grid-cols-2 gap-3 md:grid-cols-3">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-40 rounded-xl" />)}</div></div><Skeleton className="h-[520px] rounded-xl" /></div></div>;
}
