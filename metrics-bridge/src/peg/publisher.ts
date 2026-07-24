import {
  commitPegDecisionPackages,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
} from "./decision-packages.js";
import { publishPegMetrics, type PegAssetMetricSnapshot } from "./metrics.js";

/**
 * Prepare the read model before mutating metrics, then commit it only after the
 * current metrics batch succeeds. A failed cycle gets no context and therefore
 * cannot replace the last confirmed package.
 */
export function publishPegPollSnapshot(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext | null,
): void {
  if (snapshots.length > 0 && context === null) {
    throw new Error("non-empty peg publication requires policy context");
  }
  const prepared =
    context === null ? null : preparePegDecisionPackages(snapshots, context);
  publishPegMetrics(snapshots);
  if (prepared !== null) commitPegDecisionPackages(prepared);
}
