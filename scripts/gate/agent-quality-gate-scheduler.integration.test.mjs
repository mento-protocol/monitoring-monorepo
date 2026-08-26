import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  createGateFixture,
  intervalMetrics,
  waitUntil,
} from "./agent-quality-gate-scheduler-fixture.mjs";
import { directAncestor } from "./agent-quality-gate-fixture-processes.mjs";
import { makeGateHandle } from "./agent-quality-gate-scheduler-fixture-support.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(moduleDirectory, "../..");
const observerTimeoutMs = 45_000;
const cleanupTimeoutMs = 10_000;

function assertPassed(result) {
  assert.equal(
    result.code,
    0,
    `${result.label} failed:\n${result.stdout}\n${result.stderr}`,
  );
}

test("directAncestor reports a vanished process as unproven ancestry", async () => {
  await assert.rejects(
    directAncestor(2_147_483_647, process.pid),
    /2147483647 is not a descendant of/u,
  );
});

async function copyCoordinatorRuntime(worktree) {
  const targetScripts = join(worktree, "scripts");
  const targetGate = join(targetScripts, "gate");
  const targetMapping = join(targetGate, "mapping");
  const targetRoutingTable = join(targetGate, "routing-table");
  const targetDocs = join(targetScripts, "docs");
  const targetLib = join(targetScripts, "lib");
  const sourceGate = join(sourceRoot, "scripts/gate");
  await mkdir(targetGate, { recursive: true });
  await mkdir(targetMapping, { recursive: true });
  await mkdir(targetRoutingTable, { recursive: true });
  await mkdir(targetDocs, { recursive: true });
  await mkdir(targetLib, { recursive: true });
  await copyFile(
    join(sourceRoot, "scripts/agent-quality-gate.sh"),
    join(targetScripts, "agent-quality-gate.sh"),
  );
  await copyFile(
    join(sourceRoot, "scripts/agent-autoreview-core.mjs"),
    join(targetScripts, "agent-autoreview-core.mjs"),
  );
  await copyFile(
    join(sourceRoot, "scripts/docs/docs-navigation-eval-helpers.mjs"),
    join(targetDocs, "docs-navigation-eval-helpers.mjs"),
  );
  await copyFile(
    join(sourceRoot, "scripts/lib/gh-issue-lifecycle.mjs"),
    join(targetLib, "gh-issue-lifecycle.mjs"),
  );
  await copyFile(
    join(sourceGate, "lockfile-scope.mjs"),
    join(targetGate, "lockfile-scope.mjs"),
  );
  await copyFile(
    join(sourceGate, "run-handles.sh"),
    join(targetGate, "run-handles.sh"),
  );
  await copyFile(
    join(sourceGate, "mapping.mjs"),
    join(targetGate, "mapping.mjs"),
  );
  for (const [sourceDirectory, targetDirectory] of [
    [join(sourceGate, "mapping"), targetMapping],
    [join(sourceGate, "routing-table"), targetRoutingTable],
  ]) {
    const modules = await readdir(sourceDirectory, { withFileTypes: true });
    await Promise.all(
      modules
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".mjs") &&
            !entry.name.endsWith(".test.mjs"),
        )
        .map((entry) =>
          copyFile(
            join(sourceDirectory, entry.name),
            join(targetDirectory, entry.name),
          ),
        ),
    );
  }
  const entries = await readdir(sourceGate, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith("quality-gate-coordinator"),
      )
      .map((entry) =>
        copyFile(join(sourceGate, entry.name), join(targetGate, entry.name)),
      ),
  );
}

