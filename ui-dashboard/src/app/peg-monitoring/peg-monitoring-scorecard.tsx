import { formatAge, formatNumber } from "./peg-monitoring-evidence-primitives";
import type {
  PegAssetPresentation,
  PegMonitoringPresentation,
  PegPresentationTone,
} from "@/lib/peg-monitoring-presentation";

const toneClasses: Record<PegPresentationTone | "uncertain", string> = {
  healthy: "border-emerald-500/30 bg-emerald-950/30 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-950/30 text-amber-100",
  critical: "border-red-500/30 bg-red-950/30 text-red-100",
  uncertain: "border-amber-500/30 bg-amber-950/30 text-amber-100",
};
const conciseBps = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatScorecardBps(value: number): string {
  return value > 0 && value < 0.01
    ? "<0.01 bps"
    : `${conciseBps.format(value)} bps`;
}

function HealthLabel({
  asset,
}: {
  asset: PegAssetPresentation;
}): React.JSX.Element {
  const label = asset.uncertain
    ? "Status uncertain"
    : asset.tone === "healthy"
      ? "Healthy"
      : asset.tone === "critical"
        ? "Action required"
        : "Warning";
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[asset.uncertain ? "uncertain" : asset.tone]}`}
    >
      {label}
    </span>
  );
}

function decisionText(asset: PegAssetPresentation): string {
  if (asset.uncertain) return "Current status cannot be confirmed";
  if (asset.tone === "critical")
    return "Action required from the current measurement";
  if (asset.tone === "warning")
    return "Review the current measurement and evidence";
  return "Within the current measurement thresholds";
}

function distanceText(asset: PegAssetPresentation): string {
  if (asset.distanceBps === null || asset.direction === null)
    return "Current price unavailable";
  return asset.direction === "at target"
    ? "At target"
    : `${formatScorecardBps(asset.distanceBps)} ${asset.direction} target`;
}

function DistanceRail({
  asset,
}: {
  asset: PegAssetPresentation;
}): React.JSX.Element {
  const downsideWarning = asset.asset.policy.warnDeviationBps;
  const downsideCritical = asset.asset.policy.criticalDeviationBps;
  const premiumWarning = asset.asset.policy.premiumWarnBps;
  const rangeMax =
    Math.max(1, downsideWarning, downsideCritical, premiumWarning) * 1.25;
  const value = asset.distanceBps ?? 0;
  const directionSign =
    asset.direction === "below" ? -1 : asset.direction === "above" ? 1 : 0;
  const marker = Math.min(
    100,
    Math.max(0, 50 + directionSign * (value / rangeMax) * 50),
  );
  const downsideWarningMarker = 50 - (downsideWarning / rangeMax) * 50;
  const downsideCriticalMarker = 50 - (downsideCritical / rangeMax) * 50;
  const premiumWarningMarker = 50 + (premiumWarning / rangeMax) * 50;
  const thresholdDescription = `Downside warning begins at ${formatScorecardBps(downsideWarning)}, downside critical at ${formatScorecardBps(downsideCritical)}, and premium warning at ${formatScorecardBps(premiumWarning)}.`;
  const railBackground = `linear-gradient(to right, rgb(127 29 29 / 0.95) 0%, rgb(127 29 29 / 0.95) ${downsideCriticalMarker}%, rgb(120 53 15 / 0.9) ${downsideCriticalMarker}%, rgb(120 53 15 / 0.9) ${downsideWarningMarker}%, rgb(6 78 59 / 0.86) ${downsideWarningMarker}%, rgb(6 78 59 / 0.86) ${premiumWarningMarker}%, rgb(120 53 15 / 0.9) ${premiumWarningMarker}%, rgb(120 53 15 / 0.9) 100%)`;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-slate-100">
          Distance to target
        </span>
        <span className="text-xs font-medium text-slate-300">
          {distanceText(asset)}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${asset.assetName} distance from target: ${distanceText(asset)}. ${thresholdDescription}`}
        className="relative h-3 overflow-visible rounded-full border border-slate-700"
        style={{ background: railBackground }}
      >
        <span
          className="absolute inset-y-0 border-l border-red-200/60"
          style={{ left: `${downsideCriticalMarker}%` }}
        />
        <span
          className="absolute inset-y-0 border-l border-amber-200/60"
          style={{ left: `${downsideWarningMarker}%` }}
        />
        <span
          data-testid={`peg-target-${asset.asset.asset}`}
          className="absolute -inset-y-1 border-l-2 border-white"
          style={{ left: "50%" }}
        />
        <span
          className="absolute inset-y-0 border-l border-amber-200/60"
          style={{ left: `${premiumWarningMarker}%` }}
        />
        {asset.distanceBps === null ? null : (
          <span
            aria-hidden="true"
            data-testid={`peg-current-${asset.asset.asset}`}
            className="absolute -top-1.5 h-6 w-6 -translate-x-1/2 rounded-full border-4 border-emerald-50 bg-emerald-600 shadow-[0_0_0_4px_rgba(5,150,105,0.2)]"
            style={{ left: `${marker}%` }}
          />
        )}
      </div>
      <div className="relative h-6 text-[10px] text-slate-400">
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${downsideCriticalMarker}%` }}
        >
          −{formatScorecardBps(downsideCritical)}
        </span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${downsideWarningMarker}%` }}
        >
          −{formatScorecardBps(downsideWarning)}
        </span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap text-slate-200"
          style={{ left: "50%" }}
        >
          Target
        </span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${premiumWarningMarker}%` }}
        >
          +{formatScorecardBps(premiumWarning)}
        </span>
      </div>
    </div>
  );
}

function HealthSummary({
  asset,
}: {
  asset: PegAssetPresentation;
}): React.JSX.Element {
  const source = asset.decisionSource;
  const coverage = asset.asset.sources.filter(({ healthy }) => healthy).length;
  const pools = asset.asset.monitors.filter(
    ({ indexedPoolReachable }) => indexedPoolReachable,
  ).length;
  const breakers = asset.asset.monitors.filter(
    ({ breaker }) =>
      breaker !== null && breaker.enabled && breaker.status === "OK",
  ).length;
  const breakerCount = asset.asset.monitors.length;
  const sourceCoverage =
    asset.asset.sources.length === 1
      ? `${coverage} source healthy`
      : `${coverage} of ${asset.asset.sources.length} sources healthy`;
  const poolHealth =
    asset.asset.monitors.length === 1
      ? `${pools} pool reachable`
      : `${pools} of ${asset.asset.monitors.length} pools reachable`;
  const breakerHealth =
    breakerCount === 0
      ? "No monitored breakers"
      : breakerCount === 1 && breakers === 1
        ? "1 breaker OK"
        : `${breakers} of ${breakerCount} breakers OK`;
  return (
    <dl className="mt-5 grid gap-2 border-t border-slate-800 pt-4 sm:grid-cols-4">
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">
          Market
        </dt>
        <dd className="mt-1 text-sm text-slate-200">
          {source?.healthy ? "Measured" : "Unavailable"}
        </dd>
      </div>
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">
          Source coverage
        </dt>
        <dd className="mt-1 text-sm text-slate-200">{sourceCoverage}</dd>
      </div>
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">
          Pool
        </dt>
        <dd className="mt-1 text-sm text-slate-200">{poolHealth}</dd>
      </div>
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-slate-400">
          Breaker
        </dt>
        <dd className="mt-1 text-sm text-slate-200">{breakerHealth}</dd>
      </div>
    </dl>
  );
}

function AssetScorecard({
  asset,
  stale,
}: {
  asset: PegAssetPresentation;
  stale: boolean;
}): React.JSX.Element {
  const source = asset.decisionSource;
  return (
    <article
      data-testid={`peg-scorecard-${asset.asset.asset}`}
      className="rounded-xl border border-slate-700 bg-slate-900/50 p-5 shadow-lg shadow-slate-950/20"
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(13rem,0.8fr)_minmax(20rem,1.4fr)_minmax(13rem,0.8fr)] xl:items-center">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-white">
                {asset.assetName} / {asset.asset.peg}
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                {asset.asset.coverageClass}
              </p>
            </div>
            <HealthLabel asset={asset} />
          </div>
          <p className="mt-5 text-3xl font-semibold tracking-tight text-white">
            {formatNumber(source?.executablePrice ?? null)}{" "}
            <span className="text-base font-medium text-slate-400">
              {asset.asset.peg}
            </span>
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {stale
              ? "Last confirmed executable price"
              : "Current executable price"}{" "}
            {source
              ? `from ${source.provider} ${source.pair}`
              : "is unavailable"}
          </p>
        </div>
        <DistanceRail asset={asset} />
        <div
          className={`rounded-lg border p-4 ${toneClasses[asset.uncertain ? "uncertain" : asset.tone]}`}
        >
          <p className="text-xs font-semibold uppercase tracking-wide">
            Current conclusion
          </p>
          <p className="mt-2 text-sm font-medium">{decisionText(asset)}</p>
          {asset.reasons[0] ? (
            <p className="mt-2 text-xs leading-5 text-slate-300">
              {asset.uncertaintyReason ?? asset.reasons[0]}
            </p>
          ) : null}
        </div>
      </div>
      <HealthSummary asset={asset} />
    </article>
  );
}

function HeadlineCard({
  label,
  value,
  detail,
  tone = "healthy",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: PegPresentationTone | "uncertain";
}): React.JSX.Element {
  return (
    <section className={`rounded-xl border p-5 ${toneClasses[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.08em]">
        {label}
      </p>
      <p className="mt-4 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-xs text-slate-300">{detail}</p>
    </section>
  );
}

