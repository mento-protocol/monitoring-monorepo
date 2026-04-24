import type { ReactNode } from "react";

export function Stat({
  label,
  value,
  title,
  mono,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  title?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-slate-400">{label}</dt>
      <dd className={`text-white ${mono ? "font-mono" : ""}`} title={title}>
        {value}
      </dd>
    </div>
  );
}
