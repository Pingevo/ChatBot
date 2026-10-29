// Custom React Flow nodes สำหรับ Workflow Editor (แบบ Zaapi Flow Builder)
// แต่ละ type มีสี + ไอคอน + สรุป config ให้เห็นเร็วๆ บน canvas
//   card = type-tinted header + node name (config.label) + summary + handles
//   handles/subtype label = registry (nodeRegistry.resolveOutputHandles/getNodeDef)
//   — owner เดียวกับที่ edges ใช้ ครอบทั้ง zaapi conditions[] และ local shape
//   selected = data.selected (editor inject จาก selectedNodeId — click/new node)
"use client";
import { useEffect, useRef } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import {
  Zap, GitBranch, Play, Clock, MessageSquare, Bot, UserPlus, Tag, XCircle,
  StickyNote, Globe, Repeat, LogIn, LogOut, MessageCircleQuestion, Timer,
  CalendarClock, Hourglass, Shuffle, MousePointerClick, Store, Star, FileText,
} from "lucide-react";
import { getNodeDef, resolveOutputHandles } from "@/lib/workflow/nodeRegistry";

export type FlowNodeType = "trigger" | "condition" | "action" | "wait";

export const NODE_TYPE_META: Record<
  FlowNodeType,
  { label: string; color: string; bg: string; border: string; icon: React.ReactNode }
> = {
  trigger: { label: "Trigger", color: "#d97706", bg: "#ffffff", border: "#e5e7eb", icon: <Zap size={13} /> },
  condition: { label: "Condition", color: "#7c3aed", bg: "#ffffff", border: "#e5e7eb", icon: <GitBranch size={13} /> },
  action: { label: "Action", color: "#059669", bg: "#ffffff", border: "#e5e7eb", icon: <Play size={13} /> },
  wait: { label: "Wait", color: "#8b1e28", bg: "#ffffff", border: "#e5e7eb", icon: <Clock size={13} /> },
};

export const SUBTYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  // trigger
  message_received: { label: "ได้รับข้อความ (keyword)", icon: <MessageSquare size={13} /> },
  // condition
  message_content: { label: "เนื้อหาข้อความ", icon: <MessageCircleQuestion size={13} /> },
  conversation_status: { label: "สถานะแชท", icon: <LogIn size={13} /> },
  business_hours: { label: "เวลาทำการ", icon: <Clock size={13} /> },
  new_vs_returning: { label: "ลูกค้าใหม่/เก่า", icon: <Repeat size={13} /> },
  assignee: { label: "ผู้รับผิดชอบ", icon: <UserPlus size={13} /> },
  // action
  send_message: { label: "ส่งข้อความ", icon: <MessageSquare size={13} /> },
  let_ai_respond: { label: "ให้ AI ตอบ", icon: <Bot size={13} /> },
  assign_ticket: { label: "จ่ายงานแอดมิน", icon: <UserPlus size={13} /> },
  add_label: { label: "ติด label", icon: <Tag size={13} /> },
  close_ticket: { label: "ปิดแชท", icon: <XCircle size={13} /> },
  add_note: { label: "บันทึก note", icon: <StickyNote size={13} /> },
  send_http: { label: "เรียก webhook", icon: <Globe size={13} /> },
  jump_to: { label: "วนกลับ (jump)", icon: <LogOut size={13} /> },
  // wait
  wait_for_reply: { label: "รอลูกค้าตอบ", icon: <Clock size={13} /> },
  // imported-only (canonical registry มี label — local palette ไม่มี)
  label: { label: "ตรวจ label", icon: <Tag size={13} /> },
  last_interaction: { label: "เวลาล่าสุด", icon: <Timer size={13} /> },
  customer_waiting_time: { label: "เวลารอลูกค้า", icon: <Hourglass size={13} /> },
  event_time: { label: "ช่วงเวลา event", icon: <CalendarClock size={13} /> },
  delay: { label: "หน่วงเวลา", icon: <Clock size={13} /> },
  remove_label: { label: "ลบ label", icon: <Tag size={13} /> },
  unassign_ticket: { label: "ยกเลิกมอบหมาย", icon: <UserPlus size={13} /> },
  send_button_template: { label: "ส่งปุ่ม template", icon: <MousePointerClick size={13} /> },
  randomizer: { label: "สุ่มเส้นทาง", icon: <Shuffle size={13} /> },
  send_marketplace_order_card: { label: "การ์ดออเดอร์", icon: <Store size={13} /> },
};

