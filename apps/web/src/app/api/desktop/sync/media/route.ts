import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { storeSynchronizedProductImage, validateProductImage } from "@/lib/media/product-images";

export const runtime = "nodejs";

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN ?? "";
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  return process.env.FORNO_DESKTOP_MODE === "1" && expected.length > 0 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Local synchronization is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });
  const form = await request.formData().catch(() => null);
  const key = form?.get("key");
  const file = form?.get("file");
  const contentHash = request.headers.get("x-forno-content-sha256") ?? "";
  if (typeof key !== "string" || !(file instanceof File)) return NextResponse.json({ error: "Product media request is invalid." }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "Product image exceeds the upload limit." }, { status: 413 });
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    validateProductImage(bytes, file.type, file.name);
    const verifiedHash = await storeSynchronizedProductImage(key, bytes, file.type, contentHash);
    return NextResponse.json({ stored: true, contentHash: verifiedHash }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Product media was rejected." }, { status: 400 });
  }
}
