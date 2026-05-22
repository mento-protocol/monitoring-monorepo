import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "vitest";
import {
  V2_STABLES,
  V2_STABLE_ADDRESSES,
  findV2StableByAddress,
  makeStableSupplyDailySnapshotId,
} from "../src/handlers/v2Stables/config.ts";
import {
  _resetBrokerAddressCacheForTest,
  classifyV2StableSupplyChangeKind,
} from "../src/handlers/v2Stables/classifyKind.ts";
import { flushV2StableDailySnapshot } from "../src/handlers/v2Stables/dailyFlush.ts";

const MAINNET_CONFIG = readFileSync(
  new URL("../config.multichain.mainnet.yaml", import.meta.url),
  "utf8",
);

// Expected V2 stable symbols. If @mento-protocol/contracts drops or renames
// one of these, the EXPECTED_V2_RESERVE_SYMBOLS invariant in config.ts will
// throw at module load — but we also enumerate here so the test fails with
// a clearer message than a stack trace from a top-level throw.
const EXPECTED_V2_RESERVE_SYMBOLS = [
  "USDm",
  "EURm",
  "BRLm",
  "AUDm",
  "CADm",
  "COPm",
  "GHSm",
  "KESm",
  "NGNm",
  "PHPm",
  "XOFm",
  "ZARm",
] as const;

const V3_HUB_USDM_ADDRESS = "0x106cc9ff5a2c488780635be8afc07c68522b7ea5";
const V2_CUSD_USDM_ADDRESS = "0x765de816845861e75a25fca122bb6898b8b1282a";

describe("v2Stables/config — registry derivation", () => {
  it("exposes 13 entries: 12 V2_RESERVE + 1 V3_HUB_COLLATERAL", () => {
    assert.equal(V2_STABLES.length, 13);
    const v2Reserve = V2_STABLES.filter((s) => s.source === "V2_RESERVE");
    const hub = V2_STABLES.filter((s) => s.source === "V3_HUB_COLLATERAL");
    assert.equal(v2Reserve.length, 12);
    assert.equal(hub.length, 1);
    assert.equal(hub[0].address, V3_HUB_USDM_ADDRESS);
    assert.equal(hub[0].symbol, "USDm");
  });

  it("includes every expected V2 reserve symbol from @mento-protocol/contracts", () => {
    const got = new Set(
      V2_STABLES.filter((s) => s.source === "V2_RESERVE").map((s) => s.symbol),
    );
    for (const expected of EXPECTED_V2_RESERVE_SYMBOLS) {
      assert.ok(
        got.has(expected),
        `Expected V2 reserve symbol ${expected} missing from V2_STABLES — package drift?`,
      );
    }
  });

  it("excludes V3 Liquity debt tokens (GBPm/CHFm/JPYm) — supply tracked via systemDebt", () => {
    const v2ReserveSymbols = V2_STABLES.filter(
      (s) => s.source === "V2_RESERVE",
    ).map((s) => s.symbol);
    for (const v3Symbol of ["GBPm", "CHFm", "JPYm"]) {
      assert.ok(
        !v2ReserveSymbols.includes(v3Symbol),
        `${v3Symbol} should NOT be in V2_RESERVE — V3 Liquity debt tokens use the systemDebt path.`,
      );
    }
  });

  it("V2 cUSD-USDm and V3 hub USDm are tracked as separate rows", () => {
    const v2Cusd = findV2StableByAddress(42220, V2_CUSD_USDM_ADDRESS);
    const v3Hub = findV2StableByAddress(42220, V3_HUB_USDM_ADDRESS);
    assert.ok(v2Cusd, "V2 cUSD-USDm not in registry");
    assert.ok(v3Hub, "V3 hub USDm not in registry");
    assert.equal(v2Cusd.source, "V2_RESERVE");
    assert.equal(v3Hub.source, "V3_HUB_COLLATERAL");
    assert.notEqual(
      v2Cusd.address,
      v3Hub.address,
      "V2 cUSD and V3 hub USDm must be distinct on-chain contracts",
    );
  });
});

