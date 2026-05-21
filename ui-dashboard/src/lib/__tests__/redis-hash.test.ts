import { describe, expect, it, vi } from "vitest";
import {
  flattenHashReplacements,
  MAX_REDIS_HASH_REPLACE_BYTES,
  mergeRedisHashes,
  REDIS_HSET_FIELD_CHUNK_SIZE,
  replaceRedisHashes,
} from "@/lib/redis-hash";

function makeMockRedis() {
  return {
    eval: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
  };
}

describe("replaceRedisHashes", () => {
  it("replaces multiple hashes in one EVAL payload", async () => {
    const redis = makeMockRedis();

    await replaceRedisHashes(redis, [
      { key: "labels", fields: { "0xaaa": "label" } },
      { key: "reports", fields: { "0xbbb": "report" } },
    ]);

    expect(redis.eval).toHaveBeenCalledOnce();
    const [script, keys, argv] = redis.eval.mock.calls[0]!;
    expect(script).toContain(
      `local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}`,
    );
    expect(script).toContain("while remainingFields > 0 do");
    expect(script).toContain("unpack(ARGV, argIndex, chunkEndArg)");
    expect(script).not.toContain("lastFieldArg");
    expect(script).not.toContain("ARGV[argIndex], ARGV[argIndex + 1]");
    expect(keys).toEqual(["labels", "reports"]);
    expect(argv).toEqual(["1", "0xaaa", "label", "1", "0xbbb", "report"]);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("keeps HSET chunks below the Redis Lua unpack stack ceiling", async () => {
    const redis = makeMockRedis();
    const fields = Object.fromEntries(
      Array.from({ length: REDIS_HSET_FIELD_CHUNK_SIZE + 1 }, (_, index) => [
        `0x${index.toString(16).padStart(40, "0")}`,
        `label-${index}`,
      ]),
    );

    await replaceRedisHashes(redis, [{ key: "labels", fields }]);

    const [, , argv] = redis.eval.mock.calls[0]!;
    expect(argv[0]).toBe(String(REDIS_HSET_FIELD_CHUNK_SIZE + 1));
    expect(argv).toHaveLength(1 + (REDIS_HSET_FIELD_CHUNK_SIZE + 1) * 2);
  });

  it("encodes empty replacements as zero-field hash clears", () => {
    expect(
      flattenHashReplacements([
        { key: "labels", fields: {} },
        { key: "reports", fields: { "0xbbb": "report" } },
      ]),
    ).toEqual(["0", "1", "0xbbb", "report"]);
  });

  it("splits each hash into its own batch when combined exceeds the cap but each fits", async () => {
    const redis = makeMockRedis();
    // Each replacement is ~6 MB; combined ~12 MB > 8 MB cap. Neither fits
    // with another, so greedy-pack puts each in its own batch.
    const bigField = "x".repeat(6 * 1024 * 1024);
    await replaceRedisHashes(redis, [
      { key: "labels", fields: { "0xaaa": bigField } },
      { key: "reports", fields: { "0xbbb": bigField } },
    ]);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0]?.[1]).toEqual(["labels"]);
    expect(redis.eval.mock.calls[1]?.[1]).toEqual(["reports"]);
  });

  it("keeps small hashes packed together when only a later large hash forces a split", async () => {
    const redis = makeMockRedis();
    // labels + reports together = 2 MB; arkham_deep alone = 7 MB. Combined
    // 9 MB > 8 MB cap. Greedy-pack puts labels+reports in one EVAL (their
    // 2 MB fits, atomic invariant preserved), arkham_deep in another.
    const oneMb = "z".repeat(1024 * 1024);
    const sevenMb = "z".repeat(7 * 1024 * 1024);
    await replaceRedisHashes(redis, [
      { key: "labels", fields: { "0xaaa": oneMb } },
      { key: "reports", fields: { "0xbbb": oneMb } },
      { key: "arkham_deep", fields: { "0xccc": sevenMb } },
    ]);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0]?.[1]).toEqual(["labels", "reports"]);
    expect(redis.eval.mock.calls[1]?.[1]).toEqual(["arkham_deep"]);
  });

  it("falls back to chunked DEL+HSET when a single replace hash exceeds the EVAL cap", async () => {
    const redis = makeMockRedis();
    // labels = small, EVAL-able. intel_deep = 10 fields × 1 MB = ~10 MB total
    // > 8 MB EVAL cap, but each individual field fits an HSET command. The
    // mixed-call partitions: EVAL for labels, chunked DEL+HSET for intel_deep.
    // Without the partition, the EVAL would reject the whole payload — see
    // ANALYTICS-MENTO-ORG-18 incident.
    const oneMb = "v".repeat(1024 * 1024);
    const intelFields = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`0x${i}`, oneMb]),
    );
    await replaceRedisHashes(redis, [
      { key: "labels", fields: { "0xaaa": "label" } },
      { key: "intel_deep", fields: intelFields },
    ]);
    // labels goes through EVAL
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]?.[1]).toEqual(["labels"]);
    // intel_deep goes through DEL + chunked HSET (at least one HSET call)
    expect(redis.del).toHaveBeenCalledWith("intel_deep");
    expect(redis.hset.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of redis.hset.mock.calls) {
      expect(call[0]).toBe("intel_deep");
    }
    // Union of HSET chunks = full input field set
    const writtenFields = new Set<string>();
    for (const call of redis.hset.mock.calls) {
      for (const k of Object.keys(call[1] as Record<string, string>)) {
        writtenFields.add(k);
      }
    }
    expect(writtenFields.size).toBe(10);
  });

  it("splits an oversized hash into multiple HSET chunks when many fields combined exceed the cap", async () => {
    const redis = makeMockRedis();
    // Build a hash with many ~1 MB fields so the total > 8 MB and the
    // chunker must break it across multiple HSETs. Each field individually
    // fits an HSET command.
    const oneMb = "f".repeat(1024 * 1024);
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}`, oneMb]),
    );
    await replaceRedisHashes(redis, [{ key: "intel_deep", fields }]);
    expect(redis.del).toHaveBeenCalledWith("intel_deep");
    // 12 MB of data with ~7 MB-per-chunk effective cap → 2 chunks expected
    expect(redis.hset.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Verify all fields landed somewhere — union of chunks equals input
    const writtenFields = new Set<string>();
    for (const call of redis.hset.mock.calls) {
      const chunkArg = call[1] as Record<string, string>;
      for (const k of Object.keys(chunkArg)) {
        writtenFields.add(k);
      }
    }
    expect(writtenFields.size).toBe(12);
  });

  it("decorates errors from chunked HSET with hash name and partial-state warning", async () => {
    const redis = makeMockRedis();
    const oneMb = "v".repeat(1024 * 1024);
    const fields = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`0x${i}`, oneMb]),
    );
    redis.hset.mockRejectedValueOnce(new Error("upstash 500"));
    await expect(
      replaceRedisHashes(redis, [{ key: "intel_deep", fields }]),
    ).rejects.toThrow(
      /chunked write for intel_deep[\s\S]*may be in a partial state[\s\S]*upstash 500/,
    );
    // DEL ran (replace mode), then HSET threw before completing
    expect(redis.del).toHaveBeenCalledWith("intel_deep");
  });

  it("throws cleanly when a single field exceeds the HSET command cap (no partial write)", async () => {
    const redis = makeMockRedis();
    // One field with a value bigger than MAX_REDIS_HASH_REPLACE_BYTES can't
    // be split further at the field level — fail fast with a clear message
    // rather than issue a doomed HSET.
    const oneHuge = "x".repeat(MAX_REDIS_HASH_REPLACE_BYTES);
    await expect(
      replaceRedisHashes(redis, [
        { key: "intel_deep", fields: { huge: oneHuge } },
      ]),
    ).rejects.toThrow(
      /Single field huge on hash intel_deep[\s\S]*cannot split further/,
    );
  });
});

describe("mergeRedisHashes", () => {
  it("merges multiple hashes in one EVAL payload without deleting keys", async () => {
    const redis = makeMockRedis();

    await mergeRedisHashes(redis, [
      { key: "labels", fields: { "0xaaa": "label" } },
      { key: "reports", fields: { "0xbbb": "report" } },
    ]);

    expect(redis.eval).toHaveBeenCalledOnce();
    const [script, keys, argv] = redis.eval.mock.calls[0]!;
    expect(script).toContain(
      `local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}`,
    );
    expect(script).not.toContain("redis.call('DEL', key)");
    expect(script).toContain("redis.call('HSET', key");
    expect(keys).toEqual(["labels", "reports"]);
    expect(argv).toEqual(["1", "0xaaa", "label", "1", "0xbbb", "report"]);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("skips empty merge replacements because merge mode must not clear hashes", async () => {
    const redis = makeMockRedis();

    await mergeRedisHashes(redis, [
      { key: "labels", fields: {} },
      { key: "reports", fields: {} },
    ]);

    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("falls back to chunked HSET (no DEL) when a single merge hash exceeds the EVAL cap", async () => {
    const redis = makeMockRedis();
    // Merge mode must NOT issue DEL even when chunking — that would wipe
    // pre-existing fields the merge was supposed to union with.
    const oneMb = "v".repeat(1024 * 1024);
    const fields = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`0x${i}`, oneMb]),
    );
    await mergeRedisHashes(redis, [{ key: "intel_deep", fields }]);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.hset.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of redis.hset.mock.calls) {
      expect(call[0]).toBe("intel_deep");
    }
  });
});
