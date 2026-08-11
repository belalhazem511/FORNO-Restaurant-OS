"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@forno/ui/components/card";
import { EyeIcon, ShoppingCartIcon } from "lucide-react";
import { Button } from "@forno/ui/components/button";
import Link from "next/link";
import { Skeleton } from "@forno/ui/components/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { DataTable, TableActions, type Column, type ExportColumn } from "@forno/ui/components/data-table";
import { SearchFilter, type FilterOption } from "@forno/ui/components/search-filter";
import type { RouterOutputs } from "@/lib/trpc/router";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/utils";

type Order = RouterOutputs["orders"]["list"][number];

export default function OrdersPage() {
  const trpc = useTRPC();
  const { data: orders = [], isLoading, error } = useQuery(trpc.orders.list.queryOptions());
  const t = useTranslations("orders");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const statusFilterOptions: FilterOption[] = [
    { label: tc("all"), value: "all" },
    { label: tc("completed"), value: "completed", variant: "success" },
    { label: tc("pending"), value: "pending", variant: "warning" },
    { label: tc("cancelled"), value: "cancelled", variant: "danger" },
  ];
  const filteredOrders = useMemo(() => orders.filter((order) => {
    if (statusFilter !== "all" && order.status !== statusFilter) return false;
    const query = searchTerm.toLowerCase();
    return (order.customer?.name ?? "").toLowerCase().includes(query) || order.id.toString().includes(query);
  }), [orders, searchTerm, statusFilter]);
  const columns: Column<Order>[] = [
    { key: "id", header: t("orderId"), sortable: true },
    { key: "customer", header: t("customer"), accessorFn: (row) => row.customer?.name ?? "", render: (row) => row.customer?.name ?? "—" },
    { key: "total_amount", header: tc("total"), sortable: true, render: (row) => formatCurrency(row.total_amount, locale) },
    { key: "payment_status", header: t("paymentStatus"), sortable: true, render: (row) => t(`payment_${row.payment_status}`) },
    { key: "status", header: tc("status"), sortable: true, render: (row) => t(`status_${row.status}`) },
    { key: "created_at", header: tc("date"), sortable: true, hideOnMobile: true, accessorFn: (row) => row.created_at ? new Date(row.created_at).getTime() : 0, render: (row) => row.created_at ? new Date(row.created_at).toLocaleDateString(locale) : "" },
    { key: "actions", header: tc("actions"), render: (row) => <TableActions><Link href={`/admin/orders/${row.id}`} prefetch={false}><Button size="icon" variant="ghost"><EyeIcon className="h-4 w-4" /><span className="sr-only">{tc("view")}</span></Button></Link></TableActions> },
  ];
  const exportColumns: ExportColumn<Order>[] = [
    { key: "id", header: t("orderId"), getValue: (order) => order.id },
    { key: "customer", header: t("customer"), getValue: (order) => order.customer?.name ?? "" },
    { key: "total", header: tc("total"), getValue: (order) => (order.total_amount / 100).toFixed(2) },
    { key: "payment_status", header: t("paymentStatus"), getValue: (order) => order.payment_status },
    { key: "status", header: tc("status"), getValue: (order) => order.status },
  ];

  if (isLoading) return <Card className="p-6"><CardContent className="space-y-3 p-0">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</CardContent></Card>;
  if (error) return <Card><CardContent><p className="text-red-500">{error.message}</p></CardContent></Card>;
  return (
    <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <CardHeader className="p-0"><SearchFilter search={searchTerm} onSearchChange={setSearchTerm} searchPlaceholder={t("searchPlaceholder")} filters={[{ options: statusFilterOptions, value: statusFilter, onChange: setStatusFilter }]} /></CardHeader>
      <CardContent className="p-0"><DataTable data={filteredOrders} columns={columns} exportColumns={exportColumns} exportFilename="orders" emptyMessage={t("noOrders")} emptyIcon={<ShoppingCartIcon className="h-8 w-8" />} defaultSort={[{ id: "created_at", desc: true }]} /></CardContent>
    </Card>
  );
}
