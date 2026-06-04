import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("writes structured entries with Cloud Logging severities", async () => {
    const entryMock = vi.fn((metadata, data) => ({ metadata, data }));
    const writeMock = vi.fn();
    const logSyncMock = vi.fn(() => ({
      entry: entryMock,
      write: writeMock,
    }));

    vi.doMock("@google-cloud/logging", () => ({
      Logging: vi.fn(function MockLogging() {
        return {
          logSync: logSyncMock,
        };
      }),
    }));

    const { logger } = await import("./logger");

    logger.debug("debug message", { key: "debug" });
    logger.info("info message", { key: "info" });
    logger.warn("warn message", { key: "warn" });
    logger.error("error message", { key: "error" });
    logger.critical("critical message", { key: "critical" });

    expect(logSyncMock).toHaveBeenCalledWith("oncall-announcer");
    expect(entryMock).toHaveBeenCalledWith(
      { severity: "DEBUG" },
      { message: "debug message", key: "debug" },
    );
    expect(entryMock).toHaveBeenCalledWith(
      { severity: "INFO" },
      { message: "info message", key: "info" },
    );
    expect(entryMock).toHaveBeenCalledWith(
      { severity: "WARNING" },
      { message: "warn message", key: "warn" },
    );
    expect(entryMock).toHaveBeenCalledWith(
      { severity: "ERROR" },
      { message: "error message", key: "error" },
    );
    expect(entryMock).toHaveBeenCalledWith(
      { severity: "CRITICAL" },
      { message: "critical message", key: "critical" },
    );
    expect(writeMock).toHaveBeenCalledTimes(5);
  });

  it("falls back to console when Cloud Logging fails", async () => {
    vi.doMock("@google-cloud/logging", () => ({
      Logging: vi.fn(function MockLogging() {
        return {
          logSync: vi.fn(() => ({
            entry: vi.fn(),
            write: vi.fn(() => {
              throw new Error("logging unavailable");
            }),
          })),
        };
      }),
    }));
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // test-only console suppression
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        // test-only console suppression
      });

    const { logger } = await import("./logger");

    logger.info("info fallback", { key: "info" });
    logger.error("error fallback", { key: "error" });

    expect(consoleLogSpy).toHaveBeenCalledWith("[INFO] info fallback", {
      key: "info",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith("[ERROR] error fallback", {
      key: "error",
    });

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
