"use client";

import { Card, CardContent, CardHeader } from "@forno/ui/components/card";
import { CreditCardIcon } from "lucide-react";
import { Skeleton } from "@forno/ui/components/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { DataTable, type Column } from "@forno/ui/components/data-table";
import type { RouterOutputs } from "@/lib/trpc/router";
import { useTranslations } from "next-intl";

type PaymentMethod = RouterOutputs["paymentMethods"]["list"][number];

export default function PaymentMethodsPage() {
  const trpc = useTRPC();
  const { data: methods = [], isLoading, error } = useQuery(trpc.paymentMethods.list.queryOptions());
  const t = useTranslations("paymentMethods");
  const tc = useTranslations("common");
  const columns: Column<PaymentMethod>[] = [
    { key: "name", header: tc("name"), sortable: true, className: "font-medium" },
    { key: "code", header: t("code"), sortable: true, render: (row) => row.code ?? "—" },
  ];

  if (isLoading) {
    return <Card className="p-6"><CardContent className="space-y-3 p-0">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}</CardContent></Card>;
  }
  if (error) return <Card><CardContent><p className="text-red-500">{error.message}</p></CardContent></Card>;

  return (
    <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
      <CardHeader className="space-y-2 p-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <CreditCardIcon className="h-5 w-5" />
          <span className="text-sm">{t("methodCount", { count: methods.length })}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("immutableDescription")}</p>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable data={methods} columns={columns} emptyMessage={t("noMethods")} emptyIcon={<CreditCardIcon className="h-8 w-8" />} defaultSort={[{ id: "name", desc: false }]} />
      </CardContent>
    </Card>
  );
}
