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
import {
  applyStethYieldLedgerResult,
  fetchStethYieldLedger,
} from "../reserve-yield-steth";

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
    expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(false);
    expect(extracted.trackedAssetCount).toBe(3);
    expect(extracted.susdsAssetCount).toBe(1);
    expect(extracted.hasUnindexedSusdsHolding).toBe(false);
    expect(extracted.holdings).toHaveLength(4);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "sUSDS",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Reserve Safe",
      balance: 2000,
      hasTokenBalance: true,
      principalUsd: 2200,
    });
    expect(extracted.holdings[1]).toMatchObject({
      assetSymbol: "AUSD",
      chain: "ethereum",
      sourceType: "wallet",
      sourceLabel: "Ops Safe",
      balance: 1500,
      hasTokenBalance: true,
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

  it("fails sUSDS coverage when a potentially nonzero raw source is dropped", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "2001",
            usd_value: 2201,
            sources: [
              {
                type: "wallet",
                label: "Tracked Safe",
                identifier: TRACKED_SUSDS_WALLET,
                balance: "2000",
                usd_value: 2200,
              },
              {
                type: "wallet",
                label: "Unpriced Safe",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "unknown",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.malformedCount).toBe(1);
    expect(extracted.hasUnindexedSusdsHolding).toBe(true);
  });

  it("allows a proven-zero extra sUSDS source beside indexed exposure", () => {
    const extracted = extractReserveYieldHoldings({
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
                label: "Tracked Safe",
                identifier: TRACKED_SUSDS_WALLET,
                balance: "2000",
                usd_value: 2200,
              },
              {
                type: "wallet",
                label: "Unused Safe",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "0",
                usd_value: 0,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.hasUnindexedSusdsHolding).toBe(false);
  });

  it("fails sUSDS coverage before duplicate unindexed sources aggregate to zero", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "0",
            usd_value: 0,
            sources: [
              {
                type: "wallet",
                label: "Unindexed Safe",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "1",
                usd_value: 1,
              },
              {
                type: "wallet",
                label: "Unindexed Safe",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "-1",
                usd_value: -1,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      balance: 0,
      principalUsd: 0,
    });
    expect(extracted.hasUnindexedSusdsHolding).toBe(true);
  });

  it("fails sUSDS coverage when a positive asset has only zero sources", () => {
    const positiveAsset = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "1",
            usd_value: 1,
            sources: [{ balance: "0", usd_value: 0 }],
          },
        ],
      },
    });
    const zeroAsset = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "0",
            usd_value: 0,
            sources: [{ balance: "0", usd_value: 0 }],
          },
        ],
      },
    });

    expect(positiveAsset.hasUnindexedSusdsHolding).toBe(true);
    expect(zeroAsset.hasUnindexedSusdsHolding).toBe(false);
  });

  it("does not let an indexed zero holding hide a positive sUSDS asset", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "1",
            usd_value: 1,
            sources: [
              {
                identifier: TRACKED_SUSDS_WALLET,
                balance: "0",
                usd_value: "unknown",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      identifier: TRACKED_SUSDS_WALLET,
      balance: 0,
      principalUsd: 0,
    });
    expect(extracted.hasUnindexedSusdsHolding).toBe(true);
  });

  it("does not use malformed stETH sources as sUSDS coverage evidence", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          RESERVE_PAYLOAD.collateral.assets[1],
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "1",
            usd_value: 2_000,
            sources: [{ balance: "unknown", usd_value: "unknown" }],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBeGreaterThan(0);
    expect(extracted.hasUnindexedSusdsHolding).toBe(false);
  });

  it.each([
    {},
    { collateral: {} },
    { collateral: { assets: null } },
    { collateral: { assets: {} } },
  ])(
    "fails holdings classification for a malformed reserve shape",
    (payload) => {
      const extracted = extractReserveYieldHoldings(payload);

      expect(extracted.holdings).toEqual([]);
      expect(extracted.malformedCount).toBe(0);
      expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(true);
    },
  );

  it("fails current holdings classification for unclassifiable asset rows", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: { assets: [null, {}, { symbol: 123 }] },
    });

    expect(extracted.holdings).toEqual([]);
    expect(extracted.malformedCount).toBe(3);
    expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(true);
  });

  it("accepts an empty sources array for a tracked asset", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "100",
            usd_value: 110,
            sources: [],
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.malformedCount).toBe(0);
    expect(extracted.susdsAssetCount).toBe(1);
  });

  it.each([
    ["object", {}],
    ["null", null],
  ])("marks a provided %s sources value as malformed", (_label, sources) => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "100",
            usd_value: 110,
            sources,
          },
        ],
      },
    });

    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.malformedCount).toBe(1);
    expect(extracted.susdsAssetCount).toBe(1);
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
      hasTokenBalance: true,
      principalUsd: 252_000,
    });
    expect(extracted.holdings[1]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Reserve Safe",
      balance: 100,
      hasTokenBalance: true,
      principalUsd: 168_000,
    });
  });

  it("preserves incomplete stETH source coverage without rejecting explicit-zero extras", () => {
    const asset = {
      symbol: "stETH",
      chain: "ethereum",
      balance: "2",
      usd_value: 4_000,
      sources: [
        {
          type: "wallet",
          label: "Reserve Safe",
          identifier: TRACKED_SUSDS_WALLET,
          balance: "1",
          usd_value: 2_000,
        },
      ],
    };
    const incomplete = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            ...asset,
            sources: [
              ...asset.sources,
              {
                type: "wallet",
                label: "Unpriced source",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "unknown",
                usd_value: "unknown",
              },
            ],
          },
        ],
      },
    });
    const explicitZeroExtra = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            ...asset,
            sources: [
              ...asset.sources,
              {
                type: "wallet",
                label: "Zero source",
                identifier: "0x0000000000000000000000000000000000000001",
                balance: "0",
                usd_value: 0,
              },
            ],
          },
        ],
      },
    });

    expect(incomplete.holdings).toHaveLength(1);
    expect(incomplete.stethSnapshotSourceRequired).toBe(true);
    expect(incomplete.hasIncompleteStethSourceCoverage).toBe(true);
    expect(explicitZeroExtra.hasIncompleteStethSourceCoverage).toBe(false);
  });

  it("derives stETH source token balances from asset totals", () => {
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
                label: "Partial Reserve Safe",
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                usd_value: 168_000,
                custodian_type: "cold",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Partial Reserve Safe",
      hasTokenBalance: true,
      principalUsd: 168_000,
    });
    expect(extracted.holdings[0]?.balance).toBeCloseTo(100, 12);
  });

  it("derives stETH balances after balance-only sources consume asset principal", () => {
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
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                balance: "100",
                custodian_type: "cold",
              },
              {
                type: "wallet",
                label: "Custodian",
                identifier: "0x0000000000000000000000000000000000000001",
                usd_value: 252_000,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(2);
    const reserveSafe = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Reserve Safe",
    );
    const custodian = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Custodian",
    );
    expect(reserveSafe).toMatchObject({
      sourceLabel: "Reserve Safe",
      balance: 100,
      hasTokenBalance: true,
      principalUsd: 168_000,
    });
    expect(custodian).toMatchObject({
      sourceLabel: "Custodian",
      hasTokenBalance: true,
      principalUsd: 252_000,
    });
    expect(custodian?.balance).toBeCloseTo(150, 12);
  });

  it("does not derive stETH token balances from zero asset balances", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "0",
            usd_value: 420_000,
            sources: [
              {
                type: "wallet",
                label: "Reserve Safe",
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                usd_value: 420_000,
                custodian_type: "cold",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Reserve Safe",
      balance: 420_000,
      hasTokenBalance: false,
      principalUsd: 420_000,
    });
  });

  it("caps derived stETH source balances to the asset token total", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "100",
            usd_value: 100_000,
            sources: [
              {
                type: "wallet",
                label: "Reserve Safe",
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                usd_value: 80_000,
              },
              {
                type: "wallet",
                label: "Custodian",
                identifier: "0x0000000000000000000000000000000000000001",
                usd_value: 80_000,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(2);
    const reserveSafe = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Reserve Safe",
    );
    const custodian = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Custodian",
    );
    expect(reserveSafe).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Reserve Safe",
      hasTokenBalance: true,
      principalUsd: 50_000,
    });
    expect(custodian).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Custodian",
      hasTokenBalance: true,
      principalUsd: 50_000,
    });
    expect(reserveSafe?.balance).toBeCloseTo(50, 12);
    expect(custodian?.balance).toBeCloseTo(50, 12);
  });

  it("scales balance-derived stETH principals when sources exceed asset USD", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            balance: "100",
            usd_value: 100_000,
            sources: [
              {
                type: "wallet",
                label: "Reserve Safe",
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                balance: "50",
              },
              {
                type: "wallet",
                label: "Custodian",
                identifier: "0x0000000000000000000000000000000000000001",
                usd_value: 90_000,
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(2);
    const reserveSafe = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Reserve Safe",
    );
    const custodian = extracted.holdings.find(
      (holding) => holding.sourceLabel === "Custodian",
    );
    expect(reserveSafe).toMatchObject({
      sourceLabel: "Reserve Safe",
      balance: 50,
      hasTokenBalance: true,
    });
    expect(reserveSafe?.principalUsd).toBeCloseTo(35_714.285714, 6);
    expect(custodian).toMatchObject({
      sourceLabel: "Custodian",
      hasTokenBalance: true,
    });
    expect(custodian?.balance).toBeCloseTo(50, 12);
    expect(custodian?.principalUsd).toBeCloseTo(64_285.714286, 6);
  });

  it("tracks when stETH rows use USD fallback instead of token balances", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "stETH",
            chain: "ethereum",
            usd_value: 420_000,
            sources: [
              {
                type: "wallet",
                label: "Partial Reserve Safe",
                identifier: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
                usd_value: 168_000,
                custodian_type: "cold",
              },
            ],
          },
        ],
      },
    });

    expect(extracted.malformedCount).toBe(0);
    expect(extracted.holdings).toHaveLength(1);
    expect(extracted.holdings[0]).toMatchObject({
      assetSymbol: "stETH",
      sourceLabel: "Partial Reserve Safe",
      balance: 168_000,
      hasTokenBalance: false,
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
    expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(false);
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
    expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(false);
    expect(extracted.susdsSnapshotSourceRequired).toBe(true);
    expect(extracted.hasUnindexedSusdsHolding).toBe(true);
  });

  it("does not require an sUSDS snapshot source for explicit zero exposure", () => {
    const extracted = extractReserveYieldHoldings({
      collateral: {
        assets: [
          {
            symbol: "sUSDS",
            chain: "ethereum",
            balance: "0",
            usd_value: 0,
            sources: [],
          },
        ],
      },
    });

    expect(extracted.reserveCurrentHoldingsClassificationFailed).toBe(false);
    expect(extracted.susdsSnapshotSourceRequired).toBe(false);
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
    expect(extracted.malformedCount).toBe(0);
    expect(extracted.susdsSnapshotSourceRequired).toBe(true);
    expect(extracted.hasUnindexedSusdsHolding).toBe(true);
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

  it("does not join Ethereum stETH actuals to the same tracked wallet on Polygon", () => {
    const wallet = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
    const holding = {
      id: "polygon-steth-reserve-safe",
      assetSymbol: "stETH",
      chain: "polygon",
      sourceType: "wallet",
      sourceLabel: "Reserve Safe",
      identifier: wallet,
      custodianType: "cold",
      balance: 1,
      hasTokenBalance: true,
      principalUsd: 2_000,
      earnedYieldUsd: null,
      apyPercent: null,
      yieldModel: "Yield source pending",
      dailyRunRateUsd: null,
      next30dUsd: null,
      next365dUsd: null,
      annualRunRateUsd: null,
    };

    const result = applyStethYieldLedgerResult(
      [holding],
      {
        status: "fulfilled",
        value: {
          entries: [
            {
              wallet,
              earnedYieldAmount: BigInt("1000000000000000000"),
              realizedYieldAmount: BigInt(0),
              unrealizedYieldAmount: BigInt("1000000000000000000"),
              asOf: "2026-06-12T00:00:00.000Z",
            },
          ],
          error: null,
        },
      },
      true,
      true,
    );

    expect(result.earnedYieldUsd).toBeNull();
    expect(result.holdings[0]?.earnedYieldUsd).toBeNull();
    expect(result.earnedYieldError).toContain("indexed only for Ethereum");
  });

  it.each([
    ["another chain", { chainId: 137 }],
    ["another token", { token: "0x0000000000000000000000000000000000000001" }],
    [
      "an untracked wallet",
      { wallet: "0x0000000000000000000000000000000000000002" },
    ],
  ])("does not accept stETH ledger rows for %s", async (_label, overrides) => {
    vi.stubEnv("NEXT_PUBLIC_HASURA_URL", "https://hasura.example/v1/graphql");
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          StethYieldDailySnapshot: [
            {
              id: "1-steth-wallet-1780444800",
              chainId: 1,
              token: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
              wallet: "0xd0697f70e79476195b742d5afab14be50f98cc1e",
              timestamp: "1780444800",
              realizedYieldAmount: "0",
              unrealizedYieldAmount: "1",
              totalEarnedYieldAmount: "1",
              sampledAtTimestamp: "1780444800",
              ...overrides,
            },
          ],
        },
      }),
    );

    try {
      await expect(fetchStethYieldLedger(fetchImpl)).resolves.toEqual({
        entries: [],
        error:
          "stETH earned-yield actuals pending: no indexed wallet snapshot rows yet.",
      });
    } finally {
      vi.unstubAllEnvs();
    }
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
