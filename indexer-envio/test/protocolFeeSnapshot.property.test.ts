/**
 * Property-based tests for protocolFeeSnapshot bigint-math invariants.
 *
 * These complement the unit tests in poolDailyFeeSnapshot.test.ts by
 * checking law-shaped invariants across arbitrary inputs rather than specific
 * scenarios. Invariants covered:
 *
 *  1. mergeFeeSnapshot (first write): transferCount always starts at 1
 *  2. mergeFeeSnapshot (first write): unresolvedCount is 0 for known symbols
 *  3. mergeFeeSnapshot (first write): unresolvedCount is 1 for UNKNOWN
 *  4. mergeFeeSnapshot (add): transferCount always increases by 1 per add
 *  5. mergeFeeSnapshot (add): amounts[tokenIdx] >= prior amounts[tokenIdx] (monotone)
 *  6. mergeFeeSnapshot (add): feesUsdWei never decreases when adding pegged tokens
 *  7. mergeFeeSnapshot (add): blockNumber always equals the max of all seen values
 *  8. mergeFeeSnapshot (add): unresolvedCount is always >= 0 (Math.max(0,...))
 *  9. mergeFeeSnapshot (add): unresolvedCount <= tokens.length (bounded by slot count)
 * 10. mergeFeeSnapshot (add): commutativity — two distinct-token adds in either
 *     order yield the same total feesUsdWei and transferCount
 * 11. mergeFeeSnapshot (heal): amounts array is unchanged after heal
 * 12. mergeFeeSnapshot (heal): transferCount is unchanged after heal
 * 13. mergeFeeSnapshot (heal): unresolvedCount never increases after heal
 * 14. mergeFeeSnapshot (heal mode, undefined existing): returns null
 * 15. recomputeAllPegged: allPegged true only when ALL symbols are pegged
 */

import { describe, it } from "vitest";
import { strict as assert } from "assert";
import * as fc from "fast-check";
import { mergeFeeSnapshot } from "../src/protocolFeeSnapshot.js";
import { computeFeeUsdWei, USD_PEGGED_SYMBOLS } from "../src/usd.js";
import { dayBucket, makePoolId } from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const CHAIN = 42220;
const POOL_ADDRESS = "0x00000000000000000000000000000000deadbeef";
const POOL_ID = makePoolId(CHAIN, POOL_ADDRESS);
const BASE_DAY_TS = dayBucket(1_736_928_000n); // 2025-01-15 UTC midnight

const PEGGED_SYMBOLS = [...USD_PEGGED_SYMBOLS]; // ["cUSD","USDC","axlUSDC","USDT","USDT0","USD₮","USDm","AUSD"]

/** Arbitrary pegged token symbol. */
const arbPeggedSymbol: fc.Arbitrary<string> = fc.constantFrom(
  ...PEGGED_SYMBOLS,
);

/** Arbitrary non-pegged symbol (never "UNKNOWN", never in PEGGED_SYMBOLS). */
const arbNonPeggedSymbol: fc.Arbitrary<string> = fc
  .string({ minLength: 2, maxLength: 8 })
  .filter((s) => !USD_PEGGED_SYMBOLS.has(s) && s !== "UNKNOWN");

/** Arbitrary token amount in wei (non-negative, up to 10^30). */
const arbAmount: fc.Arbitrary<bigint> = fc.bigInt({ min: 0n, max: 10n ** 30n });

/** Arbitrary token decimals — commonly 6 or 18. */
const arbDecimals: fc.Arbitrary<number> = fc.constantFrom(6, 18);

/** Arbitrary block number. */
const arbBlockNumber: fc.Arbitrary<bigint> = fc.bigInt({
  min: 1n,
  max: 10_000_000n,
});

function arbAddress(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[0-9a-f]{40}$/).map((h) => `0x${h}`);
}

/** Build a minimal MergeInput for a pegged token. */
function makePeggedInput({
  token,
  symbol,
  decimals,
  amount,
  blockNumber,
}: {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  blockNumber: bigint;
}) {
  return {
    id: `${CHAIN}-${POOL_ADDRESS}-${BASE_DAY_TS}`,
    chainId: CHAIN,
    poolId: POOL_ID,
    poolAddress: POOL_ADDRESS,
    timestamp: BASE_DAY_TS,
    token,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    amount,
    blockNumber,
    updatedAtTimestamp: BASE_DAY_TS,
  };
}

