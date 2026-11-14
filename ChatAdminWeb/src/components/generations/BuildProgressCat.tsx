"use client";
import type { CSSProperties } from "react";
import Image from "next/image";

export type PixelCatAction = "idle" | "walk" | "wave" | "snack" | "snack-wave" | "jump-wave" | "mood";
export type PixelCatOutfit = "classic" | "maroon" | "hoodie";
export type PixelCatMood = "adoring" | "angry" | "happy" | "downcast";

export function getGenerationMascotState(status: string, active: boolean): {
  action: PixelCatAction;
  mood: PixelCatMood;
} {
  if (status === "published" && active) return { action: "jump-wave", mood: "happy" };
  if (status === "published" || status === "pending") return { action: "snack-wave", mood: "happy" };
  return { action: "mood", mood: "angry" };
}

export function getGenerationProgressPercent(progress: number, total: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (progress / total) * 100)));
}

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
  const spriteAction = action || (walking ? "walk" : "idle");
  const staticPose = !walking && spriteAction === "idle";
  const spriteStyle: CSSProperties | undefined = staticPose ? { animation: "none" } : undefined;
  return (
    <span className={`generation-cat-sprite-window generation-cat-sprite--${spriteAction} generation-cat-mood--${mood}`} aria-hidden="true">
      <span className="generation-cat-sprite-frame">
        <Image
          src={OUTFIT_SPRITES[outfit]}
          width={1776}
          height={888}
          unoptimized
          sizes="192px"
          alt=""
          className="generation-cat-sprite-sheet"
          style={spriteStyle}
        />
      </span>
    </span>
  );
}

/** แมวเดินบนแถบขั้นตอน — idx = step ปัจจุบัน, total = จำนวน step */
export function BuildProgressCat(
  { current = 0, total = 1, progressPercent, walking, action, mood }: {
    current?: number; total?: number; progressPercent?: number;
    walking: boolean; action?: PixelCatAction; mood?: PixelCatMood;
  },
) {
  const pct = progressPercent === undefined
    ? (total > 1 ? getGenerationProgressPercent(current, total - 1) : 0)
    : getGenerationProgressPercent(progressPercent, 100);
  return (
    <div
      className="generation-build-progress relative h-12"
      style={{ "--generation-progress": `${pct}%` } as CSSProperties}
    >
      <div className="absolute transition-all duration-700 ease-in-out"
           style={{ left: `clamp(0px, calc(${pct}% - 24px), calc(100% - 64px))` }}>
        <PixelCat walking={walking} action={action} mood={mood} />
      </div>
    </div>
  );
}
