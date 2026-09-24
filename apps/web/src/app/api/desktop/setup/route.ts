import { randomUUID, timingSafeEqual } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { branches, cashierRegisters, paymentMethods, staffAssignments, user } from "@/lib/db/schema";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN;
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: NextRequest) {
  if (process.env.FORNO_DESKTOP_MODE !== "1" || !authorized(request)) return NextResponse.json({ error: "Desktop setup is unavailable." }, { status: 404 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const branchName = typeof body?.branchName === "string" ? body.branchName.trim() : "";
  const registerName = typeof body?.registerName === "string" ? body.registerName.trim() : "";
  if (name.length < 2 || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128 || branchName.length < 2 || branchName.length > 120 || registerName.length < 2 || registerName.length > 120 || !["en", "ar"].includes(String(body?.locale))) {
    return NextResponse.json({ error: "Setup information is invalid." }, { status: 400 });
  }
  const [userCount] = await db.select({ value: count() }).from(user);
  const [branchCount] = await db.select({ value: count() }).from(branches);
  if ((branchCount?.value ?? 0) !== 0) return NextResponse.json({ error: "This local database already has a restaurant branch. Existing data was not changed." }, { status: 409 });
  let ownerId: string | undefined;
  if ((userCount?.value ?? 0) === 0) {
    const created = await auth.api.signUpEmail({ body: { name, email, password } }).catch(() => null);
    ownerId = created?.user?.id;
  } else {
    const existingOwner = await db.query.user.findFirst({ where: eq(user.email, email) });
    if (existingOwner) {
      const authenticated = await auth.api.signInEmail({ body: { email, password } }).catch(() => null);
      if (authenticated?.user.id === existingOwner.id) ownerId = existingOwner.id;
    }
  }
  if (!ownerId) return NextResponse.json({ error: "Owner authentication or account creation failed; existing data was not overwritten." }, { status: 400 });
  try {
    await db.transaction(async (tx) => {
      const [branch] = await tx.insert(branches).values({
        code: `LOCAL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name_en: branchName,
        name_ar: branchName,
        address_en: "",
        address_ar: "",
      }).returning();
      await tx.insert(staffAssignments).values({ user_id: ownerId, branch_id: branch.id, role: "owner", is_active: true });
      await tx.insert(cashierRegisters).values({ branch_id: branch.id, code: "MAIN", name_en: registerName, name_ar: registerName, is_active: true });
      await tx.insert(paymentMethods).values([
        { code: "CASH", name: "Cash", affects_drawer: true, is_active: true },
        { code: "CARD", name: "Card", affects_drawer: false, is_active: true },
        { code: "INSTAPAY", name: "InstaPay", affects_drawer: false, is_active: true },
      ]);
    });
    return NextResponse.json({ ready: true }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Owner was created but restaurant setup did not finish. The database was preserved for recovery; contact support before retrying." }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (process.env.FORNO_DESKTOP_MODE !== "1" || !authorized(request)) return NextResponse.json({ error: "Desktop setup is unavailable." }, { status: 404 });
  const [userCount] = await db.select({ value: count() }).from(user);
  const [branchCount] = await db.select({ value: count() }).from(branches);
  const [assignmentCount] = await db.select({ value: count() }).from(staffAssignments);
  const [registerCount] = await db.select({ value: count() }).from(cashierRegisters);
  return NextResponse.json({ complete: (userCount?.value ?? 0) > 0 && (branchCount?.value ?? 0) > 0 && (assignmentCount?.value ?? 0) > 0 && (registerCount?.value ?? 0) > 0 });
}
