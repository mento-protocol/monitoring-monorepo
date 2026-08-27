// Small formatting helpers scoped to the trove history page. Mirrors (does
// not import — `trove-cells.tsx` keeps these private, and this route stays
// out of `[symbol]/_components/`) the equivalent helpers in
// `../../_components/trove-cells.tsx`; a rename there should be echoed here.

const D18 = BigInt(10) ** BigInt(18);
const MENTO_APP_BORROW_MANAGE_BASE_URL = "https://app.mento.org/borrow/manage";

export function formatBpsPercent(bps: number): string {
  if (bps < 0) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatInterestRate(rate: string | null | undefined): string {
  if (rate == null) return "—";
  const big = BigInt(rate);
  if (big === BigInt(0)) return "0.00%";
  const hundredths = (big * BigInt(10_000)) / D18;
  if (hundredths === BigInt(0)) return "<0.01%";
  return `${(Number(hundredths) / 100).toFixed(2)}%`;
}

export function icrTextClass(icrBps: number, mcrBps: number): string {
  if (icrBps < 0 || mcrBps <= 0) return "text-slate-500";
  if (icrBps < mcrBps) return "text-rose-300";
  if (icrBps < Math.ceil(mcrBps * 1.2)) return "text-amber-300";
  return "text-emerald-300";
}

export function troveManageUrl(troveId: string, tokenSymbol: string): string {
  return `${MENTO_APP_BORROW_MANAGE_BASE_URL}/${encodeURIComponent(
    troveId,
  )}?token=${encodeURIComponent(tokenSymbol)}`;
}
