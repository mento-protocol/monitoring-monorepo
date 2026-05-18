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