// ---------------------------------------------------------------------------
// 1. First write: transferCount always starts at 1
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (first write) — transferCount starts at 1", () => {
  it("any first-write always sets transferCount = 1", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amount, blockNumber) => {
          const result = mergeFeeSnapshot(
            undefined,
            makePeggedInput({ token, symbol, decimals, amount, blockNumber }),
          );
          assert.equal(result.transferCount, 1);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. First write: unresolvedCount is 0 for known symbols
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (first write) — unresolvedCount for known symbols", () => {
  it("any known (non-UNKNOWN) symbol → unresolvedCount = 0", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amount, blockNumber) => {
          const result = mergeFeeSnapshot(
            undefined,
            makePeggedInput({ token, symbol, decimals, amount, blockNumber }),
          );
          assert.equal(result.unresolvedCount, 0);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. First write: unresolvedCount is 1 for UNKNOWN
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (first write) — unresolvedCount for UNKNOWN", () => {
  it("UNKNOWN symbol on first write → unresolvedCount = 1", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbBlockNumber,
        (token, decimals, amount, blockNumber) => {
          const result = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol: "UNKNOWN",
              decimals,
              amount,
              blockNumber,
            }),
          );
          assert.equal(result.unresolvedCount, 1);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Add: transferCount increases by exactly 1 per add call
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — transferCount increments by 1", () => {
  it("each add call increments transferCount by exactly 1", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        // Three amounts for: first write + two adds
        arbAmount,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amt1, amt2, amt3, blockNumber) => {
          const input = (amount: bigint) =>
            makePeggedInput({ token, symbol, decimals, amount, blockNumber });

          const s1 = mergeFeeSnapshot(undefined, input(amt1));
          assert.equal(s1.transferCount, 1);

          const s2 = mergeFeeSnapshot(s1, input(amt2));
          assert.equal(s2.transferCount, 2);

          const s3 = mergeFeeSnapshot(s2, input(amt3));
          assert.equal(s3.transferCount, 3);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Add: amounts[tokenIdx] is monotone (never decreases)
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — amounts are monotone non-decreasing", () => {
  it("amounts[0] after add is always >= amounts[0] before add", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        // Second add amount: may be 0n (still valid, adds nothing to the raw amount but bumps count)
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amt1, amt2, blockNumber) => {
          const input = (amount: bigint) =>
            makePeggedInput({ token, symbol, decimals, amount, blockNumber });
          const s1 = mergeFeeSnapshot(undefined, input(amt1));
          const s2 = mergeFeeSnapshot(s1, input(amt2));

          assert(
            (s2.amounts[0] ?? 0n) >= (s1.amounts[0] ?? 0n),
            `amounts[0] decreased: was ${s1.amounts[0]}, now ${s2.amounts[0]}`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Add: feesUsdWei never decreases when adding pegged tokens
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — feesUsdWei monotone for pegged tokens", () => {
  it("feesUsdWei after add is always >= feesUsdWei before add (for pegged tokens)", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amt1, amt2, blockNumber) => {
          const input = (amount: bigint) =>
            makePeggedInput({ token, symbol, decimals, amount, blockNumber });
          const s1 = mergeFeeSnapshot(undefined, input(amt1));
          const s2 = mergeFeeSnapshot(s1, input(amt2));

          assert(
            s2.feesUsdWei >= s1.feesUsdWei,
            `feesUsdWei decreased: was ${s1.feesUsdWei}, now ${s2.feesUsdWei}`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Add: blockNumber is always the max of all inputs
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — blockNumber = max of all inputs", () => {
  it("blockNumber after two adds always equals the larger blockNumber", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        arbBlockNumber,
        (token, symbol, decimals, amt1, amt2, block1, block2) => {
          const s1 = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol,
              decimals,
              amount: amt1,
              blockNumber: block1,
            }),
          );
          const s2 = mergeFeeSnapshot(
            s1,
            makePeggedInput({
              token,
              symbol,
              decimals,
              amount: amt2,
              blockNumber: block2,
            }),
          );
          const expectedMax = block1 > block2 ? block1 : block2;
          assert.equal(
            s2.blockNumber,
            expectedMax,
            `blockNumber should be max(${block1}, ${block2}) = ${expectedMax}, got ${s2.blockNumber}`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Add: unresolvedCount is always >= 0
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — unresolvedCount >= 0", () => {
  it("unresolvedCount is always non-negative (Math.max(0, ...) guard)", () => {
    // Exercise the heal path via a self-heal (UNKNOWN → resolved in add mode)
    // to trigger the Math.max(0, unresolvedCount - 1) expression.
    fc.assert(
      fc.property(
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbAmount,
        arbPeggedSymbol,
        arbBlockNumber,
        (token, decimals, amt1, amt2, resolvedSymbol, blockNumber) => {
          // First add: UNKNOWN
          const s1 = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol: "UNKNOWN",
              decimals,
              amount: amt1,
              blockNumber,
            }),
          );
          // Second add: same token, now resolved → triggers Math.max(0, unresolvedCount - 1)
          const s2 = mergeFeeSnapshot(
            s1,
            makePeggedInput({
              token,
              symbol: resolvedSymbol,
              decimals,
              amount: amt2,
              blockNumber,
            }),
          );
          assert(
            s2.unresolvedCount >= 0,
            `unresolvedCount is negative: ${s2.unresolvedCount}`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Add: unresolvedCount <= tokens.length
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — unresolvedCount bounded by slot count", () => {
  it("unresolvedCount is always <= tokens.length", () => {
    fc.assert(
      fc.property(
        // Two distinct token addresses
        arbAddress(),
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        (token1, token2, decimals, amt1, amt2, blockNumber) => {
          fc.pre(token1 !== token2);

          const s1 = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token: token1,
              symbol: "UNKNOWN",
              decimals,
              amount: amt1,
              blockNumber,
            }),
          );
          const s2 = mergeFeeSnapshot(
            s1,
            makePeggedInput({
              token: token2,
              symbol: "UNKNOWN",
              decimals,
              amount: amt2,
              blockNumber,
            }),
          );

          assert(
            s2.unresolvedCount <= s2.tokens.length,
            `unresolvedCount (${s2.unresolvedCount}) > tokens.length (${s2.tokens.length})`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Add: commutativity — two distinct-token adds in either order
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (add) — two-token add commutativity", () => {
  it("adding token A then B yields the same feesUsdWei and transferCount as B then A", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbAddress(),
        arbPeggedSymbol,
        arbPeggedSymbol,
        arbDecimals,
        arbDecimals,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        (tokenA, tokenB, symA, symB, decA, decB, amtA, amtB, blockNumber) => {
          fc.pre(tokenA !== tokenB);

          const inputA = makePeggedInput({
            token: tokenA,
            symbol: symA,
            decimals: decA,
            amount: amtA,
            blockNumber,
          });
          const inputB = makePeggedInput({
            token: tokenB,
            symbol: symB,
            decimals: decB,
            amount: amtB,
            blockNumber,
          });

          // A then B
          const s_A = mergeFeeSnapshot(undefined, inputA);
          const s_AB = mergeFeeSnapshot(s_A, inputB);

          // B then A
          const s_B = mergeFeeSnapshot(undefined, inputB);
          const s_BA = mergeFeeSnapshot(s_B, inputA);

          assert.equal(
            s_AB.feesUsdWei,
            s_BA.feesUsdWei,
            `feesUsdWei differs: A→B=${s_AB.feesUsdWei}, B→A=${s_BA.feesUsdWei}`,
          );
          assert.equal(
            s_AB.transferCount,
            s_BA.transferCount,
            "transferCount differs by add order",
          );
          assert.equal(
            s_AB.tokens.length,
            s_BA.tokens.length,
            "token slot count differs by add order",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Heal: amounts array is unchanged after heal
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (heal) — amounts unchanged", () => {
  it("heal mode never modifies the amounts array", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbPeggedSymbol,
        arbBlockNumber,
        (token, decimals, amount, resolvedSymbol, blockNumber) => {
          // Write UNKNOWN first
          const original = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol: "UNKNOWN",
              decimals,
              amount,
              blockNumber,
            }),
          );
          // Heal: resolves metadata, must NOT change amounts
          const healed = mergeFeeSnapshot(
            original,
            makePeggedInput({
              token,
              symbol: resolvedSymbol,
              decimals,
              amount,
              blockNumber,
            }),
            "heal",
          );
          assert(
            healed !== null,
            "heal must return non-null on existing snapshot",
          );
          assert.deepStrictEqual(
            healed.amounts,
            original.amounts,
            "heal must not modify the amounts array",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Heal: transferCount unchanged after heal
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (heal) — transferCount unchanged", () => {
  it("heal mode never modifies transferCount", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbPeggedSymbol,
        arbBlockNumber,
        (token, decimals, amount, resolvedSymbol, blockNumber) => {
          const original = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol: "UNKNOWN",
              decimals,
              amount,
              blockNumber,
            }),
          );
          const healed = mergeFeeSnapshot(
            original,
            makePeggedInput({
              token,
              symbol: resolvedSymbol,
              decimals,
              amount,
              blockNumber,
            }),
            "heal",
          );
          assert(healed !== null);
          assert.equal(healed.transferCount, original.transferCount);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Heal: unresolvedCount never increases after heal
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (heal) — unresolvedCount never increases", () => {
  it("unresolvedCount after heal is always <= unresolvedCount before heal", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbDecimals,
        arbAmount,
        arbPeggedSymbol,
        arbBlockNumber,
        (token, decimals, amount, resolvedSymbol, blockNumber) => {
          const original = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token,
              symbol: "UNKNOWN",
              decimals,
              amount,
              blockNumber,
            }),
          );
          const healed = mergeFeeSnapshot(
            original,
            makePeggedInput({
              token,
              symbol: resolvedSymbol,
              decimals,
              amount,
              blockNumber,
            }),
            "heal",
          );
          assert(healed !== null);
          assert(
            healed.unresolvedCount <= original.unresolvedCount,
            `unresolvedCount increased: was ${original.unresolvedCount}, now ${healed.unresolvedCount}`,
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Heal mode on undefined existing → returns null
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot (heal, undefined existing) — returns null", () => {
  it("heal mode with no existing snapshot always returns null", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbBlockNumber,
        (token, symbol, decimals, amount, blockNumber) => {
          const result = mergeFeeSnapshot(
            undefined,
            makePeggedInput({ token, symbol, decimals, amount, blockNumber }),
            "heal",
          );
          assert.equal(result, null);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 15. allPegged monotone: once false, stays false
// ---------------------------------------------------------------------------
describe("mergeFeeSnapshot — allPegged monotone (false is absorbing)", () => {
  it("once allPegged is false, adding more tokens never reverts it to true", () => {
    fc.assert(
      fc.property(
        arbAddress(),
        arbAddress(),
        arbAddress(),
        arbNonPeggedSymbol,
        arbPeggedSymbol,
        arbDecimals,
        arbAmount,
        arbAmount,
        arbAmount,
        arbBlockNumber,
        (
          tokenA,
          tokenB,
          tokenC,
          nonPeggedSym,
          peggedSym,
          decimals,
          amtA,
          amtB,
          amtC,
          blockNumber,
        ) => {
          fc.pre(tokenA !== tokenB && tokenB !== tokenC && tokenA !== tokenC);

          // Step 1: pegged → allPegged = true
          const s1 = mergeFeeSnapshot(
            undefined,
            makePeggedInput({
              token: tokenA,
              symbol: peggedSym,
              decimals,
              amount: amtA,
              blockNumber,
            }),
          );
          assert.equal(
            s1.allPegged,
            true,
            "setup: first pegged token must give allPegged=true",
          );

          // Step 2: non-pegged → allPegged = false
          const s2 = mergeFeeSnapshot(
            s1,
            makePeggedInput({
              token: tokenB,
              symbol: nonPeggedSym,
              decimals,
              amount: amtB,
              blockNumber,
            }),
          );
          assert.equal(
            s2.allPegged,
            false,
            "setup: non-pegged must flip allPegged to false",
          );

          // Step 3: another pegged token → allPegged must stay false
          const s3 = mergeFeeSnapshot(
            s2,
            makePeggedInput({
              token: tokenC,
              symbol: peggedSym,
              decimals,
              amount: amtC,
              blockNumber,
            }),
          );
          assert.equal(
            s3.allPegged,
            false,
            "allPegged must not revert to true after a non-pegged token was added",
          );
        },
      ),
    );
  });
});
