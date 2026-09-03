// Custom React Flow nodes สำหรับ Workflow Editor (แบบ Zaapi Flow Builder)
// แต่ละ type มีสี + ไอคอน + สรุป config ให้เห็นเร็วๆ บน canvas
"use client";
import { useEffect, useRef } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Zap, GitBranch, Play, Clock, MessageSquare, Bot, UserPlus, Tag, XCircle, StickyNote, Globe, Repeat, LogIn, LogOut, MessageCircleQuestion } from "lucide-react";

export type FlowNodeType = "trigger" | "condition" | "action" | "wait";

export const NODE_TYPE_META: Record<
  FlowNodeType,
  { label: string; color: string; bg: string; border: string; icon: React.ReactNode }
> = {
  trigger: { label: "Trigger", color: "#d97706", bg: "#ffffff", border: "#e5e7eb", icon: <Zap size={13} /> },
  condition: { label: "Condition", color: "#7c3aed", bg: "#ffffff", border: "#e5e7eb", icon: <GitBranch size={13} /> },
  action: { label: "Action", color: "#059669", bg: "#ffffff", border: "#e5e7eb", icon: <Play size={13} /> },
  wait: { label: "Wait", color: "#4f46e5", bg: "#ffffff", border: "#e5e7eb", icon: <Clock size={13} /> },
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
};

/** สรุป config สั้นๆ แสดงบน node */
function configSummary(subtype: string, config: Record<string, unknown>): string {
  switch (subtype) {
    case "message_received": {
      const kw = Array.isArray(config.keywords) ? (config.keywords as string[]) : [];
      return kw.length > 0 ? kw.slice(0, 3).join(", ") + (kw.length > 3 ? "…" : "") : "(ไม่มี keyword)";
    }
    case "message_content": {
      // ⚡ multi-branch: แสดงจำนวน branch + label แรก
      if (Array.isArray(config.branches) && (config.branches as { branch_id: string; label?: string; keywords: string[] }[]).length > 0) {
        const branches = config.branches as { branch_id: string; label?: string; keywords: string[] }[];
        const first = branches[0];
        const labelTxt = first.label || first.keywords.slice(0, 2).join(",");
        return `${branches.length} ทาง: ${labelTxt}${branches.length > 1 ? "…" : ""}`;
      }
      // legacy binary
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
      // ⚡ Phase 3: ถ้ามี label_ids → แสดงเป็น list, legacy → แสดง text เดียว
      if (Array.isArray(config.label_ids) && (config.label_ids as string[]).length > 0) {
        const ids = config.label_ids as string[];
        return ids.length <= 2 ? ids.join(", ") : `${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
      }
      return `label: ${String(config.label || "")}`;
    }
    case "close_ticket":
      return "ปิดแชท";
    case "add_note": {
      const t = String(config.text || "");
      return t.length > 30 ? t.slice(0, 30) + "…" : t;
    }
    case "send_http":
      return String(config.url || "").slice(0, 35);
    case "jump_to":
      return `→ ${String(config.target_node_id || "?")}`;
    case "wait_for_reply": {
      // ⚡ Phase 2: ถ้ามี answer_type → แสดง retry + timeout
      if (typeof config.answer_type === "string") {
        const retries = Number(config.max_retries ?? 0);
        const timeoutMs = Number(config.timeout_ms ?? 0);
        const timeoutLabel = timeoutMs >= 3600000 ? `${Math.floor(timeoutMs / 3600000)} ชม` : timeoutMs >= 60000 ? `${Math.floor(timeoutMs / 60000)} นาที` : `${Math.floor(timeoutMs / 1000)}s`;
        return `${config.answer_type} · retry ${retries} · รอ ${timeoutLabel}`;
      }
      // legacy
      return config.timeout_ms ? `รอ ≤ ${Math.floor(Number(config.timeout_ms) / 1000)}s` : "รอข้อความถัดไป";
    }
    default:
      return "";
  }
}

// ─── Trigger node (จุดเริ่ม — มีแค่ output handle) ──
// ⚡ Phase 5: header สี + icon + label ข้าง handle
export function TriggerNode({ data }: NodeProps) {
  const d = data as { subtype?: string; config?: Record<string, unknown> };
  const meta = NODE_TYPE_META.trigger;
  const sub = SUBTYPE_META[d.subtype || "message_received"] || { label: d.subtype || "", icon: null };
  return (
    <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 8, padding: 0, minWidth: 180, maxWidth: 240, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
      {/* header — minimal: พื้นขาว + สีเป็น accent */}
      <div style={{ color: meta.color, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${meta.border}` }}>
        {meta.icon} {sub.label}
      </div>
      {/* body — config summary */}
      <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim, #888)", whiteSpace: "pre-wrap" }}>
        {configSummary(d.subtype || "message_received", d.config || {})}
      </div>
      <Handle type="source" position={Position.Bottom} id="out" />
      {/* label ข้าง handle */}
      <div style={{ fontSize: 10, textAlign: "center", padding: "2px 0 4px", color: meta.color }}>
        เริ่ม flow ↓
      </div>
    </div>
  );
}

