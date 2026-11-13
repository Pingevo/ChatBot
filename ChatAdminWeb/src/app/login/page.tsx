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
      gsap.set(sceneWrap, {
        transformOrigin: "50% 45%",
        transformPerspective: 1300,
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
          rotationX: smooth(0.86, 0.98, progress) * 2.2,
          rotationY: smooth(0.86, 0.98, progress) * -3.2,
          rotationZ: 0,
          x: Math.sin(progress * 6.2) * 5,
          y: -progress * 12 + Math.sin(progress * Math.PI * 2.4) * 6,
          scale: 1 + progress * 0.45,
          opacity: 1 - exit * 0.10,
        });
        gsap.set(bloom, {
          opacity: 0.66 * entry + middle * (0.20 + pulse * 0.25) + 0.68 * exit,
          scale: 0.8 + 0.32 * entry + progress * 0.45 + exit * 1.0 + middle * pulse * 0.18,
        });
        gsap.set(core, { opacity: middle * 0.14 + exit * 0.04, scale: 0.18 + progress * 3.8 });
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
          const floating = warp.progress >= 0.97;
          const slowBreath = Math.sin(angle * 0.62 - 0.75);
          const lightShimmer = 0.5 + 0.5 * Math.sin(angle * 1.35 + 1.1);
          gsap.set(bloom, {
            rotation: Math.sin(angle) * 14,
            x: Math.sin(angle * 0.9) * 18,
            y: Math.cos(angle * 1.1) * 26,
            ...(floating && { opacity: 0.46 + emergence.progress * 0.08 + slowBreath * 0.14 + (lightShimmer - 0.5) * 0.08 }),
          });
          if (floating) {
            const bob = Math.sin(angle);
            gsap.set(sceneWrap, {
              rotationX: 2.2 * (1 - emergence.progress) + Math.sin(angle * 0.52) * 0.7,
              rotationY: -3.2 * (1 - emergence.progress) + Math.sin(angle * 0.68) * 0.65,
              rotationZ: Math.sin(angle * 0.38) * 0.3,
              x: Math.sin(angle * 0.48) * 3.5,
              y: -12 + bob * 8,
              scale: 1.45 + emergence.progress * 0.025 + Math.sin(angle + 0.4) * 0.018,
            });
            gsap.set(shade, {
              opacity: 0.69 + slowBreath * 0.075,
              "--shade-x": `${50 + Math.sin(angle * 0.31) * 3}%`,
              "--shade-y": `${45 + Math.cos(angle * 0.27) * 3}%`,
            });
            portalLightRef.current = 0.98 + emergence.progress * 0.16 + slowBreath * 0.42 + (lightShimmer - 0.5) * 0.24;
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
          gsap.to(emergence, {
            progress: 1,
            duration: 1.15,
            ease: "power2.out",
            onComplete: () => window.location.assign(href),
          });
        },
      })
        .to(warp, { progress: 1, duration: 3.85, ease: "power2.inOut", onUpdate: syncDistortion }, 0);
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
