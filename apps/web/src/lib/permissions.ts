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
  | "purchase-receipt:overreceive"
  | "supplier-return:view"
  | "supplier-return:cost:view"
  | "supplier-return:create"
  | "supplier-return:submit"
  | "supplier-return:approve"
  | "supplier-return:dispatch"
  | "supplier-return:cancel"
  | "supplier-return:reverse"
  | "supplier-return:resolve"
  | "stock-transfer:view"
  | "stock-transfer:create"
  | "stock-transfer:submit"
  | "stock-transfer:approve"
  | "stock-transfer:dispatch"
  | "stock-transfer:receive"
  | "stock-transfer:cancel"
  | "stock-transfer:reverse"
  | "stock-transfer:resolve"
  | "stock-count:view"
  | "stock-count:create"
  | "stock-count:start"
  | "stock-count:enter"
  | "stock-count:submit"
  | "stock-count:approve"
  | "stock-count:post"
  | "stock-count:cancel"
  | "stock-count:reverse"
  | "stock-count:resolve"
  | "stock-count:variance:view"
  | "stock-count:cost:resolve";

const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:configure", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:reverse", "purchase-receipt:variance:approve", "purchase-receipt:overreceive", "supplier-return:view", "supplier-return:cost:view", "supplier-return:create", "supplier-return:submit", "supplier-return:approve", "supplier-return:dispatch", "supplier-return:cancel", "supplier-return:reverse", "supplier-return:resolve", "stock-transfer:view", "stock-transfer:create", "stock-transfer:submit", "stock-transfer:approve", "stock-transfer:dispatch", "stock-transfer:receive", "stock-transfer:cancel", "stock-transfer:reverse", "stock-transfer:resolve"]),
  admin: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:configure", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:reverse", "purchase-receipt:variance:approve", "purchase-receipt:overreceive", "supplier-return:view", "supplier-return:cost:view", "supplier-return:create", "supplier-return:submit", "supplier-return:approve", "supplier-return:dispatch", "supplier-return:cancel", "supplier-return:reverse", "supplier-return:resolve", "stock-transfer:view", "stock-transfer:create", "stock-transfer:submit", "stock-transfer:approve", "stock-transfer:dispatch", "stock-transfer:receive", "stock-transfer:cancel", "stock-transfer:reverse", "stock-transfer:resolve"]),
  manager: new Set(["order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust", "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:adjust", "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:overreceive", "supplier-return:view", "supplier-return:cost:view", "supplier-return:create", "supplier-return:submit", "supplier-return:dispatch", "supplier-return:cancel", "stock-transfer:view", "stock-transfer:create", "stock-transfer:submit", "stock-transfer:approve", "stock-transfer:dispatch", "stock-transfer:receive", "stock-transfer:cancel"]),
  cashier: new Set(["order:create", "checkout:create", "shift:own", "print:initial"]),
};

export function hasPermission(role: StaffRole, permission: Permission) {
  const adminCount: Permission[] = ["stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve", "stock-count:post", "stock-count:cancel", "stock-count:reverse", "stock-count:resolve", "stock-count:variance:view", "stock-count:cost:resolve"];
  const managerCount: Permission[] = ["stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve", "stock-count:post", "stock-count:variance:view"];
  if (adminCount.includes(permission)) return role === "owner" || role === "admin" || (role === "manager" && managerCount.includes(permission));
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: StaffRole): Permission[] {
  const countPermissions: Permission[] = role === "owner" || role === "admin"
    ? ["stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve", "stock-count:post", "stock-count:cancel", "stock-count:reverse", "stock-count:resolve", "stock-count:variance:view", "stock-count:cost:resolve"]
    : role === "manager" ? ["stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve", "stock-count:post", "stock-count:variance:view"] : [];
  return [...ROLE_PERMISSIONS[role], ...countPermissions];
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
