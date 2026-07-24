import {
  commitPegDecisionPackages,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
} from "./decision-packages.js";
import { publishPegMetrics, type PegAssetMetricSnapshot } from "./metrics.js";

/**
 * Prepare the read model from complete per-policy candidates before mutating
 * metrics, then commit it only after the current metrics batch succeeds. The
 * metrics batch may be empty when a sibling policy failed while one complete
 * policy remains eligible for the decision package.
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
  publishPegMetrics(snapshots);
  if (prepared !== null) commitPegDecisionPackages(prepared);
}
