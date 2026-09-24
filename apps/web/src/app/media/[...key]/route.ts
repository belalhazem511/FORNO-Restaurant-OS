import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productImagePath } from "@/lib/media/product-images";
import { readFile } from "node:fs/promises";

const contentTypes: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const key = (await context.params).key.join("/");
  try {
    const product = await db.query.products.findFirst({ where: eq(products.image_key, key), columns: { image_key: true } });
    if (!product) return new NextResponse(null, { status: 404 });
    const path = productImagePath(key);
    const bytes = await readFile(path);
    const extension = key.slice(key.lastIndexOf(".") + 1);
    return new NextResponse(bytes, { headers: { "Content-Type": contentTypes[extension], "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
