import { describe, expect, it } from "vitest";
import { presentPegMonitoring } from "../peg-monitoring-presentation";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";

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
    const presentation = presentPegMonitoring(healthyResponse(), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });

    expect(presentation.aggregate.label).toBe("All pegs healthy");
    expect(presentation.assets[0]).toMatchObject({
      assetName: "EUROP",
      tone: "healthy",
      direction: "below",
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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

    const belowAdjustedWarning = presentPegMonitoring(withDistance(25), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });
    const adjustedWarning = presentPegMonitoring(withDistance(55), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });
    const adjustedCritical = presentPegMonitoring(withDistance(80), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });

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

    const atBoundary = presentPegMonitoring(withSpread(envelope), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });
    const beyondBoundary = presentPegMonitoring(withSpread(envelope + 0.01), {
      packageIsStale: false,
      usesPreviousPolicy: false,
    });

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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
    );

    expect(presentation.closestWarning?.asset.asset).toBe("near-warning");
    expect(presentation.closestWarning?.warningDistanceBps).toBeCloseTo(-5);
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
      { packageIsStale: false, usesPreviousPolicy: false },
    );
    const stale = presentPegMonitoring(response, {
      packageIsStale: true,
      usesPreviousPolicy: false,
    });
    const previous = presentPegMonitoring(response, {
      packageIsStale: false,
      usesPreviousPolicy: true,
    });
    const staleCritical = presentPegMonitoring(
      { ...response, packages: [criticalItem] },
      { packageIsStale: true, usesPreviousPolicy: false },
    );
    const previousCritical = presentPegMonitoring(
      { ...response, packages: [criticalItem] },
      { packageIsStale: false, usesPreviousPolicy: true },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
      { packageIsStale: false, usesPreviousPolicy: false },
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
