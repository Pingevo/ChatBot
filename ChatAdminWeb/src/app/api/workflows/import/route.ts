// POST /api/workflows/import — apply Zaapi import batch เป็น disabled drafts
// Server-side preview→apply (ไม่เชื่อ client-computed report) — atomic per batch,
// idempotent ด้วย deterministic batch_id; malformed/unsupported → zero writes
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { workflowService } from "@/backend/service/workflowService";
import { previewZaapiFlows, type IndexRow } from "@/lib/workflow/zaapiImport";

export async function POST(req: NextRequest) {
  const r = await requirePageEdit(req, "workflow");
  if (!r.ok) return r.response;

  const body = await readJson<{ flows?: unknown; indexRows?: IndexRow[]; index?: { rows?: IndexRow[] } }>(req);
  if (!body?.flows) return error("flows JSON required", 422);
  const indexRows = body.indexRows ?? body.index?.rows;

  let batch;
  try {
    batch = previewZaapiFlows(body.flows, { indexRows });
  } catch (err) {
    return error(`invalid export: ${(err as Error).message}`, 422);
  }
  try {
    const applied = await workflowService.applyImportBatch(batch, r.ctx.admin.admin_id);
    return json({
      ok: true,
      already_applied: applied.already_applied ?? false,
      batch_id: applied.batch_id,
      workflow_ids: applied.workflow_ids,
      flow_count: applied.flow_count,
      node_count: applied.node_count,
      edge_count: applied.edge_count,
      bindings_total: applied.bindings_total,
      warnings: applied.warnings,
      conflicts: applied.conflicts,
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    // in-progress concurrent apply → 409 · validation/malformed → 422 · infra → 500
    if (e.code === "IMPORT_IN_PROGRESS") return error(e.message, 409);
    if (e.code === "IMPORT_INVALID") return error(`import apply rejected: ${e.message}`, 422);
    return error(`import apply failed: ${e.message}`, 500);
  }
}
