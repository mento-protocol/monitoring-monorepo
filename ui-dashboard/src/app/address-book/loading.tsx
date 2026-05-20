import { TableSkeleton } from "@/components/skeletons";

// cols=10 must stay in sync with the real address-book table:
// Chain, Address, Name, Tags, Notes, Source, Visibility, Created at,
// Updated at, Actions. Skeleton is structural-only: ARIA announcements live
// on TableSkeleton itself to avoid nested live regions.

export default function AddressBookLoading() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-800/50" />
      <TableSkeleton rows={10} cols={10} />
    </div>
  );
}
