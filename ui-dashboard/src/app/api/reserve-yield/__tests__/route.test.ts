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
});

describe("GET /api/reserve-yield", () => {
  it("returns tracked principal and blended AUSD plus sUSDS forecasts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
      );
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
    expect(body.skySavingsRateApyPercent).toBeCloseTo(3.6, 12);
    expect(body.annualRunRateUsd).toBeCloseTo(120.64, 6);
    expect(body.next365dUsd).toBeCloseTo(120.64, 6);
    expect(body.next30dUsd).toBeCloseTo(9.915616, 6);
    expect(body.forecastUnavailableSymbols).toEqual([]);
    expect(body.holdings).toHaveLength(2);
    expect(body.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      sourceLabel: "Reserve Safe",
      principalUsd: 2200,
    });
    expect(body.holdings[0].apyPercent).toBeCloseTo(3.6, 12);
    expect(body.holdings[0].next30dUsd).toBeCloseTo(6.509589, 6);
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
      )
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
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
      )
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
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
    expect(body.skySavingsRateApyPercent).toBeCloseTo(3.6, 12);
    expect(body.annualRunRateUsd).toBeNull();
  });

  it("keeps sUSDS forecasts when FEDFUNDS fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(3200);
    expect(body.forecastPrincipalUsd).toBe(2200);
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.skySavingsRateApyPercent).toBeCloseTo(3.6, 12);
    expect(body.rateError).toContain("FRED FEDFUNDS");
    expect(body.dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.holdings[0].dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.forecastUnavailableSymbols).toEqual(["AUSD"]);
  });

  it("suppresses FRED errors when only sUSDS forecasts are shown", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_ONLY_SUSDS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
      );
    const { GET } = await loadRoute();

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.principalUsd).toBe(2200);
    expect(body.forecastPrincipalUsd).toBe(2200);
    expect(body.grossApyPercent).toBeNull();
    expect(body.netMentoApyPercent).toBeNull();
    expect(body.skySavingsRateApyPercent).toBeCloseTo(3.6, 12);
    expect(body.rateError).toBeNull();
    expect(body.dailyRunRateUsd).toBeCloseTo(79.2 / 365, 6);
    expect(body.forecastUnavailableSymbols).toEqual([]);
  });

  it("keeps AUSD forecasts when the Sky Savings Rate feed fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
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
    expect(body.rateError).toContain("Sky Savings Rate");
    expect(body.annualRunRateUsd).toBeCloseTo(41.44, 6);
    expect(body.holdings[0].dailyRunRateUsd).toBeNull();
    expect(body.forecastUnavailableSymbols).toEqual(["SUSDS"]);
  });

  it("returns null forecasts when both rate feeds fail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(RESERVE_WITH_YIELD_COMPONENTS))
      .mockResolvedValueOnce(new Response("fred down", { status: 503 }))
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
      .mockResolvedValueOnce(
        Response.json([{ sky_savings_rate_apy: "0.036" }]),
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
