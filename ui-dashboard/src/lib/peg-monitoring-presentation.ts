import type {
  PegAssetPackage,
  PegMonitoringResponse,
  PegSource,
} from "./peg-monitoring-schema";
import {
  assetName,
  classifySafety,
  effectiveThresholds,
  selectSources,
  sourceHasUnavailableEvidence,
  type PackageContext,
  type PegPresentationTone,
  type SourceSelection,
} from "./peg-monitoring-presentation-safety";

export type { PegPresentationTone } from "./peg-monitoring-presentation-safety";
type PegThresholdTone = PegPresentationTone | "uncertain";

export type PegAssetPresentation = {
  asset: PegAssetPackage;
  assetName: string;
  decisionSource: PegSource | null;
  deepSource: PegSource | null;
  structuralEvidenceCurrent: boolean;
  usableSourceCount: number;
  distanceBps: number | null;
  direction: "below" | "above" | "at target" | null;
  downsideWarningThresholdBps: number;
  downsideCriticalThresholdBps: number;
  premiumWarningThresholdBps: number;
  warningThresholdBps: number | null;
  warningDistanceBps: number | null;
  thresholdTone: PegThresholdTone;
  tone: PegPresentationTone;
  currentCritical: boolean;
  reasons: string[];
  uncertain: boolean;
  uncertaintyReason: string | null;
};

export type PegMonitoringPresentation = {
  assets: PegAssetPresentation[];
  aggregate: {
    tone: PegPresentationTone | "uncertain";
    label:
      | "All pegs healthy"
      | "Critical condition detected"
      | "Some pegs need attention"
      | "Latest data is stale"
      | "Policy update pending"
      | "Price check unavailable"
      | "Monitoring checks incomplete";
    detail: string | null;
  };
  furthest: PegAssetPresentation | null;
  closestWarning: PegAssetPresentation | null;
};

type DistanceGeometry = Pick<
  PegAssetPresentation,
  | "distanceBps"
  | "direction"
  | "downsideWarningThresholdBps"
  | "downsideCriticalThresholdBps"
  | "premiumWarningThresholdBps"
  | "warningThresholdBps"
  | "warningDistanceBps"
  | "thresholdTone"
>;

const severity = { healthy: 0, warning: 1, critical: 2 } as const;

function signedDistanceBps(
  source: PegSource | null,
  target: number,
): number | null {
  if (source?.executablePrice === null || source === null) return null;
  return (source.executablePrice / target - 1) * 10_000;
}

function directionFrom(
  signedDistance: number | null,
): PegAssetPresentation["direction"] {
  if (signedDistance === null) return null;
  if (signedDistance === 0) return "at target";
  return signedDistance < 0 ? "below" : "above";
}

function decisionDistanceBps(
  source: PegSource | null,
  direction: PegAssetPresentation["direction"],
): number | null {
  if (source === null || direction === null) return null;
  if (direction === "below") return source.deviationBps;
  if (direction === "above") return source.premiumBps;
  return 0;
}

function thresholdTone(input: {
  decisionSource: PegSource | null;
  direction: PegAssetPresentation["direction"];
  distanceBps: number | null;
  warningDistanceBps: number | null;
  criticalDeviationBps: number;
}): PegThresholdTone {
  if (input.decisionSource === null) return "uncertain";
  if (
    input.direction === "below" &&
    input.distanceBps !== null &&
    input.distanceBps >= input.criticalDeviationBps
  )
    return "critical";
  return input.warningDistanceBps !== null && input.warningDistanceBps <= 0
    ? "warning"
    : "healthy";
}

function describeDistance(
  item: PegAssetPackage,
  selection: SourceSelection,
): DistanceGeometry {
  const thresholds = effectiveThresholds(item, selection.deepSource);
  const signedDistance = signedDistanceBps(
    selection.decisionSource,
    item.policy.target,
  );
  const direction = directionFrom(signedDistance);
  const currentDistanceBps = decisionDistanceBps(
    selection.decisionSource,
    direction,
  );
  const warningThresholdBps =
    direction === null
      ? null
      : direction === "above"
        ? thresholds.premiumWarningThresholdBps
        : direction === "below"
          ? thresholds.downsideWarningThresholdBps
          : Math.min(
              thresholds.downsideWarningThresholdBps,
              thresholds.premiumWarningThresholdBps,
            );
  const warningDistanceBps =
    currentDistanceBps === null || warningThresholdBps === null
      ? null
      : warningThresholdBps - currentDistanceBps;
  return {
    ...thresholds,
    distanceBps: currentDistanceBps,
    direction,
    warningThresholdBps,
    warningDistanceBps,
    thresholdTone: thresholdTone({
      decisionSource: selection.decisionSource,
      direction,
      distanceBps: currentDistanceBps,
      warningDistanceBps,
      criticalDeviationBps: thresholds.downsideCriticalThresholdBps,
    }),
  };
}

