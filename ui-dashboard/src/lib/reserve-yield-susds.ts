import { weiToUsd } from "@/lib/format";
import {
  asArray,
  bigintField,
  errorMessage,
  fetchGraphql,
  isRecord,
  joinErrors,
  unixSecondsToIso,
} from "@/lib/reserve-yield-shared";
import {
  FORECASTABLE_SUSDS_SYMBOL,
  type FetchImpl,
  type ReserveYieldHolding,
  type SusdsYieldLedger,
  type SusdsYieldLedgerResult,
  type SusdsYieldState,
} from "@/lib/reserve-yield-types";

const SUSDS_YIELD_SUMMARY_ID = "1-susds";
const TRACKED_SUSDS_WALLET_IDENTIFIERS = new Set([
  "0xd0697f70e79476195b742d5afab14be50f98cc1e",
  "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1",
]);

const SUSDS_YIELD_SUMMARY_QUERY = /* GraphQL */ `
  query SusdsYieldSummary($id: String!) {
    SusdsYieldSummary(where: { id: { _eq: $id } }, limit: 1) {
      id
      currentShares
      costBasisUsdWei
      realizedYieldUsdWei
      transferredOutYieldUsdWei
      redeemedYieldUsdWei
      currentValueUsdWei
      unrealizedYieldUsdWei
      totalEarnedYieldUsdWei
      sharePriceUsdWei
      lastUpdatedBlock
      lastUpdatedTimestamp
    }
  }
`;

function isSusdsHolding(holding: ReserveYieldHolding): boolean {
  return holding.assetSymbol.toUpperCase() === FORECASTABLE_SUSDS_SYMBOL;
}

function isIndexedSusdsHolding(holding: ReserveYieldHolding): boolean {
  const identifier = holding.identifier?.toLowerCase() ?? null;
  return (
    isSusdsHolding(holding) &&
    identifier !== null &&
    TRACKED_SUSDS_WALLET_IDENTIFIERS.has(identifier)
  );
}

function currentSusdsPrincipalUsd(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(isSusdsHolding)
    .reduce((sum, holding) => sum + holding.principalUsd, 0);
}

function currentIndexedSusdsPrincipalUsd(
  holdings: ReserveYieldHolding[],
): number {
  return holdings
    .filter(isIndexedSusdsHolding)
    .reduce((sum, holding) => sum + holding.principalUsd, 0);
}

function hasUnindexedSusdsHolding(holdings: ReserveYieldHolding[]): boolean {
  return holdings.some(
    (holding) => isSusdsHolding(holding) && !isIndexedSusdsHolding(holding),
  );
}

function applySusdsYieldLedger(
  holdings: ReserveYieldHolding[],
  ledger: SusdsYieldLedger | null,
): ReserveYieldHolding[] {
  if (ledger === null) return holdings;
  const susdsPrincipalUsd = currentIndexedSusdsPrincipalUsd(holdings);
  if (susdsPrincipalUsd <= 0 || susdsPrincipalUsd < ledger.currentValueUsd) {
    return holdings;
  }

  return holdings.map((holding) => {
    if (!isIndexedSusdsHolding(holding)) {
      return holding;
    }
    return {
      ...holding,
      earnedYieldUsd:
        ledger.earnedYieldUsd * (holding.principalUsd / susdsPrincipalUsd),
    };
  });
}

