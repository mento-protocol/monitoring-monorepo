import { describe, expect, it, vi } from "vitest";
import {
  flattenHashReplacements,
  mergeRedisHashes,
  REDIS_HSET_FIELD_CHUNK_SIZE,
  replaceRedisHashes,
} from "@/lib/redis-hash";

describe("replaceRedisHashes", () => {
  it("replaces multiple hashes in one EVAL payload", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);

    await replaceRedisHashes({ eval: evalMock }, [
      { key: "labels", fields: { "0xaaa": "label" } },
      { key: "reports", fields: { "0xbbb": "report" } },
    ]);

    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keys, argv] = evalMock.mock.calls[0]!;
    expect(script).toContain(
      `local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}`,
    );
    expect(script).toContain("while remainingFields > 0 do");
    expect(script).toContain("unpack(ARGV, argIndex, chunkEndArg)");
    expect(script).not.toContain("lastFieldArg");
    expect(script).not.toContain("ARGV[argIndex], ARGV[argIndex + 1]");
    expect(keys).toEqual(["labels", "reports"]);
    expect(argv).toEqual(["1", "0xaaa", "label", "1", "0xbbb", "report"]);
  });

  it("keeps HSET chunks below the Redis Lua unpack stack ceiling", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const fields = Object.fromEntries(
      Array.from({ length: REDIS_HSET_FIELD_CHUNK_SIZE + 1 }, (_, index) => [
        `0x${index.toString(16).padStart(40, "0")}`,
        `label-${index}`,
      ]),
    );

    await replaceRedisHashes({ eval: evalMock }, [{ key: "labels", fields }]);

    const [, , argv] = evalMock.mock.calls[0]!;
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
    const evalMock = vi.fn().mockResolvedValue(1);
    // Each replacement is ~6 MB; combined ~12 MB > 8 MB cap. Neither fits
    // with another, so greedy-pack puts each in its own batch.
    const bigField = "x".repeat(6 * 1024 * 1024);
    await replaceRedisHashes({ eval: evalMock }, [
      { key: "labels", fields: { "0xaaa": bigField } },
      { key: "reports", fields: { "0xbbb": bigField } },
    ]);
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[0]?.[1]).toEqual(["labels"]);
    expect(evalMock.mock.calls[1]?.[1]).toEqual(["reports"]);
  });

  it("keeps small hashes packed together when only a later large hash forces a split", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    // labels + reports together = 2 MB; arkham_deep alone = 7 MB. Combined
    // 9 MB > 8 MB cap. Greedy-pack puts labels+reports in one EVAL (their
    // 2 MB fits, atomic invariant preserved), arkham_deep in another.
    const oneMb = "z".repeat(1024 * 1024);
    const sevenMb = "z".repeat(7 * 1024 * 1024);
    await replaceRedisHashes({ eval: evalMock }, [
      { key: "labels", fields: { "0xaaa": oneMb } },
      { key: "reports", fields: { "0xbbb": oneMb } },
      { key: "arkham_deep", fields: { "0xccc": sevenMb } },
    ]);
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[0]?.[1]).toEqual(["labels", "reports"]);
    expect(evalMock.mock.calls[1]?.[1]).toEqual(["arkham_deep"]);
  });

  it("rejects a single-hash payload above the cap before any write (preflight)", async () => {
    const evalMock = vi.fn();
    const huge = "x".repeat(9 * 1024 * 1024);
    await expect(
      replaceRedisHashes({ eval: evalMock }, [
        { key: "labels", fields: { "0xaaa": "ok" } },
        { key: "reports", fields: { "0xbbb": huge } },
      ]),
    ).rejects.toThrow(/Redis hash replacement payload for reports exceeds/);
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe("mergeRedisHashes", () => {
  it("merges multiple hashes in one EVAL payload without deleting keys", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);

    await mergeRedisHashes({ eval: evalMock }, [
      { key: "labels", fields: { "0xaaa": "label" } },
      { key: "reports", fields: { "0xbbb": "report" } },
    ]);

    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keys, argv] = evalMock.mock.calls[0]!;
    expect(script).toContain(
      `local hsetFieldChunkSize = ${REDIS_HSET_FIELD_CHUNK_SIZE}`,
    );
    expect(script).not.toContain("redis.call('DEL', key)");
    expect(script).toContain("redis.call('HSET', key");
    expect(keys).toEqual(["labels", "reports"]);
    expect(argv).toEqual(["1", "0xaaa", "label", "1", "0xbbb", "report"]);
  });

  it("skips empty merge replacements because merge mode must not clear hashes", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);

    await mergeRedisHashes({ eval: evalMock }, [
      { key: "labels", fields: {} },
      { key: "reports", fields: {} },
    ]);

    expect(evalMock).not.toHaveBeenCalled();
  });
});
