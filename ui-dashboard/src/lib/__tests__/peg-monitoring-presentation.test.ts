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

  it("marks deep critical downside and disabled breakers as action required", () => {
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

    expect(critical.aggregate.label).toBe("Peg action required");
    expect(critical.assets[0]).toMatchObject({
      tone: "critical",
      thresholdTone: "critical",
    });
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

    expect(presentation.aggregate.label).toBe("Current status uncertain");
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

    expect(presentation.aggregate.label).toBe("Current status uncertain");
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

  it("ranks mixed packages by severity and treats stale or previous packages as uncertain", () => {
    const response = healthyResponse();
    const item = response.packages[0]!;
    const criticalItem = {
      ...item,
      asset: "eurox-schuman",
      sources: item.sources.map((source) =>
        source.id === item.policy.deepVenueSource
          ? { ...source, deviationBps: item.policy.criticalDeviationBps }
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

    expect(mixed.aggregate.label).toBe("Peg action required");
    expect(mixed.assets[0]?.asset.asset).toBe("eurox-schuman");
    expect(stale.aggregate.label).toBe("Current status uncertain");
    expect(stale.assets[0]).toMatchObject({ tone: "warning", uncertain: true });
    expect(previous.aggregate.label).toBe("Current status uncertain");
    expect(previous.assets[0]).toMatchObject({
      tone: "warning",
      uncertain: true,
    });
    expect(staleCritical.aggregate.label).toBe("Current status uncertain");
    expect(staleCritical.assets[0]).toMatchObject({
      tone: "critical",
      uncertain: true,
    });
    expect(previousCritical.aggregate.label).toBe("Current status uncertain");
    expect(previousCritical.assets[0]).toMatchObject({
      tone: "critical",
      uncertain: true,
    });
    expect(confirmedCriticalWithUncertainSibling.aggregate.label).toBe(
      "Peg action required",
    );
  });
});
