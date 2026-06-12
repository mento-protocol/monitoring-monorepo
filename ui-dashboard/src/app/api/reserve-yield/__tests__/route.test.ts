import { beforeEach, describe, expect, it, vi } from "vitest";

const SKY_SSR_APY_PERCENT = 3.600000425292;
const SKY_SSR_RPC_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: "0x0000000000000000000000000000000000000000033b2e3caf60d0b2dd215bce",
};

const RESERVE_WITH_YIELD_COMPONENTS = {
  collateral: {
    assets: [
      {
        symbol: "AUSD",
        chain: "ethereum",
        balance: "1000",
        usd_value: 1000,
        sources: [
          {
            type: "wallet",
            label: "Ops Safe",
            identifier: "0xops",
            balance: "1000",
            usd_value: 1000,
            custodian_type: "ops",
          },
        ],
      },
      {
        symbol: "sUSDS",
        chain: "ethereum",
        balance: "2000",
        usd_value: 2200,
        sources: [
          {
            type: "wallet",
            label: "Reserve Safe",
            identifier: "0xreserve-safe",
            balance: "2000",
            usd_value: 2200,
            custodian_type: "cold",
          },
        ],
      },
    ],
  },
};

const SUSDS_LEDGER_SUMMARY = {
  id: "1-susds",
  currentShares: "2000000000000000000000",
  costBasisUsdWei: "2000000000000000000000",
  realizedYieldUsdWei: "100000000000000000000",
  transferredOutYieldUsdWei: "100000000000000000000",
  redeemedYieldUsdWei: "0",
  currentValueUsdWei: "2100000000000000000000",
  unrealizedYieldUsdWei: "100000000000000000000",
  totalEarnedYieldUsdWei: "200000000000000000000",
  sharePriceUsdWei: "1050000000000000000",
  lastUpdatedBlock: "25236329",
  lastUpdatedTimestamp: "1780483271",
};

const RESERVE_WITH_ONLY_AUSD = {
  collateral: {
    assets: [RESERVE_WITH_YIELD_COMPONENTS.collateral.assets[0]],
  },
};

const RESERVE_WITHOUT_YIELD_COMPONENTS = {
  collateral: {
    assets: [
      {
        symbol: "USDC",
        chain: "celo",
        balance: "1000",
        usd_value: 1000,
        sources: [],
      },
    ],
  },
};

const RESERVE_WITH_ONLY_SUSDS = {
  collateral: {
    assets: [
      {
        symbol: "sUSDS",
        chain: "ethereum",
        balance: "2000",
        usd_value: 2200,
        sources: [
          {
            type: "wallet",
            label: "Reserve Safe",
            identifier: "0xreserve-safe",
            balance: "2000",
            usd_value: 2200,
            custodian_type: "cold",
          },
        ],
      },
    ],
  },
};