describe("v2Stables — YAML drift gate", () => {
  it("every V2_STABLES address appears under V2StableToken in mainnet YAML", () => {
    // Locate the V2StableToken block under the Celo (chain 42220) network.
    const celoStart = MAINNET_CONFIG.indexOf("  - id: 42220");
    assert.notEqual(celoStart, -1, "Celo chain block missing from mainnet YAML");
    const monadStart = MAINNET_CONFIG.indexOf("  - id: 143", celoStart);
    const celoBlock = MAINNET_CONFIG.slice(
      celoStart,
      monadStart === -1 ? undefined : monadStart,
    );

    const v2Block = celoBlock.split("- name: V2StableToken")[1];
    assert.ok(
      v2Block,
      "V2StableToken contract block missing under Celo in mainnet YAML",
    );
    // Stop at the next top-level `- name:` so we don't pick up addresses from
    // a later block.
    const yamlAddresses = (
      v2Block.split(/\n {6}- name:/)[0].match(/0x[0-9a-fA-F]{40}/g) ?? []
    ).map((a) => a.toLowerCase());

    assert.equal(
      yamlAddresses.length,
      V2_STABLE_ADDRESSES.length,
      `YAML lists ${yamlAddresses.length} V2StableToken addresses on Celo; registry has ${V2_STABLE_ADDRESSES.length}.`,
    );
    const yamlSet = new Set(yamlAddresses);
    for (const addr of V2_STABLE_ADDRESSES) {
      assert.ok(
        yamlSet.has(addr),
        `Registry address ${addr} missing from YAML — re-run codegen or update one or the other.`,
      );
    }
  });
});

describe("classifyV2StableSupplyChangeKind", () => {
  beforeEach(() => {
    _resetBrokerAddressCacheForTest();
  });

  it("Broker tx.to maps to RESERVE_MINT / RESERVE_BURN on Celo", () => {
    // Broker address from @mento-protocol/contracts mainnet Celo.
    const broker = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, broker, true),
      "RESERVE_MINT",
    );
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, broker, false),
      "RESERVE_BURN",
    );
  });

  it("NTT manager proxy tx.to maps to BRIDGE_*", () => {
    const usdmManager = "0xa4096343485a44c0f8d05ae6da311c18d63e38bc";
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, usdmManager, true),
      "BRIDGE_MINT",
    );
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, usdmManager, false),
      "BRIDGE_BURN",
    );
  });

  it("NTT helper tx.to maps to BRIDGE_*", () => {
    // USDm helper on Celo — the address user-initiated bridges usually hit.
    const usdmHelper = "0x37316334108c816f9862bab52347a0aab7551127";
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, usdmHelper, true),
      "BRIDGE_MINT",
    );
  });

  it("NTT transceiver tx.to maps to BRIDGE_*", () => {
    const usdmTransceiver = "0x40f8650acd6ca771a822b6d8da71b46b0bde4c1b";
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, usdmTransceiver, false),
      "BRIDGE_BURN",
    );
  });

  it("Unknown tx.to maps to OTHER_*", () => {
    const random = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, random, true),
      "OTHER_MINT",
    );
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, random, false),
      "OTHER_BURN",
    );
  });

  it("null/undefined tx.to maps to OTHER_*", () => {
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, null, true),
      "OTHER_MINT",
    );
    assert.equal(
      classifyV2StableSupplyChangeKind(42220, undefined, false),
      "OTHER_BURN",
    );
  });

  it("Celo Broker address on Monad (143) maps to OTHER_* (chain-dispatch)", () => {
    // Per-chain dispatch invariant: a Broker address only resolves on the
    // chain where Broker is deployed. Passing Celo's Broker as Monad's
    // tx.to MUST fall through to OTHER_*, not RESERVE_*.
    const celoBroker = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
    assert.equal(
      classifyV2StableSupplyChangeKind(143, celoBroker, true),
      "OTHER_MINT",
    );
  });
});

