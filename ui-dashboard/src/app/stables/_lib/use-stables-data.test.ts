import { describe, expect, it } from "vitest";
import { mergedFeedError } from "./use-stables-data";

describe("mergedFeedError", () => {
  it("does not hard-error when merged fallback rows are usable", () => {
    const currentError = new Error("current state schema missing");

    expect(mergedFeedError([{}], currentError, null)).toBeNull();
  });

  it("surfaces a feed error when no merged rows are usable", () => {
    const currentError = new Error("current state schema missing");

    expect(mergedFeedError([], currentError, null)).toBe(currentError);
  });

  it("surfaces fallback errors even when current rows are usable", () => {
    const fallbackError = new Error("daily fallback unavailable");

    expect(mergedFeedError([{}], null, fallbackError)).toBe(fallbackError);
  });
});
