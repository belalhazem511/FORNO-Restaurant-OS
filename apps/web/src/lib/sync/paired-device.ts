import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncDevices } from "@/lib/db/schema";

export async function authenticatePairedDevice(request: Request) {
  const deviceId = request.headers.get("x-forno-device-id") ?? "";
  const credential = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || credential.length < 32 || credential.length > 100) return null;
  const [device] = await db.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).limit(1);
  if (!device || device.status !== "paired" || !device.credential_hash || device.revoked_at) return null;
  const actual = createHash("sha256").update(credential).digest();
  const expected = Buffer.from(device.credential_hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return device;
}
