"use client";

import { use } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Badge } from "@forno/ui/components/badge";
import { Button } from "@forno/ui/components/button";
import { Skeleton } from "@forno/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@forno/ui/components/table";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations, useLocale } from "next-intl";
import { formatCurrency } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc/router";

type OrderItem = NonNullable<RouterOutputs["orders"]["get"]>["orderItems"][number];

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const orderId = parseInt(id);
  const trpc = useTRPC();
  const { data: order, isLoading } = useQuery(trpc.orders.get.queryOptions({ id: orderId }));
  const t = useTranslations("orders");
  const tc = useTranslations("common");
  const locale = useLocale();
  const isArabic = locale === "ar";

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Card><CardContent className="p-6 space-y-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</CardContent></Card>
      </div>
    );
  }

  if (!order) {
    return <div className="text-muted-foreground">{t("orderNotFound")}</div>;
  }

  const statusColor = order.status === "completed" ? "text-green-600" : order.status === "cancelled" ? "text-red-600" : "text-yellow-600";
  const statusLabel = order.status === "completed" ? tc("completed") : order.status === "cancelled" ? tc("cancelled") : tc("pending");

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link href="/admin/orders">
          <Button variant="ghost" size="icon"><ArrowLeftIcon className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{t("orderDetails")} #{order.id}</h1>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t("orderDetails")}</CardTitle>
            <span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-muted-foreground">{t("customer")}</dt>
              <dd className="font-medium">{order.customer?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{tc("total")}</dt>
              <dd className="text-lg font-bold">{formatCurrency(order.total_amount, locale)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("createdAt")}</dt>
              <dd>{order.created_at ? new Date(order.created_at).toLocaleString() : "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {order.orderItems && order.orderItems.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t("items")}</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("product")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{tc("category")}</TableHead>
                    <TableHead>{t("quantity")}</TableHead>
                    <TableHead>{t("unitPrice")}</TableHead>
                    <TableHead>{t("subtotal")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.orderItems.map((item: OrderItem) => {
                    const modifierTotal = item.modifiers.reduce((sum, modifier) => sum + modifier.price_delta, 0);
                    const itemName = item.menuItem
                      ? (isArabic ? item.menuItem.name_ar : item.menuItem.name_en)
                      : item.product?.name ?? `#${item.product_id}`;
                    const variantName = item.variant
                      ? (isArabic ? item.variant.name_ar : item.variant.name_en)
                      : null;
                    return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">
                        <div>{itemName}{variantName ? ` · ${variantName}` : ""}</div>
                        {item.modifiers.length > 0 && (
                          <div className="mt-1 text-xs font-normal text-muted-foreground">
                            {item.modifiers.map((modifier) => isArabic ? modifier.name_ar : modifier.name_en).join("، ")}
                          </div>
                        )}
                        {item.notes && <div className="mt-1 text-xs font-normal text-muted-foreground">{item.notes}</div>}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {item.product?.category ? <Badge variant="outline">{item.product.category}</Badge> : "—"}
                      </TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{formatCurrency(item.price + modifierTotal, locale)}</TableCell>
                      <TableCell className="font-medium">{formatCurrency((item.price + modifierTotal) * item.quantity, locale)}</TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
