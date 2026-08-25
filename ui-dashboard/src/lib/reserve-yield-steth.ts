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
import { STETH_YIELD_LATEST_SNAPSHOTS_QUERY } from "@/lib/queries/reserve-yield";
import { weiToUsd } from "@/lib/format";
import {
  FORECASTABLE_STETH_SYMBOL,
  RESERVE_YIELD_ETHEREUM_CHAIN_ID,
  STETH_TOKEN_ADDRESS,
  type FetchImpl,
  type ReserveYieldHolding,
  type StethYieldLedgerEntry,
  type StethYieldLedgerResult,
  type StethYieldState,
} from "@/lib/reserve-yield-types";
import {
  isIndexedStethHolding,
  isTrackedStethWalletIdentifier,
} from "@/lib/reserve-yield-steth-coverage";

const LIDO_STETH_APR_URL = "https://eth-api.lido.fi/v1/protocol/steth/apr/last";

const STETH_SYMBOL = "STETH";
const STETH_LATEST_SNAPSHOT_LIMIT = 50;

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
  if (address !== STETH_TOKEN_ADDRESS) {
    throw new Error("Lido stETH APR metadata address did not match stETH");
  }
  if (chainId !== RESERVE_YIELD_ETHEREUM_CHAIN_ID) {
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

function unindexedStethHoldingWarning(
  holding: ReserveYieldHolding,
): string | null {
  if (!isStethHolding(holding) || holding.principalUsd <= 0) return null;
  const identifier = holding.identifier?.trim().toLowerCase() ?? null;
  if (holding.chain.trim().toLowerCase() !== "ethereum") {
    return "stETH earned-yield actuals are indexed only for Ethereum holdings.";
  }
  return identifier === null
    ? "stETH earned-yield actuals missing wallet identifier for a current stETH holding."
    : `stETH earned-yield actuals missing indexed wallet configuration for ${identifier}.`;
}

function currentStethPrincipalUsd(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(isStethHolding)
    .reduce((sum, holding) => sum + holding.principalUsd, 0);
}

function stethUsdPerToken(holding: ReserveYieldHolding): number | null {
  if (!holding.hasTokenBalance || holding.balance <= 0) return null;
  const usdPerToken = holding.principalUsd / holding.balance;
  return Number.isFinite(usdPerToken) && usdPerToken > 0 ? usdPerToken : null;
}

function wei18ToTokenAmount(amountWei: bigint): number {
  return weiToUsd(amountWei);
}

function stethYieldUsd(amountWei: bigint, usdPerToken: number): number {
  return wei18ToTokenAmount(amountWei) * usdPerToken;
}

function oldestIso(values: string[]): string | null {
  let oldest: string | null = null;
  for (const value of values) {
    if (oldest === null || value < oldest) oldest = value;
  }
  return oldest;
}

function isMissingStethYieldDailySnapshotEntity(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("StethYieldDailySnapshot") &&
    (message.includes("not found in type") ||
      message.includes("Cannot query field"))
  );
}

function trackedStethWalletIdentifier(value: unknown): string | null {
  if (!isRecord(value) || typeof value.wallet !== "string") return null;
  const wallet = value.wallet.trim().toLowerCase();
  return isTrackedStethWalletIdentifier(wallet) ? wallet : null;
}

function trackedStethYieldLedgerEntry(
  value: unknown,
): StethYieldLedgerEntry | null {
  if (!isRecord(value)) return null;
  const wallet = trackedStethWalletIdentifier(value);
  const token =
    typeof value.token === "string" ? value.token.trim().toLowerCase() : null;
  if (
    numericField(value.chainId) !== RESERVE_YIELD_ETHEREUM_CHAIN_ID ||
    token !== STETH_TOKEN_ADDRESS ||
    wallet === null ||
    !isTrackedStethWalletIdentifier(wallet)
  ) {
    return null;
  }
  const sampledAtTimestamp = bigintField(
    value.sampledAtTimestamp,
    "sampledAtTimestamp",
  );
  return {
    wallet,
    earnedYieldAmount: bigintField(
      value.totalEarnedYieldAmount,
      "totalEarnedYieldAmount",
    ),
    realizedYieldAmount: bigintField(
      value.realizedYieldAmount,
      "realizedYieldAmount",
    ),
    unrealizedYieldAmount: bigintField(
      value.unrealizedYieldAmount,
      "unrealizedYieldAmount",
    ),
    asOf: unixSecondsToIso(sampledAtTimestamp),
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
    if (isMissingStethYieldDailySnapshotEntity(new Error(message))) {
      return {
        entries: [],
        error:
          "stETH earned-yield actuals pending: indexed wallet snapshots are not deployed yet.",
      };
    }
    throw new Error(message);
  }

  const data = isRecord(payload.data) ? payload.data : null;
  const rows = data ? asArray(data.StethYieldDailySnapshot) : [];
  const latestByWallet = new Map<string, StethYieldLedgerEntry>();
  const seenTrackedWallets = new Set<string>();

  for (const value of rows) {
    const wallet = trackedStethWalletIdentifier(value);
    if (wallet === null || seenTrackedWallets.has(wallet)) continue;
    // The query is newest-first. An invalid newest identity must not expose an
    // older snapshot as the current ledger entry for this tracked wallet.
    seenTrackedWallets.add(wallet);
    const entry = trackedStethYieldLedgerEntry(value);
    if (entry === null) {
      throw new Error(
        `StethYieldDailySnapshot newest row for tracked wallet ${wallet} had an invalid chain or token`,
      );
    }
    latestByWallet.set(entry.wallet, entry);
  }

  if (latestByWallet.size === 0) {
    return {
      entries: [],
      error:
        "stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
    };
  }

  return { entries: Array.from(latestByWallet.values()), error: null };
}

