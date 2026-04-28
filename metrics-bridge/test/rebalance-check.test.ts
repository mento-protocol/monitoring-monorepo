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
import {
  encodeErrorResult,
  parseAbi,
  toFunctionSelector,
  type Hex,
  type PublicClient,
} from "viem";
import {
  probeRebalance,
  detectStrategyType,
  scrubUrls,
  ERROR_MESSAGES,
} from "../src/rebalance-check.js";

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
    "error OLS_OUT_OF_COLLATERAL()",
    "error OLS_OUT_OF_DEBT()",
  ]);
  return encodeErrorResult({ abi, errorName, args });
}

/**
 * Mock a viem PublicClient whose strategy detection resolves to the
 * specified type — `getCDPConfig`/`reserve`/`getPools` succeed for the
 * matching type and revert with a contract-shape "function not found"
 * error otherwise. `call` is delegated to a per-test stub.
 */
type StrategyKind = "cdp" | "reserve" | "ols";

function functionNotFoundError(): Error {
  // viem-shape contract revert ("returned no data" → ContractFunctionZeroDataError).
  return makeRevertError(
    'The contract function "x" returned no data ("0x").',
    null,
  );
}

function mockClient(args: {
  strategyKind: StrategyKind;
  call: () => Promise<unknown>;
}): PublicClient {
  return {
    call: args.call,
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === "getCDPConfig") {
        if (args.strategyKind === "cdp") return Promise.resolve({});
        return Promise.reject(functionNotFoundError());
      }
      if (functionName === "reserve") {
        if (args.strategyKind === "reserve")
          return Promise.resolve("0x0000000000000000000000000000000000000abc");
        return Promise.reject(functionNotFoundError());
      }
      if (functionName === "getPools") {
        if (args.strategyKind === "ols") return Promise.resolve([]);
        return Promise.reject(functionNotFoundError());
      }
      return Promise.reject(
        new Error(`unexpected functionName: ${functionName}`),
      );
    },
  } as unknown as PublicClient;
}

/** Mock a viem PublicClient whose `call` rejects with the given error. */
function mockRevertingClient(
  err: Error,
  strategyKind: StrategyKind = "reserve",
): PublicClient {
  return mockClient({
    strategyKind,
    call: () => Promise.reject(err),
  });
}

function mockSucceedingClient(
  strategyKind: StrategyKind = "reserve",
): PublicClient {
  return mockClient({
    strategyKind,
    call: () => Promise.resolve({}),
  });
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
    "OLS_OUT_OF_COLLATERAL",
    "OLS_OUT_OF_DEBT",
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
    // reason_message MUST stay inside the bounded enum (~30 fixed strings)
    // — embedding the raw selector here would explode label cardinality
    // and hand a Slack-injection vector to a non-canonical strategy
    // contract. The raw payload lives on the `diagnostic` channel for
    // operator log spelunking.
    expect(result.reasonMessage).toBe("Unknown revert");
    expect(result.reasonMessage).not.toContain("0xdeadbeef");
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic).toContain("0xdeadbeef");
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

describe("probeRebalance — built-in Solidity reverts (Error / Panic)", () => {
  // Both branches feed `reason_message` from a fixed string set so the
  // alert label stays inside the bounded enum. The unbounded payload
  // (the contract-supplied string / panic code) goes to `diagnostic`.
  // Important: a non-canonical strategy contract MUST NOT be able to
  // inject Slack mrkdwn (`*bold*`, `<url|text>`, newlines) into the
  // alert body via `Error("...")`.
  it("Error(string) decodes to fixed reasonMessage, raw string only on diagnostic", async () => {
    const errorAbi = parseAbi(["error Error(string reason)"]);
    const data = encodeErrorResult({
      abi: errorAbi,
      errorName: "Error",
      args: ["*pwned* <https://evil.example/|click>"],
    });
    const err = makeRevertError("execution reverted", data);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("Error");
    expect(result.reasonMessage).toBe("Reverted with revert string");
    // Slack-injection-safety: the contract-supplied string MUST NOT leak
    // into the user-visible reasonMessage (no mrkdwn passthrough).
    expect(result.reasonMessage).not.toContain("*pwned*");
    expect(result.reasonMessage).not.toContain("evil.example");
    // Operator detail is preserved on the diagnostic channel for log
    // spelunking but never enters the metric label set.
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic).toContain("*pwned*");
  });

  it("Panic(uint256) decodes to fixed reasonMessage, panic code only on diagnostic", async () => {
    const panicAbi = parseAbi(["error Panic(uint256 code)"]);
    // Panic 0x11: arithmetic overflow.
    const data = encodeErrorResult({
      abi: panicAbi,
      errorName: "Panic",
      args: [0x11n],
    });
    const err = makeRevertError("execution reverted", data);
    const result = await probeRebalance(
      mockRevertingClient(err),
      POOL,
      STRATEGY,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("Panic");
    expect(result.reasonMessage).toBe("Solidity panic");
    expect(result.reasonMessage).not.toContain("0x11");
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic).toContain("0x11");
  });
});

