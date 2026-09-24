import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth-guard";
import { db } from "@/lib/db";
import { staffAssignments } from "@/lib/db/schema";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function SupplierReturnsLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, user.id), eq(staffAssignments.is_active, true)) });
  if (!assignment || !hasPermission(assignment.role, "supplier-return:view")) notFound();
  return children;
}
