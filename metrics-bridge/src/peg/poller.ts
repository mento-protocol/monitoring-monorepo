import { getRpcClient } from "../rpc.js";
import {
  fetchBitvavoListing,
  fetchBitvavoObservation,
  type BitvavoListingRequest,
  type BitvavoObservationRequest,
} from "./adapters/bitvavo.js";
import {
  fetchKrakenListing,
  fetchKrakenObservation,
  type KrakenListingRequest,
  type KrakenObservationRequest,
} from "./adapters/kraken.js";
import {
  convertQuotePriceToPeg,
  readPegConversionLeg,
  type PegConversionLeg,
} from "./conversion.js";
import { fetchPegStructuralContext } from "./graphql.js";
import {
  type PegAssetMetricSnapshot,
  type PegSourceMetricSnapshot,
} from "./metrics.js";
import {
  runPegPollCycle,
  type PegPollCycleContext,
  type PegPollCycleInput,
  type PegPollSourceState,
} from "./poll-cycle.js";
import {
  acceptRecordedListingCheck,
  cadenceDue,
  createListingCheckRecorder,
  fetchListing,
  listingCadenceDue,
  pollListingOnly as pollListingCheckOnly,
} from "./listing-poller.js";
import { publishPegPollSnapshot } from "./publisher.js";
import type { PegDecisionPackagePublicationContext } from "./decision-packages.js";
import type {
  PegAssetPolicy,
  PegPolicyVersion,
  PegSourcePolicy,
} from "./policy.js";
import {
  PEG_POLICY_MAX_ASSETS,
  effectiveListingAbsentConsecutiveChecks,
  PEG_POLICY_MAX_SOURCES_PER_ASSET,
} from "./policy.js";
import type {
  PegAsset,
  PegConversion,
  PegRegistry,
  PegSource,
} from "./registry.js";
import {
  pollPegStructuralContext,
  type PegPolledStructuralContext,
} from "./structural-poller.js";
import { deriveReferenceSize } from "./structural.js";
import type {
  AuthoritativeListingCheck,
  PegObservation,
  RecordListingCheck,
} from "./types.js";

export const MAX_PROVIDER_CLOCK_SKEW_MS = 60_000;

const MAX_IDENTITIES_PER_OBSERVATION_TIMESTAMP = 64;

export const PEG_POLL_ERROR_KINDS = [
  "bounds",
  "join",
  "structural_query",
  "structural_missing",
  "structural_binding",
  "structural_data",
  "source_provider",
  "source_fetch",
  "source_freshness",
  "conversion",
  "conversion_unavailable",
  "publish",
  "cycle",
] as const;

export type PegPollErrorKind = (typeof PEG_POLL_ERROR_KINDS)[number];

export interface PegPollErrorEvent {
  kind: PegPollErrorKind;
  asset: string | null;
  source: string | null;
  monitorIndex: number | null;
  cause: unknown;
}

export type { PegPollCycleInput, PegPollCyclePolicies } from "./poll-cycle.js";

export interface PegPollerDependencies {
  nowMs?: () => number;
  fetchStructuralContext?: typeof fetchPegStructuralContext;
  fetchBitvavo?: (
    request: BitvavoObservationRequest,
  ) => Promise<PegObservation>;
  fetchKraken?: (request: KrakenObservationRequest) => Promise<PegObservation>;
  fetchBitvavoListing?: (
    request: BitvavoListingRequest,
  ) => Promise<AuthoritativeListingCheck>;
  fetchKrakenListing?: (
    request: KrakenListingRequest,
  ) => Promise<AuthoritativeListingCheck>;
  readConversionLeg?: (
    conversion: PegConversion,
    nowSeconds: number,
  ) => Promise<PegConversionLeg>;
  publish?: (
    snapshots: PegAssetMetricSnapshot[],
    context: PegDecisionPackagePublicationContext | null,
    decisionSnapshots: PegAssetMetricSnapshot[],
  ) => void | Error | Promise<void | Error>;
  onError?: (event: PegPollErrorEvent) => void;
}

