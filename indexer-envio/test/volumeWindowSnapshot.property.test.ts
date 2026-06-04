/**
 * Property-based tests for volumeWindowSnapshot + volumeWindowFlush
 * bigint-math invariants.
 *
 * These complement the unit tests in volumeWindowSnapshot.test.ts by
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
 *  9. aggregatePerWindow: isProtocolActor is sticky-true (OR-accumulation)
 * 10. buildVolumeWindowSnapshot: totalVolumeUsdWei = sum of organic aggregates
 * 11. buildVolumeWindowSnapshot: uniqueTraders <= uniqueTradersIncludingProtocolActors
 * 12. buildVolumeWindowSnapshot: firstDayExclusiveUniqueTraders <= uniqueTraders
 * 13. buildVolumeWindowSnapshot: totalVolumeUsdWei <= totalVolumeUsdWeiIncludingProtocolActors
 * 14. buildVolumeWindowSnapshot: id has deterministic format
 * 15. maybeHeartbeatFlushV3: never decreases lastFlushedDay
 * 16. maybeHeartbeatFlushV3: written snapshot count = closed days × WINDOW_KEYS length
 */

import { describe, it } from "vitest";
import { strict as assert } from "assert";
import * as fc from "fast-check";
import type {
  VolumeChainState,
  VolumeWindowSnapshot,
  TraderDailySnapshot,
} from "envio";
import {
  WINDOW_KEYS,
  aggregatePerWindow,
  buildVolumeWindowSnapshot,
  windowStartDay,
  type TraderDailyRow,
  type TraderWindowAggregate,
} from "../src/volumeWindowSnapshot.js";
import {
  maybeHeartbeatFlushV3,
  type V3FlushContext,
} from "../src/volumeWindowFlush.js";
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
    isProtocolActor: fc.boolean(),
  });
}

