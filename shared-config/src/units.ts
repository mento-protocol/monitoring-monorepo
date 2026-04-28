/**
 * Convert a raw on-chain uint256 balance to a human-units number without
 * losing precision when the raw value exceeds 2^53. `Number(bigint) /
 * 10**decimals` truncates bits past 2^53, which for an 18-decimal token
 * kicks in around 9M whole tokens — well within realistic supplies. We
 * scale down in BigInt first so the Number cast is always safe.
 *
 * Fractional precision is capped at 6 digits (far more than the tooltip
 * needs) to keep the final Number representation lossless. Mirrored
 * historically across `metrics-bridge/src/rebalance-check.ts` and
 * `ui-dashboard/src/lib/rebalance-check.ts` — kept here as the single
 * source of truth so the alert annotation and the dashboard tooltip
 * always agree on rendered units.
 */
export function toHumanUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  // BigInt(...) call form rather than `10n` literal — the ui-dashboard
  // tsconfig targets ES2017, which doesn't emit BigInt literals.
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = raw / divisor;
  const fractionScale = BigInt(1_000_000);
  const fraction = ((raw % divisor) * fractionScale) / divisor;
  return Number(whole) + Number(fraction) / Number(fractionScale);
}
