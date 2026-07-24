import {
  commitPegDecisionPackages,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
} from "./decision-packages.js";
import { publishPegMetrics, type PegAssetMetricSnapshot } from "./metrics.js";

/**
 * Prepare the read model from complete per-policy candidates before mutating
 * metrics, then commit it only after the current metric publication succeeds.
 * A sibling-policy failure clears the current-state gauges while the selected
 * complete policy's monotonic counter deltas still publish exactly once.
 */
export function publishPegPollSnapshot(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext | null,
  decisionSnapshots: PegAssetMetricSnapshot[] = snapshots,
): void {
  if (
    (snapshots.length > 0 || decisionSnapshots.length > 0) &&
    context === null
  ) {
    throw new Error("non-empty peg publication requires policy context");
  }
  const prepared =
    context === null
      ? null
      : preparePegDecisionPackages(decisionSnapshots, context);
  const counterSnapshots =
    snapshots.length > 0 || prepared === null
      ? snapshots
      : decisionSnapshots.filter(
          ({ policyVersion }) =>
            policyVersion === prepared.model.producedPolicyVersion,
        );
  publishPegMetrics(snapshots, counterSnapshots);
  if (prepared !== null) commitPegDecisionPackages(prepared);
}
