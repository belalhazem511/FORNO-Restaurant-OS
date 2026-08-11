import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, userId: null },
      { status: 401, headers: { "Cache-Control": "no-store, private" } },
    );
  }
  return NextResponse.json(
    { ok: true, userId: user.id, serverTime: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store, private" } },
  );
}
