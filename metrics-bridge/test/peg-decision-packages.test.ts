import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../src/metrics.js";
import {
  _resetPegDecisionPackagesForTests,
  currentPegDecisionPackagesJson,
  PEG_DECISION_PACKAGE_MAX_BYTES,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
} from "../src/peg/decision-packages.js";
import {
  _resetPegMetricsForTests,
  type PegAssetMetricSnapshot,
} from "../src/peg/metrics.js";
import {
  runPegPollCycle,
  type PegPollCycleContext,
  type PegPollSourceState,
} from "../src/peg/poll-cycle.js";
import type { PegPolicyVersion } from "../src/peg/policy.js";
import { publishPegPollSnapshot } from "../src/peg/publisher.js";
import { parsePegRegistry } from "../src/peg/registry.js";

const token = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const feed = "0x3333333333333333333333333333333333333333";
const secondPool = "0x5555555555555555555555555555555555555555";
const secondFeed = "0x6666666666666666666666666666666666666666";

const registry = parsePegRegistry({
  "asset-one": {
    peg: "EUR",
    tokenRefs: [{ chainId: 137, address: token }],
    sources: [
      {
        id: "deep_eur",
        provider: "bitvavo",
        pair: "PEG-EUR",
        baseCurrency: "PEG",
        quoteCurrency: "EUR",
        role: "primary",
      },
    ],
    monitors: [
      {
        chainId: 137,
        poolAddress: pool,
        rateFeedId: feed,
        monitoredTokenAddress: token,
      },
    ],
    coverageClass: "cex-book+indexed-pool",
    rejectedSources: [],
  },
});

function policy(version: string): PegPolicyVersion {
  return {
    version,
    rolloverAckExpectedSeconds: 300,
    assets: {
      "asset-one": {
        target: 1,
        warnDeviationBps: 25,
        criticalDeviationBps: 50,
        premiumWarnBps: 25,
        warnSustainSeconds: 60,
        criticalSustainSeconds: 120,
        durationQuantile: 0.2,
        minimumCoverageFraction: 0.8,
        blindConsecutivePolls: 3,
        permanentlyDeadSeconds: 86_400,
        structuralWarnFraction: 0.8,
        freshnessGraceSeconds: 60,
        deepVenueSource: "deep_eur",
        sources: {
          deep_eur: {
            authority: "deep",
            referenceSizeCap: 50,
            pollIntervalSeconds: 30,
            staleAfterSeconds: 60,
            listingAbsentConsecutiveChecks: 2,
            spreadEnvelopeBps: 50,
            conversionErrorBps: 0,
          },
        },
      },
    },
  };
}

const active = policy("active-v1");
const previous = policy("previous-v1");

const twoMonitorRegistry = structuredClone(registry);
twoMonitorRegistry["asset-one"]!.monitors.push({
  chainId: 137,
  poolAddress: secondPool,
  rateFeedId: secondFeed,
  monitoredTokenAddress: token,
});

function snapshot(
  policyVersion: string,
  overrides: Partial<PegAssetMetricSnapshot> = {},
): PegAssetMetricSnapshot {
  return {
    asset: "asset-one",
    policyVersion,
    lastPollAt: 1_800_000_000,
    blind: false,
    blindConsecutivePolls: 2,
    structuralSaturation: 0.4,
    structuralQuerySaturated: false,
    indexedPoolReachable: true,
    counterpartyCount: 2,
    monitors: [
      {
        chainId: 137,
        poolAddress: pool,
        rateFeedId: feed,
        monitoredTokenAddress: token,
        indexedPoolReachable: true,
        structuralSaturation: 0.4,
        structuralQuerySaturated: false,
        counterpartyCount: 2,
        breaker: {
          id: "feed-breaker",
          address: "0x4444444444444444444444444444444444444444",
          enabled: false,
          kind: "VALUE_DELTA",
          status: "TRIPPED",
          tradingMode: 3,
          effectiveRateChangeThreshold: "50000000000000000000000",
          referenceValue: "1000000000000000000000000",
          lastMedianRate: "999000000000000000000000",
          lastUpdatedAt: 1_800_000_000,
          lastStatusUpdatedAt: 1_799_999_990,
        },
      },
    ],
    sources: [
      {
        asset: "asset-one",
        source: "deep_eur",
        policyVersion,
        healthy: true,
        referenceSize: 50,
        listingState: "listed",
        listingCheckedAt: 1_800_000_000_000,
        listingAbsentConsecutiveChecks: 0,
        observation: {
          vwap: 0.99,
          filledFraction: 1,
          capped: false,
          bid: 0.989,
          ask: 0.991,
          lastTradeAt: 1_800_000_000_000,
          fetchedAt: 1_800_000_000_000,
          observationAt: 1_800_000_000_000,
          sequence: "fixed",
          venueState: "ok",
        },
        deviationBps: 100,
        premiumBps: 0,
        spreadBps: 20,
        newSuccess: true,
        newUsableDecision: true,
      },
    ],
    ...overrides,
  };
}

