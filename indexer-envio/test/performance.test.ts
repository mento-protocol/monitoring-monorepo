import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const OLD_PERF = process.env.INDEXER_PERF;
const OLD_INTERVAL = process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS;

describe("withInstrumentedHandler", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.INDEXER_PERF = "true";
    process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS = "1";
  });

  afterEach(() => {
    vi.resetModules();
    if (OLD_PERF === undefined) {
      delete process.env.INDEXER_PERF;
    } else {
      process.env.INDEXER_PERF = OLD_PERF;
    }
    if (OLD_INTERVAL === undefined) {
      delete process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS;
    } else {
      process.env.INDEXER_PERF_LOG_INTERVAL_EVENTS = OLD_INTERVAL;
    }
  });

  it("does not throw after a successful handler when context.log is absent", async () => {
    const { withInstrumentedHandler } = await import("../src/performance.ts");

    const result = await withInstrumentedHandler(
      "test",
      { context: { isPreload: false } },
      async () => "ok",
    );

    assert.equal(result, "ok");
  });

  it("swallows logger failures so instrumentation cannot mask handler results", async () => {
    const { withInstrumentedHandler } = await import("../src/performance.ts");

    const result = await withInstrumentedHandler(
      "test",
      {
        context: {
          isPreload: false,
          log: {
            info: () => {
              throw new Error("logger failed");
            },
          },
        },
      },
      async () => "ok",
    );

    assert.equal(result, "ok");
  });
});
