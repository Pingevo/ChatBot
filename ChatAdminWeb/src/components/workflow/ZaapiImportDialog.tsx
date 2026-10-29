// ZaapiImportDialog — shared import dialog (list page + editor)
//   dry-run preview (client-side parse) → Apply as disabled drafts (server apply)
//   editor ส่ง onLoadReportToCanvas เพิ่ม — โหลดโครง flow ลง canvas ที่กำลังแก้
//   (draft-only ไม่เขียน DB) — list page ไม่ส่ง → ปุ่มนั้นไม่ render
"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "@/components/ui/Toast";
import { parseZaapiImportInputs, type ImportPreviewReport } from "@/lib/workflow/zaapiImport";

export interface ZaapiImportDialogProps {
  open: boolean;
  onClose: () => void;
  onLoadReportToCanvas?: (report: ImportPreviewReport) => void;  // editor only
  onApplied?: (result: {
    flow_count?: number; workflow_ids?: string[]; batch_id?: string;
    already_applied?: boolean; bindings_total?: number;
  }) => void;
}

export function ZaapiImportDialog({ open, onClose, onLoadReportToCanvas, onApplied }: ZaapiImportDialogProps) {
  const [flowsText, setFlowsText] = useState("");
  const [indexText, setIndexText] = useState("");
  const [flowsFileName, setFlowsFileName] = useState("");
  const [indexFileName, setIndexFileName] = useState("");
  const [batch, setBatch] = useState<ImportPreviewReport[]>([]);
  const [applying, setApplying] = useState(false);

  const close = () => {
    setFlowsText(""); setIndexText(""); setFlowsFileName(""); setIndexFileName(""); setBatch([]);
    onClose();
  };

  const doPreview = () => {
    if (!flowsText.trim()) { toast.error("เลือกไฟล์ flows JSON ก่อน (all-flows.json หรือ flow file)"); return; }
    try {
      const { batch: b } = parseZaapiImportInputs(flowsText, indexText || undefined);
      setBatch(b.reports);
      const nameIssues = b.reports.filter((r) => r.nameStatus !== "ok" && r.nameStatus !== "provided").length;
      toast.success(`import preview: ${b.flowCount} flows / ${b.nodeCount} nodes / ${b.edgeCount} edges${nameIssues ? ` — ${nameIssues} flow(s) ไม่มีชื่อจริง` : ""}`);
    } catch (err) {
      toast.error(`import ไม่สำเร็จ: ${(err as Error).message}`);
    }
  };

  const doApply = async () => {
    setApplying(true);
    try {
      const flows = JSON.parse(flowsText);
      const idx = indexText.trim() ? JSON.parse(indexText) : undefined;
      const r = await fetch("/api/workflows/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flows, indexRows: idx?.rows ?? (Array.isArray(idx) ? idx : undefined) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(`apply ไม่สำเร็จ: ${d.detail || d.error || `HTTP ${r.status}`}`); return; }
      toast.success(`apply: ${d.flow_count} flows → ${d.workflow_ids?.length ?? 0} disabled drafts (batch ${d.batch_id})${d.already_applied ? " — already applied" : ""} · ${d.bindings_total} unresolved bindings`);
      onApplied?.(d);
      close();
    } catch (err) { toast.error(`apply ผิดพลาด: ${(err as Error).message}`); }
    finally { setApplying(false); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-bold">Zaapi Import Preview (dry-run)</div>
          <button onClick={close} aria-label="ปิด import preview" title="ปิด" className="w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center">
            <X size={16} className="text-text-muted" />
          </button>
        </div>
        <div className="text-[11px] text-text-muted mb-2">
          เลือก 2 ไฟล์: <b>all-flows.json</b> (หรือ flow file เดี่ยว) + <b>_index_data.json</b> (ชื่อ flow จริง — ไม่ส่ง = ชื่อ generic + warning)
        </div>
        <label className="block text-[11px] font-semibold text-text-muted mb-1">flows JSON</label>
        <input
          type="file" accept=".json,application/json" aria-label="flows JSON file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) { setFlowsText(await f.text()); setFlowsFileName(f.name); }
          }}
          className="w-full text-xs mb-2"
        />
        {flowsFileName && <div className="text-[10px] text-text-subtle mb-1">เลือกแล้ว: {flowsFileName}</div>}
        <label className="block text-[11px] font-semibold text-text-muted mb-1">index JSON (optional — ชื่อ flow จาก _index_data.json)</label>
        <input
          type="file" accept=".json,application/json" aria-label="index JSON file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) { setIndexText(await f.text()); setIndexFileName(f.name); }
          }}
          className="w-full text-xs"
        />
        {indexFileName && <div className="text-[10px] text-text-subtle mt-1">เลือกแล้ว: {indexFileName}</div>}
        <button onClick={doPreview} className="mt-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand text-white hover:opacity-90">
          Preview import
        </button>
        {batch.length > 0 && (
          <button
            onClick={doApply} disabled={applying}
            className="mt-2 ml-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:opacity-90 disabled:opacity-50"
          >
            {applying ? "กำลัง apply…" : "Apply as disabled drafts"}
          </button>
        )}
        {batch.length > 0 && (
          <div className="mt-3 border border-border rounded-lg divide-y divide-border">
            {batch.map((r) => (
              <div key={r.flowKeyHash} className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold truncate">{r.name}</div>
                  {onLoadReportToCanvas && (
                    <button onClick={() => { onLoadReportToCanvas(r); close(); }} className="shrink-0 px-2 py-1 text-[11px] font-medium rounded-md border border-border hover:bg-surface-2">
                      โหลดลง canvas
                    </button>
                  )}
                </div>
                <div className="text-[10px] text-text-muted mt-1">
                  {r.nodeCount} nodes · {r.edgeCount} edges · {r.bindings.length} bindings ·{" "}
                  {r.unsupportedTypes.length > 0 ? `${r.unsupportedTypes.length} unsupported` : "types ครบ"} ·{" "}
                  {r.structural.ok ? "graph ok" : `graph error: ${r.structural.errors[0] || ""}`}
                  {r.stepRefs.synthesized > 0 && ` · ${r.stepRefs.synthesized} jump edges synthesized`}
                  {r.unresolvedStepRefs.length > 0 && ` · ${r.unresolvedStepRefs.length} dangling step refs (blocks publish)`}
                  {r.stepRefs.mismatched > 0 && ` · ${r.stepRefs.mismatched} handle mismatch (blocks publish)`}
                </div>
                {r.nameStatus !== "ok" && r.nameStatus !== "provided" && (
                  <div className="text-[10px] text-warning mt-0.5">⚠ {r.warnings.find((w) => /index|name/i.test(w)) || `name ${r.nameStatus}`}</div>
                )}
                {r.conflicts.length > 0 && (
                  <div className="text-[10px] text-warning mt-0.5">{r.conflicts.length} conflict(s)</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