/** subtype label/icon — SUBTYPE_META ก่อน, fallback registry label (canonical owner) */
function subtypeMeta(subtype: string): { label: string; icon: React.ReactNode } {
  const local = SUBTYPE_META[subtype];
  if (local) return local;
  const def = getNodeDef(subtype);
  if (def) return { label: def.label, icon: <FileText size={13} /> };
  return { label: subtype || "", icon: null };
}

const trunc = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);

/** text ตัวแรกของ condition — keyword → operator → label fallback */
function condText(c: Record<string, unknown>): string {
  const t = c.text;
  if (Array.isArray(t) && t.length) return String(t[0]);
  if (typeof t === "string" && t) return t;
  const op = String(c.operator || "");
  if (op === "within_office_hours") return "ในเวลาทำการ";
  if (op === "outside_office_hours") return "นอกเวลา";
  if (op === "within_time_range") return "ในช่วงเวลา";
  if (op === "outside_time_range") return "นอกช่วงเวลา";
  const li = c.lastInteraction as { value?: number; unit?: string } | undefined;
  if (li?.value != null) return `> ${li.value} ${li.unit}`;
  if (op) return op.replace(/_/g, " ");
  return "";
}

/** canonical-Zaapi summary — conditions[] / action.* / waitForReply shapes; null = ไม่ใช่ zaapi shape → legacy */
function zaapiSummary(subtype: string, config: Record<string, unknown>): string | null {
  const act = config.action as Record<string, unknown> | undefined;
  const conds = Array.isArray(config.conditions) ? config.conditions as Record<string, unknown>[] : null;
  switch (subtype) {
    case "message_received": {
      if (!("triggerOncePerOpen" in config || "triggerOncePerConversation" in config)) return null;
      const bits: string[] = [];
      if (config.triggerOncePerOpen) bits.push("ครั้งเดียว/ตั๋วใหม่");
      if (config.triggerOncePerConversation) bits.push("ครั้งเดียว/แชท");
      return bits.length ? bits.join(" · ") : "ทุกข้อความ";
    }
    case "message_content":
      return conds ? `${conds.length} เงื่อนไข${conds[0] ? `: ${trunc(condText(conds[0]), 22)}` : ""}` : null;
    case "business_hours":
      return conds ? (conds.some((c) => String(c.operator).includes("outside")) ? "ในเวลา / นอกเวลา" : "ตรวจเวลาทำการ") : null;
    case "event_time":
      return conds ? (conds.some((c) => String(c.operator).includes("outside")) ? "ใน/นอกช่วงเวลา" : "ตรวจช่วงเวลา") : null;
    case "label":
      return conds ? `label ×${conds.length}` : null;
    case "assignee":
      return conds ? `ผู้รับ ×${conds.length}` : null;
    case "last_interaction":
    case "customer_waiting_time":
      return conds ? (conds[0] ? trunc(condText(conds[0]), 26) || `${conds.length} เงื่อนไข` : "0 เงื่อนไข") : null;
    case "send_message": {
      const m = act?.message as { text?: string; type?: string } | undefined;
      if (!m) return null;
      return m.text ? trunc(String(m.text)) : `[${m.type || "non-text"}]`;
    }
    case "send_button_template": {
      const bt = act?.buttonTemplate as { buttons?: unknown[] } | undefined;
      return bt ? `template · ${bt.buttons?.length ?? 0} ปุ่ม` : null;
    }
    case "let_ai_respond": {
      const cb = act?.chatbot as { timeout?: { value?: number; unit?: string } } | undefined;
      return cb ? `AI ตอบ · timeout ${cb.timeout?.value ?? "?"} ${cb.timeout?.unit ?? ""}` : null;
    }
    case "assign_ticket":
      return act?.assignment ? "มอบหมายอัตโนมัติ" : null;
    case "add_label":
      return act?.label ? "ติด label" : null;
    case "remove_label":
      return act?.label ? "ลบ label" : null;
    case "jump_to": {
      const j = act?.jumpTo as { maxJumps?: number } | undefined;
      return j ? `jump (สูงสุด ${j.maxJumps ?? "∞"})` : null;
    }
    case "wait_for_reply": {
      const w = config.waitForReply as { replyType?: string; numberOfRetries?: number; expiresIn?: { value?: number; unit?: string } } | undefined;
      return w ? `${w.replyType ?? "any"} · retry ${w.numberOfRetries ?? 0} · ${w.expiresIn?.value ?? "?"} ${w.expiresIn?.unit ?? ""}` : null;
    }
    case "delay": {
      const dl = config.delay as { value?: number; unit?: string } | undefined;
      return dl ? `รอ ${dl.value} ${dl.unit}` : null;
    }
    case "randomizer": {
      const rz = config.randomizer as { paths?: unknown[] } | undefined;
      return rz?.paths ? `สุ่ม ${rz.paths.length} เส้นทาง` : null;
    }
    case "set_ticket_field": {
      const st = act?.setTicketField as { value?: unknown } | undefined;
      return st ? `set field: ${trunc(String(st.value ?? ""), 20)}` : null;
    }
    default:
      return null;
  }
}

