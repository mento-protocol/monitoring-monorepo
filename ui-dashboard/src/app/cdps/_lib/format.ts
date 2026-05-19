import { formatWei } from "@/lib/format";

export function formatTokenAmount(
  value: string | null | undefined,
  symbol: string,
): string {
  if (value == null) return "—";
  if (BigInt(value) === BigInt(-1)) return "—";
  return `${formatWei(value, 18, 2)} ${symbol}`;
}

export function cdpSymbolSlug(symbol: string): string {
  return symbol.toLowerCase();
}

/** Like {@link formatTokenAmount} but accepts a bigint and prefixes `≥` when
 * the aggregate is known to be a floor (trove query hit its row cap). */
export function formatAggregateAmount(
  value: bigint,
  symbol: string,
  truncated: boolean,
): string {
  const base = formatTokenAmount(value.toString(), symbol);
  if (base === "—") return base;
  return truncated ? `≥ ${base}` : base;
}
