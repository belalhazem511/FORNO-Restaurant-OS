import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  branches,
  cashierShifts,
  offlinePriceSnapshots,
  registerPrintPreferences,
  staffAssignments,
} from "@/lib/db/schema";
import { hasPermission, permissionsForRole } from "@/lib/permissions";
import { menuAvailability } from "@/lib/inventory/service";
import {
  OFFLINE_SNAPSHOT_STALE_MS,
  offlinePriceSnapshotTtlMs,
  snapshotRevision,
  type OfflinePricingPayload,
} from "./contracts";

export async function loadOfflineBootstrap(userId: string, branchId: number) {
  const assignment = await db.query.staffAssignments.findFirst({
    where: and(
      eq(staffAssignments.user_id, userId),
      eq(staffAssignments.branch_id, branchId),
      eq(staffAssignments.is_active, true),
    ),
  });
  if (!assignment || !hasPermission(assignment.role, "order:create")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No offline POS permission for this branch" });
  }
  const branch = await db.query.branches.findFirst({
    where: and(eq(branches.id, branchId), eq(branches.is_active, true)),
    with: {
      diningAreas: { with: { tables: true } },
      kitchenStations: true,
      menuCategories: {
        with: {
          menuItems: {
            with: {
              product: { columns: { image_key: true } },
              variants: true,
              kitchenStation: true,
              modifierGroups: { with: { modifierGroup: { with: { options: true } } } },
            },
          },
        },
      },
      modifierGroups: { with: { options: true } },
    },
  });
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "Active branch not found" });
  const cashier = await db.query.user.findFirst({ where: (users, { eq: equals }) => equals(users.id, userId) });
  if (!cashier) throw new TRPCError({ code: "UNAUTHORIZED", message: "Authenticated cashier not found" });
  const shift = await db.query.cashierShifts.findFirst({
    where: and(
      eq(cashierShifts.branch_id, branchId),
      eq(cashierShifts.cashier_user_id, userId),
      eq(cashierShifts.status, "open"),
    ),
    with: { register: true },
  });
  if (!shift?.register.is_active) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "An active cashier shift and register are required before offline use" });
  }
  const printPreference = await db.query.registerPrintPreferences.findFirst({
    where: eq(registerPrintPreferences.register_id, shift.register_id),
  });
  const createdAt = new Date();
  const availability = (await db.transaction((tx) => menuAvailability(tx, branchId, { includeInventoryDetails: hasPermission(assignment.role, "inventory:view") }))).map(({ theoreticalCost: _cost, ...entry }) => entry);
  const pricing: OfflinePricingPayload = {
    items: branch.menuCategories.flatMap((category) => category.menuItems.map((item) => ({
      id: item.id,
      basePrice: item.base_price,
      variants: item.variants.map((variant) => ({ id: variant.id, price: variant.price })),
      modifiers: item.modifierGroups.flatMap((link) => link.modifierGroup.options.map((option) => ({ id: option.id, priceDelta: option.price_delta }))),
    }))),
  };
  const priceRevision = snapshotRevision(pricing);
  const priceReference = `OPS-${branchId}-${randomBytes(18).toString("base64url")}`;
  const priceExpiresAt = new Date(createdAt.getTime() + offlinePriceSnapshotTtlMs());
  await db.insert(offlinePriceSnapshots).values({
    reference: priceReference,
    revision: priceRevision,
    branch_id: branch.id,
    register_id: shift.register_id,
    shift_id: shift.id,
    actor_user_id: userId,
    pricing_payload: JSON.stringify(pricing),
    issued_at: createdAt,
    expires_at: priceExpiresAt,
  });
  const core = {
    userId,
    cashier: { id: cashier.id, name: cashier.name },
    role: assignment.role,
    permissions: permissionsForRole(assignment.role),
    branch,
    register: shift.register,
    shift: {
      id: shift.id,
      branch_id: shift.branch_id,
      register_id: shift.register_id,
      cashier_user_id: shift.cashier_user_id,
      opened_at: shift.opened_at,
      status: shift.status,
    },
    printing: {
      paperWidth: printPreference?.paper_width ?? 80,
      language: printPreference?.language ?? "bilingual",
      receiptCopies: printPreference?.receipt_copies ?? 1,
      kotCopies: printPreference?.kot_copies ?? 1,
    },
    priceSnapshot: {
      reference: priceReference,
      revision: priceRevision,
      issuedAt: createdAt,
      expiresAt: priceExpiresAt,
      ttlMs: offlinePriceSnapshotTtlMs(),
    },
    availability,
    availabilityRevision: snapshotRevision(availability),
  };
  return {
    version: 2 as const,
    revision: snapshotRevision(core),
    createdAt,
    staleAt: new Date(createdAt.getTime() + OFFLINE_SNAPSHOT_STALE_MS),
    expiresAt: priceExpiresAt,
    ...core,
  };
}
