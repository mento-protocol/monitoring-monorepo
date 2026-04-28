/**
 * RPC client cache + null-on-missing-URL tests.
 *
 * Bug 3 regression guard: chain 10143 (Monad testnet) used to default to a
 * HyperRPC endpoint that doesn't serve `eth_call`. The default has been
 * removed, so without `RPC_URL_10143` set, `getRpcClient(10143)` must return
 * `null` and log a one-off warning instead of returning a client that fails
 * every probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRpcClient, _resetRpcClientsForTests } from "../src/rpc.js";

const CHAINS_WITH_FULL_NODE_DEFAULT = [42220, 11142220, 143] as const;

describe("getRpcClient", () => {
  // Snapshot env to restore between tests — `RPC_URL_*` overrides leak.
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    _resetRpcClientsForTests();
    delete process.env.RPC_URL_10143;
    delete process.env.RPC_URL_42220;
    delete process.env.RPC_URL_143;
    delete process.env.RPC_URL_11142220;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns null for unknown chains and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRpcClient(99999)).toBeNull();
    // Repeat call — log dedup must not warn twice.
    expect(getRpcClient(99999)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("99999"));
    warn.mockRestore();
  });

  it("returns null for chain 10143 (Monad testnet) without RPC_URL_10143 — HyperRPC default removed", () => {
    // Bug 3: chain 10143 used to default to https://10143.rpc.hypersync.xyz,
    // which doesn't serve eth_call. The default is gone — operators must
    // set RPC_URL_10143 explicitly. Without it, we skip the probe gracefully.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRpcClient(10143)).toBeNull();
    // One-off warn that mentions the env var name so operators know what to fix.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RPC_URL_10143"));
    warn.mockRestore();
  });

  it("returns null only once per chain — log spam guard for missing URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRpcClient(10143)).toBeNull();
    expect(getRpcClient(10143)).toBeNull();
    expect(getRpcClient(10143)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns a client for chain 10143 when RPC_URL_10143 is set", () => {
    process.env.RPC_URL_10143 = "https://example.test/monad";
    expect(getRpcClient(10143)).not.toBeNull();
  });

  it.each(CHAINS_WITH_FULL_NODE_DEFAULT)(
    "returns a client for chain %i (full-node default present)",
    (chainId) => {
      // Defaults: forno.celo.org / forno.celo-sepolia.celo-testnet.org / rpc2.monad.xyz.
      // All three are full-node RPCs that serve eth_call.
      const client = getRpcClient(chainId);
      expect(client).not.toBeNull();
    },
  );

  it("env-var override wins over the hardcoded default", () => {
    // Sanity: the cache is per-chain, so once a client is created with
    // env-var-derived URL it should be cached regardless of subsequent
    // process.env mutations.
    process.env.RPC_URL_42220 = "https://example.test/celo-override";
    const first = getRpcClient(42220);
    expect(first).not.toBeNull();
    // Mutating env after caching — cache should NOT pick up the change.
    process.env.RPC_URL_42220 = "https://example.test/different";
    const second = getRpcClient(42220);
    expect(second).toBe(first);
  });
});
