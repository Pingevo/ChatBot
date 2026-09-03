// Workflow Editor — canvas builder แบบ Zaapi Flow Builder (ใช้ @xyflow/react)
// โครงสร้าง: palette ซ้าย (เพิ่ม node) / canvas กลาง (ลาก + เชื่อม edge) / panel ขวา (แก้ config + flow settings)
// Save → POST /api/workflows (ใหม่) หรือ PATCH /api/workflows/[id] (แก้)
"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import React from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState, MarkerType,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { nodeTypes, toXYFlowType, NODE_TYPE_META, SUBTYPE_META, type FlowNodeType } from "./nodes";

// ─── Types ────────────────────────────────────────────────

interface WFNodeData extends Record<string, unknown> {
  subtype: string;
  config: Record<string, unknown>;
}

interface FlowSettings {
  name: string;
  description: string;
  shop_ids: string[];
  platforms: string[];
  trigger_frequency: "once_per_customer" | "once_per_conversation" | "every_time";
  false_branch_policy: "exit_to_bot" | "exit_drop" | "stay_retry";
  priority: number;
  enabled: boolean;
  status: "draft" | "published";
}

interface WorkflowDocDTO {
  workflow_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  shop_ids: string[];
  platforms: string[];
  trigger_frequency: string;
  false_branch_policy: string;
  nodes: { node_id: string; type: string; subtype: string; config: Record<string, unknown>; position: { x: number; y: number } }[];
  edges: { edge_id: string; source_node_id: string; target_node_id: string; branch?: string }[];
  priority: number;
  status: string;
}

interface ShopOption {
  shop_id: string;
  shopname: string;
  platform: string;
}

const defaultSettings: FlowSettings = {
  name: "",
  description: "",
  shop_ids: [],
  platforms: [],
  trigger_frequency: "every_time",
  false_branch_policy: "exit_to_bot",
  priority: 0,
  enabled: false,
  status: "draft",
};

// palette: type → subtypes ที่มี
const PALETTE: { type: FlowNodeType; subtypes: string[] }[] = [
  { type: "trigger", subtypes: ["message_received"] },
  {
    type: "condition",
    subtypes: ["message_content", "conversation_status", "business_hours", "new_vs_returning", "assignee"],
  },
  {
    type: "action",
    subtypes: ["send_message", "let_ai_respond", "assign_ticket", "add_label", "close_ticket", "add_note", "send_http", "jump_to"],
  },
  { type: "wait", subtypes: ["wait_for_reply"] },
];

let idCounter = 1;
function genNodeId(): string {
  return "n" + Date.now().toString(36) + (idCounter++);
}

// ─── Inner editor (ต้องอยู่ใน ReactFlowProvider) ──

