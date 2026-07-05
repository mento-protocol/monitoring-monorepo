import { describe, expect, it } from "vitest";
import { sortedCopy } from "../immutable-sort";

describe("sortedCopy", () => {
  it("returns a new array sorted by the comparator", () => {
    const input = [3, 1, 2];
    const result = sortedCopy(input, (a, b) => a - b);

    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(input);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    sortedCopy(input, (a, b) => a - b);

    expect(input).toEqual([3, 1, 2]);
  });

  it("passes the comparator through untouched, preserving stability", () => {
    const input = [
      { key: "b", order: 0 },
      { key: "a", order: 1 },
      { key: "a", order: 0 },
    ];

    const result = sortedCopy(input, (a, b) => a.key.localeCompare(b.key));

    expect(result).toEqual([
      { key: "a", order: 1 },
      { key: "a", order: 0 },
      { key: "b", order: 0 },
    ]);
  });

  it("handles an empty array", () => {
    const input: number[] = [];
    const result = sortedCopy(input, (a, b) => a - b);

    expect(result).toEqual([]);
  });

  it("handles a single-element array", () => {
    const input = [42];
    const result = sortedCopy(input, (a, b) => a - b);

    expect(result).toEqual([42]);
  });
});
