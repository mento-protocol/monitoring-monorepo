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
  const warning =
    asset.warningThresholdBps ?? asset.asset.policy.warnDeviationBps;
  const critical = asset.asset.policy.criticalDeviationBps;
  const premiumDirection = asset.direction === "above";
  const rangeMax = Math.max(1, (premiumDirection ? warning : critical) * 1.25);
  const value = asset.distanceBps ?? 0;
  const marker = Math.min(100, Math.max(0, (value / rangeMax) * 100));
  const warningMarker = Math.min(100, (warning / rangeMax) * 100);
  const criticalMarker = Math.min(100, (critical / rangeMax) * 100);
  const thresholdDescription = premiumDirection
    ? `Premium warning begins at ${formatScorecardBps(warning)}.`
    : `Warning begins at ${formatScorecardBps(warning)} and critical at ${formatScorecardBps(critical)}.`;
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
        className="relative h-3 overflow-visible rounded-full border border-slate-700 bg-gradient-to-r from-emerald-950 via-amber-900 to-red-950"
      >
        <span
          className="absolute inset-y-0 border-l border-amber-200/60"
          style={{ left: `${warningMarker}%` }}
        />
        {premiumDirection ? null : (
          <span
            className="absolute inset-y-0 border-l border-red-200/60"
            style={{ left: `${criticalMarker}%` }}
          />
        )}
        {asset.distanceBps === null ? null : (
          <span
            aria-hidden="true"
            className="absolute -top-1 h-5 w-1 rounded bg-white shadow-[0_0_0_2px_rgba(15,23,42,0.9)]"
            style={{ left: `calc(${marker}% - 2px)` }}
          />
        )}
      </div>
      <p className="flex justify-between text-[11px] text-slate-400">
        <span>Target</span>
        <span>
          {premiumDirection ? "Premium warning" : "Warning"}{" "}
          {formatScorecardBps(warning)}
        </span>
        {premiumDirection ? null : (
          <span>Critical {formatScorecardBps(critical)}</span>
        )}
      </p>
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
  const breakerCount = asset.asset.monitors.filter(
    ({ breaker }) => breaker !== null,
  ).length;
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
      ? "No breaker data"
      : breakerCount === 1
        ? `${breakers} breaker OK`
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
}: {
  asset: PegAssetPresentation;
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
            Current executable price{" "}
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
              {asset.reasons[0]}
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
    detail: `${closest.assetName} relative to its warning threshold`,
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
  const furthest = presentation.furthest;
  const closestHeadline = closestWarningHeadline(presentation.closestWarning);
  return (
    <section aria-label="Peg decision scorecard" className="space-y-5">
      <div
        data-testid="peg-aggregate-status"
        role="status"
        aria-label={presentation.aggregate.label}
        className={`rounded-xl border px-5 py-4 text-lg font-semibold ${toneClasses[presentation.aggregate.tone]}`}
      >
        {presentation.aggregate.label}
      </div>
      <div
        data-testid="peg-headline-cards"
        className="grid gap-3 md:grid-cols-3"
      >
        <HeadlineCard
          label="Furthest from target"
          value={furthest ? distanceText(furthest) : "Unavailable"}
          detail={
            furthest
              ? `${furthest.assetName} current executable measurement`
              : "No executable price is available"
          }
          tone={furthest?.thresholdTone ?? "uncertain"}
        />
        <HeadlineCard label="Closest to warning" {...closestHeadline} />
        <HeadlineCard
          label="Data freshness"
          value={stale ? "Stale" : "Current"}
          detail={`${stale ? "Last confirmed package" : "Package produced"} ${formatAge(ageMs)} ago`}
          tone={stale ? "warning" : "healthy"}
        />
      </div>
      <div className="space-y-4">
        {presentation.assets.map((asset) => (
          <AssetScorecard key={asset.asset.asset} asset={asset} />
        ))}
      </div>
    </section>
  );
}
