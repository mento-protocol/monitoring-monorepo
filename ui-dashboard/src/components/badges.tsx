/** Health status badge for oracle/pool health (OK | WARN | WEEKEND | CRITICAL | N/A) */
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

  const cfg = configs[status] ?? configs["N/A"];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span aria-hidden="true">{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const isFPMM = source.includes("fpmm");
  const label = isFPMM ? "FPMM" : "Virtual";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        isFPMM
          ? "bg-indigo-500/20 text-indigo-300"
          : "bg-emerald-500/20 text-emerald-300"
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

  const cfg = configs[status] ?? configs["N/A"];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.text}`}
    >
      <span aria-hidden="true">{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

const NA_BADGE_CONFIG = {
  label: "N/A",
  dot: "⚪",
  bg: "bg-slate-500/20",
  text: "text-slate-400",
} as const;

/** Rebalancer liveness badge (ACTIVE | STALE | N/A | NO_DATA) */
export function RebalancerBadge({ status }: { status: string }) {
  const configs: Record<
    string,
    { label: string; dot: string; bg: string; text: string }
  > = {
    ACTIVE: {
      label: "ACTIVE",
      dot: "🟢",
      bg: "bg-emerald-500/20",
      text: "text-emerald-300",
    },
    STALE: {
      label: "STALE",
      dot: "🔴",
      bg: "bg-red-500/20",
      text: "text-red-300",
    },
    "N/A": NA_BADGE_CONFIG,
    NO_DATA: NA_BADGE_CONFIG,
  };

  const cfg = configs[status] ?? configs["N/A"];
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
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        isMint
          ? "bg-emerald-500/20 text-emerald-300"
          : "bg-amber-500/20 text-amber-300"
      }`}
    >
      {kind}
    </span>
  );
}
