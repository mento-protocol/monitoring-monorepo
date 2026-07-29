import { describe, expect, it } from "vitest";
import { presentPegMonitoring } from "../peg-monitoring-presentation";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_PRODUCED_AT,
} from "@/test-utils/peg-monitoring-fixture";

const CURRENT_CONTEXT = {
  nowMs: PEG_FIXTURE_PRODUCED_AT * 1_000,
  packageIsStale: false,
  usesPreviousPolicy: false,
} as const;

function healthyResponse() {
  const response = makePegMonitoringResponse();
  const item = response.packages[0]!;
  return {
    ...response,
    packages: [
      {
        ...item,
        structural: { ...item.structural, structuralSaturation: null },
        monitors: item.monitors.map((monitor) => ({
          ...monitor,
          structuralSaturation: null,
        })),
        sources: item.sources.map((source) =>
          source.id === item.policy.deepVenueSource
            ? {
                ...source,
                executablePrice: 0.999,
                deviationBps: 10,
                premiumBps: 0,
              }
            : source,
        ),
      },
    ],
  };
}

describe("presentPegMonitoring", () => {
  it("derives a healthy decision from the deep source without treating legacy listing or inactive structural windows as unhealthy", () => {
    const presentation = presentPegMonitoring(
      healthyResponse(),
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("All pegs healthy");
    expect(presentation.assets[0]).toMatchObject({
      assetName: "EUROP",
      tone: "healthy",
      direction: "below",
    });
  });

  it("expires deep-source evidence strictly after its own freshness limit", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const sourceProduced40SecondsEarlier = {
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === item.policy.deepVenueSource
              ? {
                  ...source,
                  observationAt: response.producedAt - 40,
                }
              : source,
          ),
        },
      ],
    };
    const atBoundary = presentPegMonitoring(sourceProduced40SecondsEarlier, {
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + 80) * 1_000,
    });
    const expired = presentPegMonitoring(sourceProduced40SecondsEarlier, {
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + 81) * 1_000,
    });

    expect(atBoundary.aggregate.label).toBe("All pegs healthy");
    expect(atBoundary.assets[0]).toMatchObject({
      decisionSource: expect.any(Object),
      usableSourceCount: 3,
    });
    expect(expired.aggregate.label).toBe("Price check unavailable");
    expect(expired.assets[0]).toMatchObject({
      decisionSource: null,
      distanceBps: null,
      thresholdTone: "uncertain",
      uncertain: true,
      usableSourceCount: 2,
      uncertaintyReason:
        "The policy-selected market observation is older than its allowed freshness window.",
    });

    const retained = presentPegMonitoring(sourceProduced40SecondsEarlier, {
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + 81) * 1_000,
      packageIsStale: true,
    });
    expect(retained.aggregate.label).toBe("Latest data is stale");
    expect(retained.assets[0]).toMatchObject({
      decisionSource: expect.any(Object),
      distanceBps: 10,
      thresholdTone: "healthy",
      usableSourceCount: 3,
    });
  });

  it("expires structural evidence strictly after the asset freshness grace", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const shortGrace = {
      ...response,
      packages: [
        {
          ...item,
          policy: { ...item.policy, freshnessGraceSeconds: 60 },
          sources: item.sources.map((source) => ({
            ...source,
            policy: {
              ...source.policy,
              pollIntervalSeconds: Math.min(
                source.policy.pollIntervalSeconds,
                60,
              ),
            },
          })),
        },
      ],
    };
    const atBoundary = presentPegMonitoring(shortGrace, {
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + 60) * 1_000,
    });
    const expired = presentPegMonitoring(shortGrace, {
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + 61) * 1_000,
    });

    expect(atBoundary.aggregate.label).toBe("All pegs healthy");
    expect(atBoundary.assets[0]?.structuralEvidenceCurrent).toBe(true);
    expect(expired.aggregate.label).toBe("Monitoring checks incomplete");
    expect(expired.assets[0]).toMatchObject({
      decisionSource: expect.any(Object),
      structuralEvidenceCurrent: false,
      uncertain: true,
      uncertaintyReason:
        "The structural checks are older than the policy's freshness window.",
    });
  });

  it("keeps stale scorecard safety and price evidence at the confirmed package timestamp", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const retained = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, freshnessGraceSeconds: 60 },
            sources: item.sources.map((source) => ({
              ...source,
              policy: { ...source.policy, staleAfterSeconds: 30 },
            })),
          },
        ],
      },
      {
        ...CURRENT_CONTEXT,
        nowMs: (response.producedAt + 100) * 1_000,
        packageIsStale: true,
      },
    );

    expect(retained.aggregate.label).toBe("Latest data is stale");
    expect(retained.assets[0]).toMatchObject({
      decisionSource: expect.any(Object),
      distanceBps: 10,
      structuralEvidenceCurrent: true,
      usableSourceCount: 3,
    });
  });

  it("marks a current deep critical reading and disabled breaker as a critical condition", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const critical = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.995,
                    deviationBps: item.policy.criticalDeviationBps,
                  }
                : source,
            ),
            monitors: [
              {
                ...item.monitors[0]!,
                breaker: { ...item.monitors[0]!.breaker!, enabled: false },
              },
            ],
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(critical.aggregate.label).toBe("Critical condition detected");
    expect(critical.assets[0]).toMatchObject({
      tone: "critical",
      currentCritical: true,
      thresholdTone: "critical",
    });
    expect(critical.aggregate.detail).toContain(
      "The alert only fires if enough readings stay there long enough.",
    );
  });

  it("expires breaker decisions strictly after the structural freshness grace", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const baseBreaker = item.monitors[0]!.breaker!;
    const withBreaker = (breaker: typeof baseBreaker | null) => ({
      ...response,
      packages: [
        {
          ...item,
          policy: { ...item.policy, freshnessGraceSeconds: 60 },
          monitors: item.monitors.map((monitor) => ({
            ...monitor,
            breaker,
          })),
          sources: item.sources.map((source) => ({
            ...source,
            policy: {
              ...source.policy,
              pollIntervalSeconds: Math.min(
                source.policy.pollIntervalSeconds,
                60,
              ),
            },
          })),
        },
      ],
    });
    const contextAt = (seconds: number) => ({
      ...CURRENT_CONTEXT,
      nowMs: (response.producedAt + seconds) * 1_000,
    });

    for (const unsafeBreaker of [
      { ...baseBreaker, enabled: false },
      { ...baseBreaker, status: "TRIPPED" as const },
    ]) {
      const atBoundary = presentPegMonitoring(
        withBreaker(unsafeBreaker),
        contextAt(60),
      );
      const expired = presentPegMonitoring(
        withBreaker(unsafeBreaker),
        contextAt(61),
      );

      expect(atBoundary.aggregate.label).toBe("Critical condition detected");
      expect(atBoundary.assets[0]).toMatchObject({
        structuralEvidenceCurrent: true,
        currentCritical: true,
      });
      expect(expired.aggregate.label).toBe("Monitoring checks incomplete");
      expect(expired.assets[0]).toMatchObject({
        structuralEvidenceCurrent: false,
        currentCritical: false,
        uncertain: true,
        uncertaintyReason:
          "The structural checks are older than the policy's freshness window.",
      });
      expect(expired.assets[0]?.reasons).not.toContain(
        "A monitored breaker is disabled or tripped.",
      );
    }

    const unavailableExpired = presentPegMonitoring(
      withBreaker(null),
      contextAt(61),
    );
    expect(unavailableExpired.assets[0]).toMatchObject({
      structuralEvidenceCurrent: false,
      currentCritical: false,
      uncertain: true,
      uncertaintyReason:
        "The structural checks are older than the policy's freshness window.",
    });
    expect(unavailableExpired.assets[0]?.reasons).not.toContain(
      "A monitored breaker is unavailable.",
    );
  });

  it("matches every confirmed blind-while-stressed critical alert leg", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const confirmedBlindStreak = {
      ...item.structural,
      // The alert contract intentionally keys off the confirmed streak rather
      // than the separate instantaneous blind gauge.
      blind: false,
      blindConsecutivePolls: item.policy.blindConsecutivePolls,
    };
    const withSources = (
      update: (
        source: (typeof item.sources)[number],
      ) => (typeof item.sources)[number],
    ) =>
      item.sources.map((source) =>
        source.id === item.policy.deepVenueSource ? update(source) : source,
      );
    const presentations = [
      presentPegMonitoring(
        {
          ...response,
          packages: [
            {
              ...item,
              structural: {
                ...confirmedBlindStreak,
                structuralSaturation: item.policy.structuralWarnFraction,
                indexedPoolReachable: true,
              },
            },
          ],
        },
        CURRENT_CONTEXT,
      ),
      presentPegMonitoring(
        {
          ...response,
          packages: [
            {
              ...item,
              structural: confirmedBlindStreak,
              sources: withSources((source) => ({
                ...source,
                spreadBps: source.policy.spreadEnvelopeBps + 0.01,
              })),
            },
          ],
        },
        CURRENT_CONTEXT,
      ),
      presentPegMonitoring(
        {
          ...response,
          packages: [
            {
              ...item,
              structural: confirmedBlindStreak,
              sources: withSources((source) => ({
                ...source,
                capped: true,
                executablePrice:
                  item.policy.target *
                  (1 -
                    (item.policy.criticalDeviationBps +
                      source.policy.conversionErrorBps) /
                      10_000),
              })),
            },
          ],
        },
        CURRENT_CONTEXT,
      ),
    ];

    const expectedDetails = [
      "on-chain pool activity crossed its warning limit",
      "buy and sell prices moved too far apart",
      "available partial price crossed the critical downside limit",
    ];
    for (const [index, presentation] of presentations.entries()) {
      expect(presentation.aggregate).toMatchObject({
        tone: "critical",
        label: "Critical condition detected",
      });
      expect(presentation.aggregate.detail).toContain(
        `${item.policy.blindConsecutivePolls} consecutive checks`,
      );
      expect(presentation.aggregate.detail).toContain(expectedDetails[index]);
      expect(presentation.assets[0]).toMatchObject({
        tone: "critical",
        currentCritical: true,
      });
    }
    expect(presentations.map(({ assets }) => assets[0]?.uncertain)).toEqual([
      false,
      false,
      true,
    ]);
    expect(presentations[2]?.assets[0]?.decisionSource).toBeNull();
  });

  it("keeps blind-while-stressed alert boundaries fail closed", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const deepSource = item.sources.find(
      ({ id }) => id === item.policy.deepVenueSource,
    )!;
    const withBlindStress = (
      blindConsecutivePolls: number,
      spreadBps: number,
    ) => ({
      ...response,
      packages: [
        {
          ...item,
          structural: {
            ...item.structural,
            blind: true,
            blindConsecutivePolls,
          },
          sources: item.sources.map((source) =>
            source.id === item.policy.deepVenueSource
              ? { ...source, spreadBps }
              : source,
          ),
        },
      ],
    });
    const belowBlindLimit = presentPegMonitoring(
      withBlindStress(
        item.policy.blindConsecutivePolls - 1,
        deepSource.policy.spreadEnvelopeBps + 0.01,
      ),
      CURRENT_CONTEXT,
    );
    const atSpreadBoundary = presentPegMonitoring(
      withBlindStress(
        item.policy.blindConsecutivePolls,
        deepSource.policy.spreadEnvelopeBps,
      ),
      CURRENT_CONTEXT,
    );
    const atFreshnessBoundary = presentPegMonitoring(
      withBlindStress(
        item.policy.blindConsecutivePolls,
        deepSource.policy.spreadEnvelopeBps + 0.01,
      ),
      {
        ...CURRENT_CONTEXT,
        nowMs:
          (deepSource.observationAt! + deepSource.policy.staleAfterSeconds) *
          1_000,
      },
    );
    const afterFreshnessBoundary = presentPegMonitoring(
      withBlindStress(
        item.policy.blindConsecutivePolls,
        deepSource.policy.spreadEnvelopeBps + 0.01,
      ),
      {
        ...CURRENT_CONTEXT,
        nowMs:
          (deepSource.observationAt! +
            deepSource.policy.staleAfterSeconds +
            1) *
          1_000,
      },
    );

    expect(belowBlindLimit.assets[0]?.currentCritical).toBe(false);
    expect(atSpreadBoundary.assets[0]?.currentCritical).toBe(false);
    expect(atFreshnessBoundary.assets[0]?.currentCritical).toBe(true);
    expect(afterFreshnessBoundary.assets[0]?.currentCritical).toBe(false);
  });

  it("uses the directional warning threshold for an above-target measurement", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 1.003,
                    deviationBps: 0,
                    premiumBps: item.policy.premiumWarnBps,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("Some pegs need attention");
    expect(presentation.assets[0]).toMatchObject({
      tone: "warning",
      direction: "above",
      warningThresholdBps: item.policy.premiumWarnBps,
      thresholdTone: "warning",
    });
  });

  it("adds the selected source conversion allowance to every price threshold", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const withDistance = (distance: number) => ({
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === item.policy.deepVenueSource
              ? {
                  ...source,
                  policy: { ...source.policy, conversionErrorBps: 30 },
                  executablePrice: 1 - distance / 10_000,
                  deviationBps: distance,
                  premiumBps: 0,
                }
              : source,
          ),
        },
      ],
    });

    const belowAdjustedWarning = presentPegMonitoring(
      withDistance(25),
      CURRENT_CONTEXT,
    );
    const adjustedWarning = presentPegMonitoring(
      withDistance(55),
      CURRENT_CONTEXT,
    );
    const adjustedCritical = presentPegMonitoring(
      withDistance(80),
      CURRENT_CONTEXT,
    );

    expect(belowAdjustedWarning.assets[0]).toMatchObject({
      tone: "healthy",
      downsideWarningThresholdBps: 55,
      downsideCriticalThresholdBps: 80,
      premiumWarningThresholdBps: 55,
      warningThresholdBps: 55,
      thresholdTone: "healthy",
    });
    expect(belowAdjustedWarning.assets[0]?.warningDistanceBps).toBeCloseTo(30);
    expect(adjustedWarning.assets[0]).toMatchObject({
      tone: "warning",
      warningDistanceBps: 0,
      thresholdTone: "warning",
    });
    expect(adjustedCritical.assets[0]).toMatchObject({
      tone: "critical",
      currentCritical: true,
      thresholdTone: "critical",
    });
  });

  it("matches the alert rule's strict spread warning boundary", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const withSpread = (spreadBps: number) => ({
      ...response,
      packages: [
        {
          ...item,
          sources: item.sources.map((source) =>
            source.id === item.policy.deepVenueSource
              ? { ...source, spreadBps }
              : source,
          ),
        },
      ],
    });
    const envelope = item.sources.find(
      ({ id }) => id === item.policy.deepVenueSource,
    )!.policy.spreadEnvelopeBps;

    const atBoundary = presentPegMonitoring(
      withSpread(envelope),
      CURRENT_CONTEXT,
    );
    const beyondBoundary = presentPegMonitoring(
      withSpread(envelope + 0.01),
      CURRENT_CONTEXT,
    );

    expect(atBoundary.aggregate.label).toBe("All pegs healthy");
    expect(atBoundary.assets[0]?.tone).toBe("healthy");
    expect(beyondBoundary.aggregate.label).toBe("Some pegs need attention");
    expect(beyondBoundary.assets[0]?.tone).toBe("warning");
  });

  it("does not infer a critical downside threshold from the warning threshold", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            policy: {
              ...item.policy,
              warnDeviationBps: 20,
              criticalDeviationBps: 45,
            },
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.996,
                    deviationBps: 40,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.assets[0]).toMatchObject({
      tone: "warning",
      thresholdTone: "warning",
    });
    expect(presentation.assets[0]?.warningDistanceBps).toBeCloseTo(-20);
  });

  it("keeps a zero executable price as a measurable critical deviation", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0,
                    deviationBps: 10_000,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.assets[0]).toMatchObject({
      tone: "critical",
      distanceBps: 10_000,
      direction: "below",
    });
  });

  it("keeps unavailable deep evidence conservative and calls it uncertain", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    healthy: false,
                    executablePrice: null,
                    observationAt: null,
                    fetchedAt: null,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("Price check unavailable");
    expect(presentation.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
      thresholdTone: "uncertain",
      decisionSource: null,
      distanceBps: null,
    });
    expect(presentation.furthest).toBeNull();
    expect(presentation.closestWarning).toBeNull();
  });

  it("treats a confirmed structural threshold breach as a warning rather than uncertainty", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const packageThreshold = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              structuralSaturation: item.policy.structuralWarnFraction,
            },
          },
        ],
      },
      CURRENT_CONTEXT,
    );
    const monitorThreshold = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            monitors: item.monitors.map((monitor) => ({
              ...monitor,
              structuralSaturation: item.policy.structuralWarnFraction,
            })),
          },
        ],
      },
      CURRENT_CONTEXT,
    );
    const incompleteQuery = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            structural: {
              ...item.structural,
              structuralQuerySaturated: true,
            },
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(packageThreshold.aggregate.label).toBe("Some pegs need attention");
    expect(packageThreshold.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: false,
    });
    expect(monitorThreshold.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: false,
    });
    expect(incompleteQuery.aggregate.label).toBe(
      "Monitoring checks incomplete",
    );
    expect(incompleteQuery.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
    });
  });

  it("does not use a capped deep observation as decision evidence", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    capped: true,
                    executablePrice: 0.99,
                    deviationBps: item.policy.criticalDeviationBps * 2,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("Price check unavailable");
    expect(presentation.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
      decisionSource: null,
      distanceBps: null,
      direction: null,
    });
    expect(presentation.furthest).toBeNull();
    expect(presentation.closestWarning).toBeNull();
  });

  it("does not use a deep observation with missing decision metrics", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            sources: item.sources.map((source) =>
              source.id === item.policy.deepVenueSource
                ? {
                    ...source,
                    executablePrice: 0.999,
                    deviationBps: null,
                    premiumBps: null,
                  }
                : source,
            ),
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("Price check unavailable");
    expect(presentation.assets[0]).toMatchObject({
      uncertain: true,
      decisionSource: null,
      distanceBps: null,
      thresholdTone: "uncertain",
    });
  });

  it("does not replace a missing policy-selected deep source with another deep source", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, deepVenueSource: "missing-deep-source" },
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.aggregate.label).toBe("Price check unavailable");
    expect(presentation.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
      deepSource: null,
      decisionSource: null,
      distanceBps: null,
    });
    expect(presentation.furthest).toBeNull();
    expect(presentation.closestWarning).toBeNull();
  });

  it("selects furthest distance independently from severity ranking", () => {
    const response = healthyResponse();
    const healthyItem = response.packages[0]!;
    const structuralWarningItem = {
      ...healthyItem,
      asset: "eurox-schuman",
      structural: { ...healthyItem.structural, blind: true },
      sources: healthyItem.sources.map((source) =>
        source.id === healthyItem.policy.deepVenueSource
          ? { ...source, executablePrice: 0.9995, deviationBps: 5 }
          : source,
      ),
    };
    const presentation = presentPegMonitoring(
      { ...response, packages: [healthyItem, structuralWarningItem] },
      CURRENT_CONTEXT,
    );

    expect(presentation.assets[0]?.asset.asset).toBe("eurox-schuman");
    expect(presentation.furthest?.asset.asset).toBe("europ-schuman");
  });

  it("selects the asset nearest the warning boundary after multiple assets cross it", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const crossedBy = (asset: string, distanceBps: number) => ({
      ...item,
      asset,
      sources: item.sources.map((source) =>
        source.id === item.policy.deepVenueSource
          ? {
              ...source,
              executablePrice: 1 - distanceBps / 10_000,
              deviationBps: distanceBps,
              premiumBps: 0,
            }
          : source,
      ),
    });
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [
          crossedBy("far-beyond-warning", 125),
          crossedBy("near-warning", 30),
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(presentation.closestWarning?.asset.asset).toBe("near-warning");
    expect(presentation.closestWarning?.warningDistanceBps).toBeCloseTo(-5);
  });

  it("uses the nearer directional warning boundary for an asset at target", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const atTarget = {
      ...item,
      asset: "at-target",
      policy: {
        ...item.policy,
        warnDeviationBps: 100,
        criticalDeviationBps: 150,
        premiumWarnBps: 10,
      },
      sources: item.sources.map((source) =>
        source.id === item.policy.deepVenueSource
          ? {
              ...source,
              executablePrice: item.policy.target,
              deviationBps: 0,
              premiumBps: 0,
            }
          : source,
      ),
    };
    const twentyBpsFromWarning = {
      ...item,
      asset: "twenty-bps-from-warning",
      sources: item.sources.map((source) =>
        source.id === item.policy.deepVenueSource
          ? {
              ...source,
              executablePrice: 0.9995,
              deviationBps: 5,
              premiumBps: 0,
            }
          : source,
      ),
    };
    const presentation = presentPegMonitoring(
      {
        ...response,
        packages: [twentyBpsFromWarning, atTarget],
      },
      CURRENT_CONTEXT,
    );
    const atTargetPresentation = presentation.assets.find(
      ({ asset }) => asset.asset === "at-target",
    );

    expect(atTargetPresentation).toMatchObject({
      direction: "at target",
      warningThresholdBps: 10,
      warningDistanceBps: 10,
    });
    expect(presentation.closestWarning?.asset.asset).toBe("at-target");
  });

  it("ranks mixed packages by severity and treats stale or previous packages as uncertain", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const criticalItem = {
      ...item,
      asset: "eurox-schuman",
      sources: item.sources.map((source) =>
        source.id === item.policy.deepVenueSource
          ? {
              ...source,
              executablePrice: 0.995,
              deviationBps: item.policy.criticalDeviationBps,
            }
          : source,
      ),
    };
    const mixed = presentPegMonitoring(
      { ...response, packages: [item, criticalItem] },
      CURRENT_CONTEXT,
    );
    const stale = presentPegMonitoring(response, {
      ...CURRENT_CONTEXT,
      packageIsStale: true,
    });
    const previous = presentPegMonitoring(response, {
      ...CURRENT_CONTEXT,
      usesPreviousPolicy: true,
    });
    const staleCritical = presentPegMonitoring(
      { ...response, packages: [criticalItem] },
      { ...CURRENT_CONTEXT, packageIsStale: true },
    );
    const previousCritical = presentPegMonitoring(
      { ...response, packages: [criticalItem] },
      { ...CURRENT_CONTEXT, usesPreviousPolicy: true },
    );
    const confirmedCriticalWithUncertainSibling = presentPegMonitoring(
      {
        ...response,
        packages: [
          criticalItem,
          {
            ...item,
            asset: "uncertain-euro",
            structural: { ...item.structural, blind: true },
          },
        ],
      },
      CURRENT_CONTEXT,
    );
    const currentCriticalWithIncompleteChecks = presentPegMonitoring(
      {
        ...response,
        packages: [
          {
            ...criticalItem,
            structural: { ...item.structural, blind: true },
          },
        ],
      },
      CURRENT_CONTEXT,
    );

    expect(mixed.aggregate.label).toBe("Critical condition detected");
    expect(mixed.assets[0]?.asset.asset).toBe("eurox-schuman");
    expect(stale.aggregate.label).toBe("Latest data is stale");
    expect(stale.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
      thresholdTone: "healthy",
    });
    expect(previous.aggregate.label).toBe("Policy update pending");
    expect(previous.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
      thresholdTone: "healthy",
    });
    expect(staleCritical.aggregate.label).toBe("Latest data is stale");
    expect(staleCritical.assets[0]).toMatchObject({
      tone: "critical",
      currentCritical: false,
      uncertain: true,
    });
    expect(previousCritical.aggregate.label).toBe("Policy update pending");
    expect(previousCritical.assets[0]).toMatchObject({
      tone: "critical",
      currentCritical: false,
      uncertain: true,
    });
    expect(confirmedCriticalWithUncertainSibling.aggregate.label).toBe(
      "Critical condition detected",
    );
    expect(currentCriticalWithIncompleteChecks.aggregate.label).toBe(
      "Critical condition detected",
    );
    expect(currentCriticalWithIncompleteChecks.assets[0]).toMatchObject({
      tone: "critical",
      currentCritical: true,
      uncertain: true,
    });
  });
});
