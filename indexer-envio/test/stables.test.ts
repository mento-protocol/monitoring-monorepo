import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "vitest";
import {
  LOCK_AND_MINT_NTT_STABLES,
  LOCK_AND_MINT_NTT_STABLE_ADDRESSES,
  NTT_STABLES,
  STABLES,
  STABLE_ADDRESSES,
  findLockAndMintNttStableByAddress,
  findStableByAddress,
  makeStableSupplyDailySnapshotId,
  makeStableTokenCustodyDailySnapshotId,
} from "../src/handlers/stables/config.ts";
import {
  _resetBrokerAddressCacheForTest,
  classifyStableSupplyChangeKind,
} from "../src/handlers/stables/classifyKind.ts";
import { flushStableDailySnapshot } from "../src/handlers/stables/dailyFlush.ts";
import { makeStableTokenSupply } from "../src/handlers/stables/bootstrap.ts";
import {
  flushStableTokenCustodyDailySnapshot,
  makeStableTokenCustodyState,
} from "../src/handlers/stables/custodyState.ts";
import { V3_HUB_USDM_ADDRESS } from "../src/constants.ts";

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

// V3 hub USDm address is imported from constants.ts (single source of truth).
const V2_CUSD_USDM_ADDRESS = "0x765de816845861e75a25fca122bb6898b8b1282a";

