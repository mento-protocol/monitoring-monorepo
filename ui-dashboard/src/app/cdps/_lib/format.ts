import { formatWei } from "@/lib/format";

export function formatBpsPercent(bps: number | null | undefined): string {
  if (bps == null || bps < 0) return "—";
  return `${(bps / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function formatTokenAmount(
  value: string | null | undefined,
  symbol: string,
): string {
  if (value == null) return "—";
  return `${formatWei(value, 18, 2)} ${symbol}`;
}

export function cdpSymbolSlug(symbol: string): string {
  return symbol.toLowerCase();
}
