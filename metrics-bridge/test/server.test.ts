import { describe, it, expect, beforeEach } from "vitest";
import { register, updateMetrics } from "../src/metrics.js";
import { handleRequest, markHealthy } from "../src/server.js";
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

  it("GET /healthz returns 200 after markHealthy", () => {
    markHealthy();
    const res = makeRes();
    handleRequest({ url: "/healthz", method: "GET" }, res);
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("GET /healthz strips query params", () => {
    markHealthy();
    const res = makeRes();
    handleRequest({ url: "/healthz?ts=1", method: "GET" }, res);
    expect(res.status).toBe(200);
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
