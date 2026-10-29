// one-off: import Zaapi flow corpus ทั้งหมดลง Mongo จริง (dev) — ผ่าน service owner เดียวกับ route
// รัน: npx tsx scripts/import-zaapi-corpus.ts [dir]
//   dir = โฟลเดอร์ที่มี all-flows.json + _index_data.json (default ~/Downloads/zaapi/data/flows)
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dir = resolve(process.argv[2] || `${homedir()}/Downloads/zaapi/data/flows`);

async function main() {
  const { previewZaapiFlows } = await import("../src/lib/workflow/zaapiImport");
  const svc = await import("../src/backend/service/workflowService");

  const flowsJson = JSON.parse(readFileSync(resolve(dir, "all-flows.json"), "utf8"));
  const indexJson = JSON.parse(readFileSync(resolve(dir, "_index_data.json"), "utf8"));
  const indexRows = (indexJson.rows || []).map((r: Record<string, unknown>) => ({ wid: r.wid, name: r.name }));

  const batch = previewZaapiFlows(flowsJson, { indexRows });
  console.log(`preview: ${batch.flowCount} flows · ${batch.nodeCount} nodes · ${batch.edgeCount} edges · ok=${batch.ok}`);
  console.log(`bindings total: ${batch.bindingsTotal} · unsupported: ${batch.unsupportedTypes.length} · conflicts: ${batch.conflicts.length}`);
  for (const r of batch.reports) {
    console.log(`  ${r.name.slice(0, 46).padEnd(46)} nodes=${r.nodeCount} edges=${r.edgeCount} bindings=${r.bindings.length} synth=${r.stepRefs.synthesized} ok=${r.structural.ok}`);
  }
  if (!batch.ok) {
    for (const r of batch.reports.filter((x) => !x.structural.ok)) {
      console.log("  STRUCTURAL FAIL:", r.name, r.structural.errors);
    }
    throw new Error("batch not ok — abort before write");
  }
  const res = await svc.applyImportBatch(batch, "devin-import");
  console.log(`\napply: ok=${res.ok} already_applied=${res.already_applied ?? false} batch=${res.batch_id}`);
  console.log(`  workflows: ${res.workflow_ids.length} · flows=${res.flow_count} · nodes=${res.node_count} · edges=${res.edge_count} · bindings=${res.bindings_total}`);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
