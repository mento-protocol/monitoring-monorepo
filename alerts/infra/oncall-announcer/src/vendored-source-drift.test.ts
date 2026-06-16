import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(__dirname, "..");
const repoRoot = join(packageRoot, "..", "..", "..");

const read = (path: string) => readFileSync(path, "utf8");

describe("vendored shared-source files stay byte-identical", () => {
  it("gcp-logger.ts matches the onchain-event-handler copy", () => {
    expect(read(join(packageRoot, "src", "gcp-logger.ts"))).toBe(
      read(
        join(
          repoRoot,
          "alerts",
          "infra",
          "onchain-event-handler",
          "src",
          "gcp-logger.ts",
        ),
      ),
    );
  });
});