export interface PegPoller {
  pollCycle(input: PegPollCycleInput): Promise<PegAssetMetricSnapshot[]>;
}

type ErrorLocation = {
  asset?: string;
  source?: string;
  monitorIndex?: number;
};

type ReportError = (
  kind: PegPollErrorKind,
  cause: unknown,
  location?: ErrorLocation,
) => void;

interface Dependencies {
  nowMs: () => number;
  fetchStructuralContext: typeof fetchPegStructuralContext;
  fetchBitvavo: (request: BitvavoObservationRequest) => Promise<PegObservation>;
  fetchKraken: (request: KrakenObservationRequest) => Promise<PegObservation>;
  fetchBitvavoListing:
    | ((request: BitvavoListingRequest) => Promise<AuthoritativeListingCheck>)
    | null;
  fetchKrakenListing:
    | ((request: KrakenListingRequest) => Promise<AuthoritativeListingCheck>)
    | null;
  readConversionLeg: (
    conversion: PegConversion,
    nowSeconds: number,
  ) => Promise<PegConversionLeg>;
  publish: (
    snapshots: PegAssetMetricSnapshot[],
    context: PegDecisionPackagePublicationContext | null,
    decisionSnapshots: PegAssetMetricSnapshot[],
  ) => void | Error | Promise<void | Error>;
  report: ReportError;
}

type SourceState = PegPollSourceState;
type CycleContext = PegPollCycleContext<Dependencies>;

const sortedEntries = <Value>(record: Record<string, Value>) =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

const defaultSourceState = (): SourceState => ({
  lastAttemptAt: null,
  listingLastAttemptAt: null,
  lastObservationAt: null,
  identitiesAtLastObservationAt: new Set(),
  observation: null,
  referenceSize: null,
  conversionValidUntil: null,
  listingState: null,
  listingCheckedAt: null,
  listingAbsentConsecutiveChecks: 0,
  blindConsecutivePolls: 0,
});

const defaultReadConversionLeg = async (
  conversion: PegConversion,
  nowSeconds: number,
) => {
  const client = getRpcClient(conversion.chainId);
  if (client === null) {
    throw new Error(`No RPC client for conversion chain ${conversion.chainId}`);
  }
  return readPegConversionLeg(conversion, client, nowSeconds);
};

function resolveListingDependency<Request>(
  listing:
    | ((request: Request) => Promise<AuthoritativeListingCheck>)
    | undefined,
  observation: unknown,
  fallback: (request: Request) => Promise<AuthoritativeListingCheck>,
): ((request: Request) => Promise<AuthoritativeListingCheck>) | null {
  return listing ?? (observation === undefined ? fallback : null);
}

const resolveDependencies = (input: PegPollerDependencies): Dependencies => {
  const report: ReportError = (kind, cause, location = {}) => {
    try {
      input.onError?.({
        kind,
        cause,
        asset: location.asset ?? null,
        source: location.source ?? null,
        monitorIndex: location.monitorIndex ?? null,
      });
    } catch {
      // Observability cannot break the isolated peg lifecycle.
    }
  };
  return {
    nowMs: input.nowMs ?? Date.now,
    fetchStructuralContext:
      input.fetchStructuralContext ?? fetchPegStructuralContext,
    fetchBitvavo: input.fetchBitvavo ?? fetchBitvavoObservation,
    fetchKraken: input.fetchKraken ?? fetchKrakenObservation,
    // Replaced observation adapters must explicitly opt into listing requests,
    // so a mock never triggers real provider traffic.
    fetchBitvavoListing: resolveListingDependency(
      input.fetchBitvavoListing,
      input.fetchBitvavo,
      fetchBitvavoListing,
    ),
    fetchKrakenListing: resolveListingDependency(
      input.fetchKrakenListing,
      input.fetchKraken,
      fetchKrakenListing,
    ),
    readConversionLeg: input.readConversionLeg ?? defaultReadConversionLeg,
    publish: input.publish ?? publishPegPollSnapshot,
    report,
  };
};

