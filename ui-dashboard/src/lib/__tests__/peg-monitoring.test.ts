import { describe, expect, it } from "vitest";
import {
  classifyPegMonitoringState,
  PEG_MONITORING_STALE_AFTER_MS,
} from "@/lib/peg-monitoring";
import { PegMonitoringResponseSchema } from "@/lib/peg-monitoring-schema";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_PRODUCED_AT,
} from "@/test-utils/peg-monitoring-fixture";

describe("PegMonitoringResponseSchema", () => {
  it("preserves distinct observed and configured blind poll counts", () => {
    const parsed = PegMonitoringResponseSchema.parse(
      makePegMonitoringResponse(),
    );
    expect(parsed.packages[0]?.structural.blindConsecutivePolls).toBe(0);
    expect(parsed.packages[0]?.policy.blindConsecutivePolls).toBe(10);
  });
  it("accepts inclusive structural-saturation bounds and rejects values outside them", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    const valid = (structuralSaturation: number) =>
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            structural: { ...item.structural, structuralSaturation },
            monitors: [{ ...monitor, structuralSaturation }],
          },
        ],
      }).success;
    expect(valid(0)).toBe(true);
    expect(valid(1)).toBe(true);
    for (const structuralSaturation of [-0.01, 1.01]) {
      expect(
        PegMonitoringResponseSchema.safeParse({
          ...response,
          packages: [
            {
              ...item,
              structural: { ...item.structural, structuralSaturation },
            },
          ],
        }).success,
      ).toBe(false);
      expect(
        PegMonitoringResponseSchema.safeParse({
          ...response,
          packages: [
            {
              ...item,
              monitors: [{ ...monitor, structuralSaturation }],
            },
          ],
        }).success,
      ).toBe(false);
    }
  });
  it("rejects topology holes, policy-slot drift, and bad uint256", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        policySlot: "previous",
      }).success,
    ).toBe(false);
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [{ ...item, monitors: [] }],
      }).success,
    ).toBe(false);
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              {
                ...monitor,
                breaker: {
                  ...monitor.breaker!,
                  enabled: false,
                  effectiveRateChangeThreshold: "050",
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("accepts the producer's paired listing evidence, including legacy nulls", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const valid = (
      listingState: "listed" | "halted" | "absent" | null,
      healthy: boolean,
    ) =>
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            sources: [
              {
                ...source,
                listingState,
                listingCheckedAt:
                  listingState === null ? null : PEG_FIXTURE_PRODUCED_AT - 5,
                healthy,
              },
              ...item.sources.slice(1),
            ],
          },
        ],
      }).success;

    expect(valid(null, true)).toBe(true);
    expect(valid("listed", true)).toBe(true);
    expect(valid("halted", false)).toBe(true);
    expect(valid("absent", false)).toBe(true);
  });
  it("rejects incomplete, unsupported, and contradictory listing evidence", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const valid = (sourceOverride: Record<string, unknown>) =>
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            sources: [{ ...source, ...sourceOverride }],
          },
        ],
      }).success;

    expect(valid({ listingState: "listed", listingCheckedAt: null })).toBe(
      false,
    );
    expect(
      valid({
        listingState: null,
        listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 5,
      }),
    ).toBe(false);
    expect(
      valid({
        listingState: "unsupported",
        listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 5,
      }),
    ).toBe(false);
    expect(
      valid({
        listingState: "listed",
        listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 0.5,
      }),
    ).toBe(false);
    expect(
      valid({
        listingState: "halted",
        listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 5,
        healthy: true,
      }),
    ).toBe(false);
    expect(
      valid({
        listingState: "absent",
        listingCheckedAt: PEG_FIXTURE_PRODUCED_AT - 5,
        healthy: true,
      }),
    ).toBe(false);
  });
  it("rejects source cadence beyond freshness grace", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            policy: { ...item.policy, freshnessGraceSeconds: 60 },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("requires the producer's complete observation subset for healthy sources", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const invalid = (sourceOverride: Partial<typeof source>) =>
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            sources: [{ ...source, ...sourceOverride }],
          },
        ],
      }).success;

    for (const required of [
      "venueState",
      "observationAt",
      "fetchedAt",
      "filledFraction",
      "capped",
      "referenceSize",
    ] as const) {
      expect(invalid({ [required]: null })).toBe(false);
    }
    expect(invalid({ venueState: "halted" })).toBe(false);
  });
  it("accepts unavailable and status-only unhealthy evidence, but keeps timestamp pairs complete", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const valid = (sourceOverride: Partial<typeof source>) =>
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            sources: [{ ...source, healthy: false, ...sourceOverride }],
          },
        ],
      }).success;

    expect(
      valid({
        venueState: null,
        observationAt: null,
        fetchedAt: null,
        lastTradeAt: null,
        executablePrice: null,
        filledFraction: null,
        capped: null,
        referenceSize: null,
        bid: null,
        ask: null,
        spreadBps: null,
        deviationBps: null,
        premiumBps: null,
      }),
    ).toBe(true);
    expect(
      valid({
        venueState: "halted",
        observationAt: null,
        fetchedAt: PEG_FIXTURE_PRODUCED_AT - 5,
        filledFraction: 0,
        capped: true,
        executablePrice: null,
        bid: null,
        ask: null,
        spreadBps: null,
        deviationBps: null,
        premiumBps: null,
      }),
    ).toBe(true);
    expect(
      valid({
        observationAt: PEG_FIXTURE_PRODUCED_AT - 5,
        fetchedAt: null,
      }),
    ).toBe(false);
  });
  it("accepts disabled breakers and neutral null breakers", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const monitor = item.monitors[0]!;
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [
          {
            ...item,
            monitors: [
              { ...monitor, breaker: { ...monitor.breaker!, enabled: false } },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [{ ...item, monitors: [{ ...monitor, breaker: null }] }],
      }).success,
    ).toBe(true);
  });
  it("accepts a producer-valid non-peg conversion", () => {
    const parsed = PegMonitoringResponseSchema.parse(
      makePegMonitoringResponse(),
    );
    expect(
      parsed.packages[0]?.sources.find(({ id }) => id === "kraken_usd")
        ?.convertVia,
    ).toMatchObject({ fromCurrency: "USD", toCurrency: "EUR" });
  });
  it("rejects duplicate and incompatible producer topology", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const monitor = item.monitors[0]!;
    const invalid = (next: typeof item) =>
      PegMonitoringResponseSchema.safeParse({ ...response, packages: [next] })
        .success;
    expect(
      PegMonitoringResponseSchema.safeParse({
        ...response,
        packages: [item, item],
      }).success,
    ).toBe(false);
    expect(
      invalid({
        ...item,
        tokenRefs: [...item.tokenRefs, item.tokenRefs[0]!],
      }),
    ).toBe(false);
    expect(invalid({ ...item, sources: [source, source] })).toBe(false);
    expect(invalid({ ...item, monitors: [monitor, monitor] })).toBe(false);
    expect(
      invalid({
        ...item,
        monitors: [
          {
            ...monitor,
            monitoredTokenAddress: "0x5555555555555555555555555555555555555555",
          },
        ],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [{ ...source, registryRole: "secondary", authority: "deep" }],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [
          { ...source, registryRole: "display", authority: "secondary" },
        ],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [{ ...source, quoteCurrency: "USD", convertVia: null }],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [
          {
            ...source,
            convertVia: {
              chainId: monitor.chainId,
              rateFeedId: monitor.rateFeedId,
              fromCurrency: "USD",
              toCurrency: "EUR",
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [
          {
            ...source,
            convertVia: {
              chainId: monitor.chainId,
              rateFeedId: monitor.rateFeedId,
              fromCurrency: "EUR",
              toCurrency: "EUR",
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      invalid({
        ...item,
        sources: [
          {
            ...source,
            quoteCurrency: "USD",
            convertVia: {
              chainId: 1,
              rateFeedId: monitor.rateFeedId,
              fromCurrency: "USD",
              toCurrency: "EUR",
            },
          },
        ],
      }),
    ).toBe(false);
  });
});
describe("classifyPegMonitoringState", () => {
  const data = makePegMonitoringResponse();
  const at = PEG_FIXTURE_PRODUCED_AT * 1000;
  it("transitions loading, current, stale retained, unavailable, and recovery", () => {
    expect(
      classifyPegMonitoringState({
        data: null,
        hasError: false,
        isLoading: true,
        nowMs: at,
      }).kind,
    ).toBe("loading");
    expect(
      classifyPegMonitoringState({
        data,
        hasError: false,
        isLoading: false,
        nowMs: at,
      }).kind,
    ).toBe("current");
    expect(
      classifyPegMonitoringState({
        data,
        hasError: true,
        isLoading: false,
        nowMs: at,
      }).kind,
    ).toBe("stale");
    expect(
      classifyPegMonitoringState({
        data: null,
        hasError: true,
        isLoading: false,
        nowMs: at,
      }).kind,
    ).toBe("unavailable");
    expect(
      classifyPegMonitoringState({
        data,
        hasError: false,
        isLoading: false,
        nowMs: at,
      }).kind,
    ).toBe("current");
  });
  it("marks age and a future producer clock stale", () => {
    expect(
      classifyPegMonitoringState({
        data,
        hasError: false,
        isLoading: false,
        nowMs: at + PEG_MONITORING_STALE_AFTER_MS + 1,
      }),
    ).toMatchObject({ kind: "stale", reason: "age" });
    expect(
      classifyPegMonitoringState({
        data,
        hasError: false,
        isLoading: false,
        nowMs: at - 60001,
      }),
    ).toMatchObject({ kind: "stale", reason: "clock-skew" });
  });
});
