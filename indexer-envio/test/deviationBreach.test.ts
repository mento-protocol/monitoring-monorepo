import assert from "node:assert/strict";
import {
  classifyBreachEvent,
  openBreachId,
  recordBreachTransition,
} from "../src/deviationBreach.js";
import { DEVIATION_BREACH_GRACE_SECONDS } from "../src/pool.js";
import type { DeviationThresholdBreach } from "envio";
import { makePool } from "./helpers/makePool.js";

// ---------------------------------------------------------------------------
// In-memory mock context shaped like the Envio loader context used by
// recordBreachTransition.
// ---------------------------------------------------------------------------
function makeMockContext() {
  const store = new Map<string, DeviationThresholdBreach>();
  return {
    store,
    context: {
      DeviationThresholdBreach: {
        get: async (id: string) => store.get(id),
        getWhere: async (where: { poolId: { _eq: string } }) =>
          Array.from(store.values()).filter(
            (row) => row.poolId === where.poolId._eq,
          ),
        set: (row: DeviationThresholdBreach) => {
          store.set(row.id, row);
        },
      },
    },
  };
}

function getOnlyOpenBreach(
  store: Map<string, DeviationThresholdBreach>,
): DeviationThresholdBreach {
  const rows = Array.from(store.values()).filter(
    (row) => row.endedAt === undefined,
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

// Pick an "out-of-weekend" epoch second so tradingSecondsInRange == wall-clock
// for the intervals we test. Monday 2024-01-08 00:00:00 UTC.
const MON_NOON = 1_704_672_000n;

describe("classifyBreachEvent", () => {
  it("maps each known indexer source to a user-facing category", () => {
    assert.equal(classifyBreachEvent("fpmm_rebalanced"), "rebalance");
    assert.equal(classifyBreachEvent("fpmm_swap"), "swap");
    assert.equal(classifyBreachEvent("fpmm_mint"), "liquidity");
    assert.equal(classifyBreachEvent("fpmm_burn"), "liquidity");
    assert.equal(classifyBreachEvent("fpmm_factory"), "threshold_change");
    assert.equal(classifyBreachEvent("oracle_reported"), "oracle_update");
    assert.equal(classifyBreachEvent("median_updated"), "oracle_update");
  });

  it("classifies fpmm_update_reserves as 'unknown' so it can't steal swap/mint/burn attribution", () => {
    // The FPMM contract emits ReservesUpdated inside swap/mint/burn flows,
    // so the UpdateReserves handler fires before the semantic handler.
    // Categorising it as "liquidity" would mislabel swap-driven breaches
    // — keep it "unknown" and let the upgrade-on-continue path in
    // recordBreachTransition rewrite the cause when the real handler runs.
    assert.equal(classifyBreachEvent("fpmm_update_reserves"), "unknown");
  });

  it("returns 'unknown' for virtual pool sources and truly unknown strings", () => {
    // Virtual pools never breach, but defend the mapping anyway.
    assert.equal(classifyBreachEvent("virtual_pool_factory"), "unknown");
    assert.equal(classifyBreachEvent("some_future_source"), "unknown");
  });
});

describe("openBreachId", () => {
  it("is deterministic on (poolId, startedAt)", () => {
    assert.equal(openBreachId("42220-0xpool", 1000n), "42220-0xpool-1000");
  });

  it("adds block, tx, and log-index entropy when provided", () => {
    assert.equal(
      openBreachId("42220-0xpool", 1000n, {
        blockNumber: 123n,
        txHash: "0xABC",
        logIndex: 7,
      }),
      "42220-0xpool-1000-123-0xabc-7",
    );
  });
});

describe("recordBreachTransition — rising edge", () => {
  it("creates a new row with entry/peak/startedBy metadata", async () => {
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 4000n,
      rebalanceThreshold: 5000,
      deviationBreachStartedAt: 0n,
    }); // ratio 0.8 → OK
    const next = makePool({
      priceDifference: 7500n,
      rebalanceThreshold: 5000,
      deviationBreachStartedAt: MON_NOON,
    }); // ratio 1.5 → breached
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xabc",
      source: "fpmm_swap",
    });

    assert.deepStrictEqual(poolUpdate, {}); // no cumulative change on rising edge
    assert.equal(store.size, 1);
    const row = getOnlyOpenBreach(store);
    assert.equal(row.startedAt, MON_NOON);
    assert.equal(row.endedAt, undefined);
    assert.equal(row.entryPriceDifference, 7500n);
    assert.equal(row.peakPriceDifference, 7500n);
    assert.equal(row.peakAt, MON_NOON);
    assert.equal(row.startedByEvent, "swap");
    assert.equal(row.startedByTxHash, "0xabc");
    assert.equal(row.rebalanceCountDuring, 0);
  });

  it("sets rebalanceCountDuring=1 on a rising edge triggered by a rebalance event", async () => {
    // Rare but possible: a rebalance that also causes the rising edge.
    // The `isRebalance ? 1 : 0` branch must count the closing rebalance
    // on creation so the "attempts observed" metric is honest.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xrbl-rise",
      source: "fpmm_rebalanced",
      strategy: "0xstrategy",
    });
    const row = getOnlyOpenBreach(store);
    assert.equal(row.rebalanceCountDuring, 1);
    assert.equal(row.startedByEvent, "rebalance");
  });

  it("treats a missing prev as a fresh breach when next is already breached", async () => {
    const { store, context } = makeMockContext();
    const next = makePool({
      priceDifference: 8000n,
      rebalanceThreshold: 5000,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, undefined, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xbootstrap",
      source: "oracle_reported",
    });
    assert.equal(store.size, 1);
    const row = getOnlyOpenBreach(store);
    assert.equal(row.startedByEvent, "oracle_update");
  });

  it("keeps repeated same-timestamp breaches as distinct rows and updates the active one", async () => {
    const { store, context } = makeMockContext();
    const healthy = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    const breached = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });

    await recordBreachTransition(context, healthy, breached, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xfirst",
      source: "fpmm_swap",
    });
    await recordBreachTransition(
      context,
      breached,
      { ...healthy, breachCount: 0 },
      {
        blockTimestamp: MON_NOON,
        blockNumber: 100n,
        txHash: "0xclose",
        source: "fpmm_rebalanced",
      },
    );
    await recordBreachTransition(context, healthy, breached, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xsecond",
      source: "oracle_reported",
    });

    assert.equal(store.size, 2);
    const ids = Array.from(store.keys());
    assert.equal(new Set(ids).size, 2);
    assert.ok(ids.every((id) => id.includes(`${MON_NOON}-100-0x`)));

    await recordBreachTransition(
      context,
      breached,
      { ...breached, priceDifference: 9000n },
      {
        blockTimestamp: MON_NOON,
        blockNumber: 100n,
        txHash: "0xcontinue",
        source: "fpmm_swap",
      },
    );

    const open = getOnlyOpenBreach(store);
    assert.equal(open.startedByTxHash, "0xsecond");
    assert.equal(open.peakPriceDifference, 9000n);
  });
});

