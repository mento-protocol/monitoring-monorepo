/** Tiny pill rendered next to a trader address when the indexer has flagged
 * it as a Mento protocol actor (rebalancer, NTT, treasury, etc.). */
export function ProtocolActorChip() {
  return (
    <span
      className="rounded bg-slate-700/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-slate-300"
      title="Mento protocol actor (rebalancer, NTT, treasury, etc.)"
      aria-label="Protocol actor — Mento internal contract (rebalancer, NTT, treasury, etc.)"
    >
      Protocol
    </span>
  );
}
