// ChatList — left column: list of conversations across 3 platforms
// filter: title + search + multi-select platform/status/shop + admin filter + accept toggle + sort
"use client";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Search, ChevronDown, Check, X, ArrowDownUp, MessageSquare } from "lucide-react";
import type { Conversation, Platform, AdminUser } from "@/lib/types";

interface Props {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  // Phase 7.10 — admin filter + accept toggle (ย้ายมารวมใน ChatList)
  admins?: AdminUser[];
  chatFilter?: string; // "me" | "all" | admin_id
  onChatFilterChange?: (filter: string) => void;
  acceptingChats?: boolean;
  onToggleAccepting?: () => void;
  togglingAccept?: boolean;
  // ⚡ total count จริงจาก DB (ไม่จำกัดด้วย limit) — ถ้าไม่ส่ง จะใช้ filtered.length
  totalCount?: number;
}

// Status ใหม่: ยังไม่อ่าน / อ่านแล้ว / ยังไม่ตอบ (อ่านแล้วแต่ยังไม่ตอบ) / ปิด / เปิด / บอทตอบ
type StatusFilter =
  | "all"
  | "unread"
  | "read"
  | "unreplied"
  | "closed"
  | "open"
  | "open_bot";

const statusFilterOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "unread", label: "ยังไม่อ่าน" },
  { value: "read", label: "อ่านแล้ว" },
  { value: "unreplied", label: "ยังไม่ตอบ" },
  { value: "open", label: "เปิด" },
  { value: "open_bot", label: "บอทตอบ" },
  { value: "closed", label: "ปิด" },
];

