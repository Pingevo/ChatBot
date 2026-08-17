"use client";
import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Info } from "lucide-react";
import { ChatList } from "@/components/chat/ChatList";
import { TicketChatPanel } from "@/components/chat/TicketChatPanel";
import { InfoPanel } from "@/components/chat/InfoPanel";
import { chatService } from "@/lib/services";
import type { Conversation, ChatMessage } from "@/lib/types";

// ─── Mock data (replace when backend wired) ────────────────────────────────────
const mockConversations: Conversation[] = [
  {
    id: "conv_001",
    platform: "shopee",
    shop_id: "shop_123",
    shop_name: "IMILabThailand",
    customer_id: "user_001",
    customer_name: "คุณสมชาย",
    status: "bot",
    topic: "product_inquiry",
    last_message: "มีกล้องวงจรปิดไหม",
    last_timestamp: new Date(Date.now() - 120000).toISOString(),
    unread: 2,
    item_ids: [],
    // ticket metadata
    ticket_id: "TK-001",
    ticket_status: "open",
    ticket_priority: "medium",
    ticket_issue_type: "product_inquiry",
  },
  {
    id: "conv_002",
    platform: "tiktok",
    shop_id: "shop_456",
    shop_name: "KospetThailand",
    customer_id: "user_002",
    customer_name: "Jane Doe",
    status: "handoff",
    topic: "claim",
    last_message: "ส่งซ่อมรับประกันไงคะ",
    last_timestamp: new Date(Date.now() - 600000).toISOString(),
    unread: 1,
    item_ids: ["item_789"],
    // ticket metadata
    ticket_id: "TK-002",
    ticket_status: "in_progress",
    ticket_priority: "high",
    ticket_issue_type: "claim",
    ticket_resolution: "แจ้งทีมซ่อม",
  },
  {
    id: "conv_003",
    platform: "lazada",
    shop_id: "shop_789",
    shop_name: "Yaber",
    customer_id: "user_003",
    customer_name: "คุณมานี",
    status: "bot",
    topic: "product_compare",
    last_message: "เปรียบเทียบ Yaber K1 กับ V6",
    last_timestamp: new Date(Date.now() - 3600000).toISOString(),
    unread: 0,
    item_ids: ["item_k1", "item_v6"],
    ticket_id: "TK-003",
    ticket_status: "open",
    ticket_priority: "low",
    ticket_issue_type: "product_compare",
  },
  {
    id: "conv_004",
    platform: "shopee",
    shop_id: "shop_123",
    shop_name: "YoupinOfficialStore",
    customer_id: "user_004",
    customer_name: "Tanakorn",
    status: "resolved",
    topic: "shipping",
    last_message: "ส่งกี่วันครับ",
    last_timestamp: new Date(Date.now() - 86400000).toISOString(),
    unread: 0,
    ticket_id: "TK-004",
    ticket_status: "resolved",
    ticket_priority: "low",
    ticket_issue_type: "shipping",
    ticket_resolution: "ไม่ดำเนินการ",
  },
  {
    id: "conv_005",
    platform: "tiktok",
    shop_id: "shop_456",
    shop_name: "KospetThailand",
    customer_id: "user_005",
    customer_name: "Somchai",
    status: "pending",
    topic: "tax_invoice",
    last_message: "ขอใบกำกับภาษีครับ",
    last_timestamp: new Date(Date.now() - 7200000).toISOString(),
    unread: 0,
    ticket_id: "TK-005",
    ticket_status: "open",
    ticket_priority: "medium",
    ticket_issue_type: "tax_invoice",
  },
];

