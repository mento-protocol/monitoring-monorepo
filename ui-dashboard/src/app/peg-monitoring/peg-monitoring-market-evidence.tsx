import type { PegSource } from "@/lib/peg-monitoring";
import type { PegAssetPresentation } from "@/lib/peg-monitoring-presentation";
import { sourceHasUnavailableEvidence } from "@/lib/peg-monitoring-presentation-safety";
import {
  StatusPill,
  formatAge,
  formatBps,
  formatFraction,
  formatNumber,
  shortAddress,
} from "./peg-monitoring-evidence-primitives";

export function marketName(source: PegSource): string {
  const provider =
    source.provider.length === 0
      ? source.provider
      : `${source.provider[0]!.toUpperCase()}${source.provider.slice(1)}`;
  return `${provider} ${source.pair}`;
}

function observationAge(source: PegSource, nowMs: number): string | null {
  return source.observationAt === null
    ? null
    : formatAge(Math.max(0, nowMs - source.observationAt * 1_000));
}

function conversionText(source: PegSource): string | null {
  const conversion = source.convertVia;
  return conversion === null
    ? null
    : `Converted from ${conversion.fromCurrency} to ${conversion.toCurrency} using rate feed ${shortAddress(conversion.rateFeedId)} on chain ${conversion.chainId}.`;
}

export function SaleMeasurement({
  source,
  nowMs,
  stale,
}: {
  source: PegSource;
  nowMs: number;
  stale: boolean;
}): React.JSX.Element {
  const checkedAge = observationAge(source, nowMs);
  const priceCurrency = source.convertVia?.toCurrency ?? source.quoteCurrency;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium leading-6 text-slate-100">
        {stale ? "At the last confirmed check, a" : "A"}{" "}
        {formatNumber(source.referenceSize)} {source.baseCurrency} sale{" "}
        {stale ? "would have received" : "would get"} about{" "}
        {formatNumber(source.executablePrice)} {priceCurrency} per{" "}
        {source.baseCurrency}.
      </p>
      <p className="text-xs leading-5 text-slate-400">
        {formatFraction(source.filledFraction)} of the test sale filled
        {source.spreadBps === null
          ? ""
          : ` · ${formatBps(source.spreadBps)} buy/sell spread`}
        {checkedAge === null ? "" : ` · checked ${checkedAge} ago`}
      </p>
      {conversionText(source) ? (
        <p className="text-xs leading-5 text-slate-400">
          {conversionText(source)}
        </p>
      ) : null}
    </div>
  );
}

function SupportingSource({
  source,
  nowMs,
  confirmedAtMs,
  stale,
}: {
  source: PegSource;
  nowMs: number;
  confirmedAtMs: number;
  stale: boolean;
}): React.JSX.Element {
  const checkedAge = observationAge(source, nowMs);
  const usable = !sourceHasUnavailableEvidence(
    source,
    stale ? confirmedAtMs : nowMs,
  );
  const priceCurrency = source.convertVia?.toCurrency ?? source.quoteCurrency;
  return (
    <article
      data-testid={`peg-supporting-source-${source.id}`}
      className="min-w-0 rounded-md border border-slate-800 bg-slate-900/45 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="break-words text-sm font-medium text-slate-100">
          {marketName(source)}
        </p>
        <StatusPill
          label={
            usable ? (stale ? "Last confirmed" : "Available") : "Unavailable"
          }
          tone={usable ? (stale ? "neutral" : "good") : "warn"}
        />
      </div>
      {source.executablePrice === null ? (
        <p className="mt-2 text-xs leading-5 text-slate-300">
          No sale price is available.
        </p>
      ) : (
        <p className="mt-2 text-xs leading-5 text-slate-300">
          {stale ? "At the last confirmed check: " : ""}
          {formatNumber(source.executablePrice)} {priceCurrency} per{" "}
          {source.baseCurrency}
          {source.capped
            ? ` · partial fill: ${formatFraction(source.filledFraction)} of the test sale`
            : source.referenceSize === null
              ? ""
              : ` for a ${formatNumber(source.referenceSize)} ${source.baseCurrency} test sale`}
          {checkedAge === null ? "" : ` · checked ${checkedAge} ago`}
        </p>
      )}
      {conversionText(source) ? (
        <p className="mt-2 text-xs leading-5 text-slate-400">
          {conversionText(source)}
        </p>
      ) : null}
    </article>
  );
}

export function OtherMarkets({
  asset,
  nowMs,
  confirmedAtMs,
  stale,
}: {
  asset: PegAssetPresentation;
  nowMs: number;
  confirmedAtMs: number;
  stale: boolean;
}): React.JSX.Element | null {
  const sources = asset.asset.sources.filter(
    (source) => source.id !== asset.asset.policy.deepVenueSource,
  );
  const hasWarningAuthority = sources.some(
    (source) => source.authority === "secondary",
  );
  return sources.length === 0 ? null : (
    <details
      data-testid={`peg-other-markets-${asset.asset.asset}`}
      className="rounded-lg border border-slate-800 bg-slate-950/30"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-200 hover:text-white">
        Other market checks ({sources.length})
      </summary>
      <div className="border-t border-slate-800 p-4">
        <p className="mb-3 text-xs leading-5 text-slate-400">
          {hasWarningAuthority
            ? "These markets do not set the peg status shown above. Some can send a market warning. Their health or listing can send a monitoring warning."
            : "These markets do not set the peg status shown above. Their health or listing can send a monitoring warning."}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {sources.map((source) => (
            <SupportingSource
              key={source.id}
              source={source}
              nowMs={nowMs}
              confirmedAtMs={confirmedAtMs}
              stale={stale}
            />
          ))}
        </div>
      </div>
    </details>
  );
}
