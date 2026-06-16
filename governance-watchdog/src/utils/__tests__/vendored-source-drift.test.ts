import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();
const repoRoot = join(packageRoot, "..");

const read = (path: string) => readFileSync(path, "utf8");

describe("vendored shared-source files stay byte-identical", () => {
  it("quicknode-hmac.ts matches the onchain-event-handler copy", () => {
    expect(read(join(packageRoot, "src", "utils", "quicknode-hmac.ts"))).toBe(
      read(
        join(
          repoRoot,
          "alerts",
          "infra",
          "onchain-event-handler",
          "src",
          "quicknode-hmac.ts",
        ),
      ),
    );
  });
});