const mockMessages: Record<string, ChatMessage[]> = {
  conv_001: [
    { id: "m1", role: "user", text: "สวัสดีครับ", timestamp: new Date(Date.now() - 180000).toISOString() },
    { id: "m2", role: "bot", text: "สวัสดีค่ะ ยินดีต้อนรับสู่ IMILabThailand มีอะไรให้ช่วยไหมคะ", timestamp: new Date(Date.now() - 170000).toISOString(), source: "general:greeting", topic: "general" },
    { id: "m3", role: "user", text: "มีกล้องวงจรปิดไหม", timestamp: new Date(Date.now() - 120000).toISOString() },
    { id: "m4", role: "bot", text: "มีค่ะ ทางเรามีกล้องวงจรปิด IMILAB หลายรุ่น ขอแนะนำ IMILAB EC6 Dual Pro ค่ะ", timestamp: new Date(Date.now() - 110000).toISOString(), source: "product_store", topic: "product_inquiry", products: [{ item_id: "item_ec6", name: "IMILAB EC6 Dual Pro กล้องวงจรปิด 2 เลนส์", price: 2242 }], tokens: { prompt: 320, output: 180, total: 500 } },
  ],
  conv_002: [
    { id: "m1", role: "user", text: "นาฬิกาพัง ส่งซ่อมรับประกันไงคะ", timestamp: new Date(Date.now() - 600000).toISOString() },
    { id: "m2", role: "bot", text: "ขออภัยที่ทราบเรื่องไม่ดีนะคะ สำหรับการเคลมสินค้า กรุณาแนบวิดีโอขณะแกะกล่องและเลขคำสั่งซื้อ แอดมินจะรับเรื่องต่อให้ค่ะ", timestamp: new Date(Date.now() - 590000).toISOString(), source: "general:warranty_policy", topic: "claim" },
    { id: "m3", role: "system", text: "ส่งต่อให้แอดมินเรียบร้อย", timestamp: new Date(Date.now() - 580000).toISOString() },
  ],
};

type MobileView = "list" | "chat" | "info";

export default function TicketsPage() {
  const [conversations, setConversations] = useState<Conversation[]>(mockConversations);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  // Load messages when conversation changes
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    chatService
      .messages(selectedId)
      .then(setMessages)
      .catch(() => setMessages(mockMessages[selectedId] ?? []));
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("chat");
  }, []);

  const handleBack = useCallback(() => {
    setMobileView("list");
    setSelectedId(null);
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      if (!selectedId) return;
      setSending(true);
      const tempMsg: ChatMessage = {
        id: `temp_${Date.now()}`,
        role: "admin",
        text,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempMsg]);
      try {
        const res = await chatService.send(selectedId, text);
        if (res.message) setMessages((prev) => [...prev, res.message]);
      } catch {
        // offline — keep temp message
      } finally {
        setSending(false);
      }
    },
    [selectedId]
  );

  const handleHandoff = useCallback(() => {
    if (!selectedId) return;
    chatService.handoff(selectedId).catch(() => {});
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedId ? { ...c, status: "handoff" } : c))
    );
  }, [selectedId]);

  const handleResolve = useCallback(() => {
    if (!selectedId) return;
    chatService.resolve(selectedId).catch(() => {});
    setConversations((prev) =>
      prev.map((c) =>
        c.id === selectedId
          ? { ...c, status: "resolved", ticket_status: "resolved" }
          : c
      )
    );
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
      {/* ── Panel ซ้าย: Conversation list ── */}
      <div className={`${mobileView === "list" ? "flex" : "hidden"} md:flex h-full`}>
        <ChatList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelect}
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
          onSuggestProduct={handleSuggestProduct}
          onTicketChange={handleTicketChange}
          sending={sending}
        />
      </div>

      {/* ── Panel ขวา: Customer info + ticket history ── */}
      {selected && (
        <div className={`${mobileView === "info" ? "flex" : "hidden"} md:flex h-full`}>
          <div className="relative h-full">
            <button
              onClick={() => setMobileView("chat")}
              className="md:hidden absolute top-3 left-3 z-10 w-8 h-8 rounded-lg bg-surface border border-border flex items-center justify-center shadow-sm"
              title="กลับ"
            >
              <ArrowLeft size={16} className="text-text" />
            </button>
            <InfoPanel
              conversation={selected}
              messages={messages}
              onSuggestProduct={handleSuggestProduct}
              onCreateTicket={() => {}}
              onSendCode={handleSendCode}
            />
          </div>
        </div>
      )}
    </div>
  );
}
