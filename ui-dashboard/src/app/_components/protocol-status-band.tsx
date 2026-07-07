import type {
  ProtocolStatusLevel,
  ProtocolStatusSummary,
} from "../_lib/protocol-status";

export function ProtocolStatusBand({
  summary,
  isLoading,
}: {
  summary: ProtocolStatusSummary;
  isLoading: boolean;
}) {
  const tone = statusTone(summary.level, isLoading);
  const criticalLike = summary.criticalCount + summary.haltedCount;

  return (
    <section
      aria-label="Protocol status"
      className={`rounded-lg border ${tone.shell} px-4 py-4 sm:px-5`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">
            Protocol status
          </h2>
          <p className="mt-1 text-sm text-slate-300" role="status">
            {statusSentence(summary, isLoading)}
          </p>
        </div>
        <span
          className={`inline-flex w-fit rounded border px-2.5 py-1 text-xs font-medium ${tone.badge}`}
        >
          {statusLabel(summary.level, isLoading)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-4">
        <StatusMetric
          label="Critical pools"
          value={isLoading ? "..." : String(criticalLike)}
          detail={criticalDetail(summary)}
          tone={criticalLike > 0 ? "critical" : "neutral"}
        />
        <StatusMetric
          label="Warn pools"
          value={isLoading ? "..." : String(summary.warnCount)}
          detail={warnDetail(summary)}
          tone={summary.warnCount > 0 ? "warning" : "neutral"}
        />
        <StatusMetric
          label="Worst deviation"
          value={
            isLoading
              ? "..."
              : summary.worstDeviation
                ? formatBps(summary.worstDeviation.deviationBps)
                : "0%"
          }
          detail={deviationDetail(summary)}
          tone={
            summary.worstDeviation && summary.worstDeviation.thresholdRatio > 1
              ? "warning"
              : "neutral"
          }
        />
        <StatusMetric
          label="Rebalance watch"
          value={isLoading ? "..." : String(summary.rebalanceInFlightCount)}
          detail={rebalanceDetail(summary)}
          tone={summary.rebalanceInFlightCount > 0 ? "warning" : "neutral"}
        />
      </div>
    </section>
  );
}

function statusSentence(
  summary: ProtocolStatusSummary,
  isLoading: boolean,
): string {
  if (isLoading && summary.totalPools === 0) return "Checking pool health.";
  const criticalLike = summary.criticalCount + summary.haltedCount;
  if (criticalLike > 0) {
    return `${criticalLike} pool${plural(criticalLike)} ${needsVerb(criticalLike)} immediate attention across ${summary.totalPools} loaded pools.`;
  }
  if (summary.warnCount > 0) {
    return `${summary.warnCount} pool${plural(summary.warnCount)} ${isVerb(summary.warnCount)} in warning state across ${summary.totalPools} loaded pools.`;
  }
  if (summary.failedNetworkCount > 0) {
    return `${summary.failedNetworkCount} network${plural(summary.failedNetworkCount)} failed to load, so the status is partial.`;
  }
  if (summary.nonVirtualDataGapCount > 0) {
    return `${summary.nonVirtualDataGapCount} non-virtual pool${plural(summary.nonVirtualDataGapCount)} ${hasVerb(summary.nonVirtualDataGapCount)} incomplete health inputs.`;
  }
  if (summary.totalPools === 0) return "No pools loaded yet.";
  return `No active pool alerts across ${summary.totalPools} loaded pools.`;
}

function statusLabel(level: ProtocolStatusLevel, isLoading: boolean): string {
  if (isLoading && level === "empty") return "Loading";
  if (level === "critical") return "Critical";
  if (level === "warning") return "Attention";
  if (level === "empty") return "No data";
  return "All clear";
}

function statusTone(level: ProtocolStatusLevel, isLoading: boolean) {
  if (!isLoading && level === "critical") {
    return {
      shell: "border-red-900/60 bg-red-950/25",
      badge: "border-red-700/70 bg-red-950/60 text-red-200",
    };
  }
  if (!isLoading && level === "warning") {
    return {
      shell: "border-amber-800/50 bg-amber-950/15",
      badge: "border-amber-700/70 bg-amber-950/60 text-amber-200",
    };
  }
  return {
    shell: "border-slate-800 bg-slate-900/60",
    badge: "border-slate-700 bg-slate-950 text-slate-300",
  };
}

function criticalDetail(summary: ProtocolStatusSummary): string {
  if (summary.criticalCount === 0 && summary.haltedCount === 0) {
    return "No CRITICAL or HALTED pools";
  }
  if (summary.haltedCount === 0) return `${summary.criticalCount} CRITICAL`;
  if (summary.criticalCount === 0) return `${summary.haltedCount} HALTED`;
  return `${summary.criticalCount} CRITICAL, ${summary.haltedCount} HALTED`;
}

function warnDetail(summary: ProtocolStatusSummary): string {
  if (summary.warnCount === 0) return "No warning-state pools";
  const limitSuffix =
    summary.limitAttentionCount > 0
      ? `, ${summary.limitAttentionCount} limit pressure`
      : "";
  return `Includes health and limits${limitSuffix}`;
}

function deviationDetail(summary: ProtocolStatusSummary): string {
  if (!summary.worstDeviation) return "No tracked deviation";
  const pctOfThreshold = (summary.worstDeviation.thresholdRatio * 100).toFixed(
    0,
  );
  return `${summary.worstDeviation.poolLabel} on ${summary.worstDeviation.networkLabel} (${pctOfThreshold}% of threshold)`;
}

function rebalanceDetail(summary: ProtocolStatusSummary): string {
  if (summary.rebalanceInFlightCount === 0) return "No deviation warnings";
  return "Pools above tolerance before escalation";
}

function formatBps(value: number): string {
  const pct = value / 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function needsVerb(count: number): string {
  return count === 1 ? "needs" : "need";
}

function isVerb(count: number): string {
  return count === 1 ? "is" : "are";
}

function hasVerb(count: number): string {
  return count === 1 ? "has" : "have";
}

function StatusMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "warning" | "critical";
}) {
  const valueClass =
    tone === "critical"
      ? "text-red-200"
      : tone === "warning"
        ? "text-amber-200"
        : "text-white";
  return (
    <div className="min-h-[84px]">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${valueClass}`}>
        {value}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-slate-500">{detail}</p>
    </div>
  );
}
