// Card — surface container
import { HTMLAttributes } from "react";

interface Props extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover = false, className = "", children, ...props }: Props) {
  return (
    <div
      className={`bg-surface border border-border rounded-xl shadow-sm ${
        hover ? "transition-shadow hover:shadow-md" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
