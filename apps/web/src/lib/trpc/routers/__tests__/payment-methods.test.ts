import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { paymentMethodsRouter } = await import("../payment-methods");
const { createCallerFactory } = await import("../../init");
const { paymentMethods } = await import("@/lib/db/schema");
const caller = createCallerFactory(paymentMethodsRouter)({ user: makeUser("user-1") });

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(paymentMethods).values([
    { code: "CASH", name: "Cash", affects_drawer: true, is_active: true },
    { code: "CARD", name: "Card", affects_drawer: false, is_active: true },
    { code: "INSTAPAY", name: "InstaPay", affects_drawer: false, is_active: true },
  ]);
});
afterAll(async () => { await pg.close(); });

describe("system payment methods", () => {
  it("lists the seeded Cash, Card, and InstaPay methods", async () => {
    expect((await caller.list()).map((method) => method.name).sort()).toEqual(["Card", "Cash", "InstaPay"]);
  });

  it("prevents ad-hoc creation, mutation, and deletion of financial configuration", async () => {
    await expect(caller.create({ name: "Voucher" })).rejects.toThrow("system-managed");
    await expect(caller.update({ id: 1, name: "Changed" })).rejects.toThrow("immutable");
    await expect(caller.delete({ id: 1 })).rejects.toThrow("cannot be deleted");
    expect(await caller.list()).toHaveLength(3);
  });
});
