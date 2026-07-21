import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(__dirname, "..");
const repoRoot = join(packageRoot, "..", "..", "..");
const regressionScript = join(
  packageRoot,
  "..",
  "scripts",
  "fix-webhook-state.test.sh",
);

describe("QuickNode webhook state tooling", () => {
  it("passes the provider-v3 parser and fail-closed regression suite", () => {
    const result = spawnSync("bash", [regressionScript], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