function EditorInner({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const isNew = workflowId === "new";

  const [settings, setSettings] = useState<FlowSettings>(defaultSettings);
  const [wfVersion, setWfVersion] = useState(0); // track ว่า save แล้ว
  const [loaded, setLoaded] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // ⚡ ร้านทั้งหมด (สำหรับเลือกว่า flow นี้เป็นของร้านไหน — 1 ร้านมีได้หลาย flow, ไม่เลือก = ใช้ร่วมทุกร้าน)
  const [shops, setShops] = useState<ShopOption[]>([]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WFNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodeCounterRef = useRef(0);

  // โหลด workflow เดิม + ร้านทั้งหมด (สำหรับ checkbox เลือกร้าน)
  useEffect(() => {
    // ⚡ โหลดร้าน (ใช้ทั้ง flow ใหม่และแก้ของเดิม)
    // dedupe by shop_id — /api/shops ส่งกลับ shop เดียวหลายบรรทัด (หนึ่งบรรทัดต่อ platform)
    fetch("/api/shops")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        const rows: ShopOption[] = d.rows || [];
        const map = new Map<string, ShopOption>();
        for (const s of rows) {
          if (!map.has(s.shop_id)) map.set(s.shop_id, s);
        }
        setShops(Array.from(map.values()));
      })
      .catch(() => setShops([]));

    if (isNew) return;
    (async () => {
      try {
        const r = await fetch(`/api/workflows/${workflowId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const wf: WorkflowDocDTO = d.workflow;
        setSettings({
          name: wf.name,
          description: wf.description || "",
          shop_ids: wf.shop_ids || [],
          platforms: wf.platforms || [],
          trigger_frequency: (wf.trigger_frequency as FlowSettings["trigger_frequency"]) || "every_time",
          false_branch_policy: (wf.false_branch_policy as FlowSettings["false_branch_policy"]) || "exit_to_bot",
          priority: wf.priority ?? 0,
          enabled: wf.enabled,
          status: (wf.status as FlowSettings["status"]) || "draft",
        });
        setNodes(wf.nodes.map((n) => ({
          id: n.node_id,
          type: toXYFlowType(n.type as FlowNodeType),
          position: n.position,
          data: { subtype: n.subtype, config: n.config || {} },
        })));
        setEdges(wf.edges.map((e) => ({
          id: e.edge_id,
          source: e.source_node_id,
          target: e.target_node_id,
          // ⚡ sourceHandle = branch จริง (multi-branch ใช้ branch_id เป็น handle id)
          //   ถ้าไม่มี branch → "out" (edge ปกติ)
          sourceHandle: e.branch || "out",
          // ให้ false branch เห็นเป็นสีแดง / true เขียว (legacy)
          ...(e.branch === "false" ? { style: { stroke: "#cbd5e1" }, label: "false" } :
              e.branch === "true" ? { style: { stroke: "#94a3b8" }, label: "true" } : {}),
          markerEnd: { type: MarkerType.ArrowClosed },
        })));
        nodeCounterRef.current = wf.nodes.length;
        setWfVersion(1);
      } catch (err) {
        toast.error(`โหลด workflow ไม่ได้: ${(err as Error).message}`);
      } finally {
        setLoaded(true);
      }
    })();
  }, [workflowId, isNew, setNodes, setEdges]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  );

  // ── Node CRUD ──
  const addNode = useCallback((type: FlowNodeType, subtype: string) => {
    const id = genNodeId();
    const offset = nodeCounterRef.current * 60;
    nodeCounterRef.current++;
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: toXYFlowType(type),
        position: { x: 120 + offset, y: 100 + offset },
        data: { subtype, config: {} },
      },
    ]);
    setSelectedNodeId(id);
  }, [setNodes]);

  const deleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
    setEdges((prev) => prev.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            markerEnd: { type: MarkerType.ArrowClosed },
            // ให้ edge จาก condition handle true/false มีสีอ่อน + label
            ...(params.sourceHandle === "false"
              ? { style: { stroke: "#cbd5e1" }, label: "false" }
              : params.sourceHandle === "true"
                ? { style: { stroke: "#94a3b8" }, label: "true" }
                : {}),
          },
          eds
        )
      );
    },
    [setEdges]
  );

  // แก้ config ของ node ที่เลือก
  const updateSelectedConfig = useCallback((key: string, value: unknown) => {
    if (!selectedNodeId) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === selectedNodeId
          ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } }
          : n
      )
    );
    setWfVersion((v) => v + 1);
  }, [selectedNodeId, setNodes]);

  const updateSelectedSubtype = useCallback((subtype: string) => {
    if (!selectedNodeId) return;
    setNodes((prev) =>
      prev.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, subtype, config: {} } } : n))
    );
    setWfVersion((v) => v + 1);
  }, [selectedNodeId, setNodes]);

  // ── Save ──
  const save = useCallback(async () => {
    if (!settings.name.trim()) {
      toast.error("ตั้งชื่อ workflow ก่อน");
      return;
    }
    // แปลง xyflow → WorkflowDoc format
    const wfNodes = nodes.map((n) => ({
      node_id: n.id,
      type: (n.type || "wf_action").replace("wf_", ""),
      subtype: String(n.data.subtype || ""),
      config: n.data.config || {},
      position: n.position,
    }));
    const wfEdges = edges.map((e) => {
      // ⚡ sourceHandle เป็น branch_id จริง (multi-branch condition ใช้ branch_id เป็น handle id)
      //   - "out" = edge ปกติ (ไม่ใช่ condition หรือ legacy) → ไม่ใส่ branch
      //   - "true"/"false" = legacy binary condition → ใส่ branch = true/false
      //   - อื่นๆ = multi-branch handle → ใส่ branch = sourceHandle (branch_id จริง)
      const h = e.sourceHandle;
      const branch = (h && h !== "out") ? h : undefined;
      return {
        edge_id: e.id,
        source_node_id: e.source,
        target_node_id: e.target,
        ...(branch ? { branch } : {}),
      };
    });

    setSaving(true);
    try {
      const body = {
        name: settings.name.trim(),
        description: settings.description.trim() || undefined,
        shop_ids: settings.shop_ids,
        platforms: settings.platforms,
        trigger_frequency: settings.trigger_frequency,
        false_branch_policy: settings.false_branch_policy,
        priority: settings.priority,
        enabled: settings.enabled,
        status: settings.status,
        nodes: wfNodes,
        edges: wfEdges,
      };
      const r = await fetch(isNew ? "/api/workflows" : `/api/workflows/${workflowId}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(`Save ไม่ผ่าน: ${d.detail || d.error || d.message || `HTTP ${r.status}`}`);
        return;
      }
      toast.success(isNew ? "สร้าง workflow แล้ว" : "บันทึกแล้ว");
      setWfVersion(0);
      if (isNew && d.workflow?.workflow_id) {
        router.push(`/workflows/${d.workflow.workflow_id}`);
      }
    } catch (err) {
      toast.error(`Save error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [settings, nodes, edges, isNew, workflowId, router]);

  const toggleEnabled = useCallback(async () => {
    if (isNew) {
      setSettings((s) => ({ ...s, enabled: !s.enabled }));
      return;
    }
    try {
      const r = await fetch(`/api/workflows/${workflowId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !settings.enabled }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      }
      setSettings((s) => ({ ...s, enabled: !s.enabled }));
      toast.success(settings.enabled ? "ปิด workflow แล้ว" : "เปิด workflow แล้ว");
    } catch (err) {
      toast.error(`Toggle error: ${(err as Error).message}`);
    }
  }, [isNew, workflowId, settings.enabled]);

  const remove = useCallback(async () => {
    if (isNew) return;
    if (!(await confirm.ask({ title: "ลบ workflow นี้?", message: "การลบเป็น soft delete — เก็บประวัติไว้", variant: "danger" }))) return;
    try {
      const r = await fetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      }
      toast.success("ลบแล้ว (soft delete)");
      router.push("/workflows");
    } catch (err) {
      toast.error(`Delete error: ${(err as Error).message}`);
    }
  }, [isNew, workflowId, router]);

  if (!loaded) {
    return <div style={{ padding: 40, textAlign: "center", opacity: 0.6 }}>กำลังโหลด workflow…</div>;
  }

  const dirty = wfVersion !== 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* ── Top bar: ชื่อ + ปุ่ม ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid var(--border, #333)", flexWrap: "wrap" }}>
        <input
          value={settings.name}
          onChange={(e) => { setSettings((s) => ({ ...s, name: e.target.value })); setWfVersion((v) => v + 1); }}
          placeholder="ชื่อ workflow (เช่น ขายหัวชาร์จ)"
          style={{ fontWeight: 600, fontSize: 15, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border, #333)", background: "transparent", color: "inherit", minWidth: 260 }}
        />
        <select
          value={settings.status}
          onChange={(e) => { setSettings((s) => ({ ...s, status: e.target.value as FlowSettings["status"] })); setWfVersion((v) => v + 1); }}
          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border, #333)", background: "transparent", color: "inherit" }}
        >
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={settings.enabled} onChange={toggleEnabled} />
          เปิดใช้งาน
        </label>
        <div style={{ flex: 1 }} />
        {dirty && <span style={{ fontSize: 12, color: "#f59e0b" }}>● มีการแก้ไขยังไม่ได้บันทึก</span>}
        <Button onClick={save} disabled={saving || !settings.name.trim()}>
          {saving ? "กำลังบันทึก…" : "บันทึก"}
        </Button>
        {!isNew && (
          <Button onClick={remove} variant="outline" style={{ color: "#ef4444" }}>ลบ</Button>
        )}
        <Button onClick={() => router.push("/workflows")} variant="outline">กลับ</Button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ── Palette ซ้าย ── */}
        <div style={{ width: 210, borderRight: "1px solid var(--border, #333)", padding: 14, overflowY: "auto", flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, opacity: 0.7 }}>เพิ่ม Node</div>
          {PALETTE.map((group) => {
            const meta = NODE_TYPE_META[group.type];
            return (
              <div key={group.type} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: meta.color, marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
                  {meta.icon} {meta.label}
                </div>
                {group.subtypes.map((sub) => (
                  <button
                    key={sub}
                    onClick={() => addNode(group.type, sub)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
                      padding: "7px 10px", marginBottom: 4, fontSize: 12,
                      borderRadius: 8, border: `1px solid ${meta.border}`, background: meta.bg, color: "inherit", cursor: "pointer",
                    }}
                  >
                    {SUBTYPE_META[sub]?.icon} {SUBTYPE_META[sub]?.label || sub}
                  </button>
                ))}
              </div>
            );
          })}
          <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8, lineHeight: 1.5 }}>
            ลาก node ได้ • ลากจากจุดล่าง node ไปเชื่อม node ถัดไป • condition มีทางออก true (เขียว) / false (แดง)
          </div>
        </div>

        {/* ── Canvas กลาง ── */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(c: NodeChange<Node<WFNodeData>>[]) => { onNodesChange(c); setWfVersion((v) => (c.some((x) => x.type === "position" || x.type === "remove") ? v + 1 : v)); }}
            onEdgesChange={(c: EdgeChange<Edge>[]) => { onEdgesChange(c); if (c.some((x) => x.type === "remove")) setWfVersion((v) => v + 1); }}
            onConnect={(c) => { onConnect(c); setWfVersion((v) => v + 1); }}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background gap={20} size={1.5} />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>

        {/* ── Panel ขวา: node config + flow settings ── */}
        <div style={{ width: 300, borderLeft: "1px solid var(--border, #333)", padding: 14, overflowY: "auto", flexShrink: 0 }}>
          {selectedNode ? (
            <NodeConfigPanel
              node={selectedNode}
              allNodes={nodes}
              onUpdateConfig={updateSelectedConfig}
              onUpdateSubtype={updateSelectedSubtype}
              onDelete={deleteSelected}
            />
          ) : (
            <FlowSettingsPanel settings={settings} setSettings={(s) => { setSettings(s); setWfVersion((v) => v + 1); }} shops={shops} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Node config panel — dynamic fields ตาม subtype ──

function NodeConfigPanel({
  node, allNodes, onUpdateConfig, onUpdateSubtype, onDelete,
}: {
  node: Node<WFNodeData>;
  allNodes: Node<WFNodeData>[];
  onUpdateConfig: (key: string, value: unknown) => void;
  onUpdateSubtype: (subtype: string) => void;
  onDelete: () => void;
}) {
  const cfg = node.data.config || {};
  const subtype = node.data.subtype;
  const type = (node.type || "").replace("wf_", "") as FlowNodeType;
  const subtypesOfSameType = PALETTE.find((p) => p.type === type)?.subtypes || [];

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border, #333)",
    background: "transparent", color: "inherit", fontSize: 13, boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4, display: "block" };
  const fieldGap: React.CSSProperties = { marginBottom: 12 };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          แก้ Node
        </div>
        <Button onClick={onDelete} variant="outline" style={{ color: "#ef4444", padding: "4px 10px", fontSize: 12 }}>ลบ node</Button>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ชนิด</label>
        <select value={subtype} onChange={(e) => onUpdateSubtype(e.target.value)} style={inputStyle}>
          {subtypesOfSameType.map((s) => (
            <option key={s} value={s}>{SUBTYPE_META[s]?.label || s}</option>
          ))}
        </select>
      </div>

      {subtype === "message_received" && (
        <div style={fieldGap}>
          <label style={labelStyle}>Keywords (คั่นด้วย , ทักได้หลายคำ)</label>
          <input
            style={inputStyle}
            value={Array.isArray(cfg.keywords) ? (cfg.keywords as string[]).join(", ") : ""}
            onChange={(e) => onUpdateConfig("keywords", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder="สเปค, หัวชาร์จ, ราคา"
          />
        </div>
      )}

      {subtype === "message_content" && (
        <MessageContentConfigPanel cfg={cfg} onUpdateConfig={onUpdateConfig} inputStyle={inputStyle} labelStyle={labelStyle} fieldGap={fieldGap} />
      )}

      {subtype === "conversation_status" && (
        <div style={fieldGap}>
          <label style={labelStyle}>สถานะที่ต้องการ</label>
          <select value={String(cfg.status || "open")} onChange={(e) => onUpdateConfig("status", e.target.value)} style={inputStyle}>
            <option value="open">เปิดอยู่</option>
            <option value="closed">ปิดแล้ว</option>
          </select>
        </div>
      )}

      {subtype === "business_hours" && (
        <>
          <div style={fieldGap}>
            <label style={labelStyle}>เวลาเปิด (ชั่วโมง 0-23)</label>
            <input type="number" min={0} max={23} style={inputStyle} value={Number(cfg.start_hour ?? 9)} onChange={(e) => onUpdateConfig("start_hour", Number(e.target.value))} />
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>เวลาปิด (ชั่วโมง 0-23)</label>
            <input type="number" min={0} max={23} style={inputStyle} value={Number(cfg.end_hour ?? 18)} onChange={(e) => onUpdateConfig("end_hour", Number(e.target.value))} />
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>Timezone</label>
            <input style={inputStyle} value={String(cfg.timezone || "Asia/Bangkok")} onChange={(e) => onUpdateConfig("timezone", e.target.value)} />
          </div>
        </>
      )}

      {subtype === "assignee" && (
        <div style={fieldGap}>
          <label style={labelStyle}>Admin ID (ว่าง = เช็คว่ามีผู้รับไหม)</label>
          <input style={inputStyle} value={String(cfg.admin_id || "")} onChange={(e) => onUpdateConfig("admin_id", e.target.value)} placeholder="เช่น adm_xxx" />
        </div>
      )}

      {subtype === "send_message" && (
        <SendMessageConfigPanel cfg={cfg} onUpdateConfig={onUpdateConfig} inputStyle={inputStyle} labelStyle={labelStyle} fieldGap={fieldGap} />
      )}

      {subtype === "let_ai_respond" && (
        <div style={fieldGap}>
          <label style={labelStyle}>Prompt เสริม (ว่าง = ส่งข้อความลูกค้าตรงๆ)</label>
          <textarea style={{ ...inputStyle, minHeight: 60 }} value={String(cfg.prompt || "")} onChange={(e) => onUpdateConfig("prompt", e.target.value)} placeholder="ตอบเรื่องสเปคหัวชาร์จ" />
        </div>
      )}

      {subtype === "assign_ticket" && (
        <>
          <div style={fieldGap}>
            <label style={labelStyle}>Admin ID (ว่าง = auto คนเดิม/round-robin)</label>
            <input style={inputStyle} value={String(cfg.admin_id || "")} onChange={(e) => onUpdateConfig("admin_id", e.target.value)} />
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>เหตุผล</label>
            <input style={inputStyle} value={String(cfg.reason || "")} onChange={(e) => onUpdateConfig("reason", e.target.value)} placeholder="ลูกค้าสนใจสั่งซื้อ" />
          </div>
        </>
      )}

      {subtype === "add_label" && (
        <AddLabelConfigPanel cfg={cfg} onUpdateConfig={onUpdateConfig} inputStyle={inputStyle} labelStyle={labelStyle} fieldGap={fieldGap} />
      )}

      {subtype === "close_ticket" && (
        <>
          <div style={fieldGap}>
            <label style={labelStyle}>หมวด</label>
            <select value={String(cfg.category || "other")} onChange={(e) => onUpdateConfig("category", e.target.value)} style={inputStyle}>
              <option value="product">สินค้า</option>
              <option value="shipping">การจัดส่ง</option>
              <option value="payment">การชำระเงิน</option>
              <option value="return_refund">คืนสินค้า/คืนเงิน</option>
              <option value="warranty">รับประกัน</option>
              <option value="account">บัญชี</option>
              <option value="promotion">โปรโมชั่น</option>
              <option value="other">อื่นๆ</option>
            </select>
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>เหตุผล</label>
            <input style={inputStyle} value={String(cfg.reason || "")} onChange={(e) => onUpdateConfig("reason", e.target.value)} />
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>การแก้ปัญหา</label>
            <input style={inputStyle} value={String(cfg.resolution || "")} onChange={(e) => onUpdateConfig("resolution", e.target.value)} />
          </div>
        </>
      )}

      {subtype === "add_note" && (
        <div style={fieldGap}>
          <label style={labelStyle}>Note</label>
          <textarea style={{ ...inputStyle, minHeight: 60 }} value={String(cfg.text || "")} onChange={(e) => onUpdateConfig("text", e.target.value)} />
        </div>
      )}

      {subtype === "send_http" && (
        <>
          <div style={fieldGap}>
            <label style={labelStyle}>URL (ต้องผ่าน SSRF guard)</label>
            <input style={inputStyle} value={String(cfg.url || "")} onChange={(e) => onUpdateConfig("url", e.target.value)} placeholder="https://…" />
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>Method</label>
            <select value={String(cfg.method || "POST")} onChange={(e) => onUpdateConfig("method", e.target.value)} style={inputStyle}>
              <option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
            </select>
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>Body (JSON)</label>
            <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: "monospace" }} value={typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body ?? {})} onChange={(e) => { try { onUpdateConfig("body", JSON.parse(e.target.value)); } catch { /* พิมพ์ JSON ยังไม่ครบ — เก็บเป็น string ไว้ก่อน */ onUpdateConfig("body", e.target.value); } }} />
          </div>
        </>
      )}

      {subtype === "jump_to" && (
        <>
          <div style={fieldGap}>
            <label style={labelStyle}>กระโดดไป node</label>
            <select value={String(cfg.target_node_id || "")} onChange={(e) => onUpdateConfig("target_node_id", e.target.value)} style={inputStyle}>
              <option value="">— เลือก node —</option>
              {allNodes.filter((n) => n.id !== node.id).map((n) => (
                <option key={n.id} value={n.id}>
                  {SUBTYPE_META[String(n.data.subtype)]?.label || n.data.subtype} ({n.id})
                </option>
              ))}
            </select>
          </div>
          <div style={fieldGap}>
            <label style={labelStyle}>จำนวนวนสูงสุด (กันลูปไม่รู้จบ)</label>
            <input type="number" min={1} max={10} style={inputStyle} value={Number(cfg.max_jumps ?? 3)} onChange={(e) => onUpdateConfig("max_jumps", Number(e.target.value))} />
          </div>
        </>
      )}

      {subtype === "wait_for_reply" && (
        <WaitForReplyConfigPanel cfg={cfg} onUpdateConfig={onUpdateConfig} inputStyle={inputStyle} labelStyle={labelStyle} fieldGap={fieldGap} />
      )}

      {subtype === "new_vs_returning" && (
        <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
          เช็คจาก customers.last_active_at — true = ลูกค้าใหม่ (ไม่เคยทักมาก่อน) / false = เคยมาก่อน
        </div>
      )}
    </div>
  );
}

