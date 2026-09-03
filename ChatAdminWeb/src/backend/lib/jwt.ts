// JWT helpers — server-side only, uses jose (Edge-compatible).
// ⚠️ Auth tokens (signup/reset) ถูกลบแล้ว — ระบบใช้ SSO เท่านั้น
import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { createHash, randomUUID } from "crypto";
import { serverConfig } from "./config";

const secret = new TextEncoder().encode(serverConfig.jwtSecret);

export interface SessionPayload extends JWTPayload {
  type: "session";
  admin_id: string;
  jti: string;
}

// ---- Session tokens (8 hours) ----

export async function createSessionToken(adminId: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + serverConfig.sessionHours * 3600;
  const token = await new SignJWT({
    type: "session",
    admin_id: adminId,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: serverConfig.jwtAlgo })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);
  return { token, exp };
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [serverConfig.jwtAlgo],
    });
    if (payload.type !== "session") return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

// ---- Token hashing for DB storage ----

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
