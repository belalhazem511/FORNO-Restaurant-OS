"use client";

import { useState, useMemo } from "react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod/v4";
import { Button } from "@forno/ui/components/button";
import { Card, CardContent, CardHeader } from "@forno/ui/components/card";
import { FilePenIcon, TrashIcon, PlusIcon, PackageIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@forno/ui/components/dialog";
import { Input } from "@forno/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@forno/ui/components/select";
import { Label } from "@forno/ui/components/label";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { Skeleton } from "@forno/ui/components/skeleton";
import { useTRPC } from "@/lib/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCrudMutation } from "@/hooks/use-crud-mutation";
import { DataTable, TableActions, TableActionButton, type Column, type ExportColumn } from "@forno/ui/components/data-table";
import { SearchFilter, type FilterOption } from "@forno/ui/components/search-filter";
import type { RouterOutputs } from "@/lib/trpc/router";
import { useTranslations, useLocale } from "next-intl";
import { formatCurrency } from "@/lib/utils";
import { ProductImage } from "@/components/products/product-image";

type Product = RouterOutputs["products"]["list"][number];

export default function Products() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: products = [], isLoading } = useQuery(trpc.products.list.queryOptions());
  const { data: canManageImages = false } = useQuery(trpc.products.canManageImages.queryOptions());
  const t = useTranslations("products");
  const tc = useTranslations("common");
  const locale = useLocale();

  const productFormSchema = z.object({
    name: z.string().min(1, t("nameRequired")),
    description: z.string(),
    price: z.number().min(0, t("priceMustBePositive")),
    category: z.string(),
  });

  const categoryFilterOptions: FilterOption[] = [
    { label: tc("all"), value: "all" },
    { label: t("pizza"), value: "pizza" },
    { label: t("doner"), value: "doner" },
    { label: t("cafe"), value: "cafe" },
    { label: t("drinks"), value: "drinks" },
  ];

  const columns: Column<Product>[] = [
    { key: "name", header: t("product"), sortable: true, className: "font-medium" },
    { key: "description", header: tc("description"), hideOnMobile: true },
    {
      key: "price",
      header: tc("price"),
      sortable: true,
      accessorFn: (row) => row.price,
      render: (row) => formatCurrency(row.price, locale),
    },
  ];

  const exportColumns: ExportColumn<Product>[] = [
    { key: "name", header: tc("name"), getValue: (p) => p.name },
    { key: "description", header: tc("description"), getValue: (p) => p.description ?? "" },
    { key: "price", header: tc("price"), getValue: (p) => (p.price / 100).toFixed(2) },
    { key: "category", header: tc("category"), getValue: (p) => p.category ?? "" },
  ];

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const isEditing = editingId !== null;
  const invalidateKeys = trpc.products.list.queryOptions().queryKey;

  const createMutation = useCrudMutation({
    mutationOptions: trpc.products.create.mutationOptions(),
    invalidateKeys,
    successMessage: t("created"),
    errorMessage: t("createError"),
    onSuccess: () => setIsDialogOpen(false),
  });

  const updateMutation = useCrudMutation({
    mutationOptions: trpc.products.update.mutationOptions(),
    invalidateKeys,
    successMessage: t("updated"),
    errorMessage: t("updateError"),
    onSuccess: () => setIsDialogOpen(false),
  });

  const deleteMutation = useCrudMutation({
    mutationOptions: trpc.products.delete.mutationOptions(),
    invalidateKeys,
    successMessage: t("deleted"),
    errorMessage: t("deleteError"),
  });

  const form = useForm({
    defaultValues: { name: "", description: "", price: 0, category: "" },
    validators: {
      onSubmit: productFormSchema,
    },
    onSubmit: ({ value }) => {
      const payload = {
        name: value.name,
        description: value.description || undefined,
        price: Math.round(value.price * 100),
        category: value.category || undefined,
      };
      if (isEditing) {
        updateMutation.mutate({ id: editingId, ...payload });
      } else {
        createMutation.mutate({ ...payload, in_stock: 0 });
      }
    },
  });

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      return p.name.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [products, categoryFilter, searchTerm]);

  const openCreate = () => {
    setEditingId(null);
    setEditingProduct(null);
    form.reset();
    setIsDialogOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditingId(p.id);
    setEditingProduct(p);
    setImageError(null);
    form.reset();
    form.setFieldValue("name", p.name);
    form.setFieldValue("description", p.description ?? "");
    form.setFieldValue("price", p.price / 100);
    form.setFieldValue("category", p.category ?? "");
    setIsDialogOpen(true);
  };

  const uploadProductImage = async (file: File) => {
    if (!editingProduct) return;
    setImageBusy(true);
    setImageError(null);
    const body = new FormData();
    body.set("file", file);
    try {
      const response = await fetch(`/api/products/${editingProduct.id}/image`, { method: "POST", body });
      const result = await response.json() as { imageKey?: string; error?: string };
      if (!response.ok || !result.imageKey) throw new Error(result.error ?? "Image upload failed");
      setEditingProduct({ ...editingProduct, image_key: result.imageKey });
      await queryClient.invalidateQueries({ queryKey: trpc.products.list.queryOptions().queryKey });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      setImageBusy(false);
    }
  };

  const removeProductImage = async () => {
    if (!editingProduct) return;
    setImageBusy(true);
    setImageError(null);
    try {
      const response = await fetch(`/api/products/${editingProduct.id}/image`, { method: "DELETE" });
      if (!response.ok) throw new Error("Image removal failed");
      setEditingProduct({ ...editingProduct, image_key: null });
      await queryClient.invalidateQueries({ queryKey: trpc.products.list.queryOptions().queryKey });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Image removal failed");
    } finally {
      setImageBusy(false);
    }
  };

  const handleDelete = () => {
    if (deleteId !== null) {
      deleteMutation.mutate({ id: deleteId });
      setIsDeleteOpen(false);
      setDeleteId(null);
    }
  };

  const actionsColumn: Column<Product> = {
    key: "actions",
    header: tc("actions"),
    render: (row) => (
      <TableActions>
        <TableActionButton onClick={() => openEdit(row)} icon={<FilePenIcon className="w-4 h-4" />} label={tc("edit")} />
        <TableActionButton variant="danger" onClick={() => { setDeleteId(row.id); setIsDeleteOpen(true); }} icon={<TrashIcon className="w-4 h-4" />} label={tc("delete")} />
      </TableActions>
    ),
  };

  if (isLoading) {
    return (
      <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
        <CardHeader className="p-0"><div className="flex items-center justify-between"><Skeleton className="h-10 w-48" /><Skeleton className="h-9 w-32" /></div></CardHeader>
        <CardContent className="p-0 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (<div key={i} className="flex items-center gap-4"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-12" /><Skeleton className="h-8 w-20" /></div>))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="flex flex-col gap-4 p-3 sm:gap-6 sm:p-6">
        <CardHeader className="p-0">
          <SearchFilter
            search={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder={t("searchPlaceholder")}
            filters={[
              { options: categoryFilterOptions, value: categoryFilter, onChange: setCategoryFilter },
            ]}
          >
            <Button size="sm" onClick={openCreate}>
              <PlusIcon className="w-4 h-4 me-2" />{t("addProduct")}
            </Button>
          </SearchFilter>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            data={filteredProducts}
            columns={[...columns, actionsColumn]}
            exportColumns={exportColumns}
            exportFilename="products"
            emptyMessage={t("noProducts")}
            emptyIcon={<PackageIcon className="w-8 h-8" />}
            defaultSort={[{ id: "name", desc: false }]}
          />
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) setIsDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEditing ? t("editProduct") : t("addNewProduct")}</DialogTitle>
            <DialogDescription>{isEditing ? t("editDescription") : t("addDescription")}</DialogDescription>
          </DialogHeader>
          {isEditing && editingProduct && canManageImages && <section className="space-y-3" aria-label={locale.startsWith("ar") ? "صورة المنتج" : "Product image"}>
            <ProductImage imageKey={editingProduct.image_key} alt={editingProduct.name} className="h-32 w-32 rounded-md object-cover" />
            <div className="flex flex-wrap items-center gap-2">
              <Label className="cursor-pointer rounded-md border px-3 py-2 text-sm" htmlFor="product-image-upload">{locale.startsWith("ar") ? "رفع أو استبدال الصورة" : "Upload or replace image"}</Label>
              <Input id="product-image-upload" type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={imageBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadProductImage(file); event.currentTarget.value = ""; }} />
              {editingProduct.image_key && <Button type="button" variant="outline" disabled={imageBusy} onClick={() => void removeProductImage()}>{locale.startsWith("ar") ? "إزالة" : "Remove"}</Button>}
              {imageBusy && <span role="status">{locale.startsWith("ar") ? "جارٍ الحفظ…" : "Saving…"}</span>}
            </div>
            {imageError && <p role="alert" className="text-sm text-destructive">{imageError}</p>}
          </section>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <div className="grid gap-4 py-4">
              <form.Field name="name">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="name" className="sm:text-right">{tc("name")}</Label>
                    <div className="col-span-3">
                      <Input
                        id="name"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        error={field.state.meta.errors.length > 0 ? field.state.meta.errors.map(e => e?.message ?? e).join(", ") : undefined}
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="description">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="description" className="sm:text-right">{tc("description")}</Label>
                    <Input id="description" value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} className="col-span-3" />
                  </div>
                )}
              </form.Field>
              <form.Field name="price">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="price" className="sm:text-right">{tc("price")}</Label>
                    <div className="col-span-3">
                      <Input
                        id="price"
                        type="number"
                        step="0.01"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(Number(e.target.value))}
                        onBlur={field.handleBlur}
                        error={field.state.meta.errors.length > 0 ? field.state.meta.errors.map(e => e?.message ?? e).join(", ") : undefined}
                      />
                    </div>
                  </div>
                )}
              </form.Field>
              <form.Field name="category">
                {(field) => (
                  <div className="flex flex-col sm:grid sm:grid-cols-4 sm:items-center gap-2 sm:gap-4">
                    <Label htmlFor="category" className="sm:text-right">{tc("category")}</Label>
                    <Select value={field.state.value} onValueChange={(value) => field.handleChange(value)}>
                      <SelectTrigger className="col-span-3"><SelectValue placeholder={t("selectCategory")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pizza">{t("pizza")}</SelectItem>
                        <SelectItem value="doner">{t("doner")}</SelectItem>
                        <SelectItem value="cafe">{t("cafe")}</SelectItem>
                        <SelectItem value="drinks">{t("drinks")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </form.Field>
            </div>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <Button type="submit" disabled={isSubmitting || createMutation.isPending || updateMutation.isPending}>
                    {isEditing ? t("updateProduct") : t("addProduct")}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} onConfirm={handleDelete} description={t("deleteMessage")} />
    </>
  );
}