// ─── Message Content Config Panel (Phase 1 — multi-branch) ──
// ⚡ รองรับทั้ง legacy binary (mode/text) และ multi-branch (branches/fallback)
//   - ถ้า config มี branches array → แสดง multi-branch UI
//   - ถ้าเป็น legacy → แสดง UI เดิม + ปุ่มอัปเกรด

interface ConditionBranchDTO {
  branch_id: string;
  match_type: "contains_any" | "contains_all" | "equals";
  keywords: string[];
  label?: string;
}

function MessageContentConfigPanel({
  cfg, onUpdateConfig, inputStyle, labelStyle, fieldGap,
}: {
  cfg: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  fieldGap: React.CSSProperties;
}) {
  const isMultiBranch = Array.isArray(cfg.branches) && typeof cfg.fallback_branch_id === "string";

  // ⚡ อัปเกรด legacy → multi-branch
  const upgradeToMultiBranch = () => {
    const legacyMode = String(cfg.mode || "contains");
    const legacyText = String(cfg.text || "");
    const matchType: ConditionBranchDTO["match_type"] =
      legacyMode === "equals" ? "equals" : "contains_any";
    const newCfg = {
      source: "customer_reply",
      branches: [
        {
          branch_id: "b1",
          match_type: matchType,
          keywords: legacyText ? legacyText.split(",").map((s) => s.trim()).filter(Boolean) : [],
          label: legacyText || "keyword 1",
        },
      ],
      fallback_branch_id: "fallback",
    };
    // ลบ field เก่าออกด้วย (set เป็น undefined → JSON.stringify จะตัดทิ้ง)
    onUpdateConfig("mode", undefined);
    onUpdateConfig("text", undefined);
    onUpdateConfig("retry_message", undefined);
    onUpdateConfig("source", newCfg.source);
    onUpdateConfig("branches", newCfg.branches);
    onUpdateConfig("fallback_branch_id", newCfg.fallback_branch_id);
  };

  // ⚡ กลับไป legacy
  const downgradeToLegacy = () => {
    onUpdateConfig("branches", undefined);
    onUpdateConfig("fallback_branch_id", undefined);
    onUpdateConfig("source", undefined);
    onUpdateConfig("mode", "contains");
    onUpdateConfig("text", "");
  };

  if (!isMultiBranch) {
    // ── Legacy binary UI + ปุ่มอัปเกรด ──
    return (
      <>
        <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid #8b5cf6", borderRadius: 8, background: "rgba(139,92,246,0.08)", fontSize: 11.5, lineHeight: 1.5 }}>
          ⚡ โหมด legacy (true/false 2 ทาง) — กดอัปเกรดเป็น multi-branch เพื่อแยกกิ่งได้มากกว่า 2 ทาง
          <div style={{ marginTop: 6 }}>
            <button
              onClick={upgradeToMultiBranch}
              style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, border: "1px solid #8b5cf6", background: "#8b5cf6", color: "#fff", cursor: "pointer" }}
            >
              อัปเกรดเป็น multi-branch →
            </button>
          </div>
        </div>
        <div style={fieldGap}>
          <label style={labelStyle}>โหมดเช็ค</label>
          <select value={String(cfg.mode || "contains")} onChange={(e) => onUpdateConfig("mode", e.target.value)} style={inputStyle}>
            <option value="contains">ข้อความมีคำนี้</option>
            <option value="equals">ข้อความตรงกัน</option>
            <option value="not_contains">ข้อความไม่มีคำนี้</option>
          </select>
        </div>
        <div style={fieldGap}>
          <label style={labelStyle}>คำที่เช็ค</label>
          <input style={inputStyle} value={String(cfg.text || "")} onChange={(e) => onUpdateConfig("text", e.target.value)} placeholder="สั่งซื้อ, ซื้อ, สนใจ" />
        </div>
        <div style={fieldGap}>
          <label style={labelStyle}>ข้อความตอน stay_retry (ถ้าเลือก policy นี้)</label>
          <input style={inputStyle} value={String(cfg.retry_message || "")} onChange={(e) => onUpdateConfig("retry_message", e.target.value)} placeholder="รบกวนพิมพ์ตอบตามหัวข้อนะคะ" />
        </div>
      </>
    );
  }

  // ── Multi-branch UI ──
  const branches = (cfg.branches as ConditionBranchDTO[]) || [];
  const fallbackId = String(cfg.fallback_branch_id || "fallback");

  const updateBranches = (next: ConditionBranchDTO[]) => {
    onUpdateConfig("branches", next);
  };

  const addBranch = () => {
    const nextId = `b${branches.length + 1}`;
    updateBranches([
      ...branches,
      { branch_id: nextId, match_type: "contains_any", keywords: [], label: `keyword ${branches.length + 1}` },
    ]);
  };

  const removeBranch = (idx: number) => {
    updateBranches(branches.filter((_, i) => i !== idx));
  };

  const updateBranch = (idx: number, patch: Partial<ConditionBranchDTO>) => {
    updateBranches(branches.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  };

  return (
    <>
      <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid var(--border, #333)", borderRadius: 8, fontSize: 11, opacity: 0.7, lineHeight: 1.5 }}>
        multi-branch: ไล่เช็คทีละ branch ตามลำดับ → ใช้ branch แรกที่ match · ไม่ตรงเลย → fallback
        <div style={{ marginTop: 4 }}>
          <button
            onClick={downgradeToLegacy}
            style={{ padding: "2px 8px", fontSize: 10, borderRadius: 6, border: "1px solid var(--border, #333)", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            ← กลับไป legacy
          </button>
        </div>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>เช็คจากข้อความ</label>
        <select
          value={String(cfg.source || "customer_reply")}
          onChange={(e) => onUpdateConfig("source", e.target.value)}
          style={inputStyle}
        >
          <option value="customer_reply">ข้อความตอบล่าสุด (customer_reply)</option>
          <option value="initial_message">ข้อความแรกที่ทักเข้ามา (initial_message)</option>
        </select>
      </div>

      {/* list ของ branches */}
      {branches.map((b, idx) => (
        <div key={idx} style={{ ...fieldGap, padding: "10px", border: "1px solid var(--border, #333)", borderRadius: 8, background: "rgba(139,92,246,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#8b5cf6" }}>Branch {b.branch_id}</span>
            <button
              onClick={() => removeBranch(idx)}
              style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: 2, fontSize: 11 }}
              title="ลบ branch"
            >
              ✕ ลบ
            </button>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ ...labelStyle, fontSize: 10 }}>ชื่อ branch (แสดงบน node)</label>
            <input
              style={{ ...inputStyle, fontSize: 12 }}
              value={String(b.label || "")}
              onChange={(e) => updateBranch(idx, { label: e.target.value })}
              placeholder="เช่น สั่งซื้อสินค้า"
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ ...labelStyle, fontSize: 10 }}>ประเภทการ match</label>
            <select
              style={{ ...inputStyle, fontSize: 12 }}
              value={b.match_type}
              onChange={(e) => updateBranch(idx, { match_type: e.target.value as ConditionBranchDTO["match_type"] })}
            >
              <option value="contains_any">มีคำใดคำหนึ่ง (contains any)</option>
              <option value="contains_all">มีคำครบทุกคำ (contains all)</option>
              <option value="equals">ตรงกันทุกตัว (equals)</option>
            </select>
          </div>
          <div>
            <label style={{ ...labelStyle, fontSize: 10 }}>Keywords (คั่นด้วย ,)</label>
            <input
              style={{ ...inputStyle, fontSize: 12 }}
              value={Array.isArray(b.keywords) ? b.keywords.join(", ") : ""}
              onChange={(e) => updateBranch(idx, { keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              placeholder="สั่งซื้อ, ซื้อ, สนใจ"
            />
          </div>
        </div>
      ))}

      <button
        onClick={addBranch}
        style={{ ...fieldGap, width: "100%", padding: "8px", fontSize: 12, borderRadius: 8, border: "1px dashed #8b5cf6", background: "transparent", color: "#8b5cf6", cursor: "pointer" }}
      >
        + เพิ่ม keyword (branch)
      </button>

      <div style={fieldGap}>
        <label style={labelStyle}>Fallback branch ID (ไม่ตรง keyword เลย)</label>
        <input
          style={inputStyle}
          value={fallbackId}
          onChange={(e) => onUpdateConfig("fallback_branch_id", e.target.value)}
          placeholder="fallback"
        />
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3 }}>
          edge ที่ออกจาก condition node ต้องมี branch ตรงกับ branch_id หรือ fallback นี้
        </div>
      </div>
    </>
  );
}

