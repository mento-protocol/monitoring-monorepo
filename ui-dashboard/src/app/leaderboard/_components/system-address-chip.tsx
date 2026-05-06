/** Tiny "System" pill rendered next to a trader address when the indexer
 * has flagged it as a Mento-owned contract (rebalancer, NTT, treasury,
 * etc.). Used by both v3 and v2 leaderboard tables — keep in sync. */
export function SystemAddressChip() {
  return (
    <span
      className="rounded bg-slate-700/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-slate-300"
      title="Mento internal contract (rebalancer, NTT, treasury, etc.)"
    >
      System
    </span>
  );
}
