import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", { extension: "jpg", signature: (bytes: Buffer) => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 }],
  ["image/png", { extension: "png", signature: (bytes: Buffer) => bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.subarray(-12, -8).equals(Buffer.from([0, 0, 0, 0])) && bytes.subarray(-8, -4).toString("ascii") === "IEND" }],
  ["image/webp", { extension: "webp", signature: (bytes: Buffer) => bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) }],
]);

export function productMediaDirectory(env: Record<string, string | undefined> = process.env) {
  const configured = env.FORNO_MEDIA_DIR;
  if (!configured) {
    if (env.FORNO_DATABASE_ROLE === "test" || env.FORNO_DATABASE_ROLE === "build") throw new Error("FORNO_MEDIA_DIR is required for isolated database roles.");
  }
  const mediaRoot = resolve(configured ?? join(process.cwd(), "data/media"));
  const databaseRoot = resolve(env.FORNO_DATABASE_DIR ?? join(process.cwd(), "data/pglite"));
  const normalizedMedia = process.platform === "win32" ? mediaRoot.toLowerCase() : mediaRoot;
  const normalizedDatabase = process.platform === "win32" ? databaseRoot.toLowerCase() : databaseRoot;
  if (normalizedMedia === normalizedDatabase || normalizedMedia.startsWith(`${normalizedDatabase}${sep}`)) {
    throw new Error("FORNO_MEDIA_DIR must be outside the PGLite database directory.");
  }
  return mediaRoot;
}

function assertMediaWritesAllowed() {
  if (process.env.FORNO_DATABASE_ROLE === "build") throw new Error("Product media writes are disabled during production builds.");
}

export function validateProductImage(bytes: Buffer, mimeType: string, originalName: string) {
  if (originalName.length > 255 || /[\\/]|\.\./.test(originalName) || /[\u0000-\u001f]/.test(originalName)) throw new Error("Invalid image filename.");
  const format = MIME_EXTENSIONS.get(mimeType);
  if (!format || bytes.length === 0 || bytes.length > PRODUCT_IMAGE_MAX_BYTES || !format.signature(bytes)) throw new Error("Upload must be a valid JPEG, PNG, or WebP image up to 5 MB.");
  return format.extension;
}

export async function writeProductImage(productId: number, bytes: Buffer, mimeType: string, originalName: string) {
  assertMediaWritesAllowed();
  const extension = validateProductImage(bytes, mimeType, originalName);
  const key = `products/${productId}/${randomUUID()}.${extension}`;
  const root = productMediaDirectory();
  const target = resolve(root, key);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("Invalid media path.");
  await mkdir(join(root, "products", String(productId)), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  return key;
}

export async function storeSynchronizedProductImage(key: string, bytes: Buffer, mimeType: string, contentHash: string) {
  assertMediaWritesAllowed();
  const extension = validateProductImage(bytes, mimeType, key.slice(key.lastIndexOf("/") + 1));
  if (!key.endsWith(`.${extension}`)) throw new Error("Product image key does not match its content type.");
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(contentHash) || actualHash !== contentHash) throw new Error("Product image content hash does not match.");
  const target = productImagePath(key);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (createHash("sha256").update(existing).digest("hex") !== actualHash) throw new Error("A different image already exists at this key.");
  }
  return actualHash;
}

export function productImagePath(key: string, env: Record<string, string | undefined> = process.env) {
  if (!/^products\/[1-9]\d*\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) throw new Error("Invalid product image key.");
  const root = productMediaDirectory(env);
  const target = resolve(root, key);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("Invalid media path.");
  return target;
}

export async function readProductImage(key: string) {
  if (process.env.FORNO_DATABASE_ROLE === "build") throw new Error("Product media reads are disabled during production builds.");
  return readFile(productImagePath(key));
}

export async function removeProductImage(key: string) {
  assertMediaWritesAllowed();
  await rm(productImagePath(key), { force: true });
}
