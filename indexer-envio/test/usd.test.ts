import { strict as assert } from "assert";
import {
  applyFeeBps,
  computeRebalanceUsd,
  computeSwapUsdWei,
  normalizeRewardBps,
  USD_PEGGED_SYMBOLS,
  USD_WEI_DECIMALS,
} from "../src/usd.js";

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

  it("rewardBps = 0 → '0.0000' reward (caller normalizes -1/-2 sentinels first)", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_500n * 10n ** 18n,
      rewardBps: 0,
    });
    assert.equal(result.notionalUsd, "1000.0000");
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

  it("both tokens USD-pegged (USDm/USDC): picks the side with larger USD notional", () => {
    // USDm side: |delta0|/1e18 = 1000.0000 USD
    // USDC side: |delta1|/1e6  = 1000.0001 USD (slightly larger after fees)
    // Should use USDC side (larger).
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: USDC,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0Delta: -1_000n * 10n ** 18n,
      amount1Delta: 1_000_000_100n, // 1000.0001 USDC
      rewardBps: 25,
    });
    assert.equal(result.notionalUsd, "1000.0001");
    assert.equal(result.rewardUsd, "2.5000");
  });

  it("both tokens USD-pegged: picks token0 when its delta is larger", () => {
    const result = computeRebalanceUsd({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: USDC,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0Delta: -1_000n * 10n ** 18n, // 1000 USDM
      amount1Delta: 999_500_000n, // 999.5 USDC
      rewardBps: 100,
    });
    assert.equal(result.notionalUsd, "1000.0000");
    assert.equal(result.rewardUsd, "10.0000");
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
    assert.deepStrictEqual(
      [...USD_PEGGED_SYMBOLS].sort(),
      [...EXPECTED].sort(),
      "indexer USD_PEGGED_SYMBOLS drifted from ui-dashboard/src/lib/tokens.ts:12-21 — update both in lockstep",
    );
  });
});

describe("computeSwapUsdWei", () => {
  // Helper: build USD-wei from a USD figure expressed in dollars.
  const usd = (n: bigint | number): bigint =>
    typeof n === "bigint"
      ? n * 10n ** BigInt(USD_WEI_DECIMALS)
      : BigInt(n) * 10n ** BigInt(USD_WEI_DECIMALS);

  it("USDm/CELO swap selling 1000 USDm → 1000 USD-wei", () => {
    // amount0In = 1000 USDm (18dp), amount1Out = received CELO
    // Pegged side is token0 → notional = 1000 USD.
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0In: 1_000n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_500n * 10n ** 18n,
    });
    assert.equal(result, usd(1000));
  });

  it("USDm side as token1, buying USDm → reads from amount1Out", () => {
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: CELO,
      token1: USDM,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0In: 1_500n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_000n * 10n ** 18n,
    });
    assert.equal(result, usd(1000));
  });

  it("USDC (6dp) swap → scales up to 18-decimal USD-wei", () => {
    // 1234.567890 USDC = 1_234_567_890 wei (6dp). USD-wei = 1234.567890 × 10^18
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: USDC,
      token1: CELO,
      token0Decimals: 6,
      token1Decimals: 18,
      amount0In: 1_234_567_890n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_000n * 10n ** 18n,
    });
    // 1_234_567_890 × 10^12 = 1234567890000000000000 wei = 1234.567890 USD
    assert.equal(result, 1_234_567_890n * 10n ** 12n);
  });

  it("non-pegged token + unknown token → 0", () => {
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: UNKNOWN_TOKEN,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0In: 1_000n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_500n * 10n ** 18n,
    });
    assert.equal(result, 0n);
  });

  it("missing token addresses → 0", () => {
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: undefined,
      token1: undefined,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0In: 1_000n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_500n * 10n ** 18n,
    });
    assert.equal(result, 0n);
  });

  it("both sides USD-pegged (USDm/USDC): picks side with larger USD notional", () => {
    // USDm side: |amount0In - amount0Out| = 1000.0 USDm
    // USDC side: |amount1In - amount1Out| = 1000.0001 USDC (slightly larger)
    // Should use the USDC side.
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: USDC,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0In: 1_000n * 10n ** 18n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 1_000_000_100n,
    });
    // 1_000_000_100 × 10^12 = 1000.0001 × 10^18
    assert.equal(result, 1_000_000_100n * 10n ** 12n);
  });

  it("zero amounts → 0 USD-wei (degenerate, but well-defined)", () => {
    const result = computeSwapUsdWei({
      chainId: CHAIN_CELO,
      token0: USDM,
      token1: CELO,
      token0Decimals: 18,
      token1Decimals: 18,
      amount0In: 0n,
      amount0Out: 0n,
      amount1In: 0n,
      amount1Out: 0n,
    });
    assert.equal(result, 0n);
  });
});

describe("applyFeeBps", () => {
  const oneUsd = 10n ** 18n;
  it("30 bps on 1000 USD = 3.0 USD", () => {
    assert.equal(applyFeeBps(1000n * oneUsd, 30), 3n * oneUsd);
  });
  it("0 bps → 0", () => {
    assert.equal(applyFeeBps(1000n * oneUsd, 0), 0n);
  });
  it("negative bps → 0 (defensive against -1/-2 sentinels)", () => {
    assert.equal(applyFeeBps(1000n * oneUsd, -1), 0n);
  });
});

describe("normalizeRewardBps", () => {
  it("clamps -2 sentinel (getter missing — see PR #222) to 0", () => {
    assert.equal(normalizeRewardBps(-2), 0);
  });

  it("clamps -1 sentinel (RPC not yet read) to 0", () => {
    assert.equal(normalizeRewardBps(-1), 0);
  });

  it("passes 0 through", () => {
    assert.equal(normalizeRewardBps(0), 0);
  });

  it("passes positive bps through", () => {
    assert.equal(normalizeRewardBps(25), 25);
  });
});
