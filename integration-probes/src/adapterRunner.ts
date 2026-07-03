import { detectEvidence } from "./evidence.js";
import type {
  AggregatorAdapter,
  BeforeQuoteRequest,
  QuoteAttemptBudget,
  QuoteRequest,
  TimedPayload,
} from "./adapterTypes.js";
import type {
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  ProbeStatus,
  QuoteProbeInput,
} from "./types.js";

const REQUEST_ERROR_ATTEMPT_LIMIT = 2;

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
  const statuses = new Set(results.map((result) => result.status));
  if (statuses.size === 1) return results[0]!.status;
  if (statuses.has("rate_limited")) return "rate_limited";
  if (statuses.has("needs_key") && statuses.has("pass")) return "needs_key";
  if (statuses.has("pass")) return "partial";
  if (statuses.has("budget_exhausted")) return "budget_exhausted";
  return "fail";
}

export function blockingReason(status: ProbeStatus): string | null {
  switch (status) {
    case "pass":
      return null;
    case "partial":
      return "Some USDm hub routes passed, but full pair coverage is not healthy.";
    case "unsupported":
      return "Aggregator does not currently advertise support for this chain.";
    case "needs_key":
      return "Probe credentials are missing.";
    case "rate_limited":
      return "Aggregator API rate-limited the probe.";
    case "budget_exhausted":
      return "Probe exhausted its configured per-run quote-request budget before completing.";
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
  if (!hasQuoteAttempt(args.quoteBudget)) {
    return quoteBudgetExhaustedResult(args.input, 0);
  }
  const requests = normalizeQuoteRequests(
    await args.adapter.quote!(args.input, args.env, {
      chain: args.chain,
      fetcher: args.fetcher,
    }),
  );
  let fallback: PairProbeResult | null = null;
  let attemptCount = 0;
  let requestErrorAttempts = 0;
  const queue = [...requests];
  for (let index = 0; index < queue.length; index += 1) {
    const request = queue[index]!;
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
    await appendFailureDiscoveryRequests({ ...args, request, result, queue });
  }
  return fallback
    ? { ...fallback, attemptCount }
    : skippedResult(args.input, "error", "No quote requests built.");
}

async function appendFailureDiscoveryRequests(args: {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  result: PairProbeResult;
  queue: QuoteRequest[];
  quoteBudget?: QuoteAttemptBudget | undefined;
}): Promise<void> {
  if (!args.request.afterFailure || !hasQuoteAttempt(args.quoteBudget)) return;
  const discoveredRequests = await args.request.afterFailure({
    chain: args.chain,
    input: args.input,
    fetcher: args.fetcher,
    request: args.request,
    primaryResult: args.result,
  });
  args.queue.push(...normalizeQuoteRequests(discoveredRequests));
}

export function quoteBudgetExhaustedResult(
  input: QuoteProbeInput,
  attemptCount: number,
): PairProbeResult {
  return {
    ...skippedResult(
      input,
      "budget_exhausted",
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

export async function fetchTimedPayload(args: {
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

export function probeResultFromPayload(args: {
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
    case "budget_exhausted":
    case "rate_limited":
      return 2;
    case "needs_key":
      return 1;
    case "partial":
    case "pass":
      return 0;
  }
}

function terminalStatus(status: ProbeStatus): boolean {
  return (
    status === "needs_key" ||
    status === "rate_limited" ||
    status === "budget_exhausted"
  );
}

function requestErrored(result: PairProbeResult): boolean {
  return result.status === "error" && result.requestUrl !== null;
}

export function consumeQuoteAttempt(
  budget: QuoteAttemptBudget | undefined,
): boolean {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function hasQuoteAttempt(budget: QuoteAttemptBudget | undefined): boolean {
  return !budget || budget.remaining > 0;
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

export function responseOk(statusCode: number): boolean {
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

export function requestErrorResult(
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
