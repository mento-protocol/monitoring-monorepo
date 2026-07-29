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

type PackageContext = {
  nowMs: number;
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
};

type SourceSelection = {
  deepSource: PegSource | null;
  decisionSource: PegSource | null;
  sourceExpired: boolean;
};

type SafetySignals = {
  tone: PegPresentationTone;
  currentCritical: boolean;
  reasons: string[];
  uncertain: boolean;
  uncertaintyReason: string | null;
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

type EffectiveThresholds = Pick<
  PegAssetPresentation,
  | "downsideWarningThresholdBps"
  | "downsideCriticalThresholdBps"
  | "premiumWarningThresholdBps"
>;

const severity = { healthy: 0, warning: 1, critical: 2 } as const;

function assetName(item: PegAssetPackage, source: PegSource | null): string {
  return (
    source?.baseCurrency ??
    item.asset.split("-")[0]?.toUpperCase() ??
    item.asset
  );
}

function sourceEvidenceExpired(source: PegSource | null, nowMs: number) {
  if (source === null || source.observationAt === null) return false;
  return (
    nowMs - source.observationAt * 1_000 >
    source.policy.staleAfterSeconds * 1_000
  );
}

function sourceHasUnavailableEvidence(
  source: PegSource | null,
  nowMs: number,
): boolean {
  return (
    source === null ||
    !source.healthy ||
    source.observationAt === null ||
    sourceEvidenceExpired(source, nowMs) ||
    source.executablePrice === null ||
    source.deviationBps === null ||
    source.premiumBps === null ||
    source.capped === true ||
    source.listingState === "halted" ||
    source.listingState === "absent" ||
    source.venueState === "halted"
  );
}

function selectSources(item: PegAssetPackage, nowMs: number): SourceSelection {
  const deepSource =
    item.sources.find((source) => source.id === item.policy.deepVenueSource) ??
    null;
  const sourceExpired = sourceEvidenceExpired(deepSource, nowMs);
  return {
    deepSource,
    decisionSource: sourceHasUnavailableEvidence(deepSource, nowMs)
      ? null
      : deepSource,
    sourceExpired,
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

function hasUnavailableStructuralEvidence(item: PegAssetPackage): boolean {
  const structural = item.structural;
  return (
    structural.blind ||
    !structural.indexedPoolReachable ||
    structural.structuralQuerySaturated ||
    item.monitors.some(
      (monitor) =>
        !monitor.indexedPoolReachable || monitor.structuralQuerySaturated,
    )
  );
}

function effectiveThresholds(
  item: PegAssetPackage,
  source: PegSource | null,
): EffectiveThresholds {
  const conversionAllowance = source?.policy.conversionErrorBps ?? 0;
  return {
    downsideWarningThresholdBps:
      item.policy.warnDeviationBps + conversionAllowance,
    downsideCriticalThresholdBps:
      item.policy.criticalDeviationBps + conversionAllowance,
    premiumWarningThresholdBps:
      item.policy.premiumWarnBps + conversionAllowance,
  };
}

function isSourceWarning(
  item: PegAssetPackage,
  source: PegSource | null,
): boolean {
  if (source === null) return true;
  const thresholds = effectiveThresholds(item, source);
  return (
    (source.deviationBps !== null &&
      source.deviationBps >= thresholds.downsideWarningThresholdBps) ||
    (source.premiumBps !== null &&
      source.premiumBps >= thresholds.premiumWarningThresholdBps) ||
    (source.spreadBps !== null &&
      source.spreadBps > source.policy.spreadEnvelopeBps)
  );
}

function isDeepCritical(
  item: PegAssetPackage,
  source: PegSource | null,
): boolean {
  const thresholds = effectiveThresholds(item, source);
  return (
    source?.deviationBps !== null &&
    source !== null &&
    source.deviationBps >= thresholds.downsideCriticalThresholdBps
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

function uncertaintyReason(input: {
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
  sourceUnavailable: boolean;
  sourceExpired: boolean;
  structuralExpired: boolean;
  structuralUnavailable: boolean;
  breakerUnavailable: boolean;
}): string | null {
  if (input.packageIsStale) return "No fresh monitoring package is available.";
  if (input.usesPreviousPolicy)
    return "The latest complete package uses the previous approved policy.";
  if (input.sourceExpired)
    return "The policy-selected market observation is older than its allowed freshness window.";
  if (input.sourceUnavailable)
    return "The policy-selected market has no usable full-size price.";
  if (input.structuralExpired)
    return "The structural checks are older than the policy's freshness window.";
  if (input.structuralUnavailable)
    return "Structural or pool evidence is unavailable or incomplete.";
  if (input.breakerUnavailable)
    return "A monitored breaker check is unavailable.";
  return null;
}

function safetyReasons(input: {
  structuralWarning: boolean;
  structuralExpired: boolean;
  structuralUnavailable: boolean;
  sourceUnavailable: boolean;
  sourceExpired: boolean;
  sourceWarning: boolean;
  breakerUnavailable: boolean;
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
  deepCritical: boolean;
  unsafeBreaker: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.deepCritical)
    reasons.push(
      "The latest deep-market price crossed the critical threshold. The alert only fires if enough readings stay there long enough.",
    );
  if (input.unsafeBreaker)
    reasons.push("A monitored breaker is disabled or tripped.");
  if (input.structuralExpired)
    reasons.push(
      "The structural checks are older than the policy's freshness window.",
    );
  else if (input.structuralUnavailable)
    reasons.push(
      "Current structural or pool evidence is unavailable or incomplete.",
    );
  else if (input.structuralWarning)
    reasons.push("Structural saturation crossed its warning threshold.");
  if (input.sourceUnavailable)
    reasons.push(
      input.sourceExpired
        ? "The deep market observation is older than its allowed freshness window."
        : "The deep market source is unavailable or unhealthy.",
    );
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
  selection: SourceSelection,
  context: PackageContext,
  structuralExpired: boolean,
): SafetySignals {
  const structuralWarning = !structuralExpired && isStructuralWarning(item);
  const structuralUnavailable =
    structuralExpired || hasUnavailableStructuralEvidence(item);
  const sourceUnavailable = selection.decisionSource === null;
  const sourceWarning = isSourceWarning(item, selection.decisionSource);
  const breakerUnavailable = hasUnavailableBreaker(item);
  const deepCritical = isDeepCritical(item, selection.decisionSource);
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
    currentCritical: critical && !policyWarning,
    uncertain:
      structuralUnavailable ||
      sourceUnavailable ||
      breakerUnavailable ||
      policyWarning,
    uncertaintyReason: uncertaintyReason({
      packageIsStale: context.packageIsStale,
      usesPreviousPolicy: context.usesPreviousPolicy,
      sourceUnavailable,
      sourceExpired: selection.sourceExpired,
      structuralExpired,
      structuralUnavailable,
      breakerUnavailable,
    }),
    reasons: safetyReasons({
      structuralWarning,
      structuralExpired,
      structuralUnavailable,
      sourceUnavailable,
      sourceExpired: selection.sourceExpired,
      sourceWarning,
      breakerUnavailable,
      packageIsStale: context.packageIsStale,
      usesPreviousPolicy: context.usesPreviousPolicy,
      deepCritical,
      unsafeBreaker,
    }),
  };
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
        : thresholds.downsideWarningThresholdBps;
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
