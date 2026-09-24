import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { TRPCError } from "@trpc/server";
import type { Permission } from "@/lib/permissions";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { assertPermission, hasPermission, permissionsForRole, requireStaff } = await import("@/lib/permissions");
const schema = await import("@/lib/db/schema");

const allPermissions: Permission[] = [
  "order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust",
  "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:configure", "inventory:adjust",
  "inventory:override", "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create",
  "purchase-order:approve", "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:reverse",
  "purchase-receipt:variance:approve", "purchase-receipt:overreceive", "supplier-return:view", "supplier-return:cost:view",
  "supplier-return:create", "supplier-return:submit", "supplier-return:approve", "supplier-return:dispatch", "supplier-return:cancel",
  "supplier-return:reverse", "supplier-return:resolve", "stock-transfer:view", "stock-transfer:create", "stock-transfer:submit",
  "stock-transfer:approve", "stock-transfer:dispatch", "stock-transfer:receive", "stock-transfer:cancel", "stock-transfer:reverse",
  "stock-transfer:resolve", "stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit",
  "stock-count:approve", "stock-count:post", "stock-count:cancel", "stock-count:reverse", "stock-count:resolve",
  "stock-count:variance:view", "stock-count:cost:resolve",
];

const managerPermissions: Permission[] = [
  "order:create", "checkout:create", "shift:own", "shift:review", "discount:apply", "order:cancel", "payment:refund", "cash:adjust",
  "print:initial", "print:reprint", "print:settings", "inventory:view", "inventory:cost:view", "inventory:adjust", "inventory:override",
  "recipe:manage", "supplier:view", "supplier:manage", "purchase-order:view", "purchase-order:create", "purchase-order:approve",
  "purchase-receipt:view", "purchase-receipt:create", "purchase-receipt:post", "purchase-receipt:overreceive", "supplier-return:view",
  "supplier-return:cost:view", "supplier-return:create", "supplier-return:submit", "supplier-return:dispatch", "supplier-return:cancel",
  "stock-transfer:view", "stock-transfer:create", "stock-transfer:submit", "stock-transfer:approve", "stock-transfer:dispatch",
  "stock-transfer:receive", "stock-transfer:cancel", "stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter",
  "stock-count:submit", "stock-count:approve", "stock-count:post", "stock-count:variance:view",
];

const cashierPermissions: Permission[] = ["order:create", "checkout:create", "shift:own", "print:initial"];
const countPermissions: Permission[] = [
  "stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve",
  "stock-count:post", "stock-count:cancel", "stock-count:reverse", "stock-count:resolve", "stock-count:variance:view", "stock-count:cost:resolve",
];

let branchId: number;
let foreignBranchId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([
    makeUser("permission-owner"), makeUser("permission-manager"), makeUser("permission-cashier"),
    makeUser("permission-inactive"), makeUser("permission-foreign"),
  ]);
  const [branch, foreignBranch] = await db.insert(schema.branches).values([
    { code: "AUTH", name_en: "Authorization", name_ar: "صلاحيات", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
    { code: "AUTH-FOREIGN", name_en: "Foreign", name_ar: "فرع آخر", currency: "EGP", timezone: "Africa/Cairo", is_active: true },
  ]).returning();
  branchId = branch.id;
  foreignBranchId = foreignBranch.id;
  await db.insert(schema.staffAssignments).values([
    { user_id: "permission-owner", branch_id: branchId, role: "owner", is_active: true },
    { user_id: "permission-manager", branch_id: branchId, role: "manager", is_active: true },
    { user_id: "permission-cashier", branch_id: branchId, role: "cashier", is_active: true },
    { user_id: "permission-inactive", branch_id: branchId, role: "admin", is_active: false },
    { user_id: "permission-foreign", branch_id: foreignBranchId, role: "manager", is_active: true },
  ]);
});

afterAll(async () => pg.close());

