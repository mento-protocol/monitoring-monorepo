import { toHumanUnits } from "@mento-protocol/config/units";
import type { PoolRow } from "./types.js";

// SortedOracles fixed-point scale — keep in sync with
// `indexer-envio/src/priceDifference.ts:SORTED_ORACLES_DECIMALS` and the
// dashboard's `ui-dashboard/src/lib/format.ts`. The contract reports rates
// in FixidityLib units, so the bridge gauge has to divide by 10^24 before
// it leaves the bridge for the alert template / dashboard tooltip to read
// directly.
export const SORTED_ORACLES_DECIMALS = 24;

// Pools whose token-count shares ARE their value shares, published into the
// value-share gauges when the oracle-frame conversion cannot run.
//
// Polygon EURm/EUROP is the only member. No oracle network publishes a
// EUROP/EUR price, so per ADR 0042 the pair runs on a hardcoded MANUAL rate
// feed pinned to 1:1 (`EUROPEUR` in `shared-config/oracle-reporters.json`).
// That feed has never landed a SortedOracles median, so `reserveValueShares`
// returns null and the pool would otherwise carry no depletion coverage at all
// under ADR 0067. At a rate of exactly 1 the oracle reference is 1, and the
// value share reduces to the count share — so here the count numbers are the
// depletion measure, not an approximation of it.
//
// Membership requires a rate pinned to 1 by construction. A pair that merely
// trades near parity does not qualify: its rate can move, and the count share
// would then quietly stop answering the depletion question.
//
// Keys are canonical pool IDs — `{chainId}-{lowercaseAddress}`, the form
// `indexer-envio/src/helpers.ts` builds and the only form Hasura returns.
const COUNT_SHARE_VALUE_FALLBACK_POOL_IDS: ReadonlySet<string> = new Set([
  "137-0xcd8c6811d975981f57e7fb32e59f0bee66af3201",
]);

/**
 * Whether the count shares may stand in for the value shares on this pool.
 *
 * Allowlist membership alone is not enough; two more conditions gate it.
 *
 * First, the pair must never have landed a median. The fallback exists for one
 * state — a pair with no oracle-network feed at all, whose rate is pinned to 1
 * — and must not survive that pair acquiring a real feed. `lastMedianPrice` is
 * what distinguishes the two: it is zero only while a feed has never landed a
 * median, and a feed that once worked and then went dark deliberately RETAINS
 * its last non-zero value (see `reserveValueShares`). A retained price means a
 * real median existed and the 1:1 assumption no longer holds; publishing a
 * count share there would replace a real valuation with a fabricated one at
 * exactly the moment the oracle went down, reading as healthy while the pool
 * drains. That case fails closed like every other pool.
 *
 * That condition is "no non-zero median was ever observed", NOT "the feed is
 * live right now". A zero median leaves a zero price in place
 * (`computeMedianLineageNext` in `indexer-envio/src/oracleJump.ts`), so a
 * report that expires or is removed before this pair ever priced keeps the
 * fallback on. That is deliberate: the 1:1 rate is a property of the pair —
 * EUROP has no oracle-network feed to disagree with — not of any one report's
 * freshness, so the value split stays correct while the report is stale. An
 * expired or removed report is a real problem, and the oracle-liveness plane
 * is what pages on it ("Oldest Report Expired [Polygon]" already carries
 * EUROPEUR remediation copy). ADR 0067 keeps depletion and oracle liveness as
 * independent ladders; suppressing a still-correct depletion share here would
 * drop a good signal without adding the outage signal, which already exists.
 *
 * Second, the token decimals must have been read on chain. The 1:1 argument is
 * about the RATE; it says nothing about scale. EURm has 18 decimals and EUROP
 * has 6, so a pool processed before decimal self-healing succeeds carries the
 * schema defaults (18/18) and normalizes the EUROP leg 10^12 times too small.
 * A balanced pool then reads as ~100%/0% — a false page. `metrics.ts` already
 * applies this same gate in `trustedVpOracleMedianInputs` and
 * `vpOracleFreshness` for the same reason.
 */
export function countSharesStandInForValue(
  pool: Pick<PoolRow, "id" | "lastMedianPrice" | "tokenDecimalsKnown">,
): boolean {
  if (!COUNT_SHARE_VALUE_FALLBACK_POOL_IDS.has(pool.id)) return false;
  if (pool.tokenDecimalsKnown !== true) return false;
  return BigInt(pool.lastMedianPrice) === 0n;
}

