import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import { NextRequest } from "next/server";
import { COLLECTIONS, getCollection } from "@/backend/db/mongoClient";
import { requirePageEdit } from "@/backend/middleware/authorize";

const SNAPSHOT_COLLECTIONS = [
  { role: "zaapi_kb", name: COLLECTIONS.zaapiKb },
  { role: "zaapi_kb_files", name: COLLECTIONS.zaapiKbFiles },
  { role: "zaapi_kb_import_log", name: COLLECTIONS.zaapiKbImportLog },
] as const;

type SnapshotRole = (typeof SNAPSHOT_COLLECTIONS)[number]["role"];

export const dynamic = "force-dynamic";

function _recordLine(role: SnapshotRole, document: Record<string, unknown>): string {
  return `${BSON.EJSON.stringify({ kind: "record", collection: role, document }, { relaxed: false })}\n`;
}

async function* _snapshotLines(): AsyncGenerator<string> {
  const capturedAt = new Date().toISOString();
  const counts = Object.fromEntries(SNAPSHOT_COLLECTIONS.map(({ role }) => [role, 0])) as Record<SnapshotRole, number>;
  const hashes = Object.fromEntries(SNAPSHOT_COLLECTIONS.map(({ role }) => [role, createHash("sha256")])) as Record<SnapshotRole, ReturnType<typeof createHash>>;
  const collectionNames = Object.fromEntries(SNAPSHOT_COLLECTIONS.map(({ role, name }) => [role, name])) as Record<SnapshotRole, string>;
  if (new Set(Object.values(collectionNames)).size !== SNAPSHOT_COLLECTIONS.length
      || Object.values(collectionNames).some((name) => !name.trim()))
    throw new Error("Zaapi snapshot collection names are invalid");
  const header = {
    kind: "header",
    format: "zaapi-kb-snapshot",
    version: 1,
    captured_at: capturedAt,
    collections: SNAPSHOT_COLLECTIONS.map(({ role }) => role),
    collection_names: collectionNames,
  };
  yield `${JSON.stringify(header)}\n`;

  for (const { role, name } of SNAPSHOT_COLLECTIONS) {
    const collection = await getCollection(name);
    const cursor = collection.find({}, {
      sort: { _id: 1 },
      promoteValues: false,
      promoteLongs: false,
      promoteBuffers: false,
      bsonRegExp: true,
    });
    try {
      for await (const document of cursor) {
        const line = _recordLine(role, document);
        hashes[role].update(line, "utf8");
        counts[role] += 1;
        yield line;
      }
    } finally {
      await cursor.close();
    }
  }

  const footer = {
    kind: "footer",
    complete: true,
    counts,
    sha256: Object.fromEntries(
      SNAPSHOT_COLLECTIONS.map(({ role }) => [role, hashes[role].digest("hex")]),
    ),
  };
  yield `${JSON.stringify(footer)}\n`;
}

export async function GET(req: NextRequest) {
  const r = await requirePageEdit(req, "kb");
  if (!r.ok) return r.response;

  const iterator = _snapshotLines()[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  const filename = `zaapi-kb-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
