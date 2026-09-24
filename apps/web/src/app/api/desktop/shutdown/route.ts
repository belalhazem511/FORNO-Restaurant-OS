import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pglite } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN;
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  if (process.env.FORNO_DESKTOP_MODE !== "1" || !expected || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return NextResponse.json({ error: "Desktop shutdown is unavailable." }, { status: 404 });
  }
  await pglite.close();
  return NextResponse.json({ closed: true });
}