// ─── Wait for Reply Config Panel (Phase 2 — retry/timeout/3-branch) ──
// ⚡ รองรับทั้ง legacy (timeout_ms เดี่ยว) และ Phase 2 (answer_type/retry/timeout)
//   - ถ้า config มี answer_type → แสดง Phase 2 UI
//   - ถ้า legacy → แสดง UI เดิม + ปุ่มอัปเกรด

function WaitForReplyConfigPanel({
  cfg, onUpdateConfig, inputStyle, labelStyle, fieldGap,
}: {
  cfg: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  fieldGap: React.CSSProperties;
}) {
  const isPhase2 = typeof cfg.answer_type === "string";

  const upgradeToPhase2 = () => {
    onUpdateConfig("answer_type", "any");
    onUpdateConfig("max_retries", 3);
    onUpdateConfig("retry_message", "");
    // ถ้ามี timeout_ms เดิม → ใช้ค่านั้น ไม่งั้น default 1 ชม
    onUpdateConfig("timeout_ms", cfg.timeout_ms ? Number(cfg.timeout_ms) : 3600000);
  };

  const downgradeToLegacy = () => {
    onUpdateConfig("answer_type", undefined);
    onUpdateConfig("max_retries", undefined);
    onUpdateConfig("retry_message", undefined);
    onUpdateConfig("custom_keywords", undefined);
    // timeout_ms คงไว้
  };

  if (!isPhase2) {
    // ── Legacy UI + ปุ่มอัปเกรด ──
    return (
      <>
        <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid #6366f1", borderRadius: 8, background: "rgba(99,102,241,0.08)", fontSize: 11.5, lineHeight: 1.5 }}>
          ⚡ โหมด legacy (รอ reply เดียว + global timeout) — กดอัปเกรดเป็น Phase 2 เพื่อ retry + 3 branch (success/retry_exceeded/no_reply)
          <div style={{ marginTop: 6 }}>
            <button
              onClick={upgradeToPhase2}
              style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, border: "1px solid #6366f1", background: "#6366f1", color: "#fff", cursor: "pointer" }}
            >
              อัปเกรดเป็น Phase 2 →
            </button>
          </div>
        </div>
        <div style={fieldGap}>
          <label style={labelStyle}>Timeout (ms, ว่าง = ใช้ค่า global จาก config)</label>
          <input type="number" min={0} style={inputStyle} value={cfg.timeout_ms ? Number(cfg.timeout_ms) : ""} onChange={(e) => onUpdateConfig("timeout_ms", e.target.value ? Number(e.target.value) : undefined)} placeholder="เช่น 300000 (5 นาที)" />
        </div>
      </>
    );
  }

  // ── Phase 2 UI ──
  const answerType = String(cfg.answer_type || "any");
  const maxRetries = Number(cfg.max_retries ?? 3);
  const timeoutMs = Number(cfg.timeout_ms ?? 3600000);
  const retryMessage = String(cfg.retry_message || "");
  const customKeywords = Array.isArray(cfg.custom_keywords) ? (cfg.custom_keywords as string[]).join(", ") : "";

  // ตัวเลือก timeout แบบ preset (นาที/ชั่วโมง) → แปลงเป็น ms
  const timeoutPreset = (ms: number): string => {
    if (ms === 300000) return "5m";
    if (ms === 900000) return "15m";
    if (ms === 1800000) return "30m";
    if (ms === 3600000) return "1h";
    if (ms === 7200000) return "2h";
    if (ms === 14400000) return "4h";
    return "custom";
  };

  return (
    <>
      <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid var(--border, #333)", borderRadius: 8, fontSize: 11, opacity: 0.7, lineHeight: 1.5 }}>
        Phase 2: validate คำตอบ → success / ไม่ผ่าน retry / ครบ retry → retry_exceeded / ไม่ตอบเกิน timeout → no_reply
        <div style={{ marginTop: 4 }}>
          <button
            onClick={downgradeToLegacy}
            style={{ padding: "2px 8px", fontSize: 10, borderRadius: 6, border: "1px solid var(--border, #333)", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            ← กลับไป legacy
          </button>
        </div>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ประเภทคำตอบที่รับ</label>
        <select
          value={answerType}
          onChange={(e) => onUpdateConfig("answer_type", e.target.value)}
          style={inputStyle}
        >
          <option value="any">อะไรก็ได้ (any)</option>
          <option value="number">ตัวเลขเท่านั้น (number)</option>
          <option value="custom_keywords">คำที่กำหนด (custom_keywords)</option>
        </select>
      </div>

      {answerType === "custom_keywords" && (
        <div style={fieldGap}>
          <label style={labelStyle}>คำที่ถือว่าเป็นคำตอบที่ถูก (คั่นด้วย ,)</label>
          <input
            style={inputStyle}
            value={customKeywords}
            onChange={(e) => onUpdateConfig("custom_keywords", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder="ใช่, ตกลง, ยืนยัน"
          />
        </div>
      )}

      <div style={fieldGap}>
        <label style={labelStyle}>ถามซ้ำได้กี่ครั้ง (max_retries)</label>
        <input
          type="number"
          min={0}
          max={10}
          style={inputStyle}
          value={maxRetries}
          onChange={(e) => onUpdateConfig("max_retries", Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
        />
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3 }}>
          0 = ไม่ถามซ้ำ (ผิดครั้งเดียว → retry_exceeded) · สูงสุด 10
        </div>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ข้อความถามซ้ำ (ว่าง = ใช้ default ของระบบ)</label>
        <input
          style={inputStyle}
          value={retryMessage}
          onChange={(e) => onUpdateConfig("retry_message", e.target.value)}
          placeholder="รบกวนพิมพ์ตอบตามหัวข้อนะคะ"
        />
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ระยะเวลารอ (timeout)</label>
        <select
          style={inputStyle}
          value={timeoutPreset(timeoutMs)}
          onChange={(e) => {
            const v = e.target.value;
            const map: Record<string, number> = { "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000 };
            if (v === "custom") return; // custom ให้ user พิมพ์เอง
            onUpdateConfig("timeout_ms", map[v]);
          }}
        >
          <option value="5m">5 นาที</option>
          <option value="15m">15 นาที</option>
          <option value="30m">30 นาที</option>
          <option value="1h">1 ชั่วโมง</option>
          <option value="2h">2 ชั่วโมง</option>
          <option value="4h">4 ชั่วโมง</option>
          <option value="custom">กำหนดเอง (ms)</option>
        </select>
        {timeoutPreset(timeoutMs) === "custom" && (
          <input
            type="number"
            min={1000}
            style={{ ...inputStyle, marginTop: 6 }}
            value={timeoutMs}
            onChange={(e) => onUpdateConfig("timeout_ms", Math.max(1000, Number(e.target.value) || 1000))}
            placeholder="ms (เช่น 3600000 = 1 ชม)"
          />
        )}
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3 }}>
          ถ้าเกินเวลานี้ → branch &quot;no_reply&quot; · global workflow_run_timeout_ms ยังเป็น safety net รอง
        </div>
      </div>
    </>
  );
}

// ─── Add Label Config Panel (Phase 3 — Tag Picker) ────────
// ⚡ รองรับทั้ง legacy { label: string } และ { label_ids: string[] }
//   - ถ้า config มี label_ids array → แสดง TagPicker chip
//   - ถ้า legacy → แสดง text input + ปุ่มอัปเกรด
//   - fetch label list จาก GET /api/labels (distinct จาก conversations.labels)
//   - ถ้า fetch ไม่ได้ → fallback เป็น text input (กรอก label ใหม่ได้)

function AddLabelConfigPanel({
  cfg, onUpdateConfig, inputStyle, labelStyle, fieldGap,
}: {
  cfg: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  fieldGap: React.CSSProperties;
}) {
  const isPhase3 = Array.isArray(cfg.label_ids);
  const [availableLabels, setAvailableLabels] = React.useState<string[]>([]);
  const [loadingLabels, setLoadingLabels] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [customInput, setCustomInput] = React.useState("");

  // fetch labels ครั้งเดียวเมื่อเป็น Phase 3
  React.useEffect(() => {
    if (!isPhase3) return;
    if (loadingLabels || availableLabels.length > 0 || fetchError) return;
    setLoadingLabels(true);
    fetch("/api/labels")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.labels)) {
          setAvailableLabels(data.labels as string[]);
        } else if (data.error) {
          setFetchError(String(data.error));
        }
      })
      .catch((err) => setFetchError(err instanceof Error ? err.message : "fetch error"))
      .finally(() => setLoadingLabels(false));
  }, [isPhase3, loadingLabels, availableLabels.length, fetchError]);

  const upgradeToPhase3 = () => {
    const legacyLabel = String(cfg.label || "").trim();
    onUpdateConfig("label", undefined);
    onUpdateConfig("label_ids", legacyLabel ? [legacyLabel] : []);
  };

  const downgradeToLegacy = () => {
    const ids = (cfg.label_ids as string[]) || [];
    onUpdateConfig("label_ids", undefined);
    onUpdateConfig("label", ids[0] || "");
  };

  if (!isPhase3) {
    // ── Legacy UI + ปุ่มอัปเกรด ──
    return (
      <>
        <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid #10b981", borderRadius: 8, background: "rgba(16,185,129,0.08)", fontSize: 11.5, lineHeight: 1.5 }}>
          ⚡ โหมด legacy (label เดียว) — กดอัปเกรดเป็น TagPicker เพื่อเลือกหลาย label แบบ chip
          <div style={{ marginTop: 6 }}>
            <button
              onClick={upgradeToPhase3}
              style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, border: "1px solid #10b981", background: "#10b981", color: "#fff", cursor: "pointer" }}
            >
              อัปเกรดเป็น TagPicker →
            </button>
          </div>
        </div>
        <div style={fieldGap}>
          <label style={labelStyle}>Label</label>
          <input style={inputStyle} value={String(cfg.label || "")} onChange={(e) => onUpdateConfig("label", e.target.value)} placeholder="สนใจซื้อ" />
        </div>
      </>
    );
  }

  // ── Phase 3 TagPicker UI ──
  const selectedIds: string[] = (cfg.label_ids as string[]) || [];

  const toggleLabel = (label: string) => {
    const next = selectedIds.includes(label)
      ? selectedIds.filter((l) => l !== label)
      : [...selectedIds, label];
    onUpdateConfig("label_ids", next);
  };

  const addCustomLabel = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (!selectedIds.includes(trimmed)) {
      onUpdateConfig("label_ids", [...selectedIds, trimmed]);
    }
    if (!availableLabels.includes(trimmed)) {
      setAvailableLabels([...availableLabels, trimmed]);
    }
    setCustomInput("");
  };

  return (
    <>
      <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid var(--border, #333)", borderRadius: 8, fontSize: 11, opacity: 0.7, lineHeight: 1.5 }}>
        Phase 3 TagPicker — เลือกหลาย label แบบ chip · ดึง label list จาก /api/labels
        <div style={{ marginTop: 4 }}>
          <button
            onClick={downgradeToLegacy}
            style={{ padding: "2px 8px", fontSize: 10, borderRadius: 6, border: "1px solid var(--border, #333)", background: "transparent", color: "inherit", cursor: "pointer" }}
          >
            ← กลับไป legacy
          </button>
        </div>
      </div>

      {/* chip ที่เลือกแล้ว */}
      {selectedIds.length > 0 && (
        <div style={{ ...fieldGap, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {selectedIds.map((l) => (
            <span key={l} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, padding: "3px 8px", borderRadius: 12,
              background: "rgba(16,185,129,0.15)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)",
            }}>
              {l}
              <button
                onClick={() => toggleLabel(l)}
                style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}
                title="ลบ"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* label list ให้เลือก */}
      <div style={fieldGap}>
        <label style={labelStyle}>
          {loadingLabels ? "กำลังโหลด label list…" : fetchError ? `โหลดไม่ได้ (${fetchError}) — พิมพ์เพิ่มได้` : "เลือก label ที่มีอยู่"}
        </label>
        {!loadingLabels && availableLabels.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflowY: "auto", padding: 4, border: "1px solid var(--border, #333)", borderRadius: 6 }}>
            {availableLabels.map((l) => {
              const selected = selectedIds.includes(l);
              return (
                <button
                  key={l}
                  onClick={() => toggleLabel(l)}
                  style={{
                    fontSize: 11, padding: "3px 8px", borderRadius: 12, cursor: "pointer",
                    background: selected ? "rgba(16,185,129,0.2)" : "transparent",
                    color: selected ? "#10b981" : "var(--text-dim, #888)",
                    border: selected ? "1px solid rgba(16,185,129,0.4)" : "1px solid var(--border, #333)",
                  }}
                >
                  {l}
                </button>
              );
            })}
          </div>
        )}
        {!loadingLabels && availableLabels.length === 0 && !fetchError && (
          <div style={{ fontSize: 11, opacity: 0.5, padding: 8 }}>ยังไม่มี label ในระบบ — พิมพ์เพิ่มได้ด้านล่าง</div>
        )}
      </div>

      {/* พิมพ์ label ใหม่ */}
      <div style={fieldGap}>
        <label style={labelStyle}>เพิ่ม label ใหม่ (พิมพ์แล้วกด Enter)</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomLabel();
              }
            }}
            placeholder="เช่น สนใจซื้อ, แจ้งปัญหา"
          />
          <button
            onClick={addCustomLabel}
            style={{ padding: "0 12px", fontSize: 12, borderRadius: 6, border: "1px solid #10b981", background: "transparent", color: "#10b981", cursor: "pointer" }}
          >
            + เพิ่ม
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Send Message Config Panel (Phase 4 — Variable Interpolation) ──
// ⚡ textarea + autocomplete {{ + preview ข้อความที่ resolve แล้ว
//   - พิมพ์ {{ → แสดง dropdown ตัวแปรที่ใช้ได้
//   - เลือกตัวแปร → แทรก {{varName}} ที่ cursor
//   - แสดง preview ข้อความที่ resolve แล้ว (ใช้ sample vars)

