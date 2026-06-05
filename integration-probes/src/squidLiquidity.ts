import type {
  ChainProbeConfig,
  FetchLike,
  QuoteProbeInput,
  TokenProbe,
} from "./types.js";

const CELO_CHAIN_ID = 42220;
const DEFAULT_CELO_RPC_URL = "https://forno.celo.org";
const CELO_UNISWAP_V3_FACTORY =
  "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc".toLowerCase();
const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const;
const INTERMEDIATE_SYMBOLS = ["USDT", "USDC"] as const;
const MAX_DISCOVERY_AMOUNTS = 8;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SELECTOR_GET_POOL = "0x1698ee82";
const SELECTOR_LIQUIDITY = "0x1a686502";
const SELECTOR_BALANCE_OF = "0x70a08231";

type AmountSeed = {
  amountRaw: bigint;
  variant: string;
};

export type SquidLiquidityAmountCandidate = {
  amountDecimal: string;
  amountRaw: string;
  variant: string;
};

export async function squidLiquidityAmountCandidates(args: {
  input: QuoteProbeInput;
  chain: ChainProbeConfig;
  fetcher: FetchLike;
  env: NodeJS.ProcessEnv;
}): Promise<SquidLiquidityAmountCandidate[]> {
  const externalSellDepthRaw = await uniswapSellDepthRaw(args).catch(
    () => null,
  );
  const seeds = amountSeeds({
    input: args.input,
    uniswapSellDepthRaw: externalSellDepthRaw,
  });
  return limitDiscoveryAmounts(dedupeAndSortSeeds(seeds)).map((seed) => ({
    amountRaw: seed.amountRaw.toString(),
    amountDecimal: rawAmountToDecimal(
      seed.amountRaw,
      args.input.sellToken.decimals,
    ),
    variant: seed.variant,
  }));
}

function amountSeeds(args: {
  input: QuoteProbeInput;
  uniswapSellDepthRaw: string | null;
}): AmountSeed[] {
  const baseAmountRaw = BigInt(args.input.amountRaw);
  const sellReserveRaw = optionalBigInt(args.input.sellReserveRaw);
  const capRaw =
    sellReserveRaw === null ? null : ratioAmount(sellReserveRaw, 95n, 100n);
  return [
    ...fixedMultiplierSeeds(baseAmountRaw),
    ...uniswapDepthSeeds(args.uniswapSellDepthRaw),
    ...mentoReserveSeeds(sellReserveRaw),
  ].filter(
    (seed) => seed.amountRaw > baseAmountRaw && amountWithinCap(seed, capRaw),
  );
}

function fixedMultiplierSeeds(baseAmountRaw: bigint): AmountSeed[] {
  return [
    { amountRaw: baseAmountRaw * 10n, variant: "squid-fixed-10x" },
    { amountRaw: baseAmountRaw * 100n, variant: "squid-fixed-100x" },
  ];
}

function uniswapDepthSeeds(depthRaw: string | null): AmountSeed[] {
  const depth = optionalBigInt(depthRaw);
  if (depth === null) return [];
  return [
    {
      amountRaw: ratioAmount(depth, 1n, 200n),
      variant: "squid-uniswap-depth-0.5pct",
    },
    {
      amountRaw: ratioAmount(depth, 1n, 50n),
      variant: "squid-uniswap-depth-2pct",
    },
    {
      amountRaw: ratioAmount(depth, 1n, 20n),
      variant: "squid-uniswap-depth-5pct",
    },
    {
      amountRaw: ratioAmount(depth, 1n, 10n),
      variant: "squid-uniswap-depth-10pct",
    },
    {
      amountRaw: ratioAmount(depth, 1n, 4n),
      variant: "squid-uniswap-depth-25pct",
    },
    {
      amountRaw: ratioAmount(depth, 1n, 2n),
      variant: "squid-uniswap-depth-50pct",
    },
  ];
}

function mentoReserveSeeds(sellReserveRaw: bigint | null): AmountSeed[] {
  if (sellReserveRaw === null) return [];
  return [
    {
      amountRaw: ratioAmount(sellReserveRaw, 1n, 20n),
      variant: "squid-mento-reserve-5pct",
    },
    {
      amountRaw: ratioAmount(sellReserveRaw, 1n, 5n),
      variant: "squid-mento-reserve-20pct",
    },
    {
      amountRaw: ratioAmount(sellReserveRaw, 1n, 2n),
      variant: "squid-mento-reserve-50pct",
    },
    {
      amountRaw: ratioAmount(sellReserveRaw, 9n, 10n),
      variant: "squid-mento-reserve-90pct",
    },
  ];
}

function amountWithinCap(seed: AmountSeed, capRaw: bigint | null): boolean {
  return seed.amountRaw > 0n && (capRaw === null || seed.amountRaw <= capRaw);
}

function ratioAmount(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (value * numerator) / denominator;
}

