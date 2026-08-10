import createNextIntlPlugin from "next-intl/plugin";
import { fileURLToPath } from "node:url";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: process.env.BASE_PATH || "",
  env: {
    NEXT_PUBLIC_BASE_PATH: process.env.BASE_PATH || "",
  },
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
};

export default withNextIntl(nextConfig);
