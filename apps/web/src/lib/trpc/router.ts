import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { router } from "./init";
import { productsRouter } from "./routers/products";
import { customersRouter } from "./routers/customers";
import { ordersRouter } from "./routers/orders";
import { transactionsRouter } from "./routers/transactions";
import { paymentMethodsRouter } from "./routers/payment-methods";
import { dashboardRouter } from "./routers/dashboard";
import { restaurantRouter } from "./routers/restaurant";
import { shiftsRouter } from "./routers/shifts";
import { checkoutRouter } from "./routers/checkout";
import { printingRouter } from "./routers/printing";
import { offlineRouter } from "./routers/offline";
import { inventoryRouter } from "./routers/inventory";
import { procurementRouter } from "./routers/procurement";
import { receivingRouter } from "./routers/receiving";
import { supplierReturnsRouter } from "./routers/supplier-returns";
import { stockTransfersRouter } from "./routers/stock-transfers";
import { stockCountsRouter } from "./routers/stock-counts";

export const appRouter = router({
  products: productsRouter,
  customers: customersRouter,
  orders: ordersRouter,
  transactions: transactionsRouter,
  paymentMethods: paymentMethodsRouter,
  dashboard: dashboardRouter,
  restaurant: restaurantRouter,
  shifts: shiftsRouter,
  checkout: checkoutRouter,
  printing: printingRouter,
  offline: offlineRouter,
  inventory: inventoryRouter,
  procurement: procurementRouter,
  receiving: receivingRouter,
  supplierReturns: supplierReturnsRouter,
  stockTransfers: stockTransfersRouter,
  stockCounts: stockCountsRouter,
});

export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
