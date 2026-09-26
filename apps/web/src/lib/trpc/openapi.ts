import { generateOpenApiDocument } from "trpc-to-openapi";
import { appRouter } from "./router";

export const openApiDocument = generateOpenApiDocument(appRouter, {
  title: "SOLO Restaurant OS API",
  description: "Open-source Point of Sale system API — products, customers, orders, transactions, and payment methods.",
  version: "0.4.1",
  baseUrl: "/api",
  tags: ["Products", "Customers", "Orders", "Transactions", "Payment Methods", "Dashboard"],
});
