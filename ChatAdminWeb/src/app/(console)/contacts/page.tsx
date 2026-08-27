"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Pagination } from "@/components/ui/Pagination";
import {
  Users, RefreshCw, Search,
  ArrowUpDown, ArrowUp, ArrowDown, MessageSquare,
} from "lucide-react";
import { api } from "@/lib/apiClient";
import type { Platform } from "@/lib/types";

interface ContactRow {
  platform: Platform;
  buyer_id: string;
  name: string;
  avatar?: string;
  last_active_at: string;
  created_at: string;
}

interface ListResponse {
  rows: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type SortBy = "name" | "last_active_at" | "created_at";
type SortDir = "asc" | "desc";

const platformFilters: { value: Platform | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

const sortOptions: { value: SortBy; label: string }[] = [
  { value: "last_active_at", label: "ใช้งานล่าสุด" },
  { value: "name", label: "ชื่อ" },
  { value: "created_at", label: "วันที่สมัคร" },
];

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("last_active_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<ListResponse>("/contacts", {
        params: {
          platform: platform === "all" ? undefined : platform,
          search: search || undefined,
          sortBy,
          sortDir,
          page,
          pageSize,
        },
      });
      setContacts(r.data.rows);
      setTotal(r.data.total);
      setTotalPages(r.data.totalPages);
    } catch {
      setContacts([]);
      setTotal(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [platform, search, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSearch() {
    setSearch(searchInput.trim());
    setPage(1);
  }

  function handleSort(column: SortBy) {
    if (sortBy === column) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
    setPage(1);
  }

  function SortIcon({ column }: { column: SortBy }) {
    if (sortBy !== column) return <ArrowUpDown size={12} className="text-text-subtle" />;
    return sortDir === "asc"
      ? <ArrowUp size={12} className="text-brand" />
      : <ArrowDown size={12} className="text-brand" />;
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Users size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">รายชื่อลูกค้า</h1>
              <p className="text-xs text-text-muted">
                ผู้ติดต่อทั้งหมด {total} รายการ
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Platform filter */}
          <div className="flex gap-1.5">
            {platformFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => { setPlatform(f.value); setPage(1); }}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  platform === f.value
                    ? "bg-brand text-white"
                    : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex items-center gap-1.5 ml-auto">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input
                type="text"
                placeholder="ค้นหาชื่อ / buyer_id..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="w-56 h-9 pl-9 pr-3 rounded-lg border border-border bg-surface-2 text-text text-sm placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            <Button size="sm" variant="outline" onClick={handleSearch}>ค้นหา</Button>
            {search && (
              <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setSearchInput(""); setPage(1); }}>
                ล้าง
              </Button>
            )}
          </div>
        </div>

        {/* Sort options */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-muted">เรียงตาม:</span>
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleSort(opt.value)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                sortBy === opt.value
                  ? "bg-brand/15 text-brand"
                  : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
              }`}
            >
              {opt.label}
              <SortIcon column={opt.value} />
            </button>
          ))}
        </div>

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-12">
            <Loading size={24} />
          </div>
        ) : contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="ไม่มีรายชื่อลูกค้า"
            description={search ? "ไม่พบผลลัพธ์ที่ตรงกับการค้นหา" : "ยังไม่มีข้อมูลลูกค้าในระบบ — รอ Phase 6 sync จาก dbWallet"}
          />
        ) : (
          <>
            <Card className="overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-2/50">
                    <th className="text-left px-4 py-3 font-medium text-text-muted text-xs">ลูกค้า</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted text-xs">แพลตฟอร์ม</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted text-xs">Buyer ID</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted text-xs cursor-pointer select-none" onClick={() => handleSort("last_active_at")}>
                      <span className="flex items-center gap-1">ใช้งานล่าสุด <SortIcon column="last_active_at" /></span>
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted text-xs cursor-pointer select-none" onClick={() => handleSort("created_at")}>
                      <span className="flex items-center gap-1">สมัครเมื่อ <SortIcon column="created_at" /></span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c, i) => (
                    <tr
                      key={`${c.platform}-${c.buyer_id}`}
                      className={`border-b border-border/50 hover:bg-surface-2/30 transition-colors ${i % 2 === 0 ? "" : "bg-surface-2/20"}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-brand/15 flex items-center justify-center text-xs font-medium text-brand flex-shrink-0">
                            {c.name?.charAt(0).toUpperCase() || "?"}
                          </div>
                          <span className="font-medium text-text">{c.name || "(ไม่มีชื่อ)"}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <PlatformIcon platform={c.platform} size={20} />
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">{c.buyer_id}</code>
                      </td>
                      <td className="px-4 py-3 text-text-muted text-xs">
                        {c.last_active_at ? new Date(c.last_active_at).toLocaleString("th-TH") : "-"}
                      </td>
                      <td className="px-4 py-3 text-text-muted text-xs">
                        {c.created_at ? new Date(c.created_at).toLocaleDateString("th-TH") : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {/* Pagination — เลขหน้าสวยๆ */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  หน้า {page} จาก {totalPages} · ทั้งหมด {total} รายการ
                </span>
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
