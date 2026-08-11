import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { transactionsRouter } = await import("../transactions");
const { createCallerFactory } = await import("../../init");
const { transactions } = await import("@/lib/db/schema");
const caller = createCallerFactory(transactionsRouter)({ user: makeUser("user-1") });
const outsider = createCallerFactory(transactionsRouter)({ user: makeUser("outsider") });

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(transactions).values([
    { description: "Immutable sale", amount: 1000, user_uid: "user-1", type: "income", category: "selling", status: "completed" },
    { description: "Other user", amount: 2000, user_uid: "outsider", type: "income", category: "selling", status: "completed" },
  ]);
});
afterAll(async () => { await pg.close(); });

describe("immutable financial transactions", () => {
  it("lists only the authenticated user's records", async () => {
    expect((await caller.list()).map((entry) => entry.description)).toEqual(["Immutable sale"]);
    expect((await outsider.list()).map((entry) => entry.description)).toEqual(["Other user"]);
  });

  it("rejects direct creation, editing, and deletion", async () => {
    await expect(caller.create({ description: "Fake", amount: 100, type: "income" })).rejects.toThrow("Direct transaction creation");
    await expect(caller.update({ id: 1, amount: 500 })).rejects.toThrow("immutable");
    await expect(caller.delete({ id: 1 })).rejects.toThrow("immutable");
    expect(await caller.list()).toHaveLength(1);
  });
});
