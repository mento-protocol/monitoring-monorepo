import { describe, expect, it } from "vitest";
import { extractReserveYieldHoldings } from "../reserve-yield";

const TRACKED_WALLET = "0xd0697f70e79476195b742d5afab14be50f98cc1e";
const SECOND_TRACKED_WALLET = "0xd3d2e5c5af667da817b2d752d86c8f40c22137e1";

const TRACKED_ASSETS = [
  { symbol: "sUSDS", coverageFlag: "hasUnindexedSusdsHolding" },
  { symbol: "stETH", coverageFlag: "hasIncompleteStethSourceCoverage" },
] as const;

function extractTrackedAsset({
  symbol,
  aggregateBalance,
  aggregateUsd,
  sourceBalance = 1,
  sourceUsd = 1,
}: {
  symbol: (typeof TRACKED_ASSETS)[number]["symbol"];
  aggregateBalance: unknown;
  aggregateUsd: unknown;
  sourceBalance?: number;
  sourceUsd?: number;
}) {
  return extractReserveYieldHoldings({
    collateral: {
      assets: [
        {
          symbol,
          chain: "ethereum",
          balance: aggregateBalance,
          usd_value: aggregateUsd,
          sources: [
            {
              type: "wallet",
              label: "Reserve Safe",
              identifier: TRACKED_WALLET,
              balance: String(sourceBalance),
              usd_value: sourceUsd,
            },
          ],
        },
      ],
    },
  });
}

describe.each(TRACKED_ASSETS)(
  "$symbol aggregate source coverage",
  ({ symbol, coverageFlag }) => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["empty string", ""],
    ])("leaves %s aggregate fields unchecked", (_label, aggregateValue) => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: aggregateValue,
        aggregateUsd: aggregateValue,
      });

      expect(extracted.malformedCount).toBe(0);
      expect(extracted[coverageFlag]).toBe(false);
    });

    it.each([
      ["non-finite", Number.POSITIVE_INFINITY],
      ["negative", -1],
    ])("fails closed on a present %s aggregate", (_label, aggregateValue) => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: aggregateValue,
        aggregateUsd: aggregateValue,
      });

      expect(extracted.malformedCount).toBe(0);
      expect(extracted[coverageFlag]).toBe(true);
    });

    it("fails closed when zero aggregates have positive indexed sources", () => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: 0,
        aggregateUsd: 0,
      });

      expect(extracted.malformedCount).toBe(0);
      expect(extracted[coverageFlag]).toBe(true);
    });

    it("fails closed when a normalized source balance exceeds its aggregate", () => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: 100,
        aggregateUsd: 100,
        sourceBalance: 200,
        sourceUsd: 100,
      });

      expect(extracted.malformedCount).toBe(0);
      expect(extracted[coverageFlag]).toBe(true);
    });

    it("fails closed on a negative normalized source total within tolerance", () => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: 0,
        aggregateUsd: 0,
        sourceBalance: -Number.EPSILON,
        sourceUsd: -Number.EPSILON,
      });

      expect(extracted.malformedCount).toBe(0);
      expect(extracted[coverageFlag]).toBe(true);
    });

    it.each([
      [
        "token balance",
        [
          { balance: "2", usd_value: 0.5 },
          { balance: "-1", usd_value: 0.5 },
        ],
      ],
      [
        "principal USD",
        [
          { balance: "0.5", usd_value: 1 },
          { balance: "0.5", usd_value: -Number.EPSILON },
        ],
      ],
    ])(
      "fails closed when a negative indexed source %s is masked by a positive source",
      (_label, sources) => {
        const extracted = extractReserveYieldHoldings({
          collateral: {
            assets: [
              {
                symbol,
                chain: "ethereum",
                balance: 1,
                usd_value: 1,
                sources: sources.map((source, index) => ({
                  type: "wallet",
                  label: `Reserve Safe ${index + 1}`,
                  identifier:
                    index === 0 ? TRACKED_WALLET : SECOND_TRACKED_WALLET,
                  ...source,
                })),
              },
            ],
          },
        });

        expect(extracted.malformedCount).toBe(0);
        expect(extracted[coverageFlag]).toBe(true);
      },
    );

    it("accepts raw source USD overage after normalization to the asset budget", () => {
      const extracted = extractTrackedAsset({
        symbol,
        aggregateBalance: 100,
        aggregateUsd: 100_000,
        sourceBalance: 100,
        sourceUsd: 120_000,
      });

      expect(extracted.holdings).toHaveLength(1);
      expect(extracted.holdings[0]).toMatchObject({
        balance: 100,
        principalUsd: 100_000,
      });
      expect(extracted[coverageFlag]).toBe(false);
    });
  },
);