type SortOption = "recent" | "oldest" | "unread" | "name";

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "recent", label: "ใหม่ล่าสุด" },
  { value: "oldest", label: "เก่าสุด" },
  { value: "name", label: "ตามตัวอักษร" },
];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.`;
  const d = Math.floor(h / 24);
  return `${d} วัน`;
}

// แปลง ISO → HH:MM (24 ชม. ภาษาไทย)
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// รวม: "12:45 · 5 นาที" หรือ "12:45" ถ้าไม่มี timeAgo
function timeLabel(iso: string): string {
  const t = formatTime(iso);
  const a = timeAgo(iso);
  if (t && a) return `${t} · ${a}`;
  return t || a;
}

const statusTone: Record<string, "brand" | "coral" | "neutral" | "pale"> = {
  open: "coral",
  closed: "neutral",
  bot: "brand",
  handoff: "coral",
  resolved: "neutral",
  pending: "pale",
};

const statusLabel: Record<string, string> = {
  open: "เปิด",
  closed: "ปิด",
  bot: "บอท",
  handoff: "แอดมิน",
  resolved: "เสร็จ",
  pending: "รอตอบ",
};

export function ChatList({
  conversations,
  selectedId,
  onSelect,
  admins = [],
  chatFilter = "me",
  onChatFilterChange,
  acceptingChats = true,
  onToggleAccepting,
  togglingAccept = false,
  totalCount,
}: Props) {
  const [search, setSearch] = useState("");
  const [platforms, setPlatforms] = useState<Set<Platform>>(new Set());
  const [status, setStatus] = useState<StatusFilter>("all");
  const [shops, setShops] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortOption>("recent");
  const [showPlatformDropdown, setShowPlatformDropdown] = useState(false);
  const [showShopDropdown, setShowShopDropdown] = useState(false);
  const [showAdminDropdown, setShowAdminDropdown] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);

  // ดึงรายชื่อร้านทั้งหมดจาก conversations (กรองตาม platform ที่เลือก)
  const availableShops = useMemo(() => {
    const shopMap = new Map<string, { id: string; name: string; platform: Platform }>();
    conversations.forEach((c) => {
      if (platforms.size === 0 || platforms.has(c.platform)) {
        const key = `${c.shop_id}|${c.platform}`;
        if (!shopMap.has(key)) {
          shopMap.set(key, { id: c.shop_id, name: c.shop_name, platform: c.platform });
        }
      }
    });
    return Array.from(shopMap.values());
  }, [conversations, platforms]);

  const filtered = useMemo(() => {
    let result = conversations;

    // Platform filter (multi-select)
    if (platforms.size > 0) {
      result = result.filter((c) => platforms.has(c.platform));
    }

    // Status filter
    if (status !== "all") {
      result = result.filter((c) => {
        if (status === "unread") return (c.unread || 0) > 0;
        if (status === "read") return (c.unread || 0) === 0;
        if (status === "unreplied") return (c.unread || 0) === 0 && (c.status === "handoff" || c.status === "pending");
        if (status === "closed") return c.status === "closed" || c.status === "resolved";
        if (status === "open") return c.status === "open" || c.status === "handoff" || c.status === "pending";
        if (status === "open_bot") return c.status === "bot";
        return true;
      });
    }

    // Shop filter (multi-select)
    if (shops.size > 0) {
      result = result.filter((c) => shops.has(`${c.shop_id}|${c.platform}`));
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.customer_name.toLowerCase().includes(q) ||
          c.last_message.toLowerCase().includes(q) ||
          c.shop_name.toLowerCase().includes(q)
      );
    }

    // Sort
    const sorted = [...result];
    switch (sort) {
      case "recent":
        sorted.sort((a, b) => new Date(b.last_timestamp).getTime() - new Date(a.last_timestamp).getTime());
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.last_timestamp).getTime() - new Date(b.last_timestamp).getTime());
        break;
      case "unread":
        sorted.sort((a, b) => b.unread - a.unread);
        break;
      case "name":
        sorted.sort((a, b) => a.customer_name.localeCompare(b.customer_name, "th"));
        break;
    }
    return sorted;
  }, [conversations, platforms, status, shops, search, sort]);

  // ⚡ Incremental rendering — โหลดทีละ 50 รายการ เพื่อลดการหน่วง
  //    เมื่อ filter/sort เปลี่ยน รีเซ็ตเป็น 50 รายการแรก
  //    เมื่อ scroll ใกล้ล่าง โหลดเพิ่ม 50 รายการ
  const RENDER_BATCH = 50;
  const [renderCount, setRenderCount] = useState(RENDER_BATCH);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setRenderCount(RENDER_BATCH); }, [filtered]);
  const visibleItems = filtered.slice(0, renderCount);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && renderCount < filtered.length) {
      setRenderCount((c) => Math.min(c + RENDER_BATCH, filtered.length));
    }
  }, [renderCount, filtered.length]);

  function togglePlatform(p: Platform) {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function toggleShop(key: string) {
    setShops((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearAll() {
    setPlatforms(new Set());
    setStatus("all");
    setShops(new Set());
    setSearch("");
  }

  const activeFilterCount = platforms.size + (status !== "all" ? 1 : 0) + shops.size;

  return (
    <div className="w-full bg-surface flex flex-col h-full">
      {/* Header — รวม title + search + filter + accept เป็นชั้นเดียว */}
      <div className="p-2.5 border-b border-border space-y-2">
        {/* Row 1: title + count + accept toggle */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-md bg-brand/15 flex items-center justify-center shrink-0">
              <MessageSquare size={13} className="text-brand" />
            </div>
            <h2 className="font-semibold text-text text-sm truncate">กล่องข้อความ</h2>
            <Badge tone="brand">{totalCount != null ? totalCount : filtered.length}</Badge>
            {activeFilterCount > 0 && (
              <button onClick={clearAll} className="text-[10px] text-text-muted hover:text-vibrant-coral transition-colors">
                ล้าง ({activeFilterCount})
              </button>
            )}
          </div>
          {onToggleAccepting && (
            <button
              onClick={onToggleAccepting}
              disabled={togglingAccept}
              className={`flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium shrink-0 ${acceptingChats
                  ? "bg-green-500/10 text-green-600 hover:bg-green-500/20"
                  : "bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20"
                } ${togglingAccept ? "opacity-50 cursor-not-allowed" : ""}`}
              title={acceptingChats ? "คลิกเพื่อหยุดรับแชท" : "คลิกเพื่อรับแชท"}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${acceptingChats ? "bg-green-500" : "bg-yellow-500"}`} />
              {acceptingChats ? "รับแชท" : "พัก"}
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา ชื่อ / ข้อความ / ร้าน..."
            className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
          />
        </div>

        {/* Filter row — dropdowns (admin + platform + status + shop + sort) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Admin filter (ผู้รับ) — single-select แต่ใช้ pattern เดียวกับ Dropdown */}
          {onChatFilterChange && (
            <div className="relative">
              <button
                onClick={() => { setShowAdminDropdown(!showAdminDropdown); setShowPlatformDropdown(false); setShowShopDropdown(false); setShowSortDropdown(false); setShowStatusDropdown(false); }}
                style={{ minWidth: "84px" }}
                className={`h-7 px-2 text-[11px] rounded-md border border-border bg-surface flex items-center gap-1 transition-colors text-text-muted hover:text-text hover:bg-surface-2 ${chatFilter !== "me" ? "border-brand/40 text-text" : ""}`}
              >
                <span className="text-text-subtle shrink-0">ผู้รับ:</span>
                <span className="font-medium truncate" style={{ minWidth: "40px", maxWidth: "70px" }}>
                  {chatFilter === "me" ? "ฉัน" : chatFilter === "all" ? "ทั้งหมด" : (admins.find((a) => a.admin_id === chatFilter)?.name || admins.find((a) => a.admin_id === chatFilter)?.username || chatFilter)}
                </span>
                <ChevronDown size={10} className="text-text-muted shrink-0" />
              </button>
              {showAdminDropdown && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setShowAdminDropdown(false)} />
                  <div className="absolute top-full left-0 mt-1 min-w-[140px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1 max-h-60 overflow-y-auto">
                    <button onClick={() => { onChatFilterChange("me"); setShowAdminDropdown(false); }} className={`w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-surface-2 ${chatFilter === "me" ? "text-brand font-medium" : "text-text"}`}>ฉัน</button>
                    <button onClick={() => { onChatFilterChange("all"); setShowAdminDropdown(false); }} className={`w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-surface-2 ${chatFilter === "all" ? "text-brand font-medium" : "text-text"}`}>ทั้งหมด</button>
                    {admins.length > 0 && (
                      <>
                        <div className="border-t border-border my-1" />
                        {admins.map((a) => (
                          <button key={a.admin_id} onClick={() => { onChatFilterChange(a.admin_id); setShowAdminDropdown(false); }} className={`w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-surface-2 ${chatFilter === a.admin_id ? "text-brand font-medium" : "text-text"}`}>
                            {a.name || a.username}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Platform multi-select — displayLabel แสดงชื่อที่เลือก + minLabelWidth กันขยับ */}
          <Dropdown
            label="แพลตฟอร์ม"
            displayLabel={platforms.size === 0 ? "ทั้งหมด" : platforms.size === 1 ? Array.from(platforms)[0] : `${platforms.size} เลือก`}
            selectedCount={platforms.size}
            minLabelWidth={48}
            open={showPlatformDropdown}
            onToggle={() => { setShowPlatformDropdown(!showPlatformDropdown); setShowAdminDropdown(false); setShowShopDropdown(false); setShowSortDropdown(false); setShowStatusDropdown(false); }}
            onClose={() => setShowPlatformDropdown(false)}
          >
            {(["shopee", "tiktok", "lazada"] as Platform[]).map((p) => (
              <DropdownCheckItem
                key={p}
                checked={platforms.has(p)}
                onClick={() => togglePlatform(p)}
              >
                <PlatformIcon platform={p} size={14} />
                <span className="capitalize">{p}</span>
              </DropdownCheckItem>
            ))}
          </Dropdown>

          {/* Status dropdown — ใช้ Dropdown component แบบเดียวกับตัวอื่น + แสดง label ที่เลือก */}
          <Dropdown
            label="สถานะ"
            displayLabel={statusFilterOptions.find((s) => s.value === status)?.label || "ทั้งหมด"}
            selectedCount={status !== "all" ? 1 : 0}
            minLabelWidth={52}
            open={showStatusDropdown}
            onToggle={() => { setShowStatusDropdown(!showStatusDropdown); setShowAdminDropdown(false); setShowPlatformDropdown(false); setShowShopDropdown(false); setShowSortDropdown(false); }}
            onClose={() => setShowStatusDropdown(false)}
          >
            {statusFilterOptions.map((s) => (
              <DropdownCheckItem
                key={s.value}
                checked={status === s.value}
                onClick={() => { setStatus(s.value); setShowStatusDropdown(false); }}
              >
                <span>{s.label}</span>
              </DropdownCheckItem>
            ))}
          </Dropdown>

          {/* Shop multi-select */}
          <Dropdown
            label="ร้าน"
            displayLabel={shops.size === 0 ? "ทั้งหมด" : shops.size === 1 ? Array.from(shops)[0].split("|")[0] : `${shops.size} ร้าน`}
            selectedCount={shops.size}
            minLabelWidth={48}
            open={showShopDropdown}
            onToggle={() => { setShowShopDropdown(!showShopDropdown); setShowAdminDropdown(false); setShowPlatformDropdown(false); setShowSortDropdown(false); setShowStatusDropdown(false); }}
            onClose={() => setShowShopDropdown(false)}
            disabled={availableShops.length === 0}
          >
            <div className="max-h-48 overflow-y-auto">
              {availableShops.map((s) => {
                const key = `${s.id}|${s.platform}`;
                return (
                  <DropdownCheckItem
                    key={key}
                    checked={shops.has(key)}
                    onClick={() => toggleShop(key)}
                  >
                    <PlatformIcon platform={s.platform} size={12} />
                    <span className="truncate">{s.name}</span>
                  </DropdownCheckItem>
                );
              })}
            </div>
          </Dropdown>

          {/* Sort dropdown — แสดง label ที่เลือก */}
          <Dropdown
            label="เรียง"
            displayLabel={sortOptions.find((s) => s.value === sort)?.label || "ใหม่ล่าสุด"}
            selectedCount={sort !== "recent" ? 1 : 0}
            minLabelWidth={52}
            open={showSortDropdown}
            onToggle={() => { setShowSortDropdown(!showSortDropdown); setShowAdminDropdown(false); setShowPlatformDropdown(false); setShowShopDropdown(false); setShowStatusDropdown(false); }}
            onClose={() => setShowSortDropdown(false)}
          >
            {sortOptions.map((s) => (
              <DropdownCheckItem
                key={s.value}
                checked={sort === s.value}
                onClick={() => { setSort(s.value); setShowSortDropdown(false); }}
              >
                <ArrowDownUp size={12} />
                <span>{s.label}</span>
              </DropdownCheckItem>
            ))}
          </Dropdown>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} onScroll={handleListScroll} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-muted">ไม่พบแชท</div>
        ) : (
          <>
          {visibleItems.map((c) => {
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`w-full flex items-start gap-3 p-3 border-b border-border text-left transition-colors ${
                  active ? "bg-pale-sky-soft border-l-2 border-l-brand" : "hover:bg-surface-2"
                }`}
              >
                <div className="relative shrink-0">
                  <Avatar name={c.customer_name} src={c.customer_avatar} size={40} />
                  <div className="absolute -bottom-0.5 -right-0.5">
                    <PlatformIcon platform={c.platform} size={16} />
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium text-text truncate">{c.customer_name}</span>
                    <span className="text-[10px] text-text-subtle shrink-0">{timeLabel(c.last_timestamp)}</span>
                  </div>
                  <div className="text-[11px] text-text-muted truncate">{c.shop_name}</div>
                  <div className="text-xs text-text-muted truncate mt-0.5">{c.last_message}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge tone={statusTone[c.status] || "neutral"}>{statusLabel[c.status] || c.status}</Badge>
                    {c.assigned_to && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand truncate max-w-[110px]"
                        title={`assigned: ${c.assigned_to}`}
                      >
                        {c.assigned_to_name || c.assigned_to.slice(0, 8)}
                      </span>
                    )}
                    {c.unread > 0 && (
                      <span className="ml-auto bg-vibrant-coral text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
          {renderCount < filtered.length && (
            <div className="p-2 text-center text-[10px] text-text-subtle">
              โหลดเพิ่ม... ({renderCount}/{filtered.length})
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Dropdown helpers ---------- */

function Dropdown({
  label,
  displayLabel,
  selectedCount,
  open,
  onToggle,
  onClose,
  disabled,
  children,
  minLabelWidth = 60,
}: {
  label: string;
  displayLabel?: string; // แสดงชื่อที่เลือกแทน label (ถ้ามี)
  selectedCount?: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  minLabelWidth?: number; // กันขยับเวลา label เปลี่ยน
}) {
  const text = displayLabel ?? label;
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        disabled={disabled}
        style={{ minWidth: `${minLabelWidth + 24}px` }}
        className={`h-7 px-2 text-[11px] rounded-md border border-border bg-surface flex items-center gap-1 transition-colors ${
          disabled ? "opacity-40 cursor-not-allowed" : "text-text-muted hover:text-text hover:bg-surface-2"
        } ${(selectedCount || displayLabel) ? "border-brand/40 text-text" : ""}`}
      >
        <span className="text-text-subtle shrink-0">{label}:</span>
        <span className="font-medium truncate" style={{ minWidth: `${minLabelWidth}px`, maxWidth: "100px" }}>{text}</span>
        <ChevronDown size={10} className="text-text-muted shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={onClose} />
          <div className="absolute top-full left-0 mt-1 min-w-[160px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function DropdownCheckItem({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2 transition-colors text-left"
    >
      <span className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${checked ? "bg-brand text-white" : "border border-border"}`}>
        {checked && <Check size={10} />}
      </span>
      {children}
    </button>
  );
}
