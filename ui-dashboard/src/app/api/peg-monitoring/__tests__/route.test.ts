import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  PEG_MONITORING_MAX_RESPONSE_BYTES,
  PEG_MONITORING_UPSTREAM_TIMEOUT_MS,
} from "../route";
import { makePegMonitoringResponse } from "@/test-utils/peg-monitoring-fixture";
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("METRICS_BRIDGE_URL", "https://metrics-bridge.example");
});
describe("GET /api/peg-monitoring", () => {
  it("uses the exact no-store unauthenticated endpoint under the polling deadline", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(makePegMonitoringResponse()));
    const response = await GET();
    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://metrics-bridge.example/peg/decision-packages",
    );
    expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(PEG_MONITORING_UPSTREAM_TIMEOUT_MS).toBeLessThan(30000);
  });
  it("rejects insecure, credentialed, path-bearing origins and maps start/timeout failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const origin of [
      "",
      "http://remote.example",
      "https://user:x@bridge.example",
      "https://bridge.example/x",
    ]) {
      vi.stubEnv("METRICS_BRIDGE_URL", origin);
      expect((await GET()).status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("METRICS_BRIDGE_URL", "https://metrics-bridge.example");
    fetchMock.mockRejectedValueOnce(new DOMException("secret", "TimeoutError"));
    expect((await GET()).status).toBe(504);
  });
  it("fails closed for oversized, non-json, malformed, and schema-drift bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(PEG_MONITORING_MAX_RESPONSE_BYTES + 1),
          },
        }),
      )
      .mockResolvedValueOnce(new Response("no"))
      .mockResolvedValueOnce(
        new Response("{", { headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        json({ ...makePegMonitoringResponse(), schemaVersion: 2 }),
      );
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
  });
});
