"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  density?: "regular" | "compact";
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  ({ density = "regular", className = "", ...props }, ref) => (
    <select
      ref={ref}
      {...props}
      className={`console-select${density === "compact" ? " console-select--compact" : ""} ${className}`.trim()}
    />
  )
);

SelectField.displayName = "SelectField";
