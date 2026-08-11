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
  | "cash:adjust";

const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust"]),
  admin: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust"]),
  manager: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust"]),
  cashier: new Set(["order:create", "checkout:create", "shift:own"]),
};

export function hasPermission(role: StaffRole, permission: Permission) {
  return ROLE_PERMISSIONS[role].has(permission);
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