function context(
  policies: readonly PegPolicyVersion[],
  approvedActivePolicyVersion: string,
  retainedPreviousPolicyVersion: string | null,
  selectedRegistry: typeof registry = registry,
): PegDecisionPackagePublicationContext {
  return {
    registry: selectedRegistry,
    policies,
    approvedActivePolicyVersion,
    retainedPreviousPolicyVersion,
  };
}

function sourceState(lastAttemptAt: number): PegPollSourceState {
  return {
    lastAttemptAt,
    lastObservationAt: null,
    identitiesAtLastObservationAt: new Set(),
    observation: null,
    referenceSize: null,
    conversionValidUntil: null,
    listingState: null,
    listingCheckedAt: null,
    listingAbsentConsecutiveChecks: 0,
    blindConsecutivePolls: 0,
  };
}

const sourceStateKey = (policyVersion: string, sourceId = "deep_eur") =>
  `${policyVersion}:asset-one:${sourceId}`;

const rolloverInput = {
  registry,
  policies: [active, previous] as const,
  approvedActivePolicyVersion: active.version,
  retainedPreviousPolicyVersion: previous.version,
};

function cycleDependencies() {
  const publish = vi.fn(publishPegPollSnapshot);
  const report = vi.fn();
  return {
    dependencies: {
      nowMs: () => 1_800_000_000_000,
      publish,
      report,
    },
    publish,
    report,
  };
}

function currentDecisionPackages() {
  const json = currentPegDecisionPackagesJson();
  if (json === null) throw new Error("expected a decision-package body");
  return JSON.parse(json) as {
    producedPolicyVersion: string;
    policySlot: "active" | "previous";
    packages: Array<{
      asset: string;
      structural: { blind: boolean; blindConsecutivePolls: number };
    }>;
  };
}

beforeEach(() => {
  _resetPegDecisionPackagesForTests();
  _resetPegMetricsForTests();
});
afterEach(() => {
  _resetPegDecisionPackagesForTests();
  _resetPegMetricsForTests();
});

