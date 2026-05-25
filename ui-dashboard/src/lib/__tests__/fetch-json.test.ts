import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchJsonOr404, fetchJsonOrThrow } from "@/lib/fetch-json";

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