/**
 * Value-weighted reserve shares, or `null` when they cannot be computed.
 *
 * A token-count share answers "how many tokens sit on each side", which is
 * only a depletion signal when the two legs are worth roughly the same. On an
 * off-parity pair it is dominated by the exchange rate: a healthy, balanced
 * JPYm/USDm pool reads 0.4% / 99.6% by count purely because one JPY is worth
 * ~0.0063 USD. What an operator needs to know — can a swapper still get out
 * on this side — is a question about value.
 *
 * The conversion uses the same frame the FPMM contract and the indexer's
 * `priceDifference` use (`indexer-envio/src/priceDifference.ts`):
 * `reservePrice = r1_normalized / r0_normalized` is compared against
 * `oracleRef`, the price of token0 denominated in token1. `oracleRef` is the
 * SortedOracles median in feed direction, inverted when the pool's on-chain
 * `invertRateFeed` flag says token0 is the feed's quote token. Weighting the
 * legs by `(oracleRef, 1)` therefore reproduces the on-chain equilibrium:
 * a pool sitting exactly on its oracle is 50/50 here, and the min side share
 * is exactly the "how lopsided by value" number the depletion floors want.
 *
 * `invertRateFeed` is per-pool, not per-pair — token ordering differs between
 * chains, and the flag is what compensates. Both JPYm/USDm pools carry the
 * same feed with opposite flags because Celo lists USDm as token0 and Monad
 * lists JPYm as token0. Assuming one orientation for all pools produces a
 * confident wrong answer on the other half of them, so an unread flag
 * (`invertRateFeedKnown === false`) publishes nothing at all.
 *
 * `tokenDecimalsKnown` gates for the same reason one step earlier: unread
 * decimals fall back to the schema default 18/18, and normalizing an off-18
 * leg with the wrong exponent moves the share by orders of magnitude — a much
 * larger error than the rate correction this function exists to make.
 *
 * `medianLive` gates for the same fail-closed reason. It is false when the
 * feed's most recent `MedianUpdated` carried a zero median, and
 * `lastMedianPrice` deliberately RETAINS the last non-zero value across that
 * outage — so a price check alone would keep publishing a share derived from a
 * rate the contract itself no longer honours. `hasFreshLiveMedian` in
 * `indexer-envio/src/priceDifference.ts` refuses to derive rebalance state
 * under the same condition; this follows it rather than inventing a second
 * answer to "is this feed usable".
 *
 * Price precision follows `mento_pool_oracle_price`: both go through
 * `toHumanUnits`, so an operator can reproduce the share from the two
 * published gauges by hand.
 *
 * A null here normally means the value-share gauges publish nothing for the
 * pool. `recordReserveShareMetrics` carries one narrow exception for a pool
 * pinned to a 1:1 rate that has never landed a non-zero median — see
 * `countSharesStandInForValue`. A median that went dark after pricing the pair
 * retains its last non-zero value, so it never takes that path.
 */
export function reserveValueShares(
  pool: Pick<
    PoolRow,
    | "reserves0"
    | "reserves1"
    | "token0Decimals"
    | "token1Decimals"
    | "tokenDecimalsKnown"
    | "lastMedianPrice"
    | "medianLive"
    | "invertRateFeed"
    | "invertRateFeedKnown"
  >,
): { share0: number; share1: number } | null {
  if (
    pool.invertRateFeedKnown !== true ||
    pool.medianLive !== true ||
    pool.tokenDecimalsKnown !== true
  ) {
    return null;
  }
  const price = toHumanUnits(
    BigInt(pool.lastMedianPrice),
    SORTED_ORACLES_DECIMALS,
  );
  if (!Number.isFinite(price) || price <= 0) return null;
  const r0 = Number(pool.reserves0) / 10 ** pool.token0Decimals;
  const r1 = Number(pool.reserves1) / 10 ** pool.token1Decimals;
  // `Math.min` rather than a check per leg: NaN propagates through it, and an
  // infinity that slips past is caught by the finite check on the total below.
  if (!(Math.min(r0, r1) >= 0)) return null;
  const oracleRef = pool.invertRateFeed ? 1 / price : price;
  const value0 = r0 * oracleRef;
  const total = value0 + r1;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { share0: value0 / total, share1: r1 / total };
}
