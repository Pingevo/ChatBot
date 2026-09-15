// Input — text input with consistent styling
import { InputHTMLAttributes, forwardRef } from "react";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, error, className = "", ...props }, ref) => (
    <label className="block">
      {label && <span className="block text-sm font-medium text-text mb-1.5">{label}</span>}
      <input
        ref={ref}
        className={`w-full h-10 px-3 rounded-lg border bg-surface text-text placeholder:text-text-subtle transition-all focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent hover:border-border-strong ${
          error ? "border-error" : "border-border"
        } ${className}`}
        {...props}
      />
      {error && <span className="block text-xs text-error mt-1">{error}</span>}
    </label>
  )
);
Input.displayName = "Input";
