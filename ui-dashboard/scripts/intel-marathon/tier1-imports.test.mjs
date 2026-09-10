import { expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => {
    throw new Error("import read");
  }),
  readFileSync: vi.fn(() => {
    throw new Error("import read");
  }),
}));
it("imports domain modules without requests, progress reads, or CLI execution", async () => {
  const fetch = vi.fn(() => {
    throw new Error("import request");
  });
  vi.stubGlobal("fetch", fetch);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("import exit");
  });
  try {
    await import("./tier1-discovery.mjs");
    await import("./tier1-quota.mjs");
    await import("./tier1-writes.mjs");
    await import("./tier1-progress.mjs");
    expect(fetch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    vi.unstubAllGlobals();
  }
});
