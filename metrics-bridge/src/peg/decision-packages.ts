import { Buffer } from "node:buffer";
import type {
  PegAssetMetricSnapshot,
  PegBreakerMetricSnapshot,
  PegMonitorMetricSnapshot,
  PegSourceMetricSnapshot,
} from "./metrics.js";
import {
  PEG_POLICY_MAX_ASSETS,
  type PegAssetPolicy,
  type PegPolicyVersion,
  type PegSourcePolicy,
} from "./policy.js";
import {
  PEG_REGISTRY_MAX_MONITORS_PER_ASSET,
  type PegConversion,
  type PegCoverageClass,
  type PegMonitor,
  type PegRegistry,
  type PegSource,
  type PegSourceRole,
  type PegTokenRef,
} from "./registry.js";
import type { VenueState } from "./types.js";

export const PEG_DECISION_PACKAGE_SCHEMA_VERSION = 1;
export const PEG_DECISION_PACKAGE_MAX_BYTES = 512 * 1_024;

export type PegPolicySlot = "active" | "previous";

export interface PegDecisionPackagePolicy {
  target: number;
  warnDeviationBps: number;
  criticalDeviationBps: number;
  premiumWarnBps: number;
  warnSustainSeconds: number;
  criticalSustainSeconds: number;
  durationQuantile: number;
  minimumCoverageFraction: number;
  /** Current observed counter is exposed separately in structural evidence. */
  blindConsecutivePolls: number;
  permanentlyDeadSeconds: number;
  structuralWarnFraction: number;
  freshnessGraceSeconds: number;
  deepVenueSource: string;
}

export interface PegDecisionPackageBreaker extends PegBreakerMetricSnapshot {
  thresholdScale: "fixidity-1e24";
}

export interface PegDecisionPackageMonitor {
  chainId: number;
  poolAddress: string;
  rateFeedId: string;
  monitoredTokenAddress: string;
  indexedPoolReachable: boolean;
  structuralSaturation: number | null;
  structuralQuerySaturated: boolean;
  counterpartyCount: number;
  breaker: PegDecisionPackageBreaker | null;
}

export interface PegDecisionPackageSource {
  id: string;
  provider: string;
  pair: string;
  baseCurrency: string;
  quoteCurrency: string;
  registryRole: PegSourceRole;
  authority: PegSourcePolicy["authority"];
  convertVia: PegConversion | null;
  policy: Omit<PegSourcePolicy, "authority">;
  /** Reserved for the later typed listing-cache packet; currently always null. */
  listingState: null;
  /** Reserved for the later typed listing-cache packet; currently always null. */
  listingCheckedAt: null;
  healthy: boolean;
  venueState: VenueState | null;
  observationAt: number | null;
  fetchedAt: number | null;
  lastTradeAt: number | null;
  executablePrice: number | null;
  filledFraction: number | null;
  capped: boolean | null;
  referenceSize: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  deviationBps: number | null;
  premiumBps: number | null;
}

export interface PegAssetDecisionPackage {
  asset: string;
  peg: string;
  coverageClass: PegCoverageClass;
  tokenRefs: PegTokenRef[];
  policy: PegDecisionPackagePolicy;
  structural: {
    blind: boolean;
    blindConsecutivePolls: number;
    structuralSaturation: number | null;
    structuralQuerySaturated: boolean;
    indexedPoolReachable: boolean;
    counterpartyCount: number;
  };
  monitors: PegDecisionPackageMonitor[];
  sources: PegDecisionPackageSource[];
}

export interface PegDecisionPackages {
  schemaVersion: typeof PEG_DECISION_PACKAGE_SCHEMA_VERSION;
  approvedActivePolicyVersion: string;
  producedPolicyVersion: string;
  policySlot: PegPolicySlot;
  producedAt: number;
  rolloverAckExpectedSeconds: number;
  packages: PegAssetDecisionPackage[];
}

export interface PegDecisionPackagePublicationContext {
  registry: PegRegistry;
  policies: readonly PegPolicyVersion[];
  approvedActivePolicyVersion: string;
  retainedPreviousPolicyVersion: string | null;
}

export interface PreparedPegDecisionPackages {
  model: PegDecisionPackages;
  json: string;
}

let currentDecisionPackagesJson: string | null = null;

const sortedEntries = <Value>(record: Record<string, Value>) =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

function millisecondsToSeconds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "decision-package timestamp must be finite and non-negative",
    );
  }
  return Math.floor(value / 1_000);
}

function validateSelection(
  context: PegDecisionPackagePublicationContext,
): void {
  const versions = context.policies.map(({ version }) => version);
  if (
    versions.length === 0 ||
    versions.length > 2 ||
    new Set(versions).size !== versions.length
  ) {
    throw new Error(
      "decision-package publication requires one or two distinct policies",
    );
  }
  const activePresent = versions.includes(context.approvedActivePolicyVersion);
  const matches = activePresent
    ? versions.length === 1
      ? context.retainedPreviousPolicyVersion === null
      : versions.some(
          (version) => version === context.retainedPreviousPolicyVersion,
        )
    : versions.length === 1 &&
      versions[0] === context.retainedPreviousPolicyVersion;
  if (!matches) {
    throw new Error(
      "selected policies do not match the approved active/retained-previous slots",
    );
  }
}

