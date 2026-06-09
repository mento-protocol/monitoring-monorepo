"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Minimal popover for info-icon explainers. Hover / focus opens a real
 * tooltip, click / Enter / Space pins it for touch and keyboard users, and
 * Escape or click-outside closes it. Replaces the previous "tabbable button
 * that only sets a `title`" pattern, which was both a dead tab stop and
 * keyboard-inert (native `title` doesn't reveal on focus).
 *
 * Kept intentionally simple — no portal, no positioning library. Sized
 * and shaped to fit inside the pool-header cells where it's used.
 */
export function InfoPopover({
  label,
  content,
  children,
  tooltipAlign = "left",
  tooltipPlacement = "bottom",
  triggerClassName,
}: {
  label: string;
  content: ReactNode;
  children?: ReactNode;
  tooltipAlign?: "left" | "right";
  tooltipPlacement?: "bottom" | "top";
  triggerClassName?: string;
}) {
  const [state, setState] = useState({
    hovered: false,
    focused: false,
    pinned: false,
  });
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const isTextTrigger = children !== undefined;
  const open = state.hovered || state.focused || state.pinned;
  const defaultTriggerClassName = isTextTrigger
    ? "cursor-help font-medium text-inherit underline decoration-dotted decoration-slate-500/70 underline-offset-2 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500 focus:rounded"
    : "cursor-help text-xs text-slate-500 hover:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-500 focus:rounded";

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setState({ hovered: false, focused: false, pinned: false });
    };
    const onClickOutside = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-block"
      onMouseEnter={() => setState((s) => ({ ...s, hovered: true }))}
      onMouseLeave={() => setState((s) => ({ ...s, hovered: false }))}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? tooltipId : undefined}
        aria-describedby={open ? tooltipId : undefined}
        onBlur={() => setState((s) => ({ ...s, focused: false }))}
        onClick={() => setState((s) => ({ ...s, pinned: !s.pinned }))}
        onFocus={() => setState((s) => ({ ...s, focused: true }))}
        className={triggerClassName ?? defaultTriggerClassName}
      >
        {children ?? "ⓘ"}
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className={[
            "absolute z-20 w-72 whitespace-pre-line rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-left text-xs font-normal leading-relaxed text-slate-200 shadow-lg",
            tooltipAlign === "right" ? "right-0" : "left-0",
            tooltipPlacement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          ].join(" ")}
        >
          {content}
        </span>
      )}
    </span>
  );
}
