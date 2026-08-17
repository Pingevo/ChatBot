// Password hashing — bcrypt with sha256 pre-hash (matches Python admin/auth.py).
import bcrypt from "bcryptjs";
import { createHash } from "crypto";

const BCRYPT_ROUNDS = 12;

function preHash(plain: string): string {
  // bcrypt limits to 72 bytes — sha256 first to support any length / charset.
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

export async function hashPassword(plain: string): Promise<string> {
  const pre = preHash(plain);
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  return bcrypt.hash(pre, salt);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    const pre = preHash(plain);
    return bcrypt.compare(pre, hashed);
  } catch {
    return false;
  }
}
