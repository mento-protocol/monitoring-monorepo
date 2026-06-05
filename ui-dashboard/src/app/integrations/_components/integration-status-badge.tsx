import type { IntegrationProbeStatus } from "@/lib/integration-probes";

const STATUS_STYLES: Record<
  IntegrationProbeStatus,
  { label: string; className: string }
> = {
  pass: {
    label: "Pass",
    className: "bg-emerald-500/20 text-emerald-300",
  },
  partial: {
    label: "Partial",
    className: "bg-yellow-500/20 text-yellow-200",
  },
  fail: {
    label: "Fail",
    className: "bg-red-500/20 text-red-300",
  },
  unsupported: {
    label: "Unsupported",
    className: "bg-slate-500/20 text-slate-300",
  },
  needs_key: {
    label: "Needs key",
    className: "bg-amber-500/20 text-amber-300",
  },
  no_liquidity: {
    label: "No liquidity",
    className: "bg-orange-500/20 text-orange-300",
  },
  rate_limited: {
    label: "Rate-limited",
    className: "bg-cyan-500/20 text-cyan-300",
  },
  error: {
    label: "Error",
    className: "bg-red-500/20 text-red-300",
  },
};

export function IntegrationStatusBadge({
  status,
}: {
  status: IntegrationProbeStatus;
}) {
  const config = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex min-w-[82px] justify-center rounded px-2 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
