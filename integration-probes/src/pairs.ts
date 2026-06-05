import {
  chainLabel,
  chainSlug,
} from "@mento-protocol/monitoring-config/chains";
import {
  contractEntries,
  tokenSymbol,
} from "@mento-protocol/monitoring-config/tokens";
import { addressFromPoolId, decimalAmountToRaw } from "./amounts.js";
import {
  PROBE_CHAIN_IDS,
  type ChainProbeConfig,
  type FetchLike,
  type HubPair,
  type ProbeChainId,
  type QuoteProbeInput,
  type TokenProbe,
} from "./types.js";

const USDM = "USDm";
const POOLS_QUERY = `
  query IntegrationProbePools($chainIds: [Int!]!) {
    Pool(
      where: { chainId: { _in: $chainIds } }
      limit: 1000
    ) {
      id
      chainId
      token0
      token1
      token0Decimals
      token1Decimals
      source
      wrappedExchangeId
      reserves0
      reserves1
    }
  }
`;

export type PoolRow = {
  id: string;
  chainId: number;
  token0: string | null;
  token1: string | null;
  token0Decimals: number;
  token1Decimals: number;
  source: string;
  wrappedExchangeId?: string | null;
  reserves0: string;
  reserves1: string;
};

type PoolResponse = { Pool?: PoolRow[] };

type PairSource = {
  kind: "hasura" | "contracts-fallback";
  hasuraUrlConfigured: boolean;
  note: string;
};

export type ChainConfigResult = {
  source: PairSource;
  chains: ChainProbeConfig[];
};

export async function buildChainProbeConfigs(args: {
  hasuraUrl?: string | undefined;
  fetcher: FetchLike;
  chainIds?: readonly ProbeChainId[] | undefined;
}): Promise<ChainConfigResult> {
  const chainIds = args.chainIds ?? PROBE_CHAIN_IDS;
  if (args.hasuraUrl) {
    const rows = await fetchPoolRows(args.hasuraUrl, chainIds, args.fetcher);
    return {
      source: {
        kind: "hasura",
        hasuraUrlConfigured: true,
        note: "Active USDm hub pairs were derived from indexed v3 pool rows with non-zero reserves.",
      },
      chains: chainIds.map((chainId) => chainConfigFromRows(chainId, rows)),
    };
  }
  return {
    source: {
      kind: "contracts-fallback",
      hasuraUrlConfigured: false,
      note: "No Hasura URL was configured; pairs were derived from contract metadata for dry-run visibility only.",
    },
    chains: chainIds.map(chainConfigFromContracts),
  };
}

export function buildQuoteInputs(args: {
  chain: ChainProbeConfig;
  amountUsd: string;
  takerAddress: string;
}): QuoteProbeInput[] {
  return args.chain.pairs.flatMap((pair) => [
    quoteInput(pair, "base-to-usdm", args.amountUsd, args.takerAddress),
    quoteInput(pair, "usdm-to-base", args.amountUsd, args.takerAddress),
  ]);
}

export function hubPairsFromPoolRows(
  chainId: number,
  rows: readonly PoolRow[],
): HubPair[] {
  const pairs = rows.flatMap((row) => pairFromPoolRow(chainId, row) ?? []);
  return pairs.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchPoolRows(
  hasuraUrl: string,
  chainIds: readonly number[],
  fetcher: FetchLike,
): Promise<PoolRow[]> {
  const res = await fetcher(hasuraUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: POOLS_QUERY,
      variables: { chainIds },
    }),
  });
  if (!res.ok) {
    throw new Error(`Hasura pool query failed: ${res.status}`);
  }
  const json = (await res.json()) as { data?: PoolResponse; errors?: unknown };
  if (json.errors) {
    throw new Error(
      `Hasura pool query returned errors: ${JSON.stringify(json.errors)}`,
    );
  }
  return json.data?.Pool ?? [];
}

function chainConfigFromRows(
  chainId: ProbeChainId,
  rows: readonly PoolRow[],
): ChainProbeConfig {
  const pairs = hubPairsFromPoolRows(chainId, rows);
  return baseChainConfig(chainId, pairs);
}

function chainConfigFromContracts(chainId: ProbeChainId): ChainProbeConfig {
  const usd = tokenBySymbol(chainId, USDM);
  const tokens = contractEntries(chainId)
    .filter((entry) => entry.type === "token" && entry.decimals !== undefined)
    .filter((entry) => tokenSymbol(chainId, entry.address) !== USDM);
  const pairs = usd
    ? tokens.map((entry) =>
        makePair({
          chainId,
          poolId: `${chainId}-contracts-fallback-${entry.canonicalName}`,
          poolAddress: "",
          poolSource: "contracts-fallback",
          base: {
            symbol: entry.canonicalName,
            address: entry.address,
            decimals: entry.decimals!,
          },
          quote: usd,
        }),
      )
    : [];
  return baseChainConfig(chainId, pairs);
}

