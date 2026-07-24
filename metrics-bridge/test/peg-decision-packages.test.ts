import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetPegDecisionPackagesForTests,
  currentPegDecisionPackagesJson,
  PEG_DECISION_PACKAGE_MAX_BYTES,
  preparePegDecisionPackages,
  type PegDecisionPackagePublicationContext,
} from "../src/peg/decision-packages.js";
import type { PegAssetMetricSnapshot } from "../src/peg/metrics.js";
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

beforeEach(_resetPegDecisionPackagesForTests);
afterEach(_resetPegDecisionPackagesForTests);

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
      listingState: null,
      listingCheckedAt: null,
      referenceSize: 50,
      executablePrice: 0.99,
    });
    expect(prepared.model.packages[0]?.structural.blind).toBe(false);
    expect(Buffer.byteLength(prepared.json)).toBeLessThanOrEqual(
      PEG_DECISION_PACKAGE_MAX_BYTES,
    );
  });

  it("selects retained previous only as the explicit active-incomplete fallback", () => {
    const prepared = preparePegDecisionPackages(
      [snapshot(previous.version)],
      context([active, previous], active.version, previous.version),
    )!;
    expect(prepared.model.producedPolicyVersion).toBe(previous.version);
    expect(prepared.model.policySlot).toBe("previous");
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
