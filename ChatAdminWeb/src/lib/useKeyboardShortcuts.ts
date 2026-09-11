// useKeyboardShortcuts — reusable keyboard shortcut hooks
// ใช้: const { focusSearch } = useSearchShortcut(searchRef);
//       useGlobalShortcut("/", () => focusSearch());

"use client";
import { useEffect, useCallback, useState, useRef } from "react";

/**
 * useSearchShortcut — press "/" to focus a search input (like GitHub/Slack)
 * @param ref React ref to the search input element
 * @returns void
 */
export function useSearchShortcut<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Don't intercept when typing in an input/textarea
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        e.preventDefault();
        ref.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [ref]);
}

/**
 * useEscToClear — press Escape in a search input to clear it
 * @param value current search value
 * @param onClear callback to clear the search
 * @returns function to attach to onKeyDown
 */
export function useEscToClear(onClear: () => void) {
  return useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClear();
    }
  }, [onClear]);
}

/**
 * useListboxNav — arrow-key navigation for custom dropdown listboxes.
 * Returns activeIndex and a keydown handler to attach to the listbox container.
 * On Enter/Space, calls onSelect with the option at activeIndex.
 * On ArrowDown/ArrowUp, moves activeIndex within [0, count-1].
 * On Escape, calls onClose.
 */
export function useListboxNav(count: number, onSelect: (index: number) => void, onClose: () => void) {
  const [activeIndex, setActiveIndex] = useState(0);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < count) onSelect(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }, [count, activeIndex, onSelect, onClose]);
  return { activeIndex, setActiveIndex, onKeyDown };
}

/**
 * useFocusTrap — traps focus within a modal/dialog and restores focus on unmount.
 * Pass a ref to the modal container. On mount, focuses the container.
 * Traps Tab/Shift+Tab within the container's focusable elements.
 * On unmount, restores focus to the element that had focus before the modal opened.
 */
export function useFocusTrap<T extends HTMLElement>(isOpen: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the container (or first focusable inside) after a tick
    const timer = setTimeout(() => {
      const container = ref.current;
      if (!container) return;
      const focusable = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        container.focus();
      }
    }, 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const container = ref.current;
      if (!container) return;
      const focusable = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(timer);
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);
  return ref;
}