async function loadRoute(): Promise<{
  GET: () => Promise<Response>;
}> {
  vi.resetModules();
  return (await import("../route")) as { GET: () => Promise<Response> };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/reserve-yield", () => {
  it("returns tracked principal and blended AUSD plus sUSDS forecasts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(body).toMatchObject({
      principalUsd: 3200,
      forecastPrincipalUsd: 3200,
      earnedYieldUsd: null,
      grossApyPercent: 5.33,
      expenseBps: 15,
      revenueShareBps: 8000,
      holdingsError: null,
      rateError: null,
    });
    expect(body.netMentoApyPercent).toBeCloseTo(4.144, 6);
    expect(body.skySavingsRateApyPercent).toBeCloseTo(SKY_SSR_APY_PERCENT, 12);
    expect(body.skySavingsRateSource).toBe("onchain-susds-ssr");
    expect(body.annualRunRateUsd).toBeCloseTo(120.640009, 6);
    expect(body.next365dUsd).toBeCloseTo(120.640009, 6);
    expect(body.next30dUsd).toBeCloseTo(9.915617, 6);
    expect(body.forecastUnavailableSymbols).toEqual([]);
    expect(body.holdings).toHaveLength(2);
    expect(body.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      sourceLabel: "Reserve Safe",
      principalUsd: 2200,
    });
    expect(body.holdings[0].apyPercent).toBeCloseTo(SKY_SSR_APY_PERCENT, 12);
    expect(body.holdings[0].next30dUsd).toBeCloseTo(6.50959, 6);
    expect(body.holdings[1]).toMatchObject({
      assetSymbol: "AUSD",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Ops Safe",
      principalUsd: 1000,
    });
  });

  it("merges indexed sUSDS cost basis with current reserve value when the ledger is available", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.example/v1/graphql");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            SusdsYieldSummary: [SUSDS_LEDGER_SUMMARY],
          },
        }),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "https://hasura.example/v1/graphql",
    );
    const graphqlBody = JSON.parse(
      String(fetchMock.mock.calls[3]?.[1]?.body),
    ) as { query: string; variables: Record<string, unknown> };
    expect(graphqlBody.query).toContain(
      "query SusdsYieldSummary($id: String!)",
    );
    expect(graphqlBody.variables.id).toBe("1-susds");
    expect(body.earnedYieldUsd).toBeCloseTo(300, 6);
    expect(body.realizedYieldUsd).toBeCloseTo(100, 6);
    expect(body.unrealizedYieldUsd).toBeCloseTo(200, 6);
    expect(body.earnedYieldAsOf).toBe("2026-06-03T10:41:11.000Z");
    expect(body.earnedYieldError).toBeNull();
    expect(body.holdings[0].assetSymbol).toBe("sUSDS");
    expect(body.holdings[0].earnedYieldUsd).toBeCloseTo(300, 6);
  });

  it("keeps indexed sUSDS yield when current reserve sUSDS parsing fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.example/v1/graphql");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          collateral: {
            assets: [
              {
                symbol: "sUSDS",
                chain: "ethereum",
                balance: "not-a-number",
                usd_value: "not-a-number",
                sources: [
                  {
                    type: "wallet",
                    label: "Reserve Safe",
                    balance: "not-a-number",
                    usd_value: "not-a-number",
                  },
                ],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            SusdsYieldSummary: [SUSDS_LEDGER_SUMMARY],
          },
        }),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.holdings).toEqual([]);
    expect(body.principalUsd).toBeNull();
    expect(body.holdingsError).toContain("without usable USD values");
    expect(body.earnedYieldUsd).toBeCloseTo(200, 6);
    expect(body.realizedYieldUsd).toBeCloseTo(100, 6);
    expect(body.unrealizedYieldUsd).toBeCloseTo(100, 6);
    expect(body.earnedYieldError).toBeNull();
  });

  it("suppresses sUSDS ledger errors when no sUSDS holding is displayed", async () => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.example/v1/graphql");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_ONLY_AUSD))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE))
      .mockResolvedValueOnce(
        Response.json({
          errors: [{ message: "field 'SusdsYieldSummary' not found" }],
        }),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.holdings).toHaveLength(1);
    expect(body.holdings[0].assetSymbol).toBe("AUSD");
    expect(body.earnedYieldUsd).toBeNull();
    expect(body.earnedYieldError).toBeNull();
  });

  it("returns a clear empty holdings shape when the reserve has no yield-bearing rows", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITHOUT_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.holdings).toEqual([]);
    expect(body.principalUsd).toBe(0);
    expect(body.forecastPrincipalUsd).toBeNull();
    expect(body.earnedYieldUsd).toBeNull();
    expect(body.holdingsError).toBeNull();
  });

  it("keeps FEDFUNDS data when reserve holdings fail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream down", { status: 502 }))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBeNull();
    expect(body.forecastPrincipalUsd).toBeNull();
    expect(body.holdings).toEqual([]);
    expect(body.holdingsError).toContain("Reserve API");
    expect(body.grossApyPercent).toBe(5.33);
    expect(body.skySavingsRateApyPercent).toBeCloseTo(SKY_SSR_APY_PERCENT, 12);
    expect(body.annualRunRateUsd).toBeNull();
  });

  it("keeps sUSDS forecasts when FEDFUNDS fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(3200);
    expect(body.forecastPrincipalUsd).toBe(2200);
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.skySavingsRateApyPercent).toBeCloseTo(SKY_SSR_APY_PERCENT, 12);
    expect(body.skySavingsRateSource).toBe("onchain-susds-ssr");
    expect(body.rateError).toContain("FRED FEDFUNDS");
    expect(body.dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.holdings[0].dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.forecastUnavailableSymbols).toEqual(["AUSD"]);
  });

  it("suppresses FRED errors when only sUSDS forecasts are shown", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_ONLY_SUSDS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(2200);
    expect(body.forecastPrincipalUsd).toBe(2200);
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.skySavingsRateApyPercent).toBeCloseTo(SKY_SSR_APY_PERCENT, 12);
    expect(body.rateError).toBeNull();
    expect(body.dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.forecastUnavailableSymbols).toEqual([]);
  });

  it("falls back to Block Analitica when the on-chain Sky Savings Rate read fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(new Response("rpc down", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(body.skySavingsRateApyPercent).toBeCloseTo(3.6, 12);
    expect(body.skySavingsRateSource).toBe("blockanalitica-overall");
    expect(body.rateError).toBeNull();
    expect(body.forecastUnavailableSymbols).toEqual([]);
    expect(body.holdings[0].assetSymbol).toBe("sUSDS");
    expect(body.holdings[0].yieldModel).toBe(
      "Sky Savings Rate APY from Block Analitica fallback",
    );
  });

  it("keeps AUSD forecasts when the Sky Savings Rate sources fail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(new Response("rpc down", { status: 503 }))
      .mockResolvedValueOnce(new Response("sky down", { status: 503 }));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(3200);
    expect(body.forecastPrincipalUsd).toBe(1000);
    expect(body.grossApyPercent).toBe(5.33);
    expect(body.netMentoApyPercent).toBeCloseTo(4.144, 6);
    expect(body.skySavingsRateApyPercent).toBeNull();
    expect(body.skySavingsRateSource).toBeNull();
    expect(body.rateError).toContain("Sky Savings Rate");
    expect(body.rateError).toContain("on-chain sUSDS.ssr()");
    expect(body.rateError).toContain("Block Analitica fallback");
    expect(body.annualRunRateUsd).toBeCloseTo(41.44, 6);
    expect(body.holdings[0].dailyRunRateUsd).toBeNull();
    expect(body.forecastUnavailableSymbols).toEqual(["SUSDS"]);
  });

  it("returns null forecasts when both rate feeds fail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
      .mockResolvedValueOnce(new Response("rpc down", { status: 503 }))
      .mockResolvedValueOnce(new Response("sky down", { status: 503 }));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(3200);
    expect(body.forecastPrincipalUsd).toBeNull();
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.skySavingsRateApyPercent).toBeNull();
    expect(body.skySavingsRateSource).toBeNull();
    expect(body.rateError).toContain("FRED FEDFUNDS");
    expect(body.rateError).toContain("Sky Savings Rate");
    expect(body.dailyRunRateUsd).toBeNull();
    expect(body.next30dUsd).toBeNull();
    expect(body.next365dUsd).toBeNull();
    expect(body.annualRunRateUsd).toBeNull();
    expect(body.holdings[0].dailyRunRateUsd).toBeNull();
    expect(body.holdings[1].dailyRunRateUsd).toBeNull();
    expect(body.forecastUnavailableSymbols).toEqual(["AUSD", "SUSDS"]);
  });

  it("does not emit zero-dollar estimates for malformed yield-bearing numeric fields", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          collateral: {
            assets: [
              {
                symbol: "sUSDS",
                chain: "ethereum",
                balance: "not-a-number",
                usd_value: "not-a-number",
                sources: [
                  {
                    type: "wallet",
                    label: "Ops Safe",
                    balance: "",
                    usd_value: "not-a-number",
                  },
                ],
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.holdings).toEqual([]);
    expect(body.principalUsd).toBeNull();
    expect(body.holdingsError).toContain("without usable USD values");
    expect(body.annualRunRateUsd).toBeNull();
  });
});
