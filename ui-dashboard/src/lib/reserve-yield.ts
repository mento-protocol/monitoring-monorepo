const RESERVE_API_URL =
  "https://mento-analytics-api-12390052758.us-central1.run.app//api/v2/reserve";
const FEDFUNDS_CSV_URL =
  "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS";
const FETCH_TIMEOUT_MS = 8_000;

const RESERVE_YIELD_EXPENSE_BPS = 15;
const RESERVE_YIELD_REVENUE_SHARE_BPS = 8_000;
const FORECASTABLE_AUSD_SYMBOL = "AUSD";
const TRACKED_YIELD_SYMBOLS = new Set([FORECASTABLE_AUSD_SYMBOL, "SUSDS"]);

export type ReserveYieldHolding = {
  id: string;
  assetSymbol: string;
  chain: string;
  sourceType: string;
  sourceLabel: string;
  identifier: string | null;
  custodianType: string | null;
  balance: number;
  principalUsd: number;
  earnedYieldUsd: number | null;
  apyPercent: number | null;
  yieldModel: string;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
};

export type ReserveYieldResponse = {
  principalUsd: number | null;
  forecastPrincipalUsd: number | null;
  earnedYieldUsd: number | null;
  holdings: ReserveYieldHolding[];
  holdingsAsOf: string | null;
  grossApyPercent: number | null;
  fedfundsAsOf: string | null;
  expenseBps: typeof RESERVE_YIELD_EXPENSE_BPS;
  revenueShareBps: typeof RESERVE_YIELD_REVENUE_SHARE_BPS;
  netMentoApyPercent: number | null;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
  forecastUnavailableSymbols: string[];
  holdingsError: string | null;
  rateError: string | null;
};

type FetchImpl = typeof fetch;

type ReserveYieldExtraction = {
  holdings: ReserveYieldHolding[];
  malformedCount: number;
  trackedAssetCount: number;
};

type FredObservation = {
  date: string;
  grossApyPercent: number;
};

