import { requirePagePermission } from "@/lib/auth-guard";
import { StorageActions } from "./storage-actions";

export const dynamic = "force-dynamic";

export default async function StoragePage() {
  await requirePagePermission("inventory:configure");
  return <StorageActions />;
}
