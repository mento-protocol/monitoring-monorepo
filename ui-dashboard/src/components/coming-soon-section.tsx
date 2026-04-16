export function ComingSoonSection({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6 opacity-60">
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="rounded-full bg-slate-700 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
          Coming Soon
        </span>
      </div>
      <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
      <div className="mt-4 flex h-[120px] items-center justify-center rounded border border-dashed border-slate-700 text-sm text-slate-600">
        Chart will appear when data is available
      </div>
    </div>
  );
}
