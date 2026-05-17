import { describe, expect, it, vi } from "vitest";
import {
  flattenHashReplacements,
  MAX_REDIS_HASH_REPLACE_BYTES,
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

  it("rejects payloads above the safe Upstash request budget before EVAL", async () => {
    const evalMock = vi.fn();
    const byteLengthSpy = vi
      .spyOn(Buffer, "byteLength")
      .mockReturnValueOnce(MAX_REDIS_HASH_REPLACE_BYTES + 1);

    await expect(
      replaceRedisHashes({ eval: evalMock }, [
        { key: "reports", fields: { "0xaaa": "report" } },
      ]),
    ).rejects.toThrow(/Redis hash replacement payload exceeds/);

    expect(evalMock).not.toHaveBeenCalled();
    byteLengthSpy.mockRestore();
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