function snapshotsFor(
  policy: PegPolicyVersion,
  snapshots: PegAssetMetricSnapshot[],
): PegAssetMetricSnapshot[] | null {
  const selected = snapshots.filter(
    ({ policyVersion }) => policyVersion === policy.version,
  );
  const expectedAssets = Object.keys(policy.assets);
  if (
    expectedAssets.length === 0 ||
    expectedAssets.length > PEG_POLICY_MAX_ASSETS ||
    selected.length !== expectedAssets.length
  )
    return null;
  const assets = new Set(selected.map(({ asset }) => asset));
  return assets.size === selected.length &&
    expectedAssets.every((asset) => assets.has(asset))
    ? selected
    : null;
}

function selectProducedVersion(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext,
): { policy: PegPolicyVersion; snapshots: PegAssetMetricSnapshot[] } {
  validateSelection(context);
  if (snapshots.length > PEG_POLICY_MAX_ASSETS * context.policies.length) {
    throw new Error("decision-package snapshots exceed the policy asset bound");
  }
  if (
    snapshots.some(
      (snapshot) =>
        !context.policies.some(
          (policy) => policy.version === snapshot.policyVersion,
        ),
    )
  ) {
    throw new Error(
      "decision-package snapshot has an unselected policy version",
    );
  }
  const ordered = [
    ...context.policies.filter(
      ({ version }) => version === context.approvedActivePolicyVersion,
    ),
    ...context.policies.filter(
      ({ version }) => version !== context.approvedActivePolicyVersion,
    ),
  ];
  for (const policy of ordered) {
    const selected = snapshotsFor(policy, snapshots);
    if (selected !== null) return { policy, snapshots: selected };
  }
  throw new Error(
    "no selected policy has a complete decision-package asset set",
  );
}

function policyEvidence(policy: PegAssetPolicy): PegDecisionPackagePolicy {
  return {
    target: policy.target,
    warnDeviationBps: policy.warnDeviationBps,
    criticalDeviationBps: policy.criticalDeviationBps,
    premiumWarnBps: policy.premiumWarnBps,
    warnSustainSeconds: policy.warnSustainSeconds,
    criticalSustainSeconds: policy.criticalSustainSeconds,
    durationQuantile: policy.durationQuantile,
    minimumCoverageFraction: policy.minimumCoverageFraction,
    blindConsecutivePolls: policy.blindConsecutivePolls,
    permanentlyDeadSeconds: policy.permanentlyDeadSeconds,
    structuralWarnFraction: policy.structuralWarnFraction,
    freshnessGraceSeconds: policy.freshnessGraceSeconds,
    deepVenueSource: policy.deepVenueSource,
  };
}

function sameMonitor(
  left: PegMonitorMetricSnapshot,
  right: PegMonitor,
): boolean {
  return (
    left.chainId === right.chainId &&
    left.poolAddress.toLowerCase() === right.poolAddress.toLowerCase() &&
    left.rateFeedId.toLowerCase() === right.rateFeedId.toLowerCase() &&
    left.monitoredTokenAddress.toLowerCase() ===
      right.monitoredTokenAddress.toLowerCase()
  );
}

// The registry remains topology authority; a missing measurement is explicit.
// eslint-disable-next-line complexity
function monitorEvidence(
  monitor: PegMonitor,
  metric: PegMonitorMetricSnapshot | undefined,
): PegDecisionPackageMonitor {
  return {
    chainId: monitor.chainId,
    poolAddress: monitor.poolAddress,
    rateFeedId: monitor.rateFeedId,
    monitoredTokenAddress: monitor.monitoredTokenAddress,
    indexedPoolReachable: metric?.indexedPoolReachable ?? false,
    structuralSaturation: metric?.structuralSaturation ?? null,
    structuralQuerySaturated: metric?.structuralQuerySaturated ?? false,
    counterpartyCount: metric?.counterpartyCount ?? 0,
    breaker:
      metric?.breaker === null || metric?.breaker === undefined
        ? null
        : { ...metric.breaker, thresholdScale: "fixidity-1e24" },
  };
}

