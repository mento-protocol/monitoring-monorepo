const RESERVE_API_URL =
  "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve";
const FEDFUNDS_CSV_URL =
  "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS";
const SKY_SUSDS_RPC_URL = "https://ethereum.publicnode.com";
const SKY_SUSDS_CONTRACT_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
const SKY_SUSDS_SSR_CALL_DATA = "0x03607ceb";
const SKY_OVERALL_URL = "https://info-sky.blockanalitica.com/api/v1/overall/";
const FETCH_TIMEOUT_MS = 8_000;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const RESERVE_YIELD_EXPENSE_BPS = 15;
const RESERVE_YIELD_REVENUE_SHARE_BPS = 8_000;
const FORECASTABLE_AUSD_SYMBOL = "AUSD";
const FORECASTABLE_SUSDS_SYMBOL = "SUSDS";
const SUSDS_YIELD_SUMMARY_ID = "1-susds";
const TRACKED_YIELD_SYMBOLS = new Set([
  FORECASTABLE_AUSD_SYMBOL,
  FORECASTABLE_SUSDS_SYMBOL,
]);

const SUSDS_YIELD_SUMMARY_QUERY = /* GraphQL */ `
  query SusdsYieldSummary($id: ID!) {
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
  realizedYieldUsd: number | null;
  unrealizedYieldUsd: number | null;
  earnedYieldAsOf: string | null;
  holdings: ReserveYieldHolding[];
  holdingsAsOf: string | null;
  grossApyPercent: number | null;
  fedfundsAsOf: string | null;
  expenseBps: typeof RESERVE_YIELD_EXPENSE_BPS;
  revenueShareBps: typeof RESERVE_YIELD_REVENUE_SHARE_BPS;
  netMentoApyPercent: number | null;
  skySavingsRateApyPercent: number | null;
  skySavingsRateSource: SkySavingsRateSource | null;
  dailyRunRateUsd: number | null;
  next30dUsd: number | null;
  next365dUsd: number | null;
  annualRunRateUsd: number | null;
  forecastUnavailableSymbols: string[];
  holdingsError: string | null;
  rateError: string | null;
  earnedYieldError: string | null;
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

type SkySavingsRateSource = "onchain-susds-ssr" | "blockanalitica-overall";

type SkySavingsRateObservation = {
  apyPercent: number;
  source: SkySavingsRateSource;
};

type ForecastApyBySymbol = {
  ausdNetMentoApyPercent: number | null;
  susdsApyPercent: number | null;
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

type SusdsYieldLedger = {
  earnedYieldUsd: number;
  realizedYieldUsd: number;
  unrealizedYieldUsd: number;
  costBasisUsd: number;
  asOf: string | null;
};

type SusdsYieldLedgerResult = {
  ledger: SusdsYieldLedger | null;
  error: string | null;
};

type SusdsYieldState = {
  holdings: ReserveYieldHolding[];
  earnedYieldUsd: number | null;
  realizedYieldUsd: number | null;
  unrealizedYieldUsd: number | null;
  earnedYieldAsOf: string | null;
  earnedYieldError: string | null;
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

function bigintField(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${label} was not an integer string`);
}

function weiToUsd(value: bigint): number {
  return Number(value) / 1e18;
}

