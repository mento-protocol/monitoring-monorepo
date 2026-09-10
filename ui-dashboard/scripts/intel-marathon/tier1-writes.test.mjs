import { describe, expect, it, vi } from "vitest";
import {
  buildWriteEntry,
  createLabelStore,
  createWriter,
  toAddressEntry,
} from "./tier1-writes.mjs";
const fresh = {
  name: " Fresh ",
  tags: ["new"],
  notes: "Arkham prediction (90% confidence)",
  source: "arkham",
  updatedAt: "now",
  isPublic: false,
};
const pending = (address, mode = "new") => ({
  address,
  entry: fresh,
  mode,
  expectedUpdatedAt: "old",
});
describe("tier1 write outcomes", () => {
  it("sanitizes new results and preserves curated refresh state", () => {
    const result = toAddressEntry(
      {
        celo: {
          arkhamLabel: { name: " A " },
          populatedTags: [{ id: " DeFi " }, { id: "defi" }],
        },
      },
      () => new Date("2026-01-01T00:00:00Z"),
    );
    expect(result).toMatchObject({
      name: "A",
      tags: ["DeFi"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const merged = buildWriteEntry(fresh, {
      source: "arkham",
      tags: ["arkham", " Curated ", "curated"],
      notes: "User note",
      isPublic: true,
      createdAt: "birth",
    });
    expect(merged).toMatchObject({
      name: "Fresh",
      tags: ["Curated", "new"],
      notes: "User note",
      isPublic: true,
      createdAt: "birth",
    });
    expect(
      toAddressEntry({
        celo: { entityPredictions: [{ confidence: 0.84, entityId: "low" }] },
      }),
    ).toBeNull();
    expect(
      buildWriteEntry(fresh, {
        source: "arkham",
        tags: [],
        notes: "Arkham prediction (85% confidence)",
      }).notes,
    ).toBe(fresh.notes);
  });
  it("records HSETNX and CAS contention only after confirmation", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ result: 1 }, { result: 0 }])
      .mockResolvedValueOnce([{ result: ["edited", "deleted"] }]);
    const appendFileSync = vi.fn();
    const writer = createWriter({
      pipeline,
      appendFileSync,
      progressFile: "progress",
    });
    writer.pendingWrites.push(
      pending("new"),
      pending("appeared"),
      pending("edited", "refresh"),
      pending("deleted", "refresh"),
      pending("unchanged", "refresh"),
    );
    expect(appendFileSync).not.toHaveBeenCalled();
    await writer.flushWrites();
    expect(writer.counts).toEqual({
      written: 2,
      newSkippedExists: 1,
      refreshSkippedChanged: 2,
    });
    expect(
      appendFileSync.mock.calls.map(([, line]) => JSON.parse(line)),
    ).toEqual([
      { address: "new", write: "written" },
      { address: "appeared", write: "skipped_exists" },
      { address: "edited", write: "skipped_changed" },
      { address: "deleted", write: "skipped_changed" },
      { address: "unchanged", write: "written" },
    ]);
    const command = pipeline.mock.calls[1][0][0];
    expect(command.slice(0, 1)).toEqual(["EVAL"]);
    expect(command[1]).toContain("current_updated_at == expected_updated_at");
    expect(command.slice(2, 6)).toEqual(["1", "labels", "edited", "old"]);
  });
  it("retains a failed batch and never completes unconfirmed refreshes", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ result: 1 }])
      .mockRejectedValueOnce(new Error("storage failed"));
    const appendFileSync = vi.fn();
    const writer = createWriter({
      pipeline,
      appendFileSync,
      progressFile: "progress",
    });
    writer.pendingWrites.push(pending("new"), pending("refresh", "refresh"));
    await expect(writer.flushWrites()).rejects.toThrow("storage failed");
    expect(writer.pendingWrites).toHaveLength(2);
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(appendFileSync.mock.calls[0][1])).toEqual({
      address: "new",
      write: "written",
    });
  });
  it("surfaces HTTP and individual command failures before recording progress", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ result: 1 }, { error: "denied" }]),
      );
    const store = createLabelStore({
      redisUrl: "https://redis.invalid",
      redisToken: "fake",
      fetch,
    });
    const appendFileSync = vi.fn();
    const writer = createWriter({
      pipeline: store.pipeline,
      appendFileSync,
      progressFile: "progress",
    });
    writer.pendingWrites.push(pending("first"), pending("second"));
    await expect(writer.flushWrites()).rejects.toThrow(
      "cmd[1] (HSETNX): denied",
    );
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(writer.pendingWrites).toHaveLength(2);
  });
});