describe("scrubUrls — RPC API key leak prevention", () => {
  // The diagnostic / transport_error channels are written to Cloud Run
  // logs verbatim. viem error messages routinely embed the failing URL,
  // which on Alchemy / Infura / any path-based-auth endpoint IS the API
  // credential. Operator-facing logs MUST NOT carry it.
  it("redacts an Alchemy URL with embedded API key", () => {
    const raw =
      "HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/REDACTED_API_KEY/some/path";
    const scrubbed = scrubUrls(raw);
    expect(scrubbed).toContain("<rpc-url-redacted>");
    expect(scrubbed).not.toContain("alchemy.com");
    expect(scrubbed).not.toContain("REDACTED_API_KEY");
  });

  it("redacts an http:// URL too", () => {
    const raw = "fetch failed. URL: http://internal.rpc.local:8545/path";
    const scrubbed = scrubUrls(raw);
    expect(scrubbed).toContain("<rpc-url-redacted>");
    expect(scrubbed).not.toContain("internal.rpc.local");
  });

  it("leaves plain text untouched", () => {
    expect(scrubUrls("ECONNREFUSED")).toBe("ECONNREFUSED");
    expect(scrubUrls("execution reverted")).toBe("execution reverted");
  });

  it("redacts URL but preserves surrounding error context", () => {
    const raw =
      "Request failed: HTTP request failed. URL: https://api.example.com/v2/KEY";
    const scrubbed = scrubUrls(raw);
    expect(scrubbed).toMatch(/^Request failed: HTTP request failed\. URL: /);
    expect(scrubbed).toContain("<rpc-url-redacted>");
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

describe("detectStrategyType", () => {
  it("returns 'cdp' when getCDPConfig succeeds", async () => {
    const client = mockClient({
      strategyKind: "cdp",
      call: () => Promise.resolve({}),
    });
    const t = await detectStrategyType(client, STRATEGY, POOL);
    expect(t).toBe("cdp");
  });

  it("returns 'reserve' when reserve() succeeds", async () => {
    const client = mockClient({
      strategyKind: "reserve",
      call: () => Promise.resolve({}),
    });
    const t = await detectStrategyType(client, STRATEGY, POOL);
    expect(t).toBe("reserve");
  });

  it("returns 'ols' when getPools() succeeds", async () => {
    const client = mockClient({
      strategyKind: "ols",
      call: () => Promise.resolve({}),
    });
    const t = await detectStrategyType(client, STRATEGY, POOL);
    expect(t).toBe("ols");
  });

  it("returns 'unknown' when none of the detection probes succeed", async () => {
    // Every getter reverts with "function not found" — typical for an EOA
    // or a strategy proxy with the wrong implementation. Caller must skip
    // the probe instead of emitting a misleading "blocked" annotation.
    const client = {
      readContract: () => Promise.reject(functionNotFoundError()),
    } as unknown as PublicClient;
    const t = await detectStrategyType(client, STRATEGY, POOL);
    expect(t).toBe("unknown");
  });

  it("propagates transport errors (network down) — never silently maps to 'unknown'", async () => {
    // If the RPC is down, every detection probe will fail with a transport
    // error. We must surface that to the caller (which converts it to
    // transport_error → no metric) rather than treating it as "unknown",
    // which would silently disable probes during outages.
    const client = {
      readContract: () => Promise.reject(new Error("fetch failed")),
    } as unknown as PublicClient;
    await expect(detectStrategyType(client, STRATEGY, POOL)).rejects.toThrow(
      /fetch failed/,
    );
  });
});

describe("probeRebalance — strategy-type branching", () => {
  it("CDP strategy: probes rebalance() and returns ok on success", async () => {
    const client = mockClient({
      strategyKind: "cdp",
      call: () => Promise.resolve({}),
    });
    const result = await probeRebalance(client, POOL, STRATEGY);
    expect(result).toEqual({ kind: "ok" });
  });

  it("Reserve strategy: probes rebalance() and decodes RLS_RESERVE_OUT_OF_COLLATERAL", async () => {
    const data = encodeRevert("RLS_RESERVE_OUT_OF_COLLATERAL");
    const err = makeRevertError("execution reverted", data);
    const client = mockClient({
      strategyKind: "reserve",
      call: () => Promise.reject(err),
    });
    const result = await probeRebalance(client, POOL, STRATEGY);
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("RLS_RESERVE_OUT_OF_COLLATERAL");
  });

  it("OLS strategy: probes determineAction() instead of rebalance() and decodes OLS_OUT_OF_COLLATERAL", async () => {
    // OLS rebalance() reverts inside ERC20 from address(0); the probe must
    // route to determineAction (view-only) to surface a meaningful revert.
    const data = encodeRevert("OLS_OUT_OF_COLLATERAL");
    const err = makeRevertError("execution reverted", data);
    let calledData: string | undefined;
    const callSpy = (args: { data: string }): Promise<unknown> => {
      calledData = args.data;
      return Promise.reject(err);
    };
    const client = {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "getPools") return Promise.resolve([]);
        return Promise.reject(functionNotFoundError());
      },
      call: callSpy,
    } as unknown as PublicClient;
    const result = await probeRebalance(client, POOL, STRATEGY);
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("OLS_OUT_OF_COLLATERAL");
    // Regression guard: confirm the call() data carries determineAction's
    // selector exactly. A negation against rebalance's selector would
    // pass for any selector that isn't `rebalance` — including typos —
    // so we anchor on the positive identity of the function we expect.
    const determineActionSelector = toFunctionSelector(
      "function determineAction(address pool)",
    );
    expect(calledData).toBeDefined();
    expect(calledData?.slice(0, 10)).toBe(determineActionSelector);
  });

  it("Unknown strategy: returns 'skip' without emitting a probe call", async () => {
    let callMade = false;
    const client = {
      readContract: () => Promise.reject(functionNotFoundError()),
      call: () => {
        callMade = true;
        return Promise.resolve({});
      },
    } as unknown as PublicClient;
    const result = await probeRebalance(client, POOL, STRATEGY);
    expect(result.kind).toBe("skip");
    if (result.kind !== "skip") return;
    expect(result.reason).toMatch(/strategy/i);
    expect(callMade).toBe(false);
  });

  it("transport error during detection → transport_error result (no probe attempted)", async () => {
    const client = {
      readContract: () => Promise.reject(new Error("ECONNREFUSED")),
      call: () => Promise.resolve({}),
    } as unknown as PublicClient;
    const result = await probeRebalance(client, POOL, STRATEGY);
    expect(result.kind).toBe("transport_error");
    if (result.kind !== "transport_error") return;
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("probeRebalance — Reserve enrichment for RLS_RESERVE_OUT_OF_COLLATERAL", () => {
  // The dashboard's reserve-enrichment path reads `reserve()` then chases
  // through `determineAction(pool)` (for the debt-leg flag + amountOwedToPool)
  // and `balanceOf` on the collateral token. The metrics-bridge probe
  // mirrors that path so the Slack alert can render "Reserve has insufficient
  // axlUSDC. Current balance: 0.00 axlUSDC / Needed for rebalancing:
  // 12,500.00 axlUSDC". Tests exercise the full enrichment chain end-to-end.

  // Real Celo addresses so `tokenSymbol(42220, ...)` resolves to the canonical
  // symbol via @mento-protocol/contracts. The pool address is the
  // axlUSDC/USDm Celo pool from known-pools.json; collateral is axlUSDC
  // (the non-debt leg, picked when isToken0Debt=false).
  const CELO_CHAIN_ID = 42220;
  const POOL_USDM_AXLUSDC: `0x${string}` =
    "0xb285d4c7133d6f27bfb29224fb0d22e7ec3ddd2d";
  const TOKEN_USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
  const TOKEN_AXLUSDC = "0xeb466342c4d449bc9f53a865d5cb90586f405215";
  const RESERVE_ADDR: `0x${string}` =
    "0x0000000000000000000000000000000000000abc";

  /**
   * Build a reserve-strategy client whose enrichment path responds with the
   * configured fixture. The probe fires:
   *   1. `reserve()` → reserveAddr
   *   2. `determineAction(pool)` → [ctx{isToken0Debt}, action{amountOwedToPool}]
   *   3. `token0()` / `token1()` on the pool
   *   4. `balanceOf(reserveAddr)` + `decimals()` on the collateral token
   * `enrichmentOverride` lets a test inject failures to exercise the
   * graceful-degradation branch.
   */
  function mockReserveClient(opts: {
    isToken0Debt: boolean;
    amountOwedToPool: bigint;
    balance: bigint;
    decimals: number;
    enrichmentReject?: string;
  }): PublicClient {
    const data = encodeRevert("RLS_RESERVE_OUT_OF_COLLATERAL");
    const err = makeRevertError("execution reverted", data);
    return {
      call: () => Promise.reject(err),
      readContract: ({
        address,
        functionName,
      }: {
        address: string;
        functionName: string;
      }) => {
        if (opts.enrichmentReject !== undefined && functionName !== "reserve") {
          // First call (reserve()) succeeds for detection; later calls fail
          // to simulate transport errors during enrichment.
          // Note: detectStrategyType also calls reserve() — that always
          // resolves so detection lands on "reserve".
        }
        // Detection probes — only `reserve()` succeeds, others fall through.
        if (functionName === "getCDPConfig")
          return Promise.reject(functionNotFoundError());
        if (functionName === "reserve") return Promise.resolve(RESERVE_ADDR);
        if (functionName === "getPools")
          return Promise.reject(functionNotFoundError());

        if (opts.enrichmentReject !== undefined) {
          return Promise.reject(new Error(opts.enrichmentReject));
        }

        if (functionName === "determineAction") {
          return Promise.resolve([
            {
              pool: POOL_USDM_AXLUSDC,
              isToken0Debt: opts.isToken0Debt,
            },
            { amountOwedToPool: opts.amountOwedToPool },
          ]);
        }
        if (functionName === "token0") {
          return Promise.resolve(TOKEN_USDM);
        }
        if (functionName === "token1") {
          return Promise.resolve(TOKEN_AXLUSDC);
        }
        if (functionName === "balanceOf") {
          if (address.toLowerCase() === TOKEN_AXLUSDC.toLowerCase()) {
            return Promise.resolve(opts.balance);
          }
          return Promise.resolve(0n);
        }
        if (functionName === "decimals") {
          return Promise.resolve(opts.decimals);
        }
        return Promise.reject(
          new Error(`unexpected functionName: ${functionName}`),
        );
      },
    } as unknown as PublicClient;
  }

  it("decodes RLS_RESERVE_OUT_OF_COLLATERAL with enrichment: reasonMessage names the symbol, balance + needed populated", async () => {
    const client = mockReserveClient({
      isToken0Debt: true, // USDm (token0) is debt; axlUSDC (token1) is collateral.
      amountOwedToPool: 12_500_000_000n, // 12,500 axlUSDC (6dp).
      balance: 0n, // Reserve has zero collateral — exact failure mode.
      decimals: 6,
    });
    const result = await probeRebalance(
      client,
      POOL_USDM_AXLUSDC,
      STRATEGY,
      CELO_CHAIN_ID,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("RLS_RESERVE_OUT_OF_COLLATERAL");
    // Symbol-specific message replaces the bounded-enum default — cardinality
    // stays bounded by the @mento-protocol/contracts token list.
    expect(result.reasonMessage).toBe("Reserve has insufficient axlUSDC");
    expect(result.reserveCollateral).toEqual({
      balance: 0,
      needed: 12_500,
      tokenSymbol: "axlUSDC",
    });
  });

  it("falls through to generic reason_message when enrichment fetch fails", async () => {
    // Transport error inside the enrichment chain (after reserve() resolves
    // — so detection still pins strategyType=reserve). The probe MUST NOT
    // fail loudly; the breach alert keeps firing with the bounded enum
    // message.
    const client = mockReserveClient({
      isToken0Debt: true,
      amountOwedToPool: 0n,
      balance: 0n,
      decimals: 6,
      enrichmentReject: "fetch failed",
    });
    const result = await probeRebalance(
      client,
      POOL_USDM_AXLUSDC,
      STRATEGY,
      CELO_CHAIN_ID,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("RLS_RESERVE_OUT_OF_COLLATERAL");
    // Bounded enum default — no symbol substitution because enrichment failed.
    expect(result.reasonMessage).toBe(
      ERROR_MESSAGES.RLS_RESERVE_OUT_OF_COLLATERAL,
    );
    expect(result.reserveCollateral).toBeUndefined();
  });

  it('falls back to "collateral" when token symbol is unresolvable', async () => {
    // Mock client that returns an unmapped token address as the collateral
    // leg. The probe should emit `reasonMessage: "Reserve has insufficient
    // collateral"` instead of crashing.
    const UNKNOWN_TOKEN = "0x000000000000000000000000000000000000dead";
    const client = {
      call: () => {
        const data = encodeRevert("RLS_RESERVE_OUT_OF_COLLATERAL");
        return Promise.reject(makeRevertError("execution reverted", data));
      },
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "getCDPConfig")
          return Promise.reject(functionNotFoundError());
        if (functionName === "reserve") return Promise.resolve(RESERVE_ADDR);
        if (functionName === "getPools")
          return Promise.reject(functionNotFoundError());
        if (functionName === "determineAction") {
          return Promise.resolve([
            { isToken0Debt: false }, // token1 is debt, token0 is collateral.
            { amountOwedToPool: 100n },
          ]);
        }
        if (functionName === "token0") return Promise.resolve(UNKNOWN_TOKEN);
        if (functionName === "token1") return Promise.resolve(TOKEN_USDM);
        if (functionName === "balanceOf") return Promise.resolve(50n);
        if (functionName === "decimals") return Promise.resolve(6);
        return Promise.reject(
          new Error(`unexpected functionName: ${functionName}`),
        );
      },
    } as unknown as PublicClient;
    const result = await probeRebalance(
      client,
      POOL_USDM_AXLUSDC,
      STRATEGY,
      CELO_CHAIN_ID,
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonMessage).toBe("Reserve has insufficient collateral");
    expect(result.reserveCollateral?.tokenSymbol).toBe("collateral");
  });

  it("CDP strategy: no enrichment attached even when reasonCode would map (different strategy type)", async () => {
    // Sanity: a CDPLS_STABILITY_POOL_BALANCE_TOO_LOW (the CDP analogue) does
    // NOT trigger reserve enrichment — the alert would render the bounded
    // reason_message line instead. Locks the strategy-type gate.
    const data = encodeRevert("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW");
    const err = makeRevertError("execution reverted", data);
    const client = mockClient({
      strategyKind: "cdp",
      call: () => Promise.reject(err),
    });
    const result = await probeRebalance(client, POOL, STRATEGY, CELO_CHAIN_ID);
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW");
    expect(result.reserveCollateral).toBeUndefined();
  });

  it("OLS strategy: no enrichment attached for OLS_OUT_OF_COLLATERAL", async () => {
    // OLS strategies don't have a reserve() path — even though the literal
    // word "collateral" appears in OLS_OUT_OF_COLLATERAL, the probe MUST
    // gate on strategyType=reserve, not on reason text.
    const data = encodeRevert("OLS_OUT_OF_COLLATERAL");
    const err = makeRevertError("execution reverted", data);
    const client = {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === "getPools") return Promise.resolve([]);
        return Promise.reject(functionNotFoundError());
      },
      call: () => Promise.reject(err),
    } as unknown as PublicClient;
    const result = await probeRebalance(client, POOL, STRATEGY, CELO_CHAIN_ID);
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reasonCode).toBe("OLS_OUT_OF_COLLATERAL");
    expect(result.reserveCollateral).toBeUndefined();
  });
});