describe("peg decision-package producer", () => {
  it("selects one complete active version and serializes bounded breaker and blind evidence", () => {
    const retained = snapshot(previous.version);
    retained.blind = true;
    retained.sources[0]!.observation = {
      ...retained.sources[0]!.observation!,
      vwap: 0.5,
    };
    const prepared = preparePegDecisionPackages(
      [retained, snapshot(active.version)],
      context([active, previous], active.version, previous.version),
    )!;
    expect(prepared.model).toMatchObject({
      schemaVersion: 1,
      approvedActivePolicyVersion: active.version,
      producedPolicyVersion: active.version,
      policySlot: "active",
      producedAt: 1_800_000_000,
      packages: [
        {
          structural: { blind: false, blindConsecutivePolls: 2 },
          monitors: [
            { breaker: { enabled: false, thresholdScale: "fixidity-1e24" } },
          ],
        },
      ],
    });
    expect(prepared.model.packages[0]?.sources[0]).toMatchObject({
      listingState: "listed",
      listingCheckedAt: 1_800_000_000,
      policy: { listingAbsentConsecutiveChecks: 2 },
      referenceSize: 50,
      executablePrice: 0.99,
    });
    expect(prepared.model.packages[0]?.structural.blind).toBe(false);
    expect(Buffer.byteLength(prepared.json)).toBeLessThanOrEqual(
      PEG_DECISION_PACKAGE_MAX_BYTES,
    );
  });

  it("selects retained previous only as the explicit active-incomplete fallback", () => {
    const legacyPrevious = structuredClone(previous);
    delete legacyPrevious.assets["asset-one"]!.sources.deep_eur!
      .listingAbsentConsecutiveChecks;
    const prepared = preparePegDecisionPackages(
      [snapshot(legacyPrevious.version)],
      context([active, legacyPrevious], active.version, legacyPrevious.version),
    )!;
    expect(prepared.model.producedPolicyVersion).toBe(legacyPrevious.version);
    expect(prepared.model.policySlot).toBe("previous");
    expect(
      prepared.model.packages[0]?.sources[0]?.policy
        .listingAbsentConsecutiveChecks,
    ).toBe(2);
  });

  it("keeps unobserved listing evidence paired null", () => {
    const unobserved = snapshot(active.version);
    unobserved.sources[0]!.listingState = null;
    unobserved.sources[0]!.listingCheckedAt = null;

    const prepared = preparePegDecisionPackages(
      [unobserved],
      context([active], active.version, null),
    )!;

    expect(prepared.model.packages[0]?.sources[0]).toMatchObject({
      listingState: null,
      listingCheckedAt: null,
    });
  });

  it("treats previous=null as an active-only version selection", () => {
    const prepared = preparePegDecisionPackages(
      [snapshot(active.version)],
      context([active], active.version, null),
    )!;
    expect(prepared.model.policySlot).toBe("active");
  });

  it("retains configured topology with explicit unavailable evidence", () => {
    const prepared = preparePegDecisionPackages(
      [snapshot(active.version, { monitors: [], sources: [] })],
      context([active], active.version, null),
    )!;
    const item = prepared.model.packages[0]!;
    expect(item.monitors).toHaveLength(1);
    expect(item.monitors[0]?.indexedPoolReachable).toBe(false);
    expect(item.sources).toHaveLength(1);
    expect(item.sources[0]).toMatchObject({
      healthy: false,
      referenceSize: null,
      executablePrice: null,
    });
  });

  it("keeps distinct monitor evidence and distinguishes disabled from unavailable breakers", () => {
    const measured = snapshot(active.version);
    measured.monitors[0]!.breaker = {
      ...measured.monitors[0]!.breaker!,
      enabled: false,
      referenceValue: "0",
      lastMedianRate: "0",
      lastUpdatedAt: null,
    };
    measured.monitors.push({
      ...measured.monitors[0]!,
      poolAddress: secondPool,
      rateFeedId: secondFeed,
      structuralSaturation: 0.75,
      counterpartyCount: 7,
      breaker: null,
    });

    const prepared = preparePegDecisionPackages(
      [measured],
      context([active], active.version, null, twoMonitorRegistry),
    )!;
    expect(prepared.model.packages[0]?.monitors).toEqual([
      expect.objectContaining({
        poolAddress: pool,
        structuralSaturation: 0.4,
        breaker: expect.objectContaining({
          enabled: false,
          referenceValue: "0",
          lastMedianRate: "0",
          lastUpdatedAt: null,
        }),
      }),
      expect.objectContaining({
        poolAddress: secondPool,
        structuralSaturation: 0.75,
        counterpartyCount: 7,
        breaker: null,
      }),
    ]);
  });

  it("rejects duplicate assets and inconsistent production times", () => {
    expect(() =>
      preparePegDecisionPackages(
        [snapshot(active.version), snapshot(active.version)],
        context([active], active.version, null),
      ),
    ).toThrow(/complete decision-package asset set/);

    const twoAssetPolicy: PegPolicyVersion = {
      ...active,
      assets: {
        ...active.assets,
        "asset-two": structuredClone(active.assets["asset-one"]!),
      },
    };
    const twoAssetRegistry = structuredClone(registry);
    twoAssetRegistry["asset-two"] = structuredClone(
      twoAssetRegistry["asset-one"]!,
    );
    const second = snapshot(active.version, {
      asset: "asset-two",
      lastPollAt: 1_800_000_001,
    });
    second.sources[0]!.asset = "asset-two";
    expect(() =>
      preparePegDecisionPackages(
        [snapshot(active.version), second],
        context([twoAssetPolicy], active.version, null, twoAssetRegistry),
      ),
    ).toThrow(/production time is invalid/);
  });

  it("preserves the last confirmed body through empty and failed publication preparation", () => {
    const publication = context([active], active.version, null);
    publishPegPollSnapshot([snapshot(active.version)], publication);
    const first = currentPegDecisionPackagesJson();
    publishPegPollSnapshot([], null);
    expect(currentPegDecisionPackagesJson()).toBe(first);
    expect(() =>
      publishPegPollSnapshot(
        [{ ...snapshot(active.version), asset: "other-asset" }],
        publication,
      ),
    ).toThrow(/complete decision-package asset set/);
    expect(currentPegDecisionPackagesJson()).toBe(first);
  });

  it("rejects oversized or mixed-version snapshot input", () => {
    const oversized = Array.from({ length: 33 }, (_, index) => ({
      ...snapshot(active.version),
      asset: `asset-${index}`,
    }));
    expect(() =>
      preparePegDecisionPackages(
        oversized,
        context([active], active.version, null),
      ),
    ).toThrow(/asset bound/);
    expect(() =>
      preparePegDecisionPackages(
        [snapshot(active.version), snapshot("other")],
        context([active], active.version, null),
      ),
    ).toThrow(/unselected policy version/);
  });
});

