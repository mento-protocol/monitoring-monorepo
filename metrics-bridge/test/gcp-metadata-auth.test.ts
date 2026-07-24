import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GCP_METADATA_TOKEN_URL,
  GcpMetadataBearerTokenProvider,
  parsePinnedGcsJsonMediaUrl,
} from "../src/peg/gcp-metadata-auth.js";
import type { FetchLike } from "../src/peg/types.js";

const POLICY_URL =
  "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1750000000000000";

function tokenResponse(
  accessToken = "test-token",
  expiresIn = 3_600,
  tokenType = "Bearer",
): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: expiresIn,
      token_type: tokenType,
    }),
  );
}

function trackedResponse(status: number): {
  cancel: ReturnType<typeof vi.fn>;
  response: Response;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("metadata unavailable"));
    },
    cancel,
  });
  return { cancel, response: new Response(body, { status }) };
}

describe("parsePinnedGcsJsonMediaUrl", () => {
  it.each([
    POLICY_URL,
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fversions%2Feurop-v1.json?alt=media&generation=1750000000000000",
  ])("accepts an exact generation-pinned GCS media URL: %s", (raw) => {
    expect(parsePinnedGcsJsonMediaUrl(raw).href).toBe(raw);
  });

  it.each([
    "http://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com.attacker.invalid/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://attacker.invalid/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com./download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://user@storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com:443/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy/current.json?alt=media&generation=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2fcurrent.json?alt=media&generation=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/%00?alt=media&generation=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=0",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=01",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=9223372036854775808",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?generation=1&alt=media",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1&x=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&alt=media&generation=1",
    "https://storage.googleapis.com/download/storage/v1/b/mento-monitoring-peg-policy/o/peg-policy%2Fcurrent.json?alt=media&generation=1#fragment",
  ])("rejects a confused or mutable policy URL before auth: %s", (raw) => {
    expect(() => parsePinnedGcsJsonMediaUrl(raw)).toThrow(
      /invalid pinned GCS policy URL/,
    );
  });
});

describe("GcpMetadataBearerTokenProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses only the metadata header and caches outside the expiry skew", async () => {
    let now = 1_000;
    const fetch = vi.fn<FetchLike>().mockResolvedValue(tokenResponse());
    const provider = new GcpMetadataBearerTokenProvider({
      fetch,
      now: () => now,
    });
    const policyUrl = parsePinnedGcsJsonMediaUrl(POLICY_URL);

    await expect(provider.getToken(policyUrl)).resolves.toBe("test-token");
    now += 3_000_000;
    await expect(provider.getToken(policyUrl)).resolves.toBe("test-token");

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(GCP_METADATA_TOKEN_URL);
    const request = fetch.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Metadata-Flavor")).toBe("Google");
    expect(new Headers(request?.headers).get("authorization")).toBeNull();
    expect(request?.redirect).toBe("error");
  });

  it("refreshes inside the safe expiry skew", async () => {
    let now = 0;
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-a", 120))
      .mockResolvedValueOnce(tokenResponse("token-b", 120));
    const provider = new GcpMetadataBearerTokenProvider({
      fetch,
      now: () => now,
    });
    const policyUrl = parsePinnedGcsJsonMediaUrl(POLICY_URL);

    await expect(provider.getToken(policyUrl)).resolves.toBe("token-a");
    now = 61_000;
    await expect(provider.getToken(policyUrl)).resolves.toBe("token-b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 0, 30_000.5, 30_001, Number.POSITIVE_INFINITY])(
    "rejects an unsafe injected timeout: %s",
    (timeoutMs) => {
      expect(() => new GcpMetadataBearerTokenProvider({ timeoutMs })).toThrow(
        /timeout must be a safe integer/,
      );
    },
  );

  it.each([-1, 60_000.5, 86_400_001, Number.POSITIVE_INFINITY])(
    "rejects an unsafe injected refresh skew: %s",
    (refreshSkewMs) => {
      expect(
        () => new GcpMetadataBearerTokenProvider({ refreshSkewMs }),
      ).toThrow(/refresh skew must be a safe integer/);
    },
  );

  it("accepts zero skew without reusing an expired token", async () => {
    let now = 0;
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(tokenResponse("token-a", 1))
      .mockResolvedValueOnce(tokenResponse("token-b", 1));
    const provider = new GcpMetadataBearerTokenProvider({
      fetch,
      now: () => now,
      refreshSkewMs: 0,
    });
    const policyUrl = parsePinnedGcsJsonMediaUrl(POLICY_URL);

    await expect(provider.getToken(policyUrl)).resolves.toBe("token-a");
    now = 1_000;
    await expect(provider.getToken(policyUrl)).resolves.toBe("token-b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not-json", "not valid JSON"],
    [JSON.stringify([]), "invalid shape"],
    [
      JSON.stringify({
        access_token: "test-token",
        expires_in: 3_600,
        token_type: "Bearer",
        unexpected: true,
      }),
      "invalid shape",
    ],
    [
      JSON.stringify({
        access_token: "test token",
        expires_in: 3_600,
        token_type: "Bearer",
      }),
      "invalid access token",
    ],
    [
      JSON.stringify({
        access_token: "test-token",
        expires_in: 3_600,
        token_type: "MAC",
      }),
      "invalid token type",
    ],
    [
      JSON.stringify({
        access_token: "test-token",
        expires_in: 0,
        token_type: "Bearer",
      }),
      "invalid lifetime",
    ],
    [
      JSON.stringify({
        access_token: "test-token",
        expires_in: 3_600.5,
        token_type: "Bearer",
      }),
      "invalid lifetime",
    ],
    [
      JSON.stringify({
        access_token: "test-token",
        expires_in: 86_401,
        token_type: "Bearer",
      }),
      "invalid lifetime",
    ],
  ])(
    "fails closed on invalid token response schema",
    async (body, expected) => {
      const provider = new GcpMetadataBearerTokenProvider({
        fetch: vi.fn().mockResolvedValue(new Response(body)),
      });

      await expect(
        provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL)),
      ).rejects.toThrow(expected);
    },
  );

  it("never includes a malformed token value in its error", async () => {
    const invalidToken = "secret token";
    const provider = new GcpMetadataBearerTokenProvider({
      fetch: vi.fn().mockResolvedValue(tokenResponse(invalidToken)),
    });

    const error = await provider
      .getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(invalidToken);
  });

  it("rejects an unsafe local clock before requesting metadata", async () => {
    const fetch = vi.fn();
    const provider = new GcpMetadataBearerTokenProvider({
      fetch,
      now: () => Number.MAX_SAFE_INTEGER,
    });

    await expect(
      provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL)),
    ).rejects.toThrow(/clock is invalid/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a non-success metadata response before throwing", async () => {
    const unavailable = trackedResponse(503);
    const provider = new GcpMetadataBearerTokenProvider({
      fetch: vi.fn().mockResolvedValue(unavailable.response),
    });

    await expect(
      provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL)),
    ).rejects.toThrow(/HTTP 503/);
    expect(unavailable.cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized response before parsing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const provider = new GcpMetadataBearerTokenProvider({
      fetch: vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { "content-length": String(20 * 1024) },
        }),
      ),
    });

    await expect(
      provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL)),
    ).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a streaming response when it crosses the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12 * 1024));
        controller.enqueue(new Uint8Array(5 * 1024));
      },
      cancel,
    });
    const provider = new GcpMetadataBearerTokenProvider({
      fetch: vi.fn().mockResolvedValue(new Response(body)),
    });

    await expect(
      provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL)),
    ).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts while a metadata response body is stalled", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected metadata abort signal");
      observedSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body);
    });
    const provider = new GcpMetadataBearerTokenProvider({
      fetch,
      timeoutMs: 25,
    });

    const pending = provider.getToken(parsePinnedGcsJsonMediaUrl(POLICY_URL));
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects an unpinned target before requesting metadata", async () => {
    const fetch = vi.fn();
    const provider = new GcpMetadataBearerTokenProvider({ fetch });

    await expect(
      provider.getToken(
        new URL(
          "https://attacker.invalid/download/storage/v1/b/bucket/o/current.json?alt=media&generation=1",
        ),
      ),
    ).rejects.toThrow(/generation-pinned GCS JSON media URL/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
