"use client";
// /login — SSO login page
// ปุ่ม "เข้าสู่ระบบด้วย SSO" จะ redirect ไป /api/auth/sso/login → system81 login
import { Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import styles from "@/components/auth/LoginPage.module.css";

const LoginWaterScene = dynamic(() => import("@/components/auth/LoginWaterScene"), { ssr: false });
const SSO_LOGIN_URL = "/api/auth/sso/login";

const ERROR_MESSAGES: Record<string, string> = {
  sso_failed: "การเข้าสู่ระบบผ่าน ITSR ไม่สำเร็จ กรุณาลองใหม่",
  no_token: "ไม่ได้รับ token จาก ITSR กรุณาลองใหม่",
  userinfo_failed: "ไม่สามารถตรวจสอบ token กับ ITSR ได้",
  invalid_token: "ITSR token ไม่ถูกต้อง",
  not_allowed: "บัญชี ITSR นี้ไม่มีสิทธิ์เข้าถึง Chat Admin",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ",
};

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, initialized, fetchMe } = useAuth();
  const [entering, setEntering] = useState(false);
  const enteringRef = useRef(false);
  const portalProgressRef = useRef(0);
  const portalLightRef = useRef(0);
  const sceneWrapRef = useRef<HTMLDivElement | null>(null);
  const shadeRef = useRef<HTMLDivElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);
  const bloomRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<{ kill: () => void } | null>(null);
  const mistFlowRef = useRef<{ kill: () => void; pause: () => void; resume: () => void } | null>(null);
  const motionVisibilityCleanupRef = useRef<(() => void) | null>(null);
  const errorCode = searchParams.get("error");
  const errorMsg = errorCode ? ERROR_MESSAGES[errorCode] || "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" : null;

  async function beginSso(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (enteringRef.current) return;
    enteringRef.current = true;
    setEntering(true);
    const href = event.currentTarget.href;
    portalProgressRef.current = 0;
    portalLightRef.current = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.location.assign(href);
      return;
    }

    try {
      const { gsap } = await import("gsap");
      const sceneWrap = sceneWrapRef.current;
      const shade = shadeRef.current;
      const portal = portalRef.current;
      const core = coreRef.current;
      const bloom = bloomRef.current;
      if (!sceneWrap || !shade || !portal || !core || !bloom) {
        window.location.assign(href);
        return;
      }

      const warp = { progress: 0 };
      const emergence = { progress: 0 };
      let handoffState: {
        angle: number;
        scene: { rotationX: number; rotationY: number; rotationZ: number; x: number; y: number; scale: number };
        shade: { opacity: number; x: number; y: number };
        bloom: { opacity: number; x: number; y: number };
        light: number;
        slowBreath: number;
        lightShimmer: number;
      } | null = null;
      gsap.set(sceneWrap, {
        transformOrigin: "50% 45%",
        transformPerspective: 1050,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        scale: 1,
        opacity: 1,
        force3D: true,
      });
      gsap.set(shade, { opacity: 0 });
      gsap.set(portal, { opacity: 1 });
      gsap.set(core, { xPercent: -50, yPercent: -50, transformOrigin: "50% 50%", scale: 0.12, opacity: 0 });
      gsap.set(bloom, { xPercent: -50, yPercent: -50, transformOrigin: "50% 50%", x: 0, y: 0, rotation: 0, scale: 0.55, opacity: 0 });
      const syncDistortion = () => {
        const progress = warp.progress;
        const smooth = (from: number, to: number, value: number) => {
          const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
          return t * t * (3 - 2 * t);
        };
        const entry = 1 - smooth(0.025, 0.20, progress);
        const exit = smooth(0.77, 1, progress);
        const middle = smooth(0.12, 0.30, progress) * (1 - smooth(0.74, 0.90, progress));
        const cameraDive = smooth(0.025, 0.86, progress);
        const cameraRoll = smooth(0.16, 0.72, progress) * (1 - smooth(0.90, 1, progress) * 0.42);
        const pulse = 0.5 + 0.5 * Math.sin(progress * 26 + Math.sin(progress * 8) * 0.6);
        const light = Math.max(0.065 + middle * (0.07 + pulse * 0.08), 0.72 * entry, 1.55 * exit);
        portalProgressRef.current = warp.progress;
        portalLightRef.current = light;
        gsap.set(shade, {
          opacity: smooth(0.02, 0.24, progress) * (0.70 - 0.16 * exit),
          "--shade-x": `${50 + Math.sin(progress * 11) * 5}%`,
          "--shade-y": `${45 + Math.cos(progress * 9) * 5}%`,
        });
        gsap.set(sceneWrap, {
          rotationX: cameraRoll * 5.2 + Math.sin(progress * 8.2) * 0.72 * cameraRoll,
          rotationY: cameraRoll * -8.4 + Math.sin(progress * 6.1 + 0.8) * 0.86 * cameraRoll,
          rotationZ: Math.sin(progress * 7.4 + 0.4) * 1.05 * cameraRoll,
          x: Math.sin(progress * 7.2) * 10 * cameraRoll,
          y: -cameraDive * 31 + Math.sin(progress * Math.PI * 2.1) * 9 * cameraRoll,
          scale: 1 + cameraDive * 1.22,
          opacity: 1 - exit * 0.10,
        });
        gsap.set(bloom, {
          opacity: 0.70 * entry + middle * (0.23 + pulse * 0.28) + 0.72 * exit,
          scale: 0.72 + 0.38 * entry + progress * 0.32 + exit * 0.82 + middle * pulse * 0.2,
        });
        gsap.set(core, { opacity: middle * 0.16 + exit * 0.05, scale: 0.16 + progress * 2.49 });
      };

      const mistMotion = { angle: 0 };
      mistFlowRef.current?.kill();
      mistFlowRef.current = gsap.to(mistMotion, {
        angle: Math.PI * 2,
        duration: 8.2,
        ease: "none",
        repeat: -1,
        onUpdate: () => {
          const angle = mistMotion.angle;
          const slowBreath = Math.sin(angle * 0.62 - 0.75);
          const lightShimmer = 0.5 + 0.5 * Math.sin(angle * 1.35 + 1.1);
          if (handoffState) {
            const bob = Math.sin(angle);
            const breathDelta = slowBreath - handoffState.slowBreath;
            const shimmerDelta = lightShimmer - handoffState.lightShimmer;
            gsap.set(bloom, {
              x: handoffState.bloom.x + (Math.sin(angle * 0.9) - Math.sin(handoffState.angle * 0.9)) * 18,
              y: handoffState.bloom.y + (Math.cos(angle * 1.1) - Math.cos(handoffState.angle * 1.1)) * 26,
              opacity: handoffState.bloom.opacity + emergence.progress * 0.16 + breathDelta * 0.08 + shimmerDelta * 0.04,
            });
            gsap.set(sceneWrap, {
              rotationX: handoffState.scene.rotationX * (1 - emergence.progress)
                + (Math.sin(angle * 0.52) - Math.sin(handoffState.angle * 0.52)) * 0.5,
              rotationY: handoffState.scene.rotationY * (1 - emergence.progress)
                + (Math.sin(angle * 0.68) - Math.sin(handoffState.angle * 0.68)) * 0.65,
              rotationZ: handoffState.scene.rotationZ * (1 - emergence.progress)
                + (Math.sin(angle * 0.38) - Math.sin(handoffState.angle * 0.38)) * 0.3,
              x: handoffState.scene.x * (1 - emergence.progress)
                + (Math.sin(angle * 0.48) - Math.sin(handoffState.angle * 0.48)) * 5,
              y: handoffState.scene.y + (bob - Math.sin(handoffState.angle)) * 9,
              scale: handoffState.scene.scale + emergence.progress * 0.035
                + (Math.sin(angle + 0.4) - Math.sin(handoffState.angle + 0.4)) * 0.022,
            });
            gsap.set(shade, {
              opacity: handoffState.shade.opacity + emergence.progress * 0.1 + breathDelta * 0.035,
              "--shade-x": `${handoffState.shade.x + (Math.sin(angle * 0.31) - Math.sin(handoffState.angle * 0.31)) * 3}%`,
              "--shade-y": `${handoffState.shade.y + (Math.cos(angle * 0.27) - Math.cos(handoffState.angle * 0.27)) * 3}%`,
            });
            portalLightRef.current = handoffState.light + emergence.progress * 0.12 + breathDelta * 0.32 + shimmerDelta * 0.2;
          } else {
            gsap.set(bloom, {
              x: Math.sin(angle * 0.9) * 18,
              y: Math.cos(angle * 1.1) * 26,
            });
          }
        },
      });
      const syncMotionVisibility = () => {
        if (document.hidden) mistFlowRef.current?.pause();
        else mistFlowRef.current?.resume();
      };
      document.addEventListener("visibilitychange", syncMotionVisibility);
      motionVisibilityCleanupRef.current = () => document.removeEventListener("visibilitychange", syncMotionVisibility);
      syncMotionVisibility();

      timelineRef.current = gsap.timeline({
        onComplete: () => {
          const angle = mistMotion.angle;
          handoffState = {
            angle,
            scene: {
              rotationX: Number(gsap.getProperty(sceneWrap, "rotationX")),
              rotationY: Number(gsap.getProperty(sceneWrap, "rotationY")),
              rotationZ: Number(gsap.getProperty(sceneWrap, "rotationZ")),
              x: Number(gsap.getProperty(sceneWrap, "x")),
              y: Number(gsap.getProperty(sceneWrap, "y")),
              scale: Number(gsap.getProperty(sceneWrap, "scale")),
            },
            shade: {
              opacity: Number(gsap.getProperty(shade, "opacity")),
              x: Number.parseFloat(window.getComputedStyle(shade).getPropertyValue("--shade-x")) || 50,
              y: Number.parseFloat(window.getComputedStyle(shade).getPropertyValue("--shade-y")) || 45,
            },
            bloom: {
              opacity: Number(gsap.getProperty(bloom, "opacity")),
              x: Number(gsap.getProperty(bloom, "x")),
              y: Number(gsap.getProperty(bloom, "y")),
            },
            light: portalLightRef.current,
            slowBreath: Math.sin(angle * 0.62 - 0.75),
            lightShimmer: 0.5 + 0.5 * Math.sin(angle * 1.35 + 1.1),
          };
          gsap.to(emergence, {
            progress: 1,
            duration: 1.15,
            ease: "power2.out",
            onComplete: () => window.location.assign(href),
          });
        },
      })
        .to(warp, { progress: 1, duration: 3.85, ease: "power3.inOut", onUpdate: syncDistortion }, 0);
    } catch {
      window.location.assign(href);
    }
  }

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && user) router.replace("/dashboard");
  }, [initialized, user, router]);

  useEffect(() => () => {
    timelineRef.current?.kill();
    mistFlowRef.current?.kill();
    motionVisibilityCleanupRef.current?.();
    portalProgressRef.current = 0;
    portalLightRef.current = 0;
  }, []);

  if (initialized && user) {
    return (
      <main className={`${styles.page} auth-gradient-bg`} aria-label="กำลังเข้าสู่ระบบ">
        <div className={styles.sceneWrap}><LoginWaterScene /></div>
        <div className={styles.shade} />
      </main>
    );
  }

  return (
    <main
      className={`${styles.page} auth-gradient-bg${entering ? ` ${styles.entering}` : ""}`}
      data-portal-transition={entering ? "active" : "idle"}
      aria-busy={entering}
    >
      <div className={styles.sceneWrap} ref={sceneWrapRef}><LoginWaterScene portalProgressRef={portalProgressRef} portalLightRef={portalLightRef} /></div>
      <div className={styles.shade} ref={shadeRef} />
      <a className={styles.fullPageLink} href={SSO_LOGIN_URL} onClick={beginSso} aria-label="คลิกที่ใดก็ได้เพื่อเข้าสู่ระบบด้วย SSO ผ่านประตูโทริอิ" aria-describedby="weather-attribution" aria-disabled={entering}>
        {errorMsg && <span className={styles.srOnly} role="alert">{errorMsg}</span>}
      </a>
      <span className={styles.srOnly} id="weather-attribution">
        Weather effects use Open-Meteo data when configured and are adapted under CC BY 4.0. License: https://open-meteo.com/en/license.
      </span>
      <div className={styles.portalLayer} ref={portalRef} aria-hidden="true">
        <div className={styles.portalCore} ref={coreRef} />
        <div className={styles.portalBloom} ref={bloomRef} />
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <main className={styles.fallback} aria-label="กำลังเปิดหน้าเข้าสู่ระบบ">
      </main>
    }>
      <LoginContent />
    </Suspense>
  );
}
