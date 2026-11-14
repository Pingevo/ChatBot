// Card — surface container
import { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover = false, className = "", children, ...props }: Props) {
  return (
    <div
      data-ui="card"
      className={`bg-surface border border-border-subtle rounded-xl shadow-[var(--shadow-xs)] ${
        hover ? "transition-all duration-200 hover:shadow-[var(--shadow-sm)] hover:border-border-strong" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
