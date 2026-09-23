"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@forno/ui/components/card";
import { Input } from "@forno/ui/components/input";
import { Label } from "@forno/ui/components/label";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { InventoryNav, InventoryPageHeader } from "@/components/inventory/inventory-nav";

export default function SuppliersPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ar = useLocale() === "ar";
  const context = useQuery(trpc.inventory.context.queryOptions());
  const branchId = context.data?.branch.id ?? 0;
  const procurementContext = useQuery(trpc.procurement.context.queryOptions());
  const suppliers = useQuery({
    ...trpc.procurement.suppliers.queryOptions({
      branchId,
      includeArchived: true,
    }),
    enabled: branchId > 0,
  });
  const [form, setForm] = useState({
    code: "",
    nameEn: "",
    nameAr: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const create = useMutation(
    trpc.procurement.createSupplier.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تم إنشاء المورد" : "Supplier created");
        setForm({
          code: "",
          nameEn: "",
          nameAr: "",
          contactName: "",
          phone: "",
          email: "",
          address: "",
          notes: "",
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.procurement.suppliers.queryOptions({
            branchId,
            includeArchived: true,
          }).queryKey,
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const archive = useMutation(
    trpc.procurement.archiveSupplier.mutationOptions({
      onSuccess: async () => {
        toast.success(ar ? "تمت أرشفة المورد" : "Supplier archived");
        await queryClient.invalidateQueries({
          queryKey: trpc.procurement.suppliers.queryOptions({
            branchId,
            includeArchived: true,
          }).queryKey,
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const update = useMutation(
    trpc.procurement.updateSupplier.mutationOptions({
      onSuccess: async () => {
        setEditingId(null);
        setForm({ code: "", nameEn: "", nameAr: "", contactName: "", phone: "", email: "", address: "", notes: "" });
        await queryClient.invalidateQueries({
          queryKey: trpc.procurement.suppliers.queryOptions({ branchId, includeArchived: true }).queryKey,
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  return (
    <div>
      <InventoryNav />
      <InventoryPageHeader
        titleEn="Suppliers"
        titleAr="الموردون"
        descriptionEn="Branch-scoped supplier master data for purchase orders. Archiving preserves procurement history."
        descriptionAr="بيانات الموردين الخاصة بالفرع مع الحفاظ على السجل التاريخي."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader>
            <CardTitle>{ar ? "قائمة الموردين" : "Supplier directory"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {suppliers.data?.map((supplier) => (
              <div key={supplier.id} className={`rounded-lg border p-3 ${!supplier.is_active ? "opacity-60" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <strong>{ar ? supplier.name_ar : supplier.name_en}</strong>
                  <span className="font-mono text-xs text-muted-foreground">{supplier.code}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {supplier.contact_name ?? "—"} · {supplier.phone ?? supplier.email ?? "—"}
                </p>
                {!supplier.is_active ? (
                  <p className="text-xs text-amber-700">{ar ? "مؤرشف" : "Archived"}</p>
                ) : (
                  procurementContext.data?.canManageSuppliers && (
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingId(supplier.id);
                          setForm({
                            code: supplier.code,
                            nameEn: supplier.name_en,
                            nameAr: supplier.name_ar,
                            contactName: supplier.contact_name ?? "",
                            phone: supplier.phone ?? "",
                            email: supplier.email ?? "",
                            address: supplier.address ?? "",
                            notes: supplier.notes ?? "",
                          });
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() => {
                          const reason = window.prompt(ar ? "سبب الأرشفة" : "Archive reason");
                          if (reason)
                            archive.mutate({
                              branchId,
                              supplierId: supplier.id,
                              reason,
                            });
                        }}
                      >
                        {ar ? "أرشفة" : "Archive"}
                      </Button>
                    </div>
                  )
                )}
              </div>
            ))}
          </CardContent>
        </Card>
        {procurementContext.data?.canManageSuppliers && (
          <Card>
            <CardHeader>
              <CardTitle>{ar ? "مورد جديد" : "New supplier"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Code">
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="English name">
                <Input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </Field>
              <Field label="الاسم العربي">
                <Input dir="rtl" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} />
              </Field>
              <Field label={ar ? "جهة الاتصال" : "Contact name"}>
                <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
              </Field>
              <Field label={ar ? "الهاتف" : "Phone"}>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label={ar ? "العنوان" : "Address"}>
                <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <Field label={ar ? "ملاحظات" : "Notes"}>
                <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
              <Button
                className="min-h-11 w-full"
                disabled={create.isPending || update.isPending || !form.code || !form.nameEn || !form.nameAr}
                onClick={() => {
                  const values = {
                    branchId,
                    code: form.code,
                    nameEn: form.nameEn,
                    nameAr: form.nameAr,
                    contactName: form.contactName || null,
                    phone: form.phone || null,
                    email: form.email || null,
                    address: form.address || null,
                    notes: form.notes || null,
                  };
                  if (editingId) update.mutate({ ...values, supplierId: editingId });
                  else create.mutate(values);
                }}
              >
                {ar ? "حفظ المورد" : "Create supplier"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
