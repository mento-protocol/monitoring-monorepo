import { TableSkeleton } from "@/components/skeletons";

// Matches the real pool detail layout: breadcrumb + header + 7 tabs (see
// TABS in page.tsx) + a 6-column default table. ARIA announcement lives on
// TableSkeleton itself so we don't nest live regions.

export default function PoolDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-6 w-64 animate-pulse rounded bg-slate-800/50" />
        <div className="h-4 w-96 animate-pulse rounded bg-slate-800/50" />
      </div>
      <div className="flex gap-1 border-b border-slate-800">
        {Array.from({ length: 7 }, (_, i) => (
          <div
            key={i}
            className="h-9 w-24 animate-pulse rounded-t bg-slate-800/50"
          />
        ))}
      </div>
      <TableSkeleton rows={10} cols={6} />
    </div>
  );
}
