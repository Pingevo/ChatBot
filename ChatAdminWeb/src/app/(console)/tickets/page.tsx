"use client";
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Info, X, PanelRightClose, PanelRightOpen } from "lucide-react";
import { ChatList } from "@/components/chat/ChatList";
import { TicketChatPanel } from "@/components/chat/TicketChatPanel";
import { InfoTab } from "@/components/chat/InfoTab";
import { ChatLogTab } from "@/components/chat/ChatLogTab";
import { ProductsTab } from "@/components/chat/ProductsTab";
import { CloseChatModal } from "@/components/chat/CloseChatModal";
import { chatService } from "@/lib/services";
import { api } from "@/lib/apiClient";
import { usePolling } from "@/lib/usePolling";
import { useAuth } from "@/lib/authStore";
import type { Conversation, ChatMessage, CloseHistoryRecord, ProblemCategory, AdminUser } from "@/lib/types";

// Phase 7.4 — mock data ลบแล้ว โหลดจาก chatbot DB ผ่าน /api/admin/conversations
// Phase 7.9 — รองรับ tab "แชทของฉัน" / "ทั้งหมด" / filter admin + popup เตือนตอบทับ

type MobileView = "list" | "chat" | "info";
type ChatFilter = "me" | "all" | string;

export default function TicketsPage() {
  const { user } = useAuth();
  const me = user?.admin_id ?? "";
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  // Phase 5 — close/reopen + history + right panel
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeHistory, setCloseHistory] = useState<CloseHistoryRecord[]>([]);
  const [rightTab, setRightTab] = useState<"info" | "chatlog" | "products">("info");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Phase 7.9 — filter + admins list + accept state (status/sort ย้ายไป ChatList แล้ว)
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [acceptingChats, setAcceptingChats] = useState<boolean>(user?.is_accepting_chats ?? true);
  const [togglingAccept, setTogglingAccept] = useState(false);
  // Phase 7.9 — popup เตือนตอบทับ
  const [conflictPopup, setConflictPopup] = useState<{ assignedTo: string; text: string } | null>(null);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // Phase 7.9 — โหลด admins list สำหรับ filter dropdown (ถ้า role ไม่ใช่ admin)
  useEffect(() => {
    if (user?.role === "admin") return; // admin role ไม่มีสิทธิ์ /users/list
    api().get<{ users: AdminUser[]; canEdit: boolean }>("/users/list").then((r) => {
      setAdmins(r.data.users || []);
    }).catch(() => setAdmins([]));
  }, [user?.role]);

  // Phase 7.4 — โหลด conversations จาก chatbot DB จริง (รองรับ chatFilter)
  // status/sort/platform/shop filter ทำใน ChatList เพื่อความเร็ว (ไม่ต้อง reload API)
  const loadConversations = useCallback(async () => {
    try {
      const rows = await chatService.list({
        assigned_to: chatFilter === "me" ? "me" : chatFilter === "all" ? "all" : chatFilter,
      });
      setConversations(rows);
    } catch (err) {
      console.error("load conversations failed", err);
      setConversations([]);
    }
  }, [chatFilter]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Phase 7.5 — polling 3 วิ หยุดเมื่อ tab inactive
  usePolling(loadConversations, 3000);

  // Load messages when conversation changes — โหลดทั้งหมด (เหมือนเดิม)
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    setLoadingMessages(true);
    chatService
      .messages(selectedId)
      .then(setMessages)
      .catch((err) => {
        console.error("load messages failed", err);
        setMessages([]);
      })
      .finally(() => setLoadingMessages(false));
  }, [selectedId]);

  // Phase 7.5 — poll messages เฉพาะข้อความใหม่ (after cursor) — เร็วและเบา
  // ⚠️ merge แทนทับ — กัน product card / temp message ที่เพิ่งส่งหาย
  usePolling(
    useCallback(async () => {
      if (!selectedId) return;
      try {
        // หา timestamp ล่าสุดจาก messages ปัจจุบัน
        const newest = messages.length > 0
          ? messages[messages.length - 1].timestamp
          : undefined;
        if (!newest) return; // ยังไม่มี messages ให้ข้าม (รอ initial load)
        // โหลดเฉพาะข้อความที่ใหม่กว่า newest
        const data = await chatService.messagesPage(selectedId, { limit: 100, after: newest });
        if (data.messages.length === 0) return; // ไม่มีข้อความใหม่
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newOnly = data.messages.filter((m) => !existingIds.has(m.id));
          if (newOnly.length === 0) return prev;
          const merged = [...prev, ...newOnly].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          return merged;
        });
      } catch (err) {
        console.error("poll messages failed", err);
      }
    }, [selectedId, messages]),
    2000,
    { enabled: !!selectedId }
  );

  // Load close history when conversation changes
  useEffect(() => {
    if (!selectedId) { setCloseHistory([]); return; }
    chatService
      .closeHistory(selectedId)
      .then((d) => setCloseHistory(d.history || []))
      .catch(() => setCloseHistory([]));
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("chat");
  }, []);

  const handleBack = useCallback(() => {
    setMobileView("list");
    setSelectedId(null);
  }, []);

  // Phase 7.9 — send พร้อมเช็ค conflict (assigned_to ไม่ใช่ตัวเอง)
  const sendInternal = useCallback(
    async (text: string, force: boolean) => {
      if (!selectedId) return;
      const res = await chatService.send(selectedId, text, force);
      if (res.conflict) {
        // backend บอกว่า assigned ให้คนอื่น → เปิด popup
        setConflictPopup({ assignedTo: res.assigned_to || "?", text });
        return false;
      }
      if (res.message) setMessages((prev) => [...prev, res.message]);
      // ⚡ reload conversations ทันที — ให้ list อัปเดต (unanswered count เปลี่ยน)
      loadConversations();
      return true;
    },
    [selectedId, loadConversations]
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!selectedId) return;
      setSending(true);
      // ไม่ต้องสร้าง tempMsg — sendInternal จะเพิ่ม message จริงจาก API แล้ว
      // ถ้าสร้าง tempMsg ด้วยจะซ้อนกัน 2 อัน (temp + ของจริง) เพราะ id ต่างกัน merge ไม่ออก
      try {
        await sendInternal(text, false);
      } catch {
        // offline — ไม่มีอะไรต้องทำ (polling จะ sync ให้เมื่อ online)
      } finally {
        setSending(false);
      }
    },
    [selectedId, sendInternal]
  );

  // ยืนยัน force send (หลัง popup)
  const handleForceSend = useCallback(async () => {
    if (!conflictPopup) return;
    setSending(true);
    try {
      await sendInternal(conflictPopup.text, true);
      setConflictPopup(null);
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }, [conflictPopup, sendInternal]);

  // รับช่วง — assign ให้ตัวเองแล้วค่อยส่ง
  const handleTakeOver = useCallback(async () => {
    if (!selectedId || !conflictPopup) return;
    setSending(true);
    try {
      await chatService.assign(selectedId, me);
      await sendInternal(conflictPopup.text, false);
      setConflictPopup(null);
      // refresh list
      loadConversations();
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }, [selectedId, conflictPopup, me, sendInternal, loadConversations]);

  const handleHandoff = useCallback(() => {
    if (!selectedId) return;
    chatService.handoff(selectedId).catch(() => { });
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, status: "handoff" } : c))
    );
  }, [selectedId]);

  // Phase 7.9 — เปิด/ปิดสถานะรับแชทของตัวเอง
  const handleToggleAccepting = useCallback(async () => {
    setTogglingAccept(true);
    try {
      const r = await chatService.setAcceptingChats(!acceptingChats);
      setAcceptingChats(r.is_accepting_chats);
    } catch (err) {
      console.error("toggle accepting failed", err);
    } finally {
      setTogglingAccept(false);
    }
  }, [acceptingChats]);

  const handleResolve = useCallback(() => {
    if (!selectedId) return;
    // เปลี่ยนจาก resolve เดิม → เปิด close modal แทน (บังคับกรอกข้อมูล)
    setShowCloseModal(true);
  }, [selectedId]);

  // Phase 5 — ปิดแชท (กรอก reason/category/resolution/note)
  const handleClose = useCallback(
    async (data: { reason: string; category: ProblemCategory; resolution: string; note?: string }) => {
      if (!selectedId) return;
      setClosing(true);
      try {
        await chatService.close(selectedId, data);
        setConversations((prev) =>
          prev.map((c) => (c.id === selectedId ? { ...c, status: "closed" as never } : c))
        );
        setShowCloseModal(false);
        // refresh history
        const d = await chatService.closeHistory(selectedId);
        setCloseHistory(d.history || []);
      } catch {
        // ignore — keep modal open
      } finally {
        setClosing(false);
      }
    },
    [selectedId]
  );

  // Phase 5 — เปิดแชทใหม่ (手动)
  const handleReopen = useCallback(async () => {
    if (!selectedId) return;
    try {
      await chatService.reopen(selectedId, "แอดมินเปิดแชทใหม่");
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, status: "open" as never } : c))
      );
      const d = await chatService.closeHistory(selectedId);
      setCloseHistory(d.history || []);
    } catch {
      // ignore
    }
  }, [selectedId]);

  // Transfer — โยนแชทให้ admin คนอื่น
  const handleTransfer = useCallback(async (newAdminId: string) => {
    if (!selectedId) return;
    try {
      await api().post("/assignment/reassign", {
        conversation_id: selectedId,
        new_admin_id: newAdminId,
        reason: "โยนแชทจากหน้า tickets",
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId ? { ...c, assigned_to: newAdminId } : c
        )
      );
    } catch {
      // ignore
    }
  }, [selectedId]);

  const handleSuggestProduct = useCallback(() => {
    if (!selectedId) return;
    const suggestion: ChatMessage = {
      id: `sugg_${Date.now()}`,
      role: "admin",
      text: "แนะนำสินค้าแนะนำเพิ่มเติมค่ะ",
      timestamp: new Date().toISOString(),
      products: [{ item_id: "item_rec", name: "สินค้าแนะนำ", price: 999 }],
    };
    setMessages((prev) => [...prev, suggestion]);
  }, [selectedId]);

  // Update ticket fields inline (Zaapi-style)
  const handleTicketChange = useCallback(
    (patch: Partial<Conversation>) => {
      if (!selectedId) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selectedId
            ? { ...c, ...patch, ticket_updated_at: new Date().toISOString() }
            : c
        )
      );
    },
    [selectedId]
  );

  const handleSendCode = useCallback(() => {
    if (!selectedId) return;
    const code: ChatMessage = {
      id: `code_${Date.now()}`,
      role: "admin",
      text: "รหัสยืนยันของคุณคือ 123456 (หมดอายุใน 10 นาที)",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, code]);
  }, [selectedId]);

  return (
    <div className="h-full flex">
      {/* ── Panel ซ้าย: Conversation list (รวม title + filter + accept ใน ChatList) ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full flex-col w-full md:w-80 shrink-0 border-r border-border`}>
        <ChatList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelect}
          admins={admins}
          chatFilter={chatFilter}
          onChatFilterChange={setChatFilter}
          acceptingChats={acceptingChats}
          onToggleAccepting={handleToggleAccepting}
          togglingAccept={togglingAccept}
        />
      </div>

      {/* ── Panel กลาง: Ticket fields + Chat ── */}
      <div className={`${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 h-full min-w-0 relative`}>
        {/* Mobile back button */}
        <button
          onClick={handleBack}
          className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
          title="กลับ"
        >
          <ArrowLeft size={16} className="text-text" />
        </button>
        {/* Mobile info button */}
        {selected && (
          <button
            onClick={() => setMobileView("info")}
            className="md:hidden absolute top-3 right-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
            title="รายละเอียด"
          >
            <Info size={16} className="text-text" />
          </button>
        )}
        <TicketChatPanel
          conversation={selected}
          messages={messages}
          onSend={handleSend}
          onHandoff={handleHandoff}
          onResolve={handleResolve}
          onReopen={handleReopen}
          onTransfer={handleTransfer}
          onSuggestProduct={handleSuggestProduct}
          onTicketChange={handleTicketChange}
          sending={sending}
        />
      </div>

      {/* ── Panel ขวา: ข้อมูล / ประวัติแชท / สินค้า ── (ยืด/หด ได้) */}
      {selected && (
        <>
          {/* Panel เมื่อ expanded */}
          <div
            className={`${mobileView === "info" ? "flex" : "hidden"} ${rightCollapsed ? "md:hidden" : "md:flex"} h-full transition-[width] duration-200 ease-in-out`}
          >
            <div className="relative h-full flex flex-col w-[340px] border-l border-border bg-surface">
              <button
                onClick={() => setMobileView("chat")}
                className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
                title="กลับ"
              >
                <ArrowLeft size={16} className="text-text" />
              </button>

              {/* Tab switcher — 3 tabs */}
              <div className="flex border-b border-border shrink-0">
                <button
                  onClick={() => setRightTab("info")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "info" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
                    }`}
                >
                  ข้อมูล
                </button>
                <button
                  onClick={() => setRightTab("chatlog")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "chatlog" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
                    }`}
                >
                  ประวัติแชท
                </button>
                <button
                  onClick={() => setRightTab("products")}
                  className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors ${rightTab === "products" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
                    }`}
                >
                  สินค้า
                </button>
                {/* Collapse button */}
                <button
                  onClick={() => setRightCollapsed(true)}
                  className="px-2 text-text-muted hover:text-text transition-colors shrink-0"
                  title="ซ่อน panel"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-hidden">
                {rightTab === "info" && (
                  <InfoTab
                    conversation={selected}
                    messages={messages}
                    closeHistory={closeHistory}
                    onSuggestProduct={handleSuggestProduct}
                    onCreateTicket={() => { }}
                    onSendCode={handleSendCode}
                  />
                )}
                {rightTab === "chatlog" && (
                  <ChatLogTab messages={messages} />
                )}
                {rightTab === "products" && (
                  <ProductsTab
                    conversation={selected}
                    onSendProduct={(product) => {
                      // ดึงข้อมูลจาก schema ต่างๆ ของ Shopee/TikTok/Lazada
                      const itemId = String(product.itemid || product.item_id || product.id || "");
                      const name = String(product.name || product.item_name || product.title || product.product_name || "สินค้า");
                      const price = Number(product.price || product.new_check_price || product.gen_price || 0);
                      // image extraction (เหมือน ProductsTab.extractImage)
                      let image: string | undefined;
                      if (Array.isArray(product.images) && product.images.length > 0) {
                        const f = String(product.images[0]);
                        image = f.startsWith("http") ? f : undefined;
                      } else if (product.images && typeof product.images === "object" && !Array.isArray(product.images)) {
                        const list = (product.images as any).image_url_list || (product.images as any).image_id_list;
                        if (Array.isArray(list) && list.length > 0) {
                          const first = String(list[0]);
                          image = first.startsWith("http") ? first : "https://cf.shopee.co.th/file/" + first;
                        }
                      } else if (Array.isArray(product.main_images) && product.main_images.length > 0) {
                        const mi = product.main_images[0];
                        if (mi?.thumb_urls?.length) image = mi.thumb_urls[0];
                        else if (mi?.url) image = mi.url;
                      } else if (typeof product.image_url === "string") {
                        image = product.image_url;
                      } else if (typeof product.image === "string") {
                        image = product.image;
                      }
                      // url extraction — เช็คว่าเป็น string จริง (กัน [object Object])
                      let url: string | undefined;
                      for (const c of [product.short_link, product.url, product.product_link]) {
                        if (typeof c === "string" && c.startsWith("http")) { url = c; break; }
                      }
                      const shop = product.shopname || selected.shop_name;
                      const msg: ChatMessage = {
                        id: `prod_${Date.now()}`,
                        role: "admin",
                        text: `แนะนำสินค้า: ${name}`,
                        timestamp: new Date().toISOString(),
                        products: [{ item_id: itemId, name, price, image, shop, url }],
                      };
                      setMessages((prev) => [...prev, msg]);
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Expand button — เมื่อ collapsed */}
          {rightCollapsed && (
            <button
              onClick={() => setRightCollapsed(false)}
              className="hidden md:flex absolute top-1/2 right-0 -translate-y-1/2 z-20 w-7 h-16 bg-surface border border-border rounded-l-lg items-center justify-center hover:bg-surface-2 transition-colors shadow-sm"
              title="แสดง panel"
            >
              <PanelRightOpen size={16} className="text-text-muted" />
            </button>
          )}
        </>
      )}

      {/* ── Close Chat Modal ── */}
      {showCloseModal && selected && (
        <CloseChatModal
          conversation={selected}
          onClose={() => setShowCloseModal(false)}
          onSubmit={handleClose}
          loading={closing}
        />
      )}

      {/* Phase 7.9 — Conflict popup (ตอบทับแชทที่ assign ให้คนอื่น) */}
      {conflictPopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-surface rounded-xl border border-border p-5 max-w-md w-full shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-yellow-500/15 flex items-center justify-center flex-shrink-0">
                <Info size={16} className="text-yellow-400" />
              </div>
              <h3 className="text-sm font-semibold text-text">แชทนี้ assign ให้แอดมินคนอื่น</h3>
            </div>
            <p className="text-xs text-text-muted mb-4">
              แชทนี้ถูกมอบหมายให้ <code className="bg-surface-2 px-1.5 py-0.5 rounded font-mono text-text">{conflictPopup.assignedTo}</code> แล้ว
              <br />
              ถ้าส่งต่อไป ข้อความจะถูกบันทึก log ไว้เป็น &quot;forced override&quot;
              <br />
              <span className="text-text-subtle">ข้อความที่จะส่ง: &quot;{conflictPopup.text.slice(0, 60)}{conflictPopup.text.length > 60 ? "..." : ""}&quot;</span>
            </p>
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => setConflictPopup(null)}
                className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-surface-2 transition-colors"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleTakeOver}
                disabled={sending}
                className="px-3 py-1.5 rounded-md text-xs bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {sending ? "..." : "รับช่วง + ส่ง"}
              </button>
              <button
                onClick={handleForceSend}
                disabled={sending}
                className="px-3 py-1.5 rounded-md text-xs bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 transition-colors disabled:opacity-50"
              >
                {sending ? "..." : "ส่งทับ (force)"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
