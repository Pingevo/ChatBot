// JWT helpers — server-side only, uses jose (Edge-compatible).
import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { createHash, randomUUID } from "crypto";
import { serverConfig } from "./config";

const secret = new TextEncoder().encode(serverConfig.jwtSecret);

export interface SessionPayload extends JWTPayload {
  type: "session";
  admin_id: string;
  jti: string;
}

export interface AuthTokenPayload extends JWTPayload {
  type: "auth";
  purpose: "signup" | "reset_password";
  email: string;
  admin_id?: string;
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

// ---- Auth tokens (signup / reset_password — 15 minutes) ----

export async function createAuthToken(
  purpose: "signup" | "reset_password",
  email: string,
  adminId?: string
): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + serverConfig.authTokenMinutes * 60;
  const token = await new SignJWT({
    type: "auth",
    purpose,
    email,
    admin_id: adminId,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: serverConfig.jwtAlgo })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);
  return { token, exp };
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [serverConfig.jwtAlgo],
    });
    if (payload.type !== "auth") return null;
    return payload as AuthTokenPayload;
  } catch {
    return null;
  }
}

// ---- Token hashing for DB storage ----

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