type ForecastTotals = {
  modeledHoldings: ReserveYieldHolding[];
  forecastPrincipalUsd: number | null;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
  forecastUnavailableSymbols: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

function nullableStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numericField(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function sourceHoldingFromRecord({
  asset,
  source,
  sourceIndex,
}: {
  asset: Record<string, unknown>;
  source: Record<string, unknown>;
  sourceIndex: number;
}): ReserveYieldHolding | null {
  const principalUsd =
    numericField(source.usd_value) ?? numericField(source.balance);
  const balance = numericField(source.balance) ?? principalUsd;
  if (principalUsd === null || balance === null) return null;

  const assetSymbol = stringField(asset.symbol, "unknown");
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
  const principalUsd =
    numericField(asset.usd_value) ?? numericField(asset.balance);
  const balance = numericField(asset.balance) ?? principalUsd;
  if (principalUsd === null || balance === null) return null;

  const assetSymbol = stringField(asset.symbol, "unknown");
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

function isTrackedYieldAsset(symbol: string): boolean {
  return TRACKED_YIELD_SYMBOLS.has(symbol.toUpperCase());
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

  assets.forEach((assetValue, assetIndex) => {
    if (!isRecord(assetValue)) return;
    if (!isTrackedYieldAsset(stringField(assetValue.symbol, ""))) return;
    trackedAssetCount += 1;

    const sources: Record<string, unknown>[] = [];
    for (const source of asArray(assetValue.sources)) {
      if (isRecord(source)) sources.push(source);
    }
    const sourceHoldings: ReserveYieldHolding[] = [];
    sources.forEach((source, sourceIndex) => {
      const holding = sourceHoldingFromRecord({
        asset: assetValue,
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
  };
}

function applyForecastModels(
  holdings: ReserveYieldHolding[],
  netMentoApyPercent: number | null,
): ReserveYieldHolding[] {
  return holdings.map((holding) => {
    if (holding.assetSymbol.toUpperCase() !== FORECASTABLE_AUSD_SYMBOL) {
      return {
        ...holding,
        yieldModel: "APY source pending",
      };
    }
    return {
      ...holding,
      apyPercent: netMentoApyPercent,
      yieldModel:
        "FEDFUNDS minus 15 bps expenses, then 80% Mento revenue share",
    };
  });
}

function buildForecastTotals(
  holdings: ReserveYieldHolding[],
  netMentoApyPercent: number | null,
): ForecastTotals {
  const modeledHoldings = applyForecastModels(holdings, netMentoApyPercent).map(
    estimateHolding,
  );
  const forecastableHoldings: ReserveYieldHolding[] = [];
  const unavailableSymbols = new Set<string>();
  for (const holding of modeledHoldings) {
    if (holding.apyPercent === null) {
      unavailableSymbols.add(holding.assetSymbol);
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

async function fetchJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(fetchImpl: FetchImpl, url: string): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function errorMessage(label: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${label}: ${detail}`;
}

export async function fetchReserveYieldSnapshot({
  fetchImpl = fetch,
  now = new Date(),
}: {
  fetchImpl?: FetchImpl;
  now?: Date;
} = {}): Promise<ReserveYieldResponse> {
  const [reserveResult, rateResult] = await Promise.allSettled([
    fetchJson(fetchImpl, RESERVE_API_URL),
    fetchText(fetchImpl, FEDFUNDS_CSV_URL).then(parseFredFedFundsCsv),
  ]);

  const fetchedAt = now.toISOString();
  let holdings: ReserveYieldHolding[] = [];
  let principalUsd: number | null = null;
  let holdingsAsOf: string | null = null;
  let holdingsError: string | null = null;

  if (reserveResult.status === "fulfilled") {
    const extracted = extractReserveYieldHoldings(reserveResult.value);
    holdings = extracted.holdings;
    principalUsd =
      holdings.length === 0 && extracted.malformedCount > 0
        ? null
        : holdings.reduce((sum, h) => sum + h.principalUsd, 0);
    holdingsAsOf = fetchedAt;
    if (extracted.malformedCount > 0) {
      holdingsError =
        extracted.holdings.length > 0
          ? "Some reserve yield rows were missing usable USD values."
          : "Reserve API returned yield rows without usable USD values.";
    }
  } else {
    holdingsError = errorMessage("Reserve API", reserveResult.reason);
  }

  let grossApyPercent: number | null = null;
  let fedfundsAsOf: string | null = null;
  let rateError: string | null = null;

  if (rateResult.status === "fulfilled") {
    grossApyPercent = rateResult.value.grossApyPercent;
    fedfundsAsOf = rateResult.value.date;
  } else {
    rateError = errorMessage("FRED FEDFUNDS", rateResult.reason);
  }

  const netMentoApyPercent =
    grossApyPercent === null
      ? null
      : computeNetMentoApyPercent(grossApyPercent);
  const forecast = buildForecastTotals(holdings, netMentoApyPercent);

  return {
    principalUsd,
    forecastPrincipalUsd: forecast.forecastPrincipalUsd,
    earnedYieldUsd: null,
    holdings: forecast.modeledHoldings,
    holdingsAsOf,
    grossApyPercent,
    fedfundsAsOf,
    expenseBps: RESERVE_YIELD_EXPENSE_BPS,
    revenueShareBps: RESERVE_YIELD_REVENUE_SHARE_BPS,
    netMentoApyPercent,
    dailyRunRateUsd: forecast.dailyRunRateUsd,
    next30dUsd: forecast.next30dUsd,
    next365dUsd: forecast.next365dUsd,
    annualRunRateUsd: forecast.annualRunRateUsd,
    forecastUnavailableSymbols: forecast.forecastUnavailableSymbols,
    holdingsError,
    rateError,
  };
}
