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
