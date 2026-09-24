import { requirePagePermission } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export default async function SupplierReturnsLayout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("supplier-return:view");
  return children;
}
