// BindingResolutionPanel — presentational binding-resolution UI (R1 Task 8)
//   render display data จาก BindingResolutionView (server-produced เท่านั้น)
//   + emit user events ขึ้น editor — ไม่มี fetch/validation/business decision
//   authoritative validation อยู่ฝั่ง service (saveBindingResolutionBatch) เสมอ
"use client";
import type { BindingResolutionView, ResolutionMapping } from "@/backend/service/workflowService";

// pick ที่ user เลือกต่อ source_index — local target identity เท่านั้น
// (account → local_id=shop_id + platform/shop_id · label/user → local_id)
export interface BindingPick {
  local_id: string;
  platform?: string;
  shop_id?: string;
}

export interface BindingResolutionPanelProps {
  view: BindingResolutionView;       // GET /api/workflows/[id]/bindings response verbatim
  nodeId?: string;                   // filter แสดงเฉพาะ bindings ของ node นี้ (wiring ใน NodeConfigPanel)
  picks?: Record<string, Record<number, BindingPick | undefined>>;   // controlled — editor owns state
  repeats?: Record<string, boolean>;                                 // controlled repeat flag per binding
  submitting?: string | null;        // binding_id ที่กำลัง POST
  onPick?: (binding_id: string, source_index: number, pick: BindingPick | null) => void;
  onRepeat?: (binding_id: string, repeat: boolean) => void;
  onResolve?: (binding_id: string) => void;
}

// unresolvable kinds (R1) — copy ตาม plan (team literal กำหนดใน plan §3/§20)
const UNAVAILABLE_KIND_NOTE: Record<string, string> = {
  team: "team mapping unavailable — local team identity not defined",
  ticket_field: "ticket_field mapping unavailable — no local ticket-field entity (publish-blocking)",
  url: "url mapping unavailable — values redacted at import (publish-blocking)",
};

const rowStyle: React.CSSProperties = {
  padding: "8px 10px", border: "1px solid var(--color-border)", borderRadius: 8,
  marginBottom: 10, fontSize: 12, lineHeight: 1.5,
};
const srcRowStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px",
  border: "1px solid var(--color-border)", borderRadius: 6, marginTop: 6,
};
const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--color-text-muted)", marginBottom: 4, display: "block" };
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--color-border)",
  background: "transparent", color: "inherit", fontSize: 12, boxSizing: "border-box",
};
const monoStyle: React.CSSProperties = { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" };
const chip = (color: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", fontSize: 10, fontWeight: 600,
  padding: "2px 8px", borderRadius: 12, marginRight: 4, marginTop: 4,
  background: `color-mix(in srgb, ${color} 12%, transparent)`, color,
  border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
});

function statusChipStyle(status: string): React.CSSProperties {
  return chip(status === "resolved" ? "var(--color-success)" : status === "invalid" ? "var(--color-error)" : "var(--color-warning)");
}

function mappingEcho(m: ResolutionMapping): string {
  const scope = m.platform ? ` (${m.platform}${m.shop_id ? `/${m.shop_id}` : ""})` : "";
  const flags = [m.via, m.carried ? "carried" : null, m.state === "invalid" ? "invalid" : null].filter(Boolean).join(" · ");
  return `→ ${m.local_id}${scope} · ${flags}`;
}

