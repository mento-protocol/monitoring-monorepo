"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Minimal popover for info-icon explainers. Click / Enter / Space toggles
 * an inline tooltip carrying the explainer text; Escape and click-outside
 * close it. Replaces the previous "tabbable button that only sets a
 * `title`" pattern, which was both a dead tab stop and keyboard-inert
 * (native `title` doesn't reveal on focus).
 *
 * Kept intentionally simple — no portal, no positioning library. Sized
 * and shaped to fit inside the pool-header cells where it's used.
 */
export function InfoPopover({
  label,
  content,
}: {
  label: string;
  content: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={content}
        onClick={() => setOpen((o) => !o)}
        className="cursor-help text-xs text-slate-500 hover:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-500 focus:rounded"
      >
        ⓘ
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-20 left-0 top-full mt-1 w-72 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-normal leading-relaxed text-slate-200 shadow-lg"
        >
          {content}
        </span>
      )}
    </span>
  );
}
