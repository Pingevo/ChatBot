// Tooltip — lightweight hover/focus tooltip for technical terms
// ใช้: <Tooltip text="ความสำคัญของทริกเกอร์ — ตัวเลขยิ่งสูงยิ่งจับคู่ก่อน">
//         <Info size={12} className="text-text-subtle" />
//       </Tooltip>
"use client";
import { useState, useRef, useId } from "react";

interface TooltipProps {
  /** Tooltip text */
  text: string;
  /** Children: the trigger element */
  children: React.ReactNode;
  /** Side: which side to show the tooltip (default: top) */
  side?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({ text, children, side = "top" }: TooltipProps) {
  const [show, setShow] = useState(false);
  const id = useId();

  const sideClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      <span aria-describedby={show ? id : undefined} tabIndex={0}>
        {children}
      </span>
      {show && (
        <span
          id={id}
          role="tooltip"
          className={`absolute z-50 ${sideClasses[side]} max-w-xs px-2.5 py-1.5 rounded-md bg-deep-space text-white text-xs leading-snug shadow-lg pointer-events-none whitespace-normal`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
