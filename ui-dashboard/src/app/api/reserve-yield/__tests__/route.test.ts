import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadRoute(): Promise<{
  GET: () => Promise<Response>;
}> {
  vi.resetModules();
  return (await import("../route")) as { GET: () => Promise<Response> };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/reserve-yield", () => {
  it("returns tracked principal and FEDFUNDS-derived AUSD forecasts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({
      principalUsd: 3200,
      forecastPrincipalUsd: 1000,
      earnedYieldUsd: null,
      grossApyPercent: 5.33,
      expenseBps: 15,
      revenueShareBps: 8000,
      holdingsError: null,
      rateError: null,
    });
    expect(body.netMentoApyPercent).toBeCloseTo(4.144, 6);
    expect(body.annualRunRateUsd).toBeCloseTo(41.44, 6);
    expect(body.next365dUsd).toBeCloseTo(41.44, 6);
    expect(body.next30dUsd).toBeCloseTo(3.406027, 6);
    expect(body.forecastUnavailableSymbols).toEqual(["sUSDS"]);
    expect(body.holdings).toHaveLength(2);
    expect(body.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      sourceLabel: "Reserve Safe",
      principalUsd: 2200,
      next30dUsd: null,
    });
    expect(body.holdings[1]).toMatchObject({
      assetSymbol: "AUSD",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Ops Safe",
      principalUsd: 1000,
    });
  });

  it("returns a clear empty holdings shape when the reserve has no yield-bearing rows", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITHOUT_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      );
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
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBeNull();
    expect(body.forecastPrincipalUsd).toBeNull();
    expect(body.holdings).toEqual([]);
    expect(body.holdingsError).toContain("Reserve API");
    expect(body.grossApyPercent).toBe(5.33);
    expect(body.annualRunRateUsd).toBeNull();
  });

  it("keeps tracked principal when FEDFUNDS fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }));
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(3200);
    expect(body.forecastPrincipalUsd).toBeNull();
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.rateError).toContain("FRED FEDFUNDS");
    expect(body.dailyRunRateUsd).toBeNull();
    expect(body.holdings[0].dailyRunRateUsd).toBeNull();
    expect(body.forecastUnavailableSymbols).toEqual(["AUSD", "sUSDS"]);
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
      );
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