const TEMPLATE_VARS_UI: { name: string; description: string }[] = [
  { name: "customerName", description: "ชื่อลูกค้า" },
  { name: "shopName", description: "ชื่อร้าน" },
  { name: "integrationName", description: "แพลตฟอร์ม (shopee/tiktok/lazada)" },
  { name: "botAnswer", description: "คำตอบบอทล่าสุด" },
  { name: "customerReply", description: "ข้อความตอบล่าสุดของลูกค้า" },
  { name: "initialMessage", description: "ข้อความแรกที่ลูกค้าทักเข้ามา" },
  { name: "conversationId", description: "Conversation ID" },
  { name: "shopId", description: "Shop ID" },
  { name: "platform", description: "Platform (shopee/tiktok/lazada)" },
];

// sample vars สำหรับ preview (แสดงใน UI ให้เห็นว่าจะออกมาเป็นยังไง)
const SAMPLE_VARS: Record<string, string> = {
  customerName: "คุณสมชาย",
  shopName: "ร้านชาร์จพลัส",
  integrationName: "shopee",
  botAnswer: "หัวชาร์จรุ่นนี้มี 65W ครับ",
  customerReply: "สนใจหัวชาร์จครับ",
  initialMessage: "สอบถามหัวชาร์จ",
  conversationId: "conv_abc123",
  shopId: "shop_xyz",
  platform: "shopee",
};

