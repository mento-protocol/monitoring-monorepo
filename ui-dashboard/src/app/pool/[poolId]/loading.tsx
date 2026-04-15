import { TableSkeleton } from "@/components/skeletons";

const TAB_COUNT = 7;

export default function PoolDetailLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <div className="space-y-2">
        <div className="h-6 w-64 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-96 animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="flex gap-1 border-b border-slate-800">
        {Array.from({ length: TAB_COUNT }, (_, i) => (
          <div
            key={i}
            className="h-9 w-24 animate-pulse rounded-t bg-slate-800/50"
          />
        ))}
      </div>
      <TableSkeleton rows={10} cols={6} />
      <span className="sr-only">Loading pool…</span>
    </div>
  );
}
