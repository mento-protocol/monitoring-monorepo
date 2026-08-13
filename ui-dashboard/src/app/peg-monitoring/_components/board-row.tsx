"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import { buildPoolDetailHref } from "@/lib/routing";
import {
  checkedAgo,
  formatFraction,
  formatNumber,
  formatWholeBps,
} from "../_lib/peg-board-format";
import {
  PEG_BOARD_GRID,
  PEG_COLOR,
  distanceLabel,
  monitorStates,
  mostSaturatedMonitor,
  pegPairLabel,
  railMarker,
  statusBadge,
  tradingLimitTooltip,
  venueLabel,
  venueTradeUrl,
  worstMonitor,
  type PegBoardTone,
} from "../_lib/peg-board-model";
import {
  ExternalLink,
  PegTooltip,
  SeverityDot,
  StatusBadge,
  TwoLineCell,
  pegLinkClass,
} from "./board-primitives";
import { DistanceRail } from "./distance-rail";

export type BoardRowProps = {
  asset: PegAssetPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  structuralCurrent: boolean;
  open: boolean;
  onToggle: (assetId: string) => void;
};

/** Clicks that land on a link or a nested control must not toggle the panel. */
function isInteractiveTarget(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return target.closest("a, button") !== null;
}

export function BoardRow({
  asset,
  nowMs,
  producedAt,
  stale,
  structuralCurrent,
  open,
  onToggle,
}: BoardRowProps): React.JSX.Element {
  const badge = statusBadge(asset);
  const assetId = asset.asset.asset;
  const panelId = `peg-panel-${assetId}`;
  return (
    // The chevron button carries the accessible toggle; the row itself is a
    // pointer convenience, so it deliberately exposes no widget role (a row
    // role would nest its links and breach the nested-interactive rule).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      data-testid={`peg-row-${assetId}`}
      data-open={open ? "true" : "false"}
      onClick={(event) => {
        if (!isInteractiveTarget(event)) onToggle(assetId);
      }}
      className={`grid cursor-pointer items-center border-b border-border px-[18px] py-4 ${PEG_BOARD_GRID} ${rowTint(badge.tone, open)}`}
    >
      <div className="truncate text-[15px] font-[650] text-foreground">
        {pegPairLabel(asset)}
      </div>
      <div>
        <StatusBadge
          testId={`peg-status-${assetId}`}
          label={badge.label}
          tone={badge.tone}
          detail={asset.uncertaintyReason ?? asset.reasons[0] ?? null}
        />
      </div>
      <div className="truncate text-[15px] font-semibold text-foreground">
        {formatNumber(asset.decisionSource?.executablePrice ?? null)}
      </div>
      <DistanceCell asset={asset} tone={badge.tone} />
      <PrimaryMarketCell asset={asset} nowMs={nowMs} stale={stale} />
      <TwoLineCell
        value={formatWholeBps(asset.decisionSource?.spreadBps ?? null)}
        age={checkedAgo(asset.decisionSource?.observationAt ?? null, nowMs)}
        stale={stale}
      />
      <TradingLimitCell
        asset={asset}
        nowMs={nowMs}
        producedAt={producedAt}
        stale={stale}
        structuralCurrent={structuralCurrent}
      />
      <BreakerCell
        asset={asset}
        nowMs={nowMs}
        producedAt={producedAt}
        stale={stale}
        structuralCurrent={structuralCurrent}
      />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Collapse" : "Expand"} ${pegPairLabel(asset)} details`}
        onClick={() => onToggle(assetId)}
        className={`flex size-7 items-center justify-center justify-self-end border text-[11px] ${
          open
            ? "border-[var(--border-secondary)] bg-[oklch(26.1%_0.0288_303)] text-foreground"
            : "border-[var(--border-tertiary)] text-muted-foreground"
        }`}
      >
        {open ? "▾" : "▸"}
      </button>
    </div>
  );
}

