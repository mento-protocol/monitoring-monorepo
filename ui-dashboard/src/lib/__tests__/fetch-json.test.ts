import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FetchJsonError,
  fetchJsonOr404,
  fetchJsonOrThrow,
} from "@/lib/fetch-json";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJsonOrThrow", () => {
  it("uses a default timeout below the shortest polling cadence", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await fetchJsonOrThrow("http://test/api", "test");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(timeoutSpy.mock.calls[0]?.[0]).toBeLessThan(30_000);
  });

  it("honors caller timeout overrides", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await fetchJsonOrThrow("http://test/api", "test", { timeoutMs: 12_345 });
    expect(timeoutSpy).toHaveBeenCalledWith(12_345);
  });

  it("returns parsed JSON on a 2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await fetchJsonOrThrow<{ ok: boolean }>(
      "http://test/api",
      "test",
    );
    expect(result).toEqual({ ok: true });
  });

  it("throws with the error message from a non-2xx response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    await expect(fetchJsonOrThrow("http://test/api", "test")).rejects.toThrow(
      "Not found",
    );
  });

  it("throws a generic message when non-2xx has no JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    await expect(
      fetchJsonOrThrow("http://test/api", "test label"),
    ).rejects.toThrow("test label failed (HTTP 500)");
  });

  it("preserves safe route and upstream failure metadata", async () => {
    const urlWithPrivateParts = new URL(
      "https://example.com/api/peg-monitoring?view=details#fragment",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Peg monitoring upstream unavailable",
          failureClass: "upstream-rate-limit",
          upstreamStatus: 429,
        }),
        { status: 502 },
      ),
    );
    await expect(
      fetchJsonOrThrow(urlWithPrivateParts.href, "Peg monitoring"),
    ).rejects.toMatchObject({
      failureClass: "upstream-rate-limit",
      message: "Peg monitoring upstream unavailable",
      name: "FetchJsonError",
      requestPath: "/api/peg-monitoring",
      status: 502,
      upstreamStatus: 429,
    } satisfies Partial<FetchJsonError>);
  });

  it("rejects untrusted error metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Bad gateway",
          failureClass: "unknown-category",
          upstreamStatus: 999,
        }),
        { status: 502 },
      ),
    );
    await expect(
      fetchJsonOrThrow("/api/peg-monitoring", "Peg monitoring"),
    ).rejects.toMatchObject({
      failureClass: "http",
      requestPath: "/api/peg-monitoring",
      status: 502,
      upstreamStatus: null,
    } satisfies Partial<FetchJsonError>);
  });

  it.each([
    ["TimeoutError", "timeout"],
    ["TypeError", "network"],
  ])("classifies rejected %s fetches as %s", async (name, failureClass) => {
    const error = new Error("request failed");
    error.name = name;
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error);
    await expect(
      fetchJsonOrThrow("/api/peg-monitoring", "Peg monitoring"),
    ).rejects.toMatchObject({
      failureClass,
      message:
        failureClass === "timeout"
          ? "Peg monitoring request timed out"
          : "Peg monitoring request failed",
      requestPath: "/api/peg-monitoring",
      status: null,
      upstreamStatus: null,
    });
  });

  it("classifies invalid successful JSON without retaining its body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not-json", { status: 200 }),
    );
    await expect(
      fetchJsonOrThrow("/api/peg-monitoring?view=details", "Peg monitoring"),
    ).rejects.toMatchObject({
      failureClass: "invalid-payload",
      message: "Peg monitoring returned invalid JSON",
      requestPath: "/api/peg-monitoring",
      status: 200,
    } satisfies Partial<FetchJsonError>);
  });

  it.each([
    [200, "TimeoutError", "timeout"],
    [502, "TimeoutError", "timeout"],
    [200, "TypeError", "network"],
    [502, "TypeError", "network"],
  ])(
    "classifies HTTP %i body-read %s failures as %s",
    async (status, errorName, failureClass) => {
      const body = new ReadableStream({
        pull(controller) {
          controller.error(
            errorName === "TimeoutError"
              ? new DOMException("body stalled", "TimeoutError")
              : new TypeError("body connection failed"),
          );
        },
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(body, { status }),
      );
      await expect(
        fetchJsonOrThrow("/api/peg-monitoring", "Peg monitoring"),
      ).rejects.toMatchObject({
        failureClass,
        message:
          failureClass === "timeout"
            ? "Peg monitoring request timed out"
            : "Peg monitoring request failed",
        requestPath: "/api/peg-monitoring",
        status,
      });
    },
  );
});

describe("fetchJsonOr404", () => {
  it("uses the same below-cadence default timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    await fetchJsonOr404("http://test/api", "test");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(timeoutSpy.mock.calls[0]?.[0]).toBeLessThan(30_000);
  });
});
