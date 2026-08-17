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
        className={`w-full h-10 px-3 rounded-lg border bg-surface text-text placeholder:text-text-subtle transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand ${
          error ? "border-vibrant-coral" : "border-border"
        } ${className}`}
        {...props}
      />
      {error && <span className="block text-xs text-vibrant-coral mt-1">{error}</span>}
    </label>
  )
);
Input.displayName = "Input";
