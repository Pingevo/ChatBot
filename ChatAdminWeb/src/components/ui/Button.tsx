// Button — consistent across the app
"use client";
import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-dark active:bg-accent-dark shadow-sm hover:shadow-[var(--shadow-accent)]",
  secondary: "bg-surface-2 text-text hover:bg-surface-3 active:bg-surface-3 border border-border",
  ghost: "bg-transparent text-text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3",
  danger: "bg-error text-white hover:bg-[#c5252d] active:bg-[#b91c1c] shadow-sm",
  outline: "border border-border-strong bg-surface text-text hover:bg-surface-1 hover:border-accent/40 active:bg-surface-2",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-lg",
  lg: "h-12 px-6 text-base gap-2 rounded-xl",
  icon: "h-9 w-9 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = "primary", size = "md", className = "", children, ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-medium transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-1 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
);
Button.displayName = "Button";
