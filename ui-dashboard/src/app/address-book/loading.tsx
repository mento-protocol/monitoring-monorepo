import { TableSkeleton } from "@/components/skeletons";

export default function AddressBookLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-800/50" />
      <TableSkeleton rows={10} cols={4} />
      <span className="sr-only">Loading address book…</span>
    </div>
  );
}
