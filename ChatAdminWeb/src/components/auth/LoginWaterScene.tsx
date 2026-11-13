"use client";

import WaterScene from "./water/WaterScene";
import styles from "./LoginWaterScene.module.css";

export default function LoginWaterScene({
  portalProgressRef,
  portalLightRef,
}: {
  portalProgressRef?: { current: number };
  portalLightRef?: { current: number };
}) {
  return (
    <div className={styles.scene} aria-hidden="true">
      <WaterScene subject="torii" loginMode portalProgressRef={portalProgressRef} portalLightRef={portalLightRef} />
    </div>
  );
}
