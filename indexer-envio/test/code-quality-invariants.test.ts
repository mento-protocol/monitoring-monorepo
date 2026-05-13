import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dailySnapshotId,
  dayBucket,
  asBigInt,
  eventId,
  extractAddressFromPoolId,
  hourBucket,
  makePoolId,
  snapshotId,
} from "../src/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(packageRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) return sourceFiles(absolute);
    return absolute.endsWith(".ts") ? [absolute] : [];
  });
}

describe("indexer code quality invariants", () => {
  it("does not hardcode mainnet-only chain iteration in source", () => {
    const mainnetPairPattern = /\[\s*(?:42220\s*,\s*143|143\s*,\s*42220)\s*\]/;
    const offenders = sourceFiles(srcRoot)
      .filter((file) => mainnetPairPattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(packageRoot, file));

    assert.deepEqual(offenders, []);
  });

  it("keeps event IDs collision-resistant within a same-block write batch", () => {
    assert.equal(eventId(42220, 123, 4), "42220_123_4");
    assert.notEqual(eventId(42220, 123, 4), eventId(143, 123, 4));
    assert.notEqual(eventId(42220, 123, 4), eventId(42220, 124, 4));
    assert.notEqual(eventId(42220, 123, 4), eventId(42220, 123, 5));
    assert.equal(asBigInt(123), 123n);
  });

  it("keeps pool IDs chain-namespaced and lowercased", () => {
    const poolId = makePoolId(
      42220,
      "0xABCDEF0000000000000000000000000000000001",
    );

    assert.equal(poolId, "42220-0xabcdef0000000000000000000000000000000001");
    assert.equal(
      extractAddressFromPoolId(poolId),
      "0xabcdef0000000000000000000000000000000001",
    );
    assert.throws(
      () =>
        extractAddressFromPoolId("0xabcdef0000000000000000000000000000000001"),
      /Expected namespaced pool ID/,
    );
    assert.throws(
      () =>
        extractAddressFromPoolId(
          "prefix-42220-0xabcdef0000000000000000000000000000000001",
        ),
      /Expected namespaced pool ID/,
    );
    assert.throws(
      () =>
        extractAddressFromPoolId(
          "42220-42220-0xabcdef0000000000000000000000000000000001",
        ),
      /Possible double-namespacing/,
    );
  });

  it("keeps snapshot IDs anchored to the chain-namespaced pool ID", () => {
    const poolId = makePoolId(
      42220,
      "0xABCDEF0000000000000000000000000000000001",
    );

    assert.equal(
      snapshotId(poolId, 1_700_000_000n),
      "42220-0xabcdef0000000000000000000000000000000001-1700000000",
    );
    assert.equal(
      dailySnapshotId(poolId, 1_699_977_600n),
      "42220-0xabcdef0000000000000000000000000000000001-1699977600",
    );
  });

  it("keeps UTC hour/day buckets as floor operations", () => {
    assert.equal(hourBucket(3_599n), 0n);
    assert.equal(hourBucket(3_600n), 3_600n);
    assert.equal(hourBucket(3_601n), 3_600n);

    assert.equal(dayBucket(86_399n), 0n);
    assert.equal(dayBucket(86_400n), 86_400n);
    assert.equal(dayBucket(86_401n), 86_400n);
  });
});