function unixSecondsToIso(value: bigint): string | null {
  if (value <= BigInt(0)) return null;
  return new Date(Number(value) * 1000).toISOString();
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

function applySusdsYieldLedger(
  holdings: ReserveYieldHolding[],
  ledger: SusdsYieldLedger | null,
): ReserveYieldHolding[] {
  if (ledger === null) return holdings;
  const susdsHoldings = holdings.filter(
    (holding) =>
      holding.assetSymbol.toUpperCase() === FORECASTABLE_SUSDS_SYMBOL,
  );
  const susdsPrincipalUsd = susdsHoldings.reduce(
    (sum, holding) => sum + holding.principalUsd,
    0,
  );
  if (susdsPrincipalUsd <= 0) return holdings;

  return holdings.map((holding) => {
    if (holding.assetSymbol.toUpperCase() !== FORECASTABLE_SUSDS_SYMBOL) {
      return holding;
    }
    return {
      ...holding,
      earnedYieldUsd:
        ledger.earnedYieldUsd * (holding.principalUsd / susdsPrincipalUsd),
    };
  });
}

function currentSusdsPrincipalUsd(holdings: ReserveYieldHolding[]): number {
  return holdings
    .filter(
      (holding) =>
        holding.assetSymbol.toUpperCase() === FORECASTABLE_SUSDS_SYMBOL,
    )
    .reduce((sum, holding) => sum + holding.principalUsd, 0);
}

function refreshSusdsUnrealizedYield(
  holdings: ReserveYieldHolding[],
  ledger: SusdsYieldLedger,
  useCurrentReserveBalance: boolean,
): SusdsYieldLedger {
  if (!useCurrentReserveBalance) return ledger;
  const currentValueUsd = currentSusdsPrincipalUsd(holdings);
  if (currentValueUsd <= 0) return ledger;
  const unrealizedYieldUsd = Math.max(currentValueUsd - ledger.costBasisUsd, 0);
  return {
    ...ledger,
    earnedYieldUsd: ledger.realizedYieldUsd + unrealizedYieldUsd,
    unrealizedYieldUsd,
  };
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
        yieldModel: "Sky Savings Rate APY from on-chain sUSDS.ssr()",
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

export function parseSkySavingsRateApyPercent(payload: unknown): number {
  const records = Array.isArray(payload) ? payload : [payload];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const rate = numericField(record.sky_savings_rate_apy);
    if (rate === null) continue;
    if (rate > 1) {
      throw new Error(
        `sky_savings_rate_apy looks like a percent (${rate}), expected a decimal fraction`,
      );
    }
    return rate * 100;
  }

  throw new Error("Sky overall response did not contain sky_savings_rate_apy");
}

export function computeSkySavingsRateApyPercentFromSsr(ssrRay: bigint): number {
  const perSecondRate = Number(ssrRay) / 1e27;
  if (!Number.isFinite(perSecondRate) || perSecondRate < 1) {
    throw new Error(`sUSDS ssr() returned invalid ray value ${ssrRay}`);
  }
  return (Math.pow(perSecondRate, SECONDS_PER_YEAR) - 1) * 100;
}

export function parseSkySavingsRateSsrApyPercent(payload: unknown): number {
  if (!isRecord(payload)) {
    throw new Error("sUSDS ssr() RPC response was not an object");
  }

  if (isRecord(payload.error)) {
    const code = numericField(payload.error.code);
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "unknown RPC error";
    throw new Error(code === null ? message : `RPC ${code}: ${message}`);
  }

  const result = payload.result;
  if (
    typeof result !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(result) ||
    result === "0x"
  ) {
    throw new Error(
      "sUSDS ssr() RPC response did not contain a uint256 result",
    );
  }

  return computeSkySavingsRateApyPercentFromSsr(BigInt(result));
}

async function fetchJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchJsonRpcEthCall(
  fetchImpl: FetchImpl,
  {
    rpcUrl,
    to,
    data,
  }: {
    rpcUrl: string;
    to: string;
    data: string;
  },
): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchGraphql(
  fetchImpl: FetchImpl,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const hasuraUrl = process.env.NEXT_PUBLIC_HASURA_URL?.trim();
  if (!hasuraUrl) {
    throw new Error("NEXT_PUBLIC_HASURA_URL is not configured");
  }
  const res = await fetchImpl(hasuraUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
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
      asOf: unixSecondsToIso(lastUpdatedTimestamp),
    },
    error: null,
  };
}

async function fetchSusdsYieldLedger(
  fetchImpl: FetchImpl,
): Promise<SusdsYieldLedgerResult> {
  return fetchGraphql(fetchImpl, SUSDS_YIELD_SUMMARY_QUERY, {
    id: SUSDS_YIELD_SUMMARY_ID,
  }).then(parseSusdsYieldLedger);
}

function applySusdsYieldLedgerResult(
  holdings: ReserveYieldHolding[],
  result: PromiseSettledResult<SusdsYieldLedgerResult>,
  useCurrentReserveBalance: boolean,
): SusdsYieldState {
  const hasVisibleSusdsHolding = currentSusdsPrincipalUsd(holdings) > 0;
  const shouldSurfaceLedgerError =
    hasVisibleSusdsHolding || !useCurrentReserveBalance;
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
  const ledger = refreshSusdsUnrealizedYield(
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
    earnedYieldError: null,
  };
}

