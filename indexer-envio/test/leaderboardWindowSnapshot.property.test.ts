/**
 * Property-based tests for leaderboardWindowSnapshot + leaderboardWindowFlush
 * bigint-math invariants.
 *
 * These complement the unit tests in leaderboardWindowSnapshot.test.ts by
 * checking law-shaped invariants across arbitrary inputs rather than specific
 * scenarios. Invariants covered:
 *
 *  1. windowStartDay: deterministic — same inputs always produce same output
 *  2. windowStartDay: for rolling windows (7d/30d/90d) start < snapshotDay
 *  3. windowStartDay: for "all" always returns 0n
 *  4. windowStartDay: for "24h" always returns snapshotDay + 86400n (empty range)
 *  5. aggregatePerWindow: commutativity — total volume is independent of input order
 *  6. aggregatePerWindow: out-of-range rows are always dropped
 *  7. aggregatePerWindow: volumeUsdWei accumulation matches manual sum per trader
 *  8. aggregatePerWindow: swapCount accumulation matches manual sum per trader
 *  9. aggregatePerWindow: isSystemAddress is sticky-true (OR-accumulation)
 * 10. buildLeaderboardWindowSnapshot: totalVolumeUsdWei = sum of non-system aggregates
 * 11. buildLeaderboardWindowSnapshot: uniqueTraders <= uniqueTradersIncludingSystem
 * 12. buildLeaderboardWindowSnapshot: firstDayExclusiveUniqueTraders <= uniqueTraders
 * 13. buildLeaderboardWindowSnapshot: totalVolumeUsdWei <= totalVolumeUsdWeiIncludingSystem
 * 14. buildLeaderboardWindowSnapshot: id has deterministic format
 * 15. maybeHeartbeatFlushV3: never decreases lastFlushedDay
 * 16. maybeHeartbeatFlushV3: written snapshot count = closed days × WINDOW_KEYS length
 */

import { describe, it } from "vitest";
import { strict as assert } from "assert";
import * as fc from "fast-check";
import type {
  LeaderboardChainState,
  LeaderboardWindowSnapshot,
  TraderDailySnapshot,
} from "envio";
import {
  WINDOW_KEYS,
  WINDOW_DAYS,
  aggregatePerWindow,
  buildLeaderboardWindowSnapshot,
  windowStartDay,
  type TraderDailyRow,
  type TraderWindowAggregate,
} from "../src/leaderboardWindowSnapshot.js";
import {
  maybeHeartbeatFlushV3,
  type V3FlushContext,
} from "../src/leaderboardWindowFlush.js";
import { SECONDS_PER_DAY } from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A valid UTC-day timestamp: a multiple of 86400 in the range of reasonable
 *  blockchain timestamps (2020 – 2040). */
const arbDayTimestamp: fc.Arbitrary<bigint> = fc
  .nat({ max: 365 * 20 })
  .map((offset) => {
    // 2020-01-01 00:00:00 UTC = 1577836800
    const base = 1577836800n;
    return base + BigInt(offset) * SECONDS_PER_DAY;
  });

/** A valid block timestamp: some second within a day (not necessarily aligned). */
const arbBlockTimestamp: fc.Arbitrary<bigint> = fc
  .tuple(
    fc.nat({ max: 365 * 20 }), // day offset from 2020-01-01
    fc.nat({ max: 86399 }), // seconds within the day
  )
  .map(([dayOffset, secondsOffset]) => {
    const base = 1577836800n;
    return base + BigInt(dayOffset) * SECONDS_PER_DAY + BigInt(secondsOffset);
  });

/** A non-negative bigint up to 10^30 (represents fee amounts in wei). */
const arbAmount: fc.Arbitrary<bigint> = fc.bigInt({
  min: 0n,
  max: 10n ** 30n,
});

/** A small non-negative bigint swap count. */
const arbSwapCount: fc.Arbitrary<number> = fc.nat({ max: 1_000 });

const CHAIN = 42220;

function arbAddress(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[0-9a-f]{40}$/).map((h) => `0x${h}`);
}