describe("role permission matrix", () => {
  it("preserves the complete ordered Owner and Admin permission snapshots", () => {
    expect(permissionsForRole("owner")).toEqual(allPermissions);
    expect(permissionsForRole("admin")).toEqual(allPermissions);
    for (const permission of allPermissions) {
      expect(hasPermission("owner", permission)).toBe(true);
      expect(hasPermission("admin", permission)).toBe(true);
    }
  });

  it("preserves the exact ordered Manager permission snapshot", () => {
    expect(permissionsForRole("manager")).toEqual(managerPermissions);
    for (const permission of allPermissions) {
      expect(hasPermission("manager", permission)).toBe(managerPermissions.includes(permission));
    }
  });

  it("preserves the exact four Cashier permissions and denies inventory/procurement workflows", () => {
    expect(permissionsForRole("cashier")).toEqual(cashierPermissions);
    for (const permission of [
      "inventory:view", "supplier:view", "purchase-order:view", "purchase-receipt:view", "supplier-return:view", "stock-transfer:view", "stock-count:view",
    ] as const) expect(hasPermission("cashier", permission)).toBe(false);
  });

  it("keeps stock-count permissions unchanged by role, including Manager variance-only review", () => {
    const managerCountPermissions: Permission[] = [
      "stock-count:view", "stock-count:create", "stock-count:start", "stock-count:enter", "stock-count:submit", "stock-count:approve",
      "stock-count:post", "stock-count:variance:view",
    ];
    for (const permission of countPermissions) {
      expect(hasPermission("owner", permission)).toBe(true);
      expect(hasPermission("admin", permission)).toBe(true);
      expect(hasPermission("manager", permission)).toBe(managerCountPermissions.includes(permission));
      expect(hasPermission("cashier", permission)).toBe(false);
    }
    expect(hasPermission("manager", "stock-count:variance:view")).toBe(true);
    expect(hasPermission("manager", "stock-count:reverse")).toBe(false);
    expect(hasPermission("manager", "stock-count:resolve")).toBe(false);
    expect(hasPermission("manager", "stock-count:cost:resolve")).toBe(false);
  });

  it("keeps offline permission membership and order, agrees with hasPermission, and returns independent arrays", () => {
    const expectedByRole: Record<"owner" | "admin" | "manager" | "cashier", Permission[]> = {
      owner: allPermissions,
      admin: allPermissions,
      manager: managerPermissions,
      cashier: cashierPermissions,
    } as const;
    for (const role of ["owner", "admin", "manager", "cashier"] as const) {
      const permissions = permissionsForRole(role);
      expect(permissions).toEqual(expectedByRole[role]);
      expect(new Set(permissions).size).toBe(permissions.length);
      for (const permission of allPermissions) expect(hasPermission(role, permission)).toBe(permissions.includes(permission));
    }
    const mutableCopy = permissionsForRole("owner");
    mutableCopy.pop();
    expect(permissionsForRole("owner")).toEqual(allPermissions);
  });

  it("retains assertPermission allow, deny, code, and message behavior", () => {
    expect(() => assertPermission("owner", "stock-count:reverse")).not.toThrow();
    expect(() => assertPermission("manager", "stock-count:variance:view")).not.toThrow();
    let denied: unknown;
    try { assertPermission("cashier", "discount:apply"); } catch (error) { denied = error; }
    expect(denied).toBeInstanceOf(TRPCError);
    expect(denied).toMatchObject({ code: "FORBIDDEN", message: "Role cashier cannot perform discount:apply" });
  });
});

describe("branch-scoped staff permission guard", () => {
  it("returns an active assignment matching both user and requested branch", async () => {
    const assignment = await requireStaff("permission-owner", branchId, "stock-count:reverse");
    expect(assignment.role).toBe("owner");
    expect(assignment.branch_id).toBe(branchId);
  });

  it("rejects missing, inactive, and other-branch-only assignments", async () => {
    const missing = await requireStaff("not-assigned", branchId, "inventory:view").catch((error) => error);
    const inactive = await requireStaff("permission-inactive", branchId, "inventory:view").catch((error) => error);
    const foreign = await requireStaff("permission-foreign", branchId, "inventory:view").catch((error) => error);
    for (const error of [missing, inactive, foreign]) {
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: "FORBIDDEN", message: "No active staff assignment for this branch" });
    }
  });

  it("rejects an active branch assignment whose role lacks the requested permission", async () => {
    const error = await requireStaff("permission-cashier", branchId, "stock-count:view").catch((cause) => cause);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "FORBIDDEN", message: "Role cashier cannot perform stock-count:view" });
  });
});