function buildAssetPresentation(
  item: PegAssetPackage,
  context: PackageContext,
  producedAtMs: number,
): PegAssetPresentation {
  const selection = selectSources(item, context.nowMs);
  const structuralExpired =
    context.nowMs - producedAtMs > item.policy.freshnessGraceSeconds * 1_000;
  return {
    asset: item,
    assetName: assetName(
      item,
      selection.deepSource ?? selection.decisionSource,
    ),
    decisionSource: selection.decisionSource,
    deepSource: selection.deepSource,
    structuralEvidenceCurrent: !structuralExpired,
    usableSourceCount: item.sources.filter(
      (source) => !sourceHasUnavailableEvidence(source, context.nowMs),
    ).length,
    ...describeDistance(item, selection),
    ...classifySafety(item, selection, context, structuralExpired),
  };
}

function aggregatePresentation(
  assets: PegAssetPresentation[],
  context: PackageContext,
) {
  const confirmedCritical = assets.find(
    ({ currentCritical }) => currentCritical,
  );
  if (confirmedCritical)
    return {
      tone: "critical" as const,
      label: "Critical condition detected" as const,
      detail:
        confirmedCritical.reasons[0] ??
        `${confirmedCritical.assetName} crossed a critical threshold.`,
    };
  if (context.packageIsStale)
    return {
      tone: "uncertain" as const,
      label: "Latest data is stale" as const,
      detail:
        "No fresh monitoring package is available; values below are the last confirmed measurements.",
    };
  if (context.usesPreviousPolicy)
    return {
      tone: "uncertain" as const,
      label: "Policy update pending" as const,
      detail: "The latest complete package uses the previous approved policy.",
    };
  const uncertainAsset = assets.find(({ uncertain }) => uncertain);
  if (uncertainAsset)
    return {
      tone: "uncertain" as const,
      label:
        uncertainAsset.decisionSource === null
          ? ("Price check unavailable" as const)
          : ("Monitoring checks incomplete" as const),
      detail: `${uncertainAsset.assetName}: ${uncertainAsset.uncertaintyReason ?? "One or more monitoring checks are unavailable."}`,
    };
  const warningAsset = assets.find(({ tone }) => tone === "warning");
  if (warningAsset)
    return {
      tone: "warning" as const,
      label: "Some pegs need attention" as const,
      detail:
        warningAsset.reasons[0] ??
        `${warningAsset.assetName} crossed a warning threshold.`,
    };
  return {
    tone: "healthy" as const,
    label: "All pegs healthy" as const,
    detail: null,
  };
}

function sortBySeverityAndDistance(
  assets: PegAssetPresentation[],
): PegAssetPresentation[] {
  return [...assets].sort(
    (left, right) =>
      severity[right.tone] - severity[left.tone] ||
      (right.distanceBps ?? -1) - (left.distanceBps ?? -1),
  );
}

function selectFurthest(
  assets: PegAssetPresentation[],
): PegAssetPresentation | null {
  return assets.reduce<PegAssetPresentation | null>(
    (furthest, asset) =>
      asset.distanceBps !== null &&
      (furthest === null ||
        asset.distanceBps > (furthest.distanceBps ?? Number.NEGATIVE_INFINITY))
        ? asset
        : furthest,
    null,
  );
}

function selectClosestWarning(
  assets: PegAssetPresentation[],
): PegAssetPresentation | null {
  return assets.reduce<PegAssetPresentation | null>((closest, asset) => {
    if (asset.warningDistanceBps === null) return closest;
    if (
      closest === null ||
      closest.warningDistanceBps === null ||
      Math.abs(asset.warningDistanceBps) < Math.abs(closest.warningDistanceBps)
    )
      return asset;
    return closest;
  }, null);
}

export function presentPegMonitoring(
  data: PegMonitoringResponse,
  context: PackageContext,
): PegMonitoringPresentation {
  const assets = sortBySeverityAndDistance(
    data.packages.map((item) =>
      buildAssetPresentation(item, context, data.producedAt * 1_000),
    ),
  );
  return {
    assets,
    aggregate: aggregatePresentation(assets, context),
    furthest: selectFurthest(assets),
    closestWarning: selectClosestWarning(assets),
  };
}