function SendMessageConfigPanel({
  cfg, onUpdateConfig, inputStyle, labelStyle, fieldGap,
}: {
  cfg: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  fieldGap: React.CSSProperties;
}) {
  const text = String(cfg.text || "");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [showAutocomplete, setShowAutocomplete] = React.useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = React.useState("");

  // ตรวจว่า cursor อยู่หลัง {{ หรือไม่
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    onUpdateConfig("text", newText);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newText.slice(0, cursorPos);
    // หา {{ ตัวสุดท้ายก่อน cursor
    const lastOpen = textBeforeCursor.lastIndexOf("{{");
    const lastClose = textBeforeCursor.lastIndexOf("}}");

    if (lastOpen !== -1 && lastOpen > lastClose) {
      // cursor อยู่ใน {{... → เปิด autocomplete
      const filter = textBeforeCursor.slice(lastOpen + 2).trim();
      setAutocompleteFilter(filter);
      setShowAutocomplete(true);
    } else {
      setShowAutocomplete(false);
    }
  };

  // แทรก {{varName}} ที่ cursor
  const insertVariable = (varName: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      // fallback — append ท้าย
      onUpdateConfig("text", text + `{{${varName}}}`);
      setShowAutocomplete(false);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const textBefore = text.slice(0, start);
    const textAfter = text.slice(end);

    // หา {{ ตัวสุดท้ายก่อน cursor — แทนที่ทั้ง "{{filter" เป็น "{{varName}}"
    const lastOpen = textBefore.lastIndexOf("{{");
    let newText: string;
    let newCursorPos: number;
    if (lastOpen !== -1) {
      newText = textBefore.slice(0, lastOpen) + `{{${varName}}}` + textAfter;
      newCursorPos = lastOpen + varName.length + 4; // {{varName}}
    } else {
      newText = textBefore + `{{${varName}}}` + textAfter;
      newCursorPos = start + varName.length + 4;
    }
    onUpdateConfig("text", newText);
    setShowAutocomplete(false);

    // restore cursor หลัง render
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  };

  // filter ตัวแปรตามที่พิมพ์
  const filteredVars = TEMPLATE_VARS_UI.filter((v) =>
    !autocompleteFilter || v.name.toLowerCase().includes(autocompleteFilter.toLowerCase()) || v.description.includes(autocompleteFilter)
  );

  // preview — แทน {{var}} ด้วย sample vars
  const previewText = text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, varName: string) => {
    const lower = String(varName || "").toLowerCase();
    return SAMPLE_VARS[lower] !== undefined ? SAMPLE_VARS[lower] : "";
  });

  const hasVariables = /\{\{.*?\}\}/.test(text);

  return (
    <>
      <div style={fieldGap}>
        <label style={labelStyle}>
          ข้อความ
          <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 6 }}>
            (พิมพ์ <code style={{ background: "rgba(99,102,241,0.15)", padding: "0 4px", borderRadius: 3 }}>{"{{"}</code> เพื่อแทรกตัวแปร)
          </span>
        </label>
        <div style={{ position: "relative" }}>
          <textarea
            ref={textareaRef}
            style={{ ...inputStyle, minHeight: 80, width: "100%" }}
            value={text}
            onChange={handleTextChange}
            onBlur={() => setTimeout(() => setShowAutocomplete(false), 150)}
            placeholder="สวัสดีคุณ {{customerName}} สนใจสินค้าของ {{shopName}} ไหมคะ?"
          />
          {/* autocomplete dropdown */}
          {showAutocomplete && filteredVars.length > 0 && (
            <div style={{
              position: "absolute", zIndex: 100, top: "100%", left: 0, right: 0,
              background: "var(--bg, #1e1e1e)", border: "1px solid var(--border, #333)",
              borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", maxHeight: 160, overflowY: "auto",
            }}>
              {filteredVars.map((v) => (
                <button
                  key={v.name}
                  onMouseDown={(e) => {
                    e.preventDefault(); // กัน blur ก่อน click
                    insertVariable(v.name);
                  }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
                    background: "transparent", border: "none", color: "inherit", cursor: "pointer",
                    fontSize: 12, fontFamily: "inherit",
                  }}
                >
                  <span style={{ color: "#6366f1", fontWeight: 600 }}>{"{{"}{v.name}{"}}"}</span>
                  <span style={{ opacity: 0.6, marginLeft: 8 }}>{v.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* preview ข้อความที่ resolve แล้ว */}
      {hasVariables && (
        <div style={{ ...fieldGap, padding: "8px 10px", border: "1px solid var(--border, #333)", borderRadius: 6, background: "rgba(99,102,241,0.04)" }}>
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>Preview (ตัวอย่างค่าจริง):</div>
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            {previewText || <span style={{ opacity: 0.4 }}>(ว่าง — ตัวแปรไม่มีค่า)</span>}
          </div>
        </div>
      )}

      {/* ปุ่มเพิ่มตัวแปรทั้งหมด — กดแล้ว append ท้าย */}
      <div style={{ ...fieldGap, display: "flex", flexWrap: "wrap", gap: 4 }}>
        <span style={{ fontSize: 10, opacity: 0.5, width: "100%" }}>ตัวแปรที่ใช้ได้ (กดเพื่อแทรก):</span>
        {TEMPLATE_VARS_UI.map((v) => (
          <button
            key={v.name}
            onClick={() => insertVariable(v.name)}
            style={{
              fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: "pointer",
              background: "rgba(99,102,241,0.1)", color: "#6366f1",
              border: "1px solid rgba(99,102,241,0.3)", fontFamily: "inherit",
            }}
            title={v.description}
          >
            {"{{"}{v.name}{"}}"}
          </button>
        ))}
      </div>
    </>
  );
}

// ─── Flow settings panel (แสดงเมื่อไม่ได้เลือก node) ──

function FlowSettingsPanel({
  settings, setSettings, shops,
}: {
  settings: FlowSettings;
  setSettings: (s: FlowSettings) => void;
  shops: ShopOption[];
}) {
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border, #333)",
    background: "transparent", color: "inherit", fontSize: 13, boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 4, display: "block" };
  const fieldGap: React.CSSProperties = { marginBottom: 12 };

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>ตั้งค่า Workflow</div>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12, lineHeight: 1.5 }}>
        คลิก node บน canvas เพื่อแก้ config ของ node นั้น — panel นี้เป็นค่าของ flow ทั้งอัน
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>คำอธิบาย (optional)</label>
        <textarea
          style={{ ...inputStyle, minHeight: 56 }}
          value={settings.description}
          onChange={(e) => setSettings({ ...settings, description: e.target.value })}
          placeholder="อธิบายสั้นๆ ว่า flow นี้ทำอะไร"
        />
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ร้านที่ใช้ flow นี้ (ไม่เลือก = ใช้ร่วมทุกร้าน)</label>
        {shops.length === 0 ? (
          <div style={{ fontSize: 11.5, opacity: 0.5 }}>โหลดร้านไม่ได้ — พิมพ์ shop_id คั่นด้วย , แทน</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 160, overflowY: "auto", padding: "8px 10px", border: "1px solid var(--border, #333)", borderRadius: 8 }}>
            {shops.map((s) => (
              <label key={s.shop_id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.shop_ids.includes(s.shop_id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...settings.shop_ids, s.shop_id]
                      : settings.shop_ids.filter((x) => x !== s.shop_id);
                    setSettings({ ...settings, shop_ids: next });
                  }}
                />
                <span>{s.shopname}</span>
                <span style={{ fontSize: 10, opacity: 0.45 }}>({s.platform})</span>
              </label>
            ))}
          </div>
        )}
        {shops.length === 0 && (
          <input
            style={inputStyle}
            value={settings.shop_ids.join(", ")}
            onChange={(e) => setSettings({ ...settings, shop_ids: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            placeholder="เช่น 12345, 67890"
          />
        )}
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3 }}>
          1 ร้านเลือกได้หลาย flow · flow ที่ไม่เลือกร้านเลย = ใช้กับทุกร้าน · หลาย flow ตรงพร้อมกัน → ไล่ตาม priority
        </div>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>Platform</label>
        <div style={{ display: "flex", gap: 10 }}>
          {(["shopee", "tiktok", "lazada"] as const).map((p) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settings.platforms.includes(p)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...settings.platforms, p]
                    : settings.platforms.filter((x) => x !== p);
                  setSettings({ ...settings, platforms: next });
                }}
              />
              {p}
            </label>
          ))}
        </div>
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 3 }}>ไม่เลือก = ทุก platform</div>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ความถี่ที่ flow ทำงาน</label>
        <select value={settings.trigger_frequency} onChange={(e) => setSettings({ ...settings, trigger_frequency: e.target.value as FlowSettings["trigger_frequency"] })} style={inputStyle}>
          <option value="every_time">ทุกครั้งที่ keyword ตรง</option>
          <option value="once_per_conversation">แชทละ 1 ครั้ง</option>
          <option value="once_per_customer">ลูกค้าละ 1 ครั้ง</option>
        </select>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>นโยบายตอน condition ไม่ผ่าน (ไม่มี false branch)</label>
        <select value={settings.false_branch_policy} onChange={(e) => setSettings({ ...settings, false_branch_policy: e.target.value as FlowSettings["false_branch_policy"] })} style={inputStyle}>
          <option value="exit_to_bot">ออก flow → ให้บอทตอบ (แนะนำ)</option>
          <option value="exit_drop">ออก flow → ทิ้งข้อความ</option>
          <option value="stay_retry">อยู่ flow → ทวงคำตอบ</option>
        </select>
      </div>

      <div style={fieldGap}>
        <label style={labelStyle}>ลำดับความสำคัญ (สูง = ทำก่อน ตอนหลาย flow ตรงพร้อมกัน)</label>
        <input type="number" style={inputStyle} value={settings.priority} onChange={(e) => setSettings({ ...settings, priority: Number(e.target.value) })} />
      </div>
    </div>
  );
}

// ─── Export — wrapper พร้อม ReactFlowProvider ──

export default function WorkflowEditor({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}
