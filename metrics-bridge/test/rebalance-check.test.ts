/**
 * Decoder + classification tests for the rebalance-reason probe.
 *
 * The probe is the alert annotation's source of truth — these tests
 * exercise every branch of the `kind` discriminator (ok / blocked /
 * transport_error) without ever touching a real RPC. We construct viem-shaped
 * errors (with `data` on the cause chain) to mirror what `client.call` raises
 * when a contract reverts, and use `parseAbi` + `encodeFunctionData` to
 * generate revert payloads byte-identical to what an on-chain revert would
 * emit. Anything else risks a passing test that would fail in production.
 */

import { describe, it, expect } from "vitest";
import { encodeErrorResult, parseAbi, type Hex, type PublicClient } from "viem";
import { probeRebalance, ERROR_MESSAGES } from "../src/rebalance-check.js";

const POOL: `0x${string}` = "0x0000000000000000000000000000000000001234";
const STRATEGY: `0x${string}` = "0x0000000000000000000000000000000000005678";

/**
 * Build a viem-shaped revert error. Mirrors the structure of
 * `ContractFunctionExecutionError` — viem walks the `cause` chain to find
 * `data`, so we plant the revert hex on a nested cause.
 */
function makeRevertError(message: string, revertData: Hex | null): Error {
  const err = new Error(message);
  // viem sets `cause` with revert data on contract reverts; the probe walks it.
  if (revertData !== null) {
    (err as unknown as { cause: { data: Hex; message: string } }).cause = {
      data: revertData,
      message,
    };
  }
  return err;
}

/** Encode a revert for one of the strategy ABI's custom errors. */
function encodeRevert(errorName: string, args: readonly unknown[] = []): Hex {
  // Mirror of the subset of ABI used by the probe — sufficient for the
  // encoder to produce on-chain-shape revert payloads.
  const abi = parseAbi([
    "error LS_COOLDOWN_ACTIVE()",
    "error LS_POOL_NOT_REBALANCEABLE()",
    "error LS_INVALID_PRICES()",
    "error CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()",
    "error RLS_RESERVE_OUT_OF_COLLATERAL()",
    "error PriceDifferenceTooSmall()",
    "error PriceDifferenceMovedInWrongDirection()",
    "error CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE(uint256 shortfall)",
  ]);
  return encodeErrorResult({ abi, errorName, args });
}

/** Mock a viem PublicClient whose `call` rejects with the given error. */
function mockRevertingClient(err: Error): PublicClient {
  return {
    call: () => Promise.reject(err),
  } as unknown as PublicClient;
}

function mockSucceedingClient(): PublicClient {
  return {
    call: () => Promise.resolve({}),
  } as unknown as PublicClient;
}

describe("probeRebalance — happy path", () => {
  it("returns ok when call succeeds (no revert)", async () => {
    const result = await probeRebalance(mockSucceedingClient(), POOL, STRATEGY);
    expect(result).toEqual({ kind: "ok" });
  });
});

describe("probeRebalance — known revert codes", () => {
  // Sanity check: every code in the table maps to a non-empty human message.
  const codes = [
    "LS_COOLDOWN_ACTIVE",
    "LS_INVALID_PRICES",
    "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
    "RLS_RESERVE_OUT_OF_COLLATERAL",
    "PriceDifferenceMovedInWrongDirection",
  ] as const;

  it.each(codes)(
    "decodes %s into reason_code + reason_message",
    async (code) => {
      const data = encodeRevert(code);
      const err = makeRevertError("execution reverted", data);
      const result = await probeRebalance(
        mockRevertingClient(err),
        POOL,
        STRATEGY,
      );
      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") return;
      expect(result.reasonCode).toBe(code);
      expect(result.reasonMessage).toBe(ERROR_MESSAGES[code]);
      expect(result.reasonMessage.length).toBeGreaterThan(0);
    },
  );

  it("decodes a parameterised error (uint256) without losing the code", async () => {
    const data = encodeRevert("CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE", [42n]);
    const err = makeRevertError("execution reverted", data);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE");
    expect(result.reasonMessage).toBe(
      ERROR_MESSAGES.CDPLS_REDEMPTION_SHORTFALL_TOO_LARGE,
    );
  });
});

describe("probeRebalance — healthy no-op codes collapse to ok", () => {
  // The probe-cycle gating in poller.ts excludes pools below threshold, but
  // a race (eval interval vs. probe interval) could surface a healthy pool.
  // The dashboard's `HEALTHY_NO_OP_ERRORS` set carries the same invariant.
  it("LS_POOL_NOT_REBALANCEABLE → ok", async () => {
    const data = encodeRevert("LS_POOL_NOT_REBALANCEABLE");
    const err = makeRevertError("execution reverted", data);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result).toEqual({ kind: "ok" });
  });

  it("PriceDifferenceTooSmall → ok", async () => {
    const data = encodeRevert("PriceDifferenceTooSmall");
    const err = makeRevertError("execution reverted", data);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result).toEqual({ kind: "ok" });
  });
});

describe("probeRebalance — unknown / unrecognised reverts", () => {
  it("emits reason_code='unknown' when revert data doesn't match any known error", async () => {
    // Selector 0xdeadbeef is not in the strategy ABI.
    const err = makeRevertError("execution reverted", "0xdeadbeef");
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("unknown");
    expect(result.reasonMessage).toMatch(/unrecognized revert/i);
    // Truncated payload is included so operators can grep for the selector.
    expect(result.reasonMessage).toContain("0xdeadbeef");
  });

  it("emits reason_code='unknown' when the contract revert carries no data", async () => {
    // Some providers report execution reverted without revert payload — e.g.
    // out-of-gas mid-call. We still mark the pool blocked so the operator
    // sees something, but with the catch-all message.
    const err = makeRevertError("execution reverted", null);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("unknown");
  });
});

describe("probeRebalance — transport errors propagate as transport_error", () => {
  it("network failure does NOT mark pool as blocked", async () => {
    // No revert data, no "revert" / "returned no data" signal in the message.
    const err = new Error("fetch failed");
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("transport_error");
    if (result.kind !== "transport_error") return;
    expect(result.error).toContain("fetch failed");
  });

  it("HTTP 401 does NOT mark pool as blocked", async () => {
    const err = new Error("Unauthorized");
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("transport_error");
  });

  it('viem "returned no data" IS classified as a contract revert (zero-code address)', async () => {
    // The dashboard treats this as a contract-shape revert (EOA / wrong ABI),
    // so the alert annotation falls back to "unknown" rather than masking
    // the misconfiguration as a transport blip.
    const err = makeRevertError(
      'The contract function "rebalance" returned no data ("0x").',
      null,
    );
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
  });
});
