import { weiToUsd } from "@/lib/format";
import { STETH_YIELD_SUMMARY_QUERY } from "@/lib/queries/reserve-yield";
import {
  asArray,
  bigintField,
  errorMessage,
  fetchGraphql,
  fetchJson,
  isRecord,
  joinErrors,
  numericField,
  unixSecondsToIso,
} from "@/lib/reserve-yield-shared";
import {
  FORECASTABLE_STETH_SYMBOL,
  type FetchImpl,
  type ReserveYieldHolding,
  type StethYieldLedger,
  type StethYieldLedgerResult,
  type StethYieldState,
} from "@/lib/reserve-yield-types";

const LIDO_STETH_APR_URL = "https://eth-api.lido.fi/v1/protocol/steth/apr/last";

const STETH_CHAIN_ID = 1;
const STETH_SYMBOL = "STETH";
const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const STETH_YIELD_SUMMARY_ID = "1-steth";
// Mirror: indexer-envio/src/handlers/steth/shared.ts TRACKED_STETH_WALLETS.
// Keep both in sync when tracked reserve wallets change.
const TRACKED_STETH_WALLET_IDENTIFIERS = new Set([
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
]);
const STALE_INDEXED_STETH_WARNING =
  "stETH earned-yield ledger: current indexed reserve balance is below indexed ledger balance; using indexed ledger value without current-balance refresh.";
const MISSING_INDEXED_STETH_BALANCE_WARNING =
  "stETH earned-yield ledger: current reserve stETH row is missing token balance; using indexed ledger value without current-balance refresh.";

function validateStethMeta(meta: unknown): void {
  if (!isRecord(meta)) {
    throw new Error("Lido stETH APR response did not contain metadata");
  }
  const symbol =
    typeof meta.symbol === "string" ? meta.symbol.trim().toUpperCase() : "";
  const address =
    typeof meta.address === "string" ? meta.address.trim().toLowerCase() : "";
  const chainId = numericField(meta.chainId);
  if (symbol !== STETH_SYMBOL) {
    throw new Error("Lido stETH APR metadata symbol did not match stETH");
  }
  if (address !== STETH_ADDRESS) {
    throw new Error("Lido stETH APR metadata address did not match stETH");
  }
  if (chainId !== STETH_CHAIN_ID) {
    throw new Error("Lido stETH APR metadata chainId did not match Ethereum");
  }
}

export function parseLidoStethAprPercent(payload: unknown): number {
  if (!isRecord(payload)) {
    throw new Error("Lido stETH APR response was not an object");
  }
  validateStethMeta(payload.meta);

  const data = isRecord(payload.data) ? payload.data : null;
  const apr = data === null ? null : numericField(data.apr);
  if (apr === null || apr < 0) {
    throw new Error("Lido stETH APR response did not contain a valid APR");
  }
  return apr;
}

export async function fetchLidoStethApr(fetchImpl: FetchImpl): Promise<number> {
  return fetchJson(fetchImpl, LIDO_STETH_APR_URL).then(
    parseLidoStethAprPercent,
  );
}

function isStethHolding(holding: ReserveYieldHolding): boolean {
  return holding.assetSymbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL;
}

function isIndexedStethHolding(holding: ReserveYieldHolding): boolean {
  const identifier = holding.identifier?.toLowerCase() ?? null;
  return (
    isStethHolding(holding) &&
    holding.hasTokenBalance &&
    identifier !== null &&
    TRACKED_STETH_WALLET_IDENTIFIERS.has(identifier)
  );
}

function isTrackedStethHolding(holding: ReserveYieldHolding): boolean {
  const identifier = holding.identifier?.toLowerCase() ?? null;
  return (
    isStethHolding(holding) &&
    identifier !== null &&
    TRACKED_STETH_WALLET_IDENTIFIERS.has(identifier)
  );
}

function currentStethBalance(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(isStethHolding)
    .reduce((sum, holding) => sum + holding.balance, 0);
}

function currentIndexedStethBalance(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(isIndexedStethHolding)
    .reduce((sum, holding) => sum + holding.balance, 0);
}

function currentIndexedStethValueUsd(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(isIndexedStethHolding)
    .reduce((sum, holding) => sum + holding.principalUsd, 0);
}

