"use client";
// DebouncedResponsiveContainer — wrapper around recharts ResponsiveContainer
// that debounces resize events. Prevents chart re-render storms during
// sidebar collapse/expand transitions (200ms).
//
// Usage: drop-in replacement for ResponsiveContainer.
//   <DebouncedResponsiveContainer width="100%" height={200}>
//     <BarChart ... />
//   </DebouncedResponsiveContainer>
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

interface Props {
  width?: number | string;
  height?: number | string;
  children: ReactNode;
  debounceMs?: number;
  className?: string;
}

export function DebouncedResponsiveContainer({
  width = "100%",
  height = "100%",
  children,
  debounceMs = 250,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newWidth = Math.round(entry.contentRect.width);

      // Clear previous timer — debounce
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setMeasuredWidth(newWidth);
      }, debounceMs);
    });

    ro.observe(el);
    // Set initial width immediately (no debounce on first render)
    setMeasuredWidth(Math.round(el.getBoundingClientRect().width));

    return () => {
      ro.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [debounceMs]);

  return (
    <div ref={containerRef} className={className} style={{ width, height }}>
      {measuredWidth !== null && (
        <ResponsiveContainer
          width={measuredWidth}
          height={typeof height === "number" ? height : "100%"}
        >
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}