// ─── Condition node ──
// ⚡ Phase 1: dynamic handles ตาม branches
//   - multi-branch message_content: render Handle ตาม branches.length + 1 (fallback)
//   - legacy binary (mode/text หรือ subtype อื่น): 2 handle true/false เหมือนเดิม
export function ConditionNode({ id, data }: NodeProps) {
  const d = data as { subtype?: string; config?: Record<string, unknown> };
  const meta = NODE_TYPE_META.condition;
  const sub = SUBTYPE_META[d.subtype || "message_content"] || { label: d.subtype || "", icon: null };
  const updateNodeInternals = useUpdateNodeInternals();
  const prevBranchKey = useRef<string>("");

  const cfg = d.config || {};
  const isMultiBranch = d.subtype === "message_content"
    && Array.isArray(cfg.branches)
    && typeof cfg.fallback_branch_id === "string";

  // สร้าง list ของ handles ที่จะ render
  // multi-branch: [{ id: b1, label }, { id: b2, label }, ..., { id: fallback, label: "ไม่ตรง" }]
  // legacy: [{ id: "true", label: "true" }, { id: "false", label: "false" }]
  const handles: { id: string; label: string; color: string }[] = isMultiBranch
    ? [
        ...(cfg.branches as { branch_id: string; label?: string; keywords: string[] }[]).map((b) => ({
          id: b.branch_id,
          label: b.label || b.keywords.slice(0, 2).join(",") || b.branch_id,
          color: "#10b981",
        })),
        { id: cfg.fallback_branch_id as string, label: "ไม่ตรง", color: "#ef4444" },
      ]
    : [
        { id: "true", label: "true", color: "#10b981" },
        { id: "false", label: "false", color: "#ef4444" },
      ];

  // ⚡ เรียก updateNodeInternals เมื่อจำนวน/ลำดับ handle เปลี่ยน — ให้ xyflow รู้ว่า handle มีใหม่
  const branchKey = handles.map((h) => h.id).join("|");
  useEffect(() => {
    if (prevBranchKey.current !== branchKey) {
      prevBranchKey.current = branchKey;
      updateNodeInternals(id);
    }
  }, [branchKey, id, updateNodeInternals]);

  // คำนวณตำแหน่ง handle กระจายตามจำนวน
  const handleCount = handles.length;
  const handlePosition = (idx: number) => {
    if (handleCount === 1) return 50;
    return ((idx + 1) / (handleCount + 1)) * 100;
  };

  return (
    <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 8, padding: 0, minWidth: 180, maxWidth: 260, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
      <Handle type="target" position={Position.Top} id="in" />
      {/* header — minimal */}
      <div style={{ color: meta.color, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${meta.border}` }}>
        {meta.icon} {sub.label}
      </div>
      {/* body — config summary */}
      <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim, #888)" }}>
        {configSummary(d.subtype || "message_content", d.config || {})}
      </div>
      {/* ⚡ dynamic output handles — กระจายตามจำนวน branch */}
      {handles.map((h) => (
        <Handle
          key={h.id}
          type="source"
          position={Position.Bottom}
          id={h.id}
          style={{ left: `${handlePosition(handles.indexOf(h))}%`, background: h.color, width: 6, height: 6 }}
        />
      ))}
      {/* label ข้าง handle แต่ละอัน */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 2, padding: `0 ${handleCount > 2 ? "5%" : "12%"}` }}>
        {handles.map((h) => (
          <span key={h.id} style={{ color: h.color, flex: 1, textAlign: "center" }}>{h.label} ↓</span>
        ))}
      </div>
    </div>
  );
}

// ─── Action node (input + output) ──
// ⚡ Phase 3: ถ้า subtype=add_label และมี label_ids → แสดง chip ใต้ header
export function ActionNode({ data }: NodeProps) {
  const d = data as { subtype?: string; config?: Record<string, unknown> };
  const meta = NODE_TYPE_META.action;
  const sub = SUBTYPE_META[d.subtype || "send_message"] || { label: d.subtype || "", icon: null };

  // ⚡ chip สำหรับ add_label Phase 3
  const labelChips: string[] = (d.subtype === "add_label" && Array.isArray(d.config?.label_ids))
    ? (d.config!.label_ids as string[]).filter(Boolean)
    : [];

  return (
    <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 8, padding: 0, minWidth: 180, maxWidth: 240, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
      <Handle type="target" position={Position.Top} id="in" />
      {/* header — minimal */}
      <div style={{ color: meta.color, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${meta.border}` }}>
        {meta.icon} {sub.label}
      </div>
      {/* body — config summary */}
      <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim, #888)", whiteSpace: "pre-wrap" }}>
        {configSummary(d.subtype || "send_message", d.config || {})}
      </div>
      {/* ⚡ chip สำหรับ add_label Phase 3 */}
      {labelChips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 10px 6px" }}>
          {labelChips.slice(0, 4).map((l) => (
            <span key={l} style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 4,
              background: "rgba(16,185,129,0.08)", color: "#059669", border: "1px solid rgba(16,185,129,0.2)",
            }}>
              {l}
            </span>
          ))}
          {labelChips.length > 4 && (
            <span style={{ fontSize: 10, color: "var(--text-dim, #888)" }}>+{labelChips.length - 4}</span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="out" />
      {/* label ข้าง handle */}
      <div style={{ fontSize: 10, textAlign: "center", padding: "2px 0 4px", color: meta.color }}>
        ต่อไป ↓
      </div>
    </div>
  );
}

// ─── Wait node ──
// ⚡ Phase 2: ถ้ามี answer_type → 3 output handles (success/retry_exceeded/no_reply)
//   ถ้า legacy → 1 handle (out) เหมือนเดิม
export function WaitNode({ id, data }: NodeProps) {
  const d = data as { subtype?: string; config?: Record<string, unknown> };
  const meta = NODE_TYPE_META.wait;
  const sub = SUBTYPE_META[d.subtype || "wait_for_reply"] || { label: d.subtype || "", icon: null };
  const updateNodeInternals = useUpdateNodeInternals();
  const prevMode = useRef<string>("");

  const cfg = d.config || {};
  const isPhase2 = typeof cfg.answer_type === "string";

  // handles ที่จะ render
  // Phase 2: 3 handles (success/retry_exceeded/no_reply)
  // legacy: 1 handle (out)
  const handles: { id: string; label: string; color: string }[] = isPhase2
    ? [
        { id: "success", label: "ตอบถูก", color: "#10b981" },
        { id: "retry_exceeded", label: "ทำผิดซ้ำ", color: "#f59e0b" },
        { id: "no_reply", label: "ไม่ตอบ", color: "#ef4444" },
      ]
    : [{ id: "out", label: "ต่อไป", color: meta.color }];

  // ⚡ เรียก updateNodeInternals เมื่อ mode เปลี่ยน (legacy ↔ Phase 2)
  const modeKey = isPhase2 ? "phase2" : "legacy";
  useEffect(() => {
    if (prevMode.current !== modeKey) {
      prevMode.current = modeKey;
      updateNodeInternals(id);
    }
  }, [modeKey, id, updateNodeInternals]);

  // คำนวณตำแหน่ง handle กระจายตามจำนวน
  const handleCount = handles.length;
  const handlePosition = (idx: number) => {
    if (handleCount === 1) return 50;
    return ((idx + 1) / (handleCount + 1)) * 100;
  };

  return (
    <div style={{ background: meta.bg, border: `1px dashed ${meta.border}`, borderRadius: 8, padding: 0, minWidth: 180, maxWidth: 260, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
      <Handle type="target" position={Position.Top} id="in" />
      {/* header — minimal */}
      <div style={{ color: meta.color, padding: "6px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${meta.border}` }}>
        {meta.icon} {sub.label}
      </div>
      {/* body — config summary */}
      <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim, #888)" }}>
        {configSummary(d.subtype || "wait_for_reply", d.config || {})}
      </div>
      {/* ⚡ dynamic output handles */}
      {handles.map((h, idx) => (
        <Handle
          key={h.id}
          type="source"
          position={Position.Bottom}
          id={h.id}
          style={{ left: `${handlePosition(idx)}%`, background: h.color, width: 6, height: 6 }}
        />
      ))}
      {/* label ข้าง handle แต่ละอัน */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 2, padding: `0 ${handleCount > 1 ? "5%" : "12%"}` }}>
        {handles.map((h) => (
          <span key={h.id} style={{ color: h.color, flex: 1, textAlign: "center" }}>{h.label} ↓</span>
        ))}
      </div>
    </div>
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
