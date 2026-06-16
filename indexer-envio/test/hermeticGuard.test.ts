import { describe, expect, it } from "vitest";

import { waitForHttpTestRpc } from "../src/rpc/http-test-mocks.js";

describe("hermetic test guard", () => {
  it("publishes loopback RPC URLs before tests run", () => {
    expect(process.env.ENVIO_RPC_URL_42220).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/42220$/,
    );
    expect(process.env.ENVIO_RPC_FALLBACK_URL_42220).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/42220$/,
    );
  });

  it("rejects outbound requests to non-loopback hosts", async () => {
    await expect(fetch("https://forno.celo.org")).rejects.toThrow(
      "[hermetic-test-guard]",
    );
  });

  it("allows loopback requests to the local test RPC", async () => {
    await waitForHttpTestRpc();
    const res = await fetch(String(process.env.ENVIO_RPC_URL_42220), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
    });
    const payload = (await res.json()) as { result: string };
    expect(payload.result).toBe("0xa4ec"); // 42220
  });
});
