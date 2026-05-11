import { describe, expect, it, vi } from "vitest";
import {
  flattenHashReplacements,
  MAX_REDIS_HASH_REPLACE_BYTES,
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
    const [, keys, argv] = evalMock.mock.calls[0]!;
    expect(keys).toEqual(["labels", "reports"]);
    expect(argv).toEqual(["1", "0xaaa", "label", "1", "0xbbb", "report"]);
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
