// Satori JSX for the peg-monitoring Open Graph card.
//
// This folder is the render layer and `_lib/` is the logic layer: nothing here
// is imported by the page, and nothing from `_components/` (which is `"use
// client"`) may be imported here — a client module entering the OG import
// graph breaks the route.

import type { PegBoardTone } from "../_lib/peg-board-model";

// The board's own palette, resolved to sRGB hex. Satori parses neither the
// `oklch()` literals in `peg-board-model.ts` nor the design-system custom
// properties the page reads them through, so the card carries the resolved
// values. Keep these in step with `PEG_COLOR` when that block moves.
export const BG = "#070010";

export const SURFACE = "#15111b";

export const HAIRLINE = "#272130";

export const TEXT = "#f9f8fc";

export const TEXT_2 = "#ceccd3";

export const MUTED = "#8d8b92";

export const DIM = "#6b6673";

const GREEN = "#1ecc09";

export const AMBER = "#fe9900";

export const RED_TEXT = "#f05751";

export const OFF_SCALE = "#bb5850";

export const PURPLE = "#7005fc";

// Weights land now that `ogFontOptions()` hands Satori real Geist faces
// (400/600/700/800). This card was originally authored weight-free because the
// fallback ships one weight and `fontWeight` silently did nothing; hierarchy
// leans on size and colour first, with weight added back only where it earns
// the emphasis — pair, price, status and the verdict pill.
export const TONE_COLOR: Record<PegBoardTone, string> = {
  healthy: GREEN,
  warning: AMBER,
  uncertain: AMBER,
  critical: RED_TEXT,
};

export const TICK_COLOR = {
  critical: RED_TEXT,
  warn: AMBER,
  target: TEXT_2,
} as const;

export const TONE_TINT: Record<PegBoardTone, { bg: string; border: string }> = {
  healthy: { bg: "rgba(30,204,9,0.12)", border: "rgba(30,204,9,0.38)" },
  warning: { bg: "rgba(254,153,0,0.12)", border: "rgba(254,153,0,0.38)" },
  uncertain: { bg: "rgba(254,153,0,0.12)", border: "rgba(254,153,0,0.38)" },
  critical: { bg: "rgba(201,44,44,0.16)", border: "rgba(201,44,44,0.48)" },
};