function takeBounded<Value>(
  values: Value[],
  maximum: number,
  context: CycleContext,
  label: string,
): Value[] {
  if (values.length > maximum) {
    context.dependencies.report(
      "bounds",
      new Error(`${label} exceeds parsed schema bound ${maximum}`),
    );
  }
  return values.slice(0, maximum);
}

function convertObservation(
  observation: PegObservation,
  conversion: PegConversionLeg,
): PegObservation {
  return {
    ...observation,
    vwap:
      observation.vwap === null
        ? null
        : convertQuotePriceToPeg(observation.vwap, conversion),
    bid:
      observation.bid === null
        ? null
        : convertQuotePriceToPeg(observation.bid, conversion),
    ask:
      observation.ask === null
        ? null
        : convertQuotePriceToPeg(observation.ask, conversion),
  };
}

function observationIsFresh(
  observation: PegObservation,
  policy: PegSourcePolicy,
  nowMs: number,
): boolean {
  if (observation.observationAt === null || observation.sequence === null) {
    return false;
  }
  const ageMs = nowMs - observation.observationAt;
  return (
    Number.isFinite(observation.observationAt) &&
    observation.observationAt >= 0 &&
    ageMs >= -MAX_PROVIDER_CLOCK_SKEW_MS &&
    ageMs <= policy.staleAfterSeconds * 1_000
  );
}

function priceMovement(
  observation: PegObservation | null,
  target: number,
): Pick<PegSourceMetricSnapshot, "deviationBps" | "premiumBps"> {
  if (
    observation === null ||
    observation.venueState === "halted" ||
    observation.capped ||
    observation.vwap === null ||
    !Number.isFinite(observation.vwap) ||
    observation.vwap <= 0
  ) {
    return { deviationBps: null, premiumBps: null };
  }
  return {
    deviationBps: Math.max(0, ((target - observation.vwap) / target) * 10_000),
    premiumBps: Math.max(0, ((observation.vwap - target) / target) * 10_000),
  };
}

function spreadBps(observation: PegObservation | null): number | null {
  if (
    observation === null ||
    observation.bid === null ||
    observation.ask === null
  ) {
    return null;
  }
  const midpoint = (observation.bid + observation.ask) / 2;
  const spread = ((observation.ask - observation.bid) / midpoint) * 10_000;
  return midpoint > 0 && Number.isFinite(spread) && spread >= 0 ? spread : null;
}

type PollSourceInput = {
  assetId: string;
  target: number;
  source: PegSource;
  policy: PegSourcePolicy;
  blindConsecutivePollLimit: number | null;
  structural: PegPolledStructuralContext;
  context: CycleContext;
};

type SourceSnapshotContent = {
  referenceSize: number | null;
  observation: PegObservation | null;
  newSuccess: boolean;
};

function sourceSnapshot(
  input: PollSourceInput,
  state: SourceState,
  content: SourceSnapshotContent,
): PegSourceMetricSnapshot {
  const { referenceSize, observation, newSuccess } = content;
  const movement = priceMovement(observation, input.target);
  return {
    asset: input.assetId,
    source: input.source.id,
    policyVersion: input.context.policyVersion,
    healthy:
      observation !== null &&
      observation.venueState !== "halted" &&
      observation.observationAt !== null &&
      observation.sequence !== null,
    observation,
    referenceSize,
    listingState: state.listingState,
    listingCheckedAt: state.listingCheckedAt,
    listingAbsentConsecutiveChecks: state.listingAbsentConsecutiveChecks,
    ...movement,
    spreadBps: spreadBps(observation),
    newSuccess,
    newUsableDecision:
      newSuccess &&
      movement.deviationBps !== null &&
      movement.premiumBps !== null,
  };
}

function referenceSize(
  structural: PegPolledStructuralContext,
  configuredCap: number,
): number | null {
  if (!structural.reachable || structural.limits.length === 0) {
    return null;
  }
  return Math.min(
    ...structural.limits.map((limit) =>
      deriveReferenceSize(limit, configuredCap),
    ),
  );
}

