import {
  commitPegDecisionPackages,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
  type PreparedPegDecisionPackages,
} from "./decision-packages.js";
import {
  publishPegGauges,
  publishPegMetrics,
  type PegAssetMetricSnapshot,
} from "./metrics.js";

function prepareDecisionPackages(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext | null,
): PreparedPegDecisionPackages | null {
  return context === null
    ? null
    : preparePegDecisionPackages(snapshots, context);
}

function counterSnapshotsFor(
  snapshots: PegAssetMetricSnapshot[],
  decisionSnapshots: PegAssetMetricSnapshot[],
  prepared: PreparedPegDecisionPackages | null,
): PegAssetMetricSnapshot[] {
  if (snapshots.length > 0 || prepared === null) return snapshots;
  return decisionSnapshots.filter(
    ({ policyVersion }) =>
      policyVersion === prepared.model.producedPolicyVersion,
  );
}

/**
 * Prepare the read model before mutating metrics, then commit it only after the
 * current metric publication succeeds. A read-model preparation failure leaves
 * the last confirmed body intact, publishes any valid gauges without counter
 * deltas, and is returned for the poll cycle's existing error reporter.
 * A sibling-policy failure clears the current-state gauges while the selected
 * complete policy's monotonic counter deltas still publish exactly once.
 */
export function publishPegPollSnapshot(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext | null,
  decisionSnapshots: PegAssetMetricSnapshot[] = snapshots,
): Error | undefined {
  if (
    (snapshots.length > 0 || decisionSnapshots.length > 0) &&
    context === null
  ) {
    throw new Error("non-empty peg publication requires policy context");
  }
  let prepared: PreparedPegDecisionPackages | null;
  try {
    prepared = prepareDecisionPackages(decisionSnapshots, context);
  } catch (error) {
    publishPegGauges(snapshots);
    return error instanceof Error ? error : new Error(String(error));
  }
  const counterSnapshots = counterSnapshotsFor(
    snapshots,
    decisionSnapshots,
    prepared,
  );
  publishPegMetrics(snapshots, counterSnapshots);
  if (prepared !== null) commitPegDecisionPackages(prepared);
}
