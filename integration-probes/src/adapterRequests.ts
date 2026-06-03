import type {
  QuoteRequest,
  QuoteResponseEvidenceHook,
  RequestHeaders,
} from "./adapterTypes.js";
import type { QuoteProbeInput } from "./types.js";

const LIFI_INTEGRATOR = "mento-probes";
export const LIFI_MAX_QUOTE_REQUESTS_PER_RUN = 180;
export const LIFI_FLY_EXCHANGE = "fly";

const LIFI_FLY_CHAIN_ID = 143;
const LIFI_FLY_NETWORKS: Partial<Record<number, string>> = {
  [LIFI_FLY_CHAIN_ID]: "monad",
};
const LIFI_ROUTE_DISCOVERY_MULTIPLIERS = [
  1n,
  10n,
  100n,
  1_000n,
  10_000n,
  100_000n,
] as const;
const OPENOCEAN_GAS_PRICE_WEI = "1000000000";
const OPENOCEAN_MENTO_V3_DEX_ID = "8";

export function getRequest(
  url: string,
  headers?: RequestHeaders,
  metadata: Omit<QuoteRequest, "url" | "init"> = {},
): QuoteRequest {
  return { url, ...metadata, ...(headers && { init: { headers } }) };
}

export function postRequest(
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

export function lifiQuoteRequests(
  input: QuoteProbeInput,
  env: NodeJS.ProcessEnv,
  afterResponse?: QuoteResponseEvidenceHook | undefined,
): readonly QuoteRequest[] {
  const headers = { "x-lifi-api-key": env.LIFI_API_KEY ?? "" };
  const out: QuoteRequest[] = [
    getRequest(
      lifiUrl(input),
      headers,
      lifiRequestMetadata({
        afterResponse,
        amountDecimal: input.amountDecimal,
        variant: "default",
      }),
    ),
  ];
  for (const multiplier of LIFI_ROUTE_DISCOVERY_MULTIPLIERS) {
    const amount = multipliedAmount(input, multiplier);
    out.push(
      lifiDiscoveryRequest({
        amount,
        afterResponse,
        headers,
        input,
        routeParams: { preferExchanges: "openocean" },
        variant: "prefer-openocean",
      }),
      lifiDiscoveryRequest({
        amount,
        afterResponse,
        headers,
        input,
        routeParams: { allowExchanges: "openocean" },
        variant: "allow-openocean",
      }),
    );
    if (lifiFlyNetwork(input.chainId)) {
      out.push(
        lifiDiscoveryRequest({
          amount,
          afterResponse,
          headers,
          input,
          routeParams: { allowExchanges: LIFI_FLY_EXCHANGE },
          variant: "allow-fly",
        }),
      );
    }
  }
  return dedupeRequests(out);
}

export function lifiPayloadUsesFly(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("tool" in payload)) {
    return false;
  }
  return String(payload.tool).toLowerCase() === LIFI_FLY_EXCHANGE;
}

export function flyQuoteId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("id" in payload)) {
    return null;
  }
  const id = payload.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function lifiFlyNetwork(chainId: number): string | null {
  return LIFI_FLY_NETWORKS[chainId] ?? null;
}

export function flyQuoteUrl(input: QuoteProbeInput, network: string): string {
  const url = new URL("https://api.fly.trade/aggregator/quote");
  setParams(url, {
    network,
    fromTokenAddress: input.sellToken.address,
    toTokenAddress: input.buyToken.address,
    sellAmount: input.amountRaw,
    slippage: "0.01",
    fromAddress: input.takerAddress,
    toAddress: input.takerAddress,
    gasless: "false",
  });
  return url.toString();
}

export function flyDistributionsUrl(quoteId: string): string {
  const url = new URL("https://api.fly.trade/aggregator/distributions");
  setParams(url, { quoteId });
  return url.toString();
}

export function openOceanUrl(input: QuoteProbeInput): string {
  const aliases: Record<number, string> = { 42220: "celo", 143: "monad" };
  const chain = aliases[input.chainId] ?? String(input.chainId);
  const url = new URL(
    `https://open-api-pro.openocean.finance/v4/${chain}/swap`,
  );
  setParams(url, {
    inTokenAddress: input.sellToken.address,
    outTokenAddress: input.buyToken.address,
    amountDecimals: input.amountRaw,
    account: input.takerAddress,
    slippage: "1",
    gasPriceDecimals: OPENOCEAN_GAS_PRICE_WEI,
    enabledDexIds: OPENOCEAN_MENTO_V3_DEX_ID,
  });
  return url.toString();
}

export function zeroXUrl(input: QuoteProbeInput): string {
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

export function oneInchUrl(input: QuoteProbeInput): string {
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

export function socketUrl(input: QuoteProbeInput): string {
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

export function kyberUrl(input: QuoteProbeInput): string {
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

export function squidBody(input: QuoteProbeInput): unknown {
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

export function relayBody(input: QuoteProbeInput): unknown {
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

export function rubicBody(input: QuoteProbeInput): unknown {
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

function lifiDiscoveryRequest(args: {
  amount: Pick<QuoteProbeInput, "amountDecimal" | "amountRaw">;
  afterResponse?: QuoteResponseEvidenceHook | undefined;
  headers: RequestHeaders;
  input: QuoteProbeInput;
  routeParams: Record<string, string>;
  variant: string;
}): QuoteRequest {
  return getRequest(
    lifiUrl({ ...args.input, ...args.amount }, args.routeParams),
    args.headers,
    lifiRequestMetadata({
      afterResponse: args.afterResponse,
      amountDecimal: args.amount.amountDecimal,
      variant: args.variant,
    }),
  );
}

function lifiRequestMetadata(args: {
  afterResponse?: QuoteResponseEvidenceHook | undefined;
  amountDecimal: string;
  variant: string;
}): Omit<QuoteRequest, "url" | "init"> {
  return {
    amountDecimal: args.amountDecimal,
    variant: args.variant,
    ...(args.afterResponse ? { afterResponse: args.afterResponse } : {}),
  };
}

function dedupeRequests(
  requests: readonly QuoteRequest[],
): readonly QuoteRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.variant ?? ""}:${request.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function multipliedAmount(
  input: QuoteProbeInput,
  multiplier: bigint,
): Pick<QuoteProbeInput, "amountDecimal" | "amountRaw"> {
  return {
    amountDecimal: multiplyDecimalString(input.amountDecimal, multiplier),
    amountRaw: String(BigInt(input.amountRaw) * multiplier),
  };
}

function multiplyDecimalString(value: string, multiplier: bigint): string {
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const scaled = BigInt(`${whole}${fraction}` || "0") * multiplier;
  const digits = scaled.toString().padStart(fraction.length + 1, "0");
  if (fraction.length === 0) return `${sign}${digits}`;
  const wholePart = digits.slice(0, -fraction.length) || "0";
  const fractionPart = digits.slice(-fraction.length).replace(/0+$/u, "");
  return fractionPart
    ? `${sign}${wholePart}.${fractionPart}`
    : `${sign}${wholePart}`;
}

function lifiUrl(
  input: QuoteProbeInput,
  extraParams: Record<string, string> = {},
): string {
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
    ...extraParams,
  });
  return url.toString();
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