function sourceCadences(
  state: SourceState,
  input: PollSourceInput,
): { observationCadenceDue: boolean; listingCadenceDue: boolean } {
  const { context, policy } = input;
  return {
    observationCadenceDue: cadenceDue(
      state.lastAttemptAt,
      context.nowSeconds,
      policy.pollIntervalSeconds,
    ),
    listingCadenceDue: listingCadenceDue(
      state,
      context.nowSeconds,
      policy.pollIntervalSeconds,
    ),
  };
}

function fetchSource(
  input: PollSourceInput,
  refSize: number,
  onListingChecked: RecordListingCheck,
): Promise<PegObservation> {
  const observationPolicy = {
    refSize,
    spreadEnvelopeBps: input.policy.spreadEnvelopeBps,
  };
  if (input.source.provider === "bitvavo") {
    return input.context.dependencies.fetchBitvavo({
      ...observationPolicy,
      market: input.source.pair,
      onListingChecked,
    });
  }
  if (input.source.provider === "kraken") {
    return input.context.dependencies.fetchKraken({
      ...observationPolicy,
      symbol: input.source.pair,
      onListingChecked,
    });
  }
  throw new Error(`Unsupported peg provider: ${input.source.provider}`);
}

function clearSource(state: SourceState, refSize: number | null): void {
  state.observation = null;
  state.referenceSize = refSize;
  state.conversionValidUntil = null;
}

function cachedObservation(
  state: SourceState,
  source: PegSource,
  policy: PegSourcePolicy,
  context: CycleContext,
): PegObservation | null {
  if (state.observation?.venueState === "halted") return state.observation;
  if (state.listingState !== null && state.listingState !== "listed")
    clearSource(state, state.referenceSize);
  const conversionFresh =
    source.convertVia === undefined ||
    (state.conversionValidUntil !== null &&
      context.nowSeconds <= state.conversionValidUntil);
  if (
    state.observation === null ||
    !conversionFresh ||
    !observationIsFresh(state.observation, policy, context.nowMs)
  ) {
    state.observation = null;
    return null;
  }
  return state.observation;
}

async function convertSourceObservation(
  source: PegSource,
  observation: PegObservation,
  context: CycleContext,
): Promise<{
  observation: PegObservation | null;
  validUntil: number | null;
}> {
  if (observation.venueState === "halted") {
    return { observation, validUntil: null };
  }
  if (source.convertVia === undefined) {
    return { observation, validUntil: null };
  }
  const conversion = await context.dependencies.readConversionLeg(
    source.convertVia,
    context.nowSeconds,
  );
  if (!conversion.authoritative) {
    return { observation: null, validUntil: null };
  }
  return {
    observation: convertObservation(observation, conversion),
    validUntil: conversion.medianAt + conversion.expirySeconds,
  };
}

function unavailableSourceSnapshot(
  input: PollSourceInput,
  state: SourceState,
  refSize: number,
): PegSourceMetricSnapshot {
  clearSource(state, refSize);
  return sourceSnapshot(input, state, {
    referenceSize: refSize,
    observation: null,
    newSuccess: false,
  });
}

function recordProviderAdvancement(
  state: SourceState,
  observationAt: number,
  sequence: string,
): string | null {
  if (
    state.lastObservationAt !== null &&
    observationAt < state.lastObservationAt
  ) {
    return "venue observation timestamp regressed";
  }

  if (
    state.lastObservationAt === null ||
    observationAt > state.lastObservationAt
  ) {
    state.lastObservationAt = observationAt;
    state.identitiesAtLastObservationAt.clear();
    state.identitiesAtLastObservationAt.add(sequence);
    return null;
  }

  if (state.identitiesAtLastObservationAt.has(sequence)) {
    return "venue observation did not advance";
  }
  if (
    state.identitiesAtLastObservationAt.size >=
    MAX_IDENTITIES_PER_OBSERVATION_TIMESTAMP
  ) {
    return "venue observation identity bound exceeded";
  }

  state.identitiesAtLastObservationAt.add(sequence);
  return null;
}

