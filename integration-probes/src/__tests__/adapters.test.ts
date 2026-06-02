import { describe, expect, it } from "vitest";
import {
  AGGREGATOR_ADAPTERS,
  aggregatePairStatus,
  probeAdapterPair,
} from "../adapters.js";
import type { AggregatorAdapter } from "../adapters.js";
import type { ChainProbeConfig, QuoteProbeInput } from "../types.js";

const input: QuoteProbeInput = {
  chainId: 42220,
  pairId: "42220:EURm-USDm:42220-0xpool",
  direction: "base-to-usdm",
  sellToken: {
    symbol: "EURm",
    address: "0x3D1bDb82b2d5785e85d973900ABCd4E9B0dA6F61",
    decimals: 18,
  },
  buyToken: {
    symbol: "USDm",
    address: "0xc45eCF20f3CD864B32D9794d6f76814aE8892e20",
    decimals: 18,
  },
  amountDecimal: "1",
  amountRaw: "1000000000000000000",
  takerAddress: "0x000000000000000000000000000000000000dEaD",
};

const chain: ChainProbeConfig = {
  chainId: 42220,
  chainLabel: "Celo",
  chainSlug: "celo",
  routerAddresses: ["0x1111111111111111111111111111111111111111"],
  poolAddresses: ["0x2222222222222222222222222222222222222222"],
  pairs: [],
};

describe("probeAdapterPair", () => {
  it("returns needs_key when credentials are missing", async () => {
    const adapter: AggregatorAdapter = {
      id: "keyed",
      label: "Keyed",
      kind: "dex",
      tier: 1,
      credentialEnv: ["KEYED_API_KEY"],
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        throw new Error("should not fetch");
      },
      env: {},
    });

    expect(result.status).toBe("needs_key");
    expect(result.error).toBe("Missing KEYED_API_KEY");
  });

  it("passes when response payload contains Mento address evidence", async () => {
    const adapter: AggregatorAdapter = {
      id: "public",
      label: "Public",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            transactionRequest: {
              to: "0x1111111111111111111111111111111111111111",
            },
          }),
        ),
      env: {},
    });

    expect(result.status).toBe("pass");
    expect(result.evidence[0]?.type).toBe("router-address");
  });

  it("does not pass on label-only Mento evidence", async () => {
    const adapter: AggregatorAdapter = {
      id: "public",
      label: "Public",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(JSON.stringify({ route: [{ protocol: "Mento" }] })),
      env: {},
    });

    expect(result.status).toBe("fail");
    expect(result.sourceLabels).toEqual(["Mento"]);
    expect(result.evidence).toEqual([]);
  });

  it("keeps no-liquidity and rate-limit responses explicit", async () => {
    const adapter: AggregatorAdapter = {
      id: "public",
      label: "Public",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const noLiquidity = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(JSON.stringify({ message: "no route found" }), {
          status: 400,
        }),
      env: {},
    });
    const rateLimited = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => new Response("{}", { status: 429 }),
      env: {},
    });

    expect(noLiquidity.status).toBe("no_liquidity");
    expect(rateLimited.status).toBe("rate_limited");
  });

  it("maps unauthorized quote responses to needs_key", async () => {
    const adapter: AggregatorAdapter = {
      id: "keyed",
      label: "Keyed",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(JSON.stringify({ message: "forbidden" }), {
          status: 403,
        }),
      env: {},
    });

    expect(result.status).toBe("needs_key");
    expect(result.error).toBe("HTTP 403: forbidden");
  });

  it("maps Cloudflare access challenges to rate_limited", async () => {
    const adapter: AggregatorAdapter = {
      id: "blocked",
      label: "Blocked",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response("<title>Attention Required! | Cloudflare</title>", {
          status: 403,
        }),
      env: {},
    });

    expect(result.status).toBe("rate_limited");
    expect(result.error).toBe("HTTP 403: Cloudflare access challenge");
    expect(result.httpStatus).toBe(403);
    expect(result.responsePreview).toContain("Cloudflare");
  });

  it("maps token-not-found responses to unsupported", async () => {
    const adapter: AggregatorAdapter = {
      id: "partial-token-support",
      label: "Partial Token Support",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(JSON.stringify({ message: "token not found" }), {
          status: 400,
        }),
      env: {},
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toBe("HTTP 400: token not found");
  });

  it("maps successful HTTP responses with error payloads to error", async () => {
    const adapter: AggregatorAdapter = {
      id: "rubic-like",
      label: "Rubic-like",
      kind: "meta",
      tier: 2,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => ({ url: "https://example.test" }),
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: { code: 2002, reason: "CELO blockchain temporarily down" },
          }),
        ),
      env: {},
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("CELO blockchain temporarily down");
  });

  it("returns unsupported before requiring credentials", async () => {
    const adapter: AggregatorAdapter = {
      id: "unsupported",
      label: "Unsupported",
      kind: "dex",
      tier: 1,
      credentialEnv: ["API_KEY"],
      support: { 42220: "unsupported" },
      researchNote: "not listed",
      quote: () => {
        throw new Error("should not build quote");
      },
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        throw new Error("should not fetch");
      },
      env: {},
    });

    expect(result.status).toBe("unsupported");
    expect(result.error).toBe("not listed");
  });

  it("marks adapters without a quote parser as errors after credentials exist", async () => {
    const adapter: AggregatorAdapter = {
      id: "planned",
      label: "Planned",
      kind: "dex",
      tier: 2,
      credentialEnv: ["PLANNED_KEY"],
      support: { 42220: "supported" },
      researchNote: "test",
      nextStep: "wire quote parser",
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        throw new Error("should not fetch");
      },
      env: { PLANNED_KEY: "configured" },
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("wire quote parser");
  });
});

