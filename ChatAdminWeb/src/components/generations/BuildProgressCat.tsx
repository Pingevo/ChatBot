"use client";
import React from "react";
import Image from "next/image";
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

export type PixelCatAction = "idle" | "walk" | "wave" | "snack" | "mood";
export type PixelCatOutfit = "classic" | "maroon" | "hoodie";
export type PixelCatMood = "adoring" | "angry" | "happy" | "downcast";

const OUTFIT_SPRITES: Record<PixelCatOutfit, string> = {
  classic: "/mascot/cat-girl-atlas-classic.webp",
  maroon: "/mascot/cat-girl-atlas-maroon.webp",
  hoodie: "/mascot/cat-girl-atlas-hoodie.webp",
};

export function PixelCat({
  walking,
  action,
  outfit = "classic",
  mood = "happy",
}: {
  walking: boolean;
  action?: PixelCatAction;
  outfit?: PixelCatOutfit;
  mood?: PixelCatMood;
}) {
  const [f, setF] = React.useState(0);
  const spriteAction = action || (walking ? "walk" : "idle");
  React.useEffect(() => {
    if (!walking || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setF((v) => 1 - v), 520);
    return () => clearInterval(t);
  }, [walking]);
  return (
    <>
      <span className={`generation-cat-sprite-window generation-cat-sprite--${spriteAction} generation-cat-mood--${mood} md:hidden`} aria-hidden="true">
        <span className="generation-cat-sprite-frame">
          <Image
            src={OUTFIT_SPRITES[outfit]}
            width={1776}
            height={888}
            unoptimized
            sizes="192px"
            alt=""
            className="generation-cat-sprite-sheet"
          />
        </span>
      </span>
      <svg
        width={16 * PX}
        height={10 * PX}
        className={`${walking ? "generation-pixel-cat is-walking animate-pulse" : "generation-pixel-cat"} hidden md:block`}
        role="img"
        aria-label="build-cat"
      >
        <Frame rows={f ? F2 : F1} />
      </svg>
    </>
  );
}

/** แมวเดินบนแถบขั้นตอน — idx = step ปัจจุบัน, total = จำนวน step */
export function BuildProgressCat(
  { current, total, walking }: { current: number; total: number; walking: boolean },
) {
  const pct = total > 1 ? (current / (total - 1)) * 100 : 0;
  return (
    <div
      className="generation-build-progress relative h-12"
      style={{ "--generation-progress": `${pct}%` } as React.CSSProperties}
    >
      <div className="absolute transition-all duration-700 ease-in-out"
           style={{ left: `clamp(0px, calc(${pct}% - 24px), calc(100% - 64px))` }}>
        <PixelCat walking={walking} />
      </div>
    </div>
  );
}
