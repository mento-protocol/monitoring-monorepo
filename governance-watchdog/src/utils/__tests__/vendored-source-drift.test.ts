import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// quicknode-replay-protection.ts is NOT byte-identical to the
// onchain-event-handler copy (this package logs via console.*, the sibling
// via a GCP structured logger it depends on) — see the header comment on
// both files. This test instead pins the one contract that must stay in
// parity: neither function may process a webhook when the replay bucket is
// unconfigured. Keep the resolves.toEqual and fetchMock.not.toHaveBeenCalled
// assertions below literal-identical to the missing-bucket case in
// alerts/infra/onchain-event-handler/src/quicknode-replay-protection.test.ts.
describe("quicknode-replay-protection.ts missing-bucket parity", () => {
  const originalReplayBucket = process.env.QUICKNODE_REPLAY_BUCKET;

  beforeEach(() => {
    delete process.env.QUICKNODE_REPLAY_BUCKET;
  });

  afterEach(() => {
    if (originalReplayBucket === undefined) {
      delete process.env.QUICKNODE_REPLAY_BUCKET;
    } else {
      process.env.QUICKNODE_REPLAY_BUCKET = originalReplayBucket;
    }
    vi.resetModules();
  });

  it("fails closed like the onchain-event-handler copy when the bucket is unset", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { reserveQuickNodeNonce } =
      await import("../quicknode-replay-protection.js");

    await expect(
      reserveQuickNodeNonce("nonce-1", "1700000000", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      valid: false,
      status: 500,
      message: "Server configuration error",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
