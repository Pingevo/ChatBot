// Badge — small status pill
import { HTMLAttributes } from "react";

type Tone = "brand" | "coral" | "pale" | "deep" | "neutral" | "red" | "success" | "error" | "info" | "warning";

interface Props extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const tones: Record<Tone, string> = {
  brand: "bg-accent-soft text-accent",
  coral: "bg-error-soft text-error",
  pale: "bg-surface-2 text-text-muted",
  deep: "bg-stone-800 text-white",
  neutral: "bg-surface-2 text-text-muted",
  red: "bg-error-soft text-error",
  success: "bg-success-soft text-success-dark",
  error: "bg-error-soft text-error",
  info: "bg-accent-soft text-accent",
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
