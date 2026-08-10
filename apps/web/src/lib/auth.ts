import { createAuth } from "@forno/auth";
import { db } from "./db";
import { serverUrls } from "@forno/env/server";

export const auth = createAuth({
  db: db as any,
  baseURL: serverUrls.betterAuthUrl,
});