function failSource(
  input: PollSourceInput,
  state: SourceState,
  refSize: number,
  failure: { kind: PegPollErrorKind; cause: unknown },
): PegSourceMetricSnapshot {
  input.context.dependencies.report(failure.kind, failure.cause, {
    asset: input.assetId,
    source: input.source.id,
  });
  return unavailableSourceSnapshot(input, state, refSize);
}

function acceptDueObservation(
  input: PollSourceInput,
  state: SourceState,
  refSize: number,
  converted: Awaited<ReturnType<typeof convertSourceObservation>>,
): PegSourceMetricSnapshot {
  if (converted.observation === null) {
    return failSource(input, state, refSize, {
      kind: "conversion_unavailable",
      cause: new Error("conversion leg is not authoritative"),
    });
  }
  const observation = converted.observation;
  if (observation.venueState === "halted") {
    // A halt is diagnostic, not a successful price observation. Preserve the
    // last accepted identity so reopening with the same frozen book fails shut.
    state.observation = observation;
    state.referenceSize = refSize;
    state.conversionValidUntil = null;
    return sourceSnapshot(input, state, {
      referenceSize: refSize,
      observation,
      newSuccess: false,
    });
  }
  if (observation.observationAt === null || observation.sequence === null) {
    return failSource(input, state, refSize, {
      kind: "source_freshness",
      cause: new Error("venue observation has no publication identity"),
    });
  }
  const fresh = observationIsFresh(
    observation,
    input.policy,
    input.context.nowMs,
  );
  if (!fresh) {
    return failSource(input, state, refSize, {
      kind: "source_freshness",
      cause: new Error("stale venue observation"),
    });
  }
  const advancementFailure = recordProviderAdvancement(
    state,
    observation.observationAt,
    observation.sequence,
  );
  if (advancementFailure !== null) {
    return failSource(input, state, refSize, {
      kind: "source_freshness",
      cause: new Error(advancementFailure),
    });
  }
  state.observation = observation;
  state.referenceSize = refSize;
  state.conversionValidUntil = converted.validUntil;
  return sourceSnapshot(input, state, {
    referenceSize: refSize,
    observation,
    newSuccess: true,
  });
}

async function pollListingOnly(
  input: PollSourceInput,
  state: SourceState,
  listingCadenceDue: boolean,
): Promise<boolean> {
  if (!listingCadenceDue) return true;
  const request = fetchListing(input.source, input.context.dependencies);
  return pollListingCheckOnly({
    state,
    nowSeconds: input.context.nowSeconds,
    listingCadenceIsDue: listingCadenceDue,
    request,
    listingAbsentConsecutiveCheckLimit: effectiveListingAbsentConsecutiveChecks(
      input.policy,
    ),
    report: (cause) =>
      input.context.dependencies.report("source_fetch", cause, {
        asset: input.assetId,
        source: input.source.id,
      }),
  });
}

async function pollDueSource(
  input: PollSourceInput,
  state: SourceState,
  refSize: number,
  listingCadenceDue: boolean,
): Promise<PegSourceMetricSnapshot> {
  state.lastAttemptAt = input.context.nowSeconds;
  if (listingCadenceDue) state.listingLastAttemptAt = input.context.nowSeconds;
  const { listingChecks, onListingChecked } = createListingCheckRecorder();
  let rawObservation: PegObservation;
  try {
    rawObservation = await fetchSource(input, refSize, onListingChecked);
  } catch (cause) {
    const listingError = acceptRecordedListingCheck(
      state,
      listingChecks,
      effectiveListingAbsentConsecutiveChecks(input.policy),
      listingCadenceDue,
    );
    const supported =
      input.source.provider === "bitvavo" || input.source.provider === "kraken";
    return failSource(input, state, refSize, {
      kind: supported ? "source_fetch" : "source_provider",
      cause: listingError ?? cause,
    });
  }
  const listingError = acceptRecordedListingCheck(
    state,
    listingChecks,
    effectiveListingAbsentConsecutiveChecks(input.policy),
    listingCadenceDue,
  );
  if (listingError !== null) {
    return failSource(input, state, refSize, {
      kind: "source_fetch",
      cause: listingError,
    });
  }
  let converted: Awaited<ReturnType<typeof convertSourceObservation>>;
  try {
    converted = await convertSourceObservation(
      input.source,
      rawObservation,
      input.context,
    );
  } catch (cause) {
    return failSource(input, state, refSize, {
      kind: "conversion",
      cause,
    });
  }
  return acceptDueObservation(input, state, refSize, converted);
}

