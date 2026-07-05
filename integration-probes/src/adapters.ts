import {
  flyApiHeaders,
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
  AggregatorAdapter,
  QuoteAttemptBudget,
  QuoteRequest,
  QuoteResponseEvidenceArgs,
  QuoteResponseEvidenceHook,
  RequestHeaders,
  TimedPayload,
} from "./adapterTypes.js";
import {
  consumeQuoteAttempt,
  fetchTimedPayload,
  probeResultFromPayload,
  quoteBudgetExhaustedResult,
  requestErrorResult,
  responseOk,
} from "./adapterRunner.js";
import type {
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  QuoteProbeInput,
} from "./types.js";

const DEFAULT_TAKER = "0x000000000000000000000000000000000000dEaD";

export type { AggregatorAdapter } from "./adapterTypes.js";
export {
  aggregatePairStatus,
  blockingReason,
  poolIdFromPairId,
  probeAdapterPair,
} from "./adapterRunner.js";

export const PROBE_TAKER_ADDRESS = DEFAULT_TAKER;

export const AGGREGATOR_ADAPTERS: AggregatorAdapter[] = [
  lifiAdapter(),
  squidAdapter(),
  openOceanAdapter(),
  kyberAdapter(),
  oneInchAdapter(),
  zeroXAdapter(),
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
  relayAdapter(),
  excludedAdapter(
    "odos",
    "Odos",
    "Public chain metadata currently lists neither Celo nor Monad.",
  ),
  socketAdapter(),
  rubicAdapter(),
  excludedAdapter(
    "debridge",
    "deBridge",
    "Direct Celo/Monad quote coverage needs separate evidence; track via Rubic/Relay first.",
  ),
];

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
      lifiQuoteRequests(input, env, lifiAfterResponseHook(input, env)),
  };
}

function openOceanAdapter(): AggregatorAdapter {
  return {
    id: "openocean",
    label: "OpenOcean",
    kind: "dex",
    tier: 1,
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
    tier: 2,
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
    tier: 1,
    credentialEnv: ["SQUID_INTEGRATOR_ID"],
    support: { 42220: "supported", 143: "unknown" },
    maxQuoteRequestsPerRun: SQUID_MAX_QUOTE_REQUESTS_PER_RUN,
    quoteRequestDelayMs: SQUID_QUOTE_REQUEST_DELAY_MS,
    researchNote:
      "Celo Squid routing is observed in the repo registry; Monad needs quote evidence. Probes are serialized and paced to avoid 429s from bursty route checks.",
    quote: (input, env, context) =>
      context
        ? squidQuoteRequests(input, env)
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
    tier: 2,
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
    tier: 2,
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
  env: NodeJS.ProcessEnv,
): QuoteResponseEvidenceHook | undefined {
  return lifiFlyNetwork(input.chainId)
    ? (args) => lifiFlyEvidence(args, env)
    : undefined;
}

async function lifiFlyEvidence(
  args: QuoteResponseEvidenceArgs,
  env: NodeJS.ProcessEnv,
): Promise<PairProbeResult | null> {
  if (!lifiPayloadUsesFly(args.payload)) return null;
  const network = lifiFlyNetwork(args.input.chainId);
  if (!network) return null;

  const quoteRequest = downstreamRequest(
    args.request,
    flyQuoteUrl(lifiFollowUpInput(args.input, args.request), network, env),
    flyApiHeaders(env),
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
    flyDistributionsUrl(quoteId, env),
    flyApiHeaders(env),
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

function downstreamRequest(
  parent: QuoteRequest,
  url: string,
  headers?: RequestHeaders,
): QuoteRequest {
  return {
    url,
    ...(headers ? { init: { headers } } : {}),
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
