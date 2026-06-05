import { detectEvidence } from "./evidence.js";
import {
  flyDistributionsUrl,
  flyQuoteId,
  flyQuoteUrl,
  getRequest,
  kyberUrl,
  LIFI_MAX_QUOTE_REQUESTS_PER_RUN,
  lifiFlyNetwork,
  lifiPayloadUsesFly,
  lifiQuoteRequests,
  oneInchUrl,
  openOceanUrl,
  postRequest,
  relayBody,
  rubicBody,
  socketUrl,
  SQUID_MAX_QUOTE_REQUESTS_PER_RUN,
  squidBody,
  squidQuoteRequests,
  SQUID_QUOTE_REQUEST_DELAY_MS,
  zeroXUrl,
} from "./adapterRequests.js";
import type {
  QuoteAttemptBudget,
  QuoteRequest,
  QuoteResponseEvidenceArgs,
  QuoteResponseEvidenceHook,
  TimedPayload,
} from "./adapterTypes.js";
import type {
  AggregatorKind,
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  ProbeStatus,
  QuoteProbeInput,
} from "./types.js";

const DEFAULT_TAKER = "0x000000000000000000000000000000000000dEaD";
const REQUEST_ERROR_ATTEMPT_LIMIT = 2;

type ChainSupport = "supported" | "unsupported" | "unknown";
type BeforeQuoteRequest = () => Promise<void>;
type QuoteBuildContext = {
  chain: ChainProbeConfig;
  fetcher: FetchLike;
};
type QuoteBuildResult =
  | QuoteRequest
  | readonly QuoteRequest[]
  | Promise<QuoteRequest | readonly QuoteRequest[]>;

export type AggregatorAdapter = {
  id: string;
  label: string;
  kind: AggregatorKind;
  tier: 1 | 2 | 3;
  credentialEnv?: readonly string[];
  researchNote: string;
  support: Partial<Record<number, ChainSupport>>;
  quote?: (
    input: QuoteProbeInput,
    env: NodeJS.ProcessEnv,
    context?: QuoteBuildContext,
  ) => QuoteBuildResult;
  maxQuoteRequestsPerRun?: number;
  quoteRequestDelayMs?: number;
  nextStep?: string;
};

export const PROBE_TAKER_ADDRESS = DEFAULT_TAKER;

export const AGGREGATOR_ADAPTERS: AggregatorAdapter[] = [
  lifiAdapter(),
  openOceanAdapter(),
  zeroXAdapter(),
  squidAdapter(),
  socketAdapter(),
  rubicAdapter(),
  relayAdapter(),
  oneInchAdapter(),
  kyberAdapter(),
  okxAdapter(),
  rangoAdapter(),
  excludedAdapter(
    "cow-swap",
    "CoW Swap",
    "DEX docs do not currently list Celo or Monad support.",
  ),
  excludedAdapter(
    "paraswap",
    "ParaSwap / Velora",
    "Current supported-chain docs do not list Celo or Monad.",
  ),
  excludedAdapter(
    "odos",
    "Odos",
    "Public chain metadata currently lists neither Celo nor Monad.",
  ),
  excludedAdapter(
    "debridge",
    "deBridge",
    "Direct Celo/Monad quote coverage needs separate evidence; track via Rubic/Relay first.",
  ),
];

