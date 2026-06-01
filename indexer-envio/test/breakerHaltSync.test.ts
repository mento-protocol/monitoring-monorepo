import assert from "node:assert/strict";
import type { Breaker, BreakerConfig, Pool, RateFeedDependency } from "envio";
import {
  breakerTrippedOnFeedAssign,
  clearPoolsBreakerHalt,
  makeRateFeedDependencyId,
  syncHaltOnColdStart,
  syncPoolsBreakerHalt,
} from "../src/breakers.ts";

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

function makePool(
  id: string,
  breakerTripped: boolean,
  source = "fpmm_factory",
): Pool {
  return {
    id,
    chainId: CHAIN,
    referenceRateFeedID: FEED,
    breakerTripped,
    source,
  } as unknown as Pool;
}

function makeDep(rateFeedID: string, dependsOn: string): RateFeedDependency {
  return {
    id: makeRateFeedDependencyId(CHAIN, rateFeedID, dependsOn),
    chainId: CHAIN,
    rateFeedID,
    dependsOn,
  };
}

function makeCtx(opts: {
  configs: BreakerConfig[];
  breakers: Breaker[];
  pools: Pool[];
  deps?: RateFeedDependency[];
}) {
  const pools = new Map(opts.pools.map((p) => [p.id, { ...p }]));
  const breakers = new Map(opts.breakers.map((b) => [b.id, b]));
  const deps = new Map((opts.deps ?? []).map((d) => [d.id, { ...d }]));
  const sets: Pool[] = [];
  const ctx = {
    BreakerConfig: {
      getWhere: async ({ rateFeedID }: { rateFeedID: { _eq: string } }) =>
        opts.configs.filter((c) => c.rateFeedID === rateFeedID._eq),
    },
    Breaker: {
      get: async (id: string) => breakers.get(id),
    },
    // Single-field getWhere on either edge field (forward: deps of a feed;
    // reverse: dependents of a feed), mirroring the Envio query surface.
    RateFeedDependency: {
      getWhere: async (where: {
        rateFeedID?: { _eq: string };
        dependsOn?: { _eq: string };
      }) =>
        [...deps.values()].filter((d) =>
          where.rateFeedID
            ? d.rateFeedID === where.rateFeedID._eq
            : where.dependsOn
              ? d.dependsOn === where.dependsOn._eq
              : true,
        ),
      set: (d: RateFeedDependency) => deps.set(d.id, d),
      deleteUnsafe: (id: string) => deps.delete(id),
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
  return { ctx, pools, sets, deps };
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

  it("skips VirtualPools (v2) — they stay N/A, never marked halted", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, false, "virtual_pool_factory")],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 0, "VP must not be written");
  });
});

describe("clearPoolsBreakerHalt", () => {
  it("forces breakerTripped=false even while configs stay TRIPPED (feed removed)", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      // Configs remain TRIPPED (historical record after RateFeedRemoved) — a
      // recompute would re-derive true, so clear must NOT recompute.
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, true)],
    });
    await clearPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 1);
  });

  it("is a no-op when the pool is already not halted", async () => {
    const { ctx, sets } = makeCtx({
      breakers: [],
      configs: [],
      pools: [makePool(POOL_A, false)],
    });
    await clearPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(sets.length, 0);
  });

  it("fans out to every pool on the feed", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [],
      configs: [],
      pools: [makePool(POOL_A, true), makePool(POOL_B, true)],
    });
    await clearPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(pools.get(POOL_B)?.breakerTripped, false);
  });

  it("skips VirtualPools (never written)", async () => {
    const { ctx, sets } = makeCtx({
      breakers: [],
      configs: [],
      pools: [makePool(POOL_A, true, "virtual_pool_factory")],
    });
    await clearPoolsBreakerHalt(ctx, CHAIN, FEED);
    assert.equal(sets.length, 0, "VP must not be written");
  });
});

describe("syncHaltOnColdStart", () => {
  it("recomputes halt when shouldSync is true (cold-start bootstrap)", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, false)],
    });
    await syncHaltOnColdStart(ctx, CHAIN, FEED, true);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
  });

  it("is a no-op when shouldSync is false (configs already existed)", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [makePool(POOL_A, false)],
    });
    await syncHaltOnColdStart(ctx, CHAIN, FEED, false);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 0, "no recompute when not a cold-start");
  });
});