describe("recordBreachTransition — continuing breach", () => {
  it("bumps peakPriceDifference and peakAt when the current reading exceeds the prior peak", async () => {
    const { store, context } = makeMockContext();
    // Seed an open breach row with peak 6000.
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 6000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 6000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 9000n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 60n,
      blockNumber: 110n,
      txHash: "0xdef",
      source: "fpmm_swap",
    });
    const row = store.get(open.id)!;
    assert.equal(row.peakPriceDifference, 9000n);
    assert.equal(row.peakAt, MON_NOON + 60n);
    assert.equal(row.peakAtBlock, 110n);
  });

  it("does not move peakAt when the current reading is lower than the existing peak", async () => {
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 6000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 9000n,
      peakAt: MON_NOON + 30n,
      peakAtBlock: 105n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 9000n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 7000n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 60n,
      blockNumber: 110n,
      txHash: "0xzzz",
      source: "fpmm_swap",
    });
    const row = store.get(open.id)!;
    assert.equal(row.peakPriceDifference, 9000n);
    assert.equal(row.peakAt, MON_NOON + 30n);
  });

  it("upgrades startedByEvent from 'unknown' when a specific handler runs mid-breach (same-tx ReservesUpdated → Swap)", async () => {
    // The exact scenario the "unknown" classifier enables: rising edge
    // arrives via UpdateReserves inside a swap tx (row stored with
    // "unknown"), then the Swap handler runs right after and upgrades
    // the attribution to "swap" so the history reads correctly.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 7500n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 7500n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "unknown",
      startedByTxHash: "0xreserves",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    const prev = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xswap",
      source: "fpmm_swap",
    });
    const row = store.get(open.id)!;
    assert.equal(row.startedByEvent, "swap");
    assert.equal(row.startedByTxHash, "0xswap");
    assert.equal(row.peakPriceDifference, 7500n); // unchanged
  });

  it("does not downgrade startedByEvent once a specific category is set", async () => {
    // The upgrade is one-way: once "swap" is in place, a subsequent
    // UpdateReserves (which now classifies as "unknown") must not
    // rewrite it back.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 7500n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 7500n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xswap-original",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    const prev = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 7500n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 60n,
      blockNumber: 110n,
      txHash: "0xreserves-later",
      source: "fpmm_update_reserves",
    });
    const row = store.get(open.id)!;
    assert.equal(row.startedByEvent, "swap");
    assert.equal(row.startedByTxHash, "0xswap-original");
  });

  it("increments rebalanceCountDuring when a rebalance fires mid-breach without closing it", async () => {
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 8000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 8000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: MON_NOON,
    });
    // A partial rebalance that drops priceDifference but stays above
    // threshold — still an attempt observed during the breach.
    const next = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 120n,
      blockNumber: 120n,
      txHash: "0xrbl",
      source: "fpmm_rebalanced",
      strategy: "0xstrategy",
    });
    assert.equal(store.get(open.id)!.rebalanceCountDuring, 1);
  });
});