function hasUnindexedStethHolding(holdings: ReserveYieldHolding[]): boolean {
  return holdings.some(
    (holding) => isStethHolding(holding) && !isIndexedStethHolding(holding),
  );
}

function hasTrackedStethHoldingWithoutTokenBalance(
  holdings: ReserveYieldHolding[],
): boolean {
  return holdings.some(
    (holding) => isTrackedStethHolding(holding) && !holding.hasTokenBalance,
  );
}

function currentStethUnitPriceUsd(
  holdings: ReserveYieldHolding[],
): number | null {
  const balance = currentIndexedStethBalance(holdings);
  if (balance <= 0) return null;
  return currentIndexedStethValueUsd(holdings) / balance;
}

function markStethYieldToUsd(
  amountSteth: number,
  unitPriceUsd: number,
): number {
  return amountSteth * unitPriceUsd;
}

// weiToUsd is the shared 1e18 scaler; these ledger fields are stETH units.
function weiToSteth(value: bigint): number {
  return weiToUsd(value);
}

function applyStethYieldLedger(
  holdings: ReserveYieldHolding[],
  ledger: StethYieldLedger | null,
  unitPriceUsd: number | null,
): ReserveYieldHolding[] {
  if (ledger === null || unitPriceUsd === null) return holdings;
  const indexedBalance = currentIndexedStethBalance(holdings);
  if (indexedBalance <= 0) return holdings;

  return holdings.map((holding) => {
    if (!isIndexedStethHolding(holding)) {
      return holding;
    }
    return {
      ...holding,
      earnedYieldUsd:
        markStethYieldToUsd(ledger.earnedYieldSteth, unitPriceUsd) *
        (holding.balance / indexedBalance),
      yieldModel:
        "Lido stETH APR forecast; earned yield is token-unit stETH staking yield marked to current USD, not ETH price appreciation",
    };
  });
}

function refreshStethUnrealizedYield(
  holdings: ReserveYieldHolding[],
  ledger: StethYieldLedger,
  useCurrentReserveBalance: boolean,
): {
  ledger: StethYieldLedger;
  unitPriceUsd: number | null;
  warning: string | null;
} {
  const unitPriceUsd = currentStethUnitPriceUsd(holdings);
  if (!useCurrentReserveBalance) return { ledger, unitPriceUsd, warning: null };
  const indexedBalance = currentIndexedStethBalance(holdings);
  const totalBalance = currentStethBalance(holdings);
  if (hasTrackedStethHoldingWithoutTokenBalance(holdings)) {
    return {
      ledger,
      unitPriceUsd: null,
      warning: MISSING_INDEXED_STETH_BALANCE_WARNING,
    };
  }
  if (hasUnindexedStethHolding(holdings)) {
    if (totalBalance <= ledger.currentBalanceSteth) {
      return { ledger, unitPriceUsd, warning: null };
    }
    return {
      ledger,
      unitPriceUsd,
      warning:
        "stETH earned-yield ledger: current reserve includes stETH rows outside indexed wallets; using indexed ledger value without current-balance refresh.",
    };
  }

  if (indexedBalance <= 0 || unitPriceUsd === null) {
    return {
      ledger,
      unitPriceUsd,
      warning:
        ledger.currentBalanceSteth > 0 ? STALE_INDEXED_STETH_WARNING : null,
    };
  }
  if (indexedBalance < ledger.currentBalanceSteth) {
    return {
      ledger,
      unitPriceUsd,
      warning: STALE_INDEXED_STETH_WARNING,
    };
  }
  const unrealizedYieldSteth = Math.max(
    indexedBalance - ledger.remainingPrincipalSteth,
    0,
  );
  return {
    ledger: {
      ...ledger,
      currentBalanceSteth: indexedBalance,
      earnedYieldSteth: ledger.realizedYieldSteth + unrealizedYieldSteth,
      unrealizedYieldSteth,
    },
    unitPriceUsd,
    warning: null,
  };
}

