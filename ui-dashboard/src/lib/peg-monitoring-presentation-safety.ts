import type { PegAssetPackage, PegSource } from "./peg-monitoring-schema";

export type PegPresentationTone = "healthy" | "warning" | "critical";

export type PackageContext = {
  nowMs: number;
  packageIsStale: boolean;
  usesPreviousPolicy: boolean;
};

export type SourceSelection = {
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

type EffectiveThresholds = {
  downsideWarningThresholdBps: number;
  downsideCriticalThresholdBps: number;
  premiumWarningThresholdBps: number;
};

export function assetName(
  item: PegAssetPackage,
  source: PegSource | null,
): string {
  return (
    source?.baseCurrency ??
    item.asset.split("-")[0]?.toUpperCase() ??
    item.asset
  );
}

function sourceEvidenceExpired(
  source: PegSource | null,
  nowMs: number,
): boolean {
  if (source === null || source.observationAt === null) return false;
  return (
    nowMs - source.observationAt * 1_000 >
    source.policy.staleAfterSeconds * 1_000
  );
}

export function sourceHasUnavailableEvidence(
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

export function selectSources(
  item: PegAssetPackage,
  nowMs: number,
): SourceSelection {
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

export function effectiveThresholds(
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

function blindWhileStressedReason(
  item: PegAssetPackage,
  source: PegSource | null,
  nowMs: number,
  structuralExpired: boolean,
): string | null {
  // The paging rule deliberately uses the confirmed streak. The producer
  // resets it on the same poll that restores a usable full-size price.
  if (
    structuralExpired ||
    item.structural.blindConsecutivePolls < item.policy.blindConsecutivePolls
  )
    return null;

  const structuralStress =
    item.structural.structuralSaturation !== null &&
    item.structural.structuralSaturation >=
      item.policy.structuralWarnFraction &&
    item.structural.indexedPoolReachable;
  const blindReason = `The deep market could not price the full test amount for ${item.policy.blindConsecutivePolls} consecutive checks`;
  if (structuralStress)
    return `${blindReason}, while on-chain pool activity crossed its warning limit.`;

  const sourceIsCurrent =
    source !== null &&
    source.observationAt !== null &&
    !sourceEvidenceExpired(source, nowMs);
  const spreadStress =
    sourceIsCurrent &&
    source.spreadBps !== null &&
    source.spreadBps > source.policy.spreadEnvelopeBps;
  if (spreadStress)
    return `${blindReason}, while its buy and sell prices moved too far apart.`;

  const cappedCriticalShortfall =
    sourceIsCurrent &&
    source.capped === true &&
    source.executablePrice !== null &&
    ((item.policy.target - source.executablePrice) / item.policy.target) *
      10_000 >=
      item.policy.criticalDeviationBps + source.policy.conversionErrorBps;
  return cappedCriticalShortfall
    ? `${blindReason}, while its available partial price crossed the critical downside limit.`
    : null;
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

function currentBreakerSignals(
  item: PegAssetPackage,
  structuralExpired: boolean,
) {
  if (structuralExpired)
    return { breakerUnavailable: false, unsafeBreaker: false };
  return {
    breakerUnavailable: hasUnavailableBreaker(item),
    unsafeBreaker: hasUnsafeBreaker(item),
  };
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
  blindWhileStressedReason: string | null;
  unsafeBreaker: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.blindWhileStressedReason)
    reasons.push(input.blindWhileStressedReason);
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

export function classifySafety(
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
  const { breakerUnavailable, unsafeBreaker } = currentBreakerSignals(
    item,
    structuralExpired,
  );
  const deepCritical = isDeepCritical(item, selection.decisionSource);
  const confirmedBlindWhileStressedReason = blindWhileStressedReason(
    item,
    selection.deepSource,
    context.nowMs,
    structuralExpired,
  );
  const policyWarning = context.packageIsStale || context.usesPreviousPolicy;
  const critical =
    deepCritical || confirmedBlindWhileStressedReason !== null || unsafeBreaker;
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
      blindWhileStressedReason: confirmedBlindWhileStressedReason,
      unsafeBreaker,
    }),
  };
}
