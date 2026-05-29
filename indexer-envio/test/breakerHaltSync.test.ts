import assert from "node:assert/strict";
import type { Breaker, BreakerConfig, Pool } from "envio";
import { syncPoolsBreakerHalt } from "../src/breakers.ts";

// syncPoolsBreakerHalt recomputes Pool.breakerTripped = "the feed has >=1
// enabled, non-MARKET_HOURS BreakerConfig in TRIPPED state" and writes the
// change to every pool on the feed. Tested as a pure function against a
// hand-rolled context (Maps) to avoid the mockDb multi-id-set caveat and to
// exercise the OR / MARKET_HOURS-exclusion / no-op-on-unchanged logic directly.

const CHAIN = 42220;
const OTHER_CHAIN = 143;
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a"; // lowercased
const POOL_A = `${CHAIN}-0xaaa0000000000000000000000000000000000001`;
const POOL_B = `${CHAIN}-0xaaa0000000000000000000000000000000000002`;

type Ctx = Parameters<typeof syncPoolsBreakerHalt>[0];

function makeBreaker(id: string, kind: Breaker["kind"]): Breaker {
  return { id, kind } as unknown as Breaker;
}

function makeConfig(over: Partial<BreakerConfig>): BreakerConfig {
  return {
    chainId: CHAIN,
    rateFeedID: FEED,
    enabled: true,
    status: "OK",
    breaker_id: "breaker-md",
    ...over,
  } as unknown as BreakerConfig;
}

function makePool(id: string, breakerTripped: boolean): Pool {
  return {
    id,
    chainId: CHAIN,
    referenceRateFeedID: FEED,
    breakerTripped,
  } as unknown as Pool;
}

function makeCtx(opts: {
  configs: BreakerConfig[];
  breakers: Breaker[];
  pools: Pool[];
}) {
  const pools = new Map(opts.pools.map((p) => [p.id, { ...p }]));
  const breakers = new Map(opts.breakers.map((b) => [b.id, b]));
  const sets: Pool[] = [];
  const ctx = {
    BreakerConfig: {
      getWhere: async ({ rateFeedID }: { rateFeedID: { _eq: string } }) =>
        opts.configs.filter((c) => c.rateFeedID === rateFeedID._eq),
    },
    Breaker: {
      get: async (id: string) => breakers.get(id),
    },
    Pool: {
      get: async (id: string) => pools.get(id),
      getWhere: async ({
        referenceRateFeedID,
      }: {
        referenceRateFeedID: { _eq: string };
      }) =>
        [...pools.values()].filter(
          (p) => p.referenceRateFeedID === referenceRateFeedID._eq,
        ),
      set: (p: Pool) => {
        pools.set(p.id, p);
        sets.push(p);
      },
    },
  } as unknown as Ctx;
  return { ctx, pools, sets };
}

describe("syncPoolsBreakerHalt", () => {
  it("marks the pool tripped when an enabled MEDIAN_DELTA breaker is TRIPPED", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
    assert.equal(sets.length, 1);
  });

  it("marks tripped for a VALUE_DELTA breaker too", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-vd", "VALUE_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-vd" })],
      pools: [makePool(POOL_A, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
  });

  it("does NOT trip on a MARKET_HOURS breaker (weekend closure is not a fault)", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-mh", "MARKET_HOURS")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-mh" })],
      pools: [makePool(POOL_A, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 0, "no-op: value unchanged");
  });

  it("price breaker tripped wins even when MARKET_HOURS is also tripped", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [
        makeBreaker("breaker-md", "MEDIAN_DELTA"),
        makeBreaker("breaker-mh", "MARKET_HOURS"),
      ],
      configs: [
        makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" }),
        makeConfig({ status: "TRIPPED", breaker_id: "breaker-mh" }),
      ],
      pools: [makePool(POOL_A, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
  });

  it("ignores a DISABLED tripped breaker", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [
        makeConfig({
          status: "TRIPPED",
          enabled: false,
          breaker_id: "breaker-md",
        }),
      ],
      pools: [makePool(POOL_A, true)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
  });

  it("clears the halt when the breaker resets to OK", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "OK", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, true)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
  });

  it("fans out to every pool on the feed", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, false), makePool(POOL_B, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
    assert.equal(pools.get(POOL_B)?.breakerTripped, true);
  });

  it("is a no-op when the pool already matches (no redundant write)", async () => {
    const { ctx, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, true)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(sets.length, 0);
  });

  it("ignores a tripped config on a different chain (multichain feed reuse)", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [
        makeConfig({
          status: "TRIPPED",
          chainId: OTHER_CHAIN,
          breaker_id: "breaker-md",
        }),
      ],
      pools: [makePool(POOL_A, false)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 0);
  });
});