async function pollSource(
  input: PollSourceInput,
): Promise<PegSourceMetricSnapshot | null> {
  const stateKey = sourceStateKey(
    input.context.policyVersion,
    input.assetId,
    input.source.id,
  );
  input.context.activeStateKeys.add(stateKey);
  const state =
    input.context.sourceStates.get(stateKey) ?? defaultSourceState();
  input.context.sourceStates.set(stateKey, state);
  const refSize = referenceSize(
    input.structural,
    input.policy.referenceSizeCap,
  );
  const { observationCadenceDue, listingCadenceDue } = sourceCadences(
    state,
    input,
  );
  if (refSize === null) {
    return snapshotWithoutReferenceSize(
      input,
      state,
      observationCadenceDue,
      listingCadenceDue,
    );
  }
  // A changed binding reference size requires an immediate new decision even
  // inside the ordinary cadence window.
  const due = observationCadenceDue || state.referenceSize !== refSize;
  if (due) {
    const snapshot = await pollDueSource(
      input,
      state,
      refSize,
      listingCadenceDue,
    );
    if (input.blindConsecutivePollLimit !== null) {
      updateBlindConsecutivePolls(
        state,
        input.blindConsecutivePollLimit,
        snapshot.newUsableDecision,
      );
    }
    return snapshot;
  }

  await pollListingOnly(input, state, listingCadenceDue);

  const observation = cachedObservation(
    state,
    input.source,
    input.policy,
    input.context,
  );
  return sourceSnapshot(input, state, {
    referenceSize: refSize,
    observation,
    newSuccess: false,
  });
}

async function snapshotWithoutReferenceSize(
  input: PollSourceInput,
  state: SourceState,
  observationCadenceDue: boolean,
  listingCadenceDue: boolean,
): Promise<PegSourceMetricSnapshot | null> {
  if (input.blindConsecutivePollLimit !== null && observationCadenceDue) {
    state.lastAttemptAt = input.context.nowSeconds;
    updateBlindConsecutivePolls(state, input.blindConsecutivePollLimit, false);
  }
  const listingAvailable = await pollListingOnly(
    input,
    state,
    listingCadenceDue,
  );
  if (state.referenceSize === null) {
    clearSource(state, null);
    if (!listingAvailable && state.listingState === null) return null;
    return sourceSnapshot(input, state, {
      referenceSize: null,
      observation: null,
      newSuccess: false,
    });
  }
  const observation = cachedObservation(
    state,
    input.source,
    input.policy,
    input.context,
  );
  return sourceSnapshot(input, state, {
    referenceSize: state.referenceSize,
    observation,
    newSuccess: false,
  });
}

function updateBlindConsecutivePolls(
  state: SourceState,
  limit: number,
  usableDecision: boolean,
): void {
  state.blindConsecutivePolls = usableDecision
    ? 0
    : Math.min(state.blindConsecutivePolls + 1, limit);
}

function sourceStateKey(
  policyVersion: string,
  assetId: string,
  sourceId: string,
): string {
  return `${policyVersion}:${assetId}:${sourceId}`;
}

function deepVenueIsBlind(
  sources: PegSourceMetricSnapshot[],
  deepSourceId: string,
): boolean {
  const deep = sources.find(({ source }) => source === deepSourceId);
  return (
    deep === undefined ||
    !deep.healthy ||
    deep.observation === null ||
    deep.observation.venueState === "halted" ||
    deep.observation.capped ||
    deep.observation.vwap === null ||
    !Number.isFinite(deep.observation.vwap) ||
    deep.observation.vwap <= 0
  );
}

