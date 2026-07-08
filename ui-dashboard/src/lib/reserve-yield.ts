import {
  fetchSkySavingsRate,
  parseSkySavingsRateApyPercent,
  computeSkySavingsRateApyPercentFromSsr,
  parseSkySavingsRateSsrApyPercent,
} from "@/lib/reserve-yield-sky";
import {
  applySusdsYieldLedgerResult,
  fetchSusdsYieldLedger,
} from "@/lib/reserve-yield-susds";
import {
  applyStethYieldLedgerResult,
  fetchLidoStethApr,
  fetchStethYieldLedger,
  parseLidoStethAprPercent,
} from "@/lib/reserve-yield-steth";
import {
  extractReserveYieldHoldings,
  hasStethHolding,
} from "@/lib/reserve-yield-holdings";
import {
  errorMessage,
  fetchJson,
  fetchText,
  joinErrors,
  numericField,
} from "@/lib/reserve-yield-shared";
import {
  FEDFUNDS_CSV_URL,
  FORECASTABLE_AUSD_SYMBOL,
  FORECASTABLE_SUSDS_SYMBOL,
  FORECASTABLE_STETH_SYMBOL,
  RESERVE_API_URL,
  RESERVE_YIELD_EXPENSE_BPS,
  RESERVE_YIELD_REVENUE_SHARE_BPS,
  type FetchImpl,
  type ForecastApyBySymbol,
  type ForecastTotals,
  type FredObservation,
  type ReserveHoldingsState,
  type ReserveYieldHolding,
  type ReserveYieldResponse,
  type SkySavingsRateObservation,
  type SkySavingsRateSource,
  type StethYieldState,
  type SusdsYieldState,
} from "@/lib/reserve-yield-types";

export type { ReserveYieldHolding, ReserveYieldResponse };
export {
  computeSkySavingsRateApyPercentFromSsr,
  extractReserveYieldHoldings,
  parseSkySavingsRateApyPercent,
  parseSkySavingsRateSsrApyPercent,
  parseLidoStethAprPercent,
};

function yieldForDays(
  principalUsd: number,
  netMentoApyPercent: number,
  days: number,
): number {
  return principalUsd * (netMentoApyPercent / 100) * (days / 365);
}

export function computeNetMentoApyPercent(
  grossApyPercent: number,
  expenseBps = RESERVE_YIELD_EXPENSE_BPS,
  revenueShareBps = RESERVE_YIELD_REVENUE_SHARE_BPS,
): number {
  return (grossApyPercent - expenseBps / 100) * (revenueShareBps / 10_000);
}

function estimateHolding(holding: ReserveYieldHolding): ReserveYieldHolding {
  if (holding.apyPercent === null) {
    return {
      ...holding,
      dailyRunRateUsd: null,
      next30dUsd: null,
      next365dUsd: null,
      annualRunRateUsd: null,
    };
  }
  return {
    ...holding,
    dailyRunRateUsd: yieldForDays(holding.principalUsd, holding.apyPercent, 1),
    next30dUsd: yieldForDays(holding.principalUsd, holding.apyPercent, 30),
    next365dUsd: yieldForDays(holding.principalUsd, holding.apyPercent, 365),
    annualRunRateUsd: yieldForDays(
      holding.principalUsd,
      holding.apyPercent,
      365,
    ),
  };
}

