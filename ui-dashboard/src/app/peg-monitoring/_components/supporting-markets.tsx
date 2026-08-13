"use client";

import type { PegSource } from "@/lib/peg-monitoring";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import {
  PEG_BOARD_GRID,
  PEG_COLOR,
  SUPPORTING_MARKETS_TOOLTIP,
  distanceLabelFor,
  offScaleRailTooltip,
  railMarker,
  sourceDistance,
  supportingRole,
  supportingSourceUnusableReason,
  venueLabel,
  venueTradeUrl,
} from "../_lib/peg-board-model";
import {
  checkedAgo,
  formatNumber,
  formatWholeBps,
} from "../_lib/peg-board-format";
import { ExternalLink, InfoDot, PegTooltip } from "./board-primitives";
import { DistanceRail } from "./distance-rail";

export function SupportingMarkets({
  asset,
  nowMs,
  evidenceAtMs,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  /** Freshness clock: the browser's now, or the confirmed time when stale. */
  evidenceAtMs: number;
}): React.JSX.Element | null {
  const sources = asset.asset.sources.filter(
    (source) => source.id !== asset.asset.policy.deepVenueSource,
  );
  if (sources.length === 0) return null;
  return (
    <section
      data-testid={`peg-supporting-markets-${asset.asset.asset}`}
      aria-label="Supporting markets"
      className="border-b border-border pb-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-[650] text-foreground">
          Supporting Markets
        </h2>
        <InfoDot
          label="Why supporting markets cannot set peg status"
          content={SUPPORTING_MARKETS_TOOLTIP}
        />
      </div>
      <div className="mt-1">
        {sources.map((source) => (
          <SupportingRow
            key={source.id}
            source={source}
            target={asset.asset.policy.target}
            nowMs={nowMs}
            evidenceAtMs={evidenceAtMs}
          />
        ))}
      </div>
    </section>
  );
}

function SupportingRow({
  source,
  target,
  nowMs,
  evidenceAtMs,
}: {
  source: PegSource;
  target: number;
  nowMs: number;
  evidenceAtMs: number;
}): React.JSX.Element {
  const unusableReason = supportingSourceUnusableReason(source, evidenceAtMs);
  const role = supportingRole(source);
  const url = venueTradeUrl(source);
  const label = venueLabel(source);
  return (
    <div
      data-testid={`peg-supporting-source-${source.id}`}
      className={`grid items-center border-t border-[oklch(26.13%_0.0288_302.75/0.6)] py-[9px] ${PEG_BOARD_GRID}`}
    >
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-[12.5px] text-muted-foreground">
          {url === null ? (
            label
          ) : (
            <ExternalLink href={url}>{label}</ExternalLink>
          )}
        </span>
        <PegTooltip content={role.tooltip}>
          <button
            type="button"
            className="cursor-help whitespace-nowrap border border-dashed border-[var(--border-secondary)] px-[5px] py-px text-[9.5px] font-[650] text-muted-foreground"
          >
            {role.tag}
          </button>
        </PegTooltip>
      </div>
      {unusableReason === null ? (
        <UsableCells source={source} target={target} nowMs={nowMs} />
      ) : (
        <UnavailableCells
          source={source}
          reason={unusableReason}
          nowMs={nowMs}
        />
      )}
    </div>
  );
}

function UsableCells({
  source,
  target,
  nowMs,
}: {
  source: PegSource;
  target: number;
  nowMs: number;
}): React.JSX.Element {
  const distance = sourceDistance(source, target);
  const marker = railMarker(distance.bps, distance.direction);
  const offScale = marker?.offScale === true;
  const distanceText = distanceLabelFor(distance.bps, distance.direction);
  const railTooltip =
    offScale && distance.bps !== null && distance.direction !== null
      ? offScaleRailTooltip(
          distance.bps,
          distance.direction === "above" ? "above" : "below",
        )
      : undefined;
  return (
    <>
      <div className="truncate text-[12.5px] text-muted-foreground">
        {formatNumber(source.executablePrice)}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <DistanceRail
          marker={marker}
          tone={offScale ? "critical" : "healthy"}
          ariaLabel={`${venueLabel(source)}: ${distanceText}`}
          tooltip={railTooltip}
        />
        <span
          className="whitespace-nowrap text-[12px]"
          style={{
            color: offScale ? PEG_COLOR.offScale : PEG_COLOR.muted,
          }}
        >
          {distanceText}
        </span>
      </div>
      <div className="truncate text-[11px]" style={{ color: PEG_COLOR.dim }}>
        {checkedAgo(source.observationAt, nowMs) ?? "no check recorded"}
      </div>
      <div className="truncate text-[12.5px] text-muted-foreground">
        {formatWholeBps(source.spreadBps)}
      </div>
    </>
  );
}

/**
 * A venue that cannot corroborate must not look like it does: no price, no
 * rail marker, no spread — the reason takes their place (mirrors the deleted
 * evidence view's "Unavailable" treatment).
 */
function UnavailableCells({
  source,
  reason,
  nowMs,
}: {
  source: PegSource;
  reason: string;
  nowMs: number;
}): React.JSX.Element {
  return (
    <>
      <div className="truncate text-[12.5px] text-muted-foreground">—</div>
      <div className="flex min-w-0 items-center gap-3">
        <DistanceRail
          marker={null}
          tone="healthy"
          ariaLabel={`${venueLabel(source)}: unavailable — ${reason}`}
        />
        <span
          className="whitespace-nowrap text-[12px]"
          style={{ color: PEG_COLOR.muted }}
        >
          Unavailable — {reason}
        </span>
      </div>
      <div className="truncate text-[11px]" style={{ color: PEG_COLOR.dim }}>
        {checkedAgo(source.observationAt, nowMs) ?? "no check recorded"}
      </div>
      <div className="truncate text-[12.5px] text-muted-foreground">—</div>
    </>
  );
}
