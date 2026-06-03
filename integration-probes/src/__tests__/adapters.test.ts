import { describe, expect, it } from "vitest";
import {
  AGGREGATOR_ADAPTERS,
  aggregatePairStatus,
  probeAdapterPair,
} from "../adapters.js";
import type { AggregatorAdapter } from "../adapters.js";
import type { ChainProbeConfig, QuoteProbeInput } from "../types.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const OTHER_POOL = "0x3333333333333333333333333333333333333333";

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
  routerAddresses: [ROUTER],
  poolAddresses: [POOL, OTHER_POOL],
  pairs: [
    {
      id: input.pairId,
      chainId: input.chainId,
      poolId: "42220-0xpool",
      poolAddress: POOL,
      poolSource: "test",
      base: input.sellToken,
      quote: input.buyToken,
    },
  ],
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
              to: ROUTER,
            },
          }),
        ),
      env: {},
    });

    expect(result.status).toBe("pass");
    expect(result.evidence[0]?.type).toBe("router-address");
  });

  it("passes on pool evidence only for the current pair", async () => {
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
          JSON.stringify({ route: [{ data: `swap through ${POOL}` }] }),
        ),
      env: {},
    });

    expect(result.status).toBe("pass");
    expect(result.evidence[0]?.type).toBe("pool-address");
  });

  it("does not pass on pool evidence from a different pair", async () => {
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
          JSON.stringify({ route: [{ data: `swap through ${OTHER_POOL}` }] }),
        ),
      env: {},
    });

    expect(result.status).toBe("fail");
    expect(result.evidence).toEqual([]);
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

  it("passes when a later quote attempt contains Mento address evidence", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
      ],
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("discovery")
              ? { transactionRequest: { data: `swap through ${ROUTER}` } }
              : { route: [{ protocol: "Other" }] },
          ),
        ),
      env: {},
    });

    expect(result.status).toBe("pass");
    expect(result.requestUrl).toBe("https://example.test/discovery");
    expect(result.routeVariant).toBe("allow-openocean");
    expect(result.routeAmountUsd).toBe("1000");
    expect(result.attemptCount).toBe(2);
  });

  it("continues route discovery after a quote attempt throws", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
      ],
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async (url) => {
        if (!String(url).includes("discovery")) {
          throw new Error("temporary network error");
        }
        return new Response(
          JSON.stringify({
            transactionRequest: { data: `swap through ${ROUTER}` },
          }),
        );
      },
      env: {},
    });

    expect(result.status).toBe("pass");
    expect(result.requestUrl).toBe("https://example.test/discovery");
    expect(result.routeVariant).toBe("allow-openocean");
    expect(result.routeAmountUsd).toBe("1000");
    expect(result.attemptCount).toBe(2);
  });

  it("surfaces terminal rate limits instead of masking them with fallbacks", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/rate-limited",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
      ],
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async (url) => {
        if (String(url).includes("rate-limited")) {
          return new Response(JSON.stringify({ message: "slow down" }), {
            status: 429,
          });
        }
        return new Response(JSON.stringify({ route: [{ protocol: "Mento" }] }));
      },
      env: {},
    });

    expect(result.status).toBe("rate_limited");
    expect(result.requestUrl).toBe("https://example.test/rate-limited");
    expect(result.routeVariant).toBe("allow-openocean");
    expect(result.error).toBe("HTTP 429: slow down");
    expect(result.attemptCount).toBe(2);
  });

  it("caps repeated request errors before exhausting route discovery", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
        {
          url: "https://example.test/late-pass",
          amountDecimal: "10000",
          variant: "allow-mento",
        },
      ],
    };
    let calls = 0;

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        calls += 1;
        throw new Error("temporary network error");
      },
      env: {},
    });

    expect(result.status).toBe("error");
    expect(result.requestUrl).toBe("https://example.test/default");
    expect(result.routeVariant).toBe("default");
    expect(result.attemptCount).toBe(2);
    expect(calls).toBe(2);
  });

  it("caps repeated HTTP error responses before exhausting route discovery", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
        {
          url: "https://example.test/late-pass",
          amountDecimal: "10000",
          variant: "allow-openocean",
        },
      ],
    };
    let calls = 0;

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "upstream timeout" }), {
          status: 503,
        });
      },
      env: {},
    });

    expect(result.status).toBe("error");
    expect(result.requestUrl).toBe("https://example.test/default");
    expect(result.error).toBe("HTTP 503: upstream timeout");
    expect(result.attemptCount).toBe(2);
    expect(calls).toBe(2);
  });

  it("stops route discovery when the quote-attempt budget is exhausted", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
      ],
    };
    let calls = 0;

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ route: [{ protocol: "Other" }] }));
      },
      env: {},
      quoteBudget: { remaining: 1 },
    });

    expect(result.status).toBe("fail");
    expect(result.requestUrl).toBe("https://example.test/default");
    expect(result.attemptCount).toBe(1);
    expect(calls).toBe(1);
  });

  it("keeps the best fallback when the run-level quote budget is exhausted", async () => {
    const adapter: AggregatorAdapter = {
      id: "multi-attempt",
      label: "Multi Attempt",
      kind: "dex",
      tier: 1,
      support: { 42220: "supported" },
      researchNote: "test",
      quote: () => [
        {
          url: "https://example.test/default",
          amountDecimal: "1",
          variant: "default",
        },
        {
          url: "https://example.test/discovery",
          amountDecimal: "1000",
          variant: "allow-openocean",
        },
      ],
    };

    const result = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(JSON.stringify({ route: [{ protocol: "Mento" }] })),
      env: {},
      quoteBudget: { remaining: 1 },
    });

    expect(result.status).toBe("fail");
    expect(result.requestUrl).toBe("https://example.test/default");
    expect(result.routeVariant).toBe("default");
    expect(result.sourceLabels).toEqual(["Mento"]);
    expect(result.attemptCount).toBe(1);
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
    const noAvailLiquidity = await probeAdapterPair({
      adapter,
      chain,
      input,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            code: 500,
            error: "No avail liquidity for the pair",
          }),
        ),
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
    expect(noAvailLiquidity.status).toBe("no_liquidity");
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

  it("extracts message fields from object error payloads", async () => {
    const adapter: AggregatorAdapter = {
      id: "message-error",
      label: "Message Error",
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
            error: { code: 503, message: "upstream unavailable" },
          }),
        ),
      env: {},
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("upstream unavailable");
  });

  it("stringifies object error payloads without a reason or message", async () => {
    const adapter: AggregatorAdapter = {
      id: "object-error",
      label: "Object Error",
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
        new Response(JSON.stringify({ error: { code: 503 } })),
      env: {},
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe('{"code":503}');
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
      OPENOCEAN_API_KEY: "openocean-key",
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
      const request = firstQuoteRequest(adapter?.quote?.(input, env));

      expect(request?.url, id).toContain("http");
      expect(JSON.stringify(request), id).toContain(input.sellToken.address);
      expect(JSON.stringify(request), id).toContain(input.buyToken.address);
    }
    const lifiRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "lifi",
    )?.quote?.(input, env);
    const lifiRequests = quoteRequests(lifiRequest);
    const lifiDefaultRequest = lifiRequests[0];
    expect(lifiRequests.length).toBeGreaterThan(1);
    expect(JSON.stringify(lifiDefaultRequest?.init?.headers)).toContain(
      "x-lifi-api-key",
    );
    const lifiIntegrator = new URL(
      lifiDefaultRequest?.url ?? "",
    ).searchParams.get("integrator");
    expect(lifiIntegrator).toBe("mento-probes");
    expect(lifiIntegrator?.length).toBeLessThanOrEqual(23);
    expect(
      lifiRequests.some((request) =>
        request.url.includes("allowExchanges=openocean"),
      ),
    ).toBe(true);
    expect(
      lifiRequests.some((request) =>
        request.url.includes("allowExchanges=mento"),
      ),
    ).toBe(false);
    expect(
      lifiRequests.some((request) => request.amountDecimal === "100000"),
    ).toBe(true);
    expect(
      AGGREGATOR_ADAPTERS.find((item) => item.id === "lifi")
        ?.maxQuoteRequestsPerRun,
    ).toBe(180);

    const openOceanRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "openocean",
    )?.quote?.(input, env);
    const openOceanQuoteRequest = firstQuoteRequest(openOceanRequest);
    expect(openOceanQuoteRequest?.url).toContain(
      "https://open-api-pro.openocean.finance/v4/celo/swap",
    );
    expect(JSON.stringify(openOceanQuoteRequest?.init?.headers)).toContain(
      "openocean-key",
    );
    const openOceanParams = new URL(openOceanQuoteRequest?.url ?? "")
      .searchParams;
    expect(openOceanParams.get("amountDecimals")).toBe(input.amountRaw);
    expect(openOceanParams.get("gasPriceDecimals")).toBe("1000000000");
    expect(openOceanParams.get("enabledDexIds")).toBe("8");
    expect(openOceanParams.has("amount")).toBe(false);
    expect(openOceanParams.has("gasPrice")).toBe(false);

    const relayRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "relay",
    )?.quote?.(input, env);
    expect(firstQuoteRequest(relayRequest)?.url).toBe(
      "https://api.relay.link/quote/v2",
    );

    const squidRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "squid",
    )?.quote?.(input, env);
    const squidQuoteRequest = firstQuoteRequest(squidRequest);
    expect(
      JSON.parse(String(squidQuoteRequest?.init?.body)) as {
        quoteOnly?: boolean;
      },
    ).toMatchObject({ quoteOnly: true });

    const kyberRequest = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "kyberswap",
    )?.quote?.(input, env);
    expect(
      JSON.stringify(firstQuoteRequest(kyberRequest)?.init?.headers),
    ).toContain("x-client-id");
  });

  it("marks 1inch unsupported on Celo and Monad until docs list support", () => {
    const oneInch = AGGREGATOR_ADAPTERS.find((item) => item.id === "1inch");

    expect(oneInch?.support[42220]).toBe("unsupported");
    expect(oneInch?.support[143]).toBe("unsupported");
  });

  it("can still build the parked 1inch quote request", () => {
    const oneInch = AGGREGATOR_ADAPTERS.find((item) => item.id === "1inch");
    const request = firstQuoteRequest(
      oneInch?.quote?.(input, { ONEINCH_API_KEY: "one-inch-key" }),
    );

    expect(request?.url).toContain(
      "https://api.1inch.dev/swap/v6.1/42220/quote",
    );
    expect(request?.url).toContain(`src=${input.sellToken.address}`);
    expect(request?.url).toContain(`dst=${input.buyToken.address}`);
    expect(JSON.stringify(request?.init?.headers)).toContain("one-inch-key");
  });

  it("requires an OpenOcean Pro API key before probing OpenOcean", async () => {
    const openOcean = AGGREGATOR_ADAPTERS.find(
      (item) => item.id === "openocean",
    );
    expect(openOcean).toBeDefined();

    const result = await probeAdapterPair({
      adapter: openOcean!,
      chain,
      input,
      fetcher: async () => {
        throw new Error("should not fetch without a key");
      },
      env: {},
    });

    expect(result.status).toBe("needs_key");
    expect(result.error).toBe("Missing OPENOCEAN_API_KEY");
  });

  it("requires a LI.FI API key before probing LI.FI/Jumper", async () => {
    const lifi = AGGREGATOR_ADAPTERS.find((item) => item.id === "lifi");
    expect(lifi).toBeDefined();
    expect(lifi?.credentialEnv).toEqual(["LIFI_API_KEY"]);

    const result = await probeAdapterPair({
      adapter: lifi!,
      chain,
      input,
      fetcher: async () => {
        throw new Error("should not fetch without a key");
      },
      env: {},
    });

    expect(result.status).toBe("needs_key");
    expect(result.error).toBe("Missing LIFI_API_KEY");
  });
});

type QuoteRequestFixture = {
  url: string;
  init?: RequestInit;
  amountDecimal?: string;
  variant?: string;
};

function quoteRequests(request: unknown): QuoteRequestFixture[] {
  if (!request) return [];
  return (
    Array.isArray(request) ? request : [request]
  ) as QuoteRequestFixture[];
}

function firstQuoteRequest(request: unknown): QuoteRequestFixture | undefined {
  return quoteRequests(request)[0];
}
