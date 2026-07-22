import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INDEXER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST_CLI = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

describe("SortedOracles feed-state fail-closed boundary", () => {
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