function closestWarningHeadline(
  closest: PegAssetPresentation | null,
  stale: boolean,
): Pick<
  React.ComponentProps<typeof HeadlineCard>,
  "value" | "detail" | "tone"
> {
  if (closest === null)
    return {
      value: "Unavailable",
      detail: "No warning threshold can be evaluated",
      tone: "uncertain",
    };
  const value =
    closest.warningDistanceBps === null
      ? "Unavailable"
      : closest.warningDistanceBps <= 0
        ? `${formatScorecardBps(Math.abs(closest.warningDistanceBps))} beyond warning`
        : `${formatScorecardBps(closest.warningDistanceBps)} remaining`;
  return {
    value,
    detail: `${closest.assetName} ${stale ? "last confirmed" : "current"} measurement`,
    tone: closest.thresholdTone,
  };
}

export function PegMonitoringScorecard({
  presentation,
  ageMs,
  stale,
}: {
  presentation: PegMonitoringPresentation;
  ageMs: number;
  stale: boolean;
}): React.JSX.Element {
  const closestHeadline = closestWarningHeadline(
    presentation.closestWarning,
    stale,
  );
  const aggregateDetail = stale
    ? `No fresh monitoring package has arrived; the last confirmed package is ${formatAge(ageMs)} old.`
    : presentation.aggregate.detail;
  return (
    <section aria-label="Peg decision scorecard" className="space-y-5">
      <div
        data-testid="peg-aggregate-status"
        role="status"
        aria-label={
          aggregateDetail
            ? `${presentation.aggregate.label}. ${aggregateDetail}`
            : presentation.aggregate.label
        }
        className={`rounded-xl border px-5 py-4 ${toneClasses[presentation.aggregate.tone]}`}
      >
        {aggregateDetail ? (
          <>
            <p className="text-lg font-semibold">
              {presentation.aggregate.label}
            </p>
            <p className="mt-1 text-sm font-normal text-slate-300">
              {aggregateDetail}
            </p>
          </>
        ) : (
          presentation.aggregate.label
        )}
      </div>
      <div
        data-testid="peg-headline-cards"
        className="grid gap-3 md:grid-cols-2"
      >
        <HeadlineCard label="Nearest warning" {...closestHeadline} />
        <HeadlineCard
          label="Data freshness"
          value={stale ? "Stale" : "Fresh"}
          detail={`${stale ? "Last confirmed package" : "Package produced"} ${formatAge(ageMs)} ago`}
          tone={stale ? "warning" : "healthy"}
        />
      </div>
      <div className="space-y-4">
        {presentation.assets.map((asset) => (
          <AssetScorecard key={asset.asset.asset} asset={asset} stale={stale} />
        ))}
      </div>
    </section>
  );
}
