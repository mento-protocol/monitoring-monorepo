import { describe, it, expect, vi, afterEach } from "vitest";
import { buildDailyFeeSeries } from "../revenue";
import type { OracleRateMap } from "../tokens";
import type { ProtocolFeeTransfer } from "../types";
import type { NetworkData } from "@/hooks/use-all-networks-data";

const SECONDS_PER_DAY = 86_400;

const TEST_RATES: OracleRateMap = new Map([
  ["GBPm", 1.3263],
  ["EURm", 1.1455],
]);

/** Anchor all test timestamps relative to "now" so gap-fill doesn't explode. */
const NOW_S = Math.floor(Date.now() / 1000);
const TODAY_BUCKET = Math.floor(NOW_S / SECONDS_PER_DAY) * SECONDS_PER_DAY;

/** Helper to build a transfer with sensible defaults. */
function transfer(
  overrides: Partial<ProtocolFeeTransfer> = {},
): ProtocolFeeTransfer {
  return {
    chainId: 42220,
    tokenSymbol: "USDm",
    tokenDecimals: 18,
    amount: "1000000000000000000", // 1e18 = 1 token
    blockTimestamp: String(NOW_S - 3600), // 1h ago by default
    ...overrides,
  };
}

/** Minimal NetworkData stub for testing. */
function networkData(
  feeTransfers: ProtocolFeeTransfer[],
  overrides: Partial<NetworkData> = {},
): NetworkData {
  return {
    network: {
      id: "celo-mainnet",
      chainId: 42220,
      label: "Celo",
    } as NetworkData["network"],
    snapshotWindows: {
      w24h: { from: 0, to: 0 },
      w7d: { from: 0, to: 0 },
      w30d: { from: 0, to: 0 },
    },
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    snapshotsAll: [],
    snapshotsAllTruncated: false,
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    fees: null,
    feeTransfers,
    uniqueLpAddresses: null,
    rates: TEST_RATES,
    error: null,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllError: null,
    snapshotsAllDailyError: null,
    lpError: null,
    ...overrides,
  };
}

