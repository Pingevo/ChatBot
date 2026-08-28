// API route — อ่าน test results จากหลายไฟล์ + pagination + schema normalization
//
// รองรับ 3 schema:
//   1. test_200_results.json        — {i, shop, msg, cat, source, web_search, products, elapsed, ok, answer}
//   2. test_comprehensive_results.json — {test_id, category, message, expected, answer_preview, products, product_count, source, is_correct, notes, timestamp}
//   3. testQA2_results.json         — {test_id, batch, message, answer_preview, answer_full, product_names, product_count, source, elapsed, expected, check, timestamp}
//
// ทุก schema ถูก normalize เป็น unified format ก่อนส่งกลับ
import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";

export const dynamic = "force-dynamic";

// ── ไฟล์ที่รองรับ — pattern: *results*.json (กว้างขึ้น รองรับ testQA2_results.json) ──
const FILE_PATTERN = /results.*\.json$|.*_results\.json$/i;

// directories ที่จะสแกน (relative จาก cwd = ChatAdminWeb/)
const SEARCH_DIRS = [
  ".",                                    // ChatAdminWeb/
  "..",                                   // ChatBotProductMS/
  join("..", "testresult"),               // ChatBotProductMS/testresult/ (โฟลเดอร์จริง)
  join("..", "test_results"),             // ChatBotProductMS/test_results/ (fallback)
  join("..", "scripts"),                  // ChatBotProductMS/scripts/
  join("..", ".."),                       // ขึ้นไปอีกระดับ
];

interface TestFileInfo {
  filename: string;
  path: string;
  label: string;
}

