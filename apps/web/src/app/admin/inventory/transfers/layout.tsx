import { requirePagePermission } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export default async function StockTransfersLayout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("stock-transfer:view");
  return children;
}
