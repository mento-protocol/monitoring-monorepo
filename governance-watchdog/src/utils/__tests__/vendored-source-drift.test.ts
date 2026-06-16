import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(__dirname, "..", "..", "..");
const repoRoot = join(packageRoot, "..");

const read = (path: string) => readFileSync(path, "utf8");

describe("vendored shared-source files stay byte-identical", () => {
  // Behavioral coverage for this vendored HMAC helper lives in
  // alerts/infra/onchain-event-handler/src/quicknode-hmac.test.ts; byte
  // identity keeps that coverage applicable to the governance-watchdog copy.
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
