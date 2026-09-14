// Card — surface container
import { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover = false, className = "", children, ...props }: Props) {
  return (
    <div
      className={`bg-surface border border-border rounded-xl shadow-[var(--shadow-sm)] ${
        hover ? "transition-all duration-200 hover:shadow-[var(--shadow-md)] hover:border-border-strong" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
