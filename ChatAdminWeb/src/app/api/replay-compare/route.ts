// Replay Compare API — อ่านผล replay จากไฟล์ JSON ที่ replay_compare.py เซฟ
//
// GET  /api/replay-compare?file=/tmp/replay_50.json
//   → อ่านไฟล์ JSON ที่ script เซฟ ส่งกลับทั้งหมด (analysis + conversations)
//
// GET  /api/replay-compare?files=1
//   → list ไฟล์ JSON ใน /tmp ที่ขึ้นต้นด้วย replay_
//
// POST /api/replay-compare
//   body: { action: "run", limit?: number, oldest?: boolean, shop?: string }
//   → รัน replay_compare.py ใน background (spawn child process)
//     ส่งกลับ PID และ log path
export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { shouldUseChatV2, shouldUseChatV3 } from "@/backend/service/systemConfigService";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, basename } from "path";
import { spawn } from "child_process";

const REPO_ROOT = process.env.REPO_ROOT || "/Users/itdev4/Documents/GitHub/ChatBotProductMS";
const DEFAULT_FILE = "/Users/itdev4/Documents/GitHub/ChatBotProductMS/docs/test/results/replay2.json";
const RESULTS_DIR = "/Users/itdev4/Documents/GitHub/ChatBotProductMS/docs/test/results";

// 🔒 C3: Allowed directories for replay file reads
const ALLOWED_DIRS = [RESULTS_DIR, "/tmp"];

function _isPathAllowed(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + "/") || resolved === dir);
}

// ─── Helpers ──────────────────────────────────────────────

async function listReplayFiles(): Promise<{ path: string; size: number; mtime: string }[]> {
  const results: { path: string; size: number; mtime: string }[] = [];
  // ดูใน docs/test/results/ ก่อน
  const dirs = [RESULTS_DIR, "/tmp"];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      const replayFiles = files.filter(f => /^replay[_0-9]/i.test(f) && f.endsWith(".json"));
      for (const f of replayFiles) {
        const p = join(dir, f);
        try {
          const s = await stat(p);
          results.push({ path: p, size: s.size, mtime: s.mtime.toISOString() });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  results.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return results;
}

// ⚡ List history replays — ไฟล์ replay_conv_*.json (single conversation replays)
// อ่าน metadata จาก JSON แต่ละไฟล์ (conv_id, shop_name, generated_at, qa_count, status)
async function listHistoryReplays(): Promise<{
  conv_id: string;
  shop_name?: string;
  file_path: string;
  generated_at?: string;
  qa_count: number;
  status?: string;
  customer_name?: string;
}[]> {
  const results: {
    conv_id: string;
    shop_name?: string;
    file_path: string;
    generated_at?: string;
    qa_count: number;
    status?: string;
    customer_name?: string;
  }[] = [];
  const dirs = [RESULTS_DIR, "/tmp"];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      // ⚡ เฉพาะไฟล์ replay_conv_*.json (single conversation replays)
      const convFiles = files.filter(f => /^replay_conv_/i.test(f) && f.endsWith(".json"));
      for (const f of convFiles) {
        const p = join(dir, f);
        try {
          const content = await readFile(p, "utf-8");
          const data = JSON.parse(content);
          // ดึง conversation แรก (single conv replay มี 1 conversation)
          const conv = data.conversations?.[0];
          if (conv?.conv_id) {
            results.push({
              conv_id: conv.conv_id,
              shop_name: conv.shop_name,
              file_path: p,
              generated_at: data.generated_at,
              qa_count: conv.qa?.length || data.analysis?.total_qa || 0,
              status: data.status,
              customer_name: conv.customer_name,
            });
          }
        } catch {
          // skip invalid JSON
        }
      }
    } catch {
      // skip
    }
  }
  // เรียงจากใหม่สุดก่อน (ใช้ generated_at ถ้ามี ไม่งั้นใช้ file mtime ผ่าน path)
  results.sort((a, b) => (b.generated_at || "").localeCompare(a.generated_at || ""));
  return results;
}

