import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  let entryMock: ReturnType<typeof vi.fn>;
  let writeMock: ReturnType<typeof vi.fn>;
  let logSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    entryMock = vi.fn((metadata, data) => ({ metadata, data }));
    writeMock = vi.fn();
    logSyncMock = vi.fn(() => ({
      entry: entryMock,
      write: writeMock,
    }));
    vi.doMock("@google-cloud/logging", () => ({
      Logging: class {
        logSync = logSyncMock;
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("@google-cloud/logging");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("writes structured entries with Cloud Logging severities", async () => {
    const { logger } = await import("./logger");
    const cases = [
      ["debug", "DEBUG"],
      ["info", "INFO"],
      ["warn", "WARNING"],
      ["error", "ERROR"],
      ["critical", "CRITICAL"],
    ] as const;

    for (const [method] of cases) {
      logger[method](`message-${method}`, { method });
    }

    expect(logSyncMock).toHaveBeenCalledWith("onchain-event-handler");
    for (const [method, severity] of cases) {
      expect(entryMock).toHaveBeenCalledWith(
        { severity },
        { message: `message-${method}`, method },
      );
    }
    expect(writeMock).toHaveBeenCalledTimes(cases.length);
  });

  it("falls back to console.error when error logging fails", async () => {
    writeMock.mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Keep test output quiet.
    });
    const { logger } = await import("./logger");

    logger.error("incident delivery failed", { channelId: "Calerts" });

    expect(consoleError).toHaveBeenCalledWith(
      "[ERROR] incident delivery failed",
      {
        channelId: "Calerts",
      },
    );
  });

  it("falls back to console.log for non-error severities", async () => {
    writeMock.mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output quiet.
    });
    const { logger } = await import("./logger");

    logger.warn("retrying slack delivery", { attempt: 2 });

    expect(consoleLog).toHaveBeenCalledWith(
      "[WARNING] retrying slack delivery",
      {
        attempt: 2,
      },
    );
  });
});