describe("peg poll-cycle decision publication", () => {
  it("publishes a complete previous decision when the active build fails", async () => {
    const { dependencies, publish } = cycleDependencies();

    await expect(
      runPegPollCycle(
        rolloverInput,
        dependencies,
        new Map(),
        async (_registry, selectedPolicy) => {
          if (selectedPolicy.version === active.version) {
            throw new Error("active build failed");
          }
          return [snapshot(selectedPolicy.version)];
        },
      ),
    ).resolves.toEqual([]);

    expect(publish).toHaveBeenCalledWith([], expect.any(Object), [
      expect.objectContaining({ policyVersion: previous.version }),
    ]);
    expect(currentDecisionPackages()).toMatchObject({
      producedPolicyVersion: previous.version,
      policySlot: "previous",
    });
  });

  it("publishes a complete active decision when the previous build fails", async () => {
    const { dependencies, publish } = cycleDependencies();

    await expect(
      runPegPollCycle(
        rolloverInput,
        dependencies,
        new Map(),
        async (_registry, selectedPolicy) => {
          if (selectedPolicy.version === previous.version) {
            throw new Error("previous build failed");
          }
          return [snapshot(selectedPolicy.version)];
        },
      ),
    ).resolves.toEqual([]);

    expect(publish).toHaveBeenCalledWith([], expect.any(Object), [
      expect.objectContaining({ policyVersion: active.version }),
    ]);
    expect(currentDecisionPackages()).toMatchObject({
      producedPolicyVersion: active.version,
      policySlot: "active",
    });
  });

  it("retains the prior decision body when both policy builds fail", async () => {
    publishPegPollSnapshot(
      [snapshot(active.version)],
      context([active, previous], active.version, previous.version),
    );
    const prior = currentPegDecisionPackagesJson();
    const { dependencies, publish } = cycleDependencies();

    await expect(
      runPegPollCycle(rolloverInput, dependencies, new Map(), async () => {
        throw new Error("policy build failed");
      }),
    ).resolves.toEqual([]);

    expect(publish).toHaveBeenCalledWith([], expect.any(Object), []);
    expect(currentPegDecisionPackagesJson()).toBe(prior);
  });

  it("excludes incomplete policy snapshots from decision preparation", async () => {
    publishPegPollSnapshot(
      [snapshot(active.version)],
      context([active, previous], active.version, previous.version),
    );
    const prior = currentPegDecisionPackagesJson();
    const { dependencies, publish, report } = cycleDependencies();

    await runPegPollCycle(
      rolloverInput,
      dependencies,
      new Map(),
      async (_registry, selectedPolicy) => {
        if (selectedPolicy.version === previous.version) {
          throw new Error("previous build failed");
        }
        return [snapshot(selectedPolicy.version, { asset: "unexpected" })];
      },
    );

    expect(publish).toHaveBeenCalledWith([], expect.any(Object), []);
    expect(report).toHaveBeenCalledWith(
      "cycle",
      expect.objectContaining({
        message: expect.stringContaining("incomplete snapshot set"),
      }),
    );
    expect(currentPegDecisionPackagesJson()).toBe(prior);
    expect(currentDecisionPackages().packages).toEqual([
      expect.objectContaining({ asset: "asset-one" }),
    ]);
  });

  it.each([
    [active.version, previous.version],
    [previous.version, active.version],
  ])(
    "commits and prunes only the visible %s policy when %s fails",
    async (visibleVersion, failedVersion) => {
      const visibleKey = sourceStateKey(visibleVersion);
      const visibleStaleKey = sourceStateKey(visibleVersion, "stale");
      const failedKey = sourceStateKey(failedVersion);
      const failedStaleKey = sourceStateKey(failedVersion, "stale");
      const failedOriginal = sourceState(20);
      const failedStaleOriginal = sourceState(21);
      failedOriginal.listingState = "listed";
      failedOriginal.listingCheckedAt = 20_000;
      failedOriginal.listingAbsentConsecutiveChecks = 0;
      const sourceStates = new Map([
        [visibleKey, sourceState(10)],
        [visibleStaleKey, sourceState(11)],
        [failedKey, failedOriginal],
        [failedStaleKey, failedStaleOriginal],
      ]);
      const { dependencies } = cycleDependencies();

      await runPegPollCycle(
        rolloverInput,
        dependencies,
        sourceStates,
        async (_registry, selectedPolicy, cycle) => {
          const key = sourceStateKey(selectedPolicy.version);
          const state = cycle.sourceStates.get(key)!;
          state.lastAttemptAt += 100;
          state.listingState =
            selectedPolicy.version === visibleVersion ? "absent" : "halted";
          state.listingCheckedAt = 200_000;
          state.listingAbsentConsecutiveChecks =
            selectedPolicy.version === visibleVersion ? 1 : 0;
          cycle.activeStateKeys.add(key);
          if (selectedPolicy.version === failedVersion) {
            throw new Error("policy build failed");
          }
          return [snapshot(selectedPolicy.version)];
        },
      );

      expect(sourceStates.get(visibleKey)?.lastAttemptAt).toBe(110);
      expect(sourceStates.get(visibleKey)).toMatchObject({
        listingState: "absent",
        listingCheckedAt: 200_000,
        listingAbsentConsecutiveChecks: 1,
      });
      expect(sourceStates.has(visibleStaleKey)).toBe(false);
      expect(sourceStates.get(failedKey)).toBe(failedOriginal);
      expect(sourceStates.get(failedKey)).toMatchObject({
        listingState: "listed",
        listingCheckedAt: 20_000,
        listingAbsentConsecutiveChecks: 0,
      });
      expect(sourceStates.get(failedStaleKey)).toBe(failedStaleOriginal);
      expect(currentDecisionPackages()).toMatchObject({
        producedPolicyVersion: visibleVersion,
        policySlot: visibleVersion === active.version ? "active" : "previous",
      });
    },
  );

  it("accumulates selected-policy blind state across repeated partial decisions", async () => {
    const activeKey = sourceStateKey(active.version);
    const sourceStates = new Map([[activeKey, sourceState(0)]]);
    const { dependencies } = cycleDependencies();
    const build = async (
      _registry: typeof registry,
      selectedPolicy: PegPolicyVersion,
      cycle: PegPollCycleContext,
    ): Promise<PegAssetMetricSnapshot[]> => {
      if (selectedPolicy.version === previous.version) {
        throw new Error("previous build failed");
      }
      const state = cycle.sourceStates.get(activeKey)!;
      state.blindConsecutivePolls += 1;
      cycle.activeStateKeys.add(activeKey);
      return [
        snapshot(active.version, {
          blind: true,
          blindConsecutivePolls: state.blindConsecutivePolls,
        }),
      ];
    };

    await runPegPollCycle(rolloverInput, dependencies, sourceStates, build);
    expect(currentDecisionPackages().packages[0]?.structural).toMatchObject({
      blind: true,
      blindConsecutivePolls: 1,
    });

    await runPegPollCycle(rolloverInput, dependencies, sourceStates, build);
    expect(currentDecisionPackages().packages[0]?.structural).toMatchObject({
      blind: true,
      blindConsecutivePolls: 2,
    });
  });

  it("commits no counters, decision body, or source state when partial counter validation fails", async () => {
    const activeKey = sourceStateKey(active.version);
    const activeOriginal = sourceState(1);
    const sourceStates = new Map([[activeKey, activeOriginal]]);
    const { dependencies, report } = cycleDependencies();
    const invalid = snapshot(active.version);
    invalid.sources[0]!.newUsableDecision = false;

    await expect(
      runPegPollCycle(
        rolloverInput,
        dependencies,
        sourceStates,
        async (_registry, selectedPolicy, cycle) => {
          if (selectedPolicy.version === previous.version) {
            throw new Error("previous build failed");
          }
          const state = cycle.sourceStates.get(activeKey)!;
          state.lastAttemptAt += 100;
          cycle.activeStateKeys.add(activeKey);
          return [invalid];
        },
      ),
    ).resolves.toEqual([]);

    expect(sourceStates.get(activeKey)).toBe(activeOriginal);
    expect(activeOriginal.lastAttemptAt).toBe(1);
    expect(currentPegDecisionPackagesJson()).toBeNull();
    const metrics = await register.metrics();
    expect(metrics).not.toContain(
      'mento_peg_poll_success_total{asset="asset-one"',
    );
    expect(metrics).not.toContain(
      'mento_peg_usable_decision_total{asset="asset-one"',
    );
    expect(report).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({
        message: expect.stringContaining(
          "newUsableDecision must match a newly accepted",
        ),
      }),
    );
  });

  it("commits neither policy state or decision body when publication fails", async () => {
    publishPegPollSnapshot(
      [snapshot(active.version)],
      context([active, previous], active.version, previous.version),
    );
    const prior = currentPegDecisionPackagesJson();
    const activeKey = sourceStateKey(active.version);
    const previousKey = sourceStateKey(previous.version);
    const activeOriginal = sourceState(1);
    const previousOriginal = sourceState(2);
    const sourceStates = new Map([
      [activeKey, activeOriginal],
      [previousKey, previousOriginal],
    ]);
    const dependencies = {
      nowMs: () => 1_800_000_000_000,
      publish: async () => {
        throw new Error("publication failed");
      },
      report: vi.fn(),
    };

    await expect(
      runPegPollCycle(
        rolloverInput,
        dependencies,
        sourceStates,
        async (_registry, selectedPolicy, cycle) => {
          const key = sourceStateKey(selectedPolicy.version);
          cycle.sourceStates.get(key)!.lastAttemptAt += 100;
          cycle.activeStateKeys.add(key);
          return [snapshot(selectedPolicy.version)];
        },
      ),
    ).resolves.toEqual([]);

    expect(sourceStates.get(activeKey)).toBe(activeOriginal);
    expect(sourceStates.get(previousKey)).toBe(previousOriginal);
    expect(currentPegDecisionPackagesJson()).toBe(prior);
  });
});