/** Build a TraderDailyRow with a fixed chainId and caller-controlled fields. */
function arbRow(timestamp: bigint): fc.Arbitrary<TraderDailyRow> {
  return fc.record({
    chainId: fc.constant(CHAIN),
    trader: arbAddress(),
    timestamp: fc.constant(timestamp),
    volumeUsdWei: arbAmount,
    swapCount: arbSwapCount,
    isSystemAddress: fc.boolean(),
  });
}

/** Build a TraderWindowAggregate with neutral first-day defaults. */
function arbAggregate(): fc.Arbitrary<TraderWindowAggregate> {
  return fc.record({
    trader: arbAddress(),
    volumeUsdWei: arbAmount,
    swapCount: arbSwapCount,
    isSystemAddress: fc.boolean(),
    firstDayVolumeUsdWei: fc.constant(0n),
    firstDaySwapCount: fc.constant(0),
    activeOutsideFirstDay: fc.constant(true),
  });
}

// ---------------------------------------------------------------------------
// 1. windowStartDay: deterministic
// ---------------------------------------------------------------------------
describe("windowStartDay — deterministic", () => {
  it("same snapshotDay + windowKey always returns the same value", () => {
    fc.assert(
      fc.property(arbDayTimestamp, (snapshotDay) => {
        for (const w of WINDOW_KEYS) {
          const a = windowStartDay(snapshotDay, w);
          const b = windowStartDay(snapshotDay, w);
          assert.equal(
            a,
            b,
            `windowStartDay(${snapshotDay}, ${w}) not deterministic`,
          );
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. windowStartDay: rolling windows start before snapshotDay
// ---------------------------------------------------------------------------
describe("windowStartDay — rolling windows start < snapshotDay", () => {
  it("7d/30d/90d start day is always strictly before snapshotDay", () => {
    const rollingKeys = ["7d", "30d", "90d"] as const;
    fc.assert(
      fc.property(arbDayTimestamp, (snapshotDay) => {
        for (const w of rollingKeys) {
          const start = windowStartDay(snapshotDay, w);
          assert(
            start < snapshotDay,
            `windowStartDay(${snapshotDay}, ${w}) = ${start} is not < snapshotDay`,
          );
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. windowStartDay: "all" always returns 0n
// ---------------------------------------------------------------------------
describe("windowStartDay — all returns 0n", () => {
  it("always 0n for any snapshotDay", () => {
    fc.assert(
      fc.property(arbDayTimestamp, (snapshotDay) => {
        assert.equal(windowStartDay(snapshotDay, "all"), 0n);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. windowStartDay: "24h" returns snapshotDay + SECONDS_PER_DAY
// ---------------------------------------------------------------------------
describe("windowStartDay — 24h returns snapshotDay + 1 day", () => {
  it("24h start is always one day past snapshotDay (empty range)", () => {
    fc.assert(
      fc.property(arbDayTimestamp, (snapshotDay) => {
        assert.equal(
          windowStartDay(snapshotDay, "24h"),
          snapshotDay + SECONDS_PER_DAY,
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. aggregatePerWindow: commutativity — totals independent of input order
// ---------------------------------------------------------------------------
describe("aggregatePerWindow — commutativity", () => {
  it("reordering rows does not change per-window total volume or swap count", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc
          .array(arbRow(0n), { minLength: 0, maxLength: 10 })
          .chain((baseRows) => {
            // Stamp each row with a valid timestamp within the snapshotDay's window.
            return fc.constant(baseRows);
          }),
        (snapshotDay, rawRows) => {
          // Give all rows a timestamp = snapshotDay so they land in every
          // window except 24h (which is always empty by construction).
          const rows: TraderDailyRow[] = rawRows.map((r) => ({
            ...r,
            timestamp: snapshotDay,
          }));
          const shuffled = [...rows].sort(() => 0.5 - Math.random());

          const original = aggregatePerWindow(rows, CHAIN, snapshotDay);
          const reordered = aggregatePerWindow(shuffled, CHAIN, snapshotDay);

          for (const w of WINDOW_KEYS) {
            const totalVol = (aggs: TraderWindowAggregate[]) =>
              aggs.reduce((acc, a) => acc + a.volumeUsdWei, 0n);
            const totalSwaps = (aggs: TraderWindowAggregate[]) =>
              aggs.reduce((acc, a) => acc + a.swapCount, 0);

            assert.equal(
              totalVol(original[w]),
              totalVol(reordered[w]),
              `window=${w}: total volume differs after reorder`,
            );
            assert.equal(
              totalSwaps(original[w]),
              totalSwaps(reordered[w]),
              `window=${w}: total swaps differ after reorder`,
            );
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. aggregatePerWindow: out-of-range rows are always dropped
// ---------------------------------------------------------------------------
describe("aggregatePerWindow — out-of-range rows dropped", () => {
  it("rows with timestamp > snapshotDay are never included in any window", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        arbAddress(),
        arbAmount,
        (snapshotDay, trader, vol) => {
          // Row one day after the snapshot day — must be dropped from all windows.
          const futureRow: TraderDailyRow = {
            chainId: CHAIN,
            trader,
            timestamp: snapshotDay + SECONDS_PER_DAY,
            volumeUsdWei: vol,
            swapCount: 1,
            isSystemAddress: false,
          };
          const grouped = aggregatePerWindow([futureRow], CHAIN, snapshotDay);
          for (const w of WINDOW_KEYS) {
            assert.equal(
              grouped[w].length,
              0,
              `window=${w}: future-day row must be excluded`,
            );
          }
        },
      ),
    );
  });

  it("rows with wrong chainId are never included in any window", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        arbAddress(),
        arbAmount,
        (snapshotDay, trader, vol) => {
          const wrongChainRow: TraderDailyRow = {
            chainId: CHAIN + 1,
            trader,
            timestamp: snapshotDay,
            volumeUsdWei: vol,
            swapCount: 1,
            isSystemAddress: false,
          };
          const grouped = aggregatePerWindow(
            [wrongChainRow],
            CHAIN,
            snapshotDay,
          );
          for (const w of WINDOW_KEYS) {
            assert.equal(
              grouped[w].length,
              0,
              `window=${w}: wrong-chain row must be excluded`,
            );
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. aggregatePerWindow: per-trader volume / swap accumulation
// ---------------------------------------------------------------------------
describe("aggregatePerWindow — per-trader accumulation", () => {
  it("single trader's window volume equals sum of all in-range rows for that trader", () => {
    // Use the "all" window (no lower bound) to avoid off-by-one edge cases
    // from rolling window boundaries. All rows are valid.
    fc.assert(
      fc.property(
        arbDayTimestamp,
        // Two day-timestamps strictly ≤ snapshotDay
        fc.nat({ max: 10 }).map(BigInt),
        fc.nat({ max: 10 }).map(BigInt),
        arbAmount,
        arbAmount,
        arbSwapCount,
        arbSwapCount,
        (snapshotDay, offset1, offset2, vol1, vol2, swaps1, swaps2) => {
          const trader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          const ts1 = snapshotDay - offset1 * SECONDS_PER_DAY;
          const ts2 = snapshotDay - offset2 * SECONDS_PER_DAY;
          const rows: TraderDailyRow[] = [
            {
              chainId: CHAIN,
              trader,
              timestamp: ts1,
              volumeUsdWei: vol1,
              swapCount: swaps1,
              isSystemAddress: false,
            },
            {
              chainId: CHAIN,
              trader,
              timestamp: ts2,
              volumeUsdWei: vol2,
              swapCount: swaps2,
              isSystemAddress: false,
            },
          ];
          const grouped = aggregatePerWindow(rows, CHAIN, snapshotDay);
          const allAggs = grouped["all"];
          assert.equal(
            allAggs.length,
            1,
            "single trader should merge into 1 aggregate",
          );
          assert.equal(
            allAggs[0]!.volumeUsdWei,
            vol1 + vol2,
            "volumes must sum",
          );
          assert.equal(
            allAggs[0]!.swapCount,
            swaps1 + swaps2,
            "swap counts must sum",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. aggregatePerWindow: isSystemAddress is sticky-true
// ---------------------------------------------------------------------------
describe("aggregatePerWindow — isSystemAddress sticky-true", () => {
  it("if any day marks a trader system, the aggregate is marked system", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.nat({ max: 5 }).map(BigInt), // day offset
        (snapshotDay, offset) => {
          const trader = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
          const ts1 = snapshotDay - offset * SECONDS_PER_DAY;
          const rows: TraderDailyRow[] = [
            {
              chainId: CHAIN,
              trader,
              timestamp: ts1,
              volumeUsdWei: 1n,
              swapCount: 1,
              isSystemAddress: true,
            },
            {
              chainId: CHAIN,
              trader,
              timestamp: snapshotDay,
              volumeUsdWei: 1n,
              swapCount: 1,
              isSystemAddress: false,
            },
          ];
          const grouped = aggregatePerWindow(rows, CHAIN, snapshotDay);
          const allAgg = grouped["all"].find((a) => a.trader === trader);
          assert(allAgg, "trader must appear in 'all' window");
          assert.equal(
            allAgg.isSystemAddress,
            true,
            "isSystemAddress must be sticky-true",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. buildLeaderboardWindowSnapshot: totalVolumeUsdWei = sum of non-system
// ---------------------------------------------------------------------------
describe("buildLeaderboardWindowSnapshot — volume sum invariant", () => {
  it("totalVolumeUsdWei equals the sum of volumeUsdWei for non-system aggregates", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildLeaderboardWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          const expectedVol = aggregates
            .filter((a) => !a.isSystemAddress)
            .reduce((acc, a) => acc + a.volumeUsdWei, 0n);
          assert.equal(
            snap.totalVolumeUsdWei,
            expectedVol,
            "totalVolumeUsdWei must exclude system addresses",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. buildLeaderboardWindowSnapshot: uniqueTraders <= uniqueTradersIncludingSystem
// ---------------------------------------------------------------------------
describe("buildLeaderboardWindowSnapshot — trader count ordering", () => {
  it("uniqueTraders is always <= uniqueTradersIncludingSystem", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildLeaderboardWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          assert(
            snap.uniqueTraders <= snap.uniqueTradersIncludingSystem,
            `uniqueTraders (${snap.uniqueTraders}) > uniqueTradersIncludingSystem (${snap.uniqueTradersIncludingSystem})`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 12. buildLeaderboardWindowSnapshot: firstDayExclusiveUniqueTraders <= uniqueTraders
// ---------------------------------------------------------------------------
describe("buildLeaderboardWindowSnapshot — exclusive count bounded by unique count", () => {
  it("firstDayExclusiveUniqueTraders is always <= uniqueTraders", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(
          fc.record({
            trader: arbAddress(),
            volumeUsdWei: arbAmount,
            swapCount: arbSwapCount,
            isSystemAddress: fc.constant(false), // only non-system for simplicity
            firstDayVolumeUsdWei: fc.constant(0n),
            firstDaySwapCount: fc.constant(0),
            activeOutsideFirstDay: fc.boolean(),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (snapshotDay, aggregates) => {
          const snap = buildLeaderboardWindowSnapshot({
            chainId: CHAIN,
            windowKey: "7d",
            snapshotDay,
            windowStartDay: windowStartDay(snapshotDay, "7d"),
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          assert(
            snap.firstDayExclusiveUniqueTraders <= snap.uniqueTraders,
            `firstDayExclusiveUniqueTraders (${snap.firstDayExclusiveUniqueTraders}) > uniqueTraders (${snap.uniqueTraders})`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 13. buildLeaderboardWindowSnapshot: primary volume <= includingSystem volume
// ---------------------------------------------------------------------------
describe("buildLeaderboardWindowSnapshot — primary volume <= includingSystem volume", () => {
  it("totalVolumeUsdWei is always <= totalVolumeUsdWeiIncludingSystem", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildLeaderboardWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          assert(
            snap.totalVolumeUsdWei <= snap.totalVolumeUsdWeiIncludingSystem,
            "primary volume exceeds includingSystem volume",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 14. buildLeaderboardWindowSnapshot: deterministic ID format
// ---------------------------------------------------------------------------
describe("buildLeaderboardWindowSnapshot — deterministic ID", () => {
  it("id always follows the pattern '{chainId}-{windowKey}-{snapshotDay}'", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.constantFrom(...WINDOW_KEYS),
        (snapshotDay, windowKey) => {
          const snap = buildLeaderboardWindowSnapshot({
            chainId: CHAIN,
            windowKey,
            snapshotDay,
            windowStartDay: windowStartDay(snapshotDay, windowKey),
            aggregates: [],
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          const expected = `${CHAIN}-${windowKey}-${snapshotDay}`;
          assert.equal(snap.id, expected);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 15 & 16. maybeHeartbeatFlushV3: lastFlushedDay never decreases;
//           written snapshot count = closedDays × WINDOW_KEYS.length
// ---------------------------------------------------------------------------

function makeV3Context(traderRows: TraderDailySnapshot[] = []): {
  context: V3FlushContext;
  store: {
    LeaderboardWindowSnapshot: Map<string, LeaderboardWindowSnapshot>;
    LeaderboardChainState: Map<string, LeaderboardChainState>;
  };
} {
  const store = {
    LeaderboardWindowSnapshot: new Map<string, LeaderboardWindowSnapshot>(),
    LeaderboardChainState: new Map<string, LeaderboardChainState>(),
  };
  const wrap = <T extends { id: string }>(m: Map<string, T>) => ({
    get: async (id: string) => m.get(id),
    set: (entity: T) => {
      m.set(entity.id, entity);
    },
  });
  return {
    context: {
      TraderDailySnapshot: {
        getWhere: async (query: { chainId?: { _eq?: number } }) =>
          traderRows.filter((r) => r.chainId === query.chainId?._eq),
      },
      LeaderboardChainState: wrap(store.LeaderboardChainState),
      LeaderboardWindowSnapshot: wrap(store.LeaderboardWindowSnapshot),
    },
    store,
  };
}

describe("maybeHeartbeatFlushV3 — monotone lastFlushedDay", () => {
  it("lastFlushedDay never decreases after a heartbeat", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Pick a gap of 0–4 days already flushed, then an event 1–3 days further.
        fc.nat({ max: 4 }),
        fc.nat({ min: 1, max: 3 }),
        async (alreadyFlushedDays, newDaysGap) => {
          const BASE_DAY = 1700000000n - (1700000000n % SECONDS_PER_DAY); // deterministic day
          const lastFlushedDay =
            BASE_DAY + BigInt(alreadyFlushedDays) * SECONDS_PER_DAY;
          const blockTimestamp =
            BASE_DAY +
            BigInt(alreadyFlushedDays + newDaysGap + 1) * SECONDS_PER_DAY +
            3600n; // mid next day

          const { context, store } = makeV3Context();
          store.LeaderboardChainState.set(`${CHAIN}`, {
            id: `${CHAIN}`,
            chainId: CHAIN,
            lastFlushedDay,
            lastFlushedDayBroker: 0n,
            updatedAtTimestamp: 0n,
          });

          await maybeHeartbeatFlushV3({
            context,
            chainId: CHAIN,
            blockTimestamp,
            blockNumber: 1n,
          });

          const state = store.LeaderboardChainState.get(`${CHAIN}`);
          assert(state, "LeaderboardChainState must be written");
          assert(
            state.lastFlushedDay >= lastFlushedDay,
            `lastFlushedDay decreased: was ${lastFlushedDay}, now ${state.lastFlushedDay}`,
          );
        },
      ),
    );
  });

  it("written snapshot count equals closedDays × WINDOW_KEYS.length", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Gap between 1 and 3 days from already flushed
        fc.nat({ min: 1, max: 3 }),
        async (gapDays) => {
          const BASE_DAY = 1700000000n - (1700000000n % SECONDS_PER_DAY);
          const lastFlushedDay = BASE_DAY;
          // Event is (gapDays + 1) day(s) ahead, so closedDays == gapDays
          const blockTimestamp =
            BASE_DAY + BigInt(gapDays + 1) * SECONDS_PER_DAY + 3600n;

          const { context, store } = makeV3Context();
          store.LeaderboardChainState.set(`${CHAIN}`, {
            id: `${CHAIN}`,
            chainId: CHAIN,
            lastFlushedDay,
            lastFlushedDayBroker: 0n,
            updatedAtTimestamp: 0n,
          });

          await maybeHeartbeatFlushV3({
            context,
            chainId: CHAIN,
            blockTimestamp,
            blockNumber: 1n,
          });

          const expectedSnapshots = gapDays * WINDOW_KEYS.length;
          assert.equal(
            store.LeaderboardWindowSnapshot.size,
            expectedSnapshots,
            `expected ${expectedSnapshots} snapshots for ${gapDays} closed day(s), got ${store.LeaderboardWindowSnapshot.size}`,
          );
        },
      ),
    );
  });
});
