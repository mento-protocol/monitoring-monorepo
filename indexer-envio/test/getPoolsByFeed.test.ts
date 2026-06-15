import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Pool } from "envio";
import { getPoolsByFeed } from "../src/rpc.js";
import { makePool } from "./helpers/makePool.js";

// Minimal context shaped like the Envio on-event context getPoolsByFeed reads:
// Pool.getWhere (filtered by referenceRateFeedID) + a log.warn spy.
function makeMockContext(pools: Pool[]) {
  const warnings: string[] = [];
  const context = {
    Pool: {
      getWhere: async (where: { referenceRateFeedID: { _eq: string } }) =>
        pools.filter(
          (p) => p.referenceRateFeedID === where.referenceRateFeedID._eq,
        ),
    },
    log: {
      warn: (msg: string) => {
        warnings.push(msg);
      },
    },
    // getPoolsByFeed only touches Pool + log; cast through unknown for the rest.
  } as unknown as Parameters<typeof getPoolsByFeed>[0];
  return { context, warnings };
}

const FEED = "0xfeed000000000000000000000000000000000001";

describe("getPoolsByFeed cross-chain isolation", () => {
  it("returns only the requested chain's pool when a feed resolves on two chains", async () => {
    const { context, warnings } = makeMockContext([
      makePool({
        id: "42220-0xcelo",
        chainId: 42220,
        referenceRateFeedID: FEED,
      }),
      makePool({ id: "143-0xmonad", chainId: 143, referenceRateFeedID: FEED }),
    ]);

    const celo = await getPoolsByFeed(context, 42220, FEED);
    assert.deepEqual(celo, ["42220-0xcelo"]);
    // The cross-chain drop must be visible, not silent.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /resolves on multiple chains/);
  });

  it("does not warn when every matching pool is on the requested chain", async () => {
    const { context, warnings } = makeMockContext([
      makePool({ id: "42220-0xa", chainId: 42220, referenceRateFeedID: FEED }),
      makePool({ id: "42220-0xb", chainId: 42220, referenceRateFeedID: FEED }),
    ]);

    const result = await getPoolsByFeed(context, 42220, FEED);
    assert.deepEqual(result.sort(), ["42220-0xa", "42220-0xb"]);
    assert.equal(warnings.length, 0);
  });
});
