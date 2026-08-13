import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const WORKSPACE_POLICIES = [
  "alerts/infra/onchain-event-handler/pnpm-workspace.yaml",
  "alerts/infra/oncall-announcer/pnpm-workspace.yaml",
];

for (const policyPath of WORKSPACE_POLICIES) {
  test(`${policyPath} patches vulnerable uuid release lines`, () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "alerts-uuid-overrides-"));
    try {
      writeFileSync(
        join(fixtureRoot, "pnpm-workspace.yaml"),
        readFileSync(resolve(REPO_ROOT, policyPath), "utf8"),
      );
      writeFileSync(
        join(fixtureRoot, "package.json"),
        JSON.stringify({
          name: "alerts-uuid-overrides-fixture",
          private: true,
          dependencies: {
            uuid: "12.0.0",
            "uuid-13-consumer": "file:./uuid-13-consumer",
          },
        }),
      );
      const requestedManifest = JSON.parse(
        readFileSync(join(fixtureRoot, "package.json"), "utf8"),
      );
      assert.equal(requestedManifest.dependencies.uuid, "12.0.0");
      mkdirSync(join(fixtureRoot, "uuid-13-consumer"));
      writeFileSync(
        join(fixtureRoot, "uuid-13-consumer", "package.json"),
        JSON.stringify({
          name: "uuid-13-consumer",
          private: true,
          dependencies: { uuid: "13.0.0" },
        }),
      );
      const requestedConsumerManifest = JSON.parse(
        readFileSync(
          join(fixtureRoot, "uuid-13-consumer", "package.json"),
          "utf8",
        ),
      );
      assert.equal(requestedConsumerManifest.dependencies.uuid, "13.0.0");

      try {
        execFileSync(
          "pnpm",
          [
            "install",
            "--lockfile-only",
            "--ignore-scripts",
            "--lockfile-dir",
            ".",
            "--reporter",
            "silent",
          ],
          {
            cwd: fixtureRoot,
            env: { ...process.env, CI: "true" },
            stdio: "pipe",
          },
        );
      } catch (error) {
        const detail =
          error && typeof error === "object" && "stderr" in error
            ? String(error.stderr)
            : String(error);
        assert.fail(`pnpm lockfile-only fixture resolution failed:\n${detail}`);
      }

      const lockfile = readFileSync(
        join(fixtureRoot, "pnpm-lock.yaml"),
        "utf8",
      );
      assert.match(lockfile, /^ {2}uuid@12\.0\.1:/m);
      assert.match(lockfile, /^ {2}uuid@13\.0\.1:/m);
      assert.doesNotMatch(lockfile, /^ {2}uuid@12\.0\.0:/m);
      assert.doesNotMatch(lockfile, /^ {2}uuid@13\.0\.0:/m);
      assert.match(
        lockfile,
        /uuid:\n\s+specifier: 12\.0\.1\n\s+version: 12\.0\.1/,
        "pnpm must rewrite the direct 12.0.0 request to 12.0.1",
      );
      assert.match(
        lockfile,
        /uuid-13-consumer@file:uuid-13-consumer:[\s\S]*?dependencies:\n\s+uuid: 13\.0\.1/,
        "the local consumer's 13.0.0 request must resolve to 13.0.1",
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}
