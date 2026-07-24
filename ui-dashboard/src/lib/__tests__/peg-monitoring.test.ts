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
    expect(parsed.packages[0]?.policy.blindConsecutivePolls).toBe(3);
  });
  it("rejects topology holes, policy-slot drift, unpaired listing evidence, and bad uint256", () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
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
          { ...item, sources: [{ ...source, listingCheckedAt: null }] },
        ],
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