function parseStethYieldLedger(payload: unknown): StethYieldLedgerResult {
  if (!isRecord(payload)) {
    throw new Error("Hasura response was not an object");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const message =
      isRecord(first) && typeof first.message === "string"
        ? first.message
        : "GraphQL error";
    throw new Error(message);
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const rows = data ? asArray(data.StethYieldSummary) : [];
  const row = rows.find(isRecord);
  if (!row) {
    return {
      ledger: null,
      error: "stETH earned-yield ledger pending: no indexed summary row yet.",
    };
  }

  const earnedYieldWei = bigintField(
    row.totalEarnedYieldAmount,
    "totalEarnedYieldAmount",
  );
  const realizedYieldWei = bigintField(
    row.realizedYieldAmount,
    "realizedYieldAmount",
  );
  const unrealizedYieldWei = bigintField(
    row.unrealizedYieldAmount,
    "unrealizedYieldAmount",
  );
  // The query keeps transferredOutYieldAmount for future UI decomposition; this
  // aggregate currently reports realized, unrealized, and total earned stETH.
  const remainingPrincipalWei = bigintField(
    row.remainingPrincipalAmount,
    "remainingPrincipalAmount",
  );
  const currentBalanceWei = bigintField(row.currentBalance, "currentBalance");
  const lastUpdatedTimestamp = bigintField(
    row.lastUpdatedTimestamp,
    "lastUpdatedTimestamp",
  );
  return {
    ledger: {
      earnedYieldSteth: weiToSteth(earnedYieldWei),
      realizedYieldSteth: weiToSteth(realizedYieldWei),
      unrealizedYieldSteth: weiToSteth(unrealizedYieldWei),
      remainingPrincipalSteth: weiToSteth(remainingPrincipalWei),
      currentBalanceSteth: weiToSteth(currentBalanceWei),
      asOf: unixSecondsToIso(lastUpdatedTimestamp),
    },
    error: null,
  };
}

export async function fetchStethYieldLedger(
  fetchImpl: FetchImpl,
): Promise<StethYieldLedgerResult> {
  return fetchGraphql(fetchImpl, STETH_YIELD_SUMMARY_QUERY, {
    id: STETH_YIELD_SUMMARY_ID,
  }).then(parseStethYieldLedger);
}

export function applyStethYieldLedgerResult(
  holdings: ReserveYieldHolding[],
  result: PromiseSettledResult<StethYieldLedgerResult>,
  useCurrentReserveBalance: boolean,
  hasCurrentStethAsset: boolean,
): StethYieldState {
  const hasVisibleStethHolding = currentStethBalance(holdings) > 0;
  const shouldSurfaceLedgerError =
    hasVisibleStethHolding || hasCurrentStethAsset || !useCurrentReserveBalance;
  const emptyState = {
    holdings,
    earnedYieldUsd: null,
    realizedYieldUsd: null,
    unrealizedYieldUsd: null,
    earnedYieldAsOf: null,
  };
  if (result.status === "rejected") {
    return {
      ...emptyState,
      earnedYieldError: shouldSurfaceLedgerError
        ? errorMessage("stETH earned-yield ledger", result.reason)
        : null,
    };
  }

  const { ledger: rawLedger, error } = result.value;
  if (rawLedger === null) {
    return {
      ...emptyState,
      earnedYieldError: shouldSurfaceLedgerError ? error : null,
    };
  }
  const { ledger, unitPriceUsd, warning } = refreshStethUnrealizedYield(
    holdings,
    rawLedger,
    useCurrentReserveBalance,
  );
  const realizedYieldUsd =
    unitPriceUsd === null
      ? null
      : markStethYieldToUsd(ledger.realizedYieldSteth, unitPriceUsd);
  const unrealizedYieldUsd =
    unitPriceUsd === null
      ? null
      : markStethYieldToUsd(ledger.unrealizedYieldSteth, unitPriceUsd);
  const earnedYieldUsd =
    realizedYieldUsd === null || unrealizedYieldUsd === null
      ? null
      : realizedYieldUsd + unrealizedYieldUsd;

  return {
    holdings: applyStethYieldLedger(holdings, ledger, unitPriceUsd),
    earnedYieldUsd,
    realizedYieldUsd,
    unrealizedYieldUsd,
    earnedYieldAsOf: ledger.asOf,
    earnedYieldError: joinErrors(warning),
  };
}
