"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import Image from "next/image";

type SceneProps = { onReady: () => void; onUnavailable: () => void };
type SceneComponent = ComponentType<SceneProps>;

function canUseOptionalScene(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;

  const navigatorWithHints = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (navigatorWithHints.connection?.saveData) return false;
  if ((navigatorWithHints.deviceMemory ?? 8) <= 2 || navigator.hardwareConcurrency <= 2) return false;

  try {
    const probe = document.createElement("canvas");
    const context = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function DashboardCompanion() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [Scene, setScene] = useState<SceneComponent | null>(null);
  const [sceneFailed, setSceneFailed] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const handleReady = useCallback(() => setSceneReady(true), []);
  const handleUnavailable = useCallback(() => {
    setSceneReady(false);
    setScene(null);
    setSceneFailed(true);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const near = Boolean(entry?.isIntersecting);
        setNearViewport(near);
        if (!near) setSceneReady(false);
      },
      { rootMargin: "120px", threshold: 0.05 }
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport || Scene || sceneFailed || !canUseOptionalScene()) return;

    let cancelled = false;
    let timer: number | undefined;
    let idleId: number | undefined;
    const load = () => {
      import("./PixelCompanionScene")
        .then((module) => {
          if (!cancelled) setScene(() => module.PixelCompanionScene);
        })
        .catch(() => {
          // The generated static sprite remains visible if the scene fails.
          if (!cancelled) setSceneFailed(true);
        });
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(load, { timeout: 1200 });
    else timer = window.setTimeout(load, 350);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [nearViewport, Scene, sceneFailed]);

  return (
    <div ref={rootRef} className="dashboard-companion relative h-24 w-24 shrink-0" aria-hidden="true">
      <Image
        src="/mascot/cat-girl-pixel.png"
        width={96}
        height={96}
        alt=""
        className={`absolute inset-0 h-full w-full object-contain [image-rendering:pixelated] transition-opacity duration-300 ${sceneReady ? "opacity-0" : "opacity-100"}`}
      />
      {Scene && nearViewport && (
        <Scene
          onReady={handleReady}
          onUnavailable={handleUnavailable}
        />
      )}
    </div>
  );
}