describe("buildDailyFeeSeries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array for empty input", () => {
    const result = buildDailyFeeSeries([networkData([])]);
    expect(result).toEqual([]);
  });

  it("returns empty array when all networks errored", () => {
    const result = buildDailyFeeSeries([
      networkData([transfer()], { error: new Error("boom") }),
    ]);
    expect(result).toEqual([]);
  });

  it("buckets a single transfer into one day", () => {
    const ts = NOW_S - 3600; // 1h ago
    const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const window = { from: bucket, to: NOW_S + 1 };
    const result = buildDailyFeeSeries(
      [networkData([transfer({ blockTimestamp: String(ts) })])],
      window,
    );
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(bucket);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2); // 1 USDm = $1
    expect(result[0].lpFeesUSD).toBe(0);
  });

  it("buckets multiple transfers on the same day", () => {
    const dayStart = TODAY_BUCKET;
    const window = { from: dayStart, to: dayStart + SECONDS_PER_DAY + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          transfer({ blockTimestamp: String(dayStart + 100) }), // 1 USDm
          transfer({ blockTimestamp: String(dayStart + 200) }), // 1 USDm
          transfer({
            blockTimestamp: String(dayStart + 300),
            amount: "3000000000000000000", // 3 USDm
          }),
        ]),
      ],
      window,
    );
    // All three transfers land in the same bucket
    const totalFees = result.reduce((s, p) => s + p.protocolFeesUSD, 0);
    expect(totalFees).toBeCloseTo(5, 2);
    expect(result[0].protocolFeesUSD).toBeCloseTo(5, 2);
  });

  it("gap-fills missing days with zeros", () => {
    const day0 = TODAY_BUCKET - 3 * SECONDS_PER_DAY;
    const day3 = TODAY_BUCKET;
    const window = { from: day0, to: day3 + SECONDS_PER_DAY + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          transfer({ blockTimestamp: String(day0 + 100) }),
          transfer({ blockTimestamp: String(day3 + 100) }),
        ]),
      ],
      window,
    );
    // At minimum: days 0, 1, 2, 3 (possibly +1 trailing empty bucket)
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2);
    expect(result[1].protocolFeesUSD).toBe(0);
    expect(result[2].protocolFeesUSD).toBe(0);
    expect(result[3].protocolFeesUSD).toBeCloseTo(1, 2);
    const totalFees = result.reduce((s, p) => s + p.protocolFeesUSD, 0);
    expect(totalFees).toBeCloseTo(2, 2);
  });

  it("applies FX rate for non-USD tokens", () => {
    const ts = NOW_S - 3600;
    const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const window = { from: bucket, to: NOW_S + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          transfer({ blockTimestamp: String(ts), tokenSymbol: "GBPm" }),
        ]),
      ],
      window,
    );
    expect(result).toHaveLength(1);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1.3263, 2);
  });

  it("skips UNKNOWN tokens", () => {
    const ts = NOW_S - 3600;
    const result = buildDailyFeeSeries([
      networkData([
        transfer({ blockTimestamp: String(ts), tokenSymbol: "UNKNOWN" }),
      ]),
    ]);
    expect(result).toEqual([]);
  });

  it("skips unpriced tokens", () => {
    const ts = NOW_S - 3600;
    const result = buildDailyFeeSeries([
      networkData([
        transfer({ blockTimestamp: String(ts), tokenSymbol: "NEWTOK" }),
      ]),
    ]);
    expect(result).toEqual([]);
  });

  it("aggregates across multiple networks", () => {
    const ts = NOW_S - 3600;
    const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const window = { from: bucket, to: NOW_S + 1 };
    const net1 = networkData([transfer({ blockTimestamp: String(ts) })]);
    const net2 = networkData([transfer({ blockTimestamp: String(ts) })], {
      network: {
        id: "monad-mainnet",
        chainId: 143,
        label: "Monad",
      } as NetworkData["network"],
    });
    const result = buildDailyFeeSeries([net1, net2], window);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(bucket);
    expect(result[0].protocolFeesUSD).toBeCloseTo(2, 2);
  });

  it("skips networks with top-level errors", () => {
    const ts = NOW_S - 3600;
    const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const window = { from: bucket, to: NOW_S + 1 };
    const net1 = networkData([transfer({ blockTimestamp: String(ts) })]);
    const net2 = networkData(
      [
        transfer({
          blockTimestamp: String(ts),
          amount: "5000000000000000000",
        }),
      ],
      { error: new Error("net2 failed") },
    );
    const result = buildDailyFeeSeries([net1, net2], window);
    expect(result).toHaveLength(1);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2);
  });

  it("respects window filter — excludes out-of-range transfers", () => {
    const day5ago = TODAY_BUCKET - 5 * SECONDS_PER_DAY;
    const day2ago = TODAY_BUCKET - 2 * SECONDS_PER_DAY;
    const window = { from: day2ago, to: NOW_S + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          transfer({ blockTimestamp: String(day5ago + 100) }), // outside window
          transfer({ blockTimestamp: String(day2ago + 100) }), // inside window
          transfer({ blockTimestamp: String(TODAY_BUCKET + 100) }), // inside window
        ]),
      ],
      window,
    );
    const totalFees = result.reduce((s, p) => s + p.protocolFeesUSD, 0);
    expect(totalFees).toBeCloseTo(2, 2); // only 2 in-window transfers
  });

  it("handles 6-decimal tokens correctly", () => {
    const ts = NOW_S - 3600;
    const bucket = Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const window = { from: bucket, to: NOW_S + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          transfer({
            blockTimestamp: String(ts),
            tokenSymbol: "USDC",
            tokenDecimals: 6,
            amount: "2500000", // 2.5 USDC
          }),
        ]),
      ],
      window,
    );
    expect(result).toHaveLength(1);
    expect(result[0].protocolFeesUSD).toBeCloseTo(2.5, 4);
  });
});