export async function fetchStethYieldLedger(
  fetchImpl: FetchImpl,
): Promise<StethYieldLedgerResult> {
  return fetchGraphql(fetchImpl, STETH_YIELD_LATEST_SNAPSHOTS_QUERY, {
    chainId: RESERVE_YIELD_ETHEREUM_CHAIN_ID,
    limit: STETH_LATEST_SNAPSHOT_LIMIT,
  }).then(parseStethYieldLedger);
}

function applyStethYieldLedger(
  holdings: ReserveYieldHolding[],
  entries: StethYieldLedgerEntry[],
): Omit<StethYieldState, "earnedYieldError"> & { warning: string | null } {
  const byWallet = new Map(entries.map((entry) => [entry.wallet, entry]));
  let earnedYieldUsd = 0;
  let realizedYieldUsd = 0;
  let unrealizedYieldUsd = 0;
  let appliedCount = 0;
  const asOfValues: string[] = [];
  const warnings: string[] = [];

  const nextHoldings = holdings.map((holding) => {
    if (!isIndexedStethHolding(holding)) {
      const warning = unindexedStethHoldingWarning(holding);
      if (warning !== null) warnings.push(warning);
      return holding;
    }
    const wallet = holding.identifier!.trim().toLowerCase();
    const entry = byWallet.get(wallet);
    if (!entry) {
      warnings.push(
        `stETH earned-yield actuals missing wallet snapshot for ${wallet}.`,
      );
      return holding;
    }
    const usdPerToken = stethUsdPerToken(holding);
    if (usdPerToken === null) {
      warnings.push(
        `stETH earned-yield actuals require token balance for ${wallet}.`,
      );
      return holding;
    }

    const holdingEarnedYieldUsd = stethYieldUsd(
      entry.earnedYieldAmount,
      usdPerToken,
    );
    earnedYieldUsd += holdingEarnedYieldUsd;
    realizedYieldUsd += stethYieldUsd(entry.realizedYieldAmount, usdPerToken);
    unrealizedYieldUsd += stethYieldUsd(
      entry.unrealizedYieldAmount,
      usdPerToken,
    );
    if (entry.asOf !== null) asOfValues.push(entry.asOf);
    appliedCount += 1;
    return {
      ...holding,
      earnedYieldUsd: holdingEarnedYieldUsd,
      yieldModel:
        "Launch-aligned stETH actual yield from indexed wallet snapshots; Lido APR forecast for run-rate",
    };
  });

  if (appliedCount === 0) {
    return {
      holdings,
      earnedYieldUsd: null,
      realizedYieldUsd: null,
      unrealizedYieldUsd: null,
      earnedYieldAsOf: null,
      warning:
        warnings.length > 0
          ? joinErrors(...warnings)
          : currentStethPrincipalUsd(holdings) > 0
            ? "stETH earned-yield actuals pending: no indexed wallet snapshot rows for current stETH holdings."
            : null,
    };
  }

  return {
    holdings: nextHoldings,
    earnedYieldUsd,
    realizedYieldUsd,
    unrealizedYieldUsd,
    earnedYieldAsOf: oldestIso(asOfValues),
    warning: joinErrors(...warnings),
  };
}

export function applyStethYieldLedgerResult(
  holdings: ReserveYieldHolding[],
  result: PromiseSettledResult<StethYieldLedgerResult>,
  useCurrentReserveBalance: boolean,
  hasCurrentStethAsset: boolean,
): StethYieldState {
  const hasVisibleStethHolding = currentStethPrincipalUsd(holdings) > 0;
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
        ? errorMessage("stETH earned-yield actuals", result.reason)
        : null,
    };
  }

  const { entries, error } = result.value;
  if (entries.length === 0) {
    return {
      ...emptyState,
      earnedYieldError: shouldSurfaceLedgerError ? error : null,
    };
  }

  const applied = applyStethYieldLedger(holdings, entries);
  return {
    holdings: applied.holdings,
    earnedYieldUsd: applied.earnedYieldUsd,
    realizedYieldUsd: applied.realizedYieldUsd,
    unrealizedYieldUsd: applied.unrealizedYieldUsd,
    earnedYieldAsOf: applied.earnedYieldAsOf,
    earnedYieldError: applied.warning,
  };
}
