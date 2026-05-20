import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

const TX_HASH =
  "0xafcd83c3b46adf004aa602ac8cb8ef2b14a25eae5802c0cd2b4c42b75cb26799";

function makeRequest(
  searchParams: Record<string, string> = {
    txHash: TX_HASH,
    destChainId: "42220",
    tokenSymbol: "USDm",
  },
): NextRequest {
  const url = new URL("http://localhost/api/bridge-redeem");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function mockWormholeResponse(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GET /api/bridge-redeem", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid txHash before calling Wormholescan", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await GET(
      makeRequest({
        txHash: "0x1234",
        destChainId: "42220",
        tokenSymbol: "USDm",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Expected a 32-byte hex txHash.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported destination chains", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await GET(
      makeRequest({
        txHash: TX_HASH,
        destChainId: "999999",
        tokenSymbol: "USDm",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unsupported destination chain: 999999.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown token symbols", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const res = await GET(
      makeRequest({
        txHash: TX_HASH,
        destChainId: "42220",
        tokenSymbol: "UNKNOWN",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unknown token symbol: UNKNOWN.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when Wormholescan rejects the lookup", async () => {
    mockWormholeResponse({ error: "upstream" }, 503);

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Wormholescan lookup failed with status 503.",
    });
  });

  it("returns 502 when Wormholescan returns malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Wormholescan returned an invalid response.",
    });
  });

  it("returns 404 when Wormholescan has no operation for the tx", async () => {
    mockWormholeResponse({ operations: [] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No Wormhole VAA found for this source transaction.",
    });
  });

  it("returns 404 when the operation has no raw VAA", async () => {
    mockWormholeResponse({ operations: [{ vaa: {} }] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No Wormhole VAA found for this source transaction.",
    });
  });

  it("rejects transactions with multiple Wormhole operations", async () => {
    mockWormholeResponse({
      operations: [{ vaa: { raw: "AQID" } }, { vaa: { raw: "BAUG" } }],
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Multiple Wormhole messages found for this transaction; manual redemption is not supported for batch transfers.",
    });
  });

  it("returns 502 when Wormholescan returns an invalid VAA encoding", async () => {
    mockWormholeResponse({ operations: [{ vaa: { raw: "%%%" } }] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Wormholescan returned an invalid VAA.",
    });
  });

  it("returns the redeem payload for a single valid Wormhole operation", async () => {
    mockWormholeResponse({ operations: [{ vaa: { raw: "AQID" } }] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      chainId: 42220,
      chainIdHex: "0xa4ec",
      chainName: "Celo",
      rpcUrl: "https://forno.celo.org",
      explorerUrl: "https://celoscan.io",
      nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
      vaaHex: "0x010203",
    });
  });
});
