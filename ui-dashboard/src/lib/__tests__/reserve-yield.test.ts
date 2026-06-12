import { describe, expect, it, vi } from "vitest";
import {
  computeNetMentoApyPercent,
  computeSkySavingsRateApyPercentFromSsr,
  extractReserveYieldHoldings,
  fetchReserveYieldSnapshot,
  parseFredFedFundsCsv,
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
});
