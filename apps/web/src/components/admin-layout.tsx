"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@forno/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@forno/ui/components/dropdown-menu";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@forno/ui/components/tooltip";
import { usePathname } from "next/navigation";
import Image from "next/image";
import {
  Package2Icon,
  LayoutDashboardIcon,
  DollarSignIcon,
  PackageIcon,
  ShoppingCartIcon,
  UsersIcon,
  ShoppingBagIcon,
  CreditCardIcon,
  RefreshCwIcon,
  WarehouseIcon,
  SettingsIcon,
  MenuIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { useOffline } from "@/components/offline/offline-provider";

import { logout } from "@/app/login/actions";

interface NavItem {
  href: string;
  labelKey: "dashboard" | "cashier" | "products" | "customers" | "orders" | "paymentMethods" | "pos" | "syncCenter" | "inventory" | "settings";
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { href: "/admin", labelKey: "dashboard", icon: LayoutDashboardIcon },
  { href: "/admin/cashier", labelKey: "cashier", icon: DollarSignIcon },
  { href: "/admin/products", labelKey: "products", icon: PackageIcon },
  { href: "/admin/inventory", labelKey: "inventory", icon: WarehouseIcon },
  { href: "/admin/customers", labelKey: "customers", icon: UsersIcon },
  { href: "/admin/orders", labelKey: "orders", icon: ShoppingBagIcon },
  { href: "/admin/payment-methods", labelKey: "paymentMethods", icon: CreditCardIcon },
  { href: "/admin/pos", labelKey: "pos", icon: ShoppingCartIcon },
  { href: "/admin/sync", labelKey: "syncCenter", icon: RefreshCwIcon },
  { href: "/admin/storage", labelKey: "settings", icon: SettingsIcon },
];

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const t = useTranslations("nav");
  const offline = useOffline();

  const pageNames: Record<string, string> = Object.fromEntries(
    navItems.map((item) => [item.href, t(item.labelKey)])
  );

  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-3 sm:px-4 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden shrink-0"
          onClick={() => setMobileMenuOpen(true)}
        >
          <MenuIcon className="h-5 w-5" />
          <span className="sr-only">{t("openMenu")}</span>
        </Button>
        <Link
          href="/admin"
          className="hidden sm:flex items-center gap-2 text-lg font-semibold"
        >
          <Package2Icon className="h-6 w-6" />
          <span className="sr-only">{t("adminPanel")}</span>
        </Link>
        <h1 className="text-lg sm:text-xl font-bold truncate">{pageNames[pathname]}</h1>
        <div className="ms-auto flex items-center gap-2">
          <Link href="/admin/sync" aria-label={`${offline.connection}, ${offline.pendingCount} pending`} className={`flex min-h-9 items-center gap-1 rounded-full border px-2 text-xs font-bold ${offline.connection === "offline" || offline.connection === "needs_review" || offline.connection === "failed" ? "border-amber-400 bg-amber-50 text-amber-900" : "border-emerald-300 bg-emerald-50 text-emerald-900"}`}><span className="h-2 w-2 rounded-full bg-current" />{offline.connection.replace("_", " ")} {offline.pendingCount > 0 && `(${offline.pendingCount})`}</Link>
          <LocaleSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="overflow-hidden rounded-full shrink-0"
              >
                <Image
                  src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/placeholder-user.jpg`}
                  width={36}
                  height={36}
                  alt="Avatar"
                  className="overflow-hidden rounded-full"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("myAccount")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>{t("settings")}</DropdownMenuItem>
              <DropdownMenuItem>{t("support")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { if (offline.financialPendingCount > 0) { window.alert("Unsynchronized cash sales block logout. Open Sync Center for authorized recovery.\nتوجد مبيعات نقدية غير متزامنة. افتح مركز المزامنة للمعالجة المعتمدة."); return; } void logout(); }}>{t("logout")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Mobile drawer overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <nav className="fixed inset-y-0 start-0 w-64 bg-background border-e p-4 flex flex-col gap-2 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <Link
                href="/admin"
                className="flex items-center gap-2 text-lg font-semibold"
                onClick={() => setMobileMenuOpen(false)}
              >
                <Package2Icon className="h-6 w-6" />
                <span>SOLO Restaurant OS</span>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileMenuOpen(false)}
              >
                <XIcon className="h-5 w-5" />
              </Button>
            </div>
            {navItems.map(({ href, labelKey, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  pathname === href
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                {t(labelKey)}
              </Link>
            ))}
          </nav>
        </div>
      )}

      <div className="flex flex-col sm:gap-4 sm:py-4 sm:ps-14">
        <aside className="fixed mt-[56px] inset-y-0 start-0 z-10 hidden w-14 flex-col border-e bg-background sm:flex">
          <nav className="flex flex-col items-center gap-4 px-2 sm:py-5">
            <TooltipProvider>
              {navItems.map(({ href, labelKey, icon: Icon }) => (
                <Tooltip key={href}>
                  <TooltipTrigger asChild>
                    <Link
                      href={href}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                        pathname === href
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground"
                      } transition-colors hover:text-foreground md:h-8 md:w-8`}
                    >
                      <Icon className="h-5 w-5" />
                      <span className="sr-only">{t(labelKey)}</span>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">{t(labelKey)}</TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          </nav>
        </aside>
        <main className="flex-1 p-3 sm:px-6 sm:py-0 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