describe("breakerTrippedOnFeedAssign", () => {
  const trippedCtx = () =>
    makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [makeConfig({ status: "TRIPPED", breaker_id: "breaker-md" })],
      pools: [],
    }).ctx;
  type ExistingArg = Parameters<typeof breakerTrippedOnFeedAssign>[2];
  const existing = (over: Partial<ExistingArg>): ExistingArg =>
    ({
      referenceRateFeedID: "",
      breakerTripped: false,
      source: "fpmm_factory",
      wrappedExchangeId: "",
      ...over,
    }) as ExistingArg;

  it("marks halted on the ''→assigned transition when the feed is tripped", async () => {
    assert.equal(
      await breakerTrippedOnFeedAssign(trippedCtx(), CHAIN, existing({}), FEED),
      true,
    );
  });

  it("preserves the flag when the feed was already assigned (no recompute)", async () => {
    assert.equal(
      await breakerTrippedOnFeedAssign(
        trippedCtx(),
        CHAIN,
        existing({ referenceRateFeedID: FEED, breakerTripped: false }),
        FEED,
      ),
      false,
    );
  });

  it("preserves the flag when no feed is assigned (next is '')", async () => {
    assert.equal(
      await breakerTrippedOnFeedAssign(
        trippedCtx(),
        CHAIN,
        existing({ breakerTripped: true }),
        "",
      ),
      true,
    );
  });

  it("skips VirtualPools — never recomputes (stays N/A)", async () => {
    assert.equal(
      await breakerTrippedOnFeedAssign(
        trippedCtx(),
        CHAIN,
        existing({ source: "virtual_pool_factory" }),
        FEED,
      ),
      false,
    );
  });
});

// Dependency-driven halts (#712): on-chain getRateFeedTradingMode ORs in each
// dependency feed's OWN trading mode (one level). `syncPoolsBreakerHalt` fans a
// trip/reset on a dependency feed out to every dependent feed's pools.
describe("syncPoolsBreakerHalt — dependency fan-out", () => {
  // DEP_FEED (Y) is a dependency of FEED (X); POOL_A lives on FEED (X).
  const DEP_FEED = "0xdddd000000000000000000000000000000000001";

  it("marks the dependent feed's pools tripped when a dependency trips", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      // The dependency's OWN config is tripped; FEED (X) has no own config.
      configs: [
        makeConfig({
          rateFeedID: DEP_FEED,
          status: "TRIPPED",
          breaker_id: "breaker-md",
        }),
      ],
      pools: [makePool(POOL_A, false)],
      deps: [makeDep(FEED, DEP_FEED)], // X depends on Y
    });
    // A breaker event fires on the DEPENDENCY (Y) — the fan-out must reach X.
    await syncPoolsBreakerHalt(ctx, CHAIN, DEP_FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true);
  });

  it("does NOT propagate a MARKET_HOURS dependency trip (weekend != fault)", async () => {
    const { ctx, pools, sets } = makeCtx({
      breakers: [makeBreaker("breaker-mh", "MARKET_HOURS")],
      configs: [
        makeConfig({
          rateFeedID: DEP_FEED,
          status: "TRIPPED",
          breaker_id: "breaker-mh",
        }),
      ],
      pools: [makePool(POOL_A, false)],
      deps: [makeDep(FEED, DEP_FEED)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, DEP_FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
    assert.equal(sets.length, 0, "no-op: MARKET_HOURS excluded on deps too");
  });

  it("clears the dependent's inherited halt when the dependency resets", async () => {
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [
        makeConfig({
          rateFeedID: DEP_FEED,
          status: "OK",
          breaker_id: "breaker-md",
        }),
      ],
      pools: [makePool(POOL_A, true)], // currently halted via the dependency
      deps: [makeDep(FEED, DEP_FEED)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, DEP_FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, false);
  });

  it("does not propagate beyond one hop (a dependent's dependents are untouched)", async () => {
    // Z depends on X, X depends on Y. Y trips. X must halt; Z must NOT — on-chain
    // resolution is one level, and X's OWN mode (read by Z) is unaffected by Y.
    const Z_FEED = "0xeeee000000000000000000000000000000000002";
    const POOL_ON_Z = `${CHAIN}-0xaaa0000000000000000000000000000000000009`;
    const { ctx, pools } = makeCtx({
      breakers: [makeBreaker("breaker-md", "MEDIAN_DELTA")],
      configs: [
        makeConfig({
          rateFeedID: DEP_FEED,
          status: "TRIPPED",
          breaker_id: "breaker-md",
        }),
      ],
      pools: [
        makePool(POOL_A, false), // on FEED (X)
        { ...makePool(POOL_ON_Z, false), referenceRateFeedID: Z_FEED } as Pool,
      ],
      deps: [makeDep(FEED, DEP_FEED), makeDep(Z_FEED, FEED)],
    });
    await syncPoolsBreakerHalt(ctx, CHAIN, DEP_FEED);
    assert.equal(pools.get(POOL_A)?.breakerTripped, true, "X (depends on Y)");
    assert.equal(
      pools.get(POOL_ON_Z)?.breakerTripped,
      false,
      "Z (depends on X) is one hop too far",
    );
  });
});