function errorMessage(label: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${label}: ${detail}`;
}

function joinErrors(...errors: Array<string | null>): string | null {
  const present = errors.filter((error): error is string => error !== null);
  return present.length === 0 ? null : present.join("; ");
}

function rateErrorForUnavailableForecasts(
  forecastUnavailableSymbols: string[],
  fedfundsError: string | null,
  skyRateError: string | null,
): string | null {
  const unavailable = new Set(forecastUnavailableSymbols);
  return joinErrors(
    unavailable.has(FORECASTABLE_AUSD_SYMBOL) ? fedfundsError : null,
    unavailable.has(FORECASTABLE_SUSDS_SYMBOL) ? skyRateError : null,
  );
}

async function fetchOnchainSkySavingsRate(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  const apyPercent = await fetchJsonRpcEthCall(fetchImpl, {
    rpcUrl: SKY_SUSDS_RPC_URL,
    to: SKY_SUSDS_CONTRACT_ADDRESS,
    data: SKY_SUSDS_SSR_CALL_DATA,
  }).then(parseSkySavingsRateSsrApyPercent);
  return { apyPercent, source: "onchain-susds-ssr" };
}

async function fetchBlockAnaliticaSkySavingsRateFallback(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  const apyPercent = await fetchJson(fetchImpl, SKY_OVERALL_URL).then(
    parseSkySavingsRateApyPercent,
  );
  return { apyPercent, source: "blockanalitica-overall" };
}

async function fetchSkySavingsRate(
  fetchImpl: FetchImpl,
): Promise<SkySavingsRateObservation> {
  try {
    return await fetchOnchainSkySavingsRate(fetchImpl);
  } catch (primaryErr) {
    try {
      return await fetchBlockAnaliticaSkySavingsRateFallback(fetchImpl);
    } catch (fallbackErr) {
      throw new Error(
        joinErrors(
          errorMessage("on-chain sUSDS.ssr()", primaryErr),
          errorMessage("Block Analitica fallback", fallbackErr),
        ) ?? "Sky Savings Rate unavailable",
        { cause: fallbackErr },
      );
    }
  }
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
  let fedfundsError: string | null = null;

  if (fedfundsResult.status === "fulfilled") {
    grossApyPercent = fedfundsResult.value.grossApyPercent;
    fedfundsAsOf = fedfundsResult.value.date;
  } else {
    fedfundsError = errorMessage("FRED FEDFUNDS", fedfundsResult.reason);
  }

  let skySavingsRateApyPercent: number | null = null;
  let skySavingsRateSource: SkySavingsRateSource | null = null;
  let skyRateError: string | null = null;

  if (skyRateResult.status === "fulfilled") {
    skySavingsRateApyPercent = skyRateResult.value.apyPercent;
    skySavingsRateSource = skyRateResult.value.source;
  } else {
    skyRateError = errorMessage("Sky Savings Rate", skyRateResult.reason);
  }

  const susdsYield = applySusdsYieldLedgerResult(
    holdings,
    susdsLedgerResult,
    reserveResult.status === "fulfilled",
  );
  holdings = susdsYield.holdings;

  const netMentoApyPercent =
    grossApyPercent === null
      ? null
      : computeNetMentoApyPercent(grossApyPercent);
  const forecast = buildForecastTotals(holdings, {
    ausdNetMentoApyPercent: netMentoApyPercent,
    susdsApyPercent: skySavingsRateApyPercent,
  });

  return {
    principalUsd,
    forecastPrincipalUsd: forecast.forecastPrincipalUsd,
    earnedYieldUsd: susdsYield.earnedYieldUsd,
    realizedYieldUsd: susdsYield.realizedYieldUsd,
    unrealizedYieldUsd: susdsYield.unrealizedYieldUsd,
    earnedYieldAsOf: susdsYield.earnedYieldAsOf,
    holdings: forecast.modeledHoldings,
    holdingsAsOf,
    grossApyPercent,
    fedfundsAsOf,
    expenseBps: RESERVE_YIELD_EXPENSE_BPS,
    revenueShareBps: RESERVE_YIELD_REVENUE_SHARE_BPS,
    netMentoApyPercent,
    skySavingsRateApyPercent,
    skySavingsRateSource,
    dailyRunRateUsd: forecast.dailyRunRateUsd,
    next30dUsd: forecast.next30dUsd,
    next365dUsd: forecast.next365dUsd,
    annualRunRateUsd: forecast.annualRunRateUsd,
    forecastUnavailableSymbols: forecast.forecastUnavailableSymbols,
    holdingsError,
    rateError: rateErrorForUnavailableForecasts(
      forecast.forecastUnavailableSymbols,
      fedfundsError,
      skyRateError,
    ),
    earnedYieldError: susdsYield.earnedYieldError,
  };
}
