import { Tooltip } from "@/components/tooltip";
import { streamKeyToNeedle } from "@/lib/canonical-revenue/utils";
import { formatUSD } from "@/lib/format";
import type {
  CanonicalRevenueForecast,
  CanonicalRevenuePeriod,
  CanonicalRevenueStream,
  RevenueForecastKey,
  RevenuePeriodKey,
} from "@/lib/canonical-revenue";

const PERIOD_CARD_ORDER: RevenuePeriodKey[] = [
  "allTimeSinceV3",
  "last30d",
  "last7d",
];

const FORECAST_CARD_ORDER: RevenueForecastKey[] = [
  "next365d",
  "next30d",
  "next7d",
];

function LoadingValue() {
  return (
    <span className="inline-block h-[1em] w-28 animate-pulse rounded bg-slate-800/60 align-middle" />
  );
}

function LoadingPillValue() {
  return (
    <span className="inline-block h-[1em] w-12 animate-pulse rounded bg-slate-800/60 align-middle" />
  );
}

function mutedUnavailable(value: number | null): string {
  return value === null ? "N/A" : `≈ ${formatUSD(value)}`;
}

function formatActualValue(value: number | null, isPartial: boolean): string {
  if (value === null) return "N/A";
  return `${isPartial ? "≈ " : ""}${formatUSD(value)}`;
}

function periodHeadlineTotal(period: CanonicalRevenuePeriod): number | null {
  if (period.totalUsd !== null) return period.totalUsd;
  return period.availableTotalUsd > 0 ? period.availableTotalUsd : null;
}

function MetricPill({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: number | null;
  isLoading: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-slate-200">
        {isLoading ? (
          <LoadingPillValue />
        ) : value === null ? (
          "N/A"
        ) : (
          formatUSD(value)
        )}
      </p>
    </div>
  );
}

function PeriodCard({
  period,
  isLoading,
  partialReasons,
}: {
  period: CanonicalRevenuePeriod;
  isLoading: boolean;
  partialReasons: string[];
}) {
  const isPartial = partialReasons.length > 0;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">{period.title}</h2>
          <p className="mt-0.5 text-xs text-muted">{period.subtitle}</p>
        </div>
        {isPartial ? (
          <Tooltip
            label={`About ${period.title} partial data`}
            content={partialReasons.join("\n")}
            align="right"
          />
        ) : null}
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold text-white">
        {isLoading ? (
          <LoadingValue />
        ) : (
          formatActualValue(periodHeadlineTotal(period), isPartial)
        )}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MetricPill
          label="Reserve"
          value={period.reserveYieldUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="Swap"
          value={period.swapFeesUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="CDP"
          value={period.cdpBorrowingUsd}
          isLoading={isLoading}
        />
      </div>
    </article>
  );
}

export function RevenuePeriodCards({
  periods,
  isLoading,
  partialReasons,
}: {
  periods: Record<RevenuePeriodKey, CanonicalRevenuePeriod>;
  isLoading: boolean;
  partialReasons: string[];
}) {
  return (
    <section
      aria-label="Revenue actuals by period"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {PERIOD_CARD_ORDER.map((key) => {
        const period = periods[key];
        return (
          <PeriodCard
            key={period.key}
            period={period}
            isLoading={isLoading}
            partialReasons={partialReasons}
          />
        );
      })}
    </section>
  );
}

function ForecastCard({
  forecast,
  isLoading,
}: {
  forecast: CanonicalRevenueForecast;
  isLoading: boolean;
}) {
  const isPartial = forecast.partialReasons.length > 0;
  const tooltip = [
    forecast.assumption,
    ...forecast.partialReasons.map((reason) => `- ${reason}`),
  ].join("\n");
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">
            {forecast.title}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{forecast.subtitle}</p>
        </div>
        <Tooltip
          label={`About ${forecast.title}`}
          content={tooltip}
          align="right"
        />
      </div>
      <p className="mt-3 font-mono text-2xl font-semibold text-white">
        {isLoading ? <LoadingValue /> : mutedUnavailable(forecast.totalUsd)}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MetricPill
          label="Reserve"
          value={forecast.reserveYieldUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="Swap"
          value={forecast.swapFeesUsd}
          isLoading={isLoading}
        />
        <MetricPill
          label="CDP"
          value={forecast.cdpBorrowingUsd}
          isLoading={isLoading}
        />
      </div>
      {isPartial ? (
        <p className="mt-2 text-xs text-muted">Partial forecast inputs</p>
      ) : null}
    </article>
  );
}

export function ForecastCards({
  forecasts,
  isLoading,
}: {
  forecasts: Record<RevenueForecastKey, CanonicalRevenueForecast>;
  isLoading: boolean;
}) {
  return (
    <section
      aria-label="Revenue forecasts"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {FORECAST_CARD_ORDER.map((key) => {
        const forecast = forecasts[key];
        return (
          <ForecastCard
            key={forecast.key}
            forecast={forecast}
            isLoading={isLoading}
          />
        );
      })}
    </section>
  );
}

export function RevenueStreamCards({
  streams,
  isLoading,
  actualPartialReasons,
}: {
  streams: CanonicalRevenueStream[];
  isLoading: boolean;
  actualPartialReasons: string[];
}) {
  return (
    <section
      aria-label="Revenue streams"
      className="grid grid-cols-1 gap-4 md:grid-cols-3"
    >
      {streams.map((stream) => {
        const streamActualPartialReasons = [
          ...new Set([
            ...stream.actualPartialReasons,
            ...partialReasonsForStream(stream.key, actualPartialReasons),
          ]),
        ];
        const partialReasons = [
          ...new Set([
            ...streamActualPartialReasons,
            ...stream.forecastPartialReasons,
          ]),
        ];
        return (
          <StreamCard
            key={stream.key}
            stream={stream}
            isLoading={isLoading}
            actualPartialReasons={streamActualPartialReasons}
            partialReasons={partialReasons}
          />
        );
      })}
    </section>
  );
}

function partialReasonsForStream(
  streamKey: CanonicalRevenueStream["key"],
  reasons: readonly string[],
): string[] {
  const needle = streamKeyToNeedle(streamKey);
  return [
    ...new Set(
      reasons.filter((reason) => reason.toLowerCase().includes(needle)),
    ),
  ];
}

function StreamCard({
  stream,
  isLoading,
  actualPartialReasons,
  partialReasons,
}: {
  stream: CanonicalRevenueStream;
  isLoading: boolean;
  actualPartialReasons: string[];
  partialReasons: string[];
}) {
  const isPartial = partialReasons.length > 0;
  const actualIsPartial = actualPartialReasons.length > 0;
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-slate-300">{stream.title}</h2>
          <p className="mt-0.5 text-xs text-muted">{stream.subtitle}</p>
        </div>
        {isPartial ? (
          <Tooltip
            label={`About ${stream.title} partial data`}
            content={partialReasons.join("\n")}
            align="right"
          />
        ) : null}
      </div>
      <p className="mt-3 font-mono text-xl font-semibold text-white">
        {isLoading ? (
          <LoadingValue />
        ) : (
          formatActualValue(stream.actualUsd, actualIsPartial)
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>30d {mutedUnavailable(stream.forecast30dUsd)}</span>
        <span>1y {mutedUnavailable(stream.forecast365dUsd)}</span>
      </div>
    </article>
  );
}
