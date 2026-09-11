// Badge — small status pill
import { HTMLAttributes } from "react";

// 🔒 P2b: Added success/error/info/warning tones for semantic status display
type Tone = "brand" | "coral" | "pale" | "deep" | "neutral" | "red" | "success" | "error" | "info" | "warning";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const tones: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand",
  coral: "bg-vibrant-coral-soft text-vibrant-coral",
  pale: "bg-pale-sky-soft text-deep-space",
  deep: "bg-deep-space text-white",
  neutral: "bg-surface-2 text-text-muted",
  red: "bg-flag-red/10 text-flag-red",
  success: "bg-success-soft text-success-dark",
  error: "bg-error-soft text-error",
  info: "bg-info-soft text-info-dark",
  warning: "bg-warning-soft text-warning-dark",
};

export function Badge({ tone = "neutral", className = "", children, ...props }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${tones[tone]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
