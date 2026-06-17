import {
  asArray,
  isRecord,
  nullableStringField,
  numericField,
  stringField,
} from "@/lib/reserve-yield-shared";
import {
  FORECASTABLE_AUSD_SYMBOL,
  FORECASTABLE_STETH_SYMBOL,
  FORECASTABLE_SUSDS_SYMBOL,
  type ReserveYieldExtraction,
  type ReserveYieldHolding,
} from "@/lib/reserve-yield-types";

const TRACKED_YIELD_SYMBOLS = new Set([
  FORECASTABLE_AUSD_SYMBOL,
  FORECASTABLE_SUSDS_SYMBOL,
  FORECASTABLE_STETH_SYMBOL,
]);

function aggregateHoldings(
  holdings: ReserveYieldHolding[],
): ReserveYieldHolding[] {
  const bySource = new Map<string, ReserveYieldHolding>();
  for (const holding of holdings) {
    const key = [
      holding.assetSymbol.toUpperCase(),
      holding.chain.toLowerCase(),
      holding.sourceType.toLowerCase(),
      holding.sourceLabel.toLowerCase(),
      holding.identifier?.toLowerCase() ?? "",
      holding.custodianType?.toLowerCase() ?? "",
    ].join("|");
    const existing = bySource.get(key);
    if (!existing) {
      bySource.set(key, holding);
      continue;
    }
    bySource.set(key, {
      ...existing,
      balance: existing.balance + holding.balance,
      hasTokenBalance: existing.hasTokenBalance && holding.hasTokenBalance,
      principalUsd: existing.principalUsd + holding.principalUsd,
      earnedYieldUsd:
        existing.earnedYieldUsd !== null && holding.earnedYieldUsd !== null
          ? existing.earnedYieldUsd + holding.earnedYieldUsd
          : null,
    });
  }

  return Array.from(bySource.values()).sort((a, b) => {
    if (b.principalUsd !== a.principalUsd) {
      return b.principalUsd - a.principalUsd;
    }
    return `${a.chain} ${a.sourceLabel}`.localeCompare(
      `${b.chain} ${b.sourceLabel}`,
    );
  });
}

function isTrackedYieldAsset(symbol: string): boolean {
  return TRACKED_YIELD_SYMBOLS.has(symbol.toUpperCase());
}

function isSusdsSymbol(symbol: string): boolean {
  return symbol.toUpperCase() === FORECASTABLE_SUSDS_SYMBOL;
}

function isStethSymbol(symbol: string): boolean {
  return symbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL;
}

function requiresExplicitUsdValue(symbol: string): boolean {
  return isSusdsSymbol(symbol) || isStethSymbol(symbol);
}

function principalUsdFromAsset(
  asset: Record<string, unknown>,
  symbol: string,
): number | null {
  const usdValue = numericField(asset.usd_value);
  if (usdValue !== null) return usdValue;
  return requiresExplicitUsdValue(symbol) ? null : numericField(asset.balance);
}

function unbudgetedPrincipalUsdFromSource({
  asset,
  source,
  symbol,
}: {
  asset: Record<string, unknown>;
  source: Record<string, unknown>;
  symbol: string;
}): number | null {
  const sourceUsdValue = numericField(source.usd_value);
  if (sourceUsdValue !== null) return sourceUsdValue;

  const sourceBalance = numericField(source.balance);
  if (!requiresExplicitUsdValue(symbol)) return sourceBalance;
  if (sourceBalance === null) return null;

  const assetUsdValue = numericField(asset.usd_value);
  const assetBalance = numericField(asset.balance);
  if (assetUsdValue === null || assetBalance === null || assetBalance <= 0) {
    return null;
  }
  return assetUsdValue * (sourceBalance / assetBalance);
}

type SourcePrincipalUsdBudget = {
  assetUsdValue: number;
  denominatorUsd: number;
};

function principalUsdFromSource({
  asset,
  principalUsdBudget,
  source,
  symbol,
}: {
  asset: Record<string, unknown>;
  principalUsdBudget: SourcePrincipalUsdBudget | null;
  source: Record<string, unknown>;
  symbol: string;
}): number | null {
  const sourcePrincipalUsd = unbudgetedPrincipalUsdFromSource({
    asset,
    source,
    symbol,
  });
  if (
    sourcePrincipalUsd === null ||
    sourcePrincipalUsd <= 0 ||
    principalUsdBudget === null
  ) {
    return sourcePrincipalUsd;
  }
  return (
    principalUsdBudget.assetUsdValue *
    (sourcePrincipalUsd / principalUsdBudget.denominatorUsd)
  );
}

