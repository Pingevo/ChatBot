// POST /api/kb/upload — upload an .xlsx file and upsert product_spec entries
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { knowledgeBaseService } from "@/backend/service/knowledgeBaseService";

// Minimal XLSX reader: unzip + parse sheet1 XML + extract rows.
// Avoids adding a runtime dependency on a sheet library.
// 🔒 มีข้อจำกัดขนาดเพื่อป้องกัน zip bomb / OOM
const MAX_UNCOMPRESSED_ENTRY = 50 * 1024 * 1024; // 50MB ต่อ entry
const MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024; // 100MB รวมทุก entry

async function parseXlsx(buf: Buffer): Promise<Record<string, string>[]> {
  const { inflateRawSync } = require("zlib") as typeof import("zlib");

  // Parse ZIP central directory to find file entries
  const entries: { name: string; data: Buffer }[] = [];
  let i = buf.length - 22;
  while (i >= 0) {
    if (buf.readUInt32LE(i) === 0x06054b50) break;
    i--;
  }
  if (i < 0) throw new Error("invalid xlsx (no end of central directory)");
  const cdSize = buf.readUInt32LE(i + 12);
  const cdOffset = buf.readUInt32LE(i + 16);
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let totalUncompressed = 0;
  while (p < cdEnd) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    // 🔒 ป้องกัน zip bomb — ตรวจขนาดก่อน decompress
    if (uncompSize > MAX_UNCOMPRESSED_ENTRY) {
      throw new Error(`entry "${name}" too large when decompressed (${uncompSize} bytes)`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error("total uncompressed size exceeds limit");
    }
    // Read local header to find data start
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (data.length === uncompSize || method === 0) {
      entries.push({ name, data });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  const sheet = entries.find((e) => e.name === "xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("no sheet1 found");

  // Parse shared strings (if any)
  const sst = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sharedStrings: string[] = [];
  if (sst) {
    const sstXml = sst.data.toString("utf8");
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sstXml)) !== null) {
      const texts = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      sharedStrings.push(texts.map((t) => t.replace(/<[^>]+>/g, "")).join(""));
    }
  }

  // Parse sheet rows
  const sheetXml = sheet.data.toString("utf8");
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const cellRe = /<c[^>]*?(?:\st="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t>([\s\S]*?)<\/t><\/is>)?<\/c>/g;
    const cells: { col: number; value: string }[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowContent)) !== null) {
      const refMatch = cellMatch[0].match(/r="([A-Z]+)\d+/);
      const col = refMatch ? colLetterToIndex(refMatch[1]) : cells.length;
      const t = cellMatch[1];
      const v = cellMatch[2] ?? cellMatch[3] ?? "";
      const value = t === "s" ? sharedStrings[parseInt(v, 10)] ?? "" : v;
      cells.push({ col, value });
    }
    if (cells.length > 0) {
      const maxCol = Math.max(...cells.map((c) => c.col));
      const arr = new Array(maxCol + 1).fill("");
      for (const c of cells) arr[c.col] = c.value;
      rows.push(arr);
    }
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = rows[r][c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function colLetterToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  // 🔒 จำกัดขนาดไฟล์ — 10 MB สูงสุด
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_ROWS = 10000;

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return error("file is required", 400);
  if (!file.name.match(/\.xlsx$/i)) return error("only .xlsx files are supported", 400);
  if (file.size > MAX_FILE_SIZE) {
    return error(`file too large — max ${MAX_FILE_SIZE / 1024 / 1024}MB, got ${Math.round(file.size / 1024 / 1024)}MB`, 413);
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // 🔒 ตรวจ magic bytes ของ XLSX (ZIP archive — PK\x03\x04)
  // XLSX เป็น ZIP-based format จริง — ต้องขึ้นต้นด้วย PK signature
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    return error("invalid file — not a valid XLSX (ZIP) archive", 400);
  }

  let rows: Record<string, string>[];
  try {
    rows = await parseXlsx(buf);
  } catch (e: unknown) {
    return error(`failed to parse xlsx: ${(e as Error).message}`, 400);
  }

  if (rows.length === 0) return error("xlsx contains no data rows", 400);
  // 🔒 จำกัดจำนวน rows ป้องกัน resource exhaustion
  if (rows.length > MAX_ROWS) {
    return error(`too many rows — max ${MAX_ROWS}, got ${rows.length}`, 413);
  }

  const sourceFile = file.name;
  let upserted = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.brand && !row.model && !row.category) continue;
    await knowledgeBaseService.upsertProductSpecFromExcelRow(
      {
        type: "product_spec",
        brand: row.brand || undefined,
        model: row.model || undefined,
        category: row.category || undefined,
        category_id: row.category_id || undefined,
        highlights: row.highlights || undefined,
        description: row.description || undefined,
        box_contents: row.box_contents || undefined,
        warranty_period: row.warranty_period || undefined,
        warranty_note: row.warranty_note || undefined,
        weight: row.weight || undefined,
        dimensions: row.dimensions || undefined,
        platform: (row.platform as any) || "all",
        notes: row.notes || undefined,
        source_file: sourceFile,
        source_row: i + 2, // 1-based + header
      },
      r.ctx.admin.admin_id
    );
    upserted++;
  }

  return json({ ok: true, upserted, total_rows: rows.length, source_file: sourceFile });
}
