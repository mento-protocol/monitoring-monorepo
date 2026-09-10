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
    expect([...loadProcessed("scope-a", storage).processed]).toEqual([
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
    expect(loadProcessed("scope-b", storage)).toEqual({
      processed: new Set(),
      exists: false,
    });
    expect(storage.readFileSync).not.toHaveBeenCalled();
  });
});
