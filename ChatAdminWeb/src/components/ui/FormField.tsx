// FormField — shared form field wrapper with inline validation error display
// ใช้: <FormField id="my-input" label="ชื่อ" error={errors.name}>
//         <input ... />
//       </FormField>
// ⚡ แก้ P15a: clone child เพื่อ inject id, aria-invalid, aria-describedby อัตโนมัติ
"use client";
import { cloneElement } from "react";
import { AlertCircle } from "lucide-react";
import type { ReactElement } from "react";

interface FormFieldProps {
  /** Error message — when non-empty, shows red border + error text */
  error?: string;
  /** Children: the input/select/textarea element (should be a single React element) */
  children: ReactElement;
  /** Optional label text */
  label?: string;
  /** ID for the input — used for htmlFor + aria-describedby + injected into child */
  id?: string;
  /** Optional className for the wrapper */
  className?: string;
  /** Optional className for the label */
  labelClassName?: string;
  /** Required — when true, adds aria-required="true" to child + asterisk to label */
  required?: boolean;
}

export function FormField({ error, children, label, id, className = "", labelClassName = "", required = false }: FormFieldProps) {
  const errorId = id ? `${id}-error` : undefined;
  // Clone child to inject id, aria-invalid, aria-describedby, aria-required, and border-error
  const enhancedChild = id || error || required ? (() => {
    const childProps: Record<string, unknown> = {};
    if (id) childProps.id = id;
    if (required) childProps["aria-required"] = "true";
    if (error) {
      childProps["aria-invalid"] = "true";
      if (errorId) childProps["aria-describedby"] = errorId;
      // Replace border-border with border-error (don't append — avoids CSS order issues)
      const existingClass = ((children.props as Record<string, unknown>).className || "") as string;
      childProps.className = existingClass.replace(/border-border\b/g, "border-error").trim();
    }
    const child = children as ReactElement<Record<string, unknown>>;
    return cloneElement(child, childProps);
  })() : children;

  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className={`block text-sm font-medium text-text mb-1.5 ${labelClassName}`}>
          {label}
          {required && <span className="text-coral ml-0.5" aria-hidden="true">*</span>}
        </label>
      )}
      {error ? (
        <div className="relative">
          {enhancedChild}
          <AlertCircle size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-error pointer-events-none" />
        </div>
      ) : (
        enhancedChild
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-error flex items-center gap-1">
          <AlertCircle size={11} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Helper to build inline error state from a form object
 * Returns an object of field -> error message (empty string = valid)
 */
export function buildErrors(form: Record<string, unknown>, rules: Record<string, (v: unknown) => string | undefined>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [field, validate] of Object.entries(rules)) {
    const err = validate(form[field]);
    if (err) errors[field] = err;
  }
  return errors;
}
