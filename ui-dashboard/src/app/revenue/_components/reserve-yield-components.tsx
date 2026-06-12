"use client";

import { formatUSD } from "@/lib/format";
import { Tooltip } from "@/components/tooltip";
import { Row, Table, Td, Th } from "@/components/table";
import type { ReactNode } from "react";
import type {
  ReserveYieldHolding,
  ReserveYieldResponse,
} from "@/lib/reserve-yield";

export type ReserveYieldTileState = {
  data: ReserveYieldResponse | null;
  isLoading: boolean;
  hasError: boolean;
};

function formatAnnualInterestRatePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(3).replace(/\.?0+$/, "")}%`;
}

function formatNullableUSD(value: number | null): string {
  return value === null ? "N/A" : formatUSD(value);
}

function reserveYieldSubtitle(state: ReserveYieldTileState): string {
  const { data, hasError, isLoading } = state;
  if (isLoading && data === null) return "Loading reserve yield";
  if (data === null) {
    return hasError
      ? "Unable to load reserve yield"
      : "Reserve yield unavailable";
  }
  if (data.holdingsError !== null && data.holdings.length === 0) {
    return "Yield-bearing holdings unavailable";
  }
  if (data.holdings.length === 0) {
    return "No yield-bearing reserve holdings returned";
  }
  if (data.earnedYieldError !== null) {
    return "Earned-yield ledger pending; forecasts use current reserve balances";
  }
  if (data.rateError !== null) {
    return data.dailyRunRateUsd === null
      ? "Earned-yield ledger pending; forecast rates unavailable"
      : "Earned-yield ledger pending; some forecast rates unavailable";
  }
  if (data.holdingsError !== null) {
    return "Earned-yield ledger pending; forecasts use parsed rows";
  }
  return "";
}

function reserveYieldRateBanner(data: ReserveYieldResponse): string {
  return data.dailyRunRateUsd === null
    ? "Forecast rates are unavailable — showing balances without forecast estimates."
    : "Some forecast rates are unavailable — showing balances without forecast estimates where needed.";
}

function reserveYieldHasHoldings(data: ReserveYieldResponse | null): boolean {
  return (data?.holdings.length ?? 0) > 0;
}

function reserveYieldMetric(
  value: number | null,
  hasHoldings: boolean,
): string {
  return formatNullableUSD(hasHoldings ? value : null);
}

function reserveForecastMetric(value: number | null): string {
  return value === null ? "N/A" : `≈ ${formatUSD(value)}`;
}

function reserveTileForecastMetric(value: number | null): string {
  return formatNullableUSD(value);
}

function reserveYieldForecastTooltip(
  data: ReserveYieldResponse | null,
): string {
  const forecastUnavailableSymbols = data?.forecastUnavailableSymbols ?? [];
  const ausdApyLine =
    data?.grossApyPercent === null || data?.grossApyPercent === undefined
      ? "- AUSD APY is unavailable until the Fed Funds feed loads"
      : `- AUSD APY uses current Fed Funds Rate (${formatAnnualInterestRatePercent(data.grossApyPercent)} gross), minus 15 bps expenses, then 80% Mento revenue share (${formatAnnualInterestRatePercent(data.netMentoApyPercent)} net)`;
  const susdsApyLine =
    data?.skySavingsRateApyPercent === null ||
    data?.skySavingsRateApyPercent === undefined
      ? "- sUSDS APY is unavailable until the Sky Savings Rate feed loads"
      : data.skySavingsRateSource === "blockanalitica-overall"
        ? `- sUSDS APY uses the Sky Savings Rate (${formatAnnualInterestRatePercent(data.skySavingsRateApyPercent)}) from Block Analitica fallback`
        : `- sUSDS APY reads on-chain sUSDS.ssr() on Ethereum (${formatAnnualInterestRatePercent(data.skySavingsRateApyPercent)})`;
  const remainingUnavailableSymbols = forecastUnavailableSymbols.filter(
    (symbol) => !["AUSD", "SUSDS"].includes(symbol),
  );
  const exclusions =
    remainingUnavailableSymbols.length === 0
      ? ""
      : `\n- ${remainingUnavailableSymbols.join(", ")} currently excluded until an APY source is wired`;
  return `Annual Forecast based on blended APY on current reserve balances & non-compounding math: balance x APY x days / 365\n${ausdApyLine}\n${susdsApyLine}${exclusions}`;
}

function reserveYieldHeadline(state: ReserveYieldTileState): string {
  const { data, isLoading } = state;
  if (isLoading && data === null) return "—";
  if (data === null || data.earnedYieldUsd === null) {
    return "N/A";
  }
  return formatUSD(data.earnedYieldUsd);
}

function reserveYieldTileView(state: ReserveYieldTileState): {
  headline: string;
  showEarnedLabel: boolean;
  reserveBalance: string;
  monthlyForecast: string;
  yearlyForecast: string;
  subtitle: string;
} {
  const { data } = state;
  const hasHoldings = reserveYieldHasHoldings(data);
  return {
    headline: reserveYieldHeadline(state),
    showEarnedLabel: data !== null && !state.isLoading,
    reserveBalance: reserveYieldMetric(data?.principalUsd ?? null, hasHoldings),
    monthlyForecast: reserveTileForecastMetric(data?.next30dUsd ?? null),
    yearlyForecast: reserveTileForecastMetric(data?.next365dUsd ?? null),
    subtitle: reserveYieldSubtitle(state),
  };
}

export function ReserveYieldTile({ state }: { state: ReserveYieldTileState }) {
  const view = reserveYieldTileView(state);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4 flex min-h-[152px] flex-col justify-between">
      <div>
        <p className="text-sm text-slate-400">Reserve Yield</p>
        <p className="mt-1 text-2xl font-semibold text-white font-mono">
          {view.headline}
          {view.showEarnedLabel && (
            <span className="ml-1.5 text-sm font-normal text-slate-500">
              earned
            </span>
          )}
        </p>
        <div className="mt-1.5 space-y-1 text-sm font-mono">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-slate-400">{view.monthlyForecast}</span>
            <span className="text-slate-500">per month</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-400">{view.yearlyForecast}</span>
            <span className="text-slate-500">per year</span>
            <Tooltip
              label="About Reserve Yield forecast"
              content={reserveYieldForecastTooltip(state.data)}
              align="right"
              className="ml-0.5"
              tooltipClassName="font-sans"
            />
          </p>
          <p>
            <span className="text-slate-400">{view.reserveBalance}</span>{" "}
            <span className="text-slate-500">reserve assets earning yield</span>
          </p>
        </div>
      </div>
      <p className="mt-2 min-h-4 text-xs text-slate-500">{view.subtitle}</p>
    </div>
  );
}

function sourceTypeLabel(holding: ReserveYieldHolding): string {
  const parts = [holding.sourceType];
  if (holding.custodianType !== null) parts.push(holding.custodianType);
  return parts.join(" / ");
}

function chainLabel(chain: string): string {
  if (chain.length === 0) return "Unknown";
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}

function ReserveYieldHoldingRow({ holding }: { holding: ReserveYieldHolding }) {
  return (
    <Row>
      <Td className="whitespace-nowrap sm:!pl-2 sm:!pr-1">
        <span className="font-semibold text-slate-100">
          {holding.assetSymbol}
        </span>
      </Td>
      <Td className="whitespace-nowrap sm:!px-2">
        <span className="font-semibold text-slate-100">
          {chainLabel(holding.chain)}
        </span>
      </Td>
      <Td className="min-w-48 sm:!px-2" title={holding.yieldModel}>
        <span className="block text-slate-200">{holding.sourceLabel}</span>
        <span className="block text-[10px] uppercase tracking-wide text-slate-500">
          {sourceTypeLabel(holding)}
        </span>
      </Td>
      <Td mono align="right" className="sm:!px-2">
        {formatUSD(holding.principalUsd)}
      </Td>
      <Td mono align="right" className="sm:!px-2">
        {formatNullableUSD(holding.earnedYieldUsd)}
      </Td>
      <Td mono align="right" className="sm:!px-2">
        {formatAnnualInterestRatePercent(holding.apyPercent)}
      </Td>
      <Td mono align="right" className="sm:!px-2">
        {reserveForecastMetric(holding.next30dUsd)}
      </Td>
      <Td mono align="right" className="sm:!px-2">
        {reserveForecastMetric(holding.next365dUsd)}
      </Td>
    </Row>
  );
}

function ReserveYieldTableShell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
      {children}
    </div>
  );
}

function reserveYieldTableEmptyState({
  data,
  hasError,
  isLoading,
}: ReserveYieldTileState): string {
  if (isLoading && data === null) return "Loading…";
  if (data?.holdingsError != null) {
    return "Couldn't load yield-bearing reserve holdings.";
  }
  if (hasError && data === null) return "Couldn't load reserve yield.";
  return "No yield-bearing reserve holdings returned.";
}

export function ReserveYieldByHoldingTable({
  data,
  isLoading,
  hasError,
}: ReserveYieldTileState) {
  const holdings = data?.holdings ?? [];

  if (holdings.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">
          Reserve Yield Components
        </h2>
        <ReserveYieldTableShell>
          {reserveYieldTableEmptyState({ data, isLoading, hasError })}
        </ReserveYieldTableShell>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-white">
        Reserve Yield Components
      </h2>
      {data?.holdingsError != null ? (
        <p className="mb-3 text-xs text-amber-400/80">
          Some yield-bearing reserve holdings could not be parsed — showing
          partial data.
        </p>
      ) : null}
      {data?.earnedYieldError != null ? (
        <p className="mb-3 text-xs text-amber-400/80">
          {data.earnedYieldError}
        </p>
      ) : null}
      {data?.rateError != null ? (
        <p className="mb-3 text-xs text-amber-400/80">
          {reserveYieldRateBanner(data)}
        </p>
      ) : null}
      <Table aria-label="Reserve yield components">
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/50">
            <Th className="sm:!pl-2 sm:!pr-1">Asset</Th>
            <Th className="sm:!px-2">Chain</Th>
            <Th className="sm:!px-2">Source</Th>
            <Th align="right" className="sm:!px-2">
              Balance
            </Th>
            <Th align="right" className="sm:!px-2">
              Earned
            </Th>
            <Th align="right" className="sm:!px-2">
              APY
            </Th>
            <Th align="right" className="sm:!px-2">
              30d
            </Th>
            <Th align="right" className="sm:!px-2">
              1y
            </Th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <ReserveYieldHoldingRow key={holding.id} holding={holding} />
          ))}
        </tbody>
      </Table>
    </section>
  );
}
