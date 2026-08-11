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
});

export type AppRouter = typeof appRouter;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