/** Build a TraderWindowAggregate with neutral first-day defaults. */
function arbAggregate(): fc.Arbitrary<TraderWindowAggregate> {
  return fc.record({
    trader: arbAddress(),
    volumeUsdWei: arbAmount,
    swapCount: arbSwapCount,
    isProtocolActor: fc.boolean(),
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
          .chain((baseRows) =>
            // Pair the base rows with a fast-check-controlled permutation so
            // that a failure is fully reproducible from the seed alone.
            fc
              .shuffledSubarray(baseRows, { minLength: baseRows.length })
              .map((shuffledRows) => ({ baseRows, shuffledRows })),
          ),
        (snapshotDay, { baseRows, shuffledRows }) => {
          // Give all rows a timestamp = snapshotDay so they land in every
          // window except 24h (which is always empty by construction).
          const rows: TraderDailyRow[] = baseRows.map((r) => ({
            ...r,
            timestamp: snapshotDay,
          }));
          const shuffled: TraderDailyRow[] = shuffledRows.map((r) => ({
            ...r,
            timestamp: snapshotDay,
          }));

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
            isProtocolActor: false,
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
            isProtocolActor: false,
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
              isProtocolActor: false,
            },
            {
              chainId: CHAIN,
              trader,
              timestamp: ts2,
              volumeUsdWei: vol2,
              swapCount: swaps2,
              isProtocolActor: false,
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
// 9. aggregatePerWindow: isProtocolActor is sticky-true
// ---------------------------------------------------------------------------
describe("aggregatePerWindow — isProtocolActor sticky-true", () => {
  it("if any day marks a trader as a protocol actor, the aggregate is marked protocol actor", () => {
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
              isProtocolActor: true,
            },
            {
              chainId: CHAIN,
              trader,
              timestamp: snapshotDay,
              volumeUsdWei: 1n,
              swapCount: 1,
              isProtocolActor: false,
            },
          ];
          const grouped = aggregatePerWindow(rows, CHAIN, snapshotDay);
          const allAgg = grouped["all"].find((a) => a.trader === trader);
          assert(allAgg, "trader must appear in 'all' window");
          assert.equal(
            allAgg.isProtocolActor,
            true,
            "isProtocolActor must be sticky-true",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. buildVolumeWindowSnapshot: totalVolumeUsdWei = sum of organic
// ---------------------------------------------------------------------------
describe("buildVolumeWindowSnapshot — volume sum invariant", () => {
  it("totalVolumeUsdWei equals the sum of volumeUsdWei for organic aggregates", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildVolumeWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          const expectedVol = aggregates
            .filter((a) => !a.isProtocolActor)
            .reduce((acc, a) => acc + a.volumeUsdWei, 0n);
          assert.equal(
            snap.totalVolumeUsdWei,
            expectedVol,
            "totalVolumeUsdWei must exclude protocol-owned addresses",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. buildVolumeWindowSnapshot: uniqueTraders <= uniqueTradersIncludingProtocolActors
// ---------------------------------------------------------------------------
describe("buildVolumeWindowSnapshot — trader count ordering", () => {
  it("uniqueTraders is always <= uniqueTradersIncludingProtocolActors", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildVolumeWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          assert(
            snap.uniqueTraders <= snap.uniqueTradersIncludingProtocolActors,
            `uniqueTraders (${snap.uniqueTraders}) > uniqueTradersIncludingProtocolActors (${snap.uniqueTradersIncludingProtocolActors})`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 12. buildVolumeWindowSnapshot: firstDayExclusiveUniqueTraders <= uniqueTraders
// ---------------------------------------------------------------------------
describe("buildVolumeWindowSnapshot — exclusive count bounded by unique count", () => {
  it("firstDayExclusiveUniqueTraders is always <= uniqueTraders", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(
          fc.record({
            trader: arbAddress(),
            volumeUsdWei: arbAmount,
            swapCount: arbSwapCount,
            isProtocolActor: fc.constant(false), // only organic for simplicity
            firstDayVolumeUsdWei: fc.constant(0n),
            firstDaySwapCount: fc.constant(0),
            activeOutsideFirstDay: fc.boolean(),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (snapshotDay, aggregates) => {
          const snap = buildVolumeWindowSnapshot({
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
// 13. buildVolumeWindowSnapshot: primary volume <= includingSystem volume
// ---------------------------------------------------------------------------
describe("buildVolumeWindowSnapshot — primary volume <= includingSystem volume", () => {
  it("totalVolumeUsdWei is always <= totalVolumeUsdWeiIncludingProtocolActors", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.array(arbAggregate(), { minLength: 0, maxLength: 20 }),
        (snapshotDay, aggregates) => {
          const snap = buildVolumeWindowSnapshot({
            chainId: CHAIN,
            windowKey: "all",
            snapshotDay,
            windowStartDay: 0n,
            aggregates,
            blockNumber: 1n,
            updatedAtTimestamp: 1n,
          });
          assert(
            snap.totalVolumeUsdWei <=
              snap.totalVolumeUsdWeiIncludingProtocolActors,
            "primary volume exceeds includingSystem volume",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 14. buildVolumeWindowSnapshot: deterministic ID format
// ---------------------------------------------------------------------------
describe("buildVolumeWindowSnapshot — deterministic ID", () => {
  it("id always follows the pattern '{chainId}-{windowKey}-{snapshotDay}'", () => {
    fc.assert(
      fc.property(
        arbDayTimestamp,
        fc.constantFrom(...WINDOW_KEYS),
        (snapshotDay, windowKey) => {
          const snap = buildVolumeWindowSnapshot({
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
    VolumeWindowSnapshot: Map<string, VolumeWindowSnapshot>;
    VolumeChainState: Map<string, VolumeChainState>;
  };
} {
  const store = {
    VolumeWindowSnapshot: new Map<string, VolumeWindowSnapshot>(),
    VolumeChainState: new Map<string, VolumeChainState>(),
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
      VolumeChainState: wrap(store.VolumeChainState),
      VolumeWindowSnapshot: wrap(store.VolumeWindowSnapshot),
    },
    store,
  };
}

describe("maybeHeartbeatFlushV3 — monotone lastFlushedDay", () => {
  it("lastFlushedDay never decreases after a heartbeat", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Pick a gap of 0–4 days already flushed, then an event 1–3 days further.
        // fc.nat only accepts {max}, so use fc.integer to enforce a lower bound.
        fc.nat({ max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        async (alreadyFlushedDays, newDaysGap) => {
          const BASE_DAY = 1700000000n - (1700000000n % SECONDS_PER_DAY); // deterministic day
          const lastFlushedDay =
            BASE_DAY + BigInt(alreadyFlushedDays) * SECONDS_PER_DAY;
          const blockTimestamp =
            BASE_DAY +
            BigInt(alreadyFlushedDays + newDaysGap + 1) * SECONDS_PER_DAY +
            3600n; // mid next day

          const { context, store } = makeV3Context();
          store.VolumeChainState.set(`${CHAIN}`, {
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

          const state = store.VolumeChainState.get(`${CHAIN}`);
          assert(state, "VolumeChainState must be written");
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
          store.VolumeChainState.set(`${CHAIN}`, {
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
            store.VolumeWindowSnapshot.size,
            expectedSnapshots,
            `expected ${expectedSnapshots} snapshots for ${gapDays} closed day(s), got ${store.VolumeWindowSnapshot.size}`,
          );
        },
      ),
    );
  });
});
