import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, suppliers } from "@/lib/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SupplierFields = {
  branchId: number;
  code: string;
  nameEn: string;
  nameAr: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
};

export async function assertSupplier(branchId: number, supplierId: number) {
  const supplier = await db.query.suppliers.findFirst({
    where: and(eq(suppliers.id, supplierId), eq(suppliers.branch_id, branchId)),
  });
  if (!supplier)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Supplier not found in this branch",
    });
  return supplier;
}

export async function createSupplier(tx: Transaction, input: SupplierFields, actorId: string) {
    const [supplier] = await tx
      .insert(suppliers)
      .values({
        branch_id: input.branchId,
        code: input.code,
        name_en: input.nameEn,
        name_ar: input.nameAr,
        is_active: true,
        contact_name: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        created_by: actorId,
        updated_by: actorId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      branch_id: input.branchId,
      actor_user_id: actorId,
      action: "supplier.create",
      entity_type: "supplier",
      entity_id: String(supplier.id),
      details: JSON.stringify({ code: supplier.code }),
    });
    return supplier;
}

export async function updateSupplier(tx: Transaction, input: SupplierFields & { supplierId: number }, actorId: string) {
    const [supplier] = await tx
      .update(suppliers)
      .set({
        code: input.code,
        name_en: input.nameEn,
        name_ar: input.nameAr,
        contact_name: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        updated_by: actorId,
        updated_at: new Date(),
      })
      .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.branch_id, input.branchId)))
      .returning();
    if (!supplier) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found in this branch" });
    await tx.insert(auditLogs).values({
      branch_id: input.branchId,
      actor_user_id: actorId,
      action: "supplier.update",
      entity_type: "supplier",
      entity_id: String(supplier.id),
    });
    return supplier;
}

export async function archiveSupplier(tx: Transaction, input: { branchId: number; supplierId: number; reason: string }, actorId: string) {
    const [updated] = await tx
      .update(suppliers)
      .set({ is_active: false, updated_by: actorId, updated_at: new Date() })
      .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.branch_id, input.branchId)))
      .returning();
    if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Supplier not found in this branch" });
    await tx.insert(auditLogs).values({
      branch_id: input.branchId,
      actor_user_id: actorId,
      action: "supplier.archive",
      entity_type: "supplier",
      entity_id: String(updated.id),
      reason: input.reason,
    });
    return updated;
}
