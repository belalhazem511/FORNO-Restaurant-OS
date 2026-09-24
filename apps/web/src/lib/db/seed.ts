import { pglite } from ".";
import { seedIdentity, demoLogin } from "./seed/identity";
import { seedRestaurant } from "./seed/restaurant";
import { seedInventory } from "./seed/inventory";
import { seedProcurement } from "./seed/procurement";
import { seedStockOperations } from "./seed/stock-operations";
import { seedSales } from "./seed/sales";

export async function seed() {
  const { branchId, userId, paymentByName } = await seedIdentity();
  await seedRestaurant(branchId, userId);
  await seedInventory(branchId, userId);
  await seedProcurement(branchId, userId);
  await seedStockOperations(branchId, userId);
  await seedSales(branchId, userId, paymentByName);
  console.log(`FORNO seed ready: ${demoLogin.email} and ${demoLogin.cashierEmail} / ${demoLogin.password}`);
}

if (import.meta.main) {
  await seed();
  await pglite.close();
}