async function startLocalRuntimeGate({ worktree, scenario, label }) {
  const canonicalWorktree = await realpath(worktree);
  const pathsFile = join(scenario.directory, `${label}-paths.txt`);
  await writeFile(pathsFile, "fixture-short-b.txt\n");
  const environment = {
    ...process.env,
    CI: "true",
    NODE_ENV: "test",
    AGENT_QUALITY_GATE_LOCK: "1",
    AGENT_QUALITY_GATE_COORDINATOR: "1",
    AGENT_QUALITY_GATE_CAPACITY: "3",
    AGENT_QUALITY_GATE_LOCK_DIR: scenario.lockRoot,
    AGENT_QUALITY_GATE_LOCK_POLL_SECONDS: "1",
    QG_FIXTURE_EVENT_LOG: scenario.eventLog,
    QG_FIXTURE_LABEL: label,
    QG_FIXTURE_SHORT_DELAY_MS: "100",
  };
  delete environment.AGENT_QUALITY_GATE_LOCK_HELD;
  const child = spawn(
    "/bin/bash",
    [
      join(canonicalWorktree, "scripts/agent-quality-gate.sh"),
      "--run",
      "--base",
      "HEAD^",
      "--head",
      "HEAD",
      "--parallel",
      "1",
      "--command-timeout",
      "30",
      "--lock-wait",
      "30",
      "--changed-paths-file",
      pathsFile,
    ],
    {
      cwd: canonicalWorktree,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return makeGateHandle(child, { label });
}

async function replayGateOwnerIdentityAfterExit(scenario) {
  const bin = join(scenario.directory, "replayed-owner-identity-bin");
  const ownerPidFile = join(scenario.directory, "replayed-owner-pid");
  const snapshotFile = join(scenario.directory, "replayed-owner-snapshot");
  await mkdir(bin, { recursive: true });
  const wrapper = join(bin, "ps");
  await writeFile(
    wrapper,
    `#!/bin/sh
set -eu
target=""
if [ -r "$QG_REPLAY_OWNER_PID_FILE" ]; then
  target="$(cat "$QG_REPLAY_OWNER_PID_FILE")"
fi
if [ "$#" -eq 6 ] && [ "$1" = "-o" ] && [ "$2" = "lstart=" ] && \
  [ "$3" = "-o" ] && [ "$4" = "stat=" ] && [ "$5" = "-p" ] && \
  [ -n "$target" ] && [ "$6" = "$target" ]; then
  output="$(/bin/ps "$@" 2>/dev/null || true)"
  if [ -n "$output" ]; then
    printf '%s\n' "$output" > "$QG_REPLAY_OWNER_SNAPSHOT_FILE"
    printf '%s\n' "$output"
    exit 0
  fi
  if [ -s "$QG_REPLAY_OWNER_SNAPSHOT_FILE" ]; then
    cat "$QG_REPLAY_OWNER_SNAPSHOT_FILE"
    exit 0
  fi
fi
exec /bin/ps "$@"
`,
  );
  await chmod(wrapper, 0o755);
  return {
    ownerPidFile,
    snapshotFile,
    environment: {
      PATH: `${bin}:${process.env.PATH}`,
      QG_REPLAY_OWNER_PID_FILE: ownerPidFile,
      QG_REPLAY_OWNER_SNAPSHOT_FILE: snapshotFile,
    },
  };
}

test("the real quality gate uses scheduler concurrency and recovery", async (t) => {
  const fixture = await createGateFixture();
  try {
    await t.test(
      "three distinct worktrees overlap at capacity three",
      async () => {
        const scenario = fixture.scenarioPaths("overlap");
        const startBarrier = join(scenario.directory, "start-barrier");
        const worktrees = await Promise.all([
          fixture.addWorktree("overlap-a"),
          fixture.addWorktree("overlap-b"),
          fixture.addWorktree("overlap-c"),
        ]);
        const handles = await Promise.all(
          worktrees.map((worktree, index) =>
            fixture.startGate({
              worktree,
              changedPath: `fixture-${String.fromCharCode(97 + index)}.txt`,
              scenario,
              label: `overlap-${index + 1}`,
              defaultDelayMs: 100,
              commandTimeoutSeconds: 60,
              extraEnvironment: {
                QG_FIXTURE_START_BARRIER: startBarrier,
              },
            }),
          ),
        );
        let barrierError;
        try {
          await waitUntil(
            async () =>
              (await fixture.events(scenario)).filter(
                (event) => event.event === "start",
              ).length === 3,
            {
              timeoutMs: observerTimeoutMs,
              intervalMs: 100,
              message: "three mapped commands to reach the start barrier",
            },
          );
        } catch (error) {
          barrierError = error;
        }
        await writeFile(`${startBarrier}.release`, "release\n");
        const results = await Promise.all(handles.map((handle) => handle.done));
        if (barrierError) throw barrierError;
        results.forEach(assertPassed);
        const metrics = intervalMetrics(await fixture.events(scenario));
        assert.equal(metrics.intervals.length, 3);
        assert.equal(metrics.maxConcurrency, 3);
      },
    );

    await t.test(
      "different symlink targets never share one execution",
      async () => {
        const scenario = fixture.scenarioPaths("symlink-fingerprints");
        const worktrees = await Promise.all([
          fixture.addWorktree("symlink-fingerprint-a"),
          fixture.addWorktree("symlink-fingerprint-b"),
        ]);
        await Promise.all(
          worktrees.flatMap((worktree, index) => [
            writeFile(join(worktree, `target-${index + 1}.txt`), "same\n"),
            symlink(
              `target-${index + 1}.txt`,
              join(worktree, "fixture-link.txt"),
            ),
          ]),
        );
        const handles = await Promise.all(
          worktrees.map((worktree, index) =>
            fixture.startGate({
              worktree,
              changedPath: "fixture-link.txt",
              scenario,
              label: `symlink-fingerprint-${index + 1}`,
              defaultDelayMs: 500,
            }),
          ),
        );
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        const starts = (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        );
        assert.deepEqual(starts.map((event) => event.label).sort(), [
          "symlink-fingerprint-1",
          "symlink-fingerprint-2",
        ]);
        assert.ok(
          results.every((result) => /role leader/u.test(result.stdout)),
        );
      },
    );

    await t.test(
      "identical fingerprints coalesce and reuse only when requested",
      async () => {
        const scenario = fixture.scenarioPaths("singleflight");
        const worktrees = await Promise.all([
          fixture.addWorktree("singleflight-a"),
          fixture.addWorktree("singleflight-b"),
          fixture.addWorktree("singleflight-refresh"),
          fixture.addWorktree("singleflight-active-cache"),
          fixture.addWorktree("singleflight-cached"),
        ]);
        const handles = await Promise.all(
          worktrees.slice(0, 2).map((worktree, index) =>
            fixture.startGate({
              worktree,
              changedPath: "fixture-same.txt",
              scenario,
              label: `singleflight-${index + 1}`,
              defaultDelayMs: 2_000,
            }),
          ),
        );
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        const starts = (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        );
        assert.equal(starts.length, 1, JSON.stringify(starts));
        assert.ok(results.some((result) => /role leader/u.test(result.stdout)));
        const follower = results.find((result) =>
          /role follower/u.test(result.stdout),
        );
        assert.ok(follower);
        assert.match(follower.stdout, /Shared coordinator execution passed/u);

        const refreshBarrier = join(
          scenario.directory,
          "singleflight-refresh-barrier",
        );
        let refreshReleased = false;
        const releaseRefresh = async () => {
          if (refreshReleased) return;
          await writeFile(`${refreshBarrier}.release`, "release\n");
          refreshReleased = true;
        };
        const refresh = await fixture.startGate({
          worktree: worktrees[2],
          changedPath: "fixture-same.txt",
          scenario,
          label: "singleflight-refresh",
          defaultDelayMs: 100,
          extraEnvironment: {
            QG_FIXTURE_START_BARRIER: refreshBarrier,
          },
        });
        let activeCache;
        try {
          await fixture.waitForEvent(
            scenario,
            (event) =>
              event.event === "start" && event.label === "singleflight-refresh",
            "the forced refresh execution",
          );
          activeCache = await fixture.startGate({
            worktree: worktrees[3],
            changedPath: "fixture-same.txt",
            scenario,
            label: "singleflight-active-cache",
            defaultDelayMs: 2_000,
            skipIfFresh: true,
          });
          await waitUntil(() => /role follower/u.test(activeCache.stdout), {
            timeoutMs: observerTimeoutMs,
            message: "the freshness request to join the active refresh",
          });
        } finally {
          await releaseRefresh();
        }
        const refreshResults = await Promise.all([
          refresh.done,
          activeCache.done,
        ]);
        refreshResults.forEach(assertPassed);
        assert.match(refreshResults[0].stdout, /role leader/u);
        assert.match(refreshResults[1].stdout, /role follower/u);
        assert.equal(
          (await fixture.events(scenario)).filter(
            (event) => event.event === "start",
          ).length,
          2,
        );

        const cached = await fixture.startGate({
          worktree: worktrees[4],
          changedPath: "fixture-same.txt",
          scenario,
          label: "singleflight-cached",
          defaultDelayMs: 2_000,
          skipIfFresh: true,
        });
        const cachedResult = await cached.done;
        assertPassed(cachedResult);
        assert.match(cachedResult.stdout, /role completed/u);
        assert.match(
          cachedResult.stdout,
          /Shared coordinator execution passed/u,
        );
        assert.equal(
          (await fixture.events(scenario)).filter(
            (event) => event.event === "start",
          ).length,
          2,
        );
      },
    );

    await t.test(
      "public pnpm lifecycle paths coalesce across linked worktrees",
      async () => {
        const scenario = fixture.scenarioPaths("public-pnpm-singleflight");
        const worktrees = await Promise.all([
          fixture.addWorktree("public-pnpm-singleflight-a"),
          fixture.addWorktree("public-pnpm-singleflight-b"),
        ]);
        const handles = await Promise.all(
          worktrees.map((worktree, index) =>
            fixture.startPnpmGate({
              worktree,
              changedPath: "fixture-same.txt",
              scenario,
              label: `public-pnpm-singleflight-${index + 1}`,
              defaultDelayMs: 2_000,
            }),
          ),
        );
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        const starts = (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        );
        assert.equal(starts.length, 1, JSON.stringify(starts));
        assert.ok(results.some((result) => /role leader/u.test(result.stdout)));
        const follower = results.find((result) =>
          /role follower/u.test(result.stdout),
        );
        assert.ok(follower);
        assert.match(follower.stdout, /Shared coordinator execution passed/u);
      },
    );

    await t.test(
      "public pnpm scrubs validator injections before shared execution",
      async () => {
        const scenario = fixture.scenarioPaths("public-pnpm-environment");
        const scrubbedEnvironment = (label) => ({
          AGENT_CONTEXT_CLAUDE_SETTINGS_FILE: `claude-${label}`,
          AGENT_CONTEXT_CODEX_HOOKS_FILE: `codex-${label}`,
          AGENT_QUALITY_GATE_LOCK_CLAIM_DELAY_SECONDS: "0",
          AGENT_QUALITY_GATE_LOCK_TEST_POISON: "same-parent-lock-control",
          AGENT_QUALITY_GATE_TEST_POISON: "same-parent-control",
          ALERT_RULES_LINT_RULES_DIR: `rules-${label}`,
          AUTOREVIEW_FAKE_MUTATE_REPO: `autoreview-mutation-${label}`,
          AUTOREVIEW_TEST_FOCUS: `autoreview-${label}`,
          AWS_CONFIG_FILE: `missing-aws-config-${label}`,
          CURL_FLAGS: `--header=fixture-${label}`,
          ESLINT_BASELINE_INPUT: `eslint-input-${label}`,
          ESLINT_BASELINE_MAIN: `eslint-main-${label}`,
          GATE_TEST_FOCUS: `gate-${label}`,
          GIT_DIR: `missing-git-dir-${label}`,
          GITHUB_ACTION_PINS_ROOT: `actions-${label}`,
          LOCKFILE_LINT_ROOT: `lockfile-${label}`,
          SENTRY_SUITE_GATE_ROOT: `sentry-${label}`,
          SKEW_CHECK_ROOT: `skew-${label}`,
          SKILLS_MIRROR_ROOT_A: `skills-${label}`,
          TRUNK_LAUNCHER_DEBUG: `debug-${label}`,
          TRUNK_LAUNCHER_PATH: `launcher-${label}`,
          TRUNK_LAUNCHER_QUIET: label === "a" ? "true" : "false",
          TRUNK_LAUNCHER_VERSION: `version-${label}`,
          TRUNK_QUIET: label === "a" ? "1" : "0",
          WGET_FLAGS: `--header=fixture-${label}`,
        });
        const worktrees = await Promise.all([
          fixture.addWorktree("public-pnpm-environment-a"),
          fixture.addWorktree("public-pnpm-environment-b"),
          fixture.addWorktree("public-pnpm-environment-cached"),
        ]);
        const handles = await Promise.all([
          fixture.startPnpmGate({
            worktree: worktrees[0],
            changedPath: "fixture-same.txt",
            scenario,
            label: "public-pnpm-environment-a",
            defaultDelayMs: 1_000,
            extraEnvironment: {
              QG_FIXTURE_ASSERT_SANITIZED_ENV: "1",
              ...scrubbedEnvironment("a"),
            },
          }),
          fixture.startPnpmGate({
            worktree: worktrees[1],
            changedPath: "fixture-same.txt",
            scenario,
            label: "public-pnpm-environment-b",
            defaultDelayMs: 1_000,
            extraEnvironment: {
              QG_FIXTURE_ASSERT_SANITIZED_ENV: "1",
              ...scrubbedEnvironment("b"),
            },
          }),
        ]);
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        const starts = (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        );
        assert.equal(starts.length, 1, JSON.stringify(starts));
        assert.ok(results.some((result) => /role leader/u.test(result.stdout)));
        assert.ok(
          results.some((result) => /role follower/u.test(result.stdout)),
        );

        const cached = await fixture.startPnpmGate({
          worktree: worktrees[2],
          changedPath: "fixture-same.txt",
          scenario,
          label: "public-pnpm-environment-cached",
          defaultDelayMs: 1_000,
          skipIfFresh: true,
          extraEnvironment: {
            QG_FIXTURE_ASSERT_SANITIZED_ENV: "1",
            ...scrubbedEnvironment("cached"),
          },
        });
        const cachedResult = await cached.done;
        assertPassed(cachedResult);
        assert.match(cachedResult.stdout, /role completed/u);
        assert.equal(
          (await fixture.events(scenario)).filter(
            (event) => event.event === "start",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "public pnpm clears Bash startup controls from shared mapped execution",
      async () => {
        const scenario = fixture.scenarioPaths("public-pnpm-bash-env");
        const worktrees = await Promise.all([
          fixture.addWorktree("public-pnpm-bash-env-a"),
          fixture.addWorktree("public-pnpm-bash-env-b"),
          fixture.addWorktree("public-pnpm-bash-env-cached"),
        ]);
        const startupFiles = worktrees.map((_, index) =>
          join(scenario.directory, `bash-env-${index + 1}.sh`),
        );
        await mkdir(scenario.directory, { recursive: true });
        await Promise.all(
          startupFiles.map((path, index) =>
            writeFile(
              path,
              `# distinct startup file ${index + 1}\ncase "$0" in\n  agentqg:*) exit 0 ;;\nesac\n`,
            ),
          ),
        );

        const handles = await Promise.all(
          worktrees.slice(0, 2).map((worktree, index) =>
            fixture.startPnpmGate({
              worktree,
              changedPath: "fixture-same.txt",
              scenario,
              label: `public-pnpm-bash-env-${index + 1}`,
              defaultDelayMs: 1_000,
              extraEnvironment: { BASH_ENV: startupFiles[index] },
            }),
          ),
        );
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        const startsAfterSharedRun = (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        );
        assert.equal(
          startsAfterSharedRun.length,
          1,
          JSON.stringify(startsAfterSharedRun),
        );
        assert.ok(results.some((result) => /role leader/u.test(result.stdout)));
        assert.ok(
          results.some((result) => /role follower/u.test(result.stdout)),
        );

        const cached = await fixture.startPnpmGate({
          worktree: worktrees[2],
          changedPath: "fixture-same.txt",
          scenario,
          label: "public-pnpm-bash-env-cached",
          defaultDelayMs: 1_000,
          skipIfFresh: true,
          extraEnvironment: { BASH_ENV: startupFiles[2] },
        });
        const cachedResult = await cached.done;
        assertPassed(cachedResult);
        assert.match(cachedResult.stdout, /role completed/u);
        assert.equal(
          (await fixture.events(scenario)).filter(
            (event) => event.event === "start",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "public pnpm binds effective temp directories in the shared key",
      async () => {
        const scenario = fixture.scenarioPaths("public-pnpm-temp-environment");
        const worktrees = await Promise.all([
          fixture.addWorktree("public-pnpm-temp-environment-a"),
          fixture.addWorktree("public-pnpm-temp-environment-b"),
        ]);
        const tempDirectories = [
          join(scenario.directory, "temp-a"),
          join(scenario.directory, "temp-b"),
        ];
        await Promise.all(
          tempDirectories.map((directory) =>
            mkdir(directory, { recursive: true }),
          ),
        );
        const handles = await Promise.all(
          worktrees.map((worktree, index) =>
            fixture.startPnpmGate({
              worktree,
              changedPath: "fixture-same.txt",
              scenario,
              label: `public-pnpm-temp-environment-${index + 1}`,
              defaultDelayMs: 1_000,
              extraEnvironment: {
                TMPDIR: tempDirectories[index],
              },
            }),
          ),
        );
        const results = await Promise.all(handles.map((handle) => handle.done));
        results.forEach(assertPassed);
        assert.equal(
          (await fixture.events(scenario)).filter(
            (event) => event.event === "start",
          ).length,
          2,
        );
        results.forEach((result) =>
          assert.match(result.stdout, /role leader/u),
        );
      },
    );

    await t.test("execution controls are part of the shared key", async () => {
      const scenario = fixture.scenarioPaths("execution-controls");
      const worktrees = await Promise.all([
        fixture.addWorktree("execution-controls-a"),
        fixture.addWorktree("execution-controls-b"),
        fixture.addWorktree("execution-controls-c"),
      ]);
      const handles = await Promise.all([
        fixture.startGate({
          worktree: worktrees[0],
          changedPath: "fixture-same.txt",
          scenario,
          label: "execution-controls-30",
          defaultDelayMs: 2_000,
          commandTimeoutSeconds: 30,
        }),
        fixture.startGate({
          worktree: worktrees[1],
          changedPath: "fixture-same.txt",
          scenario,
          label: "execution-controls-31",
          defaultDelayMs: 2_000,
          commandTimeoutSeconds: 31,
        }),
        fixture.startGate({
          worktree: worktrees[2],
          changedPath: "fixture-same.txt",
          scenario,
          label: "execution-controls-parallel-2",
          defaultDelayMs: 2_000,
          commandTimeoutSeconds: 30,
          qualityParallelism: 2,
        }),
      ]);
      const results = await Promise.all(handles.map((handle) => handle.done));
      results.forEach(assertPassed);
      assert.equal(
        (await fixture.events(scenario)).filter(
          (event) => event.event === "start",
        ).length,
        3,
      );
    });

    await t.test(
      "mixed scheduler wait budgets keep independent request lifetimes",
      async () => {
        const scenario = fixture.scenarioPaths("mixed-lock-wait-budgets");
        const holderBarrier = join(scenario.directory, "holder-barrier");
        const worktrees = await Promise.all([
          fixture.addWorktree("mixed-lock-wait-holder"),
          fixture.addWorktree("mixed-lock-wait-short"),
          fixture.addWorktree("mixed-lock-wait-long"),
        ]);
        const capacityOne = { AGENT_QUALITY_GATE_CAPACITY: "1" };
        let holderReleased = false;
        const releaseHolder = async () => {
          if (holderReleased) return;
          await writeFile(`${holderBarrier}.release`, "release\n");
          holderReleased = true;
        };
        const holder = await fixture.startGate({
          worktree: worktrees[0],
          changedPath: "fixture-a.txt",
          scenario,
          label: "mixed-lock-wait-holder",
          defaultDelayMs: 100,
          lockWaitSeconds: 30,
          extraEnvironment: {
            ...capacityOne,
            QG_FIXTURE_START_BARRIER: holderBarrier,
          },
        });
        let shortHandle;
        let longHandle;
        let shortResult;
        try {
          await fixture.waitForEvent(
            scenario,
            (event) =>
              event.event === "start" &&
              event.label === "mixed-lock-wait-holder",
            "the capacity holder to start",
          );
          shortHandle = await fixture.startGate({
            worktree: worktrees[1],
            changedPath: "fixture-same.txt",
            scenario,
            label: "mixed-lock-wait-short",
            defaultDelayMs: 100,
            lockWaitSeconds: 5,
            extraEnvironment: capacityOne,
          });
          await waitUntil(() => /role leader/u.test(shortHandle.stdout), {
            timeoutMs: observerTimeoutMs,
            message: "the short-budget request to register as leader",
          });
          longHandle = await fixture.startGate({
            worktree: worktrees[2],
            changedPath: "fixture-same.txt",
            scenario,
            label: "mixed-lock-wait-long",
            defaultDelayMs: 100,
            lockWaitSeconds: 30,
            extraEnvironment: capacityOne,
          });
          await waitUntil(
            () => /role (?:leader|follower)/u.test(longHandle.stdout),
            {
              timeoutMs: observerTimeoutMs,
              message: "the long-budget request to register",
            },
          );
          shortResult = await shortHandle.done;
        } finally {
          await releaseHolder();
        }

        assert.equal(
          shortResult?.code,
          2,
          `short-budget request did not time out:\n${shortResult?.stdout ?? ""}\n${shortResult?.stderr ?? ""}`,
        );
        assert.match(shortResult.stderr, /command scheduler wait failed/u);
        const [holderResult, longResult] = await Promise.all([
          holder.done,
          longHandle.done,
        ]);
        assertPassed(holderResult);
        assertPassed(longResult);
        assert.match(longResult.stdout, /role leader/u);
        const startedLabels = (await fixture.events(scenario))
          .filter((event) => event.event === "start")
          .map((event) => event.label)
          .sort();
        assert.deepEqual(startedLabels, [
          "mixed-lock-wait-holder",
          "mixed-lock-wait-long",
        ]);
      },
    );

    await t.test(
      "changed-path recomputation fails when a later Git probe succeeds",
      async () => {
        for (const coordinator of [true, false]) {
          const mode = coordinator ? "coordinator" : "legacy";
          const scenario = fixture.scenarioPaths(`git-probe-${mode}`);
          const worktree = await fixture.addWorktree(`git-probe-${mode}`);
          await writeFile(join(worktree, "fixture-a.txt"), `${mode} change\n`);
          const handle = await fixture.startGate({
            worktree,
            changedPath: "fixture-a.txt",
            scenario,
            label: `git-probe-${mode}`,
            coordinator,
            skipIfFresh: !coordinator,
            useChangedPathsFile: false,
            extraEnvironment:
              await fixture.gitProbeFailureEnvironment(scenario),
          });
          const result = await handle.done;
          assert.equal(result.code, 2, `${mode}: ${result.stderr}`);
          assert.match(
            result.stderr,
            coordinator
              ? /could not compute the shared quality-gate execution fingerprint/u
              : /could not recompute the quality-gate stamp after the lock wait/u,
          );
          assert.equal((await fixture.events(scenario)).length, 0);
        }
      },
    );

    await t.test(
      "joining clients drain a killed leader descendant once",
      async () => {
        const scenario = fixture.scenarioPaths("stale-drain");
        const [leaderWorktree, joinAWorktree, joinBWorktree] =
          await Promise.all([
            fixture.addWorktree("stale-leader"),
            fixture.addWorktree("stale-join-a"),
            fixture.addWorktree("stale-join-b"),
          ]);
        const leader = await fixture.startGate({
          worktree: leaderWorktree,
          changedPath: "fixture-crash.txt",
          scenario,
          label: "stale-leader",
        });
        const descendant = await fixture.waitForEvent(
          scenario,
          (event) => event.event === "descendant",
          "the tagged crash descendant",
        );
        await fixture.killLeaderWithoutWatchdog(
          leader,
          descendant.shellPid,
          descendant.descendantPid,
        );
        assert.equal(
          await fixture.processRunning(descendant.descendantPid),
          true,
        );
        const draining = await fixture.waitForDrain(scenario);
        assert.equal(draining.drainObligations.length, 1);

        const joiners = await Promise.all([
          fixture.startGate({
            worktree: joinAWorktree,
            changedPath: "fixture-short-a.txt",
            scenario,
            label: "stale-join-a",
            shortDelayMs: 250,
          }),
          fixture.startGate({
            worktree: joinBWorktree,
            changedPath: "fixture-short-b.txt",
            scenario,
            label: "stale-join-b",
            shortDelayMs: 250,
          }),
        ]);
        const results = await Promise.all(joiners.map((handle) => handle.done));
        results.forEach(assertPassed);
        await waitUntil(
          async () => !(await fixture.processRunning(descendant.descendantPid)),
          {
            timeoutMs: observerTimeoutMs,
            message: "the tagged descendant to be drained",
          },
        );
        assert.ok(
          results.every(
            (result) => !result.stderr.includes("DRAIN_OBLIGATION_NOT_FOUND"),
          ),
        );
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a hard-killed follower does not leave its result waiter holding output open", async () => {
  const fixture = await createGateFixture();
  let leaderBarrier;
  let leaderReleased = false;
  const releaseLeader = async () => {
    if (!leaderBarrier || leaderReleased) return;
    await writeFile(`${leaderBarrier}.release`, "release\n");
    leaderReleased = true;
  };
  try {
    const [leaderWorktree, followerWorktree] = await Promise.all([
      fixture.addWorktree("killed-follower-leader"),
      fixture.addWorktree("killed-follower-client"),
    ]);
    const scenario = fixture.scenarioPaths("killed-follower");
    leaderBarrier = join(scenario.directory, "leader-start-barrier");
    const leader = await fixture.startGate({
      worktree: leaderWorktree,
      changedPath: "fixture-same.txt",
      scenario,
      label: "killed-follower-leader",
      defaultDelayMs: 100,
      extraEnvironment: {
        QG_FIXTURE_START_BARRIER: leaderBarrier,
      },
    });
    await fixture.waitForEvent(
      scenario,
      (event) =>
        event.event === "start" && event.label === "killed-follower-leader",
      "the shared execution leader",
    );
    const follower = await fixture.startGate({
      worktree: followerWorktree,
      changedPath: "fixture-same.txt",
      scenario,
      label: "killed-follower-client",
      defaultDelayMs: 10_000,
    });
    const requestId = await waitUntil(
      async () => {
        if (!/Coalesced wait:/u.test(follower.stdout)) return null;
        return follower.stdout.match(
          /Scheduler request ([^:]+): sequence [^,]+, role follower/u,
        )?.[1];
      },
      {
        timeoutMs: observerTimeoutMs,
        message: "the follower result wait to start",
      },
    );
    assert.equal(
      (await fixture.coordinatorRequest(scenario, requestId))?.role,
      "follower",
    );

    await fixture.signalGate(follower, "SIGKILL");
    await waitUntil(
      async () => !(await fixture.coordinatorRequest(scenario, requestId)),
      {
        timeoutMs: cleanupTimeoutMs,
        message: "the killed follower request to disappear",
      },
    );
    await waitUntil(() => follower.settled, {
      timeoutMs: cleanupTimeoutMs,
      message: "the orphaned follower wait process to close its output handles",
    });
    const followerResult = await follower.done;
    assert.equal(followerResult.signal, "SIGKILL");
    assert.equal(leader.settled, false);
    assert.equal(
      (await fixture.events(scenario)).some(
        (event) =>
          event.event === "end" && event.label === "killed-follower-leader",
      ),
      false,
    );

    await releaseLeader();
    assertPassed(await leader.done);
  } finally {
    await releaseLeader();
    await fixture.cleanup();
  }
});

test("the real adapter cleans a request when its gate parent disconnects", async () => {
  const fixture = await createGateFixture();
  let replay = null;
  let disconnectBarrier;
  let disconnectReleased = false;
  const releaseDisconnect = async () => {
    if (!disconnectBarrier || disconnectReleased) return;
    await writeFile(`${disconnectBarrier}.release`, "release\n");
    disconnectReleased = true;
  };
  try {
    const worktree = await fixture.addWorktree("bound-parent-disconnect");
    const scenario = fixture.scenarioPaths("bound-parent-disconnect");
    await mkdir(scenario.directory, { recursive: true });
    disconnectBarrier = join(scenario.directory, "gate-start-barrier");
    replay = await replayGateOwnerIdentityAfterExit(scenario);
    const gate = await fixture.startGate({
      worktree,
      changedPath: "fixture-short-a.txt",
      scenario,
      label: "bound-parent-disconnect",
      shortDelayMs: 100,
      extraEnvironment: {
        ...replay.environment,
        QG_FIXTURE_START_BARRIER: disconnectBarrier,
      },
    });
    await writeFile(replay.ownerPidFile, `${gate.child.pid}\n`);
    await fixture.waitForEvent(
      scenario,
      (event) =>
        event.event === "start" && event.label === "bound-parent-disconnect",
      "the bound gate command to start",
    );
    const requestId = await waitUntil(
      () =>
        gate.stdout.match(
          /Scheduler request ([^:]+): sequence [^,]+, role leader/u,
        )?.[1] ?? null,
      {
        timeoutMs: observerTimeoutMs,
        message: "the bound request registration",
      },
    );
    await waitUntil(
      async () => {
        try {
          return (await readFile(replay.snapshotFile, "utf8")).trim() || null;
        } catch {
          return null;
        }
      },
      {
        timeoutMs: observerTimeoutMs,
        message: "the gate owner identity snapshot",
      },
    );

    await fixture.signalGate(gate, "SIGKILL");
    const drained = await fixture.waitForDrain(scenario);
    const request = drained.requests.find(
      (candidate) => candidate.requestId === requestId,
    );
    assert.ok(request, JSON.stringify(drained.requests));
    assert.equal(request.state, "draining");
    assert.ok(
      drained.leases.some(
        (lease) =>
          lease.requestId === requestId && lease.status === "drain-required",
      ),
      JSON.stringify(drained.leases),
    );
    assert.equal(drained.drainObligations.length, 1);
  } finally {
    // Let fixture teardown use the real process table after the disconnect
    // assertion has proved that the replayed identity did not drive cleanup.
    if (replay) await writeFile(replay.ownerPidFile, "\n");
    await releaseDisconnect();
    await fixture.cleanup();
  }
});

test("a coordinator-disabled gate recovers a killed coordinator leader", async () => {
  const fixture = await createGateFixture();
  let descendantPid;
  try {
    const [leaderWorktree, legacyWorktree] = await Promise.all([
      fixture.addWorktree("legacy-recovery-leader"),
      fixture.addWorktree("legacy-recovery-client"),
    ]);
    const scenario = fixture.scenarioPaths("legacy-recovery");
    const leader = await fixture.startGate({
      worktree: leaderWorktree,
      changedPath: "fixture-crash.txt",
      scenario,
      label: "legacy-recovery-leader",
    });
    const descendant = await fixture.waitForEvent(
      scenario,
      (event) => event.event === "descendant",
      "the new-protocol leader descendant",
      observerTimeoutMs,
    );
    descendantPid = descendant.descendantPid;
    await fixture.killLeaderWithoutWatchdog(
      leader,
      descendant.shellPid,
      descendant.descendantPid,
    );
    assert.equal(await fixture.processRunning(descendantPid), true);

    const legacy = await fixture.startGate({
      worktree: legacyWorktree,
      changedPath: "fixture-short-a.txt",
      scenario,
      label: "legacy-recovery-client",
      coordinator: false,
      shortDelayMs: 250,
    });
    assertPassed(await legacy.done);
    await waitUntil(
      async () => !(await fixture.processRunning(descendantPid)),
      {
        timeoutMs: observerTimeoutMs,
        message: "the legacy gate to drain the coordinator descendant",
      },
    );
  } finally {
    await fixture.cleanup();
  }
  assert.equal(await fixture.processRunning(descendantPid), false);
});

test("coordinator startup rejects source mutation during the legacy-lock wait", async () => {
  const fixture = await createGateFixture();
  let waiter;
  let holderBarrier;
  let holderReleased = false;
  const releaseHolder = async () => {
    if (!holderBarrier || holderReleased) return;
    await writeFile(`${holderBarrier}.release`, "release\n");
    holderReleased = true;
  };
  try {
    const [holderWorktree, waiterWorktree] = await Promise.all([
      fixture.addWorktree("policy-drift-holder"),
      fixture.addWorktree("policy-drift-waiter"),
    ]);
    const scenario = fixture.scenarioPaths("policy-drift-during-wait");
    holderBarrier = join(scenario.directory, "holder-start-barrier");
    await copyCoordinatorRuntime(waiterWorktree);

    const holder = await fixture.startGate({
      worktree: holderWorktree,
      changedPath: "fixture-short-a.txt",
      scenario,
      label: "policy-drift-holder",
      coordinator: false,
      shortDelayMs: 100,
      extraEnvironment: {
        QG_FIXTURE_START_BARRIER: holderBarrier,
      },
    });
    await fixture.waitForEvent(
      scenario,
      (event) =>
        event.event === "start" && event.label === "policy-drift-holder",
      "the legacy holder to start its mapped command",
    );

    waiter = await startLocalRuntimeGate({
      worktree: waiterWorktree,
      scenario,
      label: "policy-drift-waiter",
    });
    await Promise.race([
      waitUntil(
        () =>
          waiter.stdout.includes("Waiting for the agent quality gate run lock"),
        {
          timeoutMs: observerTimeoutMs,
          message: "the coordinator client to finish policy preflight and wait",
        },
      ),
      waiter.done.then((result) => {
        throw new Error(
          `coordinator client exited before waiting:\n${result.stdout}\n${result.stderr}`,
        );
      }),
    ]);
    await writeFile(
      join(waiterWorktree, "scripts/gate/quality-gate-coordinator-policy.mjs"),
      "\n// policy drift injected after preflight\n",
      { flag: "a" },
    );

    await releaseHolder();
    assertPassed(await holder.done);
    const result = await waiter.done;
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /coordinator runtime or policy inputs changed while this gate waited/u,
    );
    assert.equal(
      (await fixture.events(scenario)).some(
        (event) => event.label === "policy-drift-waiter",
      ),
      false,
      "the stale-policy waiter ran a mapped command",
    );

    const remaining = await readdir(scenario.lockRoot, { recursive: true });
    assert.ok(
      !remaining.some((name) =>
        /qgc-v1-|coordinator\.(?:json|sock)|ready\./u.test(name),
      ),
      `coordinator startup left artifacts: ${remaining.join(", ")}`,
    );
    assert.ok(
      !remaining.some((name) =>
        /(?:^|\/)run\.lock(?:\/|$)|(?:^|\/)holder\./u.test(name),
      ),
      `legacy-lock cleanup left artifacts: ${remaining.join(", ")}`,
    );
  } finally {
    if (waiter && !waiter.settled) {
      waiter.child.kill("SIGTERM");
      await waiter.done;
    }
    await releaseHolder();
    await fixture.cleanup();
  }
});

test("fixture cleanup settles an abandoned stale drain", async () => {
  const fixture = await createGateFixture();
  let descendantPid;
  try {
    const worktree = await fixture.addWorktree("cleanup-stale");
    const scenario = fixture.scenarioPaths("cleanup-stale");
    const leader = await fixture.startGate({
      worktree,
      changedPath: "fixture-crash.txt",
      scenario,
      label: "cleanup-stale",
    });
    const descendant = await fixture.waitForEvent(
      scenario,
      (event) => event.event === "descendant",
      "the cleanup regression descendant",
    );
    descendantPid = descendant.descendantPid;
    await fixture.killLeaderWithoutWatchdog(
      leader,
      descendant.shellPid,
      descendant.descendantPid,
    );
    await fixture.waitForDrain(scenario);
  } finally {
    await fixture.cleanup();
  }
  assert.equal(await fixture.processRunning(descendantPid), false);
});

test("capacity changes reuse one outer coordinator root", async () => {
  const fixture = await createGateFixture();
  try {
    const scenario = fixture.scenarioPaths("capacity-namespaces");
    const [capacityTwoWorktree, capacityThreeWorktree] = await Promise.all([
      fixture.addWorktree("capacity-two"),
      fixture.addWorktree("capacity-three"),
    ]);
    const capacityTwo = await fixture.startGate({
      worktree: capacityTwoWorktree,
      changedPath: "fixture-short-a.txt",
      scenario,
      label: "capacity-two",
      shortDelayMs: 100,
      extraEnvironment: { AGENT_QUALITY_GATE_CAPACITY: "2" },
    });
    assertPassed(await capacityTwo.done);
    await fixture.waitForCoordinatorsToIdle();

    const capacityThree = await fixture.startGate({
      worktree: capacityThreeWorktree,
      changedPath: "fixture-short-b.txt",
      scenario,
      label: "capacity-three",
      shortDelayMs: 100,
      extraEnvironment: { AGENT_QUALITY_GATE_CAPACITY: "3" },
    });
    assertPassed(await capacityThree.done);

    const outerRoots = (
      await readdir(scenario.lockRoot, {
        withFileTypes: true,
      })
    ).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("qgc-v1-u"),
    );
    assert.equal(outerRoots.length, 1);
    assert.match(outerRoots[0].name, /^qgc-v1-u[0-9]+$/u);
    const namespaces = await readdir(
      join(scenario.lockRoot, outerRoots[0].name, "state"),
      { withFileTypes: true },
    );
    const stateDirectories = namespaces.filter((entry) => entry.isDirectory());
    assert.equal(stateDirectories.length, 2);
    assert.ok(stateDirectories.some((entry) => /-c2$/u.test(entry.name)));
    assert.ok(stateDirectories.some((entry) => /-c3$/u.test(entry.name)));
  } finally {
    await fixture.cleanup();
  }
});

test("an overlong socket path falls back to serialized legacy gates", async () => {
  const fixture = await createGateFixture();
  try {
    const scenario = fixture.scenarioPaths("long-socket-path");
    const longLockRoot = join(scenario.directory, "x".repeat(100));
    await mkdir(longLockRoot, { recursive: true });
    const worktrees = await Promise.all([
      fixture.addWorktree("long-path-a"),
      fixture.addWorktree("long-path-b"),
    ]);
    const handles = await Promise.all(
      worktrees.map((worktree, index) =>
        fixture.startGate({
          worktree,
          changedPath: `fixture-short-${index === 0 ? "a" : "b"}.txt`,
          scenario,
          label: `long-path-${index + 1}`,
          shortDelayMs: 500,
          extraEnvironment: {
            AGENT_QUALITY_GATE_LOCK_DIR: longLockRoot,
          },
        }),
      ),
    );
    await fixture.waitForEvent(
      scenario,
      (event) => event.event === "start",
      "the first serialized long-path command",
    );
    const ownerRecord = await readFile(
      join(longLockRoot, "run.lock", "owner"),
      "utf8",
    );
    const ownerToken = ownerRecord.match(/^token=(.+)$/mu)?.[1];
    assert.ok(ownerToken);
    assert.ok((await readdir(longLockRoot)).includes(`holder.${ownerToken}`));
    const results = await Promise.all(handles.map((handle) => handle.done));
    results.forEach(assertPassed);
    for (const result of results) {
      assert.match(
        result.stderr,
        /coordinator socket path is too long; this run uses the serialized legacy lock/u,
      );
    }
    const metrics = intervalMetrics(await fixture.events(scenario));
    assert.equal(metrics.intervals.length, 2);
    assert.equal(metrics.maxConcurrency, 1);
    const remaining = await readdir(longLockRoot, { recursive: true });
    assert.ok(
      !remaining.some((name) => /coordinator\.(?:json|sock)$/u.test(name)),
    );
    assert.ok(
      !remaining.some((name) => /(?:^|\/)run\.lock(?:\/|$)/u.test(name)),
    );
  } finally {
    await fixture.cleanup();
  }
});
