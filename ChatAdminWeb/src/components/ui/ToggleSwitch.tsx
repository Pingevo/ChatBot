// ToggleSwitch — shared toggle component with accessibility semantics
// Replaces inline duplicates across config, admin-config, workflows, persona, triggers, quick-replies, knowledge
"use client";

import { type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export interface ToggleSwitchProps {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
  loading?: boolean;
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
  loading = false,
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
      disabled={disabled || loading}
      role="switch"
      aria-checked={enabled}
      aria-busy={loading || undefined}
      aria-label={ariaLabel || (enabled ? "ปิดใช้งาน" : "เปิดใช้งาน")}
      className={`mobile-toggle-hit-target inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 ${
        disabled || loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
      style={{ width: s.width, height: s.height }}
      title={enabled ? "คลิกเพื่อปิด" : "คลิกเพื่อเปิด"}
    >
      <span
        className={`mobile-toggle-track relative flex shrink-0 items-center rounded-full transition-colors duration-200 ${enabled ? "bg-accent" : "bg-surface-3"}`}
        aria-hidden="true"
        style={{ width: s.width, height: s.height }}
      >
        {loading ? (
          <LoaderCircle className="mx-auto animate-spin text-white" size={12} />
        ) : (
          <span
            className="mobile-toggle-knob absolute rounded-full bg-white shadow-sm transition-transform duration-200"
            style={{
              width: s.knob,
              height: s.knob,
              top: s.top,
              left: s.left,
              transform: enabled ? `translateX(${s.travel})` : "translateX(0)",
            }}
          />
        )}
      </span>
    </button>
  );

  if (!label) return switchEl;

  return (
    <span className={`inline-flex items-center gap-2 ${disabled ? "opacity-60" : ""}`}>
      {labelPosition === "left" && <span className="text-sm text-text-muted">{label}</span>}
      {switchEl}
      {labelPosition === "right" && <span className="text-sm text-text-muted">{label}</span>}
    </span>
  );
}
