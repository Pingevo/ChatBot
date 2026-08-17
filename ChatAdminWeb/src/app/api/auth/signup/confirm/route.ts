// POST /api/auth/signup/confirm — confirm signup with token from email link.
import { auth } from "@/backend/service/authService";
import { json, error, readJson } from "@/backend/lib/http";

interface SignupConfirmBody {
  token?: string;
  username?: string;
  password?: string;
  name?: string;
}

export async function POST(req: Request) {
  const body = await readJson<SignupConfirmBody>(req);
  if (!body || !body.token || !body.username || !body.password) {
    return error("token, username, password จำเป็นต้องกรอก", 422);
  }
  if (body.username.length < 3 || body.username.length > 32) {
    return error("username ต้องมี 3-32 ตัวอักษร", 422);
  }
  if (body.password.length < 8) {
    return error("password ต้องอย่างน้อย 8 ตัวอักษร", 422);
  }

  const payload = await auth.consumeAuthToken(body.token);
  if (!payload) {
    return error("token ไม่ถูกต้องหรือหมดอายุแล้ว", 401);
  }
  if (payload.purpose !== "signup") {
    return error("token ไม่ใช่สำหรับสมัคร", 400);
  }
  if (!payload.email) {
    return error("token ไม่มี email", 400);
  }

  if (await auth.getAdminByEmail(payload.email)) {
    return error("email นี้สมัครแล้ว", 409);
  }
  if (await auth.getAdminByUsername(body.username)) {
    return error("username นี้ถูกใช้แล้ว", 409);
  }

  const admin = await auth.createAdmin({
    email: payload.email,
    username: body.username,
    password: body.password,
    name: body.name,
    role: "admin", // signup creates admin only — superadmin via seed
    createdBy: "signup",
  });

  return json({ admin: auth.safeAdmin(admin) });
}
