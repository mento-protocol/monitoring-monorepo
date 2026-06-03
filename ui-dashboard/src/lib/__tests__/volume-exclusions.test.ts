import { describe, expect, it } from "vitest";
import {
  filterAggregatorRowsByVolumeExclusions,
  filterBrokerTraderRowsByVolumeExclusions,
  filterTraderRowsByVolumeExclusions,
  mergeVolumeExclusions,
  parseVolumeExclusionInput,
} from "../volume-exclusions";
import type { TraderDailyRow, BrokerTraderDailyRow } from "../volume";
import type { AggregatorDailyRowBase } from "../volume-aggregators";

const TRADER_A = "0x00000000000000000000000000000000000000aa";
const TRADER_B = "0x00000000000000000000000000000000000000bb";
const ROUTER_A = "0x00000000000000000000000000000000000000cc";

function trader(overrides: Partial<TraderDailyRow>): TraderDailyRow {
  return {
    id: "row",
    chainId: 42220,
    trader: TRADER_A,
    timestamp: "1700000000",
    swapCount: 1,
    uniquePools: 1,
    volumeUsdWei: "100",
    feesPaidUsdWei: "1",
    isSystemAddress: false,
    lastSeenTimestamp: "1700000000",
    ...overrides,
    aggregatorKeys: overrides.aggregatorKeys ?? [],
  };
}

function brokerTrader(
  overrides: Partial<BrokerTraderDailyRow>,
): BrokerTraderDailyRow {
  return {
    id: "broker-row",
    chainId: 42220,
    trader: TRADER_A,
    timestamp: "1700000000",
    swapCount: 1,
    volumeUsdWei: "100",
    isSystemAddress: false,
    lastSeenTimestamp: "1700000000",
    ...overrides,
  };
}

function aggregator(
  overrides: Partial<AggregatorDailyRowBase>,
): AggregatorDailyRowBase {
  return {
    chainId: 42220,
    aggregator: "cluster-abc",
    lastSeenAggregatorAddress: ROUTER_A,
    timestamp: "1700000000",
    swapCount: 1,
    uniqueTraders: 1,
    volumeUsdWei: "100",
    ...overrides,
  };
}

describe("volume exclusions", () => {
  it("parses addresses and source labels from pasted input", () => {
    expect(
      parseVolumeExclusionInput(
        `${TRADER_A}, source:cluster-abc\n0x 0xnotanaddress invalid!`,
      ),
    ).toEqual({
      addresses: [TRADER_A],
      sources: ["cluster-abc", "0x"],
      invalid: ["0xnotanaddress", "invalid!"],
    });
  });

  it("merges exclusions without duplicating tokens", () => {
    expect(
      mergeVolumeExclusions(
        { addresses: [TRADER_A], sources: ["cluster-abc"] },
        { addresses: [TRADER_A, TRADER_B], sources: ["cluster-abc", "squid"] },
      ),
    ).toEqual({
      addresses: [TRADER_A, TRADER_B],
      sources: ["cluster-abc", "squid"],
    });
  });

  it("filters v3 trader-day rows by signer address and aggregator source", () => {
    const rows = [
      trader({ trader: TRADER_A, aggregatorKeys: ["direct"] }),
      trader({ trader: TRADER_B, aggregatorKeys: ["cluster-abc"] }),
      trader({
        trader: "0x00000000000000000000000000000000000000dd",
        aggregatorKeys: ["squid"],
      }),
    ];

    expect(
      filterTraderRowsByVolumeExclusions(rows, {
        addresses: [TRADER_A],
        sources: ["cluster-abc"],
      }).map((row) => row.trader),
    ).toEqual(["0x00000000000000000000000000000000000000dd"]);
  });

  it("filters v2 trader-day rows by signer address", () => {
    const rows = [
      brokerTrader({ trader: TRADER_A }),
      brokerTrader({ trader: TRADER_B }),
    ];

    expect(
      filterBrokerTraderRowsByVolumeExclusions(rows, {
        addresses: [TRADER_A],
        sources: ["cluster-abc"],
      }).map((row) => row.trader),
    ).toEqual([TRADER_B]);
  });

  it("filters aggregator rows by source label or visible route address", () => {
    const rows = [
      aggregator({
        aggregator: "cluster-abc",
        lastSeenAggregatorAddress: ROUTER_A,
      }),
      aggregator({
        aggregator: "squid",
        lastSeenAggregatorAddress: "0x00000000000000000000000000000000000000dd",
      }),
      aggregator({
        aggregator: "lifi",
        lastSeenAggregatorAddress: "0x00000000000000000000000000000000000000ee",
      }),
    ];

    expect(
      filterAggregatorRowsByVolumeExclusions(rows, {
        addresses: ["0x00000000000000000000000000000000000000dd"],
        sources: ["cluster-abc"],
      }).map((row) => row.aggregator),
    ).toEqual(["lifi"]);
  });
});
