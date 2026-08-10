import type { Metadata } from "next";
import { Toaster } from "sonner";
import { TRPCReactProvider } from "@/components/trpc-provider";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "FORNO Restaurant OS",
  description: "Connected restaurant POS, inventory, menu, and operations dashboard",
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
            <main>{children}</main>
            <Toaster richColors position="bottom-right" />
          </TRPCReactProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
