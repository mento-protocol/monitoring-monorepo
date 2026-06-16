import http, { get as namedHttpGet } from "node:http";
import { describe, expect, it } from "vitest";

import { waitForHttpTestRpc } from "../src/rpc/http-test-mocks.js";

describe("hermetic test guard", () => {
  it("publishes loopback RPC URLs before tests run", () => {
    expect(process.env.ENVIO_RPC_URL_42220).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/42220$/,
    );
    expect(process.env.ENVIO_RPC_URL_1).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/1$/,
    );
    expect(process.env.ENVIO_RPC_FALLBACK_URL_42220).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/42220$/,
    );
    expect(process.env.ENVIO_RPC_FALLBACK_URL_1).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/1$/,
    );
  });

  it("rejects outbound fetch requests to non-loopback hosts without leaking paths", async () => {
    const error = await fetch("https://forno.celo.org/rpc/secret-token").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "[hermetic-test-guard] Blocked outbound request to https://forno.celo.org.",
    );
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("rejects slash-less absolute HTTP fetch URLs without parsing them against loopback", async () => {
    const error = await fetch(
      "http:metadata.google.internal/computeMetadata/v1/secret-token",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("rejects outbound Node HTTP clients to non-loopback hosts", () => {
    expect(() =>
      http.get(
        "http://metadata.google.internal/computeMetadata/v1/secret-token",
      ),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
  });

  it("rejects outbound Node HTTP named imports to non-loopback hosts", () => {
    expect(() =>
      namedHttpGet(
        "http://metadata.google.internal/computeMetadata/v1/secret-token",
      ),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
  });

  it("rejects Node HTTP options whose hostname is non-loopback even when path looks loopback", () => {
    expect(() =>
      http.request({
        hostname: "metadata.google.internal",
        path: "http://127.0.0.1/computeMetadata/v1/secret-token",
      }),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
  });

  it("rejects Node HTTP options whose absolute path names a non-loopback host", () => {
    expect(() =>
      http.request({
        path: "http://metadata.google.internal/computeMetadata/v1/secret-token",
      }),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
  });

  it("rejects Node HTTP options using hostname over a loopback host alias", () => {
    expect(() =>
      http.request({
        host: "127.0.0.1",
        hostname: "metadata.google.internal",
      }),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
    );
  });

  it("rejects outbound Node HTTP clients even when request options are invalid", () => {
    expect(() =>
      http.get("http://metadata.google.internal/computeMetadata/v1", {
        path: "http://[",
      }),
    ).toThrow(
      "[hermetic-test-guard] Blocked outbound request to http://metadata.google.internal.",
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