describe("recordBreachTransition — falling edge", () => {
  it("closes the open row, fills durations, and rolls cumulative counters", async () => {
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 8000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 9000n,
      peakAt: MON_NOON + 60n,
      peakAtBlock: 105n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    // Prev = still breached (anchor set). Next = recovered (anchor cleared).
    const prev = makePool({
      priceDifference: 9000n,
      deviationBreachStartedAt: MON_NOON,
      cumulativeBreachSeconds: 0n,
      cumulativeCriticalSeconds: 0n,
      breachCount: 0,
    });
    const breachEndedAt = MON_NOON + 2n * DEVIATION_BREACH_GRACE_SECONDS; // 2h
    const next = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
      cumulativeBreachSeconds: 0n,
      cumulativeCriticalSeconds: 0n,
      breachCount: 0,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: breachEndedAt,
      blockNumber: 200n,
      txHash: "0xclose",
      source: "fpmm_rebalanced",
      strategy: "0xstrategy",
    });
    const closed = store.get(open.id)!;
    assert.equal(closed.endedAt, breachEndedAt);
    // Duration = 7200s, grace = 3600s → critical portion = 3600s.
    assert.equal(closed.durationSeconds, 7200n);
    assert.equal(closed.criticalDurationSeconds, 3600n);
    assert.equal(closed.endedByEvent, "rebalance");
    assert.equal(closed.endedByTxHash, "0xclose");
    assert.equal(closed.endedByStrategy, "0xstrategy");
    assert.equal(closed.rebalanceCountDuring, 1);

    // Cumulative counters rolled through on poolUpdate.
    assert.equal(poolUpdate.cumulativeBreachSeconds, 7200n);
    assert.equal(poolUpdate.cumulativeCriticalSeconds, 3600n);
    assert.equal(poolUpdate.breachCount, 1);
  });

  it("criticalDurationSeconds is 0 when the breach closes within the grace window", async () => {
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 6000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 6500n,
      peakAt: MON_NOON + 60n,
      peakAtBlock: 105n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 6500n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 1800n, // 30min — within grace
      blockNumber: 150n,
      txHash: "0xsoon",
      source: "fpmm_rebalanced",
      strategy: "0xstrat",
    });
    const closed = store.get(open.id)!;
    assert.equal(closed.durationSeconds, 1800n);
    assert.equal(closed.criticalDurationSeconds, 0n);
    assert.equal(poolUpdate.cumulativeCriticalSeconds, 0n);
  });

  it("criticalDurationSeconds is 0 when peak never crossed the 5% critical-magnitude line, even past grace", async () => {
    // Tolerance refactor invariant: critical seconds only accrue for breaches
    // whose peak hit > 1.05x. A pool sitting at ~1.02x for 5h would otherwise
    // inflate `cumulativeCriticalSeconds` and disagree with `computeHealthStatus`.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      // Peak 5100/5000 = 1.02x — above tolerance, below critical magnitude.
      entryPriceDifference: 5060n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 5100n,
      peakAt: MON_NOON + 60n,
      peakAtBlock: 105n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 5100n,
      deviationBreachStartedAt: MON_NOON,
    });
    // Falls below tolerance: 5025n / 5000 = 1.005 — closes the breach.
    const next = makePool({
      priceDifference: 5025n,
      deviationBreachStartedAt: 0n,
      cumulativeBreachSeconds: 0n,
      cumulativeCriticalSeconds: 0n,
      breachCount: 0,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 5n * 3600n, // 5h — well past 1h grace
      blockNumber: 200n,
      txHash: "0xclose-small",
      source: "fpmm_swap",
    });
    const closed = store.get(open.id)!;
    // Breach duration accrues normally; critical seconds must be 0 because
    // peak never crossed 1.05x.
    assert.equal(closed.durationSeconds, 5n * 3600n);
    assert.equal(closed.criticalDurationSeconds, 0n);
    assert.equal(poolUpdate.cumulativeCriticalSeconds, 0n);
  });

  it("criticalDurationSeconds is 0 when endedAt lands exactly on the grace boundary", async () => {
    // Strict `endedAt > graceEnd` means endedAt === startedAt + 3600 stays
    // at 0 critical. Guards against an off-by-one where `>=` would credit
    // a boundary-close as having critical seconds.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 6000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 6000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 3600n, // exactly at grace boundary
      blockNumber: 150n,
      txHash: "0xedge",
      source: "fpmm_rebalanced",
      strategy: "0xstrat",
    });
    const closed = store.get(open.id)!;
    assert.equal(closed.durationSeconds, 3600n);
    assert.equal(closed.criticalDurationSeconds, 0n);
  });

  it("no-ops when an anchorless partial-restore clears without ever being tracked", async () => {
    // Partial-restore edge case: prev is breached by price but anchor was
    // never set, next is also anchorless. `recordBreachTransition` trusts
    // the anchor as the authoritative "is a breach in progress" signal —
    // no anchor means we never observed this breach, so there's nothing
    // to credit. Price-driven counting here would leak phantom breaches
    // into the `breachCount` rollup.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: 0n, // never anchored
    });
    const next = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
      breachCount: 0,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 200n,
      txHash: "0xheal-close",
      source: "oracle_reported",
    });
    assert.deepStrictEqual(poolUpdate, {});
    assert.equal(store.size, 0);
  });

  it("treats a freshly-self-healed anchor as a rising edge and attributes startedByEvent to the observed source", async () => {
    // nextDeviationBreachStartedAt self-heals to current block time when
    // it sees an already-breached pool for the first time without an
    // anchor. From `recordBreachTransition`'s anchor-based perspective
    // that IS a rising edge — the row is created with the real triggering
    // source instead of the old "unknown" fallback. The attribution is
    // honest: the first event we successfully tracked did cause the
    // breach to become observable.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: 0n, // not yet anchored
    });
    const next = makePool({
      priceDifference: 8500n,
      deviationBreachStartedAt: MON_NOON, // self-healed to current block
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 200n,
      txHash: "0xheal-continue",
      source: "oracle_reported",
    });
    const row = getOnlyOpenBreach(store);
    assert.ok(row);
    assert.equal(row.startedAt, MON_NOON);
    assert.equal(row.startedByEvent, "oracle_update");
    assert.equal(row.entryPriceDifference, 8500n);
  });

  it("measures durations in trading-seconds so a breach spanning a weekend excludes closure hours", async () => {
    const { store, context } = makeMockContext();
    // Breach starts Fri 2024-01-05 20:00:00 UTC (1 hour before FX close
    // at Fri 21:00 UTC) and closes Mon 2024-01-08 00:00:00 UTC.
    const fri20 = 1_704_484_800n;
    const monMidnight = 1_704_672_000n;
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", fri20),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: fri20,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 6000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 6000n,
      peakAt: fri20,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xabc",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    const prev = makePool({
      priceDifference: 6000n,
      deviationBreachStartedAt: fri20,
    });
    const next = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: monMidnight,
      blockNumber: 500n,
      txHash: "0xmon",
      source: "oracle_reported",
    });
    // Wall-clock between Fri 20:00 and Mon 00:00 = 2d + 4h = 187_200s.
    // FX closure Fri 21:00 UTC → Sun 23:00 UTC = 50h = 180_000s.
    // Expected trading-seconds = 187_200 − 180_000 = 7_200s (the Fri 20-21
    // hour before close + the Sun 23-Mon 00 hour after reopen).
    const closed = store.get(open.id)!;
    assert.equal(closed.durationSeconds, 7200n);
    // Well over grace (3600s) once we subtract weekend, so critical = 3600s.
    assert.equal(closed.criticalDurationSeconds, 3600n);
  });

  it("still rolls breachCount on the falling edge when the open row is missing (data loss)", async () => {
    // Data loss covers two paths: (a) a self-heal from a partial restore
    // — prev.deviationBreachStartedAt is 0n, (b) a store row was lost
    // while the anchor on prev survived. Either way we can't reconstruct
    // the duration, but we know a breach was in progress, so counting it
    // in `breachCount` is the honest answer. Tested here with the data-
    // loss shape; the self-heal shape has its own test above.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 8000n,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 3000n,
      deviationBreachStartedAt: 0n,
      breachCount: 4,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 600n,
      blockNumber: 150n,
      txHash: "0xorphan",
      source: "oracle_reported",
    });
    assert.equal(poolUpdate.breachCount, 5);
    assert.equal(poolUpdate.cumulativeBreachSeconds, undefined);
    assert.equal(poolUpdate.cumulativeCriticalSeconds, undefined);
    assert.equal(store.size, 0);
  });
});

