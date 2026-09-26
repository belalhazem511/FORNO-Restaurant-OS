import type { Metadata } from "next";
import { Toaster } from "sonner";
import { TRPCReactProvider } from "@/components/trpc-provider";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { OfflineProvider } from "@/components/offline/offline-provider";

export const metadata: Metadata = {
  title: "SOLO Restaurant OS",
  description: "Connected restaurant POS, inventory, menu, and operations dashboard",
  manifest: "/manifest.webmanifest",
  applicationName: "SOLO Restaurant OS",
  appleWebApp: { capable: true, title: "SOLO POS", statusBarStyle: "default" },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TRPCReactProvider>
            <OfflineProvider>
              <main>{children}</main>
              <Toaster richColors position="bottom-right" />
            </OfflineProvider>
          </TRPCReactProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
