"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function DashboardMotion({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const phoneLayout = window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-height: 500px)").matches;
    if (!root || !phoneLayout || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let context: { revert: () => void } | undefined;
    let cancelled = false;
    import("gsap")
      .then(({ gsap }) => {
        if (cancelled || !root) return;
        context = gsap.context(() => {
          gsap.fromTo(
            root.querySelectorAll("[data-dashboard-reveal]"),
            { opacity: 0, y: 8, scale: 0.99 },
            {
              opacity: 1,
              y: 0,
              scale: 1,
              duration: 0.38,
              stagger: 0.035,
              ease: "power2.out",
              clearProps: "transform,opacity",
            }
          );
        }, root);
      })
      .catch(() => {
        // Dashboard content is already visible; motion is optional.
      });

    return () => {
      cancelled = true;
      context?.revert();
    };
  }, []);

  return <div ref={rootRef} className="dashboard-motion-root min-w-0">{children}</div>;
}
