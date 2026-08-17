// GET /api/kb/template — download an Excel template (.xlsx) for product_spec bulk import
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";

// Minimal XLSX writer — no external deps. Produces a valid .xlsx file with one sheet.
// Columns mirror scripts/import_adminbase.py expected fields.
const COLUMNS = [
  "brand",
  "model",
  "category",
  "category_id",
  "highlights",
  "description",
  "box_contents",
  "warranty_period",
  "warranty_note",
  "weight",
  "dimensions",
  "platform",
  "notes",
];

// Build a minimal XLSX (Office Open XML) zip from scratch using only built-in zlib.
// This avoids adding a runtime dependency on a sheet library.
async function buildXlsx(): Promise<Buffer> {
  const { deflateRawSync } = require("zlib") as typeof import("zlib");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>` +
    `<row r="1">${COLUMNS.map(
      (c, i) =>
        `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${c}</t></is></c>`
    ).join("")}</row>` +
    `<row r="2">${COLUMNS.map(
      (c, i) =>
        `<c r="${String.fromCharCode(65 + i)}2" t="inlineStr"><is><t>${sampleFor(c)}</t></is></c>`
    ).join("")}</row>` +
    `</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="products" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  const relsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  const files: { path: string; data: Buffer }[] = [
    { path: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { path: "_rels/.rels", data: Buffer.from(relsXml, "utf8") },
    { path: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { path: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { path: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml, "utf8") },
  ];

  // Build a minimal ZIP (store + deflate) — central directory at end.
  const localParts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.path, "utf8");
    const crc = crc32(f.data);
    const compressed = deflateRawSync(f.data, { level: 9 });
    const useDeflate = compressed.length < f.data.length;

    // Local file header (30 bytes + name)
    const localHead = Buffer.alloc(30);
    localHead.writeUInt32LE(0x04034b50, 0);
    localHead.writeUInt16LE(20, 4); // version needed
    localHead.writeUInt16LE(0, 6); // flags
    localHead.writeUInt16LE(useDeflate ? 8 : 0, 8); // method
    localHead.writeUInt16LE(0, 10); // mod time
    localHead.writeUInt16LE(0, 12); // mod date
    localHead.writeUInt32LE(crc, 14);
    localHead.writeUInt32LE(useDeflate ? compressed.length : f.data.length, 18);
    localHead.writeUInt32LE(f.data.length, 22);
    localHead.writeUInt16LE(nameBuf.length, 26);
    localHead.writeUInt16LE(0, 28);
    const localBuf = Buffer.concat([localHead, nameBuf, useDeflate ? compressed : f.data]);
    localParts.push(localBuf);

    // Central directory header (46 bytes + name)
    const centralHead = Buffer.alloc(46);
    centralHead.writeUInt32LE(0x02014b50, 0);
    centralHead.writeUInt16LE(20, 4); // version made by
    centralHead.writeUInt16LE(20, 6); // version needed
    centralHead.writeUInt16LE(0, 8); // flags
    centralHead.writeUInt16LE(useDeflate ? 8 : 0, 10); // method
    centralHead.writeUInt16LE(0, 12); // mod time
    centralHead.writeUInt16LE(0, 14); // mod date
    centralHead.writeUInt32LE(crc, 16);
    centralHead.writeUInt32LE(useDeflate ? compressed.length : f.data.length, 20);
    centralHead.writeUInt32LE(f.data.length, 24);
    centralHead.writeUInt16LE(nameBuf.length, 28);
    centralHead.writeUInt16LE(0, 30); // extra
    centralHead.writeUInt16LE(0, 32); // comment
    centralHead.writeUInt16LE(0, 34); // disk
    centralHead.writeUInt16LE(0, 36); // internal attrs
    centralHead.writeUInt32LE(0, 38); // external attrs
    centralHead.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHead, nameBuf]));

    offset += localBuf.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(46);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with cd
  end.writeUInt16LE(files.length, 8); // entries on disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralBuf, end]);
}

function sampleFor(col: string): string {
  const samples: Record<string, string> = {
    brand: "IMILAB",
    model: "EC6 Dual Pro",
    category: "Camera",
    category_id: "cat_001",
    highlights: "2-lens, 2K, night vision",
    description: "Wireless security camera with dual lenses",
    box_contents: "Camera, mount, cable, manual",
    warranty_period: "12 months",
    warranty_note: "Local warranty",
    weight: "0.5 kg",
    dimensions: "10x10x8 cm",
    platform: "all",
    notes: "",
  };
  return samples[col] ?? "";
}

// CRC32 table-based implementation
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const xlsx = await buildXlsx();
  return new NextResponse(new Uint8Array(xlsx), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="kb_product_template.xlsx"',
    },
  });
}
