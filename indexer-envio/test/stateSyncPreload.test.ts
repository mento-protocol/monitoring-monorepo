import assert from "node:assert/strict";
import type { Pool } from "envio";
import { makePoolId } from "../src/helpers.ts";
import { openBreachId } from "../src/deviationBreach.ts";
import {
  rebalanceIncentiveAtBlockEffect as ROW4,
  rebalancingStateEffect as ROW1,
  referenceRateFeedIDEffect as ROW3,
  reservesEffect,
} from "../src/rpc/effects.ts";
import { medianTimestampEffectForChain } from "../src/rpc/median-timestamp-effect.ts";
import { stateSyncHandlers } from "../src/handlers/fpmm/state-sync.ts";
import type {
  RebalancedEvent,
  UpdateReservesEvent,
} from "../src/handlers/fpmm/state-sync-effects.ts";
import { makePool } from "./helpers/makePool.ts";

// Stage 1 of docs/PLAN-indexer-preload-state-sync.md. The harness has no
// preload hook, so these tests drive the exported handler bodies in both
// phases against an in-memory context.

const CHAIN = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const POOL_ID = makePoolId(CHAIN, POOL);
const STRATEGY = "0x0000000000000000000000000000000000000099";
const TS = 1_700_010_000;
const E18 = 10n ** 18n;
const ROW2 = medianTimestampEffectForChain(CHAIN);
const ROWS_1_TO_4 = [ROW1, ROW2, ROW3, ROW4] as unknown[];

type Row = { id: string } & Record<string, unknown>;
type Call = { effect: unknown; input: unknown };
type Tables = Record<string, Map<string, Row>>;
type Event = UpdateReservesEvent | RebalancedEvent;

function effectResult(effect: unknown): unknown {
  if (effect === ROW1) {
    return {
      oraclePriceNumerator: E18,
      oraclePriceDenominator: E18,
      rebalanceThreshold: 5000,
      priceDifference: 100n,
    };
  }
  if (effect === ROW2) return BigInt(TS - 10);
  if (effect === ROW3) return "0xfeed";
  if (effect === ROW4) return 50;
  return null; // Row 5 and heal rows 6-11: no sample, no heal.
}

/** Every capitalized property is an in-memory entity table. */
function makeContext(isPreload: boolean, tables: Tables) {
  const calls: Call[] = [];
  const writes: string[] = [];
  const readIds: string[] = [];
  const rows = (name: string) => (tables[name] ??= new Map());
  const entity = (name: string) => ({
    get: async (id: string) => {
      const row = rows(name).get(id);
      if (row) readIds.push(row.id);
      return row;
    },
    getWhere: async (where: Record<string, { _eq: unknown }>) => {
      const found = [...rows(name).values()].filter((row) =>
        Object.entries(where).every(([key, cond]) => row[key] === cond._eq),
      );
      readIds.push(...found.map((row) => row.id));
      return found;
    },
    set: (row: Row) => {
      writes.push(name);
      rows(name).set(row.id, row);
    },
  });
  const noop = () => undefined;
  const base = {
    isPreload,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    effect: async (effect: unknown, input: unknown) => {
      calls.push({ effect, input });
      return effectResult(effect);
    },
  };
  const context = new Proxy(base, {
    get: (target, prop) =>
      prop in target
        ? target[prop as keyof typeof target]
        : entity(String(prop)),
  }) as unknown as Parameters<
    typeof stateSyncHandlers.Rebalanced
  >[0]["context"];
  return { calls, writes, readIds, context };
}

/** Healed pool that cannot derive (no live median), so rows 1-3 fire. */
function rpcPool(overrides: Partial<Pool> = {}): Pool {
  return makePool({
    id: POOL_ID,
    chainId: CHAIN,
    reserves0: 1_000n * E18,
    reserves1: 1_000n * E18,
    invertRateFeedKnown: true,
    tokenDecimalsKnown: true,
    rebalanceReward: 50,
    ...overrides,
  });
}

/** Pool whose ordered state derives the rebalance state locally. */
function derivablePool(overrides: Partial<Pool> = {}): Pool {
  return rpcPool({
    referenceRateFeedID: "0xfeed",
    lastMedianPrice: 10n ** 24n,
    medianLive: true,
    oracleExpiry: 1_000_000n,
    lastOracleReportAt: BigInt(TS - 10),
    ...overrides,
  });
}

function meta(logIndex: number, tx: string) {
  const transaction = { hash: `0x${tx.repeat(32)}`, from: STRATEGY };
  const block = { number: 500, timestamp: TS };
  return { chainId: CHAIN, srcAddress: POOL, logIndex, block, transaction };
}

const ur = (logIndex: number, r0: bigint, r1: bigint, tx: string): Event => ({
  ...meta(logIndex, tx),
  params: { reserve0: r0 * E18, reserve1: r1 * E18, blockTimestamp: 0n },
});

const rebalanced = (logIndex: number, tx: string): Event => ({
  ...meta(logIndex, tx),
  params: {
    sender: STRATEGY,
    priceDifferenceBefore: 6_000n,
    priceDifferenceAfter: 100n,
  },
});

async function run(event: Event, ctx: ReturnType<typeof makeContext>) {
  await ("reserve0" in event.params
    ? stateSyncHandlers.UpdateReserves({
        event: event as UpdateReservesEvent,
        context: ctx.context,
      })
    : stateSyncHandlers.Rebalanced({
        event: event as RebalancedEvent,
        context: ctx.context,
      }));
}

