import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/hasura/devnet", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/hasura/[networkId]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 404 for unsupported networks", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ query: "{ __typename }" });
    const res = await POST(req, {
      params: Promise.resolve({ networkId: "celo-mainnet" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unsupported network" });
  });

  it("adds x-hasura-admin-secret for local network when configured", async () => {
    vi.stubEnv("HASURA_SECRET_DEVNET", "testing");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const { POST } = await import("../route");

    const req = makeRequest({ query: "{ __typename }" });
    const res = await POST(req, {
      params: Promise.resolve({ networkId: "devnet" }),
    });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hasura-admin-secret")).toBe("testing");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("omits x-hasura-admin-secret when local secret is unset", async () => {
    vi.stubEnv("HASURA_SECRET_DEVNET", "");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })));
    const { POST } = await import("../route");

    const req = makeRequest({ query: "{ __typename }" });
    await POST(req, {
      params: Promise.resolve({ networkId: "devnet" }),
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hasura-admin-secret")).toBeNull();
  });

  it("returns 502 when upstream request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    const { POST } = await import("../route");

    const req = makeRequest({ query: "{ __typename }" });
    const res = await POST(req, {
      params: Promise.resolve({ networkId: "devnet" }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Local Hasura upstream unavailable",
    });
  });
});
