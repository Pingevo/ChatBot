"use client";
import React from "react";
// Pixel-art cat เดินไปตาม pipeline — frame สลับทุก 300ms ตอน building
// pure CSS/SVG ไม่มี dependency — ขนาด 16px ×2 scale
const PX = 4; // pixel size

// 16x12 pixel cat (two walk frames) — o=body, e=ear/eye, t=tail, l=legs
const F1 = [
  "t...............",
  "tt..e.......e...",
  ".tt.ooo...ooo...",
  "..tooooooooooo..",
  "...ooooooooooo..",
  "...ooeoooooeoo..",
  "...ooooooooooo..",
  "....oo.....oo...",
  "....oo.....oo...",
  "...ll......ll...",
];
const F2 = [
  "t...............",
  "tt..e.......e...",
  ".tt.ooo...ooo...",
  "..tooooooooooo..",
  "...ooooooooooo..",
  "...ooeoooooeoo..",
  "...ooooooooooo..",
  ".....oo..oo.....",
  ".....oo..oo.....",
  "....ll....ll....",
];
const COLORS: Record<string, string> = {
  o: "#f59e0b", e: "#b45309", t: "#d97706", l: "#92400e",
};

function Frame({ rows }: { rows: string[] }) {
  const rects: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (COLORS[c]) {
        rects.push(
          <rect key={`${x}-${y}`} x={x * PX} y={y * PX} width={PX} height={PX}
                fill={COLORS[c]} />
        );
      }
    });
  });
  return <g>{rects}</g>;
}

export function PixelCat({ walking }: { walking: boolean }) {
  const [f, setF] = React.useState(0);
  React.useEffect(() => {
    if (!walking) return;
    const t = setInterval(() => setF((v) => 1 - v), 300);
    return () => clearInterval(t);
  }, [walking]);
  return (
    <svg width={16 * PX} height={10 * PX}
         className={walking ? "animate-pulse" : ""} aria-label="build-cat">
      <Frame rows={f ? F2 : F1} />
    </svg>
  );
}

/** แมวเดินบนแถบขั้นตอน — idx = step ปัจจุบัน, total = จำนวน step */
export function BuildProgressCat(
  { current, total, walking }: { current: number; total: number; walking: boolean },
) {
  const pct = total > 1 ? (current / (total - 1)) * 100 : 0;
  return (
    <div className="relative h-12">
      <div className="absolute transition-all duration-700 ease-in-out"
           style={{ left: `calc(${pct}% - 24px)` }}>
        <PixelCat walking={walking} />
      </div>
    </div>
  );
}
