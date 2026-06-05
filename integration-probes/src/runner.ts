import {
  AGGREGATOR_ADAPTERS,
  PROBE_TAKER_ADDRESS,
  aggregatePairStatus,
  blockingReason,
  poolIdFromPairId,
  probeAdapterPair,
  type AggregatorAdapter,
} from "./adapters.js";
import type { QuoteAttemptBudget } from "./adapterTypes.js";
import { buildChainProbeConfigs, buildQuoteInputs } from "./pairs.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type AggregatorProbeResult,
  type ChainProbeConfig,
  type ChainProbeResult,
  type FetchLike,
  type IntegrationProbeSnapshot,
  type PairProbeResult,
  type ProbeChainId,
} from "./types.js";

const DEFAULT_ADAPTER_CONCURRENCY = 3;
const DEFAULT_PAIR_CONCURRENCY = 4;

type BeforeQuoteRequest = () => Promise<void>;

export type RunProbeOptions = {
  amountUsd?: string | undefined;
  hasuraUrl?: string | undefined;
  fetcher?: FetchLike | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  chainIds?: readonly ProbeChainId[] | undefined;
  adapters?: readonly AggregatorAdapter[] | undefined;
  adapterIds?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  pairLimit?: number | undefined;
  adapterConcurrency?: number | undefined;
  pairConcurrency?: number | undefined;
};

