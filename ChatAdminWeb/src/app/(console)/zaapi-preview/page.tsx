"use client";
// /zaapi-preview?file=<name> — popup พรีวิว+แก้ไฟล์ต้นฉบับของ Zaapi KB
// แก้ cell → บันทึก = patch ลง stored source → rev ใหม่ (rollback ได้)
// xlsx = cell patches ตาม source_row จริง / .txt = text ทั้งก้อน
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/apiClient";
import { Loading } from "@/components/ui/Loading";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { Save, ArrowLeft } from "lucide-react";

type SheetInfo = {
  rows: number;
  columns: { column_index: number; header: string; samples: string[] }[];
  grid?: string[][];
  grid_src?: number[];
  text?: string;
};
type Preview = {
  filename: string; active_rev: number;
  sheets: Record<string, SheetInfo>;
};
// patches: sheet → source_row → column_index → new value
type Patches = Record<string, Record<number, Record<number, string>>>;

function PreviewInner() {
  const file = useSearchParams().get("file") || "";
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pythonToolsAvailable, setPythonToolsAvailable] = useState(false);
  const [patches, setPatches] = useState<Patches>({});
  const [txtEdit, setTxtEdit] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [colW, setColW] = useState<Record<string, number>>({});
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  useEffect(() => {
    if (!file) { setErr("ไม่ได้ระบุไฟล์"); return; }
    let active = true;
    api().get<{ python_tools_available: boolean }>("/system/chat-engine")
      .then(async (r) => {
        if (!active) return;
        if (r.data.python_tools_available !== true) {
          setErr("พรีวิวและแก้ไฟล์ต้นฉบับต้องใช้ Python engine; เลือก legacy/v2/v3 เพื่อใช้งานส่วนนี้");
          return;
        }
        setPythonToolsAvailable(true);
        const preview = await api().get("/zaapi-kb/bind", { params: { file, rows: 50 } });
        if (active) { setData(preview.data); setPatches({}); setTxtEdit({}); }
      })
      .catch((e) => {
        if (active) setErr(e?.response?.data?.detail || "โหลดพรีวิวไฟล์ไม่สำเร็จ");
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => {
    if (data?.filename) document.title = `พรีวิว ${data.filename}`;
  }, [data]);

  // ลากขอบขวาของ th เพื่อปรับความกว้างคอลัมน์
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.max(60, d.startW + (e.clientX - d.startX));
      setColW((p) => ({ ...p, [d.key]: w }));
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const markCell = (sheet: string, srcRow: number, col: number, v: string) =>
    setPatches((p) => ({
      ...p,
      [sheet]: { ...(p[sheet] || {}), [srcRow]: { ...((p[sheet] || {})[srcRow] || {}), [col]: v } },
    }));

  const dirtyCells = Object.values(patches).reduce(
    (n, rows) => n + Object.values(rows).reduce((m, c) => m + Object.keys(c).length, 0), 0);
  const dirtyTxt = Object.keys(txtEdit).length;
  const dirty = dirtyCells + dirtyTxt > 0;

  async function save() {
    if (!pythonToolsAvailable || !data || !dirty) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = dirtyCells
        ? { patches }
        : { text: Object.values(txtEdit)[0] };
      const r = await api().post(`/zaapi-kb/bind?file=${encodeURIComponent(file)}`, body);
      if (r.data?.ok) {
        toast.success(`บันทึก → rev ${r.data.rev}` +
          (r.data.edited_cells ? ` · แก้ ${r.data.edited_cells} เซลล์` : ""));
        const preview = await api().get("/zaapi-kb/bind", { params: { file, rows: 50 } });
        setData(preview.data); setPatches({}); setTxtEdit({});
      } else toast.error("บันทึกไม่สำเร็จ — " + (r.data?.reason || r.data?.detail || "error"));
    } catch (e: any) {
      toast.error("บันทึกไม่สำเร็จ — " + (e?.response?.data?.detail || "error"));
    } finally {
      setSaving(false);
    }
  }

  if (err) return <div className="p-6 text-sm text-error">{err}</div>;
  if (!data) return <div className="flex justify-center p-10"><Loading size={20} /></div>;

  return (
    <div className="min-h-screen bg-surface p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <a href="/knowledge"
            className="inline-flex items-center gap-1 text-[11px] text-text-subtle hover:text-text mb-1">
            <ArrowLeft size={12} /> กลับหน้าฐานความรู้
          </a>
          <div className="text-sm font-semibold text-text break-all">{data.filename}</div>
          <div className="text-[11px] text-text-subtle">
            ไฟล์ต้นฉบับ · rev {data.active_rev} · แก้ cell ได้โดยตรง — บันทึก = rev ใหม่ (rollback ได้) · แสดงสูงสุด 50 แถวแรกต่อชีต
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={!pythonToolsAvailable || !dirty || saving}>
          <Save size={13} /> {saving ? "กำลังบันทึก..." : `บันทึก${dirty ? ` (${dirtyCells + dirtyTxt})` : ""}`}
        </Button>
      </div>
      {Object.entries(data.sheets).map(([s, info]) => (
        <div key={s} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{s}</span>
            <span className="text-[11px] text-text-subtle">{info.rows} แถว</span>
          </div>
          {info.text != null ? (
            <textarea
              defaultValue={info.text}
              onChange={(e) => setTxtEdit((p) => ({ ...p, [s]: e.target.value }))}
              className="w-full h-96 resize rounded-lg border border-border bg-surface-2/60 p-3 text-xs leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
          ) : info.grid && info.grid.length > 0 ? (
            <div className="overflow-auto rounded-lg border border-border resize-y max-h-[70vh] min-h-[120px]">
              <table className="border-collapse text-xs" style={{ tableLayout: "fixed" }}>
                <thead className="sticky top-0 bg-surface-2 z-10">
                  <tr>
                    <th className="border-b border-border px-2 py-1.5 text-left text-[10px] font-medium text-text-subtle w-8">#</th>
                    {info.columns.map((c) => {
                      const key = `${s}:${c.column_index}`;
                      return (
                        <th key={c.column_index}
                          style={{ width: colW[key] || 180 }}
                          className="relative border-b border-l border-border px-2 py-1.5 text-left text-[10px] font-medium text-text-subtle">
                          <span className="block truncate">{c.header || `คอลัมน์ ${c.column_index}`}</span>
                          <span
                            onMouseDown={(e) => {
                              e.preventDefault();
                              dragRef.current = {
                                key, startX: e.clientX,
                                startW: colW[key] || (e.currentTarget.parentElement?.offsetWidth || 180),
                              };
                            }}
                            className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand/40"
                            title="ลากเพื่อขยายคอลัมน์"
                          />
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {info.grid.map((r, ri) => {
                    const srcRow = info.grid_src?.[ri] ?? ri + 2;
                    return (
                      <tr key={ri} className="align-top odd:bg-surface-2/40">
                        <td className="px-2 py-1.5 text-[10px] text-text-subtle">{srcRow}</td>
                        {r.map((v, ci) => {
                          const col = info.columns[ci]?.column_index ?? ci + 1;
                          const edited = patches[s]?.[srcRow]?.[col] !== undefined;
                          return (
                            <td key={ci}
                              className={`border-l border-border/40 px-2 py-1.5 ${edited ? "bg-brand/10" : ""}`}>
                              <div
                                contentEditable
                                suppressContentEditableWarning
                                onBlur={(e) => {
                                  const nv = e.currentTarget.innerText;
                                  if (nv !== v) markCell(s, srcRow, col, nv);
                                }}
                                className="break-words whitespace-pre-wrap outline-none focus:bg-brand/5 rounded px-0.5 min-h-[1em]"
                              >{edited ? patches[s][srcRow][col] : v}</div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-xs text-text-subtle">ไม่มีแถวข้อมูล</div>
          )}
          {info.grid && info.rows > info.grid.length && (
            <div className="text-[10px] text-text-subtle">
              แสดง {info.grid.length} แถวแรก จาก {info.rows} แถว — แก้ได้เฉพาะแถวที่แสดง (แถวอื่นคงเดิม)
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ZaapiPreviewPage() {
  return (
    <Suspense fallback={<div className="flex justify-center p-10"><Loading size={20} /></div>}>
      <PreviewInner />
    </Suspense>
  );
}