describe("aggregatePairStatus", () => {
  it("keeps unsupported and needs-key states distinct from failures", () => {
    expect(aggregatePairStatus([{ status: "unsupported" }])).toBe(
      "unsupported",
    );
    expect(aggregatePairStatus([{ status: "needs_key" }])).toBe("needs_key");
    expect(aggregatePairStatus([{ status: "pass" }, { status: "fail" }])).toBe(
      "fail",
    );
    expect(
      aggregatePairStatus([{ status: "pass" }, { status: "needs_key" }]),
    ).toBe("needs_key");
    expect(
      aggregatePairStatus([{ status: "error" }, { status: "error" }]),
    ).toBe("error");
    expect(aggregatePairStatus([])).toBe("error");
  });
});

describe("aggregator quote builders", () => {
  it("builds configured quote requests for v1 live adapters", () => {
    const env = {
      LIFI_API_KEY: "lifi-key",
      ZEROX_API_KEY: "0x-key",
      ONEINCH_API_KEY: "one-inch-key",
      SOCKET_API_KEY: "socket-key",
      SQUID_INTEGRATOR_ID: "squid-id",
    };
    const expected = [
      "lifi",
      "openocean",
      "0x",
      "squid",
      "socket",
      "rubic",
      "relay",
      "kyberswap",
    ];

    for (const id of expected) {
      const adapter = AGGREGATOR_ADAPTERS.find((item) => item.id === id);
      const request = adapter?.quote?.(input, env);

      expect(request?.url, id).toContain("http");
      expect(JSON.stringify(request), id).toContain(input.sellToken.address);
      expect(JSON.stringify(request), id).toContain(input.buyToken.address);
    }
    const lifiRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "lifi",
    )?.quote?.(input, env);
    expect(JSON.stringify(lifiRequest?.init?.headers)).toContain(
      "x-lifi-api-key",
    );
    const lifiIntegrator = new URL(lifiRequest?.url ?? "").searchParams.get(
      "integrator",
    );
    expect(lifiIntegrator).toBe("mento-probes");
    expect(lifiIntegrator?.length).toBeLessThanOrEqual(23);

    const openOceanRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "openocean",
    )?.quote?.(input, env);
    const openOceanParams = new URL(openOceanRequest?.url ?? "").searchParams;
    expect(openOceanParams.get("amountDecimals")).toBe(input.amountRaw);
    expect(openOceanParams.has("amount")).toBe(false);

    const relayRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "relay",
    )?.quote?.(input, env);
    expect(relayRequest?.url).toBe("https://api.relay.link/quote/v2");

    const kyberRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "kyberswap",
    )?.quote?.(input, env);
    expect(JSON.stringify(kyberRequest?.init?.headers)).toContain(
      "x-client-id",
    );
  });

  it("marks 1inch unsupported on Celo and Monad until docs list support", () => {
    const oneInch = AGGREGATOR_ADAPTERS.find((item) => item.id === "1inch");

    expect(oneInch?.support[42220]).toBe("unsupported");
    expect(oneInch?.support[143]).toBe("unsupported");
  });
});