async function listTestFiles(cwd: string): Promise<TestFileInfo[]> {
  const found = new Map<string, string>(); // filename → full path (กันซ้ำ)
  for (const dir of SEARCH_DIRS) {
    const absDir = join(cwd, dir);
    try {
      const entries = await readdir(absDir);
      for (const e of entries) {
        if (FILE_PATTERN.test(e)) {
          const fullPath = join(absDir, e);
          if (!found.has(e)) {
            found.set(e, fullPath);
          }
        }
      }
    } catch {}
  }
  // คืนเป็น array ของ { filename, path, label }
  const result: { filename: string; path: string; label: string }[] = [];
  for (const [filename, path] of found) {
    // label ที่อ่านง่าย — แสดง subdirectory ถ้ามี
    const relPath = path.replace(cwd + "/", "").replace(/^\.\.\//, "");
    result.push({ filename, path, label: relPath });
  }
  return result.sort((a, b) => a.filename.localeCompare(b.filename));
}

// หา full path ของไฟล์จาก filename
async function resolveFilePath(filename: string, cwd: string): Promise<string | null> {
  const files = await listTestFiles(cwd);
  const found = files.find((f) => f.filename === filename || f.label === filename);
  if (found) return found.path;
  // fallback: ลองอ่านตรงจาก path ที่ส่งมา
  for (const dir of SEARCH_DIRS) {
    const p = join(cwd, dir, filename);
    try {
      await stat(p);
      return p;
    } catch {}
  }
  return null;
}

// ── Normalize: แปลง schema ต่างๆ ให้เป็น unified format ──
interface UnifiedResult {
  i: number;
  shop: string;
  msg: string;
  cat: string;
  source: string;
  web_search: string;
  products: number;
  elapsed: number;
  ok: string;       // "✅" | "❌" | "ERR" | "—"
  answer: string;
  expected?: string;
  notes?: string;
  check?: string;
  test_id?: string;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function normalizeResults(raw: any[]): UnifiedResult[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const first = raw[0];
  const keys = new Set(Object.keys(first));

  // ── Schema 1: test_200_results.json ──
  if (keys.has("ok") && keys.has("msg") && keys.has("shop")) {
    return raw.map((r, idx) => ({
      i: typeof r.i === "number" ? r.i : parseInt(r.i, 10) || idx + 1,
      shop: String(r.shop || ""),
      msg: String(r.msg || ""),
      cat: String(r.cat || "unknown"),
      source: String(r.source || ""),
      web_search: String(r.web_search || "N"),
      products: toNum(r.products),
      elapsed: toNum(r.elapsed),
      ok: String(r.ok || "—"),
      answer: String(r.answer || ""),
    }));
  }

  // ── Schema 2: test_comprehensive_results.json ──
  if (keys.has("is_correct") && keys.has("answer_preview") && keys.has("test_id")) {
    return raw.map((r, idx) => {
      // ดึง shop จาก test_id เช่น "A-YoupinOfficialStore-1" → "YoupinOfficialStore"
      const tid = String(r.test_id || "");
      const shopMatch = tid.match(/^[A-Z]-(.+?)-\d+$/);
      const shop = shopMatch ? shopMatch[1] : "";
      const isCorrect = String(r.is_correct).toLowerCase() === "true";
      return {
        i: idx + 1,
        shop,
        msg: String(r.message || ""),
        cat: String(r.category || "unknown"),
        source: String(r.source || ""),
        web_search: "N",
        products: toNum(r.product_count ?? r.products),
        elapsed: 0,
        ok: isCorrect ? "✅" : "❌",
        answer: String(r.answer_preview || ""),
        expected: String(r.expected || ""),
        notes: String(r.notes || ""),
        test_id: tid,
      };
    });
  }

  // ── Schema 3: testQA2_results.json ──
  if (keys.has("batch") && keys.has("answer_full") && keys.has("check")) {
    return raw.map((r, idx) => ({
      i: idx + 1,
      shop: "",  // ไม่มี shop field — ดึงจาก message ไม่ได้ง่าย
      msg: String(r.message || ""),
      cat: String(r.batch || "unknown"),
      source: String(r.source || ""),
      web_search: "N",
      products: toNum(r.product_count),
      elapsed: toNum(r.elapsed),
      ok: "—",  // ไม่มี pass/fail field ชัดเจน
      answer: String(r.answer_preview || r.answer_full || ""),
      expected: String(r.expected || ""),
      check: String(r.check || ""),
      test_id: String(r.test_id || ""),
    }));
  }

  // ── Fallback: พยายาม map ที่เหลือ ──
  return raw.map((r, idx) => ({
    i: r.i ?? idx + 1,
    shop: String(r.shop || ""),
    msg: String(r.msg || r.message || ""),
    cat: String(r.cat || r.category || r.batch || "unknown"),
    source: String(r.source || ""),
    web_search: String(r.web_search || "N"),
    products: toNum(r.products ?? r.product_count),
    elapsed: toNum(r.elapsed),
    ok: String(r.ok || (r.is_correct !== undefined ? (String(r.is_correct).toLowerCase() === "true" ? "✅" : "❌") : "—")),
    answer: String(r.answer || r.answer_preview || r.answer_full || ""),
    expected: String(r.expected || ""),
    notes: String(r.notes || ""),
    check: String(r.check || ""),
    test_id: String(r.test_id || ""),
  }));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const cwd = process.cwd();

  // ── mode=list — แสดงรายชื่อไฟล์ ──
  if (url.searchParams.get("mode") === "list") {
    try {
      const files = await listTestFiles(cwd);
      if (files.length === 0) {
        return NextResponse.json({ files: [], error: "ไม่พบไฟล์ test results" }, { status: 404 });
      }
      // คืนทั้ง filename และ label (path ที่อ่านง่าย)
      return NextResponse.json({
        files: files.map((f) => f.filename),
        file_details: files.map((f) => ({ filename: f.filename, label: f.label })),
      });
    } catch (e) {
      return NextResponse.json({ error: "failed to list files", detail: String(e) }, { status: 500 });
    }
  }

  // ── mode=data — อ่านไฟล์ + normalize + pagination ──
  const filename = url.searchParams.get("file") || "test_200_results.json";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(url.searchParams.get("page_size") || "50", 10);

  try {
    const filePath = await resolveFilePath(filename, cwd);
    if (!filePath) {
      return NextResponse.json(
        { error: `${filename} not found — รัน test script ก่อน` },
        { status: 404 }
      );
    }

    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    const results = normalizeResults(raw);

    // pagination
    const total = results.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageData = results.slice(start, end);

    // stats รวมทั้งหมด
    const pass = results.filter((r) => r.ok === "✅").length;
    const fail = results.filter((r) => r.ok === "❌").length;
    const err = results.filter((r) => r.ok === "ERR").length;
    const unknown = results.filter((r) => r.ok === "—").length;
    const totalTime = results.reduce((s, r) => s + (r.elapsed || 0), 0);
    const wsCount = results.filter((r) => r.web_search === "Y").length;

    // category stats
    const catMap: Record<string, { pass: number; fail: number; err: number; total: number }> = {};
    for (const r of results) {
      const cat = r.cat || "unknown";
      if (!catMap[cat]) catMap[cat] = { pass: 0, fail: 0, err: 0, total: 0 };
      catMap[cat].total++;
      if (r.ok === "✅") catMap[cat].pass++;
      else if (r.ok === "❌") catMap[cat].fail++;
      else if (r.ok === "ERR") catMap[cat].err++;
    }

    return NextResponse.json({
      results: pageData,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1,
      },
      stats: {
        total,
        pass,
        fail,
        err,
        unknown,
        avg_time: total > 0 ? totalTime / total : 0,
        web_search_count: wsCount,
        cat_map: catMap,
      },
      file: filename,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "failed to read test results", detail: String(e) },
      { status: 500 }
    );
  }
}