function refreshSusdsUnrealizedYield(
  holdings: ReserveYieldHolding[],
  ledger: SusdsYieldLedger,
  useCurrentReserveBalance: boolean,
): { ledger: SusdsYieldLedger; warning: string | null } {
  if (!useCurrentReserveBalance) return { ledger, warning: null };
  const indexedCurrentValueUsd = currentIndexedSusdsPrincipalUsd(holdings);
  const totalCurrentValueUsd = currentSusdsPrincipalUsd(holdings);
  if (hasUnindexedSusdsHolding(holdings)) {
    if (totalCurrentValueUsd <= ledger.currentValueUsd) {
      return { ledger, warning: null };
    }
    return {
      ledger,
      warning:
        "sUSDS earned-yield ledger: current reserve includes sUSDS rows outside indexed wallets; using indexed ledger value without current-balance refresh.",
    };
  }

  if (
    indexedCurrentValueUsd <= 0 ||
    indexedCurrentValueUsd < ledger.currentValueUsd
  ) {
    return { ledger, warning: null };
  }
  const unrealizedYieldUsd = Math.max(
    indexedCurrentValueUsd - ledger.costBasisUsd,
    0,
  );
  return {
    ledger: {
      ...ledger,
      earnedYieldUsd: ledger.realizedYieldUsd + unrealizedYieldUsd,
      unrealizedYieldUsd,
    },
    warning: null,
  };
}

function parseSusdsYieldLedger(payload: unknown): SusdsYieldLedgerResult {
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
  const rows = data ? asArray(data.SusdsYieldSummary) : [];
  const row = rows.find(isRecord);
  if (!row) {
    return {
      ledger: null,
      error: "sUSDS earned-yield ledger pending: no indexed summary row yet.",
    };
  }

  const earnedYieldWei = bigintField(
    row.totalEarnedYieldUsdWei,
    "totalEarnedYieldUsdWei",
  );
  const costBasisWei = bigintField(row.costBasisUsdWei, "costBasisUsdWei");
  const currentValueWei = bigintField(
    row.currentValueUsdWei,
    "currentValueUsdWei",
  );
  const realizedYieldWei = bigintField(
    row.realizedYieldUsdWei,
    "realizedYieldUsdWei",
  );
  const unrealizedYieldWei = bigintField(
    row.unrealizedYieldUsdWei,
    "unrealizedYieldUsdWei",
  );
  const lastUpdatedTimestamp = bigintField(
    row.lastUpdatedTimestamp,
    "lastUpdatedTimestamp",
  );
  return {
    ledger: {
      earnedYieldUsd: weiToUsd(earnedYieldWei),
      realizedYieldUsd: weiToUsd(realizedYieldWei),
      unrealizedYieldUsd: weiToUsd(unrealizedYieldWei),
      costBasisUsd: weiToUsd(costBasisWei),
      currentValueUsd: weiToUsd(currentValueWei),
      asOf: unixSecondsToIso(lastUpdatedTimestamp),
    },
    error: null,
  };
}

export async function fetchSusdsYieldLedger(
  fetchImpl: FetchImpl,
): Promise<SusdsYieldLedgerResult> {
  return fetchGraphql(fetchImpl, SUSDS_YIELD_SUMMARY_QUERY, {
    id: SUSDS_YIELD_SUMMARY_ID,
  }).then(parseSusdsYieldLedger);
}

export function applySusdsYieldLedgerResult(
  holdings: ReserveYieldHolding[],
  result: PromiseSettledResult<SusdsYieldLedgerResult>,
  useCurrentReserveBalance: boolean,
  hasCurrentSusdsAsset: boolean,
): SusdsYieldState {
  const hasVisibleSusdsHolding = currentSusdsPrincipalUsd(holdings) > 0;
  const shouldSurfaceLedgerError =
    hasVisibleSusdsHolding || hasCurrentSusdsAsset || !useCurrentReserveBalance;
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
        ? errorMessage("sUSDS earned-yield ledger", result.reason)
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
  const { ledger, warning } = refreshSusdsUnrealizedYield(
    holdings,
    rawLedger,
    useCurrentReserveBalance,
  );

  return {
    holdings: applySusdsYieldLedger(holdings, ledger),
    earnedYieldUsd: ledger.earnedYieldUsd,
    realizedYieldUsd: ledger.realizedYieldUsd,
    unrealizedYieldUsd: ledger.unrealizedYieldUsd,
    earnedYieldAsOf: ledger.asOf,
    earnedYieldError: joinErrors(warning),
  };
}