function optionalBigInt(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function dedupeAndSortSeeds(seeds: readonly AmountSeed[]): AmountSeed[] {
  const byAmount = new Map<string, AmountSeed>();
  for (const seed of seeds) {
    const key = seed.amountRaw.toString();
    if (!byAmount.has(key)) byAmount.set(key, seed);
  }
  return [...byAmount.values()].sort((a, b) =>
    a.amountRaw < b.amountRaw ? -1 : a.amountRaw > b.amountRaw ? 1 : 0,
  );
}

function limitDiscoveryAmounts(seeds: readonly AmountSeed[]): AmountSeed[] {
  if (seeds.length <= MAX_DISCOVERY_AMOUNTS) return [...seeds];
  return dedupeAndSortSeeds([
    ...seeds.slice(0, 5),
    ...seeds.slice(-(MAX_DISCOVERY_AMOUNTS - 5)),
  ]);
}

function rawAmountToDecimal(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals) || "0";
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function uniswapSellDepthRaw(args: {
  input: QuoteProbeInput;
  chain: ChainProbeConfig;
  fetcher: FetchLike;
  env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (args.input.chainId !== CELO_CHAIN_ID) return null;
  const rpcUrl = args.env.SQUID_CELO_RPC_URL ?? DEFAULT_CELO_RPC_URL;
  const paths = liquidityProbePaths(args.input, args.chain);
  let bestDepth = 0n;
  for (const path of paths) {
    const depth = await pathSellDepthRaw({
      fetcher: args.fetcher,
      rpcUrl,
      path,
      sellToken: args.input.sellToken,
    });
    if (depth > bestDepth) bestDepth = depth;
  }
  return bestDepth > 0n ? bestDepth.toString() : null;
}

function liquidityProbePaths(
  input: QuoteProbeInput,
  chain: ChainProbeConfig,
): TokenProbe[][] {
  const tokens = tokensBySymbol(chain);
  const direct = [[input.sellToken, input.buyToken]];
  const via = INTERMEDIATE_SYMBOLS.flatMap((symbol) => {
    const intermediate = tokens.get(symbol);
    if (!intermediate || tokenMatches(intermediate, input.sellToken)) return [];
    if (tokenMatches(intermediate, input.buyToken)) return [];
    return [[input.sellToken, intermediate, input.buyToken]];
  });
  return [...direct, ...via];
}

function tokensBySymbol(chain: ChainProbeConfig): Map<string, TokenProbe> {
  const out = new Map<string, TokenProbe>();
  for (const pair of chain.pairs) {
    out.set(pair.base.symbol, pair.base);
    out.set(pair.quote.symbol, pair.quote);
  }
  return out;
}

async function pathSellDepthRaw(args: {
  fetcher: FetchLike;
  rpcUrl: string;
  path: readonly TokenProbe[];
  sellToken: TokenProbe;
}): Promise<bigint> {
  if (args.path.length === 2) {
    return bestPoolSellDepthRaw({
      ...args,
      tokenA: args.path[0]!,
      tokenB: args.path[1]!,
      sellToken: args.sellToken,
    });
  }
  const intermediate = args.path[1]!;
  const [firstHopDepth, secondHopDepth] = await Promise.all([
    bestPoolSellDepthRaw({
      ...args,
      tokenA: args.path[0]!,
      tokenB: intermediate,
      sellToken: args.sellToken,
    }),
    bestPoolSellDepthRaw({
      ...args,
      tokenA: intermediate,
      tokenB: args.path[2]!,
      sellToken: intermediate,
    }),
  ]);
  return secondHopDepth > 0n ? firstHopDepth : 0n;
}

async function bestPoolSellDepthRaw(args: {
  fetcher: FetchLike;
  rpcUrl: string;
  tokenA: TokenProbe;
  tokenB: TokenProbe;
  sellToken: TokenProbe;
}): Promise<bigint> {
  let best = 0n;
  for (const fee of UNISWAP_FEE_TIERS) {
    const pool = await uniswapPoolAddress(args, fee);
    if (pool === null) continue;
    const [liquidity, sellBalance] = await Promise.all([
      readUint256(args.fetcher, args.rpcUrl, pool, SELECTOR_LIQUIDITY),
      readUint256(
        args.fetcher,
        args.rpcUrl,
        args.sellToken.address,
        balanceOfCall(pool),
      ),
    ]);
    if (liquidity > 0n && sellBalance > best) best = sellBalance;
  }
  return best;
}

async function uniswapPoolAddress(
  args: {
    fetcher: FetchLike;
    rpcUrl: string;
    tokenA: TokenProbe;
    tokenB: TokenProbe;
  },
  fee: number,
): Promise<string | null> {
  const result = await ethCall(
    args.fetcher,
    args.rpcUrl,
    CELO_UNISWAP_V3_FACTORY,
    `${SELECTOR_GET_POOL.slice(2)}${encodeAddress(args.tokenA.address)}${encodeAddress(args.tokenB.address)}${encodeUint(fee)}`,
  );
  const address = decodeAddress(result);
  return address === ZERO_ADDRESS ? null : address;
}

async function readUint256(
  fetcher: FetchLike,
  rpcUrl: string,
  to: string,
  data: string,
): Promise<bigint> {
  const result = await ethCall(fetcher, rpcUrl, to, data);
  return BigInt(result);
}

async function ethCall(
  fetcher: FetchLike,
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string> {
  const response = await fetcher(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to, data: data.startsWith("0x") ? data : `0x${data}` },
        "latest",
      ],
    }),
  });
  if (!response.ok) throw new Error(`Celo RPC failed: ${response.status}`);
  const payload = (await response.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(payload.error.message ?? "Celo RPC returned an error");
  }
  if (!payload.result) throw new Error("Celo RPC returned no result");
  return payload.result;
}

function balanceOfCall(address: string): string {
  return `${SELECTOR_BALANCE_OF}${encodeAddress(address)}`;
}

function encodeAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/u, "").padStart(64, "0");
}

function encodeUint(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function decodeAddress(value: string): string {
  const hex = value.toLowerCase().replace(/^0x/u, "").padStart(64, "0");
  return `0x${hex.slice(-40)}`;
}

function tokenMatches(a: TokenProbe, b: TokenProbe): boolean {
  return a.address.toLowerCase() === b.address.toLowerCase();
}
