import type { ReactNode } from "react";
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

function AlertCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "warning" | "critical" | "neutral";
  children: ReactNode;
}): React.JSX.Element {
  const style = {
    warning: "border-amber-500/30 bg-amber-950/30",
    critical: "border-red-500/30 bg-red-950/30",
    neutral: "border-slate-800 bg-slate-900/45",
  }[tone];
  return (
    <div className={`rounded-md border p-3 ${style}`}>
      <h5 className="text-sm font-semibold text-white">{title}</h5>
      <div className="mt-2 space-y-2 text-xs leading-5 text-slate-200">
        {children}
      </div>
    </div>
  );
}

function DetailRow({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="py-3">
      <dt className="text-xs font-medium text-slate-200">{title}</dt>
      <dd className="mt-1 text-xs leading-5 text-slate-400">{children}</dd>
    </div>
  );
}

type AlertSettingsProps = {
  asset: PegAssetPresentation;
};

function WarningCard({ asset }: AlertSettingsProps): React.JSX.Element {
  const policy = asset.asset.policy;
  const source = asset.deepSource;
  const warningWindow = formatDuration(policy.warnSustainSeconds);
  return (
    <AlertCard title="Warning" tone="warning">
      <p>
        <strong className="font-medium text-amber-100">Price:</strong> For the
        main market, at least {formatFraction(1 - policy.durationQuantile)} of
        usable full-size prices in the last {warningWindow} must be{" "}
        {formatThreshold(asset.downsideWarningThresholdBps)} below target or{" "}
        {formatThreshold(asset.premiumWarningThresholdBps)} above target.
        Approved secondary markets are checked separately at their own limits.
      </p>
      <p>
        <strong className="font-medium text-amber-100">
          Market conditions:
        </strong>{" "}
        {source === null ? (
          "Main-market spread settings are unavailable."
        ) : (
          <>
            The main market also warns if its buy/sell spread stays above{" "}
            {formatBps(source.policy.spreadEnvelopeBps)} for {warningWindow}
          </>
        )}
        {source === null ? " Pool inflow" : ", or pool inflow"} stays at{" "}
        {formatFraction(policy.structuralWarnFraction)} or more of the active
        trading limit for {warningWindow}.
      </p>
    </AlertCard>
  );
}

function CriticalCard({ asset }: AlertSettingsProps): React.JSX.Element {
  const policy = asset.asset.policy;
  const criticalWindow = formatDuration(policy.criticalSustainSeconds);
  return (
    <AlertCard title="Critical page" tone="critical">
      <p>
        <strong className="font-medium text-red-100">Price drop:</strong> Page
        the on-call engineer when at least{" "}
        {formatFraction(1 - policy.durationQuantile)} of usable full-size
        main-market prices in the last {criticalWindow} are{" "}
        {formatThreshold(asset.downsideCriticalThresholdBps)} below target. The
        required check coverage and fresh, healthy market data must also be
        present.
      </p>
      <p>
        <strong className="font-medium text-red-100">
          Loss of a usable price:
        </strong>{" "}
        A page can fire sooner, without waiting for the full price window (
        {criticalWindow}), when {policy.blindConsecutivePolls} scheduled
        main-market checks produce no new usable full-size price and fresh data
        also shows high pool inflow, an unusually wide spread, or a partial-sale
        price beyond the critical price-drop limit.
      </p>
    </AlertCard>
  );
}

function DeliveryCard(): React.JSX.Element {
  return (
    <AlertCard title="Who gets notified" tone="neutral">
      <p>
        <strong className="font-medium text-slate-100">Market warnings:</strong>{" "}
        #alerts-pools after 1 minute.
      </p>
      <p>
        <strong className="font-medium text-slate-100">
          Monitoring problems:
        </strong>{" "}
        #alerts-infra after 1 minute. These do not page.
      </p>
      <p>
        <strong className="font-medium text-slate-100">Critical alerts:</strong>{" "}
        Splunk On-Call and <strong>@support-engineer</strong> in
        #alerts-critical after 30 seconds.
      </p>
    </AlertCard>
  );
}

function ConfirmationDetails({ asset }: AlertSettingsProps): React.JSX.Element {
  const policy = asset.asset.policy;
  const source = asset.deepSource;
  const requiredFraction = formatFraction(policy.minimumCoverageFraction);
  return (
    <details className="mt-3 rounded-md border border-slate-800 bg-slate-900/45">
      <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium text-slate-200 hover:text-white">
        How alerts are confirmed
      </summary>
      <dl className="divide-y divide-slate-800 border-t border-slate-800 px-3">
        <DetailRow title="Before a price alert can fire">
          At least {requiredFraction} of expected checks must arrive, at least{" "}
          {requiredFraction} must produce a usable full-size price, and at least{" "}
          {formatFraction(1 - policy.durationQuantile)} of those usable prices
          must cross the limit. The latest market reading must also be healthy
          and current.
        </DetailRow>
        <DetailRow title="Missing full-size price">
          Send a monitoring warning when {policy.blindConsecutivePolls}{" "}
          scheduled checks of the main market produce no new usable full-size
          price.
        </DetailRow>
        <DetailRow title="Other monitoring problems">
          Send a warning for unhealthy or missing market data and listings, an
          unreachable pool, a missing peg-monitor heartbeat, or an
          unacknowledged alert-policy update.
        </DetailRow>
        <DetailRow title="Timing">
          {source === null
            ? "Main-market settings are unavailable because the configured market is missing from this monitoring package."
            : `The main market is scheduled for a price check every ${formatDuration(source.policy.pollIntervalSeconds)}. Its data can drive a price or spread alert only while it is healthy and no more than ${formatDuration(source.policy.staleAfterSeconds)} old. Alert rules are evaluated every 60 seconds.`}
        </DetailRow>
      </dl>
    </details>
  );
}

export function PegMonitoringAlertSettings({
  asset,
}: AlertSettingsProps): React.JSX.Element {
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
        Alerts and notifications
      </h4>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        What triggers an alert and who gets notified.
      </p>

      <div className="mt-4 space-y-3">
        <WarningCard asset={asset} />
        <CriticalCard asset={asset} />
        <DeliveryCard />
      </div>
      <ConfirmationDetails asset={asset} />
    </section>
  );
}
