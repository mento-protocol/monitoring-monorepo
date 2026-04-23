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
  type FakeDocument = {
    hidden: boolean;
    _listeners: Array<() => void>;
    addEventListener: (type: string, handler: () => void) => void;
    removeEventListener: (type: string, handler: () => void) => void;
    _fireVisibilityChange: () => void;
  };
  type FakeWindow = {
    _listeners: Array<() => void>;
    addEventListener: (type: string, handler: () => void) => void;
    removeEventListener: (type: string, handler: () => void) => void;
    _fireOnline: () => void;
  };
  type FakeNavigator = { onLine: boolean };

  const globalScope = globalThis as unknown as {
    document?: FakeDocument;
    window?: FakeWindow;
    navigator?: FakeNavigator;
  };

  function installFakeEnv(
    initial: { hidden?: boolean; online?: boolean } = {},
  ): { doc: FakeDocument; win: FakeWindow; nav: FakeNavigator } {
    const docListeners: Array<() => void> = [];
    const doc: FakeDocument = {
      hidden: initial.hidden ?? false,
      _listeners: docListeners,
      addEventListener: (type, handler) => {
        if (type === "visibilitychange") docListeners.push(handler);
      },
      removeEventListener: (type, handler) => {
        if (type !== "visibilitychange") return;
        const idx = docListeners.indexOf(handler);
        if (idx !== -1) docListeners.splice(idx, 1);
      },
      _fireVisibilityChange: () => {
        for (const fn of [...docListeners]) fn();
      },
    };
    const winListeners: Array<() => void> = [];
    const win: FakeWindow = {
      _listeners: winListeners,
      addEventListener: (type, handler) => {
        if (type === "online") winListeners.push(handler);
      },
      removeEventListener: (type, handler) => {
        if (type !== "online") return;
        const idx = winListeners.indexOf(handler);
        if (idx !== -1) winListeners.splice(idx, 1);
      },
      _fireOnline: () => {
        for (const fn of [...winListeners]) fn();
      },
    };
    const nav: FakeNavigator = { onLine: initial.online ?? true };
    globalScope.document = doc;
    globalScope.window = win;
    globalScope.navigator = nav;
    return { doc, win, nav };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalScope.document;
    delete globalScope.window;
    delete globalScope.navigator;
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

  it("defers scheduling the retry timer while the tab is hidden", () => {
    // Both useGQL and useBridgeGQL disable revalidateOnFocus/Reconnect,
    // which defeats SWR's "skip onErrorRetry while inactive" gate. Without
    // this guard, 429 retries run in background tabs at the Retry-After
    // cadence — the exact quota burn the PR is supposed to prevent.
    installFakeEnv({ hidden: true });
    const revalidate = vi.fn();
    rateLimitAwareRetry(
      makeClientError(429, "120"),
      "key",
      baseConfig,
      revalidate,
      { retryCount: 0, dedupe: true },
    );
    vi.advanceTimersByTime(10 * 60_000);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("resumes the retry timer after visibilitychange returns the tab", () => {
    const { doc, win } = installFakeEnv({ hidden: true });
    const revalidate = vi.fn();
    rateLimitAwareRetry(
      makeClientError(429, "120"),
      "key",
      baseConfig,
      revalidate,
      { retryCount: 0, dedupe: true },
    );
    doc.hidden = false;
    doc._fireVisibilityChange();
    // Now the setTimeout is armed; the full Retry-After delay still applies
    // so we honor the server's instruction end-to-end.
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 0, dedupe: true });
    // Listeners removed themselves on the one-shot fire (both
    // visibilitychange and online, since we listen to both).
    expect(doc._listeners).toHaveLength(0);
    expect(win._listeners).toHaveLength(0);
  });

  it("defers scheduling the retry timer while the browser is offline", () => {
    // Parallel to the hidden case: `revalidateOnReconnect: false` means the
    // network-reconnect path can't recover errored hooks, so we have to do
    // the gating ourselves. Offline retries would otherwise grow retryCount
    // (and hence exponential backoff) during outages, so reconnect sees
    // multi-minute delays before the next retry fires.
    installFakeEnv({ online: false });
    const revalidate = vi.fn();
    rateLimitAwareRetry(new Error("boom"), "key", baseConfig, revalidate, {
      retryCount: 1,
      dedupe: true,
    });
    vi.advanceTimersByTime(10 * 60_000);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("resumes the retry timer after the online event fires", () => {
    const { nav, win } = installFakeEnv({ online: false });
    const revalidate = vi.fn();
    rateLimitAwareRetry(
      makeClientError(429, "60"),
      "key",
      baseConfig,
      revalidate,
      { retryCount: 0, dedupe: true },
    );
    nav.onLine = true;
    win._fireOnline();
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 0, dedupe: true });
  });
});
