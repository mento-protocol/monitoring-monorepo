export function LimitSelect({
  id,
  value,
  onChange,
  label = "Show:",
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  label?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <label htmlFor={id} className="text-sm text-slate-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {[10, 25, 50, 100].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}
