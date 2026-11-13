"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export function PixelCompanionScene({
  onReady,
  onUnavailable,
}: {
  onReady: () => void;
  onUnavailable: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
    } catch {
      onUnavailable();
      return;
    }

    const size = 160;
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "h-full w-full [image-rendering:pixelated]";
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 20);
    camera.position.set(0, 1.45, 5.6);
    camera.lookAt(0, 1.25, 0);

    const stage = new THREE.Group();
    const portrait = new THREE.Group();
    scene.add(stage, portrait);

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(1.12, 12),
      new THREE.MeshBasicMaterial({ color: 0xdce5ee, transparent: true, opacity: 0.72, depthWrite: false })
    );
    halo.position.set(0, 1.35, -0.32);
    stage.add(halo);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 12),
      new THREE.MeshBasicMaterial({ color: 0x0b2340, transparent: true, opacity: 0.18, depthWrite: false })
    );
    shadow.position.set(0, 0.13, 0.12);
    shadow.scale.set(0.72, 0.16, 1);
    stage.add(shadow);

    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.14, 0.72),
      new THREE.MeshLambertMaterial({ color: 0xf4ead8 })
    );
    platform.position.set(0, 0.09, 0.02);
    stage.add(platform);

    const sparkle = (color: number, position: [number, number, number], scale: number) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(scale, scale, 0.06),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 })
      );
      mesh.position.set(...position);
      stage.add(mesh);
      return mesh;
    };
    const sparkles = [
      sparkle(0x8b1e28, [-1.04, 1.88, 0.12], 0.12),
      sparkle(0x0b2340, [1.02, 1.48, 0.08], 0.09),
      sparkle(0xf4ead8, [0.92, 2.16, -0.12], 0.11),
    ];

    let disposed = false;
    let active = true;
    let frame = 0;
    let ready = false;
    let texture: THREE.Texture | undefined;
    let gsapContext: { revert: () => void } | undefined;

    const draw = () => {
      if (!active || !ready || disposed) return;
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(draw);
    };

    const contextLost = (event: Event) => {
      event.preventDefault();
      active = false;
      if (!disposed) onUnavailable();
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);

    new THREE.TextureLoader().load(
      "/mascot/cat-girl-pixel.png",
      (loadedTexture) => {
        if (disposed) {
          loadedTexture.dispose();
          return;
        }
        texture = loadedTexture;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;

        const portraitMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          alphaTest: 0.02,
          side: THREE.DoubleSide,
          depthWrite: false,
          toneMapped: false,
        });
        const image = new THREE.Mesh(new THREE.PlaneGeometry(2.25, 2.32), portraitMaterial);
        image.position.set(0, 1.3, 0.18);
        portrait.add(image);
        ready = true;
        onReady();
        draw();

        import("gsap")
          .then(({ gsap }) => {
            if (disposed || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            gsapContext = gsap.context(() => {
              gsap.to(portrait.rotation, { y: 0.13, z: 0.018, duration: 2.1, repeat: -1, yoyo: true, ease: "sine.inOut" });
              gsap.to(portrait.position, { y: 0.035, duration: 1.6, repeat: -1, yoyo: true, ease: "sine.inOut" });
              gsap.to(shadow.scale, { x: 0.63, y: 0.14, duration: 1.6, repeat: -1, yoyo: true, ease: "sine.inOut" });
              gsap.to(sparkles[0].rotation, { z: Math.PI / 4, duration: 2.4, repeat: -1, yoyo: true, ease: "sine.inOut" });
              gsap.to(sparkles[1].position, { y: 1.56, duration: 1.9, repeat: -1, yoyo: true, ease: "sine.inOut" });
              gsap.to(sparkles[2].material, { opacity: 0.5, duration: 1.25, repeat: -1, yoyo: true, ease: "sine.inOut" });
            });
          })
          .catch(() => {
            // The original pixel-art portrait remains visible without optional motion.
          });
      },
      undefined,
      () => {
        if (!disposed) onUnavailable();
      }
    );

    const visibility = new IntersectionObserver(([entry]) => {
      active = Boolean(entry?.isIntersecting);
      if (active && ready && frame === 0) draw();
      if (!active && frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    visibility.observe(host);

    return () => {
      disposed = true;
      active = false;
      if (frame) window.cancelAnimationFrame(frame);
      visibility.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      gsapContext?.revert();
      scene.traverse((item) => {
        if (item instanceof THREE.Mesh) {
          item.geometry.dispose();
          const itemMaterials = Array.isArray(item.material) ? item.material : [item.material];
          itemMaterials.forEach((material) => material.dispose());
        }
      });
      texture?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [onReady, onUnavailable]);

  return <div ref={hostRef} className="absolute inset-0 overflow-hidden" aria-hidden="true" />;
}
