import type { ReactNode } from "react";

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
export const formatNumber = (value: number | null) =>
  value === null ? "—" : decimal.format(value);
export const formatBps = (value: number | null) =>
  value === null ? "—" : `${decimal.format(value)} bps`;
export const formatFraction = (value: number | null) =>
  value === null ? "—" : `${decimal.format(value * 100)}%`;
export const formatUnixSeconds = (value: number | null) =>
  value === null
    ? "—"
    : new Date(value * 1_000).toISOString().replace(".000Z", " UTC");
export const formatAge = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3_600)}h`;
};
export const shortAddress = (value: string) =>
  `${value.slice(0, 8)}…${value.slice(-6)}`;
export const titleCase = (value: string | null) =>
  value === null ? "Unknown" : value.replace(/_/g, " ");
export const formatScaled = (raw: string | null, decimals: number) => {
  if (raw === null) return "—";
  const negative = raw.startsWith("-");
  const unsigned = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  const splitAt = Math.max(0, unsigned.length - decimals);
  const whole = decimals === 0 ? unsigned : unsigned.slice(0, splitAt) || "0";
  const fraction =
    decimals === 0
      ? ""
      : unsigned
          .slice(splitAt)
          .padStart(decimals, "0")
          .slice(0, 8)
          .replace(/0+$/, "");
  const isZero = whole.replace(/^0+$/, "") === "" && fraction === "";
  return `${negative && !isZero ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

export function EvidenceItem({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-slate-800/80 bg-slate-950/40 px-3 py-2.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-200">
        {value}
      </dd>
      {detail ? (
        <dd className="mt-0.5 break-words text-[11px] text-slate-500">
          {detail}
        </dd>
      ) : null}
    </div>
  );
}
export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
}): React.JSX.Element {
  const style = {
    good: "border-emerald-500/30 bg-emerald-950/60 text-emerald-300",
    warn: "border-amber-500/30 bg-amber-950/60 text-amber-200",
    bad: "border-red-500/30 bg-red-950/60 text-red-300",
    neutral: "border-slate-700 bg-slate-900 text-slate-300",
  }[tone];
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${style}`}
    >
      {label}
    </span>
  );
}