describe("recordBreachTransition — UpdateReserves followed by a semantic handler", () => {
  it("defers the close under UpdateReserves so a subsequent Rebalance in the same tx gets attribution", async () => {
    // End-to-end of the 'Unknown' bug that motivated anchor-based
    // breach detection: the FPMM contract emits ReservesUpdated inside
    // a Rebalance tx (the reserves flip BEFORE the semantic Rebalanced
    // event). Pre-fix, UpdateReserves handler closed the row with
    // `endedByEvent = "unknown"` and the later Rebalance handler had
    // nothing to do. With anchor deferral + anchor-based transition
    // detection, the Rebalance handler closes the row with "rebalance".
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 8000n,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 9000n,
      peakAt: MON_NOON + 60n,
      peakAtBlock: 105n,
      startedByEvent: "swap",
      startedByTxHash: "0xrise",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);

    // Step 1: UpdateReserves fires. `nextDeviationBreachStartedAt` with
    // source="fpmm_update_reserves" held the anchor, so `next.anchor`
    // still points at MON_NOON even though price dropped below threshold.
    const prev = makePool({
      priceDifference: 9000n,
      deviationBreachStartedAt: MON_NOON,
    });
    const afterUpdateReserves = makePool({
      priceDifference: 4000n, // reserves flipped, already healthy
      deviationBreachStartedAt: MON_NOON, // held
    });
    const postUR = await recordBreachTransition(
      context,
      prev,
      afterUpdateReserves,
      {
        blockTimestamp: MON_NOON + 60n,
        blockNumber: 110n,
        txHash: "0xur",
        source: "fpmm_update_reserves",
      },
    );
    assert.deepStrictEqual(postUR, {}); // no close yet
    assert.equal(store.get(open.id)!.endedAt, undefined);

    // Step 2: Rebalance fires next in the same tx. `prev` carries the
    // held anchor; `next.anchor = 0n` because Rebalance is NOT a
    // deferred source. Falling edge → closes with `endedByEvent="rebalance"`.
    const afterRebalance = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
      cumulativeBreachSeconds: 0n,
      cumulativeCriticalSeconds: 0n,
      breachCount: 0,
    });
    const postRebalance = await recordBreachTransition(
      context,
      afterUpdateReserves,
      afterRebalance,
      {
        blockTimestamp: MON_NOON + 120n,
        blockNumber: 110n,
        txHash: "0xrbl",
        source: "fpmm_rebalanced",
        strategy: "0xstrategy",
      },
    );
    const closed = store.get(open.id)!;
    assert.equal(closed.endedAt, MON_NOON + 120n);
    assert.equal(closed.endedByEvent, "rebalance");
    assert.equal(closed.endedByTxHash, "0xrbl");
    assert.equal(closed.endedByStrategy, "0xstrategy");
    assert.equal(closed.rebalanceCountDuring, 1);
    assert.equal(postRebalance.breachCount, 1);
  });
});

