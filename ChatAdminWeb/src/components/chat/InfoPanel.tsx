// InfoPanel — right column: conversation metadata, shop, products, actions (Zaapi-style)
"use client";
import { Store, Tag, User, Hash, Activity, Clock, Bot, Sparkles, Ticket, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { Conversation, ChatMessage, Topic } from "@/lib/types";

interface Props {
  conversation: Conversation;
  messages: ChatMessage[];
  onSuggestProduct?: () => void;
  onCreateTicket?: () => void;
  onSendCode?: () => void;
}

const topicLabels: Record<Topic, string> = {
  product_inquiry: "สอบถามสินค้า",
  product_compare: "เปรียบเทียบสินค้า",
  usage_help: "การใช้งาน",
  claim: "เคลม",
  warranty: "รับประกัน",
  problem_report: "แจ้งปัญหา",
  tax_invoice: "ใบกำกับภาษี",
  shipping: "จัดส่ง",
  general: "ทั่วไป",
  handoff: "ส่งแอดมิน",
};

function Row({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 py-2">
      <Icon size={14} className="text-text-subtle mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-text-subtle uppercase tracking-wide">{label}</div>
        <div className="text-sm text-text break-words">{value}</div>
      </div>
    </div>
  );
}

export function InfoPanel({ conversation, messages, onSuggestProduct, onCreateTicket, onSendCode }: Props) {
  const botMsgs = messages.filter((m) => m.role === "bot");
  const userMsgs = messages.filter((m) => m.role === "user");
  const totalTokens = messages.reduce((s, m) => s + (m.tokens?.total ?? 0), 0);
  const topics = [...new Set(messages.map((m) => m.topic).filter(Boolean))] as Topic[];
  const productsMentioned = messages.flatMap((m) => m.products ?? []);

  return (
    <aside className="w-72 shrink-0 border-l border-border bg-surface overflow-y-auto h-full">
      <div className="p-4 space-y-3">
        {/* Actions */}
        <Card className="p-3 bg-pale-sky-soft/40 border-pale-sky">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">การกระทำ</h3>
          <div className="grid grid-cols-1 gap-1.5">
            <Button size="sm" variant="outline" onClick={onSuggestProduct} className="justify-start">
              <Sparkles size={13} className="text-brand" /> แนะนำสินค้า
            </Button>
            <Button size="sm" variant="outline" onClick={onSendCode} className="justify-start">
              <KeyRound size={13} className="text-deep-space" /> ส่งรหัสยืนยัน
            </Button>
            <Button size="sm" variant="outline" onClick={onCreateTicket} className="justify-start">
              <Ticket size={13} className="text-vibrant-coral" /> สร้างตั๋ว
            </Button>
          </div>
        </Card>

        {/* Customer */}
        <Card className="p-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">ลูกค้า</h3>
          <Row icon={User} label="ชื่อ" value={conversation.customer_name} />
          <Row icon={Hash} label="Customer ID" value={conversation.customer_id} />
        </Card>

        {/* Shop */}
        <Card className="p-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">ร้านค้า</h3>
          <Row icon={Store} label="ชื่อร้าน" value={conversation.shop_name} />
          <Row icon={Hash} label="Shop ID" value={conversation.shop_id} />
          <Row icon={Tag} label="แพลตฟอร์ม" value={conversation.platform} />
        </Card>

        {/* Products mentioned */}
        {productsMentioned.length > 0 && (
          <Card className="p-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              สินค้าที่เกี่ยวข้อง ({productsMentioned.length})
            </h3>
            <div className="space-y-1.5">
              {productsMentioned.slice(0, 5).map((p, i) => (
                <div key={`${p.item_id}-${i}`} className="flex items-center gap-2 rounded-md bg-surface-2 p-1.5">
                  {p.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt={p.name} className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-surface shrink-0 flex items-center justify-center">
                      <Tag size={12} className="text-text-subtle" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text truncate">{p.name}</div>
                    {p.price != null && <div className="text-[10px] text-text-muted">฿{p.price.toLocaleString()}</div>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Locked items */}
        {conversation.item_ids && conversation.item_ids.length > 0 && (
          <Card className="p-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              สินค้าที่ล็อค ({conversation.item_ids.length})
            </h3>
            <div className="space-y-1">
              {conversation.item_ids.map((id) => (
                <div key={id} className="text-xs font-mono bg-surface-2 rounded px-2 py-1 text-text-muted">
                  {id}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Conversation meta */}
        <Card className="p-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">การสนทนา</h3>
          <Row icon={Hash} label="Conversation ID" value={conversation.id} />
          <Row icon={Clock} label="เริ่มต้น" value={new Date(conversation.last_timestamp).toLocaleString("th-TH")} />
          <div className="flex items-start gap-2 py-2">
            <Activity size={14} className="text-text-subtle mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-text-subtle uppercase tracking-wide">สถานะ</div>
              <div className="mt-0.5">
                <Badge tone={conversation.status === "bot" ? "brand" : conversation.status === "handoff" ? "coral" : "neutral"}>
                  {conversation.status === "bot" ? "บอทตอบ" : conversation.status === "handoff" ? "แอดมินรับ" : conversation.status}
                </Badge>
              </div>
            </div>
          </div>
        </Card>

        {/* Topics */}
        {topics.length > 0 && (
          <Card className="p-3">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">หัวข้อที่พูด</h3>
            <div className="flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <Badge key={t} tone="pale">{topicLabels[t]}</Badge>
              ))}
            </div>
          </Card>
        )}

        {/* Stats */}
        <Card className="p-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">สถิติ</h3>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-surface-2 rounded-lg p-2">
              <div className="text-lg font-semibold text-text">{userMsgs.length}</div>
              <div className="text-[10px] text-text-muted">ลูกค้า</div>
            </div>
            <div className="bg-surface-2 rounded-lg p-2">
              <div className="text-lg font-semibold text-text flex items-center justify-center gap-1">
                <Bot size={14} className="text-brand" />
                {botMsgs.length}
              </div>
              <div className="text-[10px] text-text-muted">บอท</div>
            </div>
          </div>
          {totalTokens > 0 && (
            <div className="mt-2 text-center text-[11px] text-text-muted">
              Tokens รวม: {totalTokens.toLocaleString()}
            </div>
          )}
        </Card>

        {/* Log */}
        <Card className="p-3">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Log ถาม-ตอบ</h3>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {messages.map((m) => (
              <div key={m.id} className="text-[11px] border-l-2 pl-2 py-0.5" style={{
                borderColor: m.role === "user" ? "#bfd7ea" : m.role === "bot" ? "#8b1e28" : "#0b3954"
              }}>
                <span className="text-text-subtle">
                  {new Date(m.timestamp).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
                </span>{" "}
                <span className="font-medium">{m.role}:</span>{" "}
                <span className="text-text-muted">{m.text.slice(0, 60)}{m.text.length > 60 ? "..." : ""}</span>
                {m.source && <span className="text-text-subtle"> · {m.source}</span>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </aside>
  );
}
