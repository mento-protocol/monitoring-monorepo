import type { ChainFilterOption, ChainFilterValue } from "@/lib/chain-filter";

export function ChainFilterControl({
  value,
  options,
  onChange,
}: {
  value: ChainFilterValue;
  options: readonly ChainFilterOption[];
  onChange: (value: ChainFilterValue) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Chain"
      className="flex gap-0.5 rounded-md bg-slate-800/50 p-0.5"
    >
      <ChainButton
        active={value === null}
        label="All"
        onClick={() => onChange(null)}
      />
      {options.map((option) => (
        <ChainButton
          key={option.chainId}
          active={value === option.chainId}
          label={option.label}
          onClick={() => onChange(option.chainId)}
        />
      ))}
    </div>
  );
}

function ChainButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
        (active
          ? "bg-slate-700 text-white shadow-sm"
          : "text-slate-400 hover:text-slate-200")
      }
    >
      {label}
    </button>
  );
}
