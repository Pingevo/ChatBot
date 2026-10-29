"use client";
// ZaapiKbPanel — read-only view ของ imported Zaapi KB corpus (zaapi_kb)
// แสดง 118 sources + docs ข้างใน — แยกจาก knowledge_base (legacy) ตาม design
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { Pagination } from "@/components/ui/Pagination";
import { api } from "@/lib/apiClient";
import { Search, ChevronDown, Database } from "lucide-react";

type ZaapiSource = {
  source_id: string;
  source_name: string;
  accounts: { id: string; platform: string; name: string }[];
  docs: number;
  active_docs: number;
  zaapi_updated_at?: string;
};

type ZaapiDoc = {
  id: string;
  row_index: number;
  sheet?: string;
  kind: string;
  fields: Record<string, string>;
  text: string;
  active: boolean;
};

const PLATFORM_COLORS: Record<string, string> = {
  Shopee: "bg-orange-100 text-orange-700",
  Facebook: "bg-blue-100 text-blue-700",
  Lazada: "bg-sky-100 text-sky-700",
  TikTok: "bg-neutral-800 text-white",
  "LINE Official": "bg-green-100 text-green-700",
};

const PAGE_SIZE = 25;

export function ZaapiKbPanel() {
  const [sources, setSources] = useState<ZaapiSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const [docs, setDocs] = useState<ZaapiDoc[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsPage, setDocsPage] = useState(0);
  const [docsLoading, setDocsLoading] = useState(false);

  useEffect(() => {
    api()
      .get("/zaapi-kb", { params: { mode: "sources" } })
      .then((r) => setSources(r.data.sources || []))
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, []);

  const loadDocs = useCallback((sourceId: string, page: number) => {
    setDocsLoading(true);
    api()
      .get("/zaapi-kb", {
        params: { mode: "docs", source_id: sourceId, skip: page * PAGE_SIZE, limit: PAGE_SIZE },
      })
      .then((r) => { setDocs(r.data.docs || []); setDocsTotal(r.data.total || 0); })
      .catch(() => { setDocs([]); setDocsTotal(0); })
      .finally(() => setDocsLoading(false));
  }, []);

  function toggleSource(id: string) {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setDocsPage(0);
    loadDocs(id, 0);
  }

  const filtered = sources.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.source_name.toLowerCase().includes(q) ||
      s.accounts.some((a) => a.name.toLowerCase().includes(q) || a.platform.toLowerCase().includes(q))
    );
  });

  if (loading) return <div className="flex justify-center py-12"><Loading size={24} /></div>;
  if (sources.length === 0)
    return <EmptyState icon={Database} title="ยังไม่มี Zaapi KB" description="รัน import_zaapi_kb.py เพื่อนำเข้าข้อมูล" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา source / ร้านค้า / platform..."
            className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
          />
        </div>
        <span className="text-xs text-text-muted">
          {filtered.length}/{sources.length} sources · import จาก Zaapi — ดูอย่างเดียว
        </span>
      </div>

      <div className="border border-border rounded-xl divide-y divide-border overflow-y-auto bg-surface max-h-[calc(100dvh-300px)]">
        {filtered.map((s) => {
          const platforms = [...new Set(s.accounts.map((a) => a.platform))];
          const open = openId === s.source_id;
          return (
            <div key={s.source_id}>
              <button
                onClick={() => toggleSource(s.source_id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 transition-colors"
              >
                <ChevronDown size={14} className={`text-text-subtle transition-transform ${open ? "" : "-rotate-90"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-text truncate">{s.source_name}</div>
                  <div className="text-[11px] text-text-subtle mt-0.5 truncate">
                    {s.accounts.slice(0, 3).map((a) => a.name).join(", ")}
                    {s.accounts.length > 3 && ` +${s.accounts.length - 3}`}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {platforms.map((p) => (
                    <span key={p} className={`text-[10px] px-1.5 py-0.5 rounded ${PLATFORM_COLORS[p] || "bg-surface-2 text-text-muted"}`}>
                      {p}
                    </span>
                  ))}
                </div>
                <Badge tone={s.active_docs === s.docs ? "success" : "warning"}>
                  {s.active_docs}/{s.docs}
                </Badge>
              </button>

              {open && (
                <div className="border-t border-border bg-surface-2/50 px-4 py-3">
                  {docsLoading ? (
                    <div className="flex justify-center py-6"><Loading size={18} /></div>
                  ) : docs.length === 0 ? (
                    <div className="text-xs text-text-subtle py-4 text-center">ไม่มีเอกสาร</div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        {docs.map((d) => (
                          <div key={d.id} className="border border-border/60 rounded-lg bg-surface px-3 py-2">
                            <div className="flex items-center gap-2 text-[10px] text-text-subtle mb-1">
                              <span className="font-mono">#{d.row_index}</span>
                              <span>{d.kind}{d.sheet ? ` · ${d.sheet}` : ""}</span>
                              {!d.active && <span className="text-error">inactive</span>}
                            </div>
                            <div className="text-xs text-text whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                              {d.text}
                            </div>
                          </div>
                        ))}
                      </div>
                      {docsTotal > PAGE_SIZE && (
                        <div className="mt-3">
                          <Pagination
                            page={docsPage + 1}
                            totalPages={Math.ceil(docsTotal / PAGE_SIZE)}
                            onChange={(p) => { setDocsPage(p - 1); loadDocs(s.source_id, p - 1); }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
