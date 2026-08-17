// Badge — small status pill
import { HTMLAttributes } from "react";

type Tone = "brand" | "coral" | "pale" | "deep" | "neutral" | "red";

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
