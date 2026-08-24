import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ExactFixtureProcesses,
  childrenOf,
  directAncestor,
  identityMatches,
  processAlive,
  processRunning,
  processStartUtc,
} from "./agent-quality-gate-fixture-processes.mjs";
import {
  makeGateHandle,
  readEvents,
} from "./agent-quality-gate-scheduler-fixture-support.mjs";
import { stubTrunk } from "./agent-quality-gate-scheduler-tool-fixture.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(moduleDirectory, "../..");
const gateScript = join(sourceRoot, "scripts/agent-quality-gate.sh");
const coordinatorScript = join(
  sourceRoot,
  "scripts/gate/quality-gate-coordinator.mjs",
);

function assertSafeTemporaryRoot(root) {
  const resolved = resolve(root);
  const allowedParents = new Set([resolve("/tmp"), resolve(tmpdir())]);
  if (
    !basename(resolved).startsWith("qg2006-") ||
    !allowedParents.has(dirname(resolved))
  ) {
    throw new Error(`refusing to remove unexpected fixture root: ${resolved}`);
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function processCommand(pid) {
  const { stdout } = await run("ps", [
    "-ww",
    "-o",
    "command=",
    "-p",
    String(pid),
  ]);
  return stdout.trim();
}

export async function waitUntil(
  probe,
  { timeoutMs = 10_000, intervalMs = 50, message = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, intervalMs),
    );
  }
  throw new Error(
    `timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function initializeRepository(repository) {
  await mkdir(join(repository, "tools"), { recursive: true });
  await mkdir(join(repository, "scripts/gate"), { recursive: true });
  await run("git", ["init", "-q", repository]);
  await run("git", ["config", "user.email", "quality-gate@example.invalid"], {
    cwd: repository,
  });
  await run("git", ["config", "user.name", "Quality Gate Fixture"], {
    cwd: repository,
  });
  const sourceManifest = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  );
  await writeFile(join(repository, ".gitignore"), ".tmp/\nnode_modules/\n");
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "quality-gate-scheduler-fixture",
        private: true,
        packageManager: sourceManifest.packageManager,
        scripts: { "agent:quality-gate": gateScript },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(repository, "pnpm-workspace.yaml"),
    "packages: []\nverifyDepsBeforeRun: false\n",
  );
  await writeFile(join(repository, "scripts/gate/.keep"), "fixture\n");
  await writeFile(join(repository, "tools/trunk"), stubTrunk);
  await chmod(join(repository, "tools/trunk"), 0o755);
  for (const name of [
    "fixture-a.txt",
    "fixture-b.txt",
    "fixture-c.txt",
    "fixture-crash.txt",
    "fixture-full.txt",
    "fixture-same.txt",
    "fixture-short-a.txt",
    "fixture-short-b.txt",
  ]) {
    await writeFile(join(repository, name), `${name}\n`);
  }
  await run("git", ["add", "."], { cwd: repository });
  await run("git", ["commit", "-q", "-m", "seed gate fixture"], {
    cwd: repository,
  });
  await writeFile(join(repository, "baseline.txt"), "second revision\n");
  await run("git", ["add", "baseline.txt"], { cwd: repository });
  await run("git", ["commit", "-q", "-m", "add comparison revision"], {
    cwd: repository,
  });
}

async function coordinatorMetadata(lockRoot) {
  if (!(await pathExists(lockRoot))) return [];
  const entries = await readdir(lockRoot, { withFileTypes: true });
  const metadata = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("qgc-v1-")) {
      continue;
    }
    const root = join(lockRoot, entry.name);
    try {
      metadata.push({
        root,
        value: JSON.parse(
          await readFile(join(root, "coordinator.json"), "utf8"),
        ),
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return metadata;
}

async function coordinatorCli(metadata, args) {
  return run(
    "node",
    [
      coordinatorScript,
      ...args,
      "--root",
      metadata.root,
      "--policy-hash",
      metadata.value.policyHash,
    ],
    { cwd: sourceRoot },
  );
}

async function coordinatorStatus(metadata) {
  if (!(await pathExists(metadata.value.socketPath))) return null;
  try {
    const { stdout } = await coordinatorCli(metadata, ["status"]);
    return JSON.parse(stdout);
  } catch (error) {
    if (!(await pathExists(metadata.value.socketPath))) return null;
    throw error;
  }
}

function coordinatorErrorCode(error) {
  try {
    return JSON.parse(String(error.stderr)).error?.code ?? null;
  } catch {
    return null;
  }
}

export function intervalMetrics(events) {
  const byTimestamp = (left, right) => left.timestampMs - right.timestampMs;
  const open = new Map();
  const intervals = [];
  for (const event of [...events].sort(byTimestamp)) {
    if (event.event === "start") open.set(event.label, event.timestampMs);
    if (event.event === "end" && open.has(event.label)) {
      intervals.push({
        label: event.label,
        startMs: open.get(event.label),
        endMs: event.timestampMs,
      });
      open.delete(event.label);
    }
  }
  const transitions = intervals
    .flatMap((interval) => [
      { timestampMs: interval.startMs, delta: 1 },
      { timestampMs: interval.endMs, delta: -1 },
    ])
    .sort(
      (left, right) => byTimestamp(left, right) || left.delta - right.delta,
    );
  let active = 0;
  let maxConcurrency = 0;
  for (const transition of transitions) {
    active += transition.delta;
    maxConcurrency = Math.max(maxConcurrency, active);
  }
  return { intervals, maxConcurrency };
}

export async function createGateFixture() {
  const root = await mkdtemp(join("/tmp", "qg2006-"));
  assertSafeTemporaryRoot(root);
  const repository = join(root, "repository");
  await initializeRepository(repository);
  const worktrees = [];
  const gateHandles = new Set();
  const lockRoots = new Set();
  const fixtureProcesses = new ExactFixtureProcesses();
  let sequence = 0;
  let worktreeQueue = Promise.resolve();

  function addWorktree(name = `worktree-${worktrees.length + 1}`) {
    const operation = worktreeQueue.then(async () => {
      const path = join(root, name);
      await run("git", ["worktree", "add", "-q", "--detach", path, "HEAD"], {
        cwd: repository,
      });
      worktrees.push(path);
      return path;
    });
    worktreeQueue = operation.catch(() => {});
    return operation;
  }

  function scenarioPaths(name) {
    const directory = join(root, `scenario-${name}`);
    return {
      directory,
      eventLog: join(directory, "events.jsonl"),
      lockRoot: join(directory, "lock"),
      pidFile: join(directory, "worker-pids"),
    };
  }

  async function preparePnpmWorktree(worktree) {
    const physicalWorktree = await realpath(worktree);
    const localBin = join(worktree, "node_modules", ".bin");
    const wrapper = join(localBin, "fixture-tool");
    await mkdir(localBin, { recursive: true });
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        `# cmd-shim-target=${physicalWorktree}/node_modules/fixture-tool/bin/tool.mjs`,
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);
  }

  async function gitProbeFailureEnvironment(scenario) {
    const bin = join(scenario.directory, "failing-git-bin");
    const countFile = join(scenario.directory, "unstaged-diff-count");
    await mkdir(bin, { recursive: true });
    const wrapper = join(bin, "git");
    await writeFile(
      wrapper,
      `#!/bin/sh
set -eu
if [ "$#" -eq 3 ] && [ "$1" = "diff" ] && [ "$2" = "--name-only" ] && [ "$3" = "--no-renames" ]; then
  count=0
  if [ -f "\${QG_FIXTURE_GIT_COUNT_FILE}" ]; then
    count="$(cat "\${QG_FIXTURE_GIT_COUNT_FILE}")"
  fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "\${QG_FIXTURE_GIT_COUNT_FILE}"
  if [ "$count" -eq 2 ]; then
    exit 91
  fi
fi
PATH="\${QG_FIXTURE_ORIGINAL_PATH}" exec git "$@"
`,
    );
    await chmod(wrapper, 0o755);
    return {
      PATH: `${bin}:${process.env.PATH}`,
      QG_FIXTURE_ORIGINAL_PATH: process.env.PATH,
      QG_FIXTURE_GIT_COUNT_FILE: countFile,
    };
  }

  async function startGate({
    worktree,
    changedPath,
    scenario,
    label,
    coordinator = true,
    defaultDelayMs = 250,
    fullDelayMs = 4_000,
    shortDelayMs = 500,
    allowPackageScriptChanges = false,
    skipIfFresh = false,
    useChangedPathsFile = true,
    commandTimeoutSeconds = 30,
    lockWaitSeconds = 30,
    qualityParallelism = 1,
    failFast = false,
    extraEnvironment = {},
    publicPnpm = false,
  }) {
    await mkdir(scenario.directory, { recursive: true });
    await mkdir(scenario.lockRoot, { recursive: true });
    lockRoots.add(scenario.lockRoot);
    sequence += 1;
    const pathsFile = join(scenario.directory, `paths-${sequence}.txt`);
    await writeFile(pathsFile, `${changedPath}\n`);
    const startedAtMs = Date.now();
    const gateEnvironment = {
      ...process.env,
      CI: "true",
      NODE_ENV: "test",
      TURBO_CACHE_DIR: join(root, "turbo-cache"),
      AGENT_TURBO_SHARED_CACHE: "0",
      AGENT_QUALITY_GATE_LOCK: "1",
      AGENT_QUALITY_GATE_COORDINATOR: coordinator ? "1" : "0",
      AGENT_QUALITY_GATE_CAPACITY: "3",
      AGENT_QUALITY_GATE_LOCK_DIR: scenario.lockRoot,
      AGENT_QUALITY_GATE_LOCK_POLL_SECONDS: "1",
      QG_FIXTURE_EVENT_LOG: scenario.eventLog,
      QG_FIXTURE_LABEL: label,
      QG_FIXTURE_PID_FILE: scenario.pidFile,
      QG_FIXTURE_DEFAULT_DELAY_MS: String(defaultDelayMs),
      QG_FIXTURE_FULL_DELAY_MS: String(fullDelayMs),
      QG_FIXTURE_SHORT_DELAY_MS: String(shortDelayMs),
      ...extraEnvironment,
    };
    // The parent Bash suite disables locking, and a parent quality gate exports
    // its own held token. Neither authority applies to this isolated lock root.
    delete gateEnvironment.AGENT_QUALITY_GATE_LOCK_HELD;
    const gateArguments = [
      "--run",
      "--base",
      "HEAD^",
      "--head",
      "HEAD",
      "--parallel",
      String(qualityParallelism),
      "--command-timeout",
      String(commandTimeoutSeconds),
      "--lock-wait",
      String(lockWaitSeconds),
    ];
    if (useChangedPathsFile) {
      gateArguments.push("--changed-paths-file", pathsFile);
    }
    if (allowPackageScriptChanges) {
      gateArguments.push("--allow-package-script-changes");
    }
    if (skipIfFresh) gateArguments.push("--skip-if-fresh");
    if (failFast) gateArguments.push("--fail-fast");
    if (publicPnpm) await preparePnpmWorktree(worktree);
    const child = spawn(
      publicPnpm ? "pnpm" : "/bin/bash",
      publicPnpm
        ? ["agent:quality-gate", ...gateArguments]
        : [gateScript, ...gateArguments],
      {
        cwd: worktree,
        env: gateEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const handle = makeGateHandle(child, {
      label,
      changedPath,
      worktree,
      startedAtMs,
    });
    gateHandles.add(handle);
    void handle.done.finally(() => gateHandles.delete(handle));
    return handle;
  }

  function startPnpmGate(options) {
    return startGate({ ...options, publicPnpm: true });
  }

  async function events(scenario) {
    return readEvents(scenario.eventLog);
  }

  async function waitForEvent(
    scenario,
    predicate,
    message,
    timeoutMs = 15_000,
  ) {
    const event = await waitUntil(
      async () => (await events(scenario)).find(predicate),
      { timeoutMs, message },
    );
    if (event.event === "descendant") {
      await fixtureProcesses.track(event.shellPid);
      await fixtureProcesses.track(event.descendantPid);
    }
    return event;
  }

  async function waitForDrain(scenario) {
    return waitUntil(
      async () => {
        for (const metadata of await coordinatorMetadata(scenario.lockRoot)) {
          const status = await coordinatorStatus(metadata);
          if (status?.drainObligations?.length) return status;
        }
        return null;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        message: "a stale drain obligation",
      },
    );
  }

  async function coordinatorRequest(scenario, requestId) {
    for (const metadata of await coordinatorMetadata(scenario.lockRoot)) {
      const status = await coordinatorStatus(metadata);
      const request = status?.requests?.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (request) return request;
    }
    return null;
  }

  async function killLeaderWithoutWatchdog(handle, stubPid, descendantPid) {
    const commandRoot = await directAncestor(stubPid, handle.child.pid);
    await fixtureProcesses.track(commandRoot);
    await fixtureProcesses.track(stubPid);
    await fixtureProcesses.track(descendantPid);
    const directChildren = await childrenOf(handle.child.pid);
    const siblingDetails = await Promise.all(
      directChildren
        .filter((pid) => pid !== commandRoot)
        .map(async (pid) => ({ pid, command: await processCommand(pid) })),
    );
    const registrationLifecycles = siblingDetails.filter(
      ({ command }) =>
        command.includes(coordinatorScript) &&
        command.includes(" register ") &&
        command.includes(" --bind-connection "),
    );
    if (registrationLifecycles.length !== 1) {
      throw new Error(
        `expected one bound-registration lifecycle beside command ${commandRoot}; found ${registrationLifecycles.map(({ pid }) => pid).join(",")}`,
      );
    }
    const watchdogs = siblingDetails.filter(
      ({ pid }) => pid !== registrationLifecycles[0].pid,
    );
    if (watchdogs.length !== 1) {
      throw new Error(
        `expected one watchdog beside command ${commandRoot}; found ${watchdogs.map(({ pid }) => pid).join(",")}`,
      );
    }
    process.kill(watchdogs[0].pid, "SIGKILL");
    await waitUntil(async () => !(await processRunning(watchdogs[0].pid)), {
      timeoutMs: 2_000,
      message: "the exact watchdog process to exit",
    });
    process.kill(handle.child.pid, "SIGKILL");
    await handle.done;
  }

  async function waitForCoordinatorsToIdle() {
    const allMetadata = (
      await Promise.all(
        [...lockRoots].map((lockRoot) => coordinatorMetadata(lockRoot)),
      )
    ).flat();
    await Promise.all(
      allMetadata.map(({ value }) =>
        waitUntil(
          async () => !(await identityMatches(value.coordinatorIdentity)),
          {
            timeoutMs: 12_000,
            intervalMs: 100,
            message: `coordinator ${value.coordinatorIdentity.pid} to exit idle`,
          },
        ),
      ),
    );
  }

  async function settleCoordinatorDrains() {
    const startUtc = await processStartUtc(process.pid);
    if (!startUtc) throw new Error("cannot read cleanup process identity");
    const identityArgs = [
      "--claimant-pid",
      String(process.pid),
      "--claimant-start-utc",
      startUtc,
    ];
    for (const lockRoot of lockRoots) {
      for (const metadata of await coordinatorMetadata(lockRoot)) {
        await waitUntil(
          async () => {
            const status = await coordinatorStatus(metadata);
            if (!status?.drainObligations?.length) return true;
            const byToken = new Map();
            for (const obligation of status.drainObligations) {
              const entries = byToken.get(obligation.drainIdentity) ?? [];
              entries.push(obligation);
              byToken.set(obligation.drainIdentity, entries);
            }
            for (const [drainIdentity, obligations] of byToken) {
              const first = obligations[0];
              try {
                await coordinatorCli(metadata, [
                  "claim-drain",
                  "--obligation-id",
                  first.obligationId,
                  "--drain-token",
                  drainIdentity,
                  ...identityArgs,
                ]);
              } catch (error) {
                if (coordinatorErrorCode(error) === "DRAIN_ALREADY_CLAIMED") {
                  continue;
                }
                if (
                  coordinatorErrorCode(error) === "DRAIN_OBLIGATION_NOT_FOUND"
                ) {
                  continue;
                }
                throw error;
              }
              for (const obligation of obligations) {
                try {
                  await coordinatorCli(metadata, [
                    "ack-drain",
                    "--obligation-id",
                    obligation.obligationId,
                    "--drain-token",
                    drainIdentity,
                    "--drainer-pid",
                    String(process.pid),
                    "--drainer-start-utc",
                    startUtc,
                    "--evidence-json",
                    '{"processTreeEmpty":true,"source":"integration-fixture-cleanup"}',
                  ]);
                } catch (error) {
                  if (
                    coordinatorErrorCode(error) !== "DRAIN_OBLIGATION_NOT_FOUND"
                  ) {
                    throw error;
                  }
                }
              }
            }
            return false;
          },
          {
            timeoutMs: 10_000,
            intervalMs: 100,
            message: "fixture drain obligations to settle",
          },
        );
      }
    }
  }

  async function cleanup() {
    for (const handle of [...gateHandles]) {
      if (!handle.settled && processAlive(handle.child.pid)) {
        process.kill(handle.child.pid, "SIGTERM");
      }
    }
    await Promise.all([...gateHandles].map((handle) => handle.done));
    await fixtureProcesses.stopAll();
    if (!(await fixtureProcesses.allStopped())) {
      throw new Error(
        "fixture process cleanup did not reach an empty process set",
      );
    }
    await settleCoordinatorDrains();
    await waitForCoordinatorsToIdle();
    for (const worktree of worktrees) {
      await run("git", ["worktree", "remove", "--force", worktree], {
        cwd: repository,
      });
    }
    assertSafeTemporaryRoot(root);
    await rm(root, { recursive: true, force: false });
  }

  return {
    root,
    repository,
    addWorktree,
    scenarioPaths,
    gitProbeFailureEnvironment,
    startGate,
    startPnpmGate,
    events,
    waitForEvent,
    waitForDrain,
    coordinatorRequest,
    killLeaderWithoutWatchdog,
    waitForCoordinatorsToIdle,
    cleanup,
    processAlive,
    processRunning,
  };
}
