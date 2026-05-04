import { describe, it, expect, vi, afterEach } from "vitest";
import { buildDailyFeeSeries } from "../revenue";
import type { OracleRateMap } from "../tokens";
import type { PoolDailyFeeSnapshot } from "../types";
import type { NetworkData } from "@/hooks/use-all-networks-data";

const SECONDS_PER_DAY = 86_400;

const TEST_RATES: OracleRateMap = new Map([
  ["GBPm", 1.3263],
  ["EURm", 1.1455],
]);

/** Anchor all test timestamps relative to "now" so gap-fill doesn't explode. */
const NOW_S = Math.floor(Date.now() / 1000);
const TODAY_BUCKET = Math.floor(NOW_S / SECONDS_PER_DAY) * SECONDS_PER_DAY;
const POOL_ADDR = "0xaaaa000000000000000000000000000000000001";

function feeSnapshot(
  overrides: Partial<PoolDailyFeeSnapshot> = {},
): PoolDailyFeeSnapshot {
  const dayTs = overrides.timestamp ?? String(TODAY_BUCKET);
  const poolAddress = overrides.poolAddress ?? POOL_ADDR;
  return {
    id: `42220-${poolAddress}-${dayTs}`,
    chainId: 42220,
    poolAddress,
    timestamp: dayTs,
    tokens: ["0xusd"],
    tokenSymbols: ["USDm"],
    tokenDecimals: [18],
    amounts: ["1000000000000000000"], // 1 USDm
    feesUsdWei: "1000000000000000000", // 1 USD
    ...overrides,
  };
}

/** Minimal NetworkData stub for testing. */
function networkData(
  feeSnapshots: PoolDailyFeeSnapshot[],
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
    snapshotsAllDaily: [],
    snapshotsAllDailyTruncated: false,
    brokerSnapshotsAllDaily: [],
    brokerSnapshotsAllDailyTruncated: false,
    tradingLimits: [],
    olsPoolIds: new Set(),
    cdpPoolIds: new Set(),
    reservePoolIds: new Set(),
    fees: null,
    feeSnapshots,
    feeSnapshotsError: null,
    ratesError: null,
    poolLabels: new Map(),
    uniqueLpAddresses: null,
    rates: TEST_RATES,
    error: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    snapshotsAllDailyError: null,
    brokerSnapshotsAllDailyError: null,
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
      networkData([feeSnapshot()], { error: new Error("boom") }),
    ]);
    expect(result).toEqual([]);
  });

  it("buckets a single pegged snapshot into one day", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const result = buildDailyFeeSeries([networkData([feeSnapshot()])], window);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(TODAY_BUCKET);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2); // 1 USDm = $1
    expect(result[0].lpFeesUSD).toBe(0);
  });

  it("sums multiple snapshots in the same day across pools", () => {
    const window = {
      from: TODAY_BUCKET,
      to: TODAY_BUCKET + SECONDS_PER_DAY + 1,
    };
    const result = buildDailyFeeSeries(
      [
        networkData([
          feeSnapshot({
            poolAddress: "0xa1",
            feesUsdWei: "1000000000000000000",
          }),
          feeSnapshot({
            poolAddress: "0xa2",
            feesUsdWei: "2000000000000000000",
          }),
          feeSnapshot({
            poolAddress: "0xa3",
            feesUsdWei: "3000000000000000000",
          }),
        ]),
      ],
      window,
    );
    const total = result.reduce((s, p) => s + p.protocolFeesUSD, 0);
    expect(total).toBeCloseTo(6, 2);
    expect(result[0].protocolFeesUSD).toBeCloseTo(6, 2);
  });

  it("gap-fills missing days with zeros", () => {
    const day0 = TODAY_BUCKET - 3 * SECONDS_PER_DAY;
    const day3 = TODAY_BUCKET;
    const window = { from: day0, to: day3 + SECONDS_PER_DAY + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          feeSnapshot({
            timestamp: String(day0),
            feesUsdWei: "1000000000000000000",
          }),
          feeSnapshot({
            timestamp: String(day3),
            feesUsdWei: "1000000000000000000",
          }),
        ]),
      ],
      window,
    );
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2);
    expect(result[1].protocolFeesUSD).toBe(0);
    expect(result[2].protocolFeesUSD).toBe(0);
    expect(result[3].protocolFeesUSD).toBeCloseTo(1, 2);
    const total = result.reduce((s, p) => s + p.protocolFeesUSD, 0);
    expect(total).toBeCloseTo(2, 2);
  });

  it("prices FX-only snapshot via the rate map", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const result = buildDailyFeeSeries(
      [
        networkData([
          feeSnapshot({
            tokens: ["0xgbp"],
            tokenSymbols: ["GBPm"],
            tokenDecimals: [18],
            amounts: ["1000000000000000000"], // 1 GBPm
            feesUsdWei: "0",
          }),
        ]),
      ],
      window,
    );
    expect(result).toHaveLength(1);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1.3263, 2);
  });

  it("skips UNKNOWN slots silently", () => {
    const result = buildDailyFeeSeries([
      networkData([
        feeSnapshot({
          tokens: ["0x???"],
          tokenSymbols: ["UNKNOWN"],
          tokenDecimals: [18],
          amounts: ["1000000000000000000"],
          feesUsdWei: "0",
        }),
      ]),
    ]);
    expect(result).toEqual([]);
  });

  it("skips unpriced FX (no rate)", () => {
    const result = buildDailyFeeSeries([
      networkData(
        [
          feeSnapshot({
            tokens: ["0xnew"],
            tokenSymbols: ["NEWTOK"],
            tokenDecimals: [18],
            amounts: ["1000000000000000000"],
            feesUsdWei: "0",
          }),
        ],
        { rates: new Map() },
      ),
    ]);
    expect(result).toEqual([]);
  });

  it("aggregates across multiple networks", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const net1 = networkData([feeSnapshot()]);
    const net2 = networkData([feeSnapshot()], {
      network: {
        id: "monad-mainnet",
        chainId: 143,
        label: "Monad",
      } as NetworkData["network"],
    });
    const result = buildDailyFeeSeries([net1, net2], window);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(TODAY_BUCKET);
    expect(result[0].protocolFeesUSD).toBeCloseTo(2, 2);
  });

  it("skips networks with top-level errors", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const net1 = networkData([feeSnapshot()]);
    const net2 = networkData(
      [feeSnapshot({ feesUsdWei: "5000000000000000000" })],
      { error: new Error("net2 failed") },
    );
    const result = buildDailyFeeSeries([net1, net2], window);
    expect(result).toHaveLength(1);
    expect(result[0].protocolFeesUSD).toBeCloseTo(1, 2);
  });

  it("contributes nothing from networks with feeSnapshotsError", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const net = networkData([], {
      feeSnapshotsError: new Error("snapshot pagination timed out"),
    });
    const result = buildDailyFeeSeries([net], window);
    expect(result).toEqual([]);
  });

  it("skips networks with ratesError even when snapshots are present", () => {
    const window = { from: TODAY_BUCKET, to: NOW_S + 1 };
    const net = networkData([feeSnapshot()], {
      ratesError: new Error("oracle rates timed out"),
    });
    const result = buildDailyFeeSeries([net], window);
    expect(result).toEqual([]);
  });
});
