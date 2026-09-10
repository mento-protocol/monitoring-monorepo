import { describe, expect, it, vi } from "vitest";
import { loadProcessed } from "./tier1-progress.mjs";
describe("tier1 existing resume contract", () => {
  it("keeps every address-bearing record, including errors and legacy outcomes", () => {
    const lines =
      [
        { address: "error", error: "timeout" },
        { address: "empty", error: "" },
        { address: "legacy" },
        { address: "status", status: 404 },
        { address: "write", write: "written" },
        { address: "error", status: 200 },
        {},
      ]
        .map(JSON.stringify)
        .join("\n") + "\nmalformed\nnull\n\n";
    const storage = {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => lines),
    };
    expect([...loadProcessed("scope-a", { storage }).processed]).toEqual([
      "error",
      "empty",
      "legacy",
      "status",
      "write",
    ]);
    expect(storage.readFileSync).toHaveBeenCalledWith("scope-a", "utf8");
  });
  it("does not read an absent scope file", () => {
    const storage = { existsSync: vi.fn(() => false), readFileSync: vi.fn() };
    expect(loadProcessed("scope-b", { storage })).toEqual({
      processed: new Set(),
      exists: false,
    });
    expect(storage.readFileSync).not.toHaveBeenCalled();
  });
});

describe("explicit error retry policy", () => {
  it.each([
    ["error only", [{ address: "a", error: "timeout" }], []],
    ["empty error", [{ address: "a", error: "" }], []],
    ["null error", [{ address: "a", error: null }], []],
    [
      "repeated errors",
      [
        { address: "a", error: "one" },
        { address: "a", error: "two" },
      ],
      [],
    ],
    [
      "error then success",
      [
        { address: "a", error: "one" },
        { address: "a", write: "written" },
      ],
      ["a"],
    ],
    [
      "success then error",
      [
        { address: "a", write: "written" },
        { address: "a", error: "one" },
      ],
      ["a"],
    ],
    ["legacy record", [{ address: "a" }], ["a"]],
    ["clean 404", [{ address: "a", status: 404 }], ["a"]],
    ["quality rejection", [{ address: "a", status: 200 }], ["a"]],
    ["new contention", [{ address: "a", write: "skipped_exists" }], ["a"]],
    ["refresh contention", [{ address: "a", write: "skipped_changed" }], ["a"]],
    [
      "error key wins within record",
      [{ address: "a", status: 200, error: "" }],
      [],
    ],
  ])("%s", (_name, records, expected) => {
    const storage = {
      existsSync: () => true,
      readFileSync: () =>
        records.map(JSON.stringify).join("\n") + "\nmalformed\nnull\n\n",
    };
    expect([
      ...loadProcessed("scope", { storage, retryErrors: true }).processed,
    ]).toEqual(expected);
    expect([...loadProcessed("scope", { storage }).processed]).toEqual(["a"]);
  });
  it("reads only the requested scope and preserves address identity", () => {
    const storage = {
      existsSync: () => true,
      readFileSync: vi.fn((path) =>
        path === "scope-a"
          ? '{"address":"ABC","error":""}\n{"address":"abc"}'
          : '{"address":"other"}',
      ),
    };
    expect([
      ...loadProcessed("scope-a", { storage, retryErrors: true }).processed,
    ]).toEqual(["abc"]);
    expect(storage.readFileSync).toHaveBeenCalledExactlyOnceWith(
      "scope-a",
      "utf8",
    );
  });
  it("handles absent histories in retry mode", () => {
    const storage = { existsSync: () => false, readFileSync: vi.fn() };
    expect(loadProcessed("missing", { storage, retryErrors: true })).toEqual({
      processed: new Set(),
      exists: false,
    });
    expect(storage.readFileSync).not.toHaveBeenCalled();
  });
});
