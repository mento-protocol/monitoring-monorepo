import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { OraclePriceDailySnapshot } from "envio";
import {
  sampleOutOfBand,
  upsertOraclePriceDaily,
  type OracleRollupContext,
} from "../src/pool.js";

// SortedOracles stores prices + breaker bands at 24dp; the rollup works on raw
// Fixidity values, so 1e24 represents "1.0".
const ONE = 10n ** 24n;
const SECONDS_PER_DAY = 86400n;

// ---------------------------------------------------------------------------
// sampleOutOfBand — bigint mirror of priceOutOfBand in oracle-chart.tsx
// ---------------------------------------------------------------------------

// Float reference: replicates the production chain verbatim
// (fixidityToFloat + the snapshotIsRed price-zero mapping + priceOutOfBand).
// The indexer is the bigint side; this is the float side it must agree with on
// any value where the float is unambiguous (i.e. away from its own rounding
// edge — at the exact band edge the bigint is authoritative, asserted below).
function floatVerdict(
  price: bigint,
  baseline: bigint,
  threshold: bigint,
): boolean | null {
  const b = Number(baseline) / 1e24;
  const t = Number(threshold) / 1e24;
  const p = price === 0n ? Number.NaN : Number(price) / 1e24;
  if (b === 0 || t === 0 || !Number.isFinite(p)) return null;
  return Math.abs(p - b) / b > t;
}

