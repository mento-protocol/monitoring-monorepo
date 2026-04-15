import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, toBytes } from "viem";

// Mock viem before importing the module under test
const mockCall = vi.fn();
const mockReadContract = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      call: mockCall,
      readContract: mockReadContract,
    }),
  };
});

import { checkRebalanceStatus, toHumanUnits } from "../rebalance-check";

const POOL = "0x1111111111111111111111111111111111111111";
const STRATEGY = "0x2222222222222222222222222222222222222222";
const RPC_URL = "https://forno.celo.org";

// 4-byte selector for determineAction(address). OLS must probe this function
// (not rebalance) to avoid an ERC20 revert when simulating from address(0).
const DETERMINE_ACTION_SELECTOR = keccak256(
  toBytes("determineAction(address)"),
).slice(0, 10);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("checkRebalanceStatus", () => {
  it("returns canRebalance=true when simulation succeeds", async () => {
    // Strategy type detection: getCDPConfig reverts (contract-level), reserve() succeeds
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");
    // Simulate rebalance succeeds
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(true);
    expect(result.message).toBe("Rebalance is currently possible");
    expect(result.rawError).toBeNull();
    expect(result.strategyType).toBe("reserve");
  });

  it("returns canRebalance=false with human message on known revert", async () => {
    // Strategy type detection: getCDPConfig succeeds (CDP strategy)
    mockReadContract.mockResolvedValueOnce({
      stabilityPool: "0x4444444444444444444444444444444444444444",
      collateralRegistry: "0x5555555555555555555555555555555555555555",
      stabilityPoolPercentage: BigInt(100),
      maxIterations: BigInt(10),
    });

    // Use real ABI-encoded selector for CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()
    // Error selectors are keccak256 of the bare signature, first 4 bytes
    const CDPLS_SELECTOR = keccak256(
      toBytes("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()"),
    ).slice(0, 10) as `0x${string}`;

    // Simulate rebalance reverts with real selector
    const err = new Error("execution reverted");
    Object.assign(err, {
      data: CDPLS_SELECTOR,
    });
    mockCall.mockRejectedValueOnce(err);

    // For enrichment: getCDPConfig + getTotalBoldDeposits + boldToken + symbol + decimals
    mockReadContract
      .mockResolvedValueOnce({
        stabilityPool: "0x4444444444444444444444444444444444444444",
        collateralRegistry: "0x5555555555555555555555555555555555555555",
        stabilityPoolPercentage: BigInt(100),
        maxIterations: BigInt(10),
      })
      .mockResolvedValueOnce(BigInt(0)) // getTotalBoldDeposits
      .mockResolvedValueOnce("0x6666666666666666666666666666666666666666") // boldToken
      .mockResolvedValueOnce("USDm") // symbol
      .mockResolvedValueOnce(18); // decimals

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("cdp");
    expect(result.rawError).toBe("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW");
    expect(result.message).toContain("Stability pool");
    expect(result.enrichment).toEqual({
      type: "cdp",
      stabilityPoolBalance: 0,
      stabilityPoolTokenSymbol: "USDm",
      stabilityPoolTokenDecimals: 18,
    });
  });

  it("detects CDP strategy type when getCDPConfig succeeds", async () => {
    mockReadContract.mockResolvedValueOnce({
      stabilityPool: "0x4444444444444444444444444444444444444444",
      collateralRegistry: "0x5555555555555555555555555555555555555555",
      stabilityPoolPercentage: BigInt(100),
      maxIterations: BigInt(10),
    });
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("cdp");
  });

  it("detects reserve strategy type when getCDPConfig fails but reserve() succeeds", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("reserve");
  });

  it("returns blocked when strategy type is unknown (no false green)", async () => {
    // CDP, Reserve and OLS probes all revert (contract-level) → unknown
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockRejectedValueOnce(new Error("execution reverted"));
    // eth_call should NOT be made — unknown strategy short-circuits

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("unknown");
    expect(result.message).toContain("Unable to identify");
    // Verify simulation was never attempted
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("treats viem's 'returned no data' error as a probe miss, not a transport failure", async () => {
    // Real-world shape viem throws for EOAs / non-matching ABIs. Without
    // swallowing it we bubble out to SWR and render "Diagnostics
    // unavailable" instead of the neutral "Unable to identify" fallback.
    const noDataMessage =
      'The contract function "getCDPConfig" returned no data ("0x"). ' +
      "This could be due to any of the following:\n" +
      '  - The contract does not have the function "getCDPConfig",\n' +
      "  - The parameters passed to the contract function may be invalid,\n" +
      "  - The address is not a contract.";
    mockReadContract
      .mockRejectedValueOnce(new Error(noDataMessage))
      .mockRejectedValueOnce(new Error(noDataMessage))
      .mockRejectedValueOnce(new Error(noDataMessage));

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("unknown");
    expect(result.message).toContain("Unable to identify");
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("detects OLS strategy type when getCDPConfig and reserve() fail but getPools() succeeds", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted")) // getCDPConfig
      .mockRejectedValueOnce(new Error("execution reverted")) // reserve()
      .mockResolvedValueOnce([]); // getPools()
    mockCall.mockResolvedValueOnce({ data: "0x" });

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);
    expect(result.strategyType).toBe("ols");
    expect(result.canRebalance).toBe(true);
    // OLS must probe determineAction(address), NOT rebalance(address) — the
    // latter triggers an ERC20 transfer revert when simulated from address(0).
    const callData = mockCall.mock.calls[0][0].data as string;
    expect(callData.slice(0, 10)).toBe(DETERMINE_ACTION_SELECTOR);
  });

  it("decodes OLS_OUT_OF_COLLATERAL revert with human-readable message", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted")) // getCDPConfig
      .mockRejectedValueOnce(new Error("execution reverted")) // reserve()
      .mockResolvedValueOnce([]); // getPools()

    const OLS_SELECTOR = keccak256(toBytes("OLS_OUT_OF_COLLATERAL()")).slice(
      0,
      10,
    ) as `0x${string}`;
    const err = new Error("execution reverted");
    Object.assign(err, { data: OLS_SELECTOR });
    mockCall.mockRejectedValueOnce(err);

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("ols");
    expect(result.rawError).toBe("OLS_OUT_OF_COLLATERAL");
    expect(result.message).toContain("collateral");
    // Regression guard: ensure probe went through determineAction, not rebalance.
    const callData = mockCall.mock.calls[0][0].data as string;
    expect(callData.slice(0, 10)).toBe(DETERMINE_ACTION_SELECTOR);
  });

  it("propagates transport errors during strategy detection", async () => {
    // First probe fails with a transport error (not a contract revert)
    mockReadContract.mockRejectedValueOnce(new Error("fetch failed: 401"));

    await expect(checkRebalanceStatus(POOL, STRATEGY, RPC_URL)).rejects.toThrow(
      "fetch failed",
    );
    // Simulation should never have been attempted
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("propagates transport errors during simulation", async () => {
    // Strategy detection succeeds (reserve)
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");

    // Simulate rebalance fails with a network/transport error (no revert data, no "revert" in message)
    const transportErr = new Error("fetch failed: network error");
    mockCall.mockRejectedValueOnce(transportErr);

    // Should throw so SWR can surface via the error state
    await expect(checkRebalanceStatus(POOL, STRATEGY, RPC_URL)).rejects.toThrow(
      "fetch failed",
    );
  });

  it("does not misclassify 'execution timeout' as a contract revert", async () => {
    // Strategy detection succeeds (reserve)
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");

    // Provider returns "execution timeout" — this is NOT a contract revert
    const providerErr = new Error("execution timeout");
    mockCall.mockRejectedValueOnce(providerErr);

    // Should throw so SWR shows "Diagnostics unavailable"
    await expect(checkRebalanceStatus(POOL, STRATEGY, RPC_URL)).rejects.toThrow(
      "execution timeout",
    );
  });

  it("decodes nested { data: { data: Hex } } error payloads", async () => {
    // Strategy detection: CDP
    mockReadContract.mockResolvedValueOnce({
      stabilityPool: "0x4444444444444444444444444444444444444444",
      collateralRegistry: "0x5555555555555555555555555555555555555555",
      stabilityPoolPercentage: BigInt(100),
      maxIterations: BigInt(10),
    });

    const CDPLS_SELECTOR = keccak256(
      toBytes("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW()"),
    ).slice(0, 10) as `0x${string}`;

    // Error uses nested { data: { data: "0x..." } } form
    const err = new Error("execution reverted");
    Object.assign(err, { data: { data: CDPLS_SELECTOR } });
    mockCall.mockRejectedValueOnce(err);

    // Skip enrichment mocks (just verify decoding works)
    mockReadContract.mockRejectedValueOnce(new Error("skip enrichment"));

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.rawError).toBe("CDPLS_STABILITY_POOL_BALANCE_TOO_LOW");
  });

  it("returns reserve enrichment on RLS_RESERVE_OUT_OF_COLLATERAL", async () => {
    const RESERVE_ADDR = "0x3333333333333333333333333333333333333333";
    const TOKEN0 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN1 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // Strategy type detection: getCDPConfig reverts (contract-level), reserve() succeeds
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce(RESERVE_ADDR);

    // Simulate rebalance reverts with RLS_RESERVE_OUT_OF_COLLATERAL
    const RLS_SELECTOR = keccak256(
      toBytes("RLS_RESERVE_OUT_OF_COLLATERAL()"),
    ).slice(0, 10) as `0x${string}`;
    const err = new Error("execution reverted");
    Object.assign(err, { data: RLS_SELECTOR });
    mockCall.mockRejectedValueOnce(err);

    // Enrichment calls:
    // 1. reserve() again
    // 2. poolConfigs(pool) → returns tuple with isToken0Debt=true
    // 3. token0()
    // 4. token1()
    // 5. balanceOf(reserveAddr) on collateral token (token1 since token0 is debt)
    // 6. symbol() on collateral token
    // 7. decimals() on collateral token
    mockReadContract
      .mockResolvedValueOnce(RESERVE_ADDR) // reserve()
      .mockResolvedValueOnce([
        true,
        0,
        0,
        "0x0000000000000000000000000000000000000000",
        BigInt(0),
        BigInt(0),
        BigInt(0),
        BigInt(0),
      ]) // poolConfigs — isToken0Debt=true
      .mockResolvedValueOnce(TOKEN0) // token0
      .mockResolvedValueOnce(TOKEN1) // token1
      .mockResolvedValueOnce(BigInt(5000) * BigInt(10 ** 18)) // balanceOf (5000 tokens)
      .mockResolvedValueOnce("USDC") // symbol
      .mockResolvedValueOnce(18); // decimals

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.strategyType).toBe("reserve");
    expect(result.rawError).toBe("RLS_RESERVE_OUT_OF_COLLATERAL");
    expect(result.message).toContain("Reserve has insufficient collateral");
    expect(result.enrichment).toEqual({
      type: "reserve",
      reserveCollateralBalance: 5000,
      collateralTokenSymbol: "USDC",
      collateralTokenDecimals: 18,
    });
  });

  it("handles revert with no parseable data gracefully", async () => {
    // Use a known strategy so we get past the unknown guard
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333");

    // Revert with "revert" in message but no data
    const err = new Error("execution reverted");
    mockCall.mockRejectedValueOnce(err);

    const result = await checkRebalanceStatus(POOL, STRATEGY, RPC_URL);

    expect(result.canRebalance).toBe(false);
    expect(result.message).toBe("Rebalance reverted with an unknown error");
    expect(result.strategyType).toBe("reserve");
  });
});

