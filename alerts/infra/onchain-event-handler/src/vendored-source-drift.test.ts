import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(__dirname, "..");
const repoRoot = join(packageRoot, "..", "..", "..");

const read = (path: string) => readFileSync(path, "utf8");

describe("vendored shared-source files stay byte-identical", () => {
  it("quicknode-hmac.ts matches the governance-watchdog copy", () => {
    expect(read(join(packageRoot, "src", "quicknode-hmac.ts"))).toBe(
      read(
        join(
          repoRoot,
          "governance-watchdog",
          "src",
          "utils",
          "quicknode-hmac.ts",
        ),
      ),
    );
  });

  it("gcp-logger.ts matches the oncall-announcer copy", () => {
    expect(read(join(packageRoot, "src", "gcp-logger.ts"))).toBe(
      read(
        join(
          repoRoot,
          "alerts",
          "infra",
          "oncall-announcer",
          "src",
          "gcp-logger.ts",
        ),
      ),
    );
  });
});