export function BindingResolutionPanel({
  view, nodeId, picks = {}, repeats = {}, submitting = null, onPick, onRepeat, onResolve,
}: BindingResolutionPanelProps) {
  const rows = view.bindings.filter((b) => nodeId == null || b.node_id === nodeId);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        bindings (zaapi external identities)
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6 }}>
        unresolved: {view.unresolved} · invalid: {view.invalid}
        {nodeId != null ? ` · node ${nodeId}` : ""}
      </div>
      {view.publish_blockers.map((b) => (
        <span key={b} style={chip("var(--color-warning)")} title="publish blocker">⛔ {b}</span>
      ))}
      {view.overlap_conflicts.map((b) => (
        <span key={b} style={chip("var(--color-error)")} title="overlap conflict">⚠ {b}</span>
      ))}
      {rows.length === 0 && (
        <div style={{ fontSize: 11, opacity: 0.55, padding: "6px 0" }}>
          {nodeId != null ? "no external bindings on this node" : "no bindings on this workflow"}
        </div>
      )}
      {rows.map((b) => {
        const bPicks = picks[b.binding_id] || {};
        const complete = b.sources.length > 0 && b.sources.every((s) => bPicks[s.source_index]?.local_id);
        // resolvable = allowlist เดียวกับ service validation switch
        // (account/label/user) — kind อื่นทั้งหมดรวม unknown → unavailable
        // path (fail-closed เหมือน server `default:` reject)
        const resolvable = b.kind === "account" || b.kind === "label" || b.kind === "user";
        const unavailableNote = resolvable ? null
          : (UNAVAILABLE_KIND_NOTE[b.kind] ?? `${b.kind} mapping unavailable in R1 (publish-blocking)`);
        return (
          <div key={b.binding_id} data-binding={b.binding_id} style={rowStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{b.kind} × {b.count} @ {b.field_path}</span>
              <span style={statusChipStyle(b.status)}>{b.status}</span>
            </div>
            <div style={{ fontSize: 10, opacity: 0.55 }}>node: {b.node_id}</div>
            {b.sources.map((s) => {
              const mapped = b.resolution?.mappings?.find((m) => m.source_index === s.source_index);
              const pick = bPicks[s.source_index];
              return (
                <div key={s.source_index} style={srcRowStyle}>
                  <div>
                    <span style={{ fontSize: 10, opacity: 0.55, marginRight: 6 }}>source {s.source_index}</span>
                    <span style={monoStyle}>{s.display_value}</span>
                  </div>
                  {mapped ? (
                    <div style={{ fontSize: 11, color: "var(--color-success)" }}>{mappingEcho(mapped)}</div>
                  ) : resolvable && b.status !== "resolved" ? (
                    b.kind === "account" ? (
                      <select
                        data-bid={b.binding_id} style={inputStyle}
                        value={pick?.shop_id ?? ""}
                        onChange={(e) => {
                          const c = view.candidates.accounts.find((a) => a.shop_id === e.target.value);
                          onPick?.(b.binding_id, s.source_index, c ? { local_id: c.shop_id, platform: c.platform, shop_id: c.shop_id } : null);
                        }}
                      >
                        <option value="">— เลือกร้าน (account) —</option>
                        {view.candidates.accounts.map((a) => (
                          <option key={`${a.platform}|${a.shop_id}`} value={a.shop_id}>
                            {a.platform} · {a.shopname} ({a.shop_id})
                          </option>
                        ))}
                      </select>
                    ) : b.kind === "label" ? (
                      <select
                        data-bid={b.binding_id} style={inputStyle}
                        value={pick?.local_id ?? ""}
                        onChange={(e) => onPick?.(b.binding_id, s.source_index, e.target.value ? { local_id: e.target.value } : null)}
                      >
                        <option value="">— เลือก label —</option>
                        {view.candidates.labels.map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                    ) : b.kind === "user" ? (
                      <select
                        data-bid={b.binding_id} style={inputStyle}
                        value={pick?.local_id ?? ""}
                        onChange={(e) => onPick?.(b.binding_id, s.source_index, e.target.value ? { local_id: e.target.value } : null)}
                      >
                        <option value="">— เลือก user —</option>
                        {view.candidates.users.map((u) => (
                          <option key={u.admin_id} value={u.admin_id}>{u.display}</option>
                        ))}
                      </select>
                    ) : null
                  ) : null}
                </div>
              );
            })}
            {unavailableNote != null && (
              <div style={{ fontSize: 11, color: "var(--color-warning)", marginTop: 6 }}>
                {unavailableNote}
              </div>
            )}
            {resolvable && b.status !== "resolved" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}
                  title="apply mapping เดียวกันให้ bindings อื่นที่มี source เดียวกัน (server เช็ค exact equality เอง)">
                  <input
                    type="checkbox" data-rbid={b.binding_id}
                    checked={!!repeats[b.binding_id]}
                    onChange={(e) => onRepeat?.(b.binding_id, e.target.checked)}
                  />
                  repeat ให้ sibling bindings
                </label>
                <button
                  disabled={submitting === b.binding_id || !complete}
                  onClick={() => onResolve?.(b.binding_id)}
                  title={complete ? "commit resolution (draft เดิม — ไม่ activate)" : "เลือก target ให้ครบทุก source ก่อน"}
                  style={{
                    padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                    border: "1px solid var(--color-brand)", cursor: complete ? "pointer" : "not-allowed",
                    background: complete ? "var(--color-brand)" : "transparent",
                    color: complete ? "#fff" : "var(--color-text-muted)", opacity: submitting === b.binding_id ? 0.6 : 1,
                  }}
                >
                  {submitting === b.binding_id ? "กำลัง resolve…" : "resolve binding นี้"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// DerivedScopeFields — extracted read-only subtree ที่ FlowSettingsPanel render
// สำหรับ imported workflows (platforms/shop_ids = server-derived จาก resolved
// account bindings — แก้ผ่าน binding resolution เท่านั้น ห้าม edit ตรง)
export function DerivedScopeFields({ platforms, shop_ids, shops }: {
  platforms: string[];
  shop_ids: string[];
  shops?: { shop_id: string; shopname: string; platform: string }[];
}) {
  const shopName = (id: string) => shops?.find((s) => s.shop_id === id)?.shopname ?? id;
  return (
    <div>
      <div style={labelStyle}>ร้านที่ใช้ flow นี้ (derived from resolved bindings)</div>
      <div style={{ marginBottom: 10 }}>
        {shop_ids.length === 0 ? (
          <span style={{ fontSize: 11, opacity: 0.55 }}>ยังไม่มี scope — resolve account bindings ก่อน</span>
        ) : shop_ids.map((id) => (
          <span key={id} style={chip("var(--color-brand)")}>{shopName(id)} ({id})</span>
        ))}
      </div>
      <div style={labelStyle}>Platform (derived from resolved bindings)</div>
      <div>
        {platforms.length === 0 ? (
          <span style={{ fontSize: 11, opacity: 0.55 }}>—</span>
        ) : platforms.map((p) => (
          <span key={p} style={chip("var(--color-brand)")}>{p}</span>
        ))}
      </div>
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>
        scope fields อ่านอย่างเดียว — derived from resolved bindings (แก้ผ่าน binding resolution เท่านั้น)
      </div>
    </div>
  );
}