function applyForecastModels(
  holdings: ReserveYieldHolding[],
  apyBySymbol: ForecastApyBySymbol,
): ReserveYieldHolding[] {
  return holdings.map((holding) => {
    const symbol = holding.assetSymbol.toUpperCase();
    if (symbol === FORECASTABLE_AUSD_SYMBOL) {
      return {
        ...holding,
        apyPercent: apyBySymbol.ausdNetMentoApyPercent,
        yieldModel:
          "FEDFUNDS minus 15 bps expenses, then 80% Mento revenue share",
      };
    }
    if (symbol === FORECASTABLE_SUSDS_SYMBOL) {
      return {
        ...holding,
        apyPercent: apyBySymbol.susdsApyPercent,
        yieldModel:
          apyBySymbol.susdsApySource === "blockanalitica-overall"
            ? "Sky Savings Rate APY from Block Analitica fallback"
            : apyBySymbol.susdsApySource === "onchain-susds-ssr"
              ? "Sky Savings Rate APY from on-chain sUSDS.ssr()"
              : "Sky Savings Rate APY source pending",
      };
    }
    if (symbol === FORECASTABLE_STETH_SYMBOL) {
      return {
        ...holding,
        apyPercent: apyBySymbol.stethAprPercent,
        yieldModel:
          holding.earnedYieldUsd !== null
            ? holding.yieldModel
            : apyBySymbol.stethAprPercent === null
              ? "Lido stETH APR source pending; stETH mark-to-market changes are not counted as earned revenue"
              : "Lido stETH APR forecast; stETH mark-to-market changes are not counted as earned revenue",
      };
    }
    return {
      ...holding,
      yieldModel: "APY source pending",
    };
  });
}

function buildForecastTotals(
  holdings: ReserveYieldHolding[],
  apyBySymbol: ForecastApyBySymbol,
): ForecastTotals {
  const modeledHoldings = applyForecastModels(holdings, apyBySymbol).map(
    estimateHolding,
  );
  const forecastableHoldings: ReserveYieldHolding[] = [];
  const unavailableSymbols = new Set<string>();
  for (const holding of modeledHoldings) {
    if (holding.apyPercent === null) {
      unavailableSymbols.add(holding.assetSymbol.toUpperCase());
    } else {
      forecastableHoldings.push(holding);
    }
  }

  const forecastPrincipalUsd =
    forecastableHoldings.length === 0
      ? null
      : forecastableHoldings.reduce((sum, h) => sum + h.principalUsd, 0);
  const forecastUnavailableSymbols = Array.from(unavailableSymbols).sort();

  if (forecastPrincipalUsd === null) {
    return {
      modeledHoldings,
      forecastPrincipalUsd,
      dailyRunRateUsd: null,
      next30dUsd: null,
      next365dUsd: null,
      annualRunRateUsd: null,
      forecastUnavailableSymbols,
    };
  }

  return {
    modeledHoldings,
    forecastPrincipalUsd,
    dailyRunRateUsd: forecastableHoldings.reduce(
      (sum, h) => sum + (h.dailyRunRateUsd ?? 0),
      0,
    ),
    next30dUsd: forecastableHoldings.reduce(
      (sum, h) => sum + (h.next30dUsd ?? 0),
      0,
    ),
    next365dUsd: forecastableHoldings.reduce(
      (sum, h) => sum + (h.next365dUsd ?? 0),
      0,
    ),
    annualRunRateUsd: forecastableHoldings.reduce(
      (sum, h) => sum + (h.annualRunRateUsd ?? 0),
      0,
    ),
    forecastUnavailableSymbols,
  };
}

export function parseFredFedFundsCsv(csv: string): FredObservation {
  const rows = csv.split(/\r?\n/);

  for (let i = rows.length - 1; i >= 1; i -= 1) {
    const line = rows[i]!.trim();
    if (line === "") continue;
    const [date, rawRate] = line.split(",");
    const grossApyPercent = numericField(rawRate);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && grossApyPercent !== null) {
      return { date, grossApyPercent };
    }
  }

  throw new Error("FEDFUNDS CSV did not contain a valid observation");
}

function rateErrorForUnavailableForecasts(
  forecastUnavailableSymbols: string[],
  fedfundsError: string | null,
  skyRateError: string | null,
  stethRateError: string | null,
): string | null {
  const unavailable = new Set(forecastUnavailableSymbols);
  return joinErrors(
    unavailable.has(FORECASTABLE_AUSD_SYMBOL) ? fedfundsError : null,
    unavailable.has(FORECASTABLE_SUSDS_SYMBOL) ? skyRateError : null,
    unavailable.has(FORECASTABLE_STETH_SYMBOL) ? stethRateError : null,
  );
}