type PollPolicySourceInput = {
  assetId: string;
  asset: PegAsset;
  policy: PegAssetPolicy;
  sourceId: string;
  sourcePolicy: PegSourcePolicy;
  structural: PegPolledStructuralContext;
  context: CycleContext;
};

async function pollPolicySource({
  assetId,
  asset,
  policy,
  sourceId,
  sourcePolicy,
  structural,
  context,
}: PollPolicySourceInput): Promise<PegSourceMetricSnapshot | null> {
  const source = asset.sources.find(({ id }) => id === sourceId);
  if (source === undefined) {
    context.dependencies.report(
      "join",
      new Error("policy source is absent from registry"),
      { asset: assetId, source: sourceId },
    );
    throw new Error(`peg source ${assetId}/${sourceId} is unsupported`);
  }
  try {
    return await pollSource({
      assetId,
      target: policy.target,
      source,
      policy: sourcePolicy,
      blindConsecutivePollLimit:
        sourcePolicy.authority === "deep" ? policy.blindConsecutivePolls : null,
      structural,
      context,
    });
  } catch (error) {
    context.dependencies.report("source_fetch", error, {
      asset: assetId,
      source: source.id,
    });
    return null;
  }
}

async function pollAsset(
  assetId: string,
  asset: PegAsset,
  policy: PegAssetPolicy,
  context: CycleContext,
): Promise<PegAssetMetricSnapshot> {
  const structural = await pollPegStructuralContext(
    assetId,
    asset.monitors,
    context,
  );
  const policySources = takeBounded(
    sortedEntries(policy.sources),
    PEG_POLICY_MAX_SOURCES_PER_ASSET,
    context,
    "policy asset sources",
  );
  const joined = await Promise.all(
    policySources.map(([sourceId, sourcePolicy]) =>
      pollPolicySource({
        assetId,
        asset,
        policy,
        sourceId,
        sourcePolicy,
        structural,
        context,
      }),
    ),
  );
  const sources = joined.filter(
    (snapshot): snapshot is PegSourceMetricSnapshot => snapshot !== null,
  );
  const deepVenueSource = policy.deepVenueSource;
  const deepSourceState = context.sourceStates.get(
    sourceStateKey(context.policyVersion, assetId, deepVenueSource),
  );
  return {
    asset: assetId,
    policyVersion: context.policyVersion,
    lastPollAt: context.nowSeconds,
    blind: deepVenueIsBlind(sources, deepVenueSource),
    blindConsecutivePolls: deepSourceState?.blindConsecutivePolls ?? 0,
    structuralSaturation: structural.saturation,
    structuralQuerySaturated: structural.querySaturated,
    indexedPoolReachable: structural.reachable,
    counterpartyCount: structural.counterpartyCount,
    monitors: structural.monitors,
    sources,
  };
}

async function buildSnapshots(
  registry: PegRegistry,
  policy: PegPolicyVersion,
  context: CycleContext,
): Promise<PegAssetMetricSnapshot[]> {
  const policyAssets = takeBounded(
    sortedEntries(policy.assets),
    PEG_POLICY_MAX_ASSETS,
    context,
    "policy assets",
  );
  const joined = await Promise.all(
    policyAssets.map(async ([assetId, assetPolicy]) => {
      const asset = registry[assetId];
      if (asset === undefined) {
        context.dependencies.report(
          "join",
          new Error("policy asset is absent from registry"),
          { asset: assetId },
        );
        throw new Error(`peg asset ${assetId} is unsupported`);
      }
      return pollAsset(assetId, asset, assetPolicy, context);
    }),
  );
  return joined.filter(
    (snapshot): snapshot is PegAssetMetricSnapshot => snapshot !== null,
  );
}

export function createPegPoller(input: PegPollerDependencies = {}): PegPoller {
  const dependencies = resolveDependencies(input);
  const sourceStates = new Map<string, SourceState>();
  return {
    pollCycle: (cycle) =>
      runPegPollCycle(cycle, dependencies, sourceStates, buildSnapshots),
  };
}
