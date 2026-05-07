/// <reference types="mocha" />
import { assert } from "chai";
import {
  _clearBootstrapCaches,
  bootstrapFeedBreakerConfigs,
} from "../src/breakers";
import { breakerListEffect } from "../src/rpc/effects";

// Tests the negative-cache state machine added in PR #331:
//   1. Failure → set TTL, calls within TTL window skip the RPC.
//   2. TTL expiry → retries fire again.
//   3. Success (empty list path) → backoff cleared so subsequent
//      `_bootstrapAttempted` short-circuit takes over.
// The success-with-non-empty-list path (ensureBreaker + ensureBreakerConfig
// fan-out) is covered by the existing breakerHandlers harness tests; this
// file only exercises the bootstrap function's local state machine.

const CHAIN = 143;
const FEED = "0x81a313ff894bfc6093d33b5514e34d7faa41b7ef";
const BACKOFF_SECONDS = 5n * 60n;

type EffectArgs = { chainId: number; blockNumber: bigint };
type EffectFn = (args: EffectArgs) => string[] | null | undefined;

function makeContext(effectFn: EffectFn): {
  ctx: { effect: (eff: unknown, input: EffectArgs) => Promise<unknown> };
  callCount: () => number;
} {
  let count = 0;
  const ctx = {
    effect: async (eff: unknown, input: EffectArgs) => {
      // Only intercept breakerListEffect calls; on the success-empty-list
      // path nothing else fires, so bare equality is safe here.
      if (eff !== breakerListEffect) {
        throw new Error("test stub: unexpected effect invoked");
      }
      count += 1;
      const result = effectFn(input);
      // The effect handler maps `null → undefined` per Sury's nullable, so
      // mirror that mapping here to keep the stub realistic.
      return result === null ? undefined : result;
    },
  };
  return { ctx, callCount: () => count };
}

describe("bootstrapFeedBreakerConfigs — negative-cache TTL", () => {
  beforeEach(() => {
    _clearBootstrapCaches();
  });

  it("first failure sets TTL; second call within TTL is a no-op", async () => {
    const { ctx, callCount } = makeContext(() => undefined); // RPC fails
    const t0 = 1_000n;

    await bootstrapFeedBreakerConfigs(ctx as never, CHAIN, FEED, 100n, t0);
    assert.equal(callCount(), 1, "first call should fire the effect");

    // Second call inside the 5-min chain-time window — should skip.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      101n,
      t0 + 60n, // +1 min — well inside TTL
    );
    assert.equal(callCount(), 1, "in-TTL call should not fire the effect");

    // Just below the TTL boundary — still inside.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      102n,
      t0 + BACKOFF_SECONDS - 1n,
    );
    assert.equal(callCount(), 1, "TTL-boundary call should not fire");
  });

  it("TTL expiry resumes retries", async () => {
    const { ctx, callCount } = makeContext(() => undefined);
    const t0 = 2_000n;

    await bootstrapFeedBreakerConfigs(ctx as never, CHAIN, FEED, 200n, t0);
    assert.equal(callCount(), 1);

    // Skip during TTL.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      201n,
      t0 + 100n,
    );
    assert.equal(callCount(), 1);

    // First call past the TTL — should retry.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      202n,
      t0 + BACKOFF_SECONDS + 1n,
    );
    assert.equal(callCount(), 2, "post-TTL call should retry");
  });

  it("success (empty breaker list) clears backoff and marks attempted", async () => {
    let failNext = true;
    const { ctx, callCount } = makeContext(() => (failNext ? undefined : []));
    const t0 = 3_000n;

    // Initial fail sets backoff.
    await bootstrapFeedBreakerConfigs(ctx as never, CHAIN, FEED, 300n, t0);
    assert.equal(callCount(), 1);

    // Past TTL, return empty list (success, no breakers configured here).
    failNext = false;
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      301n,
      t0 + BACKOFF_SECONDS + 1n,
    );
    assert.equal(callCount(), 2, "post-TTL retry fires the effect once");

    // Subsequent call should short-circuit on `_bootstrapAttempted`, NOT
    // re-fire the effect — even immediately, well inside any backoff window.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED,
      302n,
      t0 + BACKOFF_SECONDS + 2n,
    );
    assert.equal(
      callCount(),
      2,
      "after successful empty-list bootstrap, future calls skip via _bootstrapAttempted",
    );
  });

  it("different feeds maintain independent backoff state", async () => {
    const { ctx, callCount } = makeContext(() => undefined);
    const t0 = 4_000n;
    const FEED_A = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const FEED_B = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

    await bootstrapFeedBreakerConfigs(ctx as never, CHAIN, FEED_A, 400n, t0);
    await bootstrapFeedBreakerConfigs(ctx as never, CHAIN, FEED_B, 401n, t0);
    assert.equal(callCount(), 2, "each feed gets its own first-fire");

    // Both feeds inside their TTLs — both skip.
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED_A,
      402n,
      t0 + 60n,
    );
    await bootstrapFeedBreakerConfigs(
      ctx as never,
      CHAIN,
      FEED_B,
      403n,
      t0 + 60n,
    );
    assert.equal(callCount(), 2, "in-TTL calls for both feeds are no-ops");
  });
});
