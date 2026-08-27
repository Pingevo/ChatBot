// POST /api/auth/signup/confirm — confirm signup with token from email link.
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร ไม่มีการสมัครด้วย token อีกต่อไป
// import { auth } from "@/backend/service/authService";
// import { json, error, readJson } from "@/backend/lib/http";
//
// interface SignupConfirmBody {
//   token?: string;
//   username?: string;
//   password?: string;
//   name?: string;
// }
//
// export async function POST(req: Request) { ... }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — ไม่มีการสมัครด้วย token อีกต่อไป" },
    { status: 410 }
  );
}
