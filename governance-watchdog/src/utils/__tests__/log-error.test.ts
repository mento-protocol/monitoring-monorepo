import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import logError from "../log-error.js";

function loggedLine(): string {
  const spy = vi.mocked(console.error);
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0][0] as string;
}

describe("logError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single-line JSON entry with severity ERROR", () => {
    logError("something broke");

    const line = loggedLine();
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      message: "something broke",
    });
  });

  it("appends the stack for Error values", () => {
    const error = new Error("boom");

    logError("request failed:", error);

    const line = loggedLine();
    // Stacks contain newlines; the JSON encoding must keep the entry single-line
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as { message: string };
    expect(parsed.message).toContain("request failed:");
    expect(parsed.message).toContain("Error: boom");
  });

  it("serializes non-Error values", () => {
    logError("payload error:", { code: 522 });

    const parsed = JSON.parse(loggedLine()) as { message: string };
    expect(parsed.message).toBe('payload error: {"code":522}');
  });
});
