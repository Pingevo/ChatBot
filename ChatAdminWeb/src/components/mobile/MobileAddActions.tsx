"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";

export interface MobileAddAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export function MobileAddActions({ actions }: { actions: MobileAddAction[] }) {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const isSingleAction = actions.length === 1;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !dockRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  if (!mounted || actions.length === 0) return null;

  const selectAction = (action: MobileAddAction) => {
    setExpanded(false);
    action.onSelect();
  };

  return createPortal(
    <div
      ref={dockRef}
      className="mobile-add-dock"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
      }}
    >
      {expanded && !isSingleAction && (
        <div id={listId} className="mobile-add-action-list" role="group" aria-label="เลือกสิ่งที่จะเพิ่ม">
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              className="mobile-add-action-item"
              style={{ animationDelay: `${index * 35}ms` }}
              disabled={action.disabled}
              onClick={() => selectAction(action)}
            >
              <span className="mobile-add-action-icon" aria-hidden="true">{action.icon}</span>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className={`mobile-add-trigger ${expanded ? "is-expanded" : ""}`}
        aria-label={isSingleAction ? actions[0].label : expanded ? "ปิดตัวเลือกเพิ่ม" : "เพิ่มรายการใหม่"}
        aria-expanded={isSingleAction ? undefined : expanded}
        aria-controls={isSingleAction ? undefined : listId}
        title={isSingleAction ? actions[0].label : expanded ? "ปิดตัวเลือกเพิ่ม" : "เพิ่มรายการใหม่"}
        disabled={isSingleAction && actions[0].disabled}
        onClick={() => {
          if (isSingleAction) selectAction(actions[0]);
          else setExpanded((value) => !value);
        }}
      >
        {expanded && !isSingleAction ? <X size={21} /> : <Plus size={23} />}
      </button>
      {expanded && !isSingleAction && <span className="sr-only" aria-live="polite">เปิดตัวเลือกเพิ่มแล้ว</span>}
    </div>,
    document.body
  );
}