describe("stables/config — registry derivation", () => {
  it("exposes Celo supply rows plus Monad NTT supply rows", () => {
    assert.equal(STABLES.length, 18);
    const v2Reserve = STABLES.filter((s) => s.source === "V2_RESERVE");
    const hub = STABLES.filter((s) => s.source === "V3_HUB_COLLATERAL");
    const v3Liquity = STABLES.filter((s) => s.source === "V3_LIQUITY");
    assert.equal(v2Reserve.length, 14);
    assert.equal(hub.length, 1);
    assert.equal(v3Liquity.length, 3);
    assert.equal(hub[0].address, V3_HUB_USDM_ADDRESS);
    assert.equal(hub[0].symbol, "USDm");
    const monadSymbols = new Set(
      STABLES.filter((s) => s.chainId === 143).map((s) => s.symbol),
    );
    assert.deepEqual([...monadSymbols].sort(), [
      "CHFm",
      "EURm",
      "GBPm",
      "JPYm",
      "USDm",
    ]);
  });

  it("includes every expected V2 reserve symbol from @mento-protocol/contracts", () => {
    const got = new Set(
      STABLES.filter(
        (s) => s.chainId === 42220 && s.source === "V2_RESERVE",
      ).map((s) => s.symbol),
    );
    for (const expected of EXPECTED_V2_RESERVE_SYMBOLS) {
      assert.ok(
        got.has(expected),
        `Expected V2 reserve symbol ${expected} missing from STABLES — package drift?`,
      );
    }
  });

  it("excludes Celo V3 Liquity debt tokens from V2 reserve supply rows", () => {
    const v2ReserveSymbols = STABLES.filter(
      (s) => s.chainId === 42220 && s.source === "V2_RESERVE",
    ).map((s) => s.symbol);
    for (const v3Symbol of ["GBPm", "CHFm", "JPYm"]) {
      assert.ok(
        !v2ReserveSymbols.includes(v3Symbol),
        `${v3Symbol} should NOT be in V2_RESERVE — V3 Liquity debt tokens use the systemDebt path.`,
      );
    }
  });

  it("every STABLES entry exposes `decimals` (denormalized to V2StableSupplyChangeEvent.tokenDecimals)", () => {
    // The Transfer handler writes `info.decimals` to every supply-change
    // event row; the UI changes-table reads it instead of hardcoding 18.
    // A missing/non-integer decimals would silently render with NaN,
    // turning every row's amount into the literal string "NaN". Catch
    // it at module-load via this registry-shape assertion.
    for (const s of STABLES) {
      assert.equal(
        typeof s.decimals,
        "number",
        `${s.symbol} (${s.address}) missing decimals — would corrupt V2StableSupplyChangeEvent.tokenDecimals`,
      );
      assert.ok(
        Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 30,
        `${s.symbol} has implausible decimals=${s.decimals}`,
      );
    }
  });

  it("V2 cUSD-USDm and V3 hub USDm are tracked as separate rows", () => {
    const v2Cusd = findStableByAddress(42220, V2_CUSD_USDM_ADDRESS);
    const v3Hub = findStableByAddress(42220, V3_HUB_USDM_ADDRESS);
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

  it("pins Wormhole NTT modes and keeps Celo lock/mint debt tokens custody-only", () => {
    const byKey = new Map(
      NTT_STABLES.map((s) => [`${s.chainId}:${s.symbol}`, s]),
    );
    assert.equal(byKey.get("42220:CHFm")?.bridgeMode, "LOCKING");
    assert.equal(byKey.get("42220:GBPm")?.bridgeMode, "LOCKING");
    assert.equal(byKey.get("42220:JPYm")?.bridgeMode, "LOCKING");
    assert.equal(byKey.get("42220:EURm")?.bridgeMode, "BURNING");
    assert.equal(byKey.get("42220:USDm")?.bridgeMode, "BURNING");
    for (const symbol of ["CHFm", "EURm", "GBPm", "JPYm", "USDm"]) {
      assert.equal(
        byKey.get(`143:${symbol}`)?.bridgeMode,
        "BURNING",
        `${symbol} on Monad should be burn/mint supply, not lock custody.`,
      );
    }

    assert.equal(LOCK_AND_MINT_NTT_STABLES.length, 3);
    for (const locked of LOCK_AND_MINT_NTT_STABLES) {
      assert.equal(locked.chainId, 42220);
      assert.equal(
        findStableByAddress(locked.chainId, locked.address),
        undefined,
        `${locked.symbol} Celo lock/mint token should not be in supply lookup.`,
      );
      assert.equal(
        findLockAndMintNttStableByAddress(locked.chainId, locked.address)
          ?.symbol,
        locked.symbol,
      );
    }
  });
});

describe("stables — YAML drift gate", () => {
  function yamlV2StableAddressesForChain(chainId: number): string[] {
    const chainStart = MAINNET_CONFIG.indexOf(`  - id: ${chainId}`);
    assert.notEqual(
      chainStart,
      -1,
      `chain ${chainId} block missing from mainnet YAML`,
    );
    const rest = MAINNET_CONFIG.slice(chainStart + 1);
    const nextChainRelative = rest.search(/\n {2}- id: /);
    const chainBlock =
      nextChainRelative === -1
        ? MAINNET_CONFIG.slice(chainStart)
        : MAINNET_CONFIG.slice(chainStart, chainStart + 1 + nextChainRelative);

    const v2Block = chainBlock.split("- name: V2StableToken")[1];
    assert.ok(
      v2Block,
      `V2StableToken contract block missing under chain ${chainId} in mainnet YAML`,
    );
    return (
      v2Block.split(/\n {6}- name:/)[0].match(/0x[0-9a-fA-F]{40}/g) ?? []
    ).map((a) => a.toLowerCase());
  }

  it("every supply and custody address appears under V2StableToken in mainnet YAML", () => {
    const expectedByChain = new Map<number, Set<string>>();
    for (const s of STABLES) {
      let set = expectedByChain.get(s.chainId);
      if (!set) {
        set = new Set();
        expectedByChain.set(s.chainId, set);
      }
      set.add(s.address);
    }
    for (const s of LOCK_AND_MINT_NTT_STABLES) {
      let set = expectedByChain.get(s.chainId);
      if (!set) {
        set = new Set();
        expectedByChain.set(s.chainId, set);
      }
      set.add(s.address);
    }

    for (const [chainId, expected] of expectedByChain) {
      const yamlAddresses = yamlV2StableAddressesForChain(chainId);
      assert.equal(
        yamlAddresses.length,
        expected.size,
        `YAML lists ${yamlAddresses.length} V2StableToken addresses on chain ${chainId}; registry expects ${expected.size}.`,
      );
      const yamlSet = new Set(yamlAddresses);
      for (const addr of expected) {
        assert.ok(
          yamlSet.has(addr),
          `Registry address ${addr} missing from YAML on chain ${chainId} — re-run codegen or update one or the other.`,
        );
      }
    }
  });

  it("keeps supply and custody address exports scoped to their responsibilities", () => {
    assert.equal(STABLE_ADDRESSES.length, 18);
    assert.equal(LOCK_AND_MINT_NTT_STABLE_ADDRESSES.length, 3);
    for (const addr of LOCK_AND_MINT_NTT_STABLE_ADDRESSES) {
      assert.equal(
        STABLE_ADDRESSES.includes(addr),
        false,
        `${addr} is custody-only and must not be treated as a supply-tracked STABLES address.`,
      );
    }
  });
});

describe("classifyStableSupplyChangeKind", () => {
  beforeEach(() => {
    _resetBrokerAddressCacheForTest();
  });

  it("Broker tx.to maps to RESERVE_MINT / RESERVE_BURN on Celo", () => {
    // Broker address from @mento-protocol/contracts mainnet Celo.
    const broker = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
    assert.equal(
      classifyStableSupplyChangeKind(42220, broker, true),
      "RESERVE_MINT",
    );
    assert.equal(
      classifyStableSupplyChangeKind(42220, broker, false),
      "RESERVE_BURN",
    );
  });

  it("NTT manager proxy tx.to maps to BRIDGE_*", () => {
    const usdmManager = "0xa4096343485a44c0f8d05ae6da311c18d63e38bc";
    assert.equal(
      classifyStableSupplyChangeKind(42220, usdmManager, true),
      "BRIDGE_MINT",
    );
    assert.equal(
      classifyStableSupplyChangeKind(42220, usdmManager, false),
      "BRIDGE_BURN",
    );
  });

  it("NTT helper tx.to maps to BRIDGE_*", () => {
    // USDm helper on Celo — the address user-initiated bridges usually hit.
    const usdmHelper = "0x37316334108c816f9862bab52347a0aab7551127";
    assert.equal(
      classifyStableSupplyChangeKind(42220, usdmHelper, true),
      "BRIDGE_MINT",
    );
  });

  it("NTT transceiver tx.to maps to BRIDGE_*", () => {
    const usdmTransceiver = "0x40f8650acd6ca771a822b6d8da71b46b0bde4c1b";
    assert.equal(
      classifyStableSupplyChangeKind(42220, usdmTransceiver, false),
      "BRIDGE_BURN",
    );
  });

  it("Unknown tx.to maps to OTHER_*", () => {
    const random = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert.equal(
      classifyStableSupplyChangeKind(42220, random, true),
      "OTHER_MINT",
    );
    assert.equal(
      classifyStableSupplyChangeKind(42220, random, false),
      "OTHER_BURN",
    );
  });

  it("null/undefined tx.to maps to OTHER_*", () => {
    assert.equal(
      classifyStableSupplyChangeKind(42220, null, true),
      "OTHER_MINT",
    );
    assert.equal(
      classifyStableSupplyChangeKind(42220, undefined, false),
      "OTHER_BURN",
    );
  });

  it("Celo Broker address on Monad (143) maps to OTHER_* (chain-dispatch)", () => {
    // Per-chain dispatch invariant: a Broker address only resolves on the
    // chain where Broker is deployed. Passing Celo's Broker as Monad's
    // tx.to MUST fall through to OTHER_*, not RESERVE_*.
    const celoBroker = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
    assert.equal(
      classifyStableSupplyChangeKind(143, celoBroker, true),
      "OTHER_MINT",
    );
  });
});

describe("flushStableDailySnapshot — day rollover", () => {
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
    const next = flushStableDailySnapshot(
      ctx,
      supply as never,
      sameDay,
      60_700_001n,
    );
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
    const next = flushStableDailySnapshot(
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
    const next = flushStableDailySnapshot(
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

describe("StableTokenCustodyState — lock-custody snapshot helpers", () => {
  const DAY_BUCKET_2024_05_22 = 1_716_336_000n;
  const CELO_CHFM_ADDRESS = "0xb55a79f398e759e43c95b979163f30ec87ee131d";
  const CHFM_MANAGER = "0xbbfbe2791722e93f27c5ce80e3725c8dd8d09697";

  function mockCustody(overrides: Partial<MockCustody> = {}): MockCustody {
    return {
      id: `42220-${CELO_CHFM_ADDRESS}`,
      chainId: 42220,
      tokenAddress: CELO_CHFM_ADDRESS,
      tokenSymbol: "CHFm",
      source: "V3_LIQUITY",
      tokenDecimals: 18,
      managerAddress: CHFM_MANAGER,
      lockedSupply: 25_000n * 10n ** 18n,
      supplyBaselineSeeded: true,
      currentDayBucket: DAY_BUCKET_2024_05_22,
      lockedTodayBucket: 2_000n * 10n ** 18n,
      unlockedTodayBucket: 500n * 10n ** 18n,
      lastEventBlock: 60_700_000n,
      lastEventTimestamp: 1_716_400_000n,
      ...overrides,
    };
  }

  it("creates a zeroed unseeded custody state row", () => {
    const row = makeStableTokenCustodyState({
      chainId: 42220,
      tokenAddress: CELO_CHFM_ADDRESS,
      symbol: "CHFm",
      decimals: 18,
      source: "V3_LIQUITY",
      managerAddress: CHFM_MANAGER,
      blockNumber: 60_700_000n,
      blockTimestamp: 1_716_391_800n,
    });
    assert.equal(row.id, `42220-${CELO_CHFM_ADDRESS}`);
    assert.equal(row.tokenAddress, CELO_CHFM_ADDRESS);
    assert.equal(row.managerAddress, CHFM_MANAGER);
    assert.equal(row.lockedSupply, 0n);
    assert.equal(row.supplyBaselineSeeded, false);
    assert.equal(row.lockedTodayBucket, 0n);
    assert.equal(row.unlockedTodayBucket, 0n);
    assert.equal(row.currentDayBucket, DAY_BUCKET_2024_05_22);
  });

  it("does not flush custody snapshot while event remains in the same UTC day", () => {
    const saved: Array<{ id: string }> = [];
    const ctx = {
      StableTokenCustodyDailySnapshot: {
        set: (entity: { id: string }) => saved.push(entity),
      },
    };
    const custody = mockCustody();
    const next = flushStableTokenCustodyDailySnapshot(
      ctx,
      custody as never,
      custody.currentDayBucket + 3600n,
      60_700_001n,
    );
    assert.equal(saved.length, 0);
    assert.equal(next.lockedTodayBucket, custody.lockedTodayBucket);
    assert.equal(next.unlockedTodayBucket, custody.unlockedTodayBucket);
    assert.equal(next.lockedSupply, custody.lockedSupply);
  });

  it("writes custody snapshot and resets lock/unlock buckets on rollover", () => {
    type SavedSnapshot = {
      id: string;
      chainId: number;
      tokenAddress: string;
      tokenSymbol: string;
      source: string;
      tokenDecimals: number;
      managerAddress: string;
      timestamp: bigint;
      lockedSupply: bigint;
      dailyLockedAmount: bigint;
      dailyUnlockedAmount: bigint;
      blockNumber: bigint;
      updatedAtTimestamp: bigint;
    };
    const saved: SavedSnapshot[] = [];
    const ctx = {
      StableTokenCustodyDailySnapshot: {
        set: (entity: SavedSnapshot) => saved.push(entity),
      },
    };
    const custody = mockCustody();
    const tomorrow = custody.currentDayBucket + 86_400n + 100n;
    const next = flushStableTokenCustodyDailySnapshot(
      ctx,
      custody as never,
      tomorrow,
      60_710_000n,
    );

    assert.equal(saved.length, 1);
    const row = saved[0];
    assert.equal(
      row.id,
      makeStableTokenCustodyDailySnapshotId(
        custody.chainId,
        custody.tokenAddress,
        custody.currentDayBucket,
      ),
    );
    assert.equal(row.chainId, custody.chainId);
    assert.equal(row.tokenAddress, custody.tokenAddress);
    assert.equal(row.tokenSymbol, custody.tokenSymbol);
    assert.equal(row.source, custody.source);
    assert.equal(row.tokenDecimals, custody.tokenDecimals);
    assert.equal(row.managerAddress, custody.managerAddress);
    assert.equal(row.timestamp, custody.currentDayBucket);
    assert.equal(row.lockedSupply, custody.lockedSupply);
    assert.equal(row.dailyLockedAmount, custody.lockedTodayBucket);
    assert.equal(row.dailyUnlockedAmount, custody.unlockedTodayBucket);
    assert.equal(row.blockNumber, 60_710_000n);
    assert.equal(row.updatedAtTimestamp, tomorrow);
    assert.equal(next.currentDayBucket, custody.currentDayBucket + 86_400n);
    assert.equal(next.lockedTodayBucket, 0n);
    assert.equal(next.unlockedTodayBucket, 0n);
    assert.equal(next.lockedSupply, custody.lockedSupply);
  });
});

describe("makeStableTokenSupply — fresh row shape", () => {
  it("returns supplyBaselineSeeded: false with zeroed accumulators", () => {
    const row = makeStableTokenSupply({
      chainId: 42220,
      tokenAddress: V2_CUSD_USDM_ADDRESS,
      symbol: "USDm",
      decimals: 18,
      source: "V2_RESERVE",
      blockNumber: 60_700_000n,
      blockTimestamp: 1_716_400_000n,
    });
    assert.equal(row.id, `42220-${V2_CUSD_USDM_ADDRESS}`);
    assert.equal(row.chainId, 42220);
    assert.equal(row.tokenAddress, V2_CUSD_USDM_ADDRESS);
    assert.equal(row.tokenSymbol, "USDm");
    assert.equal(row.source, "V2_RESERVE");
    assert.equal(row.tokenDecimals, 18);
    assert.equal(row.totalSupply, 0n);
    assert.equal(row.supplyBaselineSeeded, false);
    assert.equal(row.mintedTodayBucket, 0n);
    assert.equal(row.burnedTodayBucket, 0n);
    assert.equal(row.lastEventBlock, 60_700_000n);
    assert.equal(row.lastEventTimestamp, 1_716_400_000n);
  });

  it("pins currentDayBucket to dayBucket(blockTimestamp) — first-day no-flush invariant", () => {
    // Block timestamp = 2024-05-22 15:30:00 UTC → currentDayBucket should
    // be 2024-05-22 00:00:00 UTC. The first day-flush call with a same-day
    // event then returns no-op (currentDayBucket >= eventDay).
    const blockTimestamp = 1_716_391_800n; // 2024-05-22 15:30:00 UTC
    const expectedDay = 1_716_336_000n; // 2024-05-22 00:00:00 UTC
    const row = makeStableTokenSupply({
      chainId: 42220,
      tokenAddress: V2_CUSD_USDM_ADDRESS,
      symbol: "USDm",
      decimals: 18,
      source: "V2_RESERVE",
      blockNumber: 60_700_000n,
      blockTimestamp,
    });
    assert.equal(row.currentDayBucket, expectedDay);
  });
});

describe("schema → TS enum drift gate", () => {
  const SCHEMA = readFileSync(
    new URL("../schema.graphql", import.meta.url),
    "utf8",
  );

  function parseEnumValues(enumName: string): Set<string> {
    const re = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]+)\\}`);
    const match = SCHEMA.match(re);
    assert.ok(match, `enum ${enumName} missing from schema.graphql`);
    const body = match[1];
    return new Set(
      body
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter((line) => line.length > 0),
    );
  }

  it("StableSupplySource TS union matches schema enum values exactly", () => {
    const schemaValues = parseEnumValues("StableSupplySource");
    // TS union value set — kept hand-listed so a future schema addition
    // requires updating BOTH places (drift then surfaces here, not at
    // runtime when the handler writes an unknown enum value).
    const tsValues = new Set(["V2_RESERVE", "V3_HUB_COLLATERAL", "V3_LIQUITY"]);
    assert.deepEqual(
      [...schemaValues].sort(),
      [...tsValues].sort(),
      `Schema enum StableSupplySource drifted from TS union. Update both.`,
    );
  });

  it("V2StableSupplyChangeKind TS union matches schema enum values exactly", () => {
    const schemaValues = parseEnumValues("V2StableSupplyChangeKind");
    const tsValues = new Set([
      "RESERVE_MINT",
      "RESERVE_BURN",
      "BRIDGE_MINT",
      "BRIDGE_BURN",
      "OTHER_MINT",
      "OTHER_BURN",
    ]);
    assert.deepEqual(
      [...schemaValues].sort(),
      [...tsValues].sort(),
      `Schema enum V2StableSupplyChangeKind drifted from TS union. Update both.`,
    );
  });
});

// Handler integration tests (via Envio's createTestIndexer harness) for the
// load-bearing transfer.ts path — baseline-seed mint, baseline-seed burn,
// throw-on-RPC-failure retry, pre-deployment-block 0n-seed — are tracked
// as a follow-up. The V2StableToken contract is registered in
// indexerTestHarness.ts in this PR; the mock-event + effect-mock-routing
// wiring across createTestIndexer's runtime needs more harness work than
// this PR can absorb. The helper tests above (dailyFlush field
// assertions, classifyKind helper/transceiver/chain-dispatch cases,
// makeStableTokenSupply pure-function tests, schema↔TS enum drift gate)
// cover what's testable without the full harness.

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

type MockCustody = {
  id: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  source: string;
  tokenDecimals: number;
  managerAddress: string;
  lockedSupply: bigint;
  supplyBaselineSeeded: boolean;
  currentDayBucket: bigint;
  lockedTodayBucket: bigint;
  unlockedTodayBucket: bigint;
  lastEventBlock: bigint;
  lastEventTimestamp: bigint;
};
