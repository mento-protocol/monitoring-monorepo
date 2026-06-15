import { describe, expect, it, vi } from "vitest";
import {
  computeNetMentoApyPercent,
  computeSkySavingsRateApyPercentFromSsr,
  extractReserveYieldHoldings,
  fetchReserveYieldSnapshot,
  parseFredFedFundsCsv,
  parseLidoStethAprPercent,
  parseSkySavingsRateApyPercent,
  parseSkySavingsRateSsrApyPercent,
} from "../reserve-yield";

const SKY_SSR_RAY = BigInt("1000000001121484774769253326");
const SKY_SSR_RPC_RESULT =
  "0x0000000000000000000000000000000000000000033b2e3caf60d0b2dd215bce";
const SKY_SSR_APY_PERCENT = 3.600000425292;
const TRACKED_SUSDS_WALLET = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
const SKY_SSR_RPC_RESPONSE = {
  jsonrpc: "2.0",
  id: 1,
  result: SKY_SSR_RPC_RESULT,
};
const LIDO_STETH_APR_RESPONSE = {
  data: { apr: 2.95 },
  meta: {
    symbol: "stETH",
    address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    chainId: 1,
  },
};

const RESERVE_PAYLOAD = {
  collateral: {
    assets: [
      {
        symbol: "USDC",
        chain: "celo",
        balance: "100",
        usd_value: 100,
        sources: [],
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
            identifier: TRACKED_SUSDS_WALLET,
            balance: "2000",
            usd_value: 2200,
            custodian_type: "cold",
          },
        ],
      },
      {
        symbol: "AUSD",
        chain: "ethereum",
        balance: "1500",
        usd_value: 1500,
        sources: [
          {
            type: "wallet",
            label: "Ops Safe",
            identifier: "0xops",
            balance: "1000",
            usd_value: 1000,
            custodian_type: "ops",
          },
          {
            type: "wallet",
            label: "Ops Safe",
            identifier: "0xops",
            balance: "500",
            usd_value: "500",
            custodian_type: "ops",
          },
        ],
      },
      {
        symbol: "AUSD",
        chain: "monad",
        balance: "1000",
        usd_value: 1000,
        sources: [
          {
            type: "wallet",
            label: "Mento V3 Liquidity Reserve",
            identifier: "0xreserve",
            balance: "800",
            usd_value: 800,
            custodian_type: "hot",
          },
          {
            type: "fpmm",
            label: "FPMM AUSD / USDm",
            identifier: "0xfpmm",
            balance: "200",
            usd_value: 200,
            custodian_type: "ops",
          },
        ],
      },
    ],
  },
};

