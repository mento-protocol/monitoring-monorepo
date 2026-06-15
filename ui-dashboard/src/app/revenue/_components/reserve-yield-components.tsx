"use client";

import { formatUSD } from "@/lib/format";
import { Row, Table, Td, Th } from "@/components/table";
import type { ReactNode } from "react";
import type {
  ReserveYieldHolding,
  ReserveYieldResponse,
} from "@/lib/reserve-yield";

type ReserveYieldTableState = {
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

function reserveYieldRateBanner(data: ReserveYieldResponse): string {
  return data.dailyRunRateUsd === null
    ? "Forecast rates are unavailable — showing balances without forecast estimates."
    : "Some forecast rates are unavailable — showing balances without forecast estimates where needed.";
}

function reserveForecastMetric(value: number | null): string {
  return value === null ? "N/A" : `≈ ${formatUSD(value)}`;
}

function reserveTotalApyPercent(data: ReserveYieldResponse): number | null {
  if (
    data.forecastPrincipalUsd === null ||
    data.next365dUsd === null ||
    data.forecastPrincipalUsd <= 0
  ) {
    return null;
  }
  return (data.next365dUsd / data.forecastPrincipalUsd) * 100;
}

function reserveTotalForecastTitle(data: ReserveYieldResponse): string {
  const rateSources = reserveForecastAnnualRateSourceTitle(data);
  if (data.next365dUsd === null) {
    return `Forecast unavailable until annual-rate sources load for current reserve holdings.${rateSources}`;
  }
  if (data.forecastUnavailableSymbols.length > 0) {
    return `Forecast totals include holdings with annual-rate sources only; missing annual rate for ${data.forecastUnavailableSymbols.join(", ")}.${rateSources}`;
  }
  return `Forecast totals use non-compounding math across current reserve balances.${rateSources}`;
}

function reserveForecastAnnualRateSourceTitle(
  data: ReserveYieldResponse,
): string {
  const sourceLines: string[] = [];
  const seenSymbols = new Set<string>();
  for (const holding of data.holdings) {
    if (holding.apyPercent === null) continue;
    const symbol = holding.assetSymbol.toUpperCase();
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    sourceLines.push(
      `${symbol}: ${formatAnnualInterestRatePercent(holding.apyPercent)} (${holding.yieldModel})`,
    );
  }
  return sourceLines.length === 0
    ? ""
    : ` Annual-rate sources: ${sourceLines.join("; ")}.`;
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

function ReserveYieldTotalRow({ data }: { data: ReserveYieldResponse }) {
  const totalApyPercent = reserveTotalApyPercent(data);
  const forecastTitle = reserveTotalForecastTitle(data);
  return (
    <tr
      aria-label="Reserve yield total row"
      className="border-t border-slate-700 bg-slate-900/80"
    >
      <th
        scope="row"
        colSpan={3}
        className="px-2 py-2.5 text-left text-xs font-semibold text-slate-100 sm:px-4 sm:text-sm"
      >
        Total
      </th>
      <Td mono align="right" className="font-semibold text-slate-100 sm:!px-2">
        {formatNullableUSD(data.principalUsd)}
      </Td>
      <Td
        mono
        align="right"
        {...(data.earnedYieldError !== null
          ? { title: data.earnedYieldError }
          : {})}
        className="font-semibold text-slate-100 sm:!px-2"
      >
        {formatNullableUSD(data.earnedYieldUsd)}
      </Td>
      <Td
        mono
        align="right"
        title={`Blended annual rate across forecastable reserve balances. ${forecastTitle}`}
        className="font-semibold text-slate-100 sm:!px-2"
      >
        {totalApyPercent !== null && data.forecastUnavailableSymbols.length > 0
          ? `≈ ${formatAnnualInterestRatePercent(totalApyPercent)}`
          : formatAnnualInterestRatePercent(totalApyPercent)}
      </Td>
      <Td
        mono
        align="right"
        title={forecastTitle}
        className="font-semibold text-slate-100 sm:!px-2"
      >
        {reserveForecastMetric(data.next30dUsd)}
      </Td>
      <Td
        mono
        align="right"
        title={forecastTitle}
        className="font-semibold text-slate-100 sm:!px-2"
      >
        {reserveForecastMetric(data.next365dUsd)}
      </Td>
    </tr>
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
}: ReserveYieldTableState): string {
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
}: ReserveYieldTableState) {
  const holdings = data?.holdings ?? [];

  if (data === null || holdings.length === 0) {
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
              Annual rate
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
        <tfoot>
          <ReserveYieldTotalRow data={data} />
        </tfoot>
      </Table>
    </section>
  );
}