describe("toHumanUnits — large-balance precision", () => {
  // BigInt(...) call form — ui-dashboard tsconfig targets ES2017, which
  // doesn't emit BigInt `10n`-style literals.
  const ten = BigInt(10);

  it("returns 0 for zero", () => {
    expect(toHumanUnits(BigInt(0), 18)).toBe(0);
  });

  it("returns the raw value when decimals is 0", () => {
    expect(toHumanUnits(BigInt(12345), 0)).toBe(12345);
  });

  it("preserves precision for balances well above 2^53 (18 decimals)", () => {
    // 10M tokens at 18 decimals = 1e25 wei — raw > 2^53 (~9e15).
    // Previous `Number(bigint) / 10**decimals` would round the low-order
    // bits; we should still see 10,000,000 exactly.
    const tenMillion = BigInt(10_000_000) * ten ** BigInt(18);
    expect(toHumanUnits(tenMillion, 18)).toBe(10_000_000);
  });

  it("keeps fractional digits within the 6-digit scale", () => {
    // 1.5 tokens at 6 decimals = 1_500_000 wei.
    expect(toHumanUnits(BigInt(1_500_000), 6)).toBeCloseTo(1.5, 6);
  });

  it("represents large whole + small fractional without cross-contamination", () => {
    // 123,456,789.123456 tokens at 18 decimals
    const raw =
      BigInt(123_456_789) * ten ** BigInt(18) +
      BigInt(123_456) * ten ** BigInt(12); /* .123456 */
    expect(toHumanUnits(raw, 18)).toBeCloseTo(123_456_789.123456, 5);
  });
});
