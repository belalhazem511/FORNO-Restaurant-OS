import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { staffAssignments, type StaffRole } from "@/lib/db/schema";

export type Permission =
  | "order:create"
  | "checkout:create"
  | "shift:own"
  | "shift:review"
  | "discount:apply"
  | "order:cancel"
  | "payment:refund"
  | "cash:adjust"
  | "print:initial"
  | "print:reprint"
  | "print:settings"
  | "inventory:view"
  | "inventory:cost:view"
  | "inventory:configure"
  | "inventory:adjust"
  | "inventory:override"
  | "recipe:manage"
  | "supplier:view"
  | "supplier:manage"
  | "purchase-order:view"
  | "purchase-order:create"
  | "purchase-order:approve"
  | "purchase-receipt:view"
  | "purchase-receipt:create"
  | "purchase-receipt:post"
  | "purchase-receipt:reverse"
  | "purchase-receipt:variance:approve"
  | "purchase-receipt:overreceive";

const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:configure", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:reverse", "purchase-receipt:variance:approve", "purchase-receipt:overreceive"]),
  admin: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:configure", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:reverse", "purchase-receipt:variance:approve", "purchase-receipt:overreceive"]),
  manager: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:overreceive"]),
  cashier: new Set(["order:create", "checkout:create", "shift:own", "print:initial"]),
};

export function hasPermission(role: StaffRole, permission: Permission) {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: StaffRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function assertPermission(role: StaffRole, permission: Permission) {
  if (!hasPermission(role, permission)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Role ${role} cannot perform ${permission}` });
  }
}

export async function requireStaff(userId: string, branchId: number, permission: Permission) {
  const assignment = await db.query.staffAssignments.findFirst({
    where: and(
      eq(staffAssignments.user_id, userId),
      eq(staffAssignments.branch_id, branchId),
      eq(staffAssignments.is_active, true),
    ),
  });
  if (!assignment) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No active staff assignment for this branch" });
  }
  assertPermission(assignment.role, permission);
  return assignment;
}