function principalUsdBudgetForAsset({
  asset,
  sources,
  symbol,
}: {
  asset: Record<string, unknown>;
  sources: Record<string, unknown>[];
  symbol: string;
}): SourcePrincipalUsdBudget | null {
  if (!requiresExplicitUsdValue(symbol)) return null;
  const assetUsdValue = numericField(asset.usd_value);
  if (assetUsdValue === null || assetUsdValue <= 0) return null;
  const sourcePrincipalUsdTotal = sources.reduce((sum, source) => {
    const sourcePrincipalUsd = unbudgetedPrincipalUsdFromSource({
      asset,
      source,
      symbol,
    });
    return sourcePrincipalUsd !== null && sourcePrincipalUsd > 0
      ? sum + sourcePrincipalUsd
      : sum;
  }, 0);
  if (sourcePrincipalUsdTotal <= assetUsdValue) return null;
  return {
    assetUsdValue,
    denominatorUsd: sourcePrincipalUsdTotal,
  };
}

type SourceTokenBalanceDerivation = {
  remainingAssetBalance: number;
  denominatorUsd: number;
};

function tokenBalanceFromSource({
  source,
  derivation,
  sourcePrincipalUsd,
}: {
  source: Record<string, unknown>;
  derivation: SourceTokenBalanceDerivation | null;
  sourcePrincipalUsd: number | null;
}): number | null {
  const sourceBalance = numericField(source.balance);
  if (sourceBalance !== null) return sourceBalance;

  if (
    sourcePrincipalUsd === null ||
    sourcePrincipalUsd <= 0 ||
    derivation === null ||
    derivation.denominatorUsd <= 0 ||
    derivation.remainingAssetBalance <= 0
  ) {
    return null;
  }
  return (
    derivation.remainingAssetBalance *
    (sourcePrincipalUsd / derivation.denominatorUsd)
  );
}

function tokenBalanceDerivationForAsset({
  asset,
  principalUsdBudget,
  sources,
  symbol,
}: {
  asset: Record<string, unknown>;
  principalUsdBudget: SourcePrincipalUsdBudget | null;
  sources: Record<string, unknown>[];
  symbol: string;
}): SourceTokenBalanceDerivation | null {
  const assetUsdValue = numericField(asset.usd_value);
  const assetBalance = numericField(asset.balance);
  if (
    assetUsdValue === null ||
    assetUsdValue <= 0 ||
    assetBalance === null ||
    assetBalance <= 0
  ) {
    return null;
  }

  let explicitSourceBalance = 0;
  let explicitSourcePrincipalUsd = 0;
  let missingBalanceSourcePrincipalUsd = 0;
  for (const source of sources) {
    const sourcePrincipalUsd = principalUsdFromSource({
      asset,
      principalUsdBudget,
      source,
      symbol,
    });
    const sourceBalance = numericField(source.balance);
    if (sourceBalance !== null) {
      explicitSourceBalance += Math.max(sourceBalance, 0);
      if (sourcePrincipalUsd !== null && sourcePrincipalUsd > 0) {
        explicitSourcePrincipalUsd += sourcePrincipalUsd;
      }
      continue;
    }
    if (sourcePrincipalUsd !== null && sourcePrincipalUsd > 0) {
      missingBalanceSourcePrincipalUsd += sourcePrincipalUsd;
    }
  }

  const remainingAssetBalance = assetBalance - explicitSourceBalance;
  if (remainingAssetBalance <= 0 || missingBalanceSourcePrincipalUsd <= 0) {
    return null;
  }
  const remainingAssetUsd = Math.max(
    assetUsdValue - explicitSourcePrincipalUsd,
    0,
  );
  return {
    remainingAssetBalance,
    denominatorUsd: Math.max(
      remainingAssetUsd,
      missingBalanceSourcePrincipalUsd,
    ),
  };
}