// This DTO is deliberately null-heavy: missing poll output is evidence, not a
// reason to erase the configured source from the decision package.
// eslint-disable-next-line complexity
function sourceEvidence(
  source: PegSource,
  policy: PegSourcePolicy,
  metric: PegSourceMetricSnapshot | undefined,
): PegDecisionPackageSource {
  const observation = metric?.observation ?? null;
  return {
    id: source.id,
    provider: source.provider,
    pair: source.pair,
    baseCurrency: source.baseCurrency,
    quoteCurrency: source.quoteCurrency,
    registryRole: source.role,
    authority: policy.authority,
    convertVia:
      source.convertVia === undefined ? null : { ...source.convertVia },
    policy: {
      referenceSizeCap: policy.referenceSizeCap,
      pollIntervalSeconds: policy.pollIntervalSeconds,
      staleAfterSeconds: policy.staleAfterSeconds,
      spreadEnvelopeBps: policy.spreadEnvelopeBps,
      conversionErrorBps: policy.conversionErrorBps,
    },
    listingState: null,
    listingCheckedAt: null,
    healthy: metric?.healthy ?? false,
    venueState: observation?.venueState ?? null,
    observationAt: millisecondsToSeconds(observation?.observationAt ?? null),
    fetchedAt: millisecondsToSeconds(observation?.fetchedAt ?? null),
    lastTradeAt: millisecondsToSeconds(observation?.lastTradeAt ?? null),
    executablePrice: observation?.vwap ?? null,
    filledFraction: observation?.filledFraction ?? null,
    capped: observation?.capped ?? null,
    referenceSize: metric?.referenceSize ?? null,
    bid: observation?.bid ?? null,
    ask: observation?.ask ?? null,
    spreadBps: metric?.spreadBps ?? null,
    deviationBps: metric?.deviationBps ?? null,
    premiumBps: metric?.premiumBps ?? null,
  };
}

function packageForAsset(
  assetId: string,
  policy: PegAssetPolicy,
  snapshot: PegAssetMetricSnapshot,
  registry: PegRegistry,
): PegAssetDecisionPackage {
  const asset = registry[assetId];
  if (
    asset === undefined ||
    asset.monitors.length > PEG_REGISTRY_MAX_MONITORS_PER_ASSET
  ) {
    throw new Error(`decision-package asset ${assetId} is unsupported`);
  }
  const sourceMetrics = new Map(
    snapshot.sources.map((source) => [source.source, source]),
  );
  return {
    asset: assetId,
    peg: asset.peg,
    coverageClass: asset.coverageClass,
    tokenRefs: asset.tokenRefs.map((token) => ({ ...token })),
    policy: policyEvidence(policy),
    structural: {
      blind: snapshot.blind,
      blindConsecutivePolls: snapshot.blindConsecutivePolls,
      structuralSaturation: snapshot.structuralSaturation,
      structuralQuerySaturated: snapshot.structuralQuerySaturated,
      indexedPoolReachable: snapshot.indexedPoolReachable,
      counterpartyCount: snapshot.counterpartyCount,
    },
    monitors: asset.monitors.map((monitor) =>
      monitorEvidence(
        monitor,
        snapshot.monitors.find((candidate) => sameMonitor(candidate, monitor)),
      ),
    ),
    sources: sortedEntries(policy.sources).map(([sourceId, sourcePolicy]) => {
      const source = asset.sources.find(({ id }) => id === sourceId);
      if (source === undefined) {
        throw new Error(
          `decision-package source ${assetId}/${sourceId} is unsupported`,
        );
      }
      return sourceEvidence(source, sourcePolicy, sourceMetrics.get(sourceId));
    }),
  };
}

export function preparePegDecisionPackages(
  snapshots: PegAssetMetricSnapshot[],
  context: PegDecisionPackagePublicationContext,
): PreparedPegDecisionPackages | null {
  if (snapshots.length === 0) return null;
  const selected = selectProducedVersion(snapshots, context);
  const producedTimes = new Set(
    selected.snapshots.map(({ lastPollAt }) => lastPollAt),
  );
  const producedAt = selected.snapshots[0]?.lastPollAt;
  if (
    producedTimes.size !== 1 ||
    producedAt === undefined ||
    !Number.isInteger(producedAt) ||
    producedAt < 0
  ) {
    throw new Error("decision-package production time is invalid");
  }
  const byAsset = new Map(
    selected.snapshots.map((snapshot) => [snapshot.asset, snapshot]),
  );
  const model: PegDecisionPackages = {
    schemaVersion: PEG_DECISION_PACKAGE_SCHEMA_VERSION,
    approvedActivePolicyVersion: context.approvedActivePolicyVersion,
    producedPolicyVersion: selected.policy.version,
    policySlot:
      selected.policy.version === context.approvedActivePolicyVersion
        ? "active"
        : "previous",
    producedAt,
    rolloverAckExpectedSeconds: selected.policy.rolloverAckExpectedSeconds,
    packages: sortedEntries(selected.policy.assets).map(([assetId, policy]) =>
      packageForAsset(assetId, policy, byAsset.get(assetId)!, context.registry),
    ),
  };
  const json = JSON.stringify(model);
  if (Buffer.byteLength(json, "utf8") > PEG_DECISION_PACKAGE_MAX_BYTES) {
    throw new Error("decision-package response exceeds its byte bound");
  }
  return { model, json };
}

export function commitPegDecisionPackages(
  prepared: PreparedPegDecisionPackages,
): void {
  currentDecisionPackagesJson = prepared.json;
}

export function currentPegDecisionPackagesJson(): string | null {
  return currentDecisionPackagesJson;
}

/** @internal Test-only reset. */
export function _resetPegDecisionPackagesForTests(): void {
  currentDecisionPackagesJson = null;
}
