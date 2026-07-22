import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "envio";
import { requireExactMedianTimestamp } from "../src/handlers/exact-median-timestamp.js";

const INDEXER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST_CLI = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

function captureLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
  } as Logger;
  return { logger, errors };
}

describe("requireExactMedianTimestamp", () => {
  it("returns exact contract responses including zero", () => {
    const { logger, errors } = captureLogger();
    assert.equal(
      requireExactMedianTimestamp({
        timestamp: 0n,
        eventName: "MedianUpdated",
        chainId: 137,
        rateFeedID: "0xfeed",
        blockNumber: 90_450_421n,
        log: logger,
      }),
      0n,
    );
    assert.deepEqual(errors, []);
  });

  for (const eventName of ["OracleReported", "MedianUpdated"] as const) {
    it(`throws and logs when ${eventName} has no exact timestamp`, () => {
      const { logger, errors } = captureLogger();
      assert.throws(
        () =>
          requireExactMedianTimestamp({
            timestamp: null,
            eventName,
            chainId: 137,
            rateFeedID: "0xfeed",
            blockNumber: 90_450_421n,
            log: logger,
          }),
        new RegExp(
          `sortedOracles\\.exactMedianTimestampUnavailable event=${eventName} chainId=137 feed=0xfeed block=90450421`,
        ),
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /exactMedianTimestampUnavailable/);
    });
  }

  for (const eventName of ["OracleReported", "MedianUpdated"] as const) {
    it(`rejects tracked ${eventName} before committing writes`, () => {
      const result = spawnSync(
        process.execPath,
        [VITEST_CLI, "run", "--config", "vitest.fail-closed.config.ts"],
        {
          cwd: INDEXER_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            SORTED_ORACLES_FAILURE_EVENT: eventName,
          },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, output);
    });
  }
});