const tablesWith = (...rows: Row[]): Tables => ({
  Pool: new Map(rows.filter((r) => !("startedAt" in r)).map((r) => [r.id, r])),
  DeviationThresholdBreach: new Map(
    rows.filter((r) => "startedAt" in r).map((r) => [r.id, r]),
  ),
});

async function phases(event: Event, preload?: Pool, processing?: Pool) {
  const pre = makeContext(true, tablesWith(...(preload ? [preload] : [])));
  await run(event, pre);
  const proc = makeContext(false, tablesWith(processing as Pool));
  await run(event, proc);
  return { pre, proc };
}

const rowCalls = (calls: Call[]) =>
  calls.filter((call) => ROWS_1_TO_4.includes(call.effect));
const notPreloaded = (proc: Call[], pre: Call[]) =>
  rowCalls(proc).filter(
    (call) =>
      !pre.some((p) => p.effect === call.effect && isDeep(p.input, call.input)),
  );
function isDeep(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

describe("FPMM state-sync preload (plan stage 1)", () => {
  for (const event of [ur(3, 900n, 1_100n, "01"), rebalanced(5, "02")]) {
    const isUr = "reserve0" in event.params;
    it(`${isUr ? "UpdateReserves" : "Rebalanced"}: preload writes nothing and requests every processing key`, async () => {
      const { pre, proc } = await phases(event, rpcPool(), rpcPool());
      assert.deepEqual(pre.writes, []);
      const expected = isUr ? [ROW3, ROW1, ROW2] : [ROW3, ROW4, ROW1, ROW2];
      assert.deepEqual(
        new Set(rowCalls(proc.calls).map((c) => c.effect)),
        new Set(expected),
      );
      assert.deepEqual(notPreloaded(proc.calls, pre.calls), []);
    });
  }

  it("pays one serialized read per row when only ordered state opens the gate", async () => {
    // An earlier event in the batch left the median stale.
    const stale = derivablePool({ medianLive: false });
    const { pre, proc } = await phases(
      rebalanced(5, "03"),
      derivablePool(),
      stale,
    );
    assert.deepEqual(
      rowCalls(pre.calls).map((c) => c.effect),
      [ROW4],
    );
    const fallback = notPreloaded(proc.calls, pre.calls);
    assert.deepEqual(
      fallback.map((c) => c.effect),
      [ROW1, ROW2],
    );
    assert.deepEqual(fallback[0]?.input, {
      chainId: CHAIN,
      poolAddress: POOL,
      blockNumber: 500n,
    });
  });

  it("derives from a pool seeded earlier in the batch without the preloaded RPC", async () => {
    const { pre, proc } = await phases(
      ur(3, 900n, 1_100n, "04"),
      undefined,
      derivablePool(),
    );
    assert.deepEqual(
      new Set(rowCalls(pre.calls).map((c) => c.effect)),
      new Set([ROW3, ROW1, ROW2]),
    );
    assert.deepEqual(pre.writes, []);
    assert.deepEqual(rowCalls(proc.calls), []);
    assert.ok(proc.writes.includes("ReserveUpdate"));
  });

  it("requests no row 4 for a preloaded Pool with rebalanceReward = -2", async () => {
    const pool = rpcPool({ rebalanceReward: -2 });
    const { pre, proc } = await phases(rebalanced(5, "05"), pool, pool);
    for (const calls of [pre.calls, proc.calls]) {
      assert.equal(
        calls.some((c) => c.effect === ROW4),
        false,
      );
    }
    assert.ok(proc.writes.includes("RebalanceEvent"));
  });

  it("closes the breach as rebalance after 2x UpdateReserves -> Rebalanced with preload first", async () => {
    const startedAt = BigInt(TS - 3_600);
    const entropy = { blockNumber: 400n, txHash: "0xcd", logIndex: 1 };
    // Current rows carry event entropy; the legacy `${poolId}-${startedAt}`
    // key misses them.
    const breach = {
      id: openBreachId(POOL_ID, startedAt, entropy),
      poolId: POOL_ID,
      startedAt,
      endedAt: undefined,
      entryRebalanceThreshold: 5000,
      peakPriceDifference: 6_000n,
      rebalanceCountDuring: 0,
    } as Row;
    const pool = rpcPool({
      priceDifference: 6_000n,
      deviationBreachStartedAt: startedAt,
    });
    const tables = tablesWith(pool as unknown as Row, breach);
    const events = [
      ur(1, 950n, 1_050n, "ab"),
      ur(2, 900n, 1_100n, "ab"),
      rebalanced(3, "ab"),
    ];

    const pre = makeContext(true, tables);
    for (const event of events) await run(event, pre);
    assert.deepEqual(pre.writes, []);
    assert.ok(
      pre.readIds.includes(breach.id),
      "warm-up must find the current breach row",
    );

    const proc = makeContext(false, tables);
    for (const event of events) await run(event, proc);
    const closed = tables.DeviationThresholdBreach?.get(breach.id);
    assert.equal(closed?.endedByEvent, "rebalance");
    assert.equal(closed?.endedByStrategy, STRATEGY);
    const rebalance = [...(tables.RebalanceEvent?.values() ?? [])][0];
    assert.equal(rebalance?.amount0Delta, -100n * E18);
    assert.equal(rebalance?.amount1Delta, 100n * E18);
    // Pre-rebalance reserves come from the ordered same-tx scratch.
    assert.equal(
      proc.calls.some((c) => c.effect === reservesEffect),
      false,
    );
  });
});