function rowTint(tone: PegBoardTone, open: boolean): string {
  if (open) return "bg-card";
  if (tone === "warning" || tone === "uncertain")
    return "bg-[oklch(76.9%_0.188_70/0.05)] hover:bg-[oklch(76.9%_0.188_70/0.1)]";
  if (tone === "critical")
    return "bg-[oklch(54.7%_0.193_26.4/0.07)] hover:bg-[oklch(54.7%_0.193_26.4/0.13)]";
  return "hover:bg-card";
}

function DistanceCell({
  asset,
  tone,
}: {
  asset: PegAssetPresentation;
  tone: PegBoardTone;
}): React.JSX.Element {
  const label = distanceLabel(asset);
  const warning = tone !== "healthy";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <DistanceRail
        testId={`peg-rail-${asset.asset.asset}`}
        marker={railMarker(asset.distanceBps, asset.direction)}
        tone={
          asset.thresholdTone === "uncertain" ? "warning" : asset.thresholdTone
        }
        ariaLabel={`${asset.assetName} distance from target: ${label}`}
      />
      <span
        className={`whitespace-nowrap text-[12.5px] ${warning ? "font-[650]" : ""}`}
        style={{ color: warning ? PEG_COLOR.amber : PEG_COLOR.muted }}
      >
        {label}
      </span>
    </div>
  );
}

function PrimaryMarketCell({
  asset,
  nowMs,
  stale,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  stale: boolean;
}): React.JSX.Element {
  const source = asset.deepSource;
  if (source === null) return <TwoLineCell value="Not configured" age={null} />;
  const url = venueTradeUrl(source);
  const label = venueLabel(source);
  return (
    <TwoLineCell
      value={
        url === null ? label : <ExternalLink href={url}>{label}</ExternalLink>
      }
      age={checkedAgo(source.observationAt, nowMs)}
      stale={stale}
    />
  );
}

function TradingLimitCell({
  asset,
  nowMs,
  producedAt,
  stale,
  structuralCurrent,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  structuralCurrent: boolean;
}): React.JSX.Element {
  const states = monitorStates(asset, structuralCurrent, stale);
  const target = mostSaturatedMonitor(states);
  const saturation =
    asset.asset.structural.structuralSaturation ?? target?.saturation ?? null;
  // A missing or expired measurement must not read as a safe 0%: the fraction
  // renders only when structural evidence is current and a saturation exists.
  const measured = structuralCurrent && saturation !== null;
  const value =
    structuralCurrent && saturation !== null ? formatFraction(saturation) : "—";
  const tooltip = measured
    ? tradingLimitTooltip(asset.asset.policy.structuralWarnFraction)
    : `${
        structuralCurrent
          ? "No trading-limit measurement is available from the indexed pool."
          : "The structural evidence behind this measurement has expired."
      } ${tradingLimitTooltip(asset.asset.policy.structuralWarnFraction)}`;
  // The link is the tooltip trigger itself: wrapping it in a button would nest
  // two interactive controls.
  const trigger =
    target === null ? (
      <button type="button" className={`${pegLinkClass} cursor-help`}>
        {value}
      </button>
    ) : (
      <Link
        href={`${buildPoolDetailHref(target.poolId)}?tab=limits`}
        className={`${pegLinkClass} cursor-help`}
      >
        {value}
      </Link>
    );
  return (
    <TwoLineCell
      value={<PegTooltip content={tooltip}>{trigger}</PegTooltip>}
      age={checkedAgo(producedAt, nowMs)}
      stale={stale}
    />
  );
}

function BreakerCell({
  asset,
  nowMs,
  producedAt,
  stale,
  structuralCurrent,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  structuralCurrent: boolean;
}): React.JSX.Element {
  const worst = worstMonitor(monitorStates(asset, structuralCurrent, stale));
  if (worst === null) return <TwoLineCell value="No monitors" age={null} />;
  return (
    <TwoLineCell
      value={
        <span className="flex items-center gap-1.5">
          <SeverityDot tone={worst.breaker.tone} />
          <Link
            href={`${buildPoolDetailHref(worst.poolId)}?tab=oracle`}
            className={pegLinkClass}
          >
            {worst.breaker.label}
          </Link>
        </span>
      }
      age={checkedAgo(producedAt, nowMs)}
      stale={stale}
    />
  );
}