describe("flushV2StableDailySnapshot — day rollover", () => {
  // 2024-05-22 00:00:00 UTC. Test value is anchored in the past so the
  // "rollover by +86_400" math doesn't accidentally land past the wall-
  // clock now for someone reading the test in the future.
  const DAY_BUCKET_2024_05_22 = 1_716_336_000n;

  function mockSupply(overrides: Partial<MockSupply> = {}): MockSupply {
    return {
      id: "42220-0x765de816845861e75a25fca122bb6898b8b1282a",
      chainId: 42220,
      tokenAddress: "0x765de816845861e75a25fca122bb6898b8b1282a",
      tokenSymbol: "USDm",
      source: "V2_RESERVE",
      tokenDecimals: 18,
      totalSupply: 1_000_000n * 10n ** 18n,
      supplyBaselineSeeded: true,
      currentDayBucket: DAY_BUCKET_2024_05_22,
      mintedTodayBucket: 500_000n * 10n ** 18n,
      burnedTodayBucket: 200_000n * 10n ** 18n,
      lastEventBlock: 60_700_000n,
      lastEventTimestamp: 1_716_400_000n,
      ...overrides,
    };
  }

  it("returns supply unchanged when event is in the same day", () => {
    const saved: Array<{ id: string }> = [];
    const ctx = {
      StableSupplyDailySnapshot: {
        set: (entity: { id: string }) => saved.push(entity),
      },
    };
    const supply = mockSupply();
    const sameDay = supply.currentDayBucket + 3600n; // +1 hour, still same UTC day
    const next = flushV2StableDailySnapshot(ctx, supply as never, sameDay, 60_700_001n);
    assert.equal(saved.length, 0, "no snapshot should be flushed");
    assert.equal(next.mintedTodayBucket, supply.mintedTodayBucket);
    assert.equal(next.burnedTodayBucket, supply.burnedTodayBucket);
    assert.equal(next.currentDayBucket, supply.currentDayBucket);
    assert.equal(next.totalSupply, supply.totalSupply);
  });

  it("writes snapshot with all fields populated + resets day buckets on rollover", () => {
    type SavedSnapshot = {
      id: string;
      chainId: number;
      tokenAddress: string;
      tokenSymbol: string;
      source: string;
      tokenDecimals: number;
      timestamp: bigint;
      totalSupply: bigint;
      dailyMintAmount: bigint;
      dailyBurnAmount: bigint;
      blockNumber: bigint;
      updatedAtTimestamp: bigint;
    };
    const saved: SavedSnapshot[] = [];
    const ctx = {
      StableSupplyDailySnapshot: {
        set: (entity: SavedSnapshot) => saved.push(entity),
      },
    };
    const supply = mockSupply();
    const tomorrow = supply.currentDayBucket + 86_400n + 100n;
    const next = flushV2StableDailySnapshot(
      ctx,
      supply as never,
      tomorrow,
      60_710_000n,
    );

    assert.equal(saved.length, 1, "one snapshot should be flushed");
    const row = saved[0];
    // ID well-formed: matches the registry's helper output.
    assert.equal(
      row.id,
      makeStableSupplyDailySnapshotId(
        supply.chainId,
        supply.tokenAddress,
        supply.currentDayBucket,
      ),
    );
    // Identity fields copied through unchanged.
    assert.equal(row.chainId, supply.chainId);
    assert.equal(row.tokenAddress, supply.tokenAddress);
    assert.equal(row.tokenSymbol, supply.tokenSymbol);
    assert.equal(row.source, supply.source);
    assert.equal(row.tokenDecimals, supply.tokenDecimals);
    // Day-bucket math: snapshot is for the PREVIOUS day, not the event's day.
    assert.equal(row.timestamp, supply.currentDayBucket);
    // Supply + flow fields from accumulators.
    assert.equal(row.totalSupply, supply.totalSupply);
    assert.equal(row.dailyMintAmount, supply.mintedTodayBucket);
    assert.equal(row.dailyBurnAmount, supply.burnedTodayBucket);
    // Block + timestamp pinned to the triggering event.
    assert.equal(row.blockNumber, 60_710_000n);
    assert.equal(row.updatedAtTimestamp, tomorrow);

    // Bucket reset after flush.
    assert.equal(next.currentDayBucket, supply.currentDayBucket + 86_400n);
    assert.equal(next.mintedTodayBucket, 0n);
    assert.equal(next.burnedTodayBucket, 0n);
    // totalSupply unchanged — already up-to-date.
    assert.equal(next.totalSupply, supply.totalSupply);
  });

  it("handles multi-day-skip rollover by jumping to event day", () => {
    // Edge case: handler hasn't seen this token for ~3 days. Only the
    // ONE snapshot row for the last-known active day is written (the
    // intermediate days are intentionally sparse — see the schema's
    // sparse-day comment block).
    const saved: Array<{ timestamp: bigint }> = [];
    const ctx = {
      StableSupplyDailySnapshot: {
        set: (entity: { timestamp: bigint }) => saved.push(entity),
      },
    };
    const supply = mockSupply();
    const threeDaysLater = supply.currentDayBucket + 3n * 86_400n + 12_345n;
    const next = flushV2StableDailySnapshot(
      ctx,
      supply as never,
      threeDaysLater,
      60_720_000n,
    );
    assert.equal(saved.length, 1, "only one snapshot row, not three");
    assert.equal(saved[0].timestamp, supply.currentDayBucket);
    assert.equal(next.currentDayBucket, supply.currentDayBucket + 3n * 86_400n);
  });
});

// Handler integration tests (via Envio's createTestIndexer harness) for the
// load-bearing transfer.ts path — baseline-seed mint, baseline-seed burn,
// throw-on-RPC-failure retry — are tracked as a follow-up. The V2StableToken
// contract is registered in indexerTestHarness.ts in this PR; the mock-event
// + effect-mock-routing wiring across createTestIndexer's runtime needs
// more harness work than this PR can absorb. The strengthened helper tests
// above (dailyFlush field assertions, classifyKind helper/transceiver/
// chain-dispatch cases) cover what's testable without the full harness.
// See codex + tests specialist findings.

type MockSupply = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: string;
  tokenDecimals: number;
  totalSupply: bigint;
  supplyBaselineSeeded: boolean;
  currentDayBucket: bigint;
  mintedTodayBucket: bigint;
  burnedTodayBucket: bigint;
  lastEventBlock: bigint;
  lastEventTimestamp: bigint;
};
