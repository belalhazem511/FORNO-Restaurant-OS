import { and, eq } from "drizzle-orm";
import { auth } from "../../auth";
import { db } from "..";
import { branches, cashierRegisters, paymentMethods, staffAssignments, user } from "../schema";

const DEMO_EMAIL = "admin@forno.local";
const DEMO_PASSWORD = "Forno123!";
const DEMO_NAME = "SOLO Admin";
const CASHIER_EMAIL = "cashier@forno.local";
const CASHIER_PASSWORD = "Forno123!";
const MANAGER_EMAIL = "manager@forno.local";
const MANAGER_PASSWORD = "Forno123!";

async function demoUserId(email: string, name: string, password: string) {
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing) return existing.id;
  const result = await auth.api.signUpEmail({ body: { name, email, password } });
  return result.user.id;
}

export async function seedIdentity() {
  const userId = await demoUserId(DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD);
  const cashierUserId = await demoUserId(CASHIER_EMAIL, "SOLO Cashier", CASHIER_PASSWORD);
  const managerUserId = await demoUserId(MANAGER_EMAIL, "SOLO Manager", MANAGER_PASSWORD);

  await db.insert(paymentMethods).values([
    { code: "CARD", name: "Card", affects_drawer: false, is_active: true },
    { code: "INSTAPAY", name: "InstaPay", affects_drawer: false, is_active: true },
    { code: "CASH", name: "Cash", affects_drawer: true, is_active: true },
  ]).onConflictDoNothing();
  await db.update(paymentMethods).set({ code: "CARD", affects_drawer: false, is_active: true }).where(eq(paymentMethods.name, "Card"));
  await db.update(paymentMethods).set({ code: "INSTAPAY", affects_drawer: false, is_active: true }).where(eq(paymentMethods.name, "InstaPay"));
  await db.update(paymentMethods).set({ code: "CASH", affects_drawer: true, is_active: true }).where(eq(paymentMethods.name, "Cash"));
  const methods = await db.select().from(paymentMethods);
  const paymentByName = new Map(methods.map((method) => [method.name, method.id]));

  await db.insert(branches).values({
    code: "FORNO-MAIN",
    name_en: "SOLO Main Branch",
    name_ar: "فرع SOLO الرئيسي",
    address_en: "New Cairo, Cairo",
    address_ar: "القاهرة الجديدة، القاهرة",
    phone: "+20 100 000 0000",
  }).onConflictDoNothing();
  const branch = await db.query.branches.findFirst({ where: eq(branches.code, "FORNO-MAIN") });
  if (!branch) throw new Error("Failed to seed FORNO branch");

  await db.insert(staffAssignments).values({
    user_id: userId,
    branch_id: branch.id,
    role: "admin",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "admin", is_active: true, updated_at: new Date() },
  });
  await db.insert(staffAssignments).values({
    user_id: cashierUserId,
    branch_id: branch.id,
    role: "cashier",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "cashier", is_active: true, updated_at: new Date() },
  });
  await db.insert(staffAssignments).values({
    user_id: managerUserId,
    branch_id: branch.id,
    role: "manager",
    is_active: true,
  }).onConflictDoUpdate({
    target: [staffAssignments.user_id, staffAssignments.branch_id],
    set: { role: "manager", is_active: true, updated_at: new Date() },
  });
  await db.insert(cashierRegisters).values({
    branch_id: branch.id,
    code: "FRONT",
    name_en: "Front Register",
    name_ar: "كاشير الواجهة",
    is_active: true,
  }).onConflictDoNothing();

  return { branchId: branch.id, userId, paymentByName };
}

export const demoLogin = { email: DEMO_EMAIL, cashierEmail: CASHIER_EMAIL, password: DEMO_PASSWORD };
