import { describe, expect, it } from "vitest";
import { squidQuoteRequests } from "../adapterRequests.js";
import type {
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  QuoteProbeInput,
} from "../types.js";

const SELL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USDT = "0xdddddddddddddddddddddddddddddddddddddddd";
const POOL = "0xcccccccccccccccccccccccccccccccccccccccc";
const VIA_POOL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RAW_1 = "1000000000000000000";
const RAW_1K = "1000000000000000000000";
const RAW_2K = "2000000000000000000000";
const RAW_10K = "10000000000000000000000";

const input: QuoteProbeInput = {
  chainId: 42220,
  pairId: "42220:EURm-USDm:42220-0xpool",
  direction: "base-to-usdm",
  sellToken: { symbol: "EURm", address: SELL, decimals: 18 },
  buyToken: { symbol: "USDm", address: BUY, decimals: 18 },
  amountDecimal: "1",
  amountRaw: RAW_1,
  sellReserveRaw: RAW_10K,
  buyReserveRaw: RAW_10K,
  takerAddress: "0x000000000000000000000000000000000000dEaD",
};

const chain: ChainProbeConfig = {
  chainId: 42220,
  chainLabel: "Celo",
  chainSlug: "celo",
  routerAddresses: [],
  poolAddresses: [],
  pairs: [
    {
      id: input.pairId,
      chainId: input.chainId,
      poolId: "42220-0xpool",
      poolAddress: "0xpool",
      poolSource: "fpmm_factory",
      base: input.sellToken,
      quote: input.buyToken,
      baseReserveRaw: RAW_10K,
      quoteReserveRaw: RAW_10K,
    },
  ],
};

describe("squidQuoteRequests", () => {
  it("builds a liquidity-aware Celo discovery ladder from Uniswap depth", async () => {
    const requests = await squidRequestsAfterDefaultFailure(
      input,
      { SQUID_INTEGRATOR_ID: "squid-id" },
      chain,
      uniswapRpcFetcher(RAW_1K),
    );

    expect(requests).toHaveLength(9);
    expect(requests[0]?.variant).toBe("default");
    expect(requestBody(requests[0]!).fromAmount).toBe(RAW_1);
    expect(requests.map((request) => request.amountDecimal)).toEqual([
      "1",
      "5",
      "10",
      "20",
      "50",
      "100",
      "2000",
      "5000",
      "9000",
    ]);
    expect(
      requests.some(
        (request) => request.variant === "squid-uniswap-depth-0.5pct",
      ),
    ).toBe(true);
    expect(requestBody(requests[1]!).fromAmount).toBe("5000000000000000000");
  });

  it("falls back to Mento reserve sizing when Uniswap depth is unavailable", async () => {
    const requests = await squidRequestsAfterDefaultFailure(
      input,
      { SQUID_INTEGRATOR_ID: "squid-id" },
      chain,
      async () => {
        throw new Error("rpc unavailable");
      },
    );

    expect(requests.map((request) => request.amountDecimal)).toEqual([
      "1",
      "10",
      "100",
      "500",
      "2000",
      "5000",
      "9000",
    ]);
    expect(
      requests.some((request) => request.variant?.startsWith("squid-mento")),
    ).toBe(true);
  });

  it("does not call Celo RPC for non-Celo ladders", async () => {
    const requests = await squidRequestsAfterDefaultFailure(
      {
        ...input,
        chainId: 143,
        sellToken: { ...input.sellToken, decimals: 0 },
        amountRaw: "1",
        sellReserveRaw: "1000",
      },
      { SQUID_INTEGRATOR_ID: "squid-id" },
      { ...chain, chainId: 143 },
      async () => {
        throw new Error("should not call RPC");
      },
    );

    expect(requests.map((request) => request.amountDecimal)).toEqual([
      "1",
      "10",
      "50",
      "100",
      "200",
      "500",
      "900",
    ]);
  });

  it("uses the first-hop sell depth from an active via-USDT path", async () => {
    const requests = await squidRequestsAfterDefaultFailure(
      input,
      { SQUID_INTEGRATOR_ID: "squid-id" },
      chainWithUsdt(),
      viaUsdtRpcFetcher(),
    );

    expect(requests.map((request) => request.amountDecimal)).toEqual([
      "1",
      "10",
      "40",
      "100",
      "200",
      "500",
      "2000",
      "5000",
      "9000",
    ]);
    expect(
      requests.some(
        (request) => request.variant === "squid-uniswap-depth-2pct",
      ),
    ).toBe(true);
  });
});

