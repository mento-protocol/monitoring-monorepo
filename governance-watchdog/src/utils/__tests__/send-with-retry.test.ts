import { describe, expect, it, vi } from "vitest";
import { sendWithRetry } from "../send-with-retry.js";

describe("sendWithRetry", () => {
  it("returns the result on the first successful attempt without retrying", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");

    const result = await sendWithRetry(attempt, {
      isRetryable: () => true,
      baseDelayMs: 1,
    });

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("retries a retryable failure and resolves once the attempt succeeds", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    const result = await sendWithRetry(attempt, {
      isRetryable: () => true,
      baseDelayMs: 1,
    });

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry when isRetryable reports the error as terminal", async () => {
    const terminalError = new Error("terminal");
    const attempt = vi.fn().mockRejectedValue(terminalError);

    await expect(
      sendWithRetry(attempt, { isRetryable: () => false, baseDelayMs: 1 }),
    ).rejects.toBe(terminalError);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("throws the last error once maxRetries is exhausted", async () => {
    const lastError = new Error("still failing");
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockRejectedValueOnce(lastError);

    await expect(
      sendWithRetry(attempt, {
        isRetryable: () => true,
        maxRetries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toBe(lastError);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("calls onAttemptFailed with the attempt index and retry decision", async () => {
    const onAttemptFailed = vi.fn();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce("ok");

    await sendWithRetry(attempt, {
      isRetryable: () => true,
      baseDelayMs: 1,
      onAttemptFailed,
    });

    expect(onAttemptFailed).toHaveBeenCalledTimes(1);
    expect(onAttemptFailed).toHaveBeenCalledWith(expect.any(Error), 0, true);
  });
});
