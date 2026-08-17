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
  primary: "bg-brand text-white hover:bg-brand/90 active:bg-brand/80 shadow-sm",
  secondary: "bg-deep-space text-white hover:bg-deep-space/90 active:bg-deep-space/80 shadow-sm",
  ghost: "bg-transparent text-text hover:bg-surface-2 active:bg-surface-2/80",
  danger: "bg-vibrant-coral text-white hover:bg-vibrant-coral/90 active:bg-vibrant-coral/80 shadow-sm",
  outline: "border border-border bg-surface text-text hover:bg-surface-2 active:bg-surface-2/80",
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
      className={`inline-flex items-center justify-center font-medium transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
);
Button.displayName = "Button";