async function squidRequestsAfterDefaultFailure(
  input: QuoteProbeInput,
  env: NodeJS.ProcessEnv,
  chain: ChainProbeConfig,
  fetcher: FetchLike,
): Promise<ReturnType<typeof squidQuoteRequests>> {
  const defaultRequests = squidQuoteRequests(input, env);
  const defaultRequest = defaultRequests[0]!;
  expect(defaultRequests).toHaveLength(1);
  expect(defaultRequest.afterFailure).toEqual(expect.any(Function));
  const discoveredRequests = await defaultRequest.afterFailure!({
    chain,
    input,
    fetcher,
    request: defaultRequest,
    primaryResult: failedPrimaryResult(input),
  });
  return [...defaultRequests, ...discoveredRequests];
}

function failedPrimaryResult(input: QuoteProbeInput): PairProbeResult {
  return {
    pairId: input.pairId,
    poolId: "42220-0xpool",
    direction: input.direction,
    sellSymbol: input.sellToken.symbol,
    buySymbol: input.buyToken.symbol,
    status: "fail",
    evidence: [],
    sourceLabels: [],
    txTarget: null,
    downstreamProvider: null,
    routeVariant: "default",
    routeAmountUsd: input.amountDecimal,
    attemptCount: 1,
    requestUrl: "https://apiplus.squidrouter.com/v2/route",
    httpStatus: 200,
    latencyMs: 1,
    responsePreview: "{}",
    error: null,
  };
}

function uniswapRpcFetcher(poolSellBalanceRaw: string): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const data = String(body.params[0].data);
    if (data.startsWith("0x1698ee82")) {
      const fee = BigInt(`0x${data.slice(-64)}`);
      return new Response(
        JSON.stringify({
          result: encodeAddressResult(fee === 100n ? POOL : ZERO_ADDRESS),
        }),
      );
    }
    if (data.startsWith("0x1a686502")) {
      return new Response(JSON.stringify({ result: encodeUint(1n) }));
    }
    if (data.startsWith("0x70a08231")) {
      return new Response(
        JSON.stringify({ result: encodeUint(BigInt(poolSellBalanceRaw)) }),
      );
    }
    throw new Error(`unexpected RPC data ${data}`);
  };
}

function viaUsdtRpcFetcher(): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const call = body.params[0] as { to: string; data: string };
    if (call.data.startsWith("0x1698ee82")) {
      const fee = BigInt(`0x${call.data.slice(-64)}`);
      const pool =
        fee === 100n && callIncludes(call.data, SELL, USDT)
          ? POOL
          : fee === 100n && callIncludes(call.data, USDT, BUY)
            ? VIA_POOL
            : ZERO_ADDRESS;
      return new Response(
        JSON.stringify({ result: encodeAddressResult(pool) }),
      );
    }
    if (call.data.startsWith("0x1a686502")) {
      return new Response(JSON.stringify({ result: encodeUint(1n) }));
    }
    if (call.data.startsWith("0x70a08231")) {
      const balance = call.to.toLowerCase() === SELL ? RAW_2K : RAW_1K;
      return new Response(
        JSON.stringify({ result: encodeUint(BigInt(balance)) }),
      );
    }
    throw new Error(`unexpected RPC data ${call.data}`);
  };
}

function chainWithUsdt(): ChainProbeConfig {
  return {
    ...chain,
    pairs: [
      ...chain.pairs,
      {
        id: "42220:USDT-USDm:42220-0xusdt",
        chainId: input.chainId,
        poolId: "42220-0xusdt",
        poolAddress: "0xusdt",
        poolSource: "fpmm_factory",
        base: { symbol: "USDT", address: USDT, decimals: 18 },
        quote: input.buyToken,
      },
    ],
  };
}

function callIncludes(data: string, a: string, b: string): boolean {
  return (
    data.includes(encodeAddressArg(a)) && data.includes(encodeAddressArg(b))
  );
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function requestBody(request: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

function encodeAddressResult(address: string): string {
  return `0x${address.replace(/^0x/u, "").padStart(64, "0")}`;
}

function encodeAddressArg(address: string): string {
  return address.replace(/^0x/u, "").padStart(64, "0");
}

function encodeUint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
