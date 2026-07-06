/** Health status badge for oracle/pool health (OK | WARN | WEEKEND | HALTED | CRITICAL | N/A) */
export function HealthBadge({ status }: { status: string }) {
  const configs: Record<
    string,
    { label: string; dot: string; bg: string; text: string }
  > = {
    OK: {
      label: "OK",
      dot: "🟢",
      bg: "bg-emerald-500/20",
      text: "text-emerald-300",
    },
    WARN: {
      label: "WARN",
      dot: "🟡",
      bg: "bg-amber-500/20",
      text: "text-amber-300",
    },
    WEEKEND: {
      label: "Weekend",
      dot: "🌙",
      bg: "bg-slate-500/20",
      text: "text-slate-300",
    },
    HALTED: {
      label: "Halted",
      dot: "🛑",
      // Orange — distinct from WARN (amber) and CRITICAL (red): trading is
      // paused by a circuit breaker, a real user impact but not a protocol
      // fault on our side.
      bg: "bg-orange-500/20",
      text: "text-orange-300",
    },
    CRITICAL: {
      label: "CRITICAL",
      dot: "🔴",
      bg: "bg-red-500/20",
      text: "text-red-300",
    },
    "N/A": {
      label: "N/A",
      dot: "⚪",
      bg: "bg-slate-500/20",
      text: "text-slate-400",
    },
  };

  const cfg = configs[status] ?? configs["N/A"]!;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span aria-hidden="true">{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

export function SourceBadge({
  source,
  wrappedExchangeId,
}: {
  source: string;
  wrappedExchangeId?: string | null | undefined;
}) {
  // Healed VirtualPools intentionally retain `fpmm_*` source for
  // pickPreferredSource priority alignment; `wrappedExchangeId` is the
  // VP-side canonical signal. Same disjoint logic as `isVirtualPool` /
  // `isFpmm` (kept inline here to avoid pulling tokens.ts into a
  // pure-presentation component).
  const isVirtual = source.includes("virtual") || Boolean(wrappedExchangeId);
  const label = isVirtual ? "Virtual" : "FPMM";
  // Pool TYPE, not health STATE — so both variants stay off the emerald/amber/
  // red alarm palette reserved for HealthBadge/LimitBadge. Virtual = neutral
  // slate, FPMM = indigo; the color follows the same predicate as the label so
  // non-virtual non-fpmm sources (e.g. `oracle_reported` on a synthetic test
  // fixture) get a consistent FPMM/indigo treatment instead of an
  // FPMM-label-with-Virtual-color mismatch (round 7 cursor finding).
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        isVirtual
          ? "bg-slate-500/20 text-slate-300"
          : "bg-indigo-500/20 text-indigo-300"
      }`}
    >
      {label}
    </span>
  );
}

/** Trading limit status badge (OK | WARN | CRITICAL | N/A) */
export function LimitBadge({ status }: { status: string }) {
  const configs: Record<
    string,
    { label: string; dot: string; bg: string; text: string }
  > = {
    OK: {
      label: "OK",
      dot: "🟢",
      bg: "bg-emerald-500/20",
      text: "text-emerald-300",
    },
    WARN: {
      label: "WARN",
      dot: "🟡",
      bg: "bg-amber-500/20",
      text: "text-amber-300",
    },
    CRITICAL: {
      label: "CRITICAL",
      dot: "🔴",
      bg: "bg-red-500/20",
      text: "text-red-300",
    },
    "N/A": {
      label: "N/A",
      dot: "⚪",
      bg: "bg-slate-500/20",
      text: "text-slate-400",
    },
  };

  const cfg = configs[status] ?? configs["N/A"]!;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span aria-hidden="true">{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  const isMint = kind === "MINT";
  // MINT / BURN are routine liquidity ops, not alarm states — keep them off the
  // emerald/amber/red palette (which would read as OK/WARN severity). The kind
  // text carries the meaning; sky vs slate just distinguishes the two.
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        isMint ? "bg-sky-500/20 text-sky-300" : "bg-slate-500/20 text-slate-300"
      }`}
    >
      {kind}
    </span>
  );
}
