import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "@/lib/db";
import { staffAssignments } from "@/lib/db/schema";
import { hasPermission, type Permission } from "@/lib/permissions";

export async function getAuthUser() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return session?.user ?? null;
}

export async function requirePagePermission(permission: Permission) {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  const assignment = await db.query.staffAssignments.findFirst({
    where: and(
      eq(staffAssignments.user_id, user.id),
      eq(staffAssignments.is_active, true),
    ),
  });
  if (!assignment || !hasPermission(assignment.role, permission)) notFound();
}
