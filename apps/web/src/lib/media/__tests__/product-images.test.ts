import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_IMAGE_MAX_BYTES, productImagePath, removeProductImage, validateProductImage, writeProductImage } from "../product-images";

const directories: string[] = [];
const previousMediaDir = process.env.FORNO_MEDIA_DIR;
const previousRole = process.env.FORNO_DATABASE_ROLE;

async function isolatedMedia() {
  const directory = await mkdtemp(join(tmpdir(), "forno-product-media-test-"));
  directories.push(directory);
  process.env.FORNO_MEDIA_DIR = directory;
  process.env.FORNO_DATABASE_ROLE = "test";
  return directory;
}

afterEach(async () => {
  if (previousMediaDir === undefined) delete process.env.FORNO_MEDIA_DIR;
  else process.env.FORNO_MEDIA_DIR = previousMediaDir;
  if (previousRole === undefined) delete process.env.FORNO_DATABASE_ROLE;
  else process.env.FORNO_DATABASE_ROLE = previousRole;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("product image storage", () => {
  it("stores validated uploads at opaque persistent keys and replaces/removes them explicitly", async () => {
    const directory = await isolatedMedia();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64");
    const first = await writeProductImage(42, png, "image/png", "menu.png");
    const second = await writeProductImage(42, png, "image/png", "new.png");
    expect(first).not.toBe(second);
    expect(await readFile(productImagePath(first))).toEqual(png);
    expect(productImagePath(second)).toContain(directory);
    await removeProductImage(first);
    await expect(access(productImagePath(first))).rejects.toThrow();
    expect(await readFile(productImagePath(second))).toEqual(png);
    await removeProductImage(second);
  });

  it("rejects mismatched content, unsupported types, oversized data, and path-like filenames", async () => {
    const valid = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64");
    expect(() => validateProductImage(valid, "image/jpeg", "x.jpg")).toThrow();
    expect(() => validateProductImage(valid, "image/gif", "x.gif")).toThrow();
    expect(() => validateProductImage(Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES + 1), "image/png", "x.png")).toThrow();
    expect(() => validateProductImage(valid, "image/png", "../x.png")).toThrow();
    expect(() => productImagePath("products/42/../../secret.png", { FORNO_MEDIA_DIR: tmpdir() })).toThrow();
  });

  it("requires isolated media directories for test and build roles", () => {
    expect(() => productImagePath("products/42/12345678-1234-1234-1234-123456789012.png", { FORNO_DATABASE_ROLE: "test" })).toThrow("FORNO_MEDIA_DIR is required");
  });

  it("prevents production builds from reading or writing product media", async () => {
    await isolatedMedia();
    process.env.FORNO_DATABASE_ROLE = "build";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64");
    await expect(writeProductImage(42, png, "image/png", "image.png")).rejects.toThrow("writes are disabled");
    await expect(import("../product-images").then(({ readProductImage }) => readProductImage("products/42/12345678-1234-1234-1234-123456789012.png"))).rejects.toThrow("reads are disabled");
  });
});
