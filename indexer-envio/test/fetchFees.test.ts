/// <reference types="mocha" />
import assert from "node:assert/strict";
import { fetchFees } from "../src/rpc.ts";
import { _setMockFees, _clearMockFees } from "../src/EventHandlers.ts";

const CHAIN = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";

describe("fetchFees (direct RPC-layer contract)", () => {
  afterEach(() => {
    _clearMockFees();
  });

  it("returns all three fields when every getter fulfills", async () => {
    _setMockFees(CHAIN, POOL, {
      lpFee: { fulfilled: 15n },
      protocolFee: { fulfilled: 5n },
      rebalanceReward: { fulfilled: 25n },
    });
    const fees = await fetchFees(CHAIN, POOL);
    assert.deepEqual(fees, { lpFee: 15, protocolFee: 5, rebalanceReward: 25 });
  });

  it("partial fulfill: returns only fulfilled fields; transient rejection leaves the field absent", async () => {
    _setMockFees(CHAIN, POOL, {
      lpFee: { fulfilled: 15n },
      protocolFee: { fulfilled: 5n },
      rebalanceReward: { rejected: "transient" },
    });
    const fees = await fetchFees(CHAIN, POOL);
    // rebalanceReward must be absent so the caller's spread leaves the
    // existing DB value (or the -1 sentinel) untouched; self-heal will
    // retry next touch.
    assert.deepEqual(fees, { lpFee: 15, protocolFee: 5 });
  });

  it("stamps -2 on 'returned no data' rejection so self-heal stops retrying", async () => {
    _setMockFees(CHAIN, POOL, {
      lpFee: { fulfilled: 15n },
      protocolFee: { fulfilled: 5n },
      rebalanceReward: { rejected: "unsupported" },
    });
    const fees = await fetchFees(CHAIN, POOL);
    // The -2 sentinel tells pool.ts self-heal the getter is permanently
    // missing from the bytecode (older FPMM deployment) — retrying would
    // hammer RPC forever for a pool that will never return data.
    assert.deepEqual(fees, {
      lpFee: 15,
      protocolFee: 5,
      rebalanceReward: -2,
    });
  });

  it("returns null only when every getter rejects", async () => {
    _setMockFees(CHAIN, POOL, {
      lpFee: { rejected: "transient" },
      protocolFee: { rejected: "transient" },
      rebalanceReward: { rejected: "transient" },
    });
    const fees = await fetchFees(CHAIN, POOL);
    assert.equal(fees, null);
  });

  it("returns null when getRpcClient throws (config error)", async () => {
    _setMockFees(CHAIN, POOL, { rpcClientThrows: true });
    const fees = await fetchFees(CHAIN, POOL);
    assert.equal(fees, null);
  });

  it("returns null for an unknown chainId (real getRpcClient throw path)", async () => {
    // No mock needed — getRpcClient throws for chainIds not in
    // RPC_CONFIG_BY_CHAIN; the outer try/catch must catch that.
    const fees = await fetchFees(999_999, POOL);
    assert.equal(fees, null);
  });
});
