// POST /api/auth/reset/confirm — set new password with token from email link.
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร รีเซตรหัสผ่านผ่าน SSO provider
// import { auth } from "@/backend/service/authService";
// import { json, error, readJson } from "@/backend/lib/http";
//
// export async function POST(req: Request) { ... }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — รีเซตรหัสผ่านผ่าน SSO provider" },
    { status: 410 }
  );
}
