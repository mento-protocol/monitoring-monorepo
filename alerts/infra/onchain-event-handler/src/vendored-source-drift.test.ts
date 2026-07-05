import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageRoot = join(__dirname, "..");
const repoRoot = join(packageRoot, "..", "..", "..");

const read = (path: string) => readFileSync(path, "utf8");

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

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

// quicknode-replay-protection.ts is NOT byte-identical to the
// governance-watchdog copy (this package logs via the GCP structured logger
// above, the sibling via console.*) — see the header comment on both files.
// This test instead pins the one contract that must stay in parity: neither
// function may process a webhook when the replay bucket is unconfigured.
// Keep the resolves.toEqual and fetchMock.not.toHaveBeenCalled assertions
// below literal-identical to the missing-bucket case in
// governance-watchdog/src/utils/__tests__/quicknode-replay-protection.test.ts.
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

  it("fails closed like the governance-watchdog copy when the bucket is unset", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { reserveQuickNodeNonce } =
      await import("./quicknode-replay-protection");

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
