import { ClientError } from "graphql-request";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitAwareRetry, retryAfterMs } from "@/lib/gql-retry";

function makeClientError(status: number, retryAfter?: string): ClientError {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new ClientError(
    { status, headers, body: "", errors: undefined, data: undefined },
    { query: "{ __typename }" },
  );
}

describe("retryAfterMs", () => {
  it("returns null for non-ClientError exceptions", () => {
    expect(retryAfterMs(new Error("network"))).toBeNull();
    expect(retryAfterMs("oops")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it("returns null for non-429 ClientError", () => {
    expect(retryAfterMs(makeClientError(500, "10"))).toBeNull();
    expect(retryAfterMs(makeClientError(403))).toBeNull();
  });

  it("returns the 60s floor when no retry-after header is present", () => {
    expect(retryAfterMs(makeClientError(429))).toBe(60_000);
  });

  it("floors tiny numeric retry-after values at 60s", () => {
    // Envio or a misbehaving upstream could return Retry-After: 0.001 which
    // would spin-loop the client if we honored it literally.
    expect(retryAfterMs(makeClientError(429, "0.001"))).toBe(60_000);
    expect(retryAfterMs(makeClientError(429, "1"))).toBe(60_000);
  });

  it("honors numeric retry-after values in the allowed range", () => {
    expect(retryAfterMs(makeClientError(429, "90"))).toBe(90_000);
    expect(retryAfterMs(makeClientError(429, "240"))).toBe(240_000);
  });

  it("caps numeric retry-after at 5 minutes", () => {
    expect(retryAfterMs(makeClientError(429, "3600"))).toBe(300_000);
  });

  it("falls back to floor for invalid numeric + invalid date", () => {
    expect(retryAfterMs(makeClientError(429, "not-a-number"))).toBe(60_000);
    expect(retryAfterMs(makeClientError(429, ""))).toBe(60_000);
  });

  it("parses HTTP-date retry-after and clamps to [60s, 5m]", () => {
    const now = Date.now();
    vi.setSystemTime(new Date(now));
    // 90s in the future → 90s backoff
    const future90s = new Date(now + 90_000).toUTCString();
    expect(
      retryAfterMs(makeClientError(429, future90s)),
    ).toBeGreaterThanOrEqual(60_000);
    expect(retryAfterMs(makeClientError(429, future90s))).toBeLessThanOrEqual(
      90_000,
    );
    // 10 min in the future → capped to 5 min
    const future10m = new Date(now + 10 * 60_000).toUTCString();
    expect(retryAfterMs(makeClientError(429, future10m))).toBe(300_000);
    // Past date → floored to 60s
    const past = new Date(now - 60_000).toUTCString();
    expect(retryAfterMs(makeClientError(429, past))).toBe(60_000);
    vi.useRealTimers();
  });
});

describe("rateLimitAwareRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const baseConfig = {
    errorRetryInterval: 5_000,
    errorRetryCount: undefined,
  } as never;

  it("schedules a retry with Retry-After backoff on 429", () => {
    const revalidate = vi.fn();
    rateLimitAwareRetry(
      makeClientError(429, "120"),
      "key",
      baseConfig,
      revalidate,
      { retryCount: 0, dedupe: true },
    );
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(119_999);
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // Full opts forwarded so SWR's `dedupe: true` isn't lost — otherwise
    // components sharing a key would fan duplicate retry requests.
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 0, dedupe: true });
  });

  it("uses exponential backoff for non-429 errors and forwards opts", () => {
    const revalidate = vi.fn();
    rateLimitAwareRetry(new Error("boom"), "key", baseConfig, revalidate, {
      retryCount: 2,
      dedupe: true,
    });
    // exponent=2 → multiplier = ~~((rand+0.5) * 4) ∈ [2, 5]; interval = 5s.
    // → timeout ∈ [10s, 25s]. Advance past upper bound.
    vi.advanceTimersByTime(30_000);
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 2, dedupe: true });
  });

  it("does not cap non-429 retries when errorRetryCount is undefined", () => {
    // Matches SWR's default (no cap) so a 5xx outage doesn't permanently
    // wedge the hook once N retries are exhausted. SWR's polling loop
    // refuses to revalidate while the cache is errored.
    const revalidate = vi.fn();
    rateLimitAwareRetry(new Error("boom"), "key", baseConfig, revalidate, {
      retryCount: 100,
      dedupe: true,
    });
    vi.runAllTimers();
    expect(revalidate).toHaveBeenCalled();
  });

  it("respects an explicit errorRetryCount cap for non-429", () => {
    const revalidate = vi.fn();
    const config = {
      errorRetryInterval: 5_000,
      errorRetryCount: 3,
    } as never;
    rateLimitAwareRetry(new Error("boom"), "key", config, revalidate, {
      retryCount: 4,
      dedupe: true,
    });
    vi.runAllTimers();
    expect(revalidate).not.toHaveBeenCalled();
  });
});
