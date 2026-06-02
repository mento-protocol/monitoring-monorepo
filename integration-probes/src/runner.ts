import {
  AGGREGATOR_ADAPTERS,
  PROBE_TAKER_ADDRESS,
  aggregatePairStatus,
  blockingReason,
  poolIdFromPairId,
  probeAdapterPair,
  type AggregatorAdapter,
} from "./adapters.js";
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
}): Promise<AggregatorProbeResult[]> {
  const results: AggregatorProbeResult[] = [];
  for (const adapter of args.adapters) {
    const chains = await probeAdapterChains({ ...args, adapter });
    results.push({
      id: adapter.id,
      label: adapter.label,
      kind: adapter.kind,
      tier: adapter.tier,
      credentialEnv: [...(adapter.credentialEnv ?? [])],
      researchNote: adapter.researchNote,
      chains,
    });
  }
  return results;
}

async function probeAdapterChains(args: {
  adapter: AggregatorAdapter;
  chains: readonly ChainProbeConfig[];
  amountUsd: string;
  env: NodeJS.ProcessEnv;
  fetcher: FetchLike;
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
}): Promise<PairProbeResult[]> {
  const inputs = buildQuoteInputs({
    chain: args.chain,
    amountUsd: args.amountUsd,
    takerAddress: PROBE_TAKER_ADDRESS,
  });
  const results: PairProbeResult[] = [];
  for (const input of inputs) {
    try {
      const result = await probeAdapterPair({ ...args, input });
      results.push(result);
    } catch (error) {
      results.push(errorResult(input, error));
    }
  }
  return results;
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
    requestUrl: null,
    httpStatus: null,
    latencyMs: null,
    responsePreview: null,
    error: error instanceof Error ? error.message : String(error),
  };
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
    failingChainChecks: chains.filter((chain) => chain.status === "fail")
      .length,
    needsKeyChainChecks: chains.filter((chain) => chain.status === "needs_key")
      .length,
    unsupportedChainChecks: chains.filter(
      (chain) => chain.status === "unsupported",
    ).length,
  };
}
