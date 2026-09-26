import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { applyAuthoritativeChanges } from "./import-authoritative-changes";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return applyAuthoritativeChanges(request, db);
}