describe("reserve yield parsing and math", () => {
  it("extracts yield-bearing source holdings and aggregates duplicate sources", () => {
    const extracted = extractReserveYieldHoldings(RESERVE_PAYLOAD);

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.trackedAssetCount).toBe(3);
    expect(extracted.susdsAssetCount).toBe(1);
    expect(extracted.holdings).toHaveLength(4);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Reserve Safe",
      balance: 2000,
      principalUsd: 2200,
    });
    expect(extracted.holdings[1]).toMatchObject({
      assetSymbol: "AUSD",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Ops Safe",
      balance: 1500,
      principalUsd: 1500,
    });
    expect(
      extracted.holdings.reduce(
        (sum, holding) => sum + holding.principalUsd,
        0,
      ),
    ).toBe(4700);
  });

  it("prices sUSDS sources from source USD value or allocated asset USD value", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "100",
            usd_value: 112,
            sources: [
              {
                type: "wallet",
                label: "Tracked Safe",
                identifier: TRACKED_SUSDS_WALLET,
                balance: "25",
                usd_value: 28,
              },
              {
                type: "wallet",
                label: "Secondary Safe",
                identifier: "0xsecondary",
                balance: "75",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(2);
    expect(extracted.holdings[0]).toMatchObject({
      sourceLabel: "Secondary Safe",
      balance: 75,
      principalUsd: 84,
    });
    expect(extracted.holdings[1]).toMatchObject({
      sourceLabel: "Tracked Safe",
      balance: 25,
      principalUsd: 28,
    });
  });

  it("prices stETH sources from USD values instead of token balances", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "250",
            usd_value: 420_000,
            sources: [
              {
                type: "wallet",
                label: "Reserve Safe",
                identifier: "0xreserve",
                balance: "100",
                custodian_type: "cold",
              },
              {
                type: "wallet",
                label: "Custodian",
                identifier: "0xcustodian",
                balance: "150",
                usd_value: 252_000,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(2);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Custodian",
      balance: 150,
      principalUsd: 252_000,
    });
    expect(extracted.holdings[1]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Reserve Safe",
      balance: 100,
      principalUsd: 168_000,
    });
  });

  it("does not treat stETH token balances as dollars when USD values are missing", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "250",
            sources: [
              {
                type: "wallet",
                label: "Reserve Safe",
                balance: "250",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.holdings).toEqual([]);
    expect(extracted.malformedCount).toBe(2);
  });

  it("does not treat sUSDS source shares as dollars when USD values are missing", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "100",
            sources: [
              {
                type: "wallet",
                label: "Unpriced Safe",
                identifier: TRACKED_SUSDS_WALLET,
                balance: "100",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.holdings).toEqual([]);
    expect(extracted.malformedCount).toBe(2);
  });

  it("uses the yield-bearing asset row when no source rows are available", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "42",
            usd_value: 42,
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      chain: "ethereum",
      sourceType: "asset",
      principalUsd: 42,
    });
  });

  it("parses the latest valid FEDFUNDS CSV observation", () => {
    expect(
      parseFredFedFundsCsv(
        [
          "observation_date,FEDFUNDS",
          "2026-04-01,3.64",
          "2026-05-01,3.63",
          "2026-06-01,.",
        ].join("\n"),
      ),
    ).toEqual({ date: "2026-05-01", grossApyPercent: 3.63 });
  });

  it("parses Sky Savings Rate APY from the Sky overall feed", () => {
    expect(
      parseSkySavingsRateApyPercent([
        { total_save: "100" },
        { sky_savings_rate_apy: "0.036000000000000000" },
      ]),
    ).toBeCloseTo(3.6, 12);
  });

  it("rejects Sky Savings Rate values that are already percentages", () => {
    expect(() =>
      parseSkySavingsRateApyPercent({ sky_savings_rate_apy: "3.6" }),
    ).toThrow("expected a decimal fraction");
  });

  it("computes Sky Savings Rate APY from on-chain sUSDS ssr()", () => {
    expect(computeSkySavingsRateApyPercentFromSsr(SKY_SSR_RAY)).toBeCloseTo(
      SKY_SSR_APY_PERCENT,
      12,
    );
    expect(parseSkySavingsRateSsrApyPercent(SKY_SSR_RPC_RESPONSE)).toBeCloseTo(
      SKY_SSR_APY_PERCENT,
      12,
    );
  });

  it("rejects malformed sUSDS ssr() RPC responses", () => {
    expect(() =>
      parseSkySavingsRateSsrApyPercent({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "execution reverted" },
      }),
    ).toThrow("RPC -32000");
    expect(() => parseSkySavingsRateSsrApyPercent({ result: "0x" })).toThrow(
      "uint256 result",
    );
  });

  it("parses Lido stETH APR only for Ethereum stETH metadata", () => {
    expect(parseLidoStethAprPercent(LIDO_STETH_APR_RESPONSE)).toBe(2.95);
    expect(() =>
      parseLidoStethAprPercent({
        data: { apr: 2.95 },
        meta: {
          symbol: "wstETH",
          address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
          chainId: 1,
        },
      }),
    ).toThrow("symbol");
    expect(() =>
      parseLidoStethAprPercent({
        data: { apr: -1 },
        meta: LIDO_STETH_APR_RESPONSE.meta,
      }),
    ).toThrow("valid APR");
  });

  it("applies the provider APY formula", () => {
    expect(computeNetMentoApyPercent(5.33)).toBeCloseTo(4.144, 6);
  });

  it("builds non-compounding reserve-yield run rates", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(RESERVE_PAYLOAD))
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE));

    const snapshot = await fetchReserveYieldSnapshot({
      fetchImpl,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(snapshot.principalUsd).toBe(4700);
    expect(snapshot.forecastPrincipalUsd).toBe(4700);
    expect(snapshot.earnedYieldUsd).toBeNull();
    expect(snapshot.holdingsAsOf).toBe("2026-06-11T12:00:00.000Z");
    expect(snapshot.grossApyPercent).toBe(5.33);
    expect(snapshot.netMentoApyPercent).toBeCloseTo(4.144, 6);
    expect(snapshot.skySavingsRateApyPercent).toBeCloseTo(
      SKY_SSR_APY_PERCENT,
      12,
    );
    expect(snapshot.skySavingsRateSource).toBe("onchain-susds-ssr");
    expect(snapshot.annualRunRateUsd).toBeCloseTo(182.800009, 6);
    expect(snapshot.next30dUsd).toBeCloseTo(15.024658, 6);
    expect(snapshot.next365dUsd).toBeCloseTo(182.800009, 6);
    expect(snapshot.dailyRunRateUsd).toBeCloseTo(0.500822, 6);
    expect(snapshot.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      earnedYieldUsd: null,
    });
    expect(snapshot.holdings[0]?.apyPercent).toBeCloseTo(
      SKY_SSR_APY_PERCENT,
      12,
    );
    expect(snapshot.holdings[0]?.next365dUsd).toBeCloseTo(79.200009, 6);
    expect(snapshot.holdings[1]?.annualRunRateUsd).toBeCloseTo(62.16, 6);
    expect(snapshot.forecastUnavailableSymbols).toEqual([]);
  });

  it("includes stETH Lido APR forecasts without earned-yield actuals", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          collateral: {
            assets: [
              ...RESERVE_PAYLOAD.collateral.assets,
              {
                symbol: "stETH",
                chain: "ethereum",
                balance: "251.59825779325257",
                usd_value: 419_495.97,
                sources: [
                  {
                    type: "wallet",
                    label: "Reserve Safe",
                    identifier: "0xd0697f70E79476195B742d5aFAb14BE50f98CC1E",
                    balance: "251.59825779325257",
                    usd_value: 419_495.97,
                    custodian_type: "cold",
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
      .mockResolvedValueOnce(Response.json(LIDO_STETH_APR_RESPONSE));

    const snapshot = await fetchReserveYieldSnapshot({
      fetchImpl,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });
    const stethHolding = snapshot.holdings.find(
      (holding) => holding.assetSymbol === "stETH",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(snapshot.principalUsd).toBeCloseTo(424_195.97, 6);
    expect(snapshot.forecastPrincipalUsd).toBeCloseTo(424_195.97, 6);
    expect(snapshot.earnedYieldUsd).toBeNull();
    expect(snapshot.annualRunRateUsd).toBeCloseTo(12_557.931124, 6);
    expect(snapshot.next30dUsd).toBeCloseTo(1_032.158723, 6);
    expect(snapshot.forecastUnavailableSymbols).toEqual([]);
    expect(stethHolding).toMatchObject({
      assetSymbol: "stETH",
      chain: "ethereum",
      sourceLabel: "Reserve Safe",
      principalUsd: 419_495.97,
      earnedYieldUsd: null,
      apyPercent: 2.95,
      yieldModel:
        "Lido stETH APR forecast; stETH mark-to-market changes are not counted as earned revenue",
    });
    expect(stethHolding?.next365dUsd).toBeCloseTo(12_375.131115, 6);
  });

  it("keeps stETH balances while excluding forecasts when Lido APR is unavailable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          collateral: {
            assets: [
              {
                symbol: "stETH",
                chain: "ethereum",
                balance: "10",
                usd_value: 17_000,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("observation_date,FEDFUNDS\n2026-05-01,5.33\n"),
      )
      .mockResolvedValueOnce(Response.json(SKY_SSR_RPC_RESPONSE))
      .mockResolvedValueOnce(new Response("lido down", { status: 503 }));

    const snapshot = await fetchReserveYieldSnapshot({ fetchImpl });

    expect(snapshot.principalUsd).toBe(17_000);
    expect(snapshot.forecastPrincipalUsd).toBeNull();
    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.holdings[0]).toMatchObject({
      assetSymbol: "stETH",
      principalUsd: 17_000,
      earnedYieldUsd: null,
      apyPercent: null,
      next30dUsd: null,
    });
    expect(snapshot.rateError).toContain("Lido stETH APR");
    expect(snapshot.forecastUnavailableSymbols).toEqual(["STETH"]);
  });
});
