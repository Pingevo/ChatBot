"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectOptionsProps {
  id: string;
  label: string;
  value: string;
  options: SelectOption[];
  onSelect: (option: SelectOption) => void;
  onEscape: () => void;
  labelPrefix?: string;
}

export function SelectOptions({ id, label, value, options, onSelect, onEscape, labelPrefix }: SelectOptionsProps) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const initialFocusIndex = selectedIndex >= 0 ? selectedIndex : enabledIndices[0];

  useEffect(() => {
    optionRefs.current[initialFocusIndex]?.focus();
  }, [initialFocusIndex]);

  const moveFocus = (currentIndex: number, direction: "next" | "previous" | "first" | "last") => {
    if (enabledIndices.length === 0) return;
    if (direction === "first") return optionRefs.current[enabledIndices[0]]?.focus();
    if (direction === "last") return optionRefs.current[enabledIndices[enabledIndices.length - 1]]?.focus();
    const currentPosition = enabledIndices.indexOf(currentIndex);
    const nextPosition = direction === "next"
      ? (currentPosition + 1 + enabledIndices.length) % enabledIndices.length
      : (currentPosition - 1 + enabledIndices.length) % enabledIndices.length;
    optionRefs.current[enabledIndices[nextPosition]]?.focus();
  };

  return (
    <div id={id} className="select-options-list" role="listbox" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const firstEnabled = enabledIndices[0];
        return (
          <button
            key={option.value}
            ref={(element) => { optionRefs.current[index] = element; }}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={option.disabled}
            tabIndex={selected || (selectedIndex < 0 && index === firstEnabled) ? 0 : -1}
            onClick={() => onSelect(option)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(index, "next");
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(index, "previous");
              } else if (event.key === "Home") {
                event.preventDefault();
                moveFocus(index, "first");
              } else if (event.key === "End") {
                event.preventDefault();
                moveFocus(index, "last");
              } else if (event.key === "Escape") {
                event.preventDefault();
                onEscape();
              }
            }}
            className={`filter-select-option ${selected ? "is-selected" : ""}`}
          >
            <span className="filter-select-option-mark" aria-hidden="true">{selected && <Check size={15} />}</span>
            <span className="min-w-0 flex-1 truncate">{labelPrefix ? `${labelPrefix}${option.label}` : option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
