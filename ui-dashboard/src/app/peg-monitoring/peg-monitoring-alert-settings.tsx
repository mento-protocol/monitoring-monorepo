import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import {
  formatBps,
  formatFraction,
  formatNumber,
} from "./peg-monitoring-evidence-primitives";

function formatDuration(seconds: number): string {
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

function formatThreshold(bps: number): string {
  return `${formatNumber(bps / 100)}% (${formatBps(bps)})`;
}

export function PegMonitoringAlertSettings({
  asset,
}: {
  asset: PegAssetPresentation;
}): React.JSX.Element {
  const policy = asset.asset.policy;
  const source = asset.deepSource;
  return (
    <section
      data-testid={`peg-alert-settings-${asset.asset.asset}`}
      aria-labelledby={`peg-alert-settings-heading-${asset.asset.asset}`}
      className="rounded-lg border border-slate-800 bg-slate-950/35 p-4"
    >
      <h4
        id={`peg-alert-settings-heading-${asset.asset.asset}`}
        className="text-sm font-semibold text-white"
      >
        Alert settings
      </h4>
      <dl className="mt-4 divide-y divide-slate-800">
        <div className="pb-3">
          <dt className="text-xs font-medium text-slate-300">Warning</dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            A warning fires after {formatDuration(policy.warnSustainSeconds)}{" "}
            when the price is{" "}
            {formatThreshold(asset.downsideWarningThresholdBps)} below target or{" "}
            {formatThreshold(asset.premiumWarningThresholdBps)} above target
            {source !== null && (
              <>
                , or when the decision market's buy/sell spread exceeds{" "}
                {formatBps(source.policy.spreadEnvelopeBps)}
              </>
            )}
            , or when pool inflow reaches{" "}
            {formatFraction(policy.structuralWarnFraction)} of its active
            trading limit.
          </dd>
        </div>
        <div className="py-3">
          <dt className="text-xs font-medium text-slate-300">
            Other non-paging warnings
          </dt>
          <dd className="mt-1 text-sm leading-6 text-slate-300">
            Separate operations warnings cover market availability and listings,
            pool reachability, missed checks, and policy rollover. They do not
            page the on-call engineer.
          </dd>
        </div>
        <div className="py-3">
          <dt className="text-xs font-medium text-slate-300">Critical page</dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            {formatThreshold(asset.downsideCriticalThresholdBps)} below target
            over {formatDuration(policy.criticalSustainSeconds)}.
          </dd>
        </div>
        <div className="py-3">
          <dt className="text-xs font-medium text-slate-300">
            Immediate critical page
          </dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            Also page immediately when the full-size sale price is missing for{" "}
            {policy.blindConsecutivePolls} consecutive checks and another risk
            signal is active: high pool inflow, an unusually wide buy/sell
            spread, or a partial-fill price below the critical limit.
          </dd>
        </div>
        <div className="py-3">
          <dt className="text-xs font-medium text-slate-300">
            Readings required
          </dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            At least {formatFraction(1 - policy.durationQuantile)} of usable
            readings must cross the limit, and{" "}
            {formatFraction(policy.minimumCoverageFraction)} of expected checks
            must arrive.
          </dd>
        </div>
        <div className="py-3">
          <dt className="text-xs font-medium text-slate-300">
            Missing full-size price
          </dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            Flag after {policy.blindConsecutivePolls} consecutive failed checks.
          </dd>
        </div>
        <div className="pt-3">
          <dt className="text-xs font-medium text-slate-300">
            Decision market timing
          </dt>
          <dd className="mt-1 text-sm leading-6 text-slate-100">
            {source === null
              ? "No timing settings are available."
              : `Checked every ${formatDuration(source.policy.pollIntervalSeconds)}; a reading expires after ${formatDuration(source.policy.staleAfterSeconds)}.`}
          </dd>
        </div>
      </dl>
    </section>
  );
}
