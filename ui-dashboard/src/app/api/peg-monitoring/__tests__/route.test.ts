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
    const expectInvalidOrigin = async (origin: string) => {
      vi.stubEnv("METRICS_BRIDGE_URL", origin);
      expect((await GET()).status).toBe(503);
    };
    await expectInvalidOrigin("");
    await expectInvalidOrigin("http://remote.example");
    const credentialedOrigin = new URL("https://bridge.example");
    credentialedOrigin.username = "test-user";
    credentialedOrigin.password = "test-pass";
    await expectInvalidOrigin(credentialedOrigin.href);
    await expectInvalidOrigin("https://bridge.example/x");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("METRICS_BRIDGE_URL", "https://metrics-bridge.example");
    fetchMock.mockRejectedValueOnce(new DOMException("secret", "TimeoutError"));
    expect((await GET()).status).toBe(504);
  });
  it("fails closed for oversized, non-json, malformed, and invalid topology bodies", async () => {
    const response = makePegMonitoringResponse();
    const item = response.packages[0]!;
    const source = item.sources[0]!;
    const monitor = item.monitors[0]!;
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
      )
      .mockResolvedValueOnce(
        json({
          ...response,
          packages: [
            {
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
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          ...response,
          packages: [
            {
              ...item,
              policy: { ...item.policy, freshnessGraceSeconds: 60 },
            },
          ],
        }),
      );
    const oversized = await GET();
    expect(oversized.status).toBe(502);
    expect(await oversized.json()).toEqual({
      error: "Peg monitoring upstream response is invalid",
      failureClass: "invalid-payload",
    });
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
  });
  it("classifies timeout and network failures without forwarding details", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(
      new DOMException("request timed out", "TimeoutError"),
    );
    const timeout = await GET();
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toEqual({
      error: "Peg monitoring upstream timed out",
      failureClass: "timeout",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("connection failed"));
    const network = await GET();
    expect(network.status).toBe(502);
    expect(await network.json()).toEqual({
      error: "Peg monitoring upstream request failed",
      failureClass: "network",
    });
  });
  it("keeps a response-body stream timeout distinct from invalid payloads", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("body stalled", "TimeoutError"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await GET();
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Peg monitoring upstream timed out",
      failureClass: "timeout",
    });
  });
  it("keeps a response-body stream failure distinct from invalid payloads", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("body connection failed"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Peg monitoring upstream request failed",
      failureClass: "network",
    });
  });
  it.each([
    [429, 502, "upstream-rate-limit"],
    [503, 503, "upstream-unavailable"],
    [418, 502, "upstream-http"],
  ])(
    "preserves upstream HTTP %i as %s with %s metadata",
    async (upstreamStatus, localStatus, failureClass) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        json({ ignored: "body" }, { status: upstreamStatus }),
      );
      const response = await GET();
      expect(response.status).toBe(localStatus);
      expect(await response.json()).toMatchObject({
        failureClass,
        upstreamStatus,
      });
    },
  );
  it("classifies missing configuration without starting a request", async () => {
    vi.stubEnv("METRICS_BRIDGE_URL", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Peg monitoring upstream is not configured",
      failureClass: "configuration",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
