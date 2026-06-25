import { EmptyBox } from "@/components/feedback";

const STABILITY_POOL_EVENTS_UNAVAILABLE_MESSAGE =
  "Stability pool deposit and withdraw events are temporarily unavailable while the indexer schema catches up.";

export function CdpTransactionsEmptyState({
  stabilityPoolEventsUnavailable,
}: {
  stabilityPoolEventsUnavailable: boolean;
}) {
  return (
    <div className="space-y-2">
      <EmptyBox message="No CDP transactions indexed yet." />
      {stabilityPoolEventsUnavailable && (
        <StabilityPoolEventsUnavailableNotice className="px-1" />
      )}
    </div>
  );
}

export function StabilityPoolEventsUnavailableNotice({
  className = "px-1 pt-1",
}: {
  className?: string;
}) {
  return (
    <p className={`${className} text-xs text-amber-400`} role="status">
      {STABILITY_POOL_EVENTS_UNAVAILABLE_MESSAGE}
    </p>
  );
}
