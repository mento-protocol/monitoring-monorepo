import type {
  PegAssetPackage,
  PegMonitoringResponse,
  PegSource,
} from "./peg-monitoring-schema";

export type PegPresentationTone = "healthy" | "warning" | "critical";
type PegThresholdTone = PegPresentationTone | "uncertain";

export type PegAssetPresentation = {
  asset: PegAssetPackage;
  assetName: string;
  decisionSource: PegSource | null;
  deepSource: PegSource | null;
  distanceBps: number | null;
  direction: "below" | "above" | "at target" | null;
  warningThresholdBps: number | null;
  warningDistanceBps: number | null;
  thresholdTone: PegThresholdTone;
  tone: PegPresentationTone;
  reasons: string[];
  uncertain: boolean;
};

export type PegMonitoringPresentation = {
  assets: PegAssetPresentation[];
  aggregate: {
    tone: PegPresentationTone | "uncertain";
    label:
      | "All pegs healthy"
      | "Peg action required"
      | "Some pegs need attention"
      | "Current status uncertain";
  };
  furthest: PegAssetPresentation | null;
  closestWarning: PegAssetPresentation | null;
};

type PackageContext = {
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
};

type SourceSelection = {
  deepSource: PegSource | null;
  decisionSource: PegSource | null;
};

type SafetySignals = {
  tone: PegPresentationTone;
  reasons: string[];
  uncertain: boolean;
};

type DistanceGeometry = Pick<
  PegAssetPresentation,
  | "distanceBps"
  | "direction"
  | "warningThresholdBps"
  | "warningDistanceBps"
  | "thresholdTone"
>;

const severity = { healthy: 0, warning: 1, critical: 2 } as const;

function assetName(item: PegAssetPackage, source: PegSource | null): string {
  return (
    source?.baseCurrency ??
    item.asset.split("-")[0]?.toUpperCase() ??
    item.asset
  );
}

function sourceHasUnavailableEvidence(source: PegSource | null): boolean {
  return (
    source === null ||
    !source.healthy ||
    source.executablePrice === null ||
    source.listingState === "halted" ||
    source.listingState === "absent" ||
    source.venueState === "halted"
  );
}

function selectSources(item: PegAssetPackage): SourceSelection {
  const deepSource =
    item.sources.find((source) => source.id === item.policy.deepVenueSource) ??
    null;
  return {
    deepSource,
    decisionSource: sourceHasUnavailableEvidence(deepSource)
      ? null
      : deepSource,
  };
}

function isStructuralWarning(item: PegAssetPackage): boolean {
  const structural = item.structural;
  const packageWarning =
    structural.blind ||
    !structural.indexedPoolReachable ||
    structural.structuralQuerySaturated ||
    (structural.structuralSaturation !== null &&
      structural.structuralSaturation >= item.policy.structuralWarnFraction);
  return (
    packageWarning ||
    item.monitors.some(
      (monitor) =>
        !monitor.indexedPoolReachable ||
        monitor.structuralQuerySaturated ||
        (monitor.structuralSaturation !== null &&
          monitor.structuralSaturation >= item.policy.structuralWarnFraction),
    )
  );
}

function isSourceWarning(
  item: PegAssetPackage,
  source: PegSource | null,
): boolean {
  if (source === null || sourceHasUnavailableEvidence(source)) return true;
  return (
    (source.deviationBps !== null &&
      source.deviationBps >= item.policy.warnDeviationBps) ||
    (source.premiumBps !== null &&
      source.premiumBps >= item.policy.premiumWarnBps) ||
    (source.spreadBps !== null &&
      source.spreadBps >= source.policy.spreadEnvelopeBps)
  );
}

function isDeepCritical(
  item: PegAssetPackage,
  source: PegSource | null,
): boolean {
  return (
    source?.deviationBps !== null &&
    source !== null &&
    source.deviationBps >= item.policy.criticalDeviationBps
  );
}

function hasUnsafeBreaker(item: PegAssetPackage): boolean {
  return item.monitors.some(
    ({ breaker }) =>
      breaker !== null && (!breaker.enabled || breaker.status === "TRIPPED"),
  );
}

function hasUnavailableBreaker(item: PegAssetPackage): boolean {
  return item.monitors.some(({ breaker }) => breaker === null);
}

function safetyReasons(input: {
  structuralWarning: boolean;
  sourceUnavailable: boolean;
  sourceWarning: boolean;
  breakerUnavailable: boolean;
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
  deepCritical: boolean;
  unsafeBreaker: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.deepCritical)
    reasons.push("Deep-source downside has reached the critical threshold.");
  if (input.unsafeBreaker)
    reasons.push("A monitored breaker is disabled or tripped.");
  if (input.structuralWarning)
    reasons.push(
      "Current structural or pool evidence is unavailable or crossed its warning threshold.",
    );
  if (input.sourceUnavailable)
    reasons.push("The deep market source is unavailable or unhealthy.");
  else if (input.sourceWarning)
    reasons.push("The deep market measurement crossed a warning threshold.");
  if (input.breakerUnavailable)
    reasons.push("A monitored breaker is unavailable.");
  if (input.packageIsStale)
    reasons.push("The package is stale; this is the last confirmed evidence.");
  if (input.usesPreviousPolicy)
    reasons.push("The package uses the previous approved policy.");
  return reasons;
}

