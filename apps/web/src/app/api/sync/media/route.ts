import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, syncGlobalEntities } from "@/lib/db/schema";
import { storeSynchronizedProductImage, validateProductImage } from "@/lib/media/product-images";
import { authenticatePairedDevice } from "@/lib/sync/paired-device";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const device = await authenticatePairedDevice(request);
  if (!device) return NextResponse.json({ error: "Paired device authentication failed." }, { status: 401, headers: { "cache-control": "no-store" } });
  const form = await request.formData().catch(() => null);
  const productGlobalId = form?.get("productGlobalId");
  const key = form?.get("key");
  const file = form?.get("file");
  const contentHash = request.headers.get("x-forno-content-sha256") ?? "";
  if (typeof productGlobalId !== "string" || !/^[0-9a-f-]{36}$/i.test(productGlobalId) || typeof key !== "string" || !(file instanceof File)) {
    return NextResponse.json({ error: "Product media request is invalid." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "Product image exceeds the upload limit." }, { status: 413, headers: { "cache-control": "no-store" } });
  const mapping = await db.query.syncGlobalEntities.findFirst({ where: and(
    eq(syncGlobalEntities.organization_id, device.organization_id),
    eq(syncGlobalEntities.entity_type, "product"),
    eq(syncGlobalEntities.global_id, productGlobalId),
  ) });
  if (!mapping) return NextResponse.json({ error: "Product mapping was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
  const product = await db.query.products.findFirst({ where: and(eq(products.id, Number(mapping.local_id)), eq(products.image_key, key)) });
  if (!product) return NextResponse.json({ error: "Product media reference is not authoritative." }, { status: 409, headers: { "cache-control": "no-store" } });
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    validateProductImage(bytes, file.type, file.name);
    const verifiedHash = await storeSynchronizedProductImage(key, bytes, file.type, contentHash);
    return NextResponse.json({ stored: true, contentHash: verifiedHash }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Product media was rejected." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