describe("sampleOutOfBand", () => {
  it("returns null (neutral) on a null or zero baseline", () => {
    assert.equal(sampleOutOfBand(2n * ONE, undefined, ONE / 100n), null);
    assert.equal(sampleOutOfBand(2n * ONE, 0n, ONE / 100n), null);
  });

  it("returns null (neutral) on a null or zero threshold", () => {
    assert.equal(sampleOutOfBand(2n * ONE, ONE, undefined), null);
    assert.equal(sampleOutOfBand(2n * ONE, ONE, 0n), null);
  });

  it("returns null (neutral) on a null or zero price (chart maps it to NaN)", () => {
    assert.equal(sampleOutOfBand(undefined, ONE, ONE / 100n), null);
    assert.equal(sampleOutOfBand(0n, ONE, ONE / 100n), null);
  });

  it("matches the exact band edge — strict greater-than, bigint authoritative", () => {
    // baseline = 1.0, threshold = 1%. |price - baseline|/baseline === threshold
    // exactly → NOT out of band (the float uses `>`, not `>=`).
    const baseline = ONE;
    const threshold = ONE / 100n; // 0.01
    const edgeDelta = threshold; // baseline * threshold / 1e24 = threshold when baseline = 1e24
    assert.equal(
      sampleOutOfBand(baseline + edgeDelta, baseline, threshold),
      false,
      "exactly at the edge is in-band",
    );
    assert.equal(
      sampleOutOfBand(baseline + edgeDelta + 1n, baseline, threshold),
      true,
      "one unit past the edge is out of band",
    );
    assert.equal(
      sampleOutOfBand(baseline + edgeDelta - 1n, baseline, threshold),
      false,
      "one unit short of the edge is in-band",
    );
    // Symmetric below the baseline.
    assert.equal(
      sampleOutOfBand(baseline - edgeDelta, baseline, threshold),
      false,
    );
    assert.equal(
      sampleOutOfBand(baseline - edgeDelta - 1n, baseline, threshold),
      true,
    );
  });

  it("agrees with the float formula across a swept range of bands + prices", () => {
    // Non-round baselines + thresholds exercise the cross-multiply; deviations
    // are set to threshold/4 (clearly in) and threshold*4 (clearly out), both
    // directions, so the float is unambiguous and the comparison is meaningful.
    const baselines = [ONE, 2n * ONE, ONE / 2n, (3n * ONE) / 7n];
    const thresholds = [ONE / 100n, ONE / 20n, ONE / 1000n];
    for (const b of baselines) {
      for (const t of thresholds) {
        const deltaIn = (b * t) / (4n * ONE); // relative deviation ≈ t/4
        const deltaOut = (4n * b * t) / ONE; // relative deviation ≈ 4t
        for (const price of [
          b + deltaIn,
          b - deltaIn,
          b + deltaOut,
          b - deltaOut,
        ]) {
          assert.equal(
            sampleOutOfBand(price, b, t),
            floatVerdict(price, b, t),
            `b=${b} t=${t} price=${price}`,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// upsertOraclePriceDaily — daily OHLC fold (Map-backed context stub, the
// deviationBreach.test.ts pattern: a real Envio mockDb hides intra-handler
// multi-set, which would defeat the multi-sample fold under test).
// ---------------------------------------------------------------------------

function makeCtx(): {
  store: Map<string, OraclePriceDailySnapshot>;
  context: OracleRollupContext;
} {
  const store = new Map<string, OraclePriceDailySnapshot>();
  return {
    store,
    context: {
      OraclePriceDailySnapshot: {
        get: async (id: string) => store.get(id),
        set: (entity: OraclePriceDailySnapshot) => {
          store.set(entity.id, entity);
        },
      },
    },
  };
}

const POOL = "pool-1";
const CHAIN = 42220;

async function fire(
  context: OracleRollupContext,
  opts: {
    ts?: bigint;
    block?: bigint;
    price?: bigint;
    oracleOk?: boolean;
    deviationRatio?: string;
    baseline?: bigint | undefined;
    threshold?: bigint | undefined;
  } = {},
): Promise<void> {
  await upsertOraclePriceDaily({
    context,
    chainId: CHAIN,
    poolId: POOL,
    blockTimestamp: opts.ts ?? 1000n,
    blockNumber: opts.block ?? 100n,
    oraclePrice: opts.price ?? ONE,
    oracleOk: opts.oracleOk ?? true,
    deviationRatio: opts.deviationRatio ?? "0.000000",
    breakerBaselineAtSnapshot: opts.baseline,
    breakerThresholdAtSnapshot: opts.threshold,
  });
}

const row = (store: Map<string, OraclePriceDailySnapshot>, dayTs: bigint) =>
  store.get(`${POOL}-${dayTs}`);

describe("upsertOraclePriceDaily", () => {
  it("creates a single-sample candle (open=high=low=close=price)", async () => {
    const { store, context } = makeCtx();
    await fire(context, {
      ts: 1000n,
      block: 100n,
      price: 2n * ONE,
      deviationRatio: "1.500000",
      baseline: ONE,
      threshold: ONE / 100n,
    });

    const r = row(store, 0n); // dayBucket(1000) = 0
    assert.ok(r, "candle row exists");
    assert.equal(r.id, `${POOL}-0`);
    assert.equal(r.chainId, CHAIN);
    assert.equal(r.bucketStart, 0n);
    assert.equal(r.openPrice, 2n * ONE);
    assert.equal(r.highPrice, 2n * ONE);
    assert.equal(r.lowPrice, 2n * ONE);
    assert.equal(r.closePrice, 2n * ONE);
    assert.equal(r.sampleCount, 1);
    // price 2.0 vs baseline 1.0, threshold 1% → way out of band.
    assert.equal(r.anyOutOfBand, true);
    assert.equal(r.maxDeviationRatio, "1.500000");
    assert.equal(r.endBreakerBaselineAtSnapshot, ONE);
    assert.equal(r.endBreakerThresholdAtSnapshot, ONE / 100n);
    assert.equal(r.blockNumber, 100n);
  });

  it("folds OHLC across same-day samples (open=first, close=last, high/low spread)", async () => {
    const { store, context } = makeCtx();
    const day = 100_000n; // dayBucket(100000) = 86400
    await fire(context, { ts: day, price: ONE, block: 10n });
    await fire(context, { ts: day + 5n, price: 3n * ONE, block: 11n });
    await fire(context, { ts: day + 9n, price: 2n * ONE, block: 12n });

    const r = row(store, SECONDS_PER_DAY);
    assert.ok(r);
    assert.equal(r.openPrice, ONE, "open = first sample");
    assert.equal(r.highPrice, 3n * ONE, "high = max");
    assert.equal(r.lowPrice, ONE, "low = min");
    assert.equal(r.closePrice, 2n * ONE, "close = last sample");
    assert.equal(r.sampleCount, 3);
    assert.equal(r.blockNumber, 12n, "blockNumber = last sample");
  });

  it("OR-folds anyOutOfBand — an intraday trip survives a recovered close", async () => {
    const { store, context } = makeCtx();
    const baseline = ONE;
    const threshold = ONE / 100n;
    // in-band, then out-of-band (the trip), then back in-band (recovered close).
    await fire(context, { price: baseline, baseline, threshold });
    await fire(context, { price: 2n * ONE, baseline, threshold });
    await fire(context, { price: baseline, baseline, threshold });

    const r = row(store, 0n);
    assert.ok(r);
    assert.equal(r.closePrice, baseline, "recovered by close");
    assert.equal(r.anyOutOfBand, true, "the intraday trip still flags the day");
  });

  it("flags anyOutOfBand on a rejected report even when in-band", async () => {
    const { store, context } = makeCtx();
    // price == baseline → in-band, but oracleOk=false → red regardless.
    await fire(context, {
      price: ONE,
      oracleOk: false,
      baseline: ONE,
      threshold: ONE / 100n,
    });
    const r = row(store, 0n);
    assert.ok(r);
    assert.equal(r.anyOutOfBand, true);
  });

  it("leaves anyOutOfBand false when no band exists (neutral verdict)", async () => {
    const { store, context } = makeCtx();
    await fire(context, { price: 2n * ONE }); // no baseline/threshold → null verdict
    const r = row(store, 0n);
    assert.ok(r);
    assert.equal(r.anyOutOfBand, false);
  });

  it("folds maxDeviationRatio NUMERICALLY, not lexically", async () => {
    // Lexically "9.500000" > "10.000000"; numerically 10 > 9.5. The max must
    // be "10.000000" regardless of arrival order.
    const a = makeCtx();
    await fire(a.context, { deviationRatio: "9.500000" });
    await fire(a.context, { deviationRatio: "10.000000" });
    assert.equal(row(a.store, 0n)!.maxDeviationRatio, "10.000000");

    const b = makeCtx();
    await fire(b.context, { deviationRatio: "10.000000" });
    await fire(b.context, { deviationRatio: "9.500000" });
    assert.equal(row(b.store, 0n)!.maxDeviationRatio, "10.000000");
  });

  it("buckets distinct UTC days into separate rows", async () => {
    const { store, context } = makeCtx();
    await fire(context, { ts: 1000n, price: ONE });
    await fire(context, { ts: SECONDS_PER_DAY + 1000n, price: 2n * ONE });

    assert.equal(row(store, 0n)!.closePrice, ONE);
    assert.equal(row(store, SECONDS_PER_DAY)!.closePrice, 2n * ONE);
    assert.equal(store.size, 2);
  });

  it("skips a zero-price outage sample without corrupting the candle", async () => {
    const { store, context } = makeCtx();
    const normal = 2n * ONE;
    await fire(context, { price: normal, deviationRatio: "0.300000" });
    await fire(context, { price: 0n, deviationRatio: "0.900000" }); // outage → skipped
    const r = row(store, 0n)!;
    assert.equal(r.openPrice, normal);
    assert.equal(r.lowPrice, normal, "zero-price must not set lowPrice=0");
    assert.equal(r.closePrice, normal, "zero-price must not set close=0");
    assert.equal(r.sampleCount, 1, "zero-price sample is not counted");
    assert.equal(
      r.maxDeviationRatio,
      "0.300000",
      "skipped sample's ratio ignored",
    );
  });

  it("creates no candle for a day whose only sample is a zero-price outage", async () => {
    const { store, context } = makeCtx();
    await fire(context, { price: 0n });
    assert.equal(row(store, 0n), undefined);
    assert.equal(store.size, 0);
  });

  it("folds maxDeviationRatio across the -1 no-health-data sentinel", async () => {
    const a = makeCtx();
    await fire(a.context, { deviationRatio: "-1" }); // no-data sample
    await fire(a.context, { deviationRatio: "0.500000" });
    assert.equal(
      row(a.store, 0n)!.maxDeviationRatio,
      "0.500000",
      "a real ratio beats the -1 sentinel",
    );

    const b = makeCtx();
    await fire(b.context, { deviationRatio: "-1" });
    await fire(b.context, { deviationRatio: "-1" });
    assert.equal(
      row(b.store, 0n)!.maxDeviationRatio,
      "-1",
      "an all-no-data day persists -1",
    );
  });
});
