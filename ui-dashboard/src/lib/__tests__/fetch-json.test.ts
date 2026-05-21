import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchJsonOrThrow } from "@/lib/fetch-json";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJsonOrThrow", () => {
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
