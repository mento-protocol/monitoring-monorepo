import { describe, it, expect, beforeEach } from "vitest";
import { register, updateMetrics } from "../src/metrics.js";
import { handleRequest, markHealthy } from "../src/server.js";
import {
  _resetPegDecisionPackagesForTests,
  commitPegDecisionPackages,
  type PegDecisionPackages,
} from "../src/peg/decision-packages.js";
import { makePool, tick } from "./fixtures.js";

function makeRes() {
  let _status = 0;
  let _body = "";
  let _headers: Record<string, string> = {};
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      _status = status;
      if (headers) _headers = headers;
    },
    end(body: string) {
      _body = body;
    },
    get status() {
      return _status;
    },
    get body() {
      return _body;
    },
    get headers() {
      return _headers;
    },
  };
}

describe("handleRequest", () => {
  beforeEach(() => {
    register.resetMetrics();
    _resetPegDecisionPackagesForTests();
  });

  it("GET /metrics returns 200 with Prometheus content type", async () => {
    const res = makeRes();
    handleRequest({ url: "/metrics", method: "GET" }, res);
    await tick();
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/plain");
  });

  it("GET /metrics contains expected gauge names after update", async () => {
    updateMetrics([makePool()]);
    const res = makeRes();
    handleRequest({ url: "/metrics", method: "GET" }, res);
    await tick();
    expect(res.body).toContain("mento_pool_oracle_ok");
    expect(res.body).toContain("mento_pool_deviation_ratio");
    expect(res.body).toContain("mento_pool_limit_pressure");
    expect(res.body).toContain("mento_pool_health_status");
  });

  it("GET /metrics strips query params", async () => {
    const res = makeRes();
    handleRequest({ url: "/metrics?ts=123", method: "GET" }, res);
    await tick();
    expect(res.status).toBe(200);
  });

  it("GET /metrics returns generic error on failure", async () => {
    const origMetrics = register.metrics.bind(register);
    register.metrics = () => Promise.reject(new Error("boom"));

    const res = makeRes();
    handleRequest({ url: "/metrics", method: "GET" }, res);
    await tick();

    expect(res.status).toBe(500);
    expect(res.body).toBe("internal error");
    expect(res.body).not.toContain("boom");

    register.metrics = origMetrics;
  });

  it("GET /health returns 200 after markHealthy", () => {
    markHealthy();
    const res = makeRes();
    handleRequest({ url: "/health", method: "GET" }, res);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("GET /health strips query params", () => {
    markHealthy();
    const res = makeRes();
    handleRequest({ url: "/health?ts=1", method: "GET" }, res);
    expect(res.status).toBe(200);
  });

  it("keeps peg decision-package unavailability isolated from health", () => {
    markHealthy();
    const decision = makeRes();
    handleRequest({ url: "/peg/decision-packages", method: "GET" }, decision);
    expect(decision.status).toBe(503);
    expect(decision.headers).toEqual({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    const health = makeRes();
    handleRequest({ url: "/health", method: "GET" }, health);
    expect(health.status).toBe(200);
  });

  it("serves the last atomically committed peg decision-package body", () => {
    const model = {
      schemaVersion: 1,
      approvedActivePolicyVersion: "active-v1",
      producedPolicyVersion: "active-v1",
      policySlot: "active",
      producedAt: 1_800_000_000,
      rolloverAckExpectedSeconds: 300,
      packages: [
        {
          asset: "asset-one",
          peg: "EUR",
          coverageClass: "cex-book+indexed-pool",
          tokenRefs: [
            {
              chainId: 137,
              address: "0x1111111111111111111111111111111111111111",
            },
          ],
          policy: {
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
          },
          structural: {
            blind: true,
            blindConsecutivePolls: 3,
            structuralSaturation: null,
            structuralQuerySaturated: false,
            indexedPoolReachable: false,
            counterpartyCount: 0,
          },
          monitors: [
            {
              chainId: 137,
              poolAddress: "0x2222222222222222222222222222222222222222",
              rateFeedId: "0x3333333333333333333333333333333333333333",
              monitoredTokenAddress:
                "0x1111111111111111111111111111111111111111",
              indexedPoolReachable: false,
              structuralSaturation: null,
              structuralQuerySaturated: false,
              counterpartyCount: 0,
              breaker: null,
            },
          ],
          sources: [
            {
              id: "deep_eur",
              provider: "bitvavo",
              pair: "PEG-EUR",
              baseCurrency: "PEG",
              quoteCurrency: "EUR",
              registryRole: "primary",
              authority: "deep",
              convertVia: null,
              policy: {
                referenceSizeCap: 50,
                pollIntervalSeconds: 30,
                staleAfterSeconds: 60,
                spreadEnvelopeBps: 50,
                conversionErrorBps: 0,
              },
              listingState: null,
              listingCheckedAt: null,
              healthy: false,
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
            },
          ],
        },
      ],
    } satisfies PegDecisionPackages;
    const json = JSON.stringify(model);
    commitPegDecisionPackages({ model, json });
    const res = makeRes();
    handleRequest(
      { url: "/peg/decision-packages?latest=1", method: "GET" },
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe(json);
  });

  it("unknown path returns 404", () => {
    const res = makeRes();
    handleRequest({ url: "/unknown", method: "GET" }, res);
    expect(res.status).toBe(404);
  });

  it("POST /metrics returns 404", () => {
    const res = makeRes();
    handleRequest({ url: "/metrics", method: "POST" }, res);
    expect(res.status).toBe(404);
  });
});
