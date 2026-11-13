"use client";

import { useEffect, useId, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Presentation = "center" | "sheet" | "fullscreen" | "image" | "workspace";

interface ModalLayerProps {
  children: ReactNode;
  className: string;
  presentation?: Presentation;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onBack?: () => void | boolean | Promise<void | boolean>;
}

let mobileModalCount = 0;
let mobileWorkspaceCount = 0;
let restoreScroll: (() => void) | null = null;

function lockPhoneScroll() {
  const content = document.querySelector<HTMLElement>("[data-app-content]");
  const bodyOverflow = document.body.style.overflow;
  const locked = content
    ? [content, ...Array.from(content.querySelectorAll<HTMLElement>("*"))]
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const scrollable = ["auto", "scroll", "overlay"].includes(style.overflowY);
          return scrollable && element.scrollHeight > element.clientHeight;
        })
        .map((element) => ({
          element,
          hadAttribute: element.hasAttribute("data-mobile-scroll-locked"),
        }))
    : [];

  document.body.style.overflow = "hidden";
  locked.forEach(({ element }) => element.setAttribute("data-mobile-scroll-locked", "true"));

  return () => {
    document.body.style.overflow = bodyOverflow;
    locked.forEach(({ element, hadAttribute }) => {
      if (!hadAttribute) element.removeAttribute("data-mobile-scroll-locked");
    });
  };
}

function acquirePhoneScrollLock() {
  if (mobileModalCount === 0) restoreScroll = lockPhoneScroll();
  mobileModalCount += 1;

  return () => {
    mobileModalCount = Math.max(0, mobileModalCount - 1);
    if (mobileModalCount === 0) {
      restoreScroll?.();
      restoreScroll = null;
    }
  };
}

function acquireMobileWorkspace() {
  mobileWorkspaceCount += 1;
  document.body.dataset.mobileWorkspaceOpen = "true";

  return () => {
    mobileWorkspaceCount = Math.max(0, mobileWorkspaceCount - 1);
    if (mobileWorkspaceCount === 0) delete document.body.dataset.mobileWorkspaceOpen;
  };
}

export function ModalLayer({ children, className, presentation = "center", onClick, onBack }: ModalLayerProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [phoneLayout, setPhoneLayout] = useState(false);
  const workspaceToken = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-height: 500px)");
    const update = () => setPhoneLayout(media.matches);

    update();
    media.addEventListener("change", update);
    setHost(document.body);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!host || !phoneLayout) return;
    return acquirePhoneScrollLock();
  }, [host, phoneLayout]);

  useEffect(() => {
    if (!host || !phoneLayout || (presentation !== "workspace" && presentation !== "sheet")) return;
    return acquireMobileWorkspace();
  }, [host, phoneLayout, presentation]);

  useEffect(() => {
    if (!host || !phoneLayout || (presentation !== "workspace" && presentation !== "sheet")) return;

    const openedPath = window.location.pathname;
    const marker = `mobile-workspace-${workspaceToken}`;
    window.history.pushState({ ...window.history.state, mobileWorkspace: marker }, "", window.location.href);
    let returnedThroughBack = false;
    let disposed = false;

    const handlePopState = async () => {
      if (window.location.pathname !== openedPath || window.history.state?.mobileWorkspace === marker) return;
      returnedThroughBack = true;
      const close = onBackRef.current;
      if (!close) {
        window.history.pushState({ ...window.history.state, mobileWorkspace: marker }, "", window.location.href);
        returnedThroughBack = false;
        return;
      }

      const result = await close();
      if (result === false && !disposed && window.location.pathname === openedPath) {
        window.history.pushState({ ...window.history.state, mobileWorkspace: marker }, "", window.location.href);
        returnedThroughBack = false;
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      disposed = true;
      window.removeEventListener("popstate", handlePopState);
      if (!returnedThroughBack && window.location.pathname === openedPath && window.history.state?.mobileWorkspace === marker) {
        window.history.back();
      }
    };
  }, [host, phoneLayout, presentation, workspaceToken]);

  if (!host) return null;

  return createPortal(
    <div
      className={`mobile-modal-viewport ${className}`}
      data-mobile-modal-presentation={presentation}
      data-mobile-modal-root
      onClick={onClick}
    >
      {children}
    </div>,
    host
  );
}