function baseChainConfig(
  chainId: ProbeChainId,
  pairs: HubPair[],
): ChainProbeConfig {
  return {
    chainId,
    chainSlug: chainSlug(chainId),
    chainLabel: chainLabel(chainId),
    routerAddresses: routerAddresses(chainId),
    poolAddresses: pairs
      .map((pair) => pair.poolAddress)
      .filter((address) => address.length > 0),
    pairs,
  };
}

function pairFromPoolRow(chainId: number, row: PoolRow): HubPair | null {
  if (row.chainId !== chainId || !hasLiquidity(row)) return null;
  const token0 = tokenFromPool(chainId, row.token0, row.token0Decimals);
  const token1 = tokenFromPool(chainId, row.token1, row.token1Decimals);
  if (!token0 || !token1) return null;
  if (token0.symbol === USDM && token1.symbol !== USDM) {
    return makePair({
      chainId,
      poolId: row.id,
      poolAddress: addressFromPoolId(row.id),
      poolSource: row.source,
      base: token1,
      quote: token0,
      baseReserveRaw: row.reserves1,
      quoteReserveRaw: row.reserves0,
    });
  }
  if (token1.symbol === USDM && token0.symbol !== USDM) {
    return makePair({
      chainId,
      poolId: row.id,
      poolAddress: addressFromPoolId(row.id),
      poolSource: row.source,
      base: token0,
      quote: token1,
      baseReserveRaw: row.reserves0,
      quoteReserveRaw: row.reserves1,
    });
  }
  return null;
}

function makePair(args: {
  chainId: number;
  poolId: string;
  poolAddress: string;
  poolSource: string;
  base: TokenProbe;
  quote: TokenProbe;
  baseReserveRaw?: string | undefined;
  quoteReserveRaw?: string | undefined;
}): HubPair {
  return {
    id: `${args.chainId}:${args.base.symbol}-${USDM}:${args.poolId}`,
    chainId: args.chainId,
    poolId: args.poolId,
    poolAddress: args.poolAddress,
    poolSource: args.poolSource,
    base: args.base,
    quote: args.quote,
    baseReserveRaw: args.baseReserveRaw,
    quoteReserveRaw: args.quoteReserveRaw,
  };
}

function tokenFromPool(
  chainId: number,
  address: string | null,
  decimals: number,
): TokenProbe | null {
  if (!address) return null;
  const symbol = tokenSymbol(chainId, address);
  if (!symbol) return null;
  return { symbol, address: address.toLowerCase(), decimals };
}

function tokenBySymbol(chainId: number, symbol: string): TokenProbe | null {
  const entry = contractEntries(chainId).find(
    (candidate) =>
      candidate.type === "token" &&
      candidate.decimals !== undefined &&
      candidate.canonicalName === symbol,
  );
  if (!entry || entry.decimals === undefined) return null;
  return { symbol, address: entry.address, decimals: entry.decimals };
}

function hasLiquidity(row: PoolRow): boolean {
  return BigInt(row.reserves0) > 0n && BigInt(row.reserves1) > 0n;
}

function routerAddresses(chainId: number): string[] {
  return contractEntries(chainId)
    .filter((entry) => /^Router(v\d+)?$/.test(entry.rawName))
    .map((entry) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

function quoteInput(
  pair: HubPair,
  direction: "base-to-usdm" | "usdm-to-base",
  amountUsd: string,
  takerAddress: string,
): QuoteProbeInput {
  const sellToken = direction === "base-to-usdm" ? pair.base : pair.quote;
  const buyToken = direction === "base-to-usdm" ? pair.quote : pair.base;
  const sellReserveRaw =
    direction === "base-to-usdm" ? pair.baseReserveRaw : pair.quoteReserveRaw;
  const buyReserveRaw =
    direction === "base-to-usdm" ? pair.quoteReserveRaw : pair.baseReserveRaw;
  return {
    chainId: pair.chainId,
    pairId: pair.id,
    direction,
    sellToken,
    buyToken,
    amountDecimal: amountUsd,
    amountRaw: decimalAmountToRaw(amountUsd, sellToken.decimals),
    sellReserveRaw,
    buyReserveRaw,
    takerAddress,
  };
}
