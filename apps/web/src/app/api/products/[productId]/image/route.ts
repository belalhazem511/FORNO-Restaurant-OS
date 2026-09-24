import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { menuItems, products, staffAssignments } from "@/lib/db/schema";
import { PRODUCT_IMAGE_MAX_BYTES, removeProductImage, writeProductImage } from "@/lib/media/product-images";
import { hasPermission } from "@/lib/permissions";

async function authorizedProduct(request: Request, productId: number) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const product = await db.query.products.findFirst({ where: eq(products.id, productId) });
  if (!product) return { response: NextResponse.json({ error: "Product not found" }, { status: 404 }) };
  const linkedMenuItems = await db.query.menuItems.findMany({
    where: eq(menuItems.product_id, productId),
    with: { category: true },
  });
  const branchIds = [...new Set(linkedMenuItems.map((item) => item.category.branch_id))];
  const assignments = await db.query.staffAssignments.findMany({ where: and(eq(staffAssignments.user_id, session.user.id), eq(staffAssignments.is_active, true)) });
  const canManage = assignments.some((assignment) => hasPermission(assignment.role, "product:manage")
    && (branchIds.length === 0 ? product.user_uid === session.user.id : branchIds.includes(assignment.branch_id)));
  if (!canManage) {
    return { response: NextResponse.json({ error: "Product not found" }, { status: 404 }) };
  }
  return { product };
}

export async function POST(request: Request, context: { params: Promise<{ productId: string }> }) {
  const productId = Number((await context.params).productId);
  if (!Number.isSafeInteger(productId) || productId < 1) return NextResponse.json({ error: "Invalid product" }, { status: 400 });
  const access = await authorizedProduct(request, productId);
  if ("response" in access) return access.response;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Image file is required" }, { status: 400 });
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return NextResponse.json({ error: "Image exceeds the 5 MB limit." }, { status: 400 });
  let newKey: string;
  try {
    newKey = await writeProductImage(productId, Buffer.from(await file.arrayBuffer()), file.type, file.name);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid image" }, { status: 400 });
  }
  try {
    await db.update(products).set({ image_key: newKey }).where(eq(products.id, productId));
  } catch (error) {
    await removeProductImage(newKey).catch(() => undefined);
    throw error;
  }
  if (access.product.image_key) await removeProductImage(access.product.image_key).catch(() => undefined);
  return NextResponse.json({ imageKey: newKey });
}

export async function DELETE(request: Request, context: { params: Promise<{ productId: string }> }) {
  const productId = Number((await context.params).productId);
  if (!Number.isSafeInteger(productId) || productId < 1) return NextResponse.json({ error: "Invalid product" }, { status: 400 });
  const access = await authorizedProduct(request, productId);
  if ("response" in access) return access.response;
  await db.update(products).set({ image_key: null }).where(eq(products.id, productId));
  if (access.product.image_key) await removeProductImage(access.product.image_key).catch(() => undefined);
  return NextResponse.json({ imageKey: null });
}
