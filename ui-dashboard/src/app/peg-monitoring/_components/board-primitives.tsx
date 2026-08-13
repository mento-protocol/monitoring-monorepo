"use client";

import type { CSSProperties, ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  PEG_COLOR,
  PEG_TONE_COLOR,
  type PegBoardTone,
} from "../_lib/peg-board-model";

/**
 * Radix Tooltip is used directly rather than through `@mento-protocol/ui`:
 * the design system compiles to one flat `dist/index.js` whose top-level
 * imports (tiptap, recharts, anime.js) defeat tree-shaking — importing its
 * Tooltip re-export measured +189 KB brotli of client JS against the bundle
 * budget. The DS's Tooltip is itself this same Radix primitive; the package
 * stays a dependency for `theme.css` (tokens + AspektaVF), which is CSS-only.
 *
 * Radix portals tooltip content to `document.body`, outside the `.dark` scope
 * that defines the design-system tokens, so the panel's colours are literal.
 * The design system's own `TooltipContent` classes are not compiled into this
 * app's Tailwind pass (see the note in `globals.css`), which is why the visual
 * recipe lives here rather than in the package default.
 */
const tooltipPanelStyle: CSSProperties = {
  backgroundColor: PEG_COLOR.surface,
  borderColor: PEG_COLOR.borderStrong,
  color: PEG_COLOR.text2,
  fontFamily: '"AspektaVF", var(--font-geist-sans), sans-serif',
};

export function PegTooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 w-fit max-w-[320px] border px-3 py-2 text-[11.5px] leading-[1.55]"
          style={tooltipPanelStyle}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** 13px circular ⓘ affordance carrying an explanatory tooltip. */
export function InfoDot({
  label,
  content,
}: {
  label: string;
  content: ReactNode;
}): React.JSX.Element {
  return (
    <PegTooltip content={content}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-[13px] shrink-0 cursor-help items-center justify-center rounded-full border border-[var(--border-secondary)] text-[9px] leading-none text-muted-foreground"
      >
        i
      </button>
    </PegTooltip>
  );
}

const linkClass =
  "underline decoration-[oklch(45%_0.02_302)] underline-offset-[3px] hover:decoration-current";

export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${linkClass} ${className}`}
    >
      {children} ↗
    </a>
  );
}

export { linkClass as pegLinkClass };

export function SeverityDot({
  tone,
  size = 6,
  color,
}: {
  tone?: PegBoardTone | undefined;
  size?: number | undefined;
  color?: string | undefined;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: color ?? PEG_TONE_COLOR[tone ?? "healthy"],
      }}
    />
  );
}

const badgeTint: Record<PegBoardTone, CSSProperties> = {
  healthy: {
    color: PEG_COLOR.green,
    backgroundColor: "oklch(73.5% 0.245 142 / 0.12)",
    borderColor: "oklch(73.5% 0.245 142 / 0.35)",
  },
  warning: {
    color: PEG_COLOR.amber,
    backgroundColor: "oklch(76.9% 0.188 70 / 0.12)",
    borderColor: "oklch(76.9% 0.188 70 / 0.35)",
  },
  uncertain: {
    color: PEG_COLOR.amber,
    backgroundColor: "oklch(76.9% 0.188 70 / 0.12)",
    borderColor: "oklch(76.9% 0.188 70 / 0.35)",
  },
  critical: {
    color: PEG_COLOR.redText,
    backgroundColor: "oklch(54.7% 0.193 26.4 / 0.16)",
    borderColor: "oklch(54.7% 0.193 26.4 / 0.45)",
  },
};

/**
 * The board's own badge rather than the design-system `Badge`: its variants
 * (default/secondary/outline/destructive) carry no healthy/warning tone pair.
 */
export function StatusBadge({
  label,
  tone,
  detail,
  testId,
}: {
  label: string;
  tone: PegBoardTone;
  detail?: string | null | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  const className =
    "inline-flex border px-[9px] py-[3px] text-[11px] font-bold leading-none";
  return detail ? (
    <PegTooltip content={detail}>
      <button
        type="button"
        data-testid={testId}
        className={`${className} cursor-help`}
        style={badgeTint[tone]}
      >
        {label}
      </button>
    </PegTooltip>
  ) : (
    <span data-testid={testId} className={className} style={badgeTint[tone]}>
      {label}
    </span>
  );
}

/** Value line over a dimmer "checked X ago" line — the board's cell pattern. */
export function TwoLineCell({
  value,
  age,
  stale = false,
}: {
  value: ReactNode;
  age: string | null;
  stale?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12.5px] text-[var(--peg-text-2)]">
        {value}
      </div>
      {age === null ? null : (
        <div
          className="mt-[3px] truncate text-[11px]"
          style={{ color: stale ? PEG_COLOR.amber : PEG_COLOR.dim }}
        >
          {stale ? `${age} · stale` : age}
        </div>
      )}
    </div>
  );
}