export async function runIntegrationProbes(
  options: RunProbeOptions = {},
): Promise<IntegrationProbeSnapshot> {
  const fetcher = withTimeout(options.fetcher ?? fetch, options.timeoutMs);
  const amountUsd = options.amountUsd ?? "1";
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const chainConfigs = await buildChainProbeConfigs({
    hasuraUrl: firstNonEmpty(
      options.hasuraUrl,
      env.INTEGRATION_PROBES_HASURA_URL,
      env.NEXT_PUBLIC_HASURA_URL,
    ),
    fetcher,
    chainIds: options.chainIds,
  });
  const adapters = filterAdapters(
    options.adapters ?? AGGREGATOR_ADAPTERS,
    options.adapterIds,
  );
  const chains = limitPairs(chainConfigs.chains, options.pairLimit);
  const aggregators = await probeAdapters({
    adapters,
    chains,
    amountUsd,
    env,
    fetcher,
    adapterConcurrency: normalizeConcurrency(
      options.adapterConcurrency,
      DEFAULT_ADAPTER_CONCURRENCY,
    ),
    pairConcurrency: normalizeConcurrency(
      options.pairConcurrency,
      DEFAULT_PAIR_CONCURRENCY,
    ),
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    amountUsd,
    takerAddress: PROBE_TAKER_ADDRESS,
    pairSource: chainConfigs.source,
    chains,
    aggregators,
    summary: summarizeSnapshot(aggregators),
  };
}

function filterAdapters(
  adapters: readonly AggregatorAdapter[],
  adapterIds: readonly string[] | undefined,
): readonly AggregatorAdapter[] {
  if (!adapterIds || adapterIds.length === 0) return adapters;
  const selected = new Set(adapterIds);
  const out = adapters.filter((adapter) => selected.has(adapter.id));
  const missing = adapterIds.filter(
    (id) => !out.some((adapter) => adapter.id === id),
  );
  if (missing.length > 0) {
    throw new Error(`Unknown adapter id(s): ${missing.join(", ")}`);
  }
  return out;
}

function limitPairs(
  chains: readonly ChainProbeConfig[],
  pairLimit: number | undefined,
): ChainProbeConfig[] {
  if (pairLimit === undefined) return [...chains];
  return chains.map((chain) => ({
    ...chain,
    pairs: chain.pairs.slice(0, Math.max(0, pairLimit)),
    poolAddresses: chain.pairs
      .slice(0, Math.max(0, pairLimit))
      .map((pair) => pair.poolAddress)
      .filter((address) => address.length > 0),
  }));
}

function withTimeout(
  fetcher: FetchLike,
  timeoutMs: number | undefined,
): FetchLike {
  if (timeoutMs === undefined || timeoutMs <= 0) return fetcher;
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Probe request timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

async function probeAdapters(args: {
  adapters: readonly AggregatorAdapter[];
  chains: readonly ChainProbeConfig[];
  amountUsd: string;
  env: NodeJS.ProcessEnv;
  fetcher: FetchLike;
  adapterConcurrency: number;
  pairConcurrency: number;
}): Promise<AggregatorProbeResult[]> {
  return mapConcurrent(
    args.adapters,
    args.adapterConcurrency,
    async (adapter) => {
      const quoteBudget = quoteAttemptBudget(adapter);
      const beforeQuoteRequest = quoteRequestPacer(adapter);
      const chains = await probeAdapterChains({
        ...args,
        adapter,
        quoteBudget,
        beforeQuoteRequest,
      });
      return {
        id: adapter.id,
        label: adapter.label,
        kind: adapter.kind,
        tier: adapter.tier,
        credentialEnv: [...(adapter.credentialEnv ?? [])],
        researchNote: adapter.researchNote,
        chains,
      };
    },
  );
}

async function probeAdapterChains(args: {
  adapter: AggregatorAdapter;
  chains: readonly ChainProbeConfig[];
  amountUsd: string;
  env: NodeJS.ProcessEnv;
  fetcher: FetchLike;
  pairConcurrency: number;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<ChainProbeResult[]> {
  const out: ChainProbeResult[] = [];
  for (const chain of args.chains) {
    const pairResults = await probeChainPairs({ ...args, chain });
    out.push(chainResult(chain, pairResults));
  }
  return out;
}

async function probeChainPairs(args: {
  adapter: AggregatorAdapter;
  chain: ChainProbeConfig;
  amountUsd: string;
  env: NodeJS.ProcessEnv;
  fetcher: FetchLike;
  pairConcurrency: number;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<PairProbeResult[]> {
  const inputs = buildQuoteInputs({
    chain: args.chain,
    amountUsd: args.amountUsd,
    takerAddress: PROBE_TAKER_ADDRESS,
  });
  const pairConcurrency =
    args.quoteBudget || args.beforeQuoteRequest ? 1 : args.pairConcurrency;
  return mapConcurrent(inputs, pairConcurrency, async (input) => {
    try {
      return await probeAdapterPair({ ...args, input });
    } catch (error) {
      return errorResult(input, error);
    }
  });
}

function quoteAttemptBudget(
  adapter: AggregatorAdapter,
): QuoteAttemptBudget | undefined {
  if (adapter.maxQuoteRequestsPerRun === undefined) return undefined;
  return { remaining: adapter.maxQuoteRequestsPerRun };
}

function quoteRequestPacer(
  adapter: AggregatorAdapter,
): BeforeQuoteRequest | undefined {
  const delayMs = normalizeDelayMs(adapter.quoteRequestDelayMs);
  if (delayMs === 0) return undefined;

  let requests = 0;
  let gate = Promise.resolve();
  return async () => {
    const wait = gate.then(async () => {
      if (requests > 0) await sleep(delayMs);
      requests += 1;
    });
    gate = wait.catch(() => {});
    await wait;
  };
}

function normalizeDelayMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Probe request delay must be a non-negative integer");
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chainResult(
  chain: ChainProbeConfig,
  pairs: PairProbeResult[],
): ChainProbeResult {
  const status = aggregatePairStatus(pairs);
  const passed = pairs.filter((pair) => pair.status === "pass").length;
  return {
    chainId: chain.chainId,
    chainSlug: chain.chainSlug,
    chainLabel: chain.chainLabel,
    status,
    pairCoverage: { passed, total: pairs.length },
    blockingReason: blockingReason(status),
    nextStep: nextStepFor(status, pairs),
    pairs,
  };
}

function errorResult(
  input: Parameters<typeof probeAdapterPair>[0]["input"],
  error: unknown,
): PairProbeResult {
  return {
    pairId: input.pairId,
    poolId: poolIdFromPairId(input.pairId),
    direction: input.direction,
    sellSymbol: input.sellToken.symbol,
    buySymbol: input.buyToken.symbol,
    status: "error",
    evidence: [],
    sourceLabels: [],
    txTarget: null,
    downstreamProvider: null,
    routeVariant: null,
    routeAmountUsd: null,
    attemptCount: null,
    requestUrl: null,
    httpStatus: null,
    latencyMs: null,
    responsePreview: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function normalizeConcurrency(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Probe concurrency must be a positive integer");
  }
  return value;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(
          items[currentIndex]!,
          currentIndex,
        );
      }
    }),
  );
  return results;
}

function nextStepFor(
  status: ChainProbeResult["status"],
  pairs: readonly PairProbeResult[],
): string | null {
  if (status === "pass") return null;
  const firstError = pairs.find((pair) => pair.error)?.error;
  if (status === "needs_key")
    return firstError ?? "Configure adapter credentials.";
  if (status === "unsupported")
    return firstError ?? "Confirm chain support with the aggregator.";
  if (status === "partial")
    return "Inspect failing route evidence for pairs that still lack Mento v3 address evidence.";
  if (status === "fail")
    return "Inspect route evidence and ask aggregator to route through Mento v3.";
  return firstError ?? "Inspect raw probe response.";
}

function summarizeSnapshot(
  aggregators: readonly AggregatorProbeResult[],
): IntegrationProbeSnapshot["summary"] {
  const chains = aggregators.flatMap((aggregator) => aggregator.chains);
  return {
    aggregators: aggregators.length,
    chainChecks: chains.length,
    passingChainChecks: chains.filter((chain) => chain.status === "pass")
      .length,
    partialChainChecks: chains.filter((chain) => chain.status === "partial")
      .length,
    failingChainChecks: chains.filter((chain) => chain.status === "fail")
      .length,
    needsKeyChainChecks: chains.filter((chain) => chain.status === "needs_key")
      .length,
    unsupportedChainChecks: chains.filter(
      (chain) => chain.status === "unsupported",
    ).length,
  };
}
