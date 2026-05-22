import { formatWei } from "@/lib/format";

/** Format an UNSIGNED wei amount. `-1` is the indexer's "unknown" sentinel
 * (e.g. `spHeadroom`, ICR percentiles before the price feed lands) and renders
 * as `—`. For signed values (deltas) use {@link formatSignedWei} — a `-1 wei`
 * withdrawal is a legitimate amount, not a sentinel. */
export function formatTokenAmount(
  value: string | null | undefined,
  symbol: string,
): string {
  if (value == null) return "—";
  if (BigInt(value) === BigInt(-1)) return "—";
  return `${formatWei(value, 18, 2)} ${symbol}`;
}

/** Format a SIGNED wei amount. Unlike {@link formatTokenAmount}, this does
 * NOT treat `-1` as an "unknown" sentinel — the int256 deltas on
 * `TroveOperationEvent.collChange` / `debtChange` are signed, so a literal
 * `-1 wei` is a real (if astronomically small) withdrawal/repayment. Only
 * `null`/`undefined` resolve to `—`. */
export function formatSignedWei(
  value: string | null | undefined,
  symbol: string,
): string {
  if (value == null) return "—";
  const big = BigInt(value);
  if (big < BigInt(0)) {
    const absolute = formatWei((-big).toString(), 18, 2);
    return `-${absolute} ${symbol}`;
  }
  return `${formatWei(value, 18, 2)} ${symbol}`;
}

export function cdpSymbolSlug(symbol: string): string {
  return symbol.toLowerCase();
}

/** Render a Redemptions-tile subtitle. `null`/`undefined` means the upstream
 * instance is unknown (no `LiquityInstance` indexed yet, or a transient query
 * gap) — render `—`, NOT a happy-path `0 events`. */
export function redemptionEventSubtitle(
  count: number | null | undefined,
): string {
  if (count == null) return "—";
  return `${count.toLocaleString()} event${count === 1 ? "" : "s"}`;
}