async function runReplayScript(params: {
  limit?: number;
  oldest?: boolean;
  shop?: string;
  conv?: string;
  useV2?: boolean;
  useV3?: boolean;
}): Promise<{ pid: number; logPath: string; savePath: string; alreadyRunning: boolean }> {
  const limit = params.limit ?? 50;
  const oldest = params.oldest ?? true;
  // ⚡ ถ้ารัน single conversation → ใช้ชื่อไฟล์ตาม conv_id
  const savePath = params.conv
    ? `${RESULTS_DIR}/replay_conv_${params.conv.slice(-12)}_${Date.now()}.json`
    : `${RESULTS_DIR}/replay_${limit}_${Date.now()}.json`;
  const logPath = `/tmp/replay_${limit}_${Date.now()}_log.txt`;

  // ⚡ เช็คก่อนว่ามี replay_compare.py รันอยู่ไหม — ถ้ามี ไม่สั่งรันซ้อน
  // (ยกเว้นถ้าเป็น single conv และ process เดิมรัน batch — กรณีนี้อนุญาตให้รันซ้อนได้ เพราะใช้ resource น้อย)
  // 🔒 L6: Use async execFile instead of execSync to avoid blocking event loop
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  if (!params.conv) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", "replay_compare.py"]);
      const out = stdout.trim();
      if (out) {
        const pids = out.split("\n").filter(Boolean);
        if (pids.length > 0) {
          return { pid: parseInt(pids[0]), logPath: "", savePath: "", alreadyRunning: true };
        }
      }
    } catch {
      // pgrep ไม่เจอ = ไม่มี process รันอยู่ → รันได้
    }
  }

  const args = [
    "chatbot/frontendScript/replay_compare.py",
    "--limit", String(limit),
    "--quiet",
    "--save", savePath,
  ];
  if (oldest && !params.conv) args.push("--oldest");
  if (params.shop) {
    args.push("--shop", params.shop);
  }
  if (params.conv) {
    args.push("--conv", params.conv);
  }
  // ⚡ chat_engine — ส่ง --v2/--v3 flag ถ้า config เลือก หรือ caller บังคับ (v3 มี priority เหนือ v2)
  if (params.useV3) {
    args.push("--v3");
  } else if (params.useV2) {
    args.push("--v2");
  }

  const child = spawn(".venv/bin/python", args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // เขียน log path ลงไฟล์เพื่อให้ frontend ตามได้
  await writeFile(logPath, `PID: ${child.pid}\nSave: ${savePath}\n`).catch(() => {});

  return { pid: child.pid ?? 0, logPath, savePath, alreadyRunning: false };
}

// ─── Route Handler ────────────────────────────────────────

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const file = url.searchParams.get("file");
  const files = url.searchParams.get("files");
  const history = url.searchParams.get("history");

  if (files) {
    const list = await listReplayFiles();
    return json({ files: list });
  }

  // ⚡ List history replays (single conversation replays)
  if (history) {
    const list = await listHistoryReplays();
    return json({ history: list });
  }

  const filePath = file || DEFAULT_FILE;
  // 🔒 C3: Block path traversal — only allow reads from ALLOWED_DIRS
  if (!_isPathAllowed(filePath)) {
    return json({ error: "access_denied", message: "ไฟล์ไม่ได้อยู่ใน directory ที่อนุญาต" }, 403);
  }
  if (!existsSync(filePath)) {
    return json({
      error: "file_not_found",
      // 🔒 L2: Don't expose full filesystem path
      message: "ยังไม่มีไฟล์ผล replay — กดปุ่ม Run ก่อน",
    }, 404);
  }

  try {
    const content = await readFile(filePath, "utf-8");
    const data = JSON.parse(content);
    return json(data);
  } catch (e) {
    // 🔒 L2: Don't expose raw error (may contain filesystem path)
    return error("failed to read/parse replay file", 500);
  }
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body.action === "run") {
    // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม) — v3 มี priority เหนือ v2
    const configUseV3 = await shouldUseChatV3();
    const configUseV2 = !configUseV3 && await shouldUseChatV2();
    const result = await runReplayScript({
      limit: body.limit,
      oldest: body.oldest,
      shop: body.shop,
      useV2: configUseV2,
      useV3: configUseV3,
    });
    if (result.alreadyRunning) {
      return json({
        ...result,
        message: `มี replay script รันอยู่แล้ว (PID: ${result.pid}) — ไม่สั่งรันซ้อน`,
      });
    }
    return json(result);
  }

  // ⚡ รัน replay แค่ conversation เดียว — สำหรับ inbox picker
  if (body.action === "run_conv") {
    if (!body.conversation_id || typeof body.conversation_id !== "string") {
      return error("conversation_id is required for run_conv", 422);
    }
    // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม) — v3 มี priority เหนือ v2
    const configUseV3 = await shouldUseChatV3();
    const configUseV2 = !configUseV3 && await shouldUseChatV2();
    const result = await runReplayScript({
      conv: String(body.conversation_id),
      shop: body.shop,
      useV2: configUseV2,
      useV3: configUseV3,
    });
    if (result.alreadyRunning) {
      return json({
        ...result,
        message: `มี replay script รันอยู่แล้ว (PID: ${result.pid}) — ไม่สั่งรันซ้อน`,
      });
    }
    return json(result);
  }

  if (body.action === "status") {
    // ⚡ เช็คสถานะ script ที่รันอยู่
    // 🔒 L6: Use async execFile instead of execSync to avoid blocking event loop
    const { execFile: _execFile } = await import("child_process");
    const { promisify: _promisify } = await import("util");
    const _execFileAsync = _promisify(_execFile);
    try {
      const { stdout } = await _execFileAsync("pgrep", ["-f", "replay_compare.py"]);
      const out = stdout.trim();
      const pids = out.split("\n").filter(Boolean);
      return json({ running: pids.length > 0, pids });
    } catch {
      return json({ running: false, pids: [] });
    }
  }

  return error("unknown action", 400);
}
