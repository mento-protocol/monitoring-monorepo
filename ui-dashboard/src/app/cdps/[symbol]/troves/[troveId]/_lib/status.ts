// Indexer status vocabulary for the trove history header badge
// (docs/PLAN-trove-history-page.md, "UI design → Layout → Header card").
// Mirrors `TROVE_STATUS` in
// indexer-envio/src/handlers/liquity/troves.ts:16-22 — kept inline here
// (same rationale as `_lib/transactions.ts`'s `TROVE_OP_BADGE` mirror) since
// the UI can't import across the package boundary. A rename on either side
// must update both.
export const TROVE_STATUSES = [
  "active",
  "zombie",
  "closed",
  "liquidated",
  "redeemed",
] as const;

type TroveStatus = (typeof TROVE_STATUSES)[number];

function isKnownTroveStatus(status: string): status is TroveStatus {
  return (TROVE_STATUSES as readonly string[]).includes(status);
}

const TROVE_STATUS_LABELS: Record<TroveStatus, string> = {
  active: "Active",
  zombie: "Zombie",
  closed: "Closed",
  liquidated: "Liquidated",
  redeemed: "Redeemed",
};

// Tooltip copy for the two non-obvious states is the design doc's own
// language (PLAN-trove-history-page.md:443-445); active/closed/liquidated are
// spelled out to match that same plain, one-sentence register.
const TROVE_STATUS_TOOLTIPS: Record<TroveStatus, string> = {
  active: "Open with debt at or above the market minimum.",
  zombie:
    "Debt below the market minimum after a redemption; unredeemable until adjusted.",
  closed: "Closed by the owner — debt repaid and collateral withdrawn.",
  liquidated:
    "Closed by liquidation — collateral seized to cover debt that fell below the minimum collateral ratio.",
  redeemed:
    "Fully redeemed to zero. Stays a zombie on-chain; the indexer distinguishes it because no debt remains.",
};

const TROVE_STATUS_BADGE_CLASSES: Record<TroveStatus, string> = {
  active: "bg-emerald-500/10 text-emerald-300 border-emerald-700/40",
  zombie: "bg-amber-500/10 text-amber-300 border-amber-700/40",
  closed: "bg-slate-500/10 text-slate-300 border-slate-600/40",
  liquidated: "bg-rose-500/10 text-rose-300 border-rose-700/40",
  redeemed: "bg-indigo-500/10 text-indigo-300 border-indigo-700/40",
};

const UNKNOWN_STATUS_CLASSES =
  "bg-slate-500/10 text-slate-400 border-slate-600/40";

export function troveStatusLabel(status: string): string {
  return isKnownTroveStatus(status) ? TROVE_STATUS_LABELS[status] : status;
}

export function troveStatusTooltip(status: string): string | null {
  return isKnownTroveStatus(status) ? TROVE_STATUS_TOOLTIPS[status] : null;
}

export function troveStatusBadgeClasses(status: string): string {
  return isKnownTroveStatus(status)
    ? TROVE_STATUS_BADGE_CLASSES[status]
    : UNKNOWN_STATUS_CLASSES;
}
