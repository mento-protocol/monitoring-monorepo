import { detectEvidence } from "./evidence.js";
import type {
  AggregatorKind,
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  ProbeStatus,
  QuoteProbeInput,
} from "./types.js";

const DEFAULT_TAKER = "0x000000000000000000000000000000000000dEaD";
const LIFI_INTEGRATOR = "mento-probes";

type ChainSupport = "supported" | "unsupported" | "unknown";

type QuoteRequest = {
  url: string;
  init?: RequestInit;
};

type RequestHeaders = Record<string, string>;

export type AggregatorAdapter = {
  id: string;
  label: string;
  kind: AggregatorKind;
  tier: 1 | 2 | 3;
  credentialEnv?: readonly string[];
  researchNote: string;
  support: Partial<Record<number, ChainSupport>>;
  quote?: (input: QuoteProbeInput, env: NodeJS.ProcessEnv) => QuoteRequest;
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
      return "Aggregator API rate-limited the probe.";
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
}): Promise<PairProbeResult> {
  const request = args.adapter.quote!(args.input, args.env);
  const startedAt = Date.now();
  const response = await args.fetcher(request.url, request.init);
  const latencyMs = Date.now() - startedAt;
  const payload = await responseJson(response);
  const detected = detectEvidence(payload, {
    routerAddresses: args.chain.routerAddresses,
    poolAddresses: pairPoolAddresses(args.chain, args.input.pairId),
  });
  const status = statusFromResponse(response.status, detected.passes, payload);
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
    requestUrl: request.url,
    httpStatus: response.status,
    latencyMs,
    responsePreview: responsePreview(payload),
    error: response.ok
      ? payloadErrorMessage(payload)
      : errorMessage(payload, response.status),
  };
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
    support: { 42220: "supported", 143: "supported" },
    researchNote: "LI.FI chain metadata lists both Celo and Monad.",
    quote: (input, env) => getRequest(lifiUrl(input), optionalLifiHeaders(env)),
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
      "OpenOcean Pro endpoint is keyed and already observed in the repo registry on both chains.",
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
    researchNote:
      "Celo Squid routing is observed in the repo registry; Monad needs quote evidence.",
    quote: (input, env) =>
      postRequest(
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

function getRequest(url: string, headers?: RequestHeaders): QuoteRequest {
  return { url, ...(headers && { init: { headers } }) };
}

function postRequest(
  url: string,
  body: unknown,
  headers?: RequestHeaders,
): QuoteRequest {
  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  };
}

function lifiUrl(input: QuoteProbeInput): string {
  const url = new URL("https://li.quest/v1/quote");
  setParams(url, {
    fromChain: String(input.chainId),
    toChain: String(input.chainId),
    fromToken: input.sellToken.address,
    toToken: input.buyToken.address,
    fromAmount: input.amountRaw,
    fromAddress: input.takerAddress,
    toAddress: input.takerAddress,
    slippage: "0.01",
    integrator: LIFI_INTEGRATOR,
  });
  return url.toString();
}

function optionalLifiHeaders(
  env: NodeJS.ProcessEnv,
): RequestHeaders | undefined {
  return env.LIFI_API_KEY ? { "x-lifi-api-key": env.LIFI_API_KEY } : undefined;
}

function openOceanUrl(input: QuoteProbeInput): string {
  const aliases: Record<number, string> = { 42220: "celo", 143: "monad" };
  const chain = aliases[input.chainId] ?? String(input.chainId);
  const url = new URL(
    `https://open-api-pro.openocean.finance/v4/${chain}/swap`,
  );
  setParams(url, {
    inTokenAddress: input.sellToken.address,
    outTokenAddress: input.buyToken.address,
    amount: input.amountDecimal,
    account: input.takerAddress,
    slippage: "1",
    gasPrice: "1",
  });
  return url.toString();
}

function zeroXUrl(input: QuoteProbeInput): string {
  const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
  setParams(url, {
    chainId: String(input.chainId),
    sellToken: input.sellToken.address,
    buyToken: input.buyToken.address,
    sellAmount: input.amountRaw,
    taker: input.takerAddress,
  });
  return url.toString();
}

function oneInchUrl(input: QuoteProbeInput): string {
  const url = new URL(`https://api.1inch.dev/swap/v6.1/${input.chainId}/quote`);
  setParams(url, {
    src: input.sellToken.address,
    dst: input.buyToken.address,
    amount: input.amountRaw,
    includeTokensInfo: "true",
    includeProtocols: "true",
  });
  return url.toString();
}

function socketUrl(input: QuoteProbeInput): string {
  const url = new URL("https://api.socket.tech/v2/quote");
  setParams(url, {
    fromChainId: String(input.chainId),
    toChainId: String(input.chainId),
    fromTokenAddress: input.sellToken.address,
    toTokenAddress: input.buyToken.address,
    fromAmount: input.amountRaw,
    userAddress: input.takerAddress,
    singleTxOnly: "true",
  });
  return url.toString();
}

function kyberUrl(input: QuoteProbeInput): string {
  const aliases: Record<number, string> = { 143: "monad" };
  const chain = aliases[input.chainId] ?? String(input.chainId);
  const url = new URL(
    `https://aggregator-api.kyberswap.com/${chain}/api/v1/routes`,
  );
  setParams(url, {
    tokenIn: input.sellToken.address,
    tokenOut: input.buyToken.address,
    amountIn: input.amountRaw,
  });
  return url.toString();
}

function squidBody(input: QuoteProbeInput): unknown {
  return {
    fromChain: String(input.chainId),
    toChain: String(input.chainId),
    fromToken: input.sellToken.address,
    toToken: input.buyToken.address,
    fromAmount: input.amountRaw,
    fromAddress: input.takerAddress,
    toAddress: input.takerAddress,
    slippage: 1,
    quoteOnly: true,
  };
}

function relayBody(input: QuoteProbeInput): unknown {
  return {
    user: input.takerAddress,
    recipient: input.takerAddress,
    originChainId: input.chainId,
    destinationChainId: input.chainId,
    originCurrency: input.sellToken.address,
    destinationCurrency: input.buyToken.address,
    amount: input.amountRaw,
    tradeType: "EXACT_INPUT",
  };
}

function rubicBody(input: QuoteProbeInput): unknown {
  return {
    srcTokenBlockchain: rubicChain(input.chainId),
    dstTokenBlockchain: rubicChain(input.chainId),
    srcTokenAddress: input.sellToken.address,
    dstTokenAddress: input.buyToken.address,
    srcTokenAmount: input.amountDecimal,
    fromAddress: input.takerAddress,
    receiver: input.takerAddress,
    slippage: 0.01,
    referrer: "mento",
  };
}

function rubicChain(chainId: number): string {
  const aliases: Record<number, string> = { 42220: "CELO", 143: "MONAD" };
  return aliases[chainId] ?? String(chainId);
}

function setParams(url: URL, params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
}
