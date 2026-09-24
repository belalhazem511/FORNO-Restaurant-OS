import { requirePagePermission } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export default async function ReceivingLayout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("purchase-receipt:view");
  return children;
}
