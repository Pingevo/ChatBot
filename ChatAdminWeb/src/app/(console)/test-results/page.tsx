"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Clock,
  Package,
  Globe,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  FileText,
} from "lucide-react";

interface TestResult {
  i: number;
  shop: string;
  msg: string;
  cat: string;
  source: string;
  web_search: string;
  products: number;
  elapsed: number;
  ok: string;
  answer: string;
  expected?: string;
  notes?: string;
  check?: string;
  test_id?: string;
}

interface Pagination {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

interface Stats {
  total: number;
  pass: number;
  fail: number;
  err: number;
  unknown?: number;
  avg_time: number;
  web_search_count: number;
  cat_map: Record<string, { pass: number; fail: number; err: number; total: number }>;
}

type SortKey = "i" | "shop" | "cat" | "elapsed" | "products";
type PageSize = 25 | 50 | 100 | 200;

export default function TestResultsPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("test_200_results.json");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);

  // client-side filter/sort (ทำใน page เท่านั้น)
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [shopFilter, setShopFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("i");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<number | null>(null);

  // ── load file list ──
  useEffect(() => {
    fetch("/api/test-results?mode=list")
      .then((r) => r.json())
      .then((d) => {
        if (d.files) setFiles(d.files);
      })
      .catch(() => {});
  }, []);

  // ── load data ──
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/test-results?file=${encodeURIComponent(selectedFile)}&page=${page}&page_size=${pageSize}`;
      const res = await fetch(url);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "failed to load");
      }
      const d = await res.json();
      setResults(d.results);
      setPagination(d.pagination);
      setStats(d.stats);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, page, pageSize]);

  // reset page เมื่อเปลี่ยนไฟล์
  const changeFile = (f: string) => {
    setSelectedFile(f);
    setPage(1);
  };

  const changePageSize = (s: PageSize) => {
    setPageSize(s);
    setPage(1);
  };

  // ── derived data ──
  const cats = useMemo(
    () => (stats ? Object.keys(stats.cat_map).sort() : []),
    [stats]
  );
  const shops = useMemo(
    () => [...new Set(results.map((r) => r.shop))].sort(),
    [results]
  );

  const filtered = useMemo(() => {
    let f = results;
    if (search) {
      const s = search.toLowerCase();
      f = f.filter(
        (r) =>
          r.msg.toLowerCase().includes(s) ||
          r.answer.toLowerCase().includes(s) ||
          r.source.toLowerCase().includes(s)
      );
    }
    if (catFilter !== "all") f = f.filter((r) => r.cat === catFilter);
    if (shopFilter !== "all") f = f.filter((r) => r.shop === shopFilter);
    if (statusFilter !== "all") {
      if (statusFilter === "pass") f = f.filter((r) => r.ok === "✅");
      else if (statusFilter === "fail") f = f.filter((r) => r.ok === "❌");
      else if (statusFilter === "error") f = f.filter((r) => r.ok === "ERR");
      else if (statusFilter === "unknown") f = f.filter((r) => r.ok === "—");
    }
    f = [...f].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "i") cmp = a.i - b.i;
      else if (sortKey === "elapsed") cmp = a.elapsed - b.elapsed;
      else if (sortKey === "products") cmp = a.products - b.products;
      else cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return f;
  }, [results, search, catFilter, shopFilter, statusFilter, sortKey, sortDir]);

  const okColor = (ok: string) =>
    ok === "✅" ? "text-emerald-400" : ok === "❌" ? "text-rose-400" : ok === "ERR" ? "text-amber-400" : "text-slate-400";
  const okBg = (ok: string) =>
    ok === "✅"
      ? "bg-emerald-500/10 border-emerald-500/30"
      : ok === "❌"
      ? "bg-rose-500/10 border-rose-500/30"
      : ok === "ERR"
      ? "bg-amber-500/10 border-amber-500/30"
      : "bg-slate-500/10 border-slate-500/30";

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-[calc(100vh-3.5rem)] bg-base px-6 py-5 space-y-6">
        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text">Test Results</h1>
            <p className="text-sm text-text-muted mt-1">
              ผลเทสบอท {stats?.total || 0} ข้อ — จาก {selectedFile}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* file selector */}
            <div className="relative">
              <FileText size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <select
                value={selectedFile}
                onChange={(e) => changeFile(e.target.value)}
                className="rounded-lg bg-surface-2 pl-8 pr-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
              >
                {files.length === 0 && <option value={selectedFile}>{selectedFile}</option>}
                {files.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-text hover:bg-pale-sky-soft disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              รีโหลด
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            ⚠️ {error}
          </div>
        )}

        {loading && results.length === 0 ? (
          <div className="text-center py-12 text-text-muted">กำลังโหลด...</div>
        ) : stats ? (
          <>
            {/* ── Summary cards ── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
              <StatCard label="ทั้งหมด" value={stats.total} icon={<Package size={16} />} color="text-text" />
              <StatCard label="ผ่าน" value={stats.pass} icon={<CheckCircle2 size={16} />} color="text-emerald-400" />
              <StatCard label="ไม่ผ่าน" value={stats.fail} icon={<XCircle size={16} />} color="text-rose-400" />
              <StatCard label="Error" value={stats.err} icon={<AlertTriangle size={16} />} color="text-amber-400" />
              {stats.unknown != null && stats.unknown > 0 && (
                <StatCard label="รอตรวจ" value={stats.unknown} icon={<AlertTriangle size={16} />} color="text-slate-400" />
              )}
              <StatCard label="เวลาเฉลี่ย" value={`${stats.avg_time.toFixed(1)}s`} icon={<Clock size={16} />} color="text-sky-400" />
              <StatCard label="Web Search" value={stats.web_search_count} icon={<Globe size={16} />} color="text-violet-400" />
            </div>

            {/* ── Category breakdown ── */}
            <div className="rounded-xl border border-white/5 bg-surface-1 p-4">
              <h2 className="text-sm font-semibold text-text mb-3">สถิติตามหมวด</h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {Object.entries(stats.cat_map).map(([cat, s]) => (
                  <div key={cat} className="rounded-lg border border-white/5 bg-surface-2 p-2.5">
                    <div className="text-xs font-medium text-text-muted truncate">{cat}</div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="text-lg font-bold text-emerald-400">{s.pass}</span>
                      {s.fail > 0 && <span className="text-sm text-rose-400">/{s.fail}</span>}
                      {s.err > 0 && <span className="text-sm text-amber-400">/{s.err}</span>}
                      <span className="text-xs text-text-muted">/{s.total}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Filters ── */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ค้นหาคำถาม/คำตอบ/source..."
                  className="w-full rounded-lg bg-surface-2 pl-9 pr-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="all">ทุกหมวด</option>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={shopFilter}
                onChange={(e) => setShopFilter(e.target.value)}
                className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="all">ทุกร้าน</option>
                {shops.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="all">ทุกสถานะ</option>
                <option value="pass">✅ ผ่าน</option>
                <option value="fail">❌ ไม่ผ่าน</option>
                <option value="error">⚠️ Error</option>
                <option value="unknown">— รอตรวจ</option>
              </select>
              {/* page size */}
              <select
                value={pageSize}
                onChange={(e) => changePageSize(Number(e.target.value) as PageSize)}
                className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value={25}>25/หน้า</option>
                <option value={50}>50/หน้า</option>
                <option value={100}>100/หน้า</option>
                <option value={200}>200/หน้า</option>
              </select>
              <span className="text-sm text-text-muted">{filtered.length} ข้อ (ในหน้า)</span>
            </div>

            {/* ── Table ── */}
            <div className="overflow-x-auto rounded-xl border border-white/5 bg-surface-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-text-muted">
                    {[
                      { k: "i" as SortKey, label: "#" },
                      { k: "shop" as SortKey, label: "ร้าน" },
                      { k: "cat" as SortKey, label: "หมวด" },
                    ].map((col) => (
                      <th
                        key={col.k}
                        className="cursor-pointer px-3 py-2.5 text-left font-medium hover:text-text"
                        onClick={() => toggleSort(col.k)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label} <SortIcon k={col.k} />
                        </span>
                      </th>
                    ))}
                    <th className="px-3 py-2.5 text-left font-medium">คำถาม</th>
                    <th className="px-3 py-2.5 text-left font-medium">Source</th>
                    <th className="px-3 py-2.5 text-center font-medium">WS</th>
                    <th
                      className="cursor-pointer px-3 py-2.5 text-right font-medium hover:text-text"
                      onClick={() => toggleSort("products")}
                    >
                      <span className="inline-flex items-center gap-1">สินค้า <SortIcon k="products" /></span>
                    </th>
                    <th
                      className="cursor-pointer px-3 py-2.5 text-right font-medium hover:text-text"
                      onClick={() => toggleSort("elapsed")}
                    >
                      <span className="inline-flex items-center gap-1">เวลา <SortIcon k="elapsed" /></span>
                    </th>
                    <th className="px-3 py-2.5 text-center font-medium">ผล</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <Fragment key={`${selectedFile}-${r.i}-${page}`}>
                      <tr
                        className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${okBg(r.ok)}`}
                        onClick={() => setExpanded(expanded === r.i ? null : r.i)}
                      >
                        <td className="px-3 py-2 text-text-muted">{r.i}</td>
                        <td className="px-3 py-2 text-text truncate max-w-[160px]">{r.shop}</td>
                        <td className="px-3 py-2">
                          <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-text-muted">{r.cat}</span>
                        </td>
                        <td className="px-3 py-2 text-text max-w-[280px] truncate">{r.msg}</td>
                        <td className="px-3 py-2 text-text-muted text-xs max-w-[180px] truncate">{r.source}</td>
                        <td className="px-3 py-2 text-center">
                          {r.web_search === "Y" ? <Globe size={12} className="inline text-violet-400" /> : <span className="text-text-muted">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-text">{r.products}</td>
                        <td className="px-3 py-2 text-right text-text-muted">{r.elapsed.toFixed(1)}s</td>
                        <td className={`px-3 py-2 text-center text-base ${okColor(r.ok)}`}>{r.ok}</td>
                      </tr>
                      {expanded === r.i && (
                        <tr className="border-b border-white/5 bg-surface-2">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="space-y-2">
                              {r.test_id && (
                                <div>
                                  <span className="text-xs text-text-muted">test_id:</span>
                                  <code className="text-xs text-text">{r.test_id}</code>
                                </div>
                              )}
                              <div>
                                <span className="text-xs text-text-muted">คำถามเต็ม:</span>
                                <p className="text-text">{r.msg}</p>
                              </div>
                              {r.expected && (
                                <div>
                                  <span className="text-xs text-text-muted">คำตอบที่คาดหวัง:</span>
                                  <p className="text-text-muted italic">{r.expected}</p>
                                </div>
                              )}
                              <div>
                                <span className="text-xs text-text-muted">คำตอบ:</span>
                                <p className="text-text whitespace-pre-wrap">{r.answer}</p>
                              </div>
                              {r.notes && (
                                <div>
                                  <span className="text-xs text-text-muted">หมายเหตุ:</span>
                                  <p className="text-amber-300 text-sm">{r.notes}</p>
                                </div>
                              )}
                              {r.check && (
                                <div>
                                  <span className="text-xs text-text-muted">check:</span>
                                  <code className="text-xs text-sky-300">{r.check}</code>
                                </div>
                              )}
                              <div className="flex gap-4 text-xs text-text-muted">
                                <span>source: {r.source}</span>
                                <span>web_search: {r.web_search}</span>
                                <span>products: {r.products}</span>
                                <span>elapsed: {r.elapsed.toFixed(2)}s</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Pagination ── */}
            {pagination && pagination.total_pages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">
                  หน้า {pagination.page} / {pagination.total_pages} — ทั้งหมด {pagination.total} ข้อ
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(1)}
                    disabled={!pagination.has_prev}
                    className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-text hover:bg-pale-sky-soft disabled:opacity-30"
                    title="หน้าแรก"
                  >
                    «
                  </button>
                  <button
                    onClick={() => setPage(page - 1)}
                    disabled={!pagination.has_prev}
                    className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-text hover:bg-pale-sky-soft disabled:opacity-30"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  {/* page numbers */}
                  {Array.from({ length: Math.min(7, pagination.total_pages) }, (_, i) => {
                    let p: number;
                    if (pagination.total_pages <= 7) {
                      p = i + 1;
                    } else if (page <= 4) {
                      p = i + 1;
                    } else if (page >= pagination.total_pages - 3) {
                      p = pagination.total_pages - 6 + i;
                    } else {
                      p = page - 3 + i;
                    }
                    return (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={`rounded-lg px-3 py-1.5 text-sm ${
                          p === page
                            ? "bg-brand text-white"
                            : "bg-surface-2 text-text hover:bg-pale-sky-soft"
                        }`}
                      >
                        {p}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setPage(page + 1)}
                    disabled={!pagination.has_next}
                    className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-text hover:bg-pale-sky-soft disabled:opacity-30"
                  >
                    <ChevronRight size={14} />
                  </button>
                  <button
                    onClick={() => setPage(pagination.total_pages)}
                    disabled={!pagination.has_next}
                    className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-text hover:bg-pale-sky-soft disabled:opacity-30"
                    title="หน้าสุดท้าย"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-surface-1 p-3">
      <div className={`flex items-center gap-1.5 text-xs ${color}`}>
        {icon}
        <span className="text-text-muted">{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
