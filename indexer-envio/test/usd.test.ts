/// <reference types="mocha" />
import { strict as assert } from "assert";
import { computeRebalanceUsd, USD_PEGGED_SYMBOLS } from "../src/usd";

// Real Celo mainnet addresses — resolvable through KNOWN_TOKEN_META
// (`feeToken.ts` builds it from `@mento-protocol/contracts/contracts.json`).
const CHAIN_CELO = 42220;
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a"; // 18dp, USD-pegged
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C"; // 6dp,  USD-pegged
const CELO = "0x471ece3750da237f93b8e339c536989b8978a438"; // 18dp, NOT pegged
const UNKNOWN_TOKEN = "0x000000000000000000000000000000000000beef";

describe("computeRebalanceUsd", () => {
  it("USDm-side delta on USDm/CELO pool: notional = |delta0|/1e18, reward = notional × bps/10000", () => {
    // Pool gave 1000 USDm to balance, took ~1500 CELO out.
    // amount0Delta = -1_000 * 1e18  (USDm, USD-pegged, abs = 1000 USD)
    // rewardBps = 25 → reward = 1000 × 0.0025 = 2.5
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_500n * 10n ** 18n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "1000.0000");
    assert.equal(result.rewardUsd, "2.5000");
  });

  it("USDm side as token1: pulls notional from amount1Delta", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: CELO,
      token1: USDM,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: 1_500n * 10n ** 18n,
      amount1Delta: -1_000n * 10n ** 18n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "1000.0000");
    assert.equal(result.rewardUsd, "2.5000");
  });

  it("6-decimal USDC pool: scales correctly", () => {
    // amount0Delta = 1234.567890 USDC (6dp) → notional = 1234.5678
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDC,
      token1: CELO,
      token0Decimals: 6,
      token1Decimals: 18,
      amount0Delta: 1_234_567_890n,
      amount1Delta: -10n * 10n ** 18n,
      rewardBps: 100, // 1%
    });
    assert.equal(result.notionalUsd, "1234.5678");
    assert.equal(result.rewardUsd, "12.3456");
  });

  it("rewardBps = -2 (getter-missing sentinel) normalizes to 0 → '0.0000' reward", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_500n * 10n ** 18n,
      rewardBps: -2,
    });
    assert.equal(result.notionalUsd, "1000.0000");
    assert.equal(result.rewardUsd, "0.0000");
  });

  it("rewardBps = -1 (RPC-not-yet-read sentinel) also normalizes to 0", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: -100n * 10n ** 18n,
      amount1Delta: 0n,
      rewardBps: -1,
    });
    assert.equal(result.notionalUsd, "100.0000");
    assert.equal(result.rewardUsd, "0.0000");
  });

  it("zero deltas (RPC fallback path) → '' sentinel for both fields", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: 0n,
      amount1Delta: 0n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "");
    assert.equal(result.rewardUsd, "");
  });

  it("both tokens USD-pegged (e.g. USDm/USDC) → '' sentinel (ambiguous side)", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: USDC,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_000_000_000n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "");
    assert.equal(result.rewardUsd, "");
  });

  it("neither token USD-pegged or unknown → '' sentinel", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: UNKNOWN_TOKEN,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_500n * 10n ** 18n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "");
    assert.equal(result.rewardUsd, "");
  });

  it("truncates sub-4dp precision (BigInt division floors)", () => {
    // 999_999_999_999_999n wei (18dp) ≈ 0.000999999999999999 USD
    // → 4dp truncation = "0.0009"
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: 999_999_999_999_999n,
      amount1Delta: -1n,
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "0.0009");
    assert.equal(result.rewardUsd, "0.0000");
  });
});

describe("USD_PEGGED_SYMBOLS — drift protection vs ui-dashboard/src/lib/tokens.ts", () => {
  // Mirror of `ui-dashboard/src/lib/tokens.ts:12-21`. If the dashboard set
  // changes (e.g. a new wrapped USD stablecoin gets onboarded), this set
  // must update too — otherwise indexer-side rewardUsd would diverge from
  // dashboard-side tokenToUSD on the same pool.
  const EXPECTED = new Set([
    "cUSD",
    "USDC",
    "axlUSDC",
    "USDT",
    "USDT0",
    "USD₮",
    "USDm",
    "AUSD",
  ]);

  it("matches the dashboard's USD_PEGGED_SYMBOLS set verbatim", () => {
    assert.deepEqual(
      [...USD_PEGGED_SYMBOLS].sort(),
      [...EXPECTED].sort(),
      "indexer USD_PEGGED_SYMBOLS drifted from ui-dashboard/src/lib/tokens.ts:12-21 — update both in lockstep",
    );
  });
});
