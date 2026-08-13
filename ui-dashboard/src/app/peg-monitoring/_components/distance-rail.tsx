"use client";

import {
  PEG_COLOR,
  PEG_RAIL_GRADIENT,
  PEG_TONE_COLOR,
  type PegBoardTone,
  type RailMarker,
} from "../_lib/peg-board-model";
import { PegTooltip } from "./board-primitives";

/**
 * The ±60 bps rail. One geometry serves the board rows and the expanded
 * panel's supporting-market sub-rows; supporting venues beyond the scale swap
 * the solid marker for a dashed, muted-red one pinned at the left edge.
 */
export function DistanceRail({
  marker,
  tone,
  ariaLabel,
  tooltip,
  testId,
}: {
  marker: RailMarker | null;
  tone: PegBoardTone;
  ariaLabel: string;
  tooltip?: string | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  const rail = (
    <span
      role="img"
      aria-label={ariaLabel}
      data-testid={testId}
      className="relative block h-2 w-[120px] shrink-0"
      style={{ background: PEG_RAIL_GRADIENT }}
    >
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -bottom-0.5 left-1/2 w-px"
        style={{ backgroundColor: "oklch(98% 0.0054 297.73 / 0.7)" }}
      />
      {marker === null ? null : marker.offScale ? (
        <OffScaleMarker />
      ) : (
        <span
          aria-hidden="true"
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
          style={{
            left: `${marker.percent}%`,
            backgroundColor: PEG_TONE_COLOR[tone],
            borderColor: PEG_COLOR.background,
          }}
        />
      )}
    </span>
  );
  return tooltip === undefined ? (
    rail
  ) : (
    <PegTooltip content={tooltip}>
      <button type="button" className="block cursor-help">
        {rail}
      </button>
    </PegTooltip>
  );
}

/**
 * Off-scale venues pin at the rail edge: a dashed muted-red circle plus a red
 * « just outside the track, so a −134 bps supporting price stays legible
 * without stretching the shared scale.
 */
function OffScaleMarker(): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden="true"
        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-dashed"
        style={{
          left: "1%",
          borderColor: PEG_COLOR.offScale,
          backgroundColor: "oklch(54.7% 0.193 26.4 / 0.15)",
        }}
      />
      <span
        aria-hidden="true"
        className="absolute -left-3.5 top-1/2 -translate-y-1/2 text-[11px] leading-none"
        style={{ color: PEG_COLOR.redText }}
      >
        «
      </span>
    </>
  );
}