function reserveHoldingsState(
  reserveResult: PromiseSettledResult<unknown>,
  fetchedAt: string,
): ReserveHoldingsState {
  if (reserveResult.status === "rejected") {
    return {
      holdings: [],
      principalUsd: null,
      holdingsAsOf: null,
      holdingsError: errorMessage("Reserve API", reserveResult.reason),
      hasCurrentSusdsAsset: false,
      hasCurrentStethAsset: false,
    };
  }

  const extracted = extractReserveYieldHoldings(reserveResult.value);
  let holdingsError: string | null = null;
  if (extracted.malformedCount > 0) {
    holdingsError =
      extracted.holdings.length > 0
        ? "Some reserve yield rows were missing usable USD values."
        : "Reserve API returned yield rows without usable USD values.";
  }

  return {
    holdings: extracted.holdings,
    principalUsd:
      extracted.holdings.length === 0 && extracted.malformedCount > 0
        ? null
        : extracted.holdings.reduce((sum, h) => sum + h.principalUsd, 0),
    holdingsAsOf: fetchedAt,
    holdingsError,
    hasCurrentSusdsAsset: extracted.susdsAssetCount > 0,
    hasCurrentStethAsset: extracted.stethAssetCount > 0,
  };
}

function sumNullable(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0);
}

function oldestIso(...values: Array<string | null>): string | null {
  let oldest: string | null = null;
  for (const value of values) {
    if (value !== null && (oldest === null || value < oldest)) oldest = value;
  }
  return oldest;
}

type FedFundsState = {
  grossApyPercent: number | null;
  fedfundsAsOf: string | null;
  fedfundsError: string | null;
};

function fedFundsState(
  result: PromiseSettledResult<FredObservation>,
): FedFundsState {
  if (result.status === "fulfilled") {
    return {
      grossApyPercent: result.value.grossApyPercent,
      fedfundsAsOf: result.value.date,
      fedfundsError: null,
    };
  }
  return {
    grossApyPercent: null,
    fedfundsAsOf: null,
    fedfundsError: errorMessage("FRED FEDFUNDS", result.reason),
  };
}

type SkyRateState = {
  skySavingsRateApyPercent: number | null;
  skySavingsRateSource: SkySavingsRateSource | null;
  skyRateError: string | null;
};

function skyRateState(
  result: PromiseSettledResult<SkySavingsRateObservation>,
): SkyRateState {
  if (result.status === "fulfilled") {
    return {
      skySavingsRateApyPercent: result.value.apyPercent,
      skySavingsRateSource: result.value.source,
      skyRateError: null,
    };
  }
  return {
    skySavingsRateApyPercent: null,
    skySavingsRateSource: null,
    skyRateError: errorMessage("Sky Savings Rate", result.reason),
  };
}

async function stethAprState(
  holdings: ReserveYieldHolding[],
  fetchImpl: FetchImpl,
): Promise<{ stethAprPercent: number | null; stethRateError: string | null }> {
  if (!hasStethHolding(holdings)) {
    return { stethAprPercent: null, stethRateError: null };
  }
  try {
    // Lido is fetched only after the reserve payload proves stETH is held.
    // Starting it speculatively would reduce one RTT for current reserves, but
    // would also call Lido on every request even when stETH is absent.
    return {
      stethAprPercent: await fetchLidoStethApr(fetchImpl),
      stethRateError: null,
    };
  } catch (err) {
    return {
      stethAprPercent: null,
      stethRateError: errorMessage("Lido stETH APR", err),
    };
  }
}

