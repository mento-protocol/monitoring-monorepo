import type { PegAssetMetricSnapshot } from "./metrics.js";
import type { PegPolicyVersion } from "./policy.js";
import type { PegRegistry } from "./registry.js";
import type { PegObservation } from "./types.js";

interface SinglePolicyPegPollCycleInput {
  registry: PegRegistry;
  policy: PegPolicyVersion;
  policies?: never;
}

export type PegPollCyclePolicies =
  | readonly [PegPolicyVersion]
  | readonly [PegPolicyVersion, PegPolicyVersion];

interface MultiPolicyPegPollCycleInput {
  registry: PegRegistry;
  policies: PegPollCyclePolicies;
  policy?: never;
}

export type PegPollCycleInput =
  | SinglePolicyPegPollCycleInput
  | MultiPolicyPegPollCycleInput;

export interface PegPollSourceState {
  // Provider attempt time, or the last counted deep-source cadence slot when
  // no structural reference size was available for a provider request.
  lastAttemptAt: number | null;
  lastObservationAt: number | null;
  identitiesAtLastObservationAt: Set<string>;
  observation: PegObservation | null;
  referenceSize: number | null;
  conversionValidUntil: number | null;
  blindConsecutivePolls: number;
}

export interface PegPollCycleCoordinatorDependencies {
  nowMs: () => number;
  publish: (snapshots: PegAssetMetricSnapshot[]) => void | Promise<void>;
  report: (kind: "cycle" | "publish", cause: unknown) => void;
}

export interface PegPollCycleContext<
  Dependencies extends PegPollCycleCoordinatorDependencies =
    PegPollCycleCoordinatorDependencies,
> {
  nowMs: number;
  nowSeconds: number;
  policyVersion: string;
  dependencies: Dependencies;
  sourceStates: Map<string, PegPollSourceState>;
  activeStateKeys: Set<string>;
}

export type PegPollCycleSnapshotBuilder<
  Dependencies extends PegPollCycleCoordinatorDependencies,
> = (
  registry: PegRegistry,
  policy: PegPolicyVersion,
  context: PegPollCycleContext<Dependencies>,
) => Promise<PegAssetMetricSnapshot[]>;

function pruneSourceStates(
  sourceStates: Map<string, PegPollSourceState>,
  activeStateKeys: Set<string>,
): void {
  for (const key of sourceStates.keys()) {
    if (!activeStateKeys.has(key)) sourceStates.delete(key);
  }
}

function cloneSourceStates(
  sourceStates: Map<string, PegPollSourceState>,
): Map<string, PegPollSourceState> {
  return new Map(
    [...sourceStates].map(([key, state]) => [
      key,
      {
        ...state,
        identitiesAtLastObservationAt: new Set(
          state.identitiesAtLastObservationAt,
        ),
        observation:
          state.observation === null ? null : { ...state.observation },
      },
    ]),
  );
}

function replaceSourceStates(
  target: Map<string, PegPollSourceState>,
  source: Map<string, PegPollSourceState>,
): void {
  target.clear();
  for (const [key, state] of source) target.set(key, state);
}

function policiesForCycle(input: PegPollCycleInput): PegPollCyclePolicies {
  const policies =
    "policy" in input && input.policy !== undefined
      ? [input.policy]
      : [...input.policies];
  if (policies.length === 0 || policies.length > 2) {
    throw new Error("peg poll cycle requires one or two policies");
  }
  if (
    new Set(policies.map(({ version }) => version)).size !== policies.length
  ) {
    throw new Error("peg poll cycle policy versions must be distinct");
  }
  return policies.length === 1 ? [policies[0]!] : [policies[0]!, policies[1]!];
}

export async function runPegPollCycle<
  Dependencies extends PegPollCycleCoordinatorDependencies,
>(
  input: PegPollCycleInput,
  dependencies: Dependencies,
  sourceStates: Map<string, PegPollSourceState>,
  buildSnapshots: PegPollCycleSnapshotBuilder<Dependencies>,
): Promise<PegAssetMetricSnapshot[]> {
  const snapshots: PegAssetMetricSnapshot[] = [];
  const cycleSourceStates = cloneSourceStates(sourceStates);
  let cycleComplete = false;
  try {
    const nowMs = dependencies.nowMs();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new Error("peg poll clock must return finite Unix milliseconds");
    }
    const nowSeconds = Math.floor(nowMs / 1_000);
    const activeStateKeys = new Set<string>();
    let policyFailed = false;
    for (const policy of policiesForCycle(input)) {
      const context: PegPollCycleContext<Dependencies> = {
        nowMs,
        nowSeconds,
        policyVersion: policy.version,
        dependencies,
        sourceStates: cycleSourceStates,
        activeStateKeys,
      };
      try {
        snapshots.push(
          ...(await buildSnapshots(input.registry, policy, context)),
        );
      } catch (error) {
        dependencies.report("cycle", error);
        policyFailed = true;
      }
    }
    if (policyFailed) snapshots.length = 0;
    else {
      pruneSourceStates(cycleSourceStates, activeStateKeys);
      cycleComplete = true;
    }
  } catch (error) {
    dependencies.report("cycle", error);
  }

  if (!cycleComplete) snapshots.length = 0;

  try {
    await dependencies.publish(snapshots);
  } catch (error) {
    dependencies.report("publish", error);
    return [];
  }
  if (cycleComplete) replaceSourceStates(sourceStates, cycleSourceStates);
  return snapshots;
}
