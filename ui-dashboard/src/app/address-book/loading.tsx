import { TableSkeleton } from "@/components/skeletons";

// cols=8 must stay in sync with the real address-book table
// (Address, Name, Tags, Chain, Notes, Source, Visibility, Actions — see
// AddressBookClient.tsx). Skeleton is structural-only: ARIA announcements
// live on TableSkeleton itself to avoid nested live regions.

export default function AddressBookLoading() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-800/50" />
      <TableSkeleton rows={10} cols={8} />
    </div>
  );
}