function buildReserveYieldResponse({
  reserveState,
  fedFunds,
  skyRate,
  susdsYield,
  stethYield,
  forecast,
  netMentoApyPercent,
  stethRateError,
}: {
  reserveState: ReserveHoldingsState;
  fedFunds: FedFundsState;
  skyRate: SkyRateState;
  susdsYield: SusdsYieldState;
  stethYield: StethYieldState;
  forecast: ForecastTotals;
  netMentoApyPercent: number | null;
  stethRateError: string | null;
}): ReserveYieldResponse {
  return {
    principalUsd: reserveState.principalUsd,
    forecastPrincipalUsd: forecast.forecastPrincipalUsd,
    earnedYieldUsd: sumNullable(
      susdsYield.earnedYieldUsd,
      stethYield.earnedYieldUsd,
    ),
    realizedYieldUsd: sumNullable(
      susdsYield.realizedYieldUsd,
      stethYield.realizedYieldUsd,
    ),
    unrealizedYieldUsd: sumNullable(
      susdsYield.unrealizedYieldUsd,
      stethYield.unrealizedYieldUsd,
    ),
    earnedYieldAsOf: oldestIso(
      susdsYield.earnedYieldAsOf,
      stethYield.earnedYieldAsOf,
    ),
    holdings: forecast.modeledHoldings,
    holdingsAsOf: reserveState.holdingsAsOf,
    grossApyPercent: fedFunds.grossApyPercent,
    fedfundsAsOf: fedFunds.fedfundsAsOf,
    expenseBps: RESERVE_YIELD_EXPENSE_BPS,
    revenueShareBps: RESERVE_YIELD_REVENUE_SHARE_BPS,
    netMentoApyPercent,
    skySavingsRateApyPercent: skyRate.skySavingsRateApyPercent,
    skySavingsRateSource: skyRate.skySavingsRateSource,
    dailyRunRateUsd: forecast.dailyRunRateUsd,
    next30dUsd: forecast.next30dUsd,
    next365dUsd: forecast.next365dUsd,
    annualRunRateUsd: forecast.annualRunRateUsd,
    forecastUnavailableSymbols: forecast.forecastUnavailableSymbols,
    holdingsError: reserveState.holdingsError,
    rateError: rateErrorForUnavailableForecasts(
      forecast.forecastUnavailableSymbols,
      fedFunds.fedfundsError,
      skyRate.skyRateError,
      stethRateError,
    ),
    earnedYieldError: joinErrors(
      susdsYield.earnedYieldError,
      stethYield.earnedYieldError,
    ),
  };
}

export async function fetchReserveYieldSnapshot({
  fetchImpl = fetch,
  now = new Date(),
}: {
  fetchImpl?: FetchImpl;
  now?: Date;
} = {}): Promise<ReserveYieldResponse> {
  const [reserveResult, fedfundsResult, skyRateResult, susdsLedgerResult] =
    await Promise.allSettled([
      fetchJson(fetchImpl, RESERVE_API_URL),
      fetchText(fetchImpl, FEDFUNDS_CSV_URL).then(parseFredFedFundsCsv),
      fetchSkySavingsRate(fetchImpl),
      fetchSusdsYieldLedger(fetchImpl),
    ]);

  const fetchedAt = now.toISOString();
  const reserveState = reserveHoldingsState(reserveResult, fetchedAt);
  let { holdings } = reserveState;
  const fedFunds = fedFundsState(fedfundsResult);
  const skyRate = skyRateState(skyRateResult);

  const susdsYield = applySusdsYieldLedgerResult(
    holdings,
    susdsLedgerResult,
    reserveResult.status === "fulfilled",
    reserveState.hasCurrentSusdsAsset,
  );
  holdings = susdsYield.holdings;
  const stethLedgerResult =
    hasStethHolding(holdings) || reserveState.hasCurrentStethAsset
      ? await fetchStethYieldLedger(fetchImpl).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
      : {
          status: "fulfilled" as const,
          value: { entries: [], error: null },
        };
  const stethYield = applyStethYieldLedgerResult(
    holdings,
    stethLedgerResult,
    reserveResult.status === "fulfilled",
    reserveState.hasCurrentStethAsset,
  );
  holdings = stethYield.holdings;

  const { stethAprPercent, stethRateError } = await stethAprState(
    holdings,
    fetchImpl,
  );

  const netMentoApyPercent =
    fedFunds.grossApyPercent === null
      ? null
      : computeNetMentoApyPercent(fedFunds.grossApyPercent);
  const forecast = buildForecastTotals(holdings, {
    ausdNetMentoApyPercent: netMentoApyPercent,
    susdsApyPercent: skyRate.skySavingsRateApyPercent,
    susdsApySource: skyRate.skySavingsRateSource,
    stethAprPercent,
  });

  return buildReserveYieldResponse({
    reserveState,
    fedFunds,
    skyRate,
    susdsYield,
    stethYield,
    forecast,
    netMentoApyPercent,
    stethRateError,
  });
}
