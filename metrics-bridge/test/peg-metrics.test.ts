import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "../src/metrics.js";
import {
  _resetPegMetricsForTests,
  pegCounters,
  publishPegMetrics,
  type PegAssetMetricSnapshot,
} from "../src/peg/metrics.js";

function snapshot(
  overrides: Partial<PegAssetMetricSnapshot> = {},
): PegAssetMetricSnapshot {
  return {
    asset: "europ-schuman",
    policyVersion: "europ-v1",
    lastPollAt: 1_784_734_422,
    blind: false,
    structuralSaturation: 0.25,
    structuralQuerySaturated: false,
    indexedPoolReachable: true,
    counterpartyCount: 3,
    sources: [
      {
        asset: "europ-schuman",
        source: "bitvavo_eur",
        policyVersion: "europ-v1",
        healthy: true,
        referenceSize: 50_000,
        deviationBps: 4,
        premiumBps: 0,
        spreadBps: 9,
        newSuccess: true,
        observation: {
          vwap: 0.9996,
          filledFraction: 1,
          capped: false,
          bid: 0.9997,
          ask: 1.0006,
          lastTradeAt: 1_784_734_400_000,
          fetchedAt: 1_784_734_422_000,
          observationAt: 1_784_734_421_000,
          sequence: "1265841",
          venueState: "ok",
        },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => _resetPegMetricsForTests());
afterEach(() => _resetPegMetricsForTests());

describe("Peg metrics", () => {
  it("publishes peg-loop failures through a bounded error channel", async () => {
    pegCounters.pollErrors.inc({ kind: "source_fetch" });

    expect(await register.metrics()).toContain(
      'mento_peg_poll_errors_total{kind="source_fetch"} 1',
    );
  });

  it("publishes version-bound decision and liveness series", async () => {
    publishPegMetrics([snapshot()]);
    const metrics = await register.metrics();

    expect(metrics).toContain(
      'mento_peg_deviation_bps{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 4',
    );
    expect(metrics).toContain(
      'mento_peg_venue_state{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1",state="ok"} 1',
    );
    expect(metrics).toContain(
      'mento_peg_policy_version{policy_version="europ-v1"} 1',
    );
    expect(metrics).toContain(
      'mento_peg_poll_success_total{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 1',
    );
  });

  it("drops deviation for capped observations but retains partial depth", async () => {
    const capped = snapshot();
    const source = capped.sources[0];
    if (!source?.observation) throw new Error("missing fixture observation");
    source.deviationBps = null;
    source.observation = {
      ...source.observation,
      capped: true,
      filledFraction: 0.4,
    };
    publishPegMetrics([capped]);
    const metrics = await register.metrics();

    expect(metrics).not.toContain("mento_peg_deviation_bps{");
    expect(metrics).toContain(
      'mento_peg_capped{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 1',
    );
    expect(metrics).toContain(
      'mento_peg_filled_fraction{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 0.4',
    );
  });

  it("evicts failed-source observations while keeping explicit unhealthy state", async () => {
    publishPegMetrics([snapshot()]);
    const failed = snapshot();
    const source = failed.sources[0];
    if (!source) throw new Error("missing fixture source");
    source.healthy = false;
    source.observation = null;
    source.deviationBps = null;
    source.premiumBps = null;
    source.spreadBps = null;
    source.newSuccess = false;
    publishPegMetrics([failed]);
    const metrics = await register.metrics();

    expect(metrics).toContain(
      'mento_peg_source_healthy{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 0',
    );
    expect(metrics).not.toContain("mento_peg_executable_px{");
    expect(metrics).not.toContain("mento_peg_observation_at{");
  });

  it("publishes a status-only halt without advancing executable freshness", async () => {
    publishPegMetrics([snapshot()]);
    const halted = snapshot({ blind: true });
    const source = halted.sources[0];
    if (!source?.observation) throw new Error("missing fixture observation");
    source.healthy = false;
    source.deviationBps = null;
    source.premiumBps = null;
    source.spreadBps = null;
    source.newSuccess = false;
    source.observation = {
      ...source.observation,
      vwap: null,
      filledFraction: 0,
      capped: true,
      bid: null,
      ask: null,
      lastTradeAt: null,
      observationAt: null,
      sequence: null,
      venueState: "halted",
    };

    publishPegMetrics([halted]);
    const metrics = await register.metrics();

    expect(metrics).toContain(
      'mento_peg_source_healthy{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 0',
    );
    expect(metrics).toContain(
      'mento_peg_venue_state{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1",state="halted"} 1',
    );
    expect(metrics).toContain(
      'mento_peg_poll_success_total{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 1',
    );
    expect(metrics).not.toContain("mento_peg_observation_at{");
    expect(metrics).not.toContain("mento_peg_executable_px{");
  });

  it("keeps success counters monotonic across gauge refreshes", async () => {
    publishPegMetrics([snapshot()]);
    publishPegMetrics([snapshot()]);
    const metrics = await register.metrics();
    expect(metrics).toContain(
      'mento_peg_poll_success_total{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v1"} 2',
    );
  });

  it("removes counters from superseded policy versions", async () => {
    publishPegMetrics([snapshot()]);
    const next = snapshot({ policyVersion: "europ-v2" });
    next.sources = next.sources.map((source) => ({
      ...source,
      policyVersion: "europ-v2",
    }));
    publishPegMetrics([next]);

    const metrics = await register.metrics();
    expect(metrics).not.toContain('policy_version="europ-v1"');
    expect(metrics).toContain(
      'mento_peg_poll_success_total{asset="europ-schuman",source="bitvavo_eur",policy_version="europ-v2"} 1',
    );
  });

  it("validates an entire snapshot before clearing last-good gauges", async () => {
    publishPegMetrics([snapshot()]);
    const invalid = snapshot({ structuralSaturation: Number.NaN });
    expect(() => publishPegMetrics([invalid])).toThrow(/structuralSaturation/);

    expect(await register.metrics()).toContain(
      'mento_peg_structural_saturation{asset="europ-schuman",policy_version="europ-v1"} 0.25',
    );
  });
});
