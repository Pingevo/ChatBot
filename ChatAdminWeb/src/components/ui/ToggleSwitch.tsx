// ToggleSwitch — shared toggle component with accessibility semantics
// Replaces inline duplicates across config, admin-config, workflows, persona, triggers, quick-replies, knowledge
"use client";

import { type ReactNode } from "react";

export interface ToggleSwitchProps {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Optional visible label (renders next to the switch). If omitted, only aria-label is used. */
  label?: ReactNode;
  /** Optional aria-label override. Defaults to dynamic "ปิดใช้งาน"/"เปิดใช้งาน". */
  ariaLabel?: string;
  /** Size variant. Default "md". */
  size?: "sm" | "md";
  /** Show the label on the left (default) or right of the switch. */
  labelPosition?: "left" | "right";
}

const SIZES = {
  sm: { width: "32px", height: "18px", knob: "14px", travel: "14px", top: "2px", left: "2px" },
  md: { width: "40px", height: "22px", knob: "18px", travel: "18px", top: "2px", left: "2px" },
};

export function ToggleSwitch({
  enabled,
  onChange,
  disabled,
  label,
  ariaLabel,
  size = "md",
  labelPosition = "left",
}: ToggleSwitchProps) {
  const s = SIZES[size];
  const switchEl = (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel || (enabled ? "ปิดใช้งาน" : "เปิดใช้งาน")}
      className={`relative rounded-full transition-colors flex-shrink-0 ${
        enabled ? "bg-success" : "bg-surface-1"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1`}
      style={{ width: s.width, height: s.height }}
      title={enabled ? "คลิกเพื่อปิด" : "คลิกเพื่อเปิด"}
    >
      <span
        className="absolute rounded-full bg-white shadow-sm transition-transform"
        style={{
          width: s.knob,
          height: s.knob,
          top: s.top,
          left: s.left,
          transform: enabled ? `translateX(${s.travel})` : "translateX(0)",
        }}
      />
    </button>
  );

  if (!label) return switchEl;

  return (
    <label className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}>
      {labelPosition === "left" && <span className="text-sm text-text-muted">{label}</span>}
      {switchEl}
      {labelPosition === "right" && <span className="text-sm text-text-muted">{label}</span>}
    </label>
  );
}