/** สรุป config สั้นๆ แสดงบน node — zaapi shape ก่อน แล้ว legacy */
export function configSummary(subtype: string, config: Record<string, unknown>): string {
  const z = zaapiSummary(subtype, config);
  if (z != null) return z;
  switch (subtype) {
    case "message_received": {
      const kw = Array.isArray(config.keywords) ? (config.keywords as string[]) : [];
      return kw.length > 0 ? kw.slice(0, 3).join(", ") + (kw.length > 3 ? "…" : "") : "(ไม่มี keyword)";
    }
    case "message_content": {
      if (Array.isArray(config.branches) && (config.branches as { branch_id: string; label?: string; keywords: string[] }[]).length > 0) {
        const branches = config.branches as { branch_id: string; label?: string; keywords: string[] }[];
        const first = branches[0];
        const labelTxt = first.label || first.keywords.slice(0, 2).join(",");
        return `${branches.length} ทาง: ${labelTxt}${branches.length > 1 ? "…" : ""}`;
      }
      const mode = String(config.mode || "contains");
      const modeLabel = mode === "equals" ? "=" : mode === "not_contains" ? "ไม่มี" : "มี";
      return `${modeLabel} "${String(config.text || "")}"`;
    }
    case "conversation_status":
      return `สถานะ: ${String(config.status || "open")}`;
    case "business_hours":
      return `${Number(config.start_hour ?? 9)}:00 - ${Number(config.end_hour ?? 18)}:00`;
    case "new_vs_returning":
      return "ลูกค้าใหม่ / เคยมาก่อน";
    case "assignee":
      return config.admin_id ? `ผู้รับ: ${String(config.admin_id)}` : "มีผู้รับไหม";
    case "send_message": {
      const t = String(config.text || "");
      return t.length > 30 ? t.slice(0, 30) + "…" : t || "(ว่าง)";
    }
    case "let_ai_respond":
      return config.prompt ? `prompt: ${String(config.prompt).slice(0, 25)}…` : "เรียกบอทตอบ";
    case "assign_ticket":
      return config.admin_id ? `→ ${String(config.admin_id)}` : "auto (คนเดิม/round-robin)";
    case "add_label": {
      if (Array.isArray(config.label_ids) && (config.label_ids as string[]).length > 0) {
        const ids = config.label_ids as string[];
        return ids.length <= 2 ? ids.join(", ") : `${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
      }
      return `label: ${String(config.label || "")}`;
    }
    case "close_ticket":
      return "ปิดแชท";
    case "unassign_ticket":
      return "ยกเลิกมอบหมาย";
    case "add_note": {
      const t = String(config.text || "");
      return t.length > 30 ? t.slice(0, 30) + "…" : t;
    }
    case "send_http":
      return String(config.url || "").slice(0, 35);
    case "jump_to":
      return `→ ${String(config.target_node_id || "?")}`;
    case "wait_for_reply": {
      if (typeof config.answer_type === "string") {
        const retries = Number(config.max_retries ?? 0);
        const timeoutMs = Number(config.timeout_ms ?? 0);
        const timeoutLabel = timeoutMs >= 3600000 ? `${Math.floor(timeoutMs / 3600000)} ชม` : timeoutMs >= 60000 ? `${Math.floor(timeoutMs / 60000)} นาที` : `${Math.floor(timeoutMs / 1000)}s`;
        return `${config.answer_type} · retry ${retries} · รอ ${timeoutLabel}`;
      }
      return config.timeout_ms ? `รอ ≤ ${Math.floor(Number(config.timeout_ms) / 1000)}s` : "รอข้อความถัดไป";
    }
    default:
      return "";
  }
}

// ─── Output handles — registry resolver (owner เดียวกับ edges) ──
// default → render id "out" (convention ของ canvas edges: branch null → "out")
interface CardHandle { id: string; label: string; color: string }

function branchStyle(id: string): { label: string; color: string } {
  if (id === "out" || id === "default") return { label: "ต่อไป", color: "#64748b" };
  switch (id) {
    case "no-match": return { label: "ไม่ตรง", color: "#ef4444" };
    case "ai-chatbot-escalate": return { label: "ยกให้เจ้าหน้าที่", color: "#f59e0b" };
    case "ai-chatbot-timeout": return { label: "หมดเวลา AI", color: "#ef4444" };
    case "wfr-success": return { label: "ตอบสำเร็จ", color: "#10b981" };
    case "wfr-no-respond": return { label: "ไม่ตอบกลับ", color: "#ef4444" };
    case "btn-template-expired": return { label: "ปุ่มหมดอายุ", color: "#ef4444" };
    case "btn-template-none-selected": return { label: "ไม่เลือก", color: "#ef4444" };
    case "success": return { label: "ตอบถูก", color: "#10b981" };
    case "retry_exceeded": return { label: "ทำผิดซ้ำ", color: "#f59e0b" };
    case "no_reply": return { label: "ไม่ตอบ", color: "#ef4444" };
    case "true": return { label: "true", color: "#10b981" };
    case "false": return { label: "false", color: "#ef4444" };
    default: return { label: "", color: "#64748b" };
  }
}

export function resolveCardHandles(subtype: string, config: Record<string, unknown>, used?: string[]): CardHandle[] {
  const def = getNodeDef(subtype);
  let outs = def ? resolveOutputHandles(def, config) : [{ id: "default" }];
  // "no-match" เป็น zaapi vocab — legacy binary (true/false) / local multi-branch (fallback_branch_id)
  // มี fallback path ของตัวเองแล้ว → ไม่ render no-match handle เกิน
  if (!Array.isArray(config.conditions)) outs = outs.filter((h) => h.id !== "no-match");
  const resolved = outs.map((h): CardHandle => {
    const id = h.id === "default" ? "out" : h.id;
    const base = branchStyle(id);
    const ci = id.match(/^condition-index-(\d+)$/);
    if (ci) {
      const i = Number(ci[1]);
      const hint = Array.isArray(config.conditions)
        ? condText((config.conditions as Record<string, unknown>[])[i] || {})
        : "";
      return { id, label: trunc(hint, 14) || `เงื่อนไข ${i + 1}`, color: "#10b981" };
    }
    const bi = id.match(/^btn-template-condition-index-(\d+)$/);
    if (bi) return { id, label: `ปุ่ม ${Number(bi[1]) + 1}`, color: "#10b981" };
    const ri = id.match(/^randomizer-path-(\d+)$/);
    if (ri) return { id, label: `สุ่ม ${Number(ri[1]) + 1}`, color: "#8b5cf6" };
    if (base.label) return { id, ...base };
    // local multi-branch → label ของ branch_id นั้น; fallback branch = "ไม่ตรง" แดง
    if (id === config.fallback_branch_id) return { id, label: "ไม่ตรง", color: "#ef4444" };
    if (Array.isArray(config.branches)) {
      const b = (config.branches as { branch_id?: string; label?: string }[]).find((x) => x.branch_id === id);
      if (b) return { id, label: trunc(b.label || id, 14), color: "#10b981" };
    }
    return { id, label: id.length > 14 ? id.slice(0, 14) : id, color: base.color };
  });
  // edge เดิมที่ใช้ handle นอก resolved set (เช่น local let_ai_respond → "out") — render ต่อไม่งั้นเส้นลอย
  const seen = new Set(resolved.map((h) => h.id));
  for (const u of used || []) {
    const id = u === "default" ? "out" : u;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = branchStyle(id);
    resolved.push({ id, color: b.color, label: b.label || id });
  }
  return resolved;
}

// ─── shared bits ──────────────────────────────────────────

interface NodeData {
  subtype?: string;
  config?: Record<string, unknown>;
  selected?: boolean;
  imported?: boolean;
  importMeta?: { source?: string };
  usedHandles?: string[];   // sourceHandle ids ที่ edges ใช้จริง — editor inject
}

function isZaapi(d: NodeData): boolean {
  return d.imported === true || d.importMeta?.source === "zaapi";
}

/** sync xyflow internals เมื่อ handle ids เปลี่ยน — shared ทุก node type */
function useSyncHandles(nodeId: string, key: string) {
  const update = useUpdateNodeInternals();
  const prev = useRef<string>("");
  useEffect(() => {
    if (prev.current !== key) {
      prev.current = key;
      update(nodeId);
    }
  }, [key, nodeId, update]);
}

/** out handles — output เดียว: dot ล่างกลาง · หลาย branch: แถวแนวตั้งด้านขวา (label + handle ออกขวา) */
function OutHandles({ nodeId, handles }: { nodeId: string; handles: CardHandle[] }) {
  useSyncHandles(nodeId, handles.map((h) => h.id).join("|"));
  const n = handles.length;
  if (n === 0) return null;
  if (n === 1) {
    return (
      <>
        <Handle
          type="source"
          position={Position.Bottom}
          id={handles[0].id}
          style={{ background: handles[0].color, width: 8, height: 8 }}
        />
        <div style={{ fontSize: 9.5, color: handles[0].color, textAlign: "center", padding: "0 10px 5px" }}>
          {handles[0].label} ↓
        </div>
      </>
    );
  }
  return (
    <div style={{ borderTop: "1px solid #f1f5f9" }}>
      {handles.map((h) => (
        <div
          key={h.id}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 6,
            padding: "5px 14px 5px 10px",
            borderTop: "1px solid #f8fafc",
            fontSize: 10.5,
          }}
        >
          <span
            style={{
              color: h.color, fontWeight: 600,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {h.label}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={h.id}
            style={{
              position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)",
              background: h.color, width: 9, height: 9,
              border: "2px solid #ffffff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** card shell — type-tinted header + node name + subtype + zaapi badge + selected ring */
function NodeShell({
  meta, subLabel, name, imported, selected, children,
}: {
  meta: (typeof NODE_TYPE_META)[FlowNodeType];
  subLabel: string;
  name: string;
  imported: boolean;
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: `1.5px solid ${selected ? meta.color : meta.border}`,
        borderRadius: 10,
        minWidth: 190,
        maxWidth: 250,
        overflow: "hidden",
        boxShadow: selected
          ? `0 0 0 3px ${meta.color}33, 0 3px 10px rgba(0,0,0,0.12)`
          : "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div
        style={{
          background: `${meta.color}14`,
          padding: "7px 10px",
          display: "flex",
          alignItems: "center",
          gap: 7,
          borderBottom: `1px solid ${meta.color}26`,
        }}
      >
        <span style={{ color: meta.color, display: "inline-flex", flexShrink: 0 }}>{meta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12, fontWeight: 700, color: "#1f2937", lineHeight: 1.25,
              overflow: "hidden", textOverflow: "ellipsis",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            }}
            title={name}
          >
            {name}
          </div>
          <div
            style={{
              fontSize: 9.5, color: meta.color, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.3,
            }}
          >
            {meta.label} · {subLabel}
          </div>
        </div>
        {imported && (
          <span
            style={{
              fontSize: 9, fontWeight: 700, color: "#0369a1",
              background: "#e0f2fe", borderRadius: 4, padding: "1px 5px", flexShrink: 0,
            }}
          >
            zaapi
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── node components ──────────────────────────────────────

export function TriggerNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = NODE_TYPE_META.trigger;
  const sub = subtypeMeta(d.subtype || "message_received");
  const name = String(d.config?.label || sub.label);
  const handles = resolveCardHandles(d.subtype || "message_received", d.config || {}, d.usedHandles);
  return (
    <NodeShell meta={meta} subLabel={sub.label} name={name} imported={isZaapi(d)} selected={!!(selected || d.selected)}>
      <div style={{ padding: "7px 10px", fontSize: 11, color: "#64748b", whiteSpace: "pre-wrap" }}>
        {configSummary(d.subtype || "message_received", d.config || {})}
      </div>
      <OutHandles nodeId={id} handles={handles} />
    </NodeShell>
  );
}

export function ConditionNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = NODE_TYPE_META.condition;
  const sub = subtypeMeta(d.subtype || "message_content");
  const name = String(d.config?.label || sub.label);
  const cfg = d.config || {};
  const handles = resolveCardHandles(d.subtype || "message_content", cfg, d.usedHandles);
  return (
    <NodeShell meta={meta} subLabel={sub.label} name={name} imported={isZaapi(d)} selected={!!(selected || d.selected)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div style={{ padding: "7px 10px", fontSize: 11, color: "#64748b" }}>
        {configSummary(d.subtype || "message_content", cfg)}
      </div>
      <OutHandles nodeId={id} handles={handles} />
    </NodeShell>
  );
}

export function ActionNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = NODE_TYPE_META.action;
  const sub = subtypeMeta(d.subtype || "send_message");
  const name = String(d.config?.label || sub.label);
  const cfg = d.config || {};
  const handles = resolveCardHandles(d.subtype || "send_message", cfg, d.usedHandles);
  const labelChips: string[] =
    d.subtype === "add_label" && Array.isArray(cfg.label_ids)
      ? (cfg.label_ids as string[]).filter(Boolean)
      : [];
  return (
    <NodeShell meta={meta} subLabel={sub.label} name={name} imported={isZaapi(d)} selected={!!(selected || d.selected)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div style={{ padding: "7px 10px", fontSize: 11, color: "#64748b", whiteSpace: "pre-wrap" }}>
        {configSummary(d.subtype || "send_message", cfg)}
      </div>
      {labelChips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 10px 6px" }}>
          {labelChips.slice(0, 4).map((l) => (
            <span
              key={l}
              style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 4,
                background: "rgba(16,185,129,0.08)", color: "#059669",
                border: "1px solid rgba(16,185,129,0.2)",
              }}
            >
              {l}
            </span>
          ))}
          {labelChips.length > 4 && (
            <span style={{ fontSize: 10, color: "#64748b" }}>+{labelChips.length - 4}</span>
          )}
        </div>
      )}
      <OutHandles nodeId={id} handles={handles} />
    </NodeShell>
  );
}

export function WaitNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = NODE_TYPE_META.wait;
  const sub = subtypeMeta(d.subtype || "wait_for_reply");
  const name = String(d.config?.label || sub.label);
  const handles = resolveCardHandles(d.subtype || "wait_for_reply", d.config || {}, d.usedHandles);
  return (
    <NodeShell meta={meta} subLabel={sub.label} name={name} imported={isZaapi(d)} selected={!!(selected || d.selected)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div style={{ padding: "7px 10px", fontSize: 11, color: "#64748b" }}>
        {configSummary(d.subtype || "wait_for_reply", d.config || {})}
      </div>
      <OutHandles nodeId={id} handles={handles} />
    </NodeShell>
  );
}

export const nodeTypes = {
  wf_trigger: TriggerNode,
  wf_condition: ConditionNode,
  wf_action: ActionNode,
  wf_wait: WaitNode,
};

/** type ของ workflow node → xyflow node type */
export function toXYFlowType(type: FlowNodeType): string {
  return `wf_${type}`;
}

/** xyflow node type → type ของ workflow node */
export function fromXYFlowType(xyType: string): FlowNodeType {
  return (xyType.replace("wf_", "") as FlowNodeType);
}
