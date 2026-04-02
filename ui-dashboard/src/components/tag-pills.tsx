"use client";

import { useRef, useState, useEffect, useCallback } from "react";

type TagPillsProps = {
  tags: string[];
  /** Max height in px before overflow kicks in. Defaults to 48 (roughly 2 rows). */
  maxHeight?: number;
};

export function TagPills({ tags, maxHeight = 48 }: TagPillsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);

  const recalc = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Count how many pill children are fully or partially hidden by overflow.
    const children = Array.from(container.children) as HTMLElement[];
    // Exclude the overflow indicator itself (last child when hiddenCount > 0).
    const pills = children.filter((c) => !c.dataset.overflow);
    let hidden = 0;
    const bottom = container.getBoundingClientRect().top + maxHeight;
    for (const pill of pills) {
      const rect = pill.getBoundingClientRect();
      if (rect.bottom > bottom + 1) {
        hidden++;
      }
    }
    setHiddenCount(hidden);
  }, [maxHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => recalc());
    ro.observe(container);
    // Initial calculation via rAF to satisfy the no-direct-set-state-in-useEffect rule
    const raf = requestAnimationFrame(() => recalc());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [recalc, tags]);

  if (tags.length === 0) return null;

  const tooltipText = tags.join(", ");

  return (
    <div className="flex flex-wrap items-start gap-1" title={tooltipText}>
      <div
        ref={containerRef}
        className="flex flex-wrap gap-1 overflow-hidden"
        style={{ maxHeight }}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center rounded-full bg-slate-700 px-2 py-0.5 text-[10px] font-medium text-slate-300 whitespace-nowrap"
          >
            {tag}
          </span>
        ))}
      </div>
      {hiddenCount > 0 && (
        <span
          data-overflow="true"
          className="inline-flex items-center rounded-full bg-slate-600 px-2 py-0.5 text-[10px] font-medium text-slate-200 whitespace-nowrap"
          aria-label={`${hiddenCount} more tags: ${tooltipText}`}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}
