import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  withMonitor: vi.fn(async (_slug: string, cb: () => Promise<unknown>) => cb()),
  flush: vi.fn().mockResolvedValue(true),
}));

import * as Sentry from "@sentry/nextjs";
import { withFlushedMonitor } from "../sentry-cron";

const mockWithMonitor = vi.mocked(Sentry.withMonitor);
const mockFlush = vi.mocked(Sentry.flush);

beforeEach(() => {
  vi.clearAllMocks();
  mockFlush.mockResolvedValue(true);
});

describe("withFlushedMonitor", () => {
  it("flushes Sentry cron check-ins before resolving", async () => {
    const result = await withFlushedMonitor("test-cron", async () => "ok", {
      schedule: { type: "crontab", value: "* * * * *" },
    });

    expect(result).toBe("ok");
    expect(mockWithMonitor).toHaveBeenCalledWith(
      "test-cron",
      expect.any(Function),
      { schedule: { type: "crontab", value: "* * * * *" } },
    );
    expect(mockFlush).toHaveBeenCalledWith(2_000);
  });

  it("still flushes when the monitored callback fails", async () => {
    await expect(
      withFlushedMonitor(
        "test-cron",
        async () => {
          throw new Error("boom");
        },
        { schedule: { type: "crontab", value: "* * * * *" } },
      ),
    ).rejects.toThrow("boom");

    expect(mockFlush).toHaveBeenCalledWith(2_000);
  });
});
