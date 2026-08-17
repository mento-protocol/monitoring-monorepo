"use client";

import Link from "next/link";
import type { PegHistoryIdentity } from "@/hooks/use-peg-history";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import { buildPoolDetailHref } from "@/lib/routing";
import { formatFraction } from "../_lib/peg-board-format";
import {
  PEG_COLOR,
  PEG_BOARD_ROW_PADDING,
  distanceLabel,
  effectiveAssetPolicy,
  monitorStates,
  type MonitorState,
} from "../_lib/peg-board-model";
import {
  PREVIOUS_POLICY_NOTICE,
  measurementLabel,
  panelNotice,
  primaryMarketProblem,
  staleNotice,
} from "../_lib/peg-panel-notices";
import { SeverityDot, pegLinkClass } from "./board-primitives";
import { PegHistoryChart } from "./peg-history-chart";
import { SupportingMarkets } from "./supporting-markets";

const noticeTint = {
  critical: {
    color: PEG_COLOR.redText,
    borderColor: "oklch(54.7% 0.193 26.4 / 0.45)",
    backgroundColor: "oklch(54.7% 0.193 26.4 / 0.12)",
  },
  warning: {
    color: PEG_COLOR.amber,
    borderColor: "oklch(76.9% 0.188 70 / 0.35)",
    backgroundColor: "oklch(76.9% 0.188 70 / 0.08)",
  },
} as const;

function historyIdentity(
  asset: PegAssetPresentation,
  policyVersion: string,
): PegHistoryIdentity | null {
  return asset.deepSource === null
    ? null
    : {
        asset: asset.asset.asset,
        source: asset.deepSource.id,
        policyVersion,
      };
}

export function RowPanel({
  asset,
  nowMs,
  producedAt,
  stale,
  previousPolicy,
  ageLabel,
  structuralCurrent,
  policyVersion,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  producedAt: number;
  stale: boolean;
  previousPolicy: boolean;
  ageLabel: string;
  structuralCurrent: boolean;
  policyVersion: string;
}): React.JSX.Element {
  const notice = panelNotice(asset, stale, previousPolicy);
  const primary = asset.deepSource;
  const primaryProblem =
    asset.decisionSource === null && primary !== null
      ? primaryMarketProblem(primary, asset)
      : null;
  const monitors = monitorStates(asset, structuralCurrent, stale);
  const signedNowBps =
    asset.distanceBps === null || asset.direction === null
      ? null
      : asset.direction === "below"
        ? -asset.distanceBps
        : asset.distanceBps;
  return (
    <div
      id={`peg-panel-${asset.asset.asset}`}
      data-testid={`peg-panel-${asset.asset.asset}`}
      role="row"
      className={`border-y border-border bg-card pb-[22px] pt-5 ${PEG_BOARD_ROW_PADDING}`}
    >
      <div role="cell" aria-colspan={8}>
        <div className="space-y-2">
          {stale ? (
            <PanelLine tone="warning" text={staleNotice(ageLabel)} />
          ) : null}
          {previousPolicy ? (
            <PanelLine
              tone="warning"
              text={PREVIOUS_POLICY_NOTICE}
              testId={`peg-previous-policy-${asset.asset.asset}`}
            />
          ) : null}
          {notice === null ? null : (
            <PanelLine
              tone={notice.tone}
              text={notice.text}
              live={notice.live}
            />
          )}
          {primaryProblem === null ? null : (
            <PanelLine
              tone="warning"
              text={`Primary market unusable: ${primaryProblem}`}
              testId={`peg-primary-unusable-${asset.asset.asset}`}
            />
          )}
        </div>
        {monitors.length > 1 ? (
          <MonitorBreakdown
            monitors={monitors}
            warnFraction={asset.asset.policy.structuralWarnFraction}
            structuralCurrent={structuralCurrent}
          />
        ) : null}
        <div className="mt-4">
          <SupportingMarkets
            asset={asset}
            nowMs={nowMs}
            // Retained (stale) evidence is judged against its confirmed time so
            // it does not silently expire against the moving browser clock.
            evidenceAtMs={stale ? producedAt * 1_000 : nowMs}
          />
        </div>
        <div className="mt-4">
          <PegHistoryChart
            // Effective thresholds (incl. any conversion allowance) so the
            // chart's bands sit exactly where the alert rules fire.
            policy={effectiveAssetPolicy(asset)}
            nowBps={signedNowBps}
            tone={
              asset.thresholdTone === "uncertain"
                ? "warning"
                : asset.thresholdTone
            }
            measurement={measurementLabel(primary)}
            nowMs={stale ? producedAt * 1_000 : nowMs}
            historyIdentity={historyIdentity(asset, policyVersion)}
            historyEndSeconds={stale ? producedAt : undefined}
          />
        </div>
        <p className="sr-only">{`${asset.assetName} is ${distanceLabel(asset)}.`}</p>
      </div>
    </div>
  );
}

function PanelLine({
  tone,
  text,
  live,
  testId,
}: {
  tone: "critical" | "warning";
  text: string;
  live?: "alert" | "status" | undefined;
  testId?: string | undefined;
}): React.JSX.Element {
  return (
    <p
      data-testid={testId}
      role={live}
      className="border px-3 py-2 text-[12.5px] leading-[1.55]"
      style={noticeTint[tone]}
    >
      {text}
    </p>
  );
}

/**
 * A package may carry up to eight monitors. The row cell shows the worst one,
 * so the panel spells out each pool's own limit and breaker.
 */
function MonitorBreakdown({
  monitors,
  warnFraction,
  structuralCurrent,
}: {
  monitors: readonly MonitorState[];
  warnFraction: number;
  structuralCurrent: boolean;
}): React.JSX.Element {
  return (
    <ul className="mt-4 space-y-1.5">
      {monitors.map((state) => (
        <li
          key={`${state.poolId}-${state.monitor.rateFeedId}-${state.monitor.monitoredTokenAddress}`}
          className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground"
        >
          <Link
            href={`${buildPoolDetailHref(state.poolId)}?tab=limits`}
            className={`${pegLinkClass} text-[var(--peg-text-2)]`}
          >
            Pool {state.monitor.poolAddress.slice(0, 8)}…
            {state.monitor.poolAddress.slice(-6)}
          </Link>
          <span>
            {/* Same honesty rule as the row cell: an expired, incomplete, or
                absent measurement must not read as a live percentage. */}
            {structuralCurrent &&
            !state.monitor.structuralQuerySaturated &&
            state.saturation !== null
              ? `trading limit ${formatFraction(state.saturation)} of ${formatFraction(warnFraction)} warn`
              : `trading limit — (${
                  !structuralCurrent
                    ? "check expired"
                    : state.monitor.structuralQuerySaturated
                      ? "check incomplete"
                      : "no measurement"
                })`}
          </span>
          <span className="flex items-center gap-1.5">
            <SeverityDot tone={state.breaker.tone} />
            <Link
              href={`${buildPoolDetailHref(state.poolId)}?tab=oracle`}
              className={`${pegLinkClass} text-[var(--peg-text-2)]`}
            >
              {state.breaker.label}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}
