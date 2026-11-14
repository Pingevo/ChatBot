"use client";

import Image from "next/image";
import type { ComponentType } from "react";

export type PageIdentityKind =
  | "insights"
  | "inbox"
  | "workflow"
  | "knowledge"
  | "generation"
  | "testing"
  | "management"
  | "settings"
  | "support";

export function getPageIdentityKind(pathname: string): PageIdentityKind {
  if (pathname.startsWith("/analytics") || pathname === "/dashboard") return "insights";
  if (pathname.startsWith("/ticket") || pathname.startsWith("/chats") || pathname.startsWith("/shadow-inbox") || pathname.startsWith("/admin-chat-result")) return "inbox";
  if (pathname.startsWith("/knowledge") || pathname.startsWith("/zaapi-kb")) return "knowledge";
  if (pathname.startsWith("/workflows") || pathname.startsWith("/triggers") || pathname.startsWith("/quick-replies")) return "workflow";
  if (pathname.startsWith("/generations")) return "generation";
  if (pathname.startsWith("/test") || pathname.startsWith("/replay") || pathname.startsWith("/logs") || pathname.startsWith("/backlog")) return "testing";
  if (pathname.startsWith("/shops") || pathname.startsWith("/shop-settings") || pathname.startsWith("/contacts") || pathname.startsWith("/team") || pathname.startsWith("/users") || pathname.startsWith("/roles") || pathname.startsWith("/admin-review-kpi")) return "management";
  if (pathname.startsWith("/llm") || pathname.startsWith("/config") || pathname.startsWith("/admin-config") || pathname.startsWith("/settings") || pathname.startsWith("/persona")) return "settings";
  return "support";
}

export function PageIdentityMark({
  kind,
  icon: Icon,
  className = "",
}: {
  kind: PageIdentityKind;
  icon?: ComponentType<{ size?: number; className?: string }>;
  className?: string;
}) {
  return (
    <span className={`page-identity-mark ${className}`} aria-hidden="true">
      <Image
        src={`/page-identity/${kind}.png`}
        alt=""
        fill
        unoptimized
        sizes="40px"
        loading="lazy"
        className="page-identity-art"
      />
      {Icon && (
        <span className="page-identity-glyph">
          <Icon size={10} />
        </span>
      )}
    </span>
  );
}
