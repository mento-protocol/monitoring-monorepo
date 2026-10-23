import { afterEach, describe, expect, it, vi } from "vitest";

const { init, browserSessionIntegration } = vi.hoisted(() => ({
  init: vi.fn(),
  browserSessionIntegration: vi.fn(() => ({ name: "BrowserSession" })),
}));
vi.mock("@sentry/nextjs", () => ({
  init,
  browserSessionIntegration,
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock("../src/env", () => ({
  clientEnv: {
    NEXT_PUBLIC_VERCEL_ENV: "production",
    NEXT_PUBLIC_SENTRY_DSN: "https://public@example.invalid/1",
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("browser Sentry initialization", () => {
  it("applies the same restrictive privacy and transaction hooks as server/edge", async () => {
    // Hold the replay callback: importing the recorder is unrelated to init privacy.
    vi.stubGlobal("window", { requestIdleCallback: vi.fn() });
    await import("../src/instrumentation-client");
    const { getServerSentryOptions } = await import("../sentry.shared");
    expect(init).toHaveBeenCalledOnce();
    const options = init.mock.calls[0]![0];
    expect(options.traceLifecycle).toBe("static");
    expect(options.attachStacktrace).toBe(false);
    expect(options.dataCollection).toEqual(
      getServerSentryOptions().dataCollection,
    );
    expect(options.beforeSendTransaction).toBe(
      getServerSentryOptions().beforeSendTransaction,
    );
    expect(options.beforeSend).toBe(getServerSentryOptions().beforeSend);
    expect(options.tracesSampleRate).toBe(0.2);
    expect(options.replaysSessionSampleRate).toBe(0.1);
    expect(options.replaysOnErrorSampleRate).toBe(1);
  });
});