function sourceHoldingFromRecord({
  asset,
  derivation,
  principalUsdBudget,
  source,
  sourceIndex,
}: {
  asset: Record<string, unknown>;
  derivation: SourceTokenBalanceDerivation | null;
  principalUsdBudget: SourcePrincipalUsdBudget | null;
  source: Record<string, unknown>;
  sourceIndex: number;
}): ReserveYieldHolding | null {
  const assetSymbol = stringField(asset.symbol, "unknown");
  const principalUsd = principalUsdFromSource({
    asset,
    principalUsdBudget,
    source,
    symbol: assetSymbol,
  });
  const tokenBalance = tokenBalanceFromSource({
    source,
    derivation,
    sourcePrincipalUsd: principalUsd,
  });
  const balance = tokenBalance ?? principalUsd;
  if (principalUsd === null || balance === null) return null;

  const chain = stringField(asset.chain, "unknown");
  const sourceType = stringField(source.type, "unknown");
  const sourceLabel = stringField(source.label, "Unlabeled source");
  const identifier = nullableStringField(source.identifier);
  const custodianType = nullableStringField(source.custodian_type);
  return {
    id: [
      assetSymbol,
      chain,
      sourceType,
      identifier ?? sourceLabel,
      custodianType ?? "unknown",
      sourceIndex,
    ].join(":"),
    assetSymbol,
    chain,
    sourceType,
    sourceLabel,
    identifier,
    custodianType,
    balance,
    hasTokenBalance: tokenBalance !== null,
    principalUsd,
    earnedYieldUsd: null,
    apyPercent: null,
    yieldModel: "Yield source pending",
    dailyRunRateUsd: null,
    next30dUsd: null,
    next365dUsd: null,
    annualRunRateUsd: null,
  };
}

function assetFallbackHolding(
  asset: Record<string, unknown>,
  assetIndex: number,
): ReserveYieldHolding | null {
  const assetSymbol = stringField(asset.symbol, "unknown");
  const principalUsd = principalUsdFromAsset(asset, assetSymbol);
  const tokenBalance = numericField(asset.balance);
  const balance = tokenBalance ?? principalUsd;
  if (principalUsd === null || balance === null) return null;

  const chain = stringField(asset.chain, "unknown");
  return {
    id: `${assetSymbol}:${chain}:asset:${assetIndex}`,
    assetSymbol,
    chain,
    sourceType: "asset",
    sourceLabel: `${assetSymbol} reserve asset`,
    identifier: null,
    custodianType: null,
    balance,
    hasTokenBalance: tokenBalance !== null,
    principalUsd,
    earnedYieldUsd: null,
    apyPercent: null,
    yieldModel: "Yield source pending",
    dailyRunRateUsd: null,
    next30dUsd: null,
    next365dUsd: null,
    annualRunRateUsd: null,
  };
}

export function extractReserveYieldHoldings(
  reservePayload: unknown,
): ReserveYieldExtraction {
  const collateral = isRecord(reservePayload)
    ? reservePayload.collateral
    : null;
  const assets = isRecord(collateral) ? asArray(collateral.assets) : [];
  const holdings: ReserveYieldHolding[] = [];
  let malformedCount = 0;
  let trackedAssetCount = 0;
  let susdsAssetCount = 0;
  let stethAssetCount = 0;

  assets.forEach((assetValue, assetIndex) => {
    if (!isRecord(assetValue)) return;
    const symbol = stringField(assetValue.symbol, "");
    if (!isTrackedYieldAsset(symbol)) return;
    trackedAssetCount += 1;
    if (isSusdsSymbol(symbol)) {
      susdsAssetCount += 1;
    }
    if (isStethSymbol(symbol)) {
      stethAssetCount += 1;
    }

    const sources: Record<string, unknown>[] = [];
    for (const source of asArray(assetValue.sources)) {
      if (isRecord(source)) sources.push(source);
    }
    const sourceHoldings: ReserveYieldHolding[] = [];
    const principalUsdBudget = principalUsdBudgetForAsset({
      asset: assetValue,
      sources,
      symbol,
    });
    const derivation = tokenBalanceDerivationForAsset({
      asset: assetValue,
      principalUsdBudget,
      sources,
      symbol,
    });
    sources.forEach((source, sourceIndex) => {
      const holding = sourceHoldingFromRecord({
        asset: assetValue,
        derivation,
        principalUsdBudget,
        source,
        sourceIndex,
      });
      if (holding !== null) sourceHoldings.push(holding);
    });
    malformedCount += sources.length - sourceHoldings.length;

    if (sourceHoldings.length > 0) {
      holdings.push(...sourceHoldings);
      return;
    }

    const fallback = assetFallbackHolding(assetValue, assetIndex);
    if (fallback) {
      holdings.push(fallback);
    } else {
      malformedCount += 1;
    }
  });

  return {
    holdings: aggregateHoldings(holdings),
    malformedCount,
    trackedAssetCount,
    susdsAssetCount,
    stethAssetCount,
  };
}

export function hasStethHolding(holdings: ReserveYieldHolding[]): boolean {
  return holdings.some(
    (holding) =>
      holding.assetSymbol.toUpperCase() === FORECASTABLE_STETH_SYMBOL,
  );
}