function classifySafety(
  item: PegAssetPackage,
  deepSource: PegSource | null,
  context: PackageContext,
): SafetySignals {
  const structuralWarning = isStructuralWarning(item);
  const sourceUnavailable = sourceHasUnavailableEvidence(deepSource);
  const sourceWarning = isSourceWarning(item, deepSource);
  const breakerUnavailable = hasUnavailableBreaker(item);
  const deepCritical = isDeepCritical(item, deepSource);
  const unsafeBreaker = hasUnsafeBreaker(item);
  const policyWarning = context.packageIsStale || context.usesPreviousPolicy;
  const critical = deepCritical || unsafeBreaker;
  return {
    tone: critical
      ? "critical"
      : structuralWarning ||
          sourceWarning ||
          breakerUnavailable ||
          policyWarning
        ? "warning"
        : "healthy",
    uncertain:
      structuralWarning ||
      sourceUnavailable ||
      breakerUnavailable ||
      policyWarning,
    reasons: safetyReasons({
      structuralWarning,
      sourceUnavailable,
      sourceWarning,
      breakerUnavailable,
      packageIsStale: context.packageIsStale,
      usesPreviousPolicy: context.usesPreviousPolicy,
      deepCritical,
      unsafeBreaker,
    }),
  };
}

function distanceBps(source: PegSource | null, target: number): number | null {
  if (source?.executablePrice === null || source === null) return null;
  return Math.abs((source.executablePrice / target - 1) * 10_000);
}

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

function thresholdTone(input: {
  deepSource: PegSource | null;
  context: PackageContext;
  direction: PegAssetPresentation["direction"];
  distanceBps: number | null;
  warningDistanceBps: number | null;
  criticalDeviationBps: number;
}): PegThresholdTone {
  if (
    sourceHasUnavailableEvidence(input.deepSource) ||
    input.context.packageIsStale ||
    input.context.usesPreviousPolicy
  )
    return "uncertain";
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
  context: PackageContext,
): DistanceGeometry {
  const signedDistance = signedDistanceBps(
    selection.decisionSource,
    item.policy.target,
  );
  const direction = directionFrom(signedDistance);
  const currentDistanceBps = distanceBps(
    selection.decisionSource,
    item.policy.target,
  );
  const warningThresholdBps =
    direction === null
      ? null
      : direction === "above"
        ? item.policy.premiumWarnBps
        : item.policy.warnDeviationBps;
  const warningDistanceBps =
    currentDistanceBps === null || warningThresholdBps === null
      ? null
      : warningThresholdBps - currentDistanceBps;
  return {
    distanceBps: currentDistanceBps,
    direction,
    warningThresholdBps,
    warningDistanceBps,
    thresholdTone: thresholdTone({
      deepSource: selection.deepSource,
      context,
      direction,
      distanceBps: currentDistanceBps,
      warningDistanceBps,
      criticalDeviationBps: item.policy.criticalDeviationBps,
    }),
  };
}

function buildAssetPresentation(
  item: PegAssetPackage,
  context: PackageContext,
): PegAssetPresentation {
  const selection = selectSources(item);
  return {
    asset: item,
    assetName: assetName(
      item,
      selection.deepSource ?? selection.decisionSource,
    ),
    decisionSource: selection.decisionSource,
    deepSource: selection.deepSource,
    ...describeDistance(item, selection, context),
    ...classifySafety(item, selection.deepSource, context),
  };
}

function aggregatePresentation(assets: PegAssetPresentation[]) {
  const confirmedCritical = assets.some(
    ({ tone, uncertain }) => tone === "critical" && !uncertain,
  );
  if (confirmedCritical)
    return { tone: "critical" as const, label: "Peg action required" as const };
  if (assets.some(({ uncertain }) => uncertain))
    return {
      tone: "uncertain" as const,
      label: "Current status uncertain" as const,
    };
  if (assets.some(({ tone }) => tone === "warning"))
    return {
      tone: "warning" as const,
      label: "Some pegs need attention" as const,
    };
  return { tone: "healthy" as const, label: "All pegs healthy" as const };
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
  return assets.reduce<PegAssetPresentation | null>(
    (closest, asset) =>
      asset.distanceBps !== null &&
      (closest === null ||
        (asset.warningDistanceBps ?? Number.POSITIVE_INFINITY) <
          (closest.warningDistanceBps ?? Number.POSITIVE_INFINITY))
        ? asset
        : closest,
    null,
  );
}

export function presentPegMonitoring(
  data: PegMonitoringResponse,
  context: PackageContext,
): PegMonitoringPresentation {
  const assets = sortBySeverityAndDistance(
    data.packages.map((item) => buildAssetPresentation(item, context)),
  );
  return {
    assets,
    aggregate: aggregatePresentation(assets),
    furthest: selectFurthest(assets),
    closestWarning: selectClosestWarning(assets),
  };
}