export async function probeAdapterPair(args: {
  adapter: AggregatorAdapter;
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  env: NodeJS.ProcessEnv;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<PairProbeResult> {
  const unsupported = unsupportedResult(args.adapter, args.input);
  if (unsupported) return unsupported;

  const missingCredential = firstMissingCredential(args.adapter, args.env);
  if (missingCredential) {
    return skippedResult(
      args.input,
      "needs_key",
      `Missing ${missingCredential}`,
    );
  }
  if (!args.adapter.quote) {
    return skippedResult(
      args.input,
      "error",
      args.adapter.nextStep ?? "Adapter quote parser is not configured yet.",
    );
  }
  return fetchAndEvaluate(args);
}

export function aggregatePairStatus(
  results: readonly Pick<PairProbeResult, "status">[],
): ProbeStatus {
  if (results.length === 0) return "error";
  if (results.every((result) => result.status === "pass")) return "pass";
  if (results.every((result) => result.status === "unsupported")) {
    return "unsupported";
  }
  if (results.every((result) => result.status === "needs_key")) {
    return "needs_key";
  }
  if (
    results.some((result) => result.status === "needs_key") &&
    results.every((result) => ["pass", "needs_key"].includes(result.status))
  ) {
    return "needs_key";
  }
  if (results.some((result) => result.status === "rate_limited")) {
    return "rate_limited";
  }
  if (results.every((result) => result.status === "no_liquidity")) {
    return "no_liquidity";
  }
  if (results.every((result) => result.status === "error")) {
    return "error";
  }
  return "fail";
}

export function blockingReason(status: ProbeStatus): string | null {
  switch (status) {
    case "pass":
      return null;
    case "unsupported":
      return "Aggregator does not currently advertise support for this chain.";
    case "needs_key":
      return "Probe credentials are missing.";
    case "rate_limited":
      return "Aggregator API rate-limited the probe or the probe hit its configured request budget.";
    case "no_liquidity":
      return "Aggregator returned no route or no liquidity.";
    case "error":
      return "Probe could not complete.";
    case "fail":
      return "At least one USDm hub route lacked Mento v3 address evidence.";
  }
}

async function fetchAndEvaluate(args: {
  adapter: AggregatorAdapter;
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  env: NodeJS.ProcessEnv;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<PairProbeResult> {
  const requests = normalizeQuoteRequests(
    await args.adapter.quote!(args.input, args.env, {
      chain: args.chain,
      fetcher: args.fetcher,
    }),
  );
  let fallback: PairProbeResult | null = null;
  let attemptCount = 0;
  let requestErrorAttempts = 0;
  for (const request of requests) {
    if (!consumeQuoteAttempt(args.quoteBudget)) {
      return quoteBudgetExhaustedResult(args.input, attemptCount);
    }
    attemptCount += 1;
    const result = {
      ...(await fetchAndEvaluateAttempt({ ...args, request })),
      attemptCount,
    };
    if (result.status === "pass") return result;
    fallback = betterFallback(fallback, result);
    if (requestErrored(result)) {
      requestErrorAttempts += 1;
    }
    if (terminalStatus(result.status)) {
      return result;
    }
    if (requestErrorLimitReached(result, requestErrorAttempts)) {
      return result;
    }
  }
  return fallback
    ? { ...fallback, attemptCount }
    : skippedResult(args.input, "error", "No quote requests built.");
}

function quoteBudgetExhaustedResult(
  input: QuoteProbeInput,
  attemptCount: number,
): PairProbeResult {
  return {
    ...skippedResult(
      input,
      "rate_limited",
      "Adapter quote-attempt budget exhausted.",
    ),
    attemptCount,
  };
}

function requestErrorLimitReached(
  result: PairProbeResult,
  requestErrorAttempts: number,
): boolean {
  return (
    requestErrored(result) &&
    requestErrorAttempts >= REQUEST_ERROR_ATTEMPT_LIMIT
  );
}

async function fetchAndEvaluateAttempt(args: {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<PairProbeResult> {
  try {
    return await fetchAndEvaluateRequest(args);
  } catch (error) {
    return requestErrorResult(args.input, args.request, error);
  }
}

async function fetchAndEvaluateRequest(args: {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  quoteBudget?: QuoteAttemptBudget | undefined;
  beforeQuoteRequest?: BeforeQuoteRequest | undefined;
}): Promise<PairProbeResult> {
  await args.beforeQuoteRequest?.();
  const response = await fetchTimedPayload({
    fetcher: args.fetcher,
    request: args.request,
  });
  const primaryResult = probeResultFromPayload({
    chain: args.chain,
    input: args.input,
    request: args.request,
    ...response,
  });
  if (!args.request.afterResponse) {
    return primaryResult;
  }
  const downstreamResult = await args.request.afterResponse({
    chain: args.chain,
    input: args.input,
    fetcher: args.fetcher,
    request: args.request,
    payload: response.payload,
    primaryResult,
    quoteBudget: args.quoteBudget,
  });
  return downstreamResult ?? primaryResult;
}

async function fetchTimedPayload(args: {
  fetcher: FetchLike;
  request: QuoteRequest;
}): Promise<TimedPayload> {
  const startedAt = Date.now();
  const response = await args.fetcher(args.request.url, args.request.init);
  const latencyMs = Date.now() - startedAt;
  const payload = await responseJson(response);
  return {
    payload,
    statusCode: response.status,
    latencyMs,
    requestUrl: args.request.url,
  };
}

function probeResultFromPayload(args: {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  request: QuoteRequest;
  payload: unknown;
  statusCode: number;
  latencyMs: number;
  requestUrl: string;
  evidenceMode?: "router-or-pool" | "pool-only" | undefined;
}): PairProbeResult {
  const routerAddresses =
    args.evidenceMode === "pool-only" ? [] : args.chain.routerAddresses;
  const detected = detectEvidence(args.payload, {
    routerAddresses,
    poolAddresses: pairPoolAddresses(args.chain, args.input.pairId),
  });
  const status = statusFromResponse(
    args.statusCode,
    detected.passes,
    args.payload,
  );
  return {
    pairId: args.input.pairId,
    poolId: poolIdFromPairId(args.input.pairId),
    direction: args.input.direction,
    sellSymbol: args.input.sellToken.symbol,
    buySymbol: args.input.buyToken.symbol,
    status,
    evidence: detected.evidence,
    sourceLabels: detected.sourceLabels,
    txTarget: detected.txTarget,
    downstreamProvider: detected.downstreamProvider,
    routeVariant: args.request.variant ?? null,
    routeAmountUsd: args.request.amountDecimal ?? args.input.amountDecimal,
    attemptCount: 1,
    requestUrl: args.requestUrl,
    httpStatus: args.statusCode,
    latencyMs: args.latencyMs,
    responsePreview: responsePreview(args.payload),
    error: responseOk(args.statusCode)
      ? payloadErrorMessage(args.payload)
      : errorMessage(args.payload, args.statusCode),
  };
}

function normalizeQuoteRequests(
  requests: QuoteRequest | readonly QuoteRequest[],
): readonly QuoteRequest[] {
  if (Array.isArray(requests)) return requests as readonly QuoteRequest[];
  return [requests as QuoteRequest];
}

function betterFallback(
  current: PairProbeResult | null,
  candidate: PairProbeResult,
): PairProbeResult {
  if (!current) return candidate;
  return fallbackPriority(candidate.status) >= fallbackPriority(current.status)
    ? candidate
    : current;
}

function fallbackPriority(status: ProbeStatus): number {
  switch (status) {
    case "fail":
      return 6;
    case "no_liquidity":
      return 5;
    case "unsupported":
      return 4;
    case "error":
      return 3;
    case "rate_limited":
      return 2;
    case "needs_key":
      return 1;
    case "pass":
      return 0;
  }
}

function terminalStatus(status: ProbeStatus): boolean {
  return status === "needs_key" || status === "rate_limited";
}

function requestErrored(result: PairProbeResult): boolean {
  return result.status === "error" && result.requestUrl !== null;
}

function consumeQuoteAttempt(budget: QuoteAttemptBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function statusFromResponse(
  statusCode: number,
  passes: boolean,
  payload: unknown,
): ProbeStatus {
  if (statusCode >= 400) return statusFromHttpError(statusCode, payload);
  if (payloadErrorMessage(payload)) return statusFromPayloadError(payload);
  if (passes) return "pass";
  return routeAbsent(payload) ? "no_liquidity" : "fail";
}

function responseOk(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function statusFromHttpError(
  statusCode: number,
  payload: unknown,
): ProbeStatus {
  if (statusCode === 401) return "needs_key";
  if (statusCode === 403) return statusFromForbidden(payload);
  if (statusCode === 429) return "rate_limited";
  return statusFromPayloadError(payload);
}

function statusFromForbidden(payload: unknown): ProbeStatus {
  return cloudflareBlocked(payload) ? "rate_limited" : "needs_key";
}

function statusFromPayloadError(payload: unknown): ProbeStatus {
  if (unsupportedResponse(payload)) return "unsupported";
  if (routeAbsent(payload)) return "no_liquidity";
  return "error";
}

function routeAbsent(payload: unknown): boolean {
  const text = JSON.stringify(payload).toLowerCase();
  return (
    text.includes("no route") ||
    text.includes("no routes") ||
    text.includes("no liquidity") ||
    text.includes("no avail liquidity") ||
    text.includes("insufficient liquidity") ||
    text.includes("amount is too small") ||
    text.includes("amount too low") ||
    text.includes("swap impact is too high") ||
    text.includes("cannot estimate")
  );
}

function unsupportedResponse(payload: unknown): boolean {
  const text = JSON.stringify(payload).toLowerCase();
  return (
    text.includes("token not found") ||
    text.includes("unsupported token") ||
    text.includes("unsupported chain")
  );
}

function cloudflareBlocked(payload: unknown): boolean {
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes("cloudflare") || text.includes("attention required");
}

function requestErrorResult(
  input: QuoteProbeInput,
  request: QuoteRequest,
  error: unknown,
): PairProbeResult {
  return {
    ...skippedResult(
      input,
      "error",
      error instanceof Error ? error.message : String(error),
    ),
    routeVariant: request.variant ?? null,
    routeAmountUsd: request.amountDecimal ?? input.amountDecimal,
    requestUrl: request.url,
  };
}

function unsupportedResult(
  adapter: AggregatorAdapter,
  input: QuoteProbeInput,
): PairProbeResult | null {
  const support = adapter.support[input.chainId] ?? "unknown";
  if (support !== "unsupported") return null;
  return skippedResult(input, "unsupported", adapter.researchNote);
}

function skippedResult(
  input: QuoteProbeInput,
  status: ProbeStatus,
  error: string,
): PairProbeResult {
  return {
    pairId: input.pairId,
    poolId: poolIdFromPairId(input.pairId),
    direction: input.direction,
    sellSymbol: input.sellToken.symbol,
    buySymbol: input.buyToken.symbol,
    status,
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
    error,
  };
}

function firstMissingCredential(
  adapter: AggregatorAdapter,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const key of adapter.credentialEnv ?? []) {
    if (!env[key]) return key;
  }
  return null;
}

function errorMessage(payload: unknown, status: number): string {
  const payloadError = payloadErrorMessage(payload);
  if (payloadError) return `HTTP ${status}: ${payloadError}`;
  if (payload && typeof payload === "object" && "message" in payload) {
    return `HTTP ${status}: ${String(payload.message)}`;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    return `HTTP ${status}: ${String(payload.error)}`;
  }
  if (cloudflareBlocked(payload)) {
    return `HTTP ${status}: Cloudflare access challenge`;
  }
  return `HTTP ${status}`;
}

function payloadErrorMessage(payload: unknown): string | null {
  const error = payloadErrorValue(payload);
  if (error === null) return null;
  if (typeof error === "string") return error;
  const objectMessage = payloadObjectErrorMessage(error);
  if (objectMessage) return objectMessage;
  return JSON.stringify(error);
}

function payloadErrorValue(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }
  return payload.error;
}

function payloadObjectErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("reason" in error) return String(error.reason);
  if ("message" in error) return String(error.message);
  return null;
}

function responsePreview(payload: unknown): string {
  const text = JSON.stringify(payload);
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

export function poolIdFromPairId(pairId: string): string {
  const marker = ":";
  const first = pairId.indexOf(marker);
  const second = pairId.indexOf(marker, first + 1);
  return second >= 0 ? pairId.slice(second + 1) : pairId;
}

function pairPoolAddresses(
  chain: ChainProbeConfig,
  pairId: string,
): readonly string[] {
  const pair = chain.pairs.find((item) => item.id === pairId);
  return pair?.poolAddress ? [pair.poolAddress] : [];
}

function lifiAdapter(): AggregatorAdapter {
  return {
    id: "lifi",
    label: "LI.FI / Jumper",
    kind: "cross_chain",
    tier: 1,
    credentialEnv: ["LIFI_API_KEY"],
    support: { 42220: "supported", 143: "supported" },
    maxQuoteRequestsPerRun: LIFI_MAX_QUOTE_REQUESTS_PER_RUN,
    researchNote:
      "LI.FI chain metadata lists both Celo and Monad; scheduled probes use an API key and route-discovery attempts to avoid confusing cheaper non-Mento default routes with missing Mento support.",
    quote: (input, env) =>
      lifiQuoteRequests(input, env, lifiAfterResponseHook(input)),
  };
}

function openOceanAdapter(): AggregatorAdapter {
  return {
    id: "openocean",
    label: "OpenOcean",
    kind: "dex",
    tier: 2,
    credentialEnv: ["OPENOCEAN_API_KEY"],
    support: { 42220: "supported", 143: "supported" },
    researchNote:
      "OpenOcean Pro endpoint is keyed; the probe enables DEX id 8 so the response proves the MentoV3 venue can route the pair.",
    quote: (input, env) =>
      getRequest(openOceanUrl(input), {
        apikey: env.OPENOCEAN_API_KEY!,
        "content-type": "application/json",
      }),
  };
}

function zeroXAdapter(): AggregatorAdapter {
  return {
    id: "0x",
    label: "0x / Matcha",
    kind: "dex",
    tier: 1,
    credentialEnv: ["ZEROX_API_KEY"],
    support: { 42220: "unsupported", 143: "supported" },
    researchNote: "Current 0x docs list Monad but not Celo for Swap API.",
    quote: (input, env) =>
      getRequest(zeroXUrl(input), {
        "0x-api-key": env.ZEROX_API_KEY!,
        "0x-version": "v2",
      }),
  };
}

function squidAdapter(): AggregatorAdapter {
  return {
    id: "squid",
    label: "Squid",
    kind: "cross_chain",
    tier: 2,
    credentialEnv: ["SQUID_INTEGRATOR_ID"],
    support: { 42220: "supported", 143: "unknown" },
    maxQuoteRequestsPerRun: SQUID_MAX_QUOTE_REQUESTS_PER_RUN,
    quoteRequestDelayMs: SQUID_QUOTE_REQUEST_DELAY_MS,
    researchNote:
      "Celo Squid routing is observed in the repo registry; Monad needs quote evidence. Probes are serialized and paced to avoid 429s from bursty route checks.",
    quote: (input, env, context) =>
      context
        ? squidQuoteRequests(input, env, context.chain, context.fetcher)
        : postRequest(
            "https://apiplus.squidrouter.com/v2/route",
            squidBody(input),
            {
              "x-integrator-id": env.SQUID_INTEGRATOR_ID!,
            },
          ),
  };
}

function socketAdapter(): AggregatorAdapter {
  return {
    id: "socket",
    label: "Socket / Bungee",
    kind: "cross_chain",
    tier: 1,
    credentialEnv: ["SOCKET_API_KEY"],
    support: { 42220: "unsupported", 143: "supported" },
    researchNote: "Public Bungee metadata lists Monad; Celo was not listed.",
    quote: (input, env) =>
      getRequest(socketUrl(input), { "API-KEY": env.SOCKET_API_KEY! }),
  };
}

function rubicAdapter(): AggregatorAdapter {
  return {
    id: "rubic",
    label: "Rubic",
    kind: "meta",
    tier: 2,
    support: { 42220: "supported", 143: "supported" },
    researchNote:
      "Rubic metadata lists Celo via Squid/LI.FI and Monad via DEX routes.",
    quote: (input) =>
      postRequest(
        "https://api-v2.rubic.exchange/api/routes/quoteBest",
        rubicBody(input),
      ),
  };
}

function relayAdapter(): AggregatorAdapter {
  return {
    id: "relay",
    label: "Relay",
    kind: "cross_chain",
    tier: 2,
    support: { 42220: "supported", 143: "supported" },
    researchNote:
      "Relay is a current candidate for both chains; quote evidence decides pass/fail.",
    quote: (input) =>
      postRequest("https://api.relay.link/quote/v2", relayBody(input)),
  };
}

function oneInchAdapter(): AggregatorAdapter {
  return {
    id: "1inch",
    label: "1inch",
    kind: "dex",
    tier: 1,
    credentialEnv: ["ONEINCH_API_KEY"],
    support: { 42220: "unsupported", 143: "unsupported" },
    researchNote:
      "Current 1inch v6.1 docs do not list Celo or Monad; keep unsupported until separate support evidence exists.",
    quote: (input, env) =>
      getRequest(oneInchUrl(input), {
        Authorization: `Bearer ${env.ONEINCH_API_KEY!}`,
      }),
  };
}

function kyberAdapter(): AggregatorAdapter {
  return {
    id: "kyberswap",
    label: "KyberSwap",
    kind: "dex",
    tier: 2,
    support: { 42220: "unsupported", 143: "supported" },
    researchNote: "KyberSwap docs list Monad but not Celo.",
    quote: (input) =>
      getRequest(kyberUrl(input), {
        "x-client-id": "mento-integration-probes",
      }),
  };
}

function okxAdapter(): AggregatorAdapter {
  return {
    id: "okx",
    label: "OKX DEX API",
    kind: "dex",
    tier: 2,
    credentialEnv: ["OKX_DEX_API_KEY", "OKX_DEX_SECRET", "OKX_DEX_PASSPHRASE"],
    support: { 42220: "unsupported", 143: "supported" },
    researchNote:
      "OKX docs list Monad but not Celo; signed API probing is required.",
    nextStep:
      "Implement OKX request signing before enabling live quote probes.",
  };
}

function rangoAdapter(): AggregatorAdapter {
  return {
    id: "rango",
    label: "Rango",
    kind: "cross_chain",
    tier: 1,
    credentialEnv: ["RANGO_API_KEY"],
    support: { 42220: "unknown", 143: "unknown" },
    researchNote:
      "Rango metadata requires an API key; chain support is probed when configured.",
    nextStep:
      "Add Rango quote endpoint mapping once API credentials are available.",
  };
}

function excludedAdapter(
  id: string,
  label: string,
  researchNote: string,
): AggregatorAdapter {
  return {
    id,
    label,
    kind: "excluded",
    tier: 3,
    support: { 42220: "unsupported", 143: "unsupported" },
    researchNote,
  };
}

function lifiAfterResponseHook(
  input: QuoteProbeInput,
): QuoteResponseEvidenceHook | undefined {
  return lifiFlyNetwork(input.chainId) ? lifiFlyEvidence : undefined;
}

async function lifiFlyEvidence(
  args: QuoteResponseEvidenceArgs,
): Promise<PairProbeResult | null> {
  if (!lifiPayloadUsesFly(args.payload)) return null;
  const network = lifiFlyNetwork(args.input.chainId);
  if (!network) return null;

  const quoteRequest = downstreamRequest(
    args.request,
    flyQuoteUrl(lifiFollowUpInput(args.input, args.request), network),
  );
  const quotePayload = await fetchDownstreamPayload({
    ...args,
    request: quoteRequest,
  });
  if ("result" in quotePayload) return quotePayload.result;
  if (!responseOk(quotePayload.statusCode)) {
    return annotateDownstreamResult(
      args.primaryResult,
      probeResultFromPayload({
        chain: args.chain,
        input: args.input,
        request: quoteRequest,
        ...quotePayload,
      }),
    );
  }

  const quoteId = flyQuoteId(quotePayload.payload);
  if (!quoteId) {
    return annotateDownstreamResult(
      args.primaryResult,
      requestErrorResult(
        args.input,
        quoteRequest,
        "Fly quote response did not include a quote id.",
      ),
    );
  }

  const distributionRequest = downstreamRequest(
    args.request,
    flyDistributionsUrl(quoteId),
  );
  const distributionPayload = await fetchDownstreamPayload({
    ...args,
    request: distributionRequest,
  });
  if ("result" in distributionPayload) return distributionPayload.result;
  return annotateDownstreamResult(
    args.primaryResult,
    probeResultFromPayload({
      chain: args.chain,
      input: args.input,
      request: distributionRequest,
      evidenceMode: "pool-only",
      ...distributionPayload,
    }),
  );
}

async function fetchDownstreamPayload(args: {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  quoteBudget?: QuoteAttemptBudget | undefined;
}): Promise<TimedPayload | { result: PairProbeResult }> {
  if (!consumeQuoteAttempt(args.quoteBudget)) {
    return {
      result: {
        ...quoteBudgetExhaustedResult(args.input, 0),
        routeAmountUsd: args.request.amountDecimal ?? args.input.amountDecimal,
        routeVariant: args.request.variant ?? null,
      },
    };
  }
  try {
    return await fetchTimedPayload({
      fetcher: args.fetcher,
      request: args.request,
    });
  } catch (error) {
    return {
      result: requestErrorResult(args.input, args.request, error),
    };
  }
}

function annotateDownstreamResult(
  primary: PairProbeResult,
  downstream: PairProbeResult,
): PairProbeResult {
  return {
    ...downstream,
    downstreamProvider:
      primary.downstreamProvider ?? downstream.downstreamProvider,
    sourceLabels: mergedStrings(primary.sourceLabels, downstream.sourceLabels),
    txTarget: primary.txTarget ?? downstream.txTarget,
  };
}

function mergedStrings(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])].sort();
}

function downstreamRequest(parent: QuoteRequest, url: string): QuoteRequest {
  return {
    url,
    ...(parent.amountDecimal ? { amountDecimal: parent.amountDecimal } : {}),
    ...(parent.amountRaw ? { amountRaw: parent.amountRaw } : {}),
    ...(parent.variant ? { variant: parent.variant } : {}),
  };
}

function lifiFollowUpInput(
  input: QuoteProbeInput,
  request: QuoteRequest,
): QuoteProbeInput {
  return {
    ...input,
    amountDecimal: request.amountDecimal ?? input.amountDecimal,
    amountRaw: request.amountRaw ?? input.amountRaw,
  };
}