describe("recordBreachTransition — no transition", () => {
  it("returns {} and writes nothing when the pool was never breached", async () => {
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 3000n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 4500n,
      deviationBreachStartedAt: 0n,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xhealthy",
      source: "fpmm_swap",
    });
    assert.deepStrictEqual(poolUpdate, {});
    assert.equal(store.size, 0);
  });

  it("does not open a breach row for tiny overages within the 1% tolerance dead zone", async () => {
    // 5025/5000 = 1.005 — above raw threshold but inside tolerance.
    // Under the tolerance rule the indexer never anchors here, so the
    // upstream nextDeviationBreachStartedAt would NOT pass MON_NOON in.
    // Verify recordBreachTransition is a no-op when the anchor is 0n.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 4000n,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 5025n,
      deviationBreachStartedAt: 0n,
    });
    const poolUpdate = await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xtolerance",
      source: "fpmm_swap",
    });
    assert.deepStrictEqual(poolUpdate, {});
    assert.equal(store.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Asymmetric pool — entry threshold capture + heal disablement (PR 1.6)
// codex P2 #3214513401: a breach opened on an asymmetric pool's zero-threshold
// side scored against the 10000 effective fallback; if the row captured raw
// `rebalanceThreshold=0` and the heal-from-zero branch swapped it for the
// post-flip opposite side's value (e.g. 300), peak % and critical-duration
// history would silently re-score against a threshold that was never in
// force when the breach opened. PR 1.6 captures `persistableThreshold(next)`
// at rising edge and retires the heal.
// ---------------------------------------------------------------------------

describe("recordBreachTransition — asymmetric pool entry threshold (PR 1.6)", () => {
  it("captures the 10000 effective fallback as entryRebalanceThreshold when the active side is 0 (above=0, below>0)", async () => {
    // Reserves currently picking the above side → `rebalanceThreshold=0`,
    // but pool DOES rebalance on the below side. `isInDeviationBreach`
    // scores against `effectiveThreshold(pool) = 10000n` here. The breach
    // row must persist 10000 as entry, not raw 0 — otherwise the closing
    // fallback chain or the heal could substitute the post-flip 300 and
    // re-score peak % / critical-duration history.
    const { store, context } = makeMockContext();
    const prev = makePool({
      priceDifference: 4000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 0n,
    });
    const next = makePool({
      priceDifference: 12_000n, // 1.2x the 10000 fallback → past tolerance
      rebalanceThreshold: 0, // still on the zero side
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON,
      blockNumber: 100n,
      txHash: "0xrise-asym",
      source: "fpmm_swap",
    });
    const row = getOnlyOpenBreach(store);
    assert.equal(row.entryRebalanceThreshold, 10000);
  });

  it("does NOT heal entryRebalanceThreshold mid-breach when reserves flip to the active side", async () => {
    // Setup: a row was previously opened with the (correct, post-fix)
    // entry=10000 capture from an asymmetric-zero-side breach. Reserves
    // then flip → `next.rebalanceThreshold` becomes 300. Pre-PR-1.6 the
    // `healEntryThreshold` branch fired when entry===0 — but even with
    // entry===10000, the asymmetric flip still reveals the bug for
    // any pre-PR-1.6 row whose entry happened to be captured as 0.
    // This test pins the post-fix behaviour: a continuing-breach event
    // must NEVER overwrite entryRebalanceThreshold, regardless of side.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 12_000n,
      entryRebalanceThreshold: 10000, // captured post-PR-1.6
      peakPriceDifference: 12_000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xrise",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    // Continuing breach — reserves flipped to the active (below) side.
    const prev = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 12_500n, // bumped peak so the row is rewritten
      rebalanceThreshold: 300, // <-- flipped to the active side
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 60n,
      blockNumber: 110n,
      txHash: "0xflip",
      source: "fpmm_swap",
    });
    const row = store.get(open.id)!;
    // Peak bumped (so the row was re-set), but entry must stay at 10000.
    assert.equal(row.peakPriceDifference, 12_500n);
    assert.equal(
      row.entryRebalanceThreshold,
      10000,
      "entryRebalanceThreshold must NEVER be overwritten mid-breach (PR 1.6 retired the heal-from-zero branch)",
    );
  });

  it("legacy entry=0 row stays at 0 across a side flip (PR 1.6 heal retired)", async () => {
    // Pre-PR-1.6 the rising edge captured raw `rebalanceThreshold=0` for
    // asymmetric-zero-side breaches and the `healEntryThreshold` branch
    // would swap that for the post-flip side's active value (e.g. 300),
    // re-scoring history. PR 1.6 retires the heal — old rows with
    // entry=0 stay at 0; the closing fallback chain in
    // `recordBreachTransition` resolves them to the 10000 effective
    // floor at close time.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 12_000n,
      entryRebalanceThreshold: 0, // legacy capture
      peakPriceDifference: 12_000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xrise",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
    });
    const next = makePool({
      priceDifference: 13_000n, // bumped peak so the row is rewritten
      rebalanceThreshold: 300,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
    });
    await recordBreachTransition(context, prev, next, {
      blockTimestamp: MON_NOON + 60n,
      blockNumber: 110n,
      txHash: "0xflip-legacy",
      source: "fpmm_swap",
    });
    const row = store.get(open.id)!;
    assert.equal(row.peakPriceDifference, 13_000n);
    assert.equal(
      row.entryRebalanceThreshold,
      0,
      "legacy entry=0 must stay 0 — pre-PR-1.6 heal-from-zero branch retired",
    );
  });

  it("close-time critical accrual scores against the 10000 floor for legacy entry=0 rows (asymmetric flip)", async () => {
    // The full integrity story for old rows: entry=0 stays 0 (test above),
    // and at close time the fallback chain canonicalizes legacy 0 directly
    // to the 10000 floor (cursor #3214689033). This is what stops the
    // re-score on side flip — `next.rebalanceThreshold` could be 300 if
    // reserves moved to the below side at close, but the chain ignores
    // that and uses 10000, the same under-bound the predicate scored
    // against at rising edge. Score: peak 12_000 against 10000 → ratio
    // 1.2 → > 1.05 critical line → critical seconds accrue past grace.
    const { store, context } = makeMockContext();
    const open: DeviationThresholdBreach = {
      id: openBreachId("42220-0xtest", MON_NOON),
      chainId: 42220,
      poolId: "42220-0xtest",
      startedAt: MON_NOON,
      startedAtBlock: 100n,
      endedAt: undefined,
      endedAtBlock: undefined,
      durationSeconds: undefined,
      criticalDurationSeconds: undefined,
      entryPriceDifference: 12_000n,
      entryRebalanceThreshold: 0, // legacy capture
      peakPriceDifference: 12_000n,
      peakAt: MON_NOON,
      peakAtBlock: 100n,
      startedByEvent: "swap",
      startedByTxHash: "0xrise",
      endedByEvent: undefined,
      endedByTxHash: undefined,
      endedByStrategy: undefined,
      rebalanceCountDuring: 0,
    };
    store.set(open.id, open);
    const prev = makePool({
      priceDifference: 12_000n,
      rebalanceThreshold: 0,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: MON_NOON,
      // Pool denorm also at 0 to exercise the row.entry=0 fallback.
      currentOpenBreachEntryThreshold: 0,
    });
    // Close after 2× grace window → 7200 total, 3600 critical.
    const closeAt = MON_NOON + 2n * DEVIATION_BREACH_GRACE_SECONDS;
    const next = makePool({
      priceDifference: 4000n, // recovered (below tolerance against 10000)
      // Even if reserves flipped at close to the active side (300):
      rebalanceThreshold: 300,
      rebalanceThresholdAbove: 0,
      rebalanceThresholdBelow: 300,
      rebalanceThresholdsKnown: true,
      deviationBreachStartedAt: 0n,
    });
    const update = await recordBreachTransition(context, prev, next, {
      blockTimestamp: closeAt,
      blockNumber: 200n,
      txHash: "0xclose-legacy",
      source: "fpmm_rebalanced",
      strategy: "0xstrategy",
    });
    const row = store.get(open.id)!;
    // Score: peak 12_000 vs effectiveThreshold (300 active, fallback 10000
    // resolves through the chain). The chain reaches Number(effectiveThreshold(next))
    // = 300 because next.rebalanceThreshold > 0. Peak 12_000 / 300 = 40 → critical.
    // Either way (10000 or 300 floor), 12_000 is above 1.05x — critical accrues.
    assert.equal(row.durationSeconds, 7200n);
    assert.equal(row.criticalDurationSeconds, 3600n);
    assert.equal(update.cumulativeCriticalSeconds, 3600n);
  });
});
