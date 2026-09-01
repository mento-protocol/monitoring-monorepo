// Filesystem isolation for untrusted finder and contestant model processes.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { canonicalPath } from "./review-eval-fixtures.mjs";
import { resetFixture } from "./review-eval-run-execution.mjs";
import { DEFAULT_EXPERIMENT_ROOT } from "./review-eval-experiment-contract.mjs";
import { claudeStdinArgv } from "./review-eval-experiment-process.mjs";

export const DEFAULT_EXPERIMENT_FIXTURE_ROOT = path.join(
  homedir(),
  ".cache",
  "mento-review-eval-experiment-fixtures",
);
export const DEFAULT_EXPERIMENT_ARTIFACT_ROOT = path.resolve(
  homedir(),
  DEFAULT_EXPERIMENT_ROOT.replace(/^~\/?/, ""),
);

export function defaultExperimentRunGit({
  args,
  cwd = process.cwd(),
  timeoutMs = undefined,
}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(Number.isFinite(timeoutMs)
      ? { timeout: Math.max(1, Math.floor(timeoutMs)) }
      : {}),
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr:
      result.stderr || (result.error ? `FATAL: ${result.error.message}` : ""),
  };
}

function quoteProfilePath(value) {
  const resolved = canonicalPath(value);
  if (resolved.includes("\0") || resolved.includes("\n")) {
    throw new Error("experiment sandbox path contains an invalid character");
  }
  return `"${resolved.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Enumerate every registered checkout that can contain the frozen truth. */
export function registeredExperimentWorktrees({
  repoRoot,
  exec = execFileSync,
} = {}) {
  const stdout = exec(
    "git",
    ["-C", repoRoot, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  );
  const roots = String(stdout)
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalPath(line.slice("worktree ".length)));
  if (roots.length === 0) {
    throw new Error("experiment sandbox found no registered worktrees");
  }
  return roots;
}

/** Keep every campaign and fixture cache inside its one denied global root. */
export function assertExperimentStorageRoot({
  target,
  base,
  label,
  allowBase = false,
  worktreeRoots = [],
}) {
  const canonicalBase = canonicalPath(base);
  const canonicalTarget = canonicalPath(target);
  const contained =
    canonicalTarget.startsWith(`${canonicalBase}${path.sep}`) ||
    (allowBase && canonicalTarget === canonicalBase);
  if (!contained) {
    throw new Error(`${label} must stay under ${canonicalBase}`);
  }
  for (const root of worktreeRoots.map((value) => canonicalPath(value))) {
    if (
      canonicalTarget === root ||
      canonicalTarget.startsWith(`${root}${path.sep}`) ||
      root.startsWith(`${canonicalTarget}${path.sep}`)
    ) {
      throw new Error(`${label} must stay outside every registered worktree`);
    }
  }
  return canonicalTarget;
}

/** Build one deny-first profile with a narrow exception for the active fixture. */
export function buildExperimentSandboxProfile({
  deniedRoots,
  fixturePath,
  protectedRoots = [],
}) {
  const fixture = canonicalPath(fixturePath);
  if (!existsSync(fixture)) {
    throw new Error(`experiment fixture does not exist: ${fixture}`);
  }
  const denied = [
    ...new Set(
      [
        ...deniedRoots.map((root) => canonicalPath(root)),
        ...protectedRoots.map((root) => canonicalPath(root)),
        DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
        DEFAULT_EXPERIMENT_FIXTURE_ROOT,
      ].map((root) => canonicalPath(root)),
    ),
  ].sort();
  if (!denied.some((root) => fixture.startsWith(`${root}${path.sep}`))) {
    throw new Error("experiment fixture is outside every denied cache root");
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny process-info*)",
    "(allow process-info* (target self))",
    ...denied.map(
      (root) =>
        `(deny file-read* file-write* (literal ${quoteProfilePath(root)}) (subpath ${quoteProfilePath(root)}))`,
    ),
    `(allow file-read* file-write* (literal ${quoteProfilePath(fixture)}) (subpath ${quoteProfilePath(fixture)}))`,
  ].join("\n");
}

function checkedGit({ args, cwd, runGit, label }) {
  const result = runGit({ args, cwd });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${String(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  return result;
}

function deadlineBoundGit({ runGit, deadlineMs, now }) {
  return ({ args, cwd }) => {
    if (deadlineMs === Number.POSITIVE_INFINITY) {
      return runGit({ args, cwd });
    }
    const remaining = deadlineMs - now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error(
        "experiment stage expired during disposable fixture setup",
      );
    }
    return runGit({
      args,
      cwd,
      timeoutMs: Math.max(1, Math.floor(remaining)),
    });
  };
}

/** Clone one prepared seed into a disposable checkout for one model process. */
export function createDisposableExperimentFixture({
  seedFixture,
  fixtureCacheDir,
  head,
  base,
  cellId,
  runGit = defaultExperimentRunGit,
  nonce = randomUUID(),
  deadlineMs = Number.POSITIVE_INFINITY,
  now = Date.now,
}) {
  if (typeof seedFixture?.path !== "string") {
    throw new Error("prepared fixture seed is missing");
  }
  const seed = canonicalPath(seedFixture.path);
  const root = canonicalPath(fixtureCacheDir);
  if (!existsSync(seed) || !seed.startsWith(`${root}${path.sep}`)) {
    throw new Error("prepared fixture seed is missing or outside its cache");
  }
  if (!/^[0-9a-f]{40}$/.test(String(head ?? ""))) {
    throw new Error("disposable fixture has no pinned head");
  }
  if (!/^[0-9a-f]{40}$/.test(String(base ?? ""))) {
    throw new Error("disposable fixture has no pinned base");
  }
  const label = String(cellId ?? "cell").replace(/[^A-Za-z0-9._-]/g, "-");
  const activeRoot = path.join(root, "active");
  mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  const target = path.join(activeRoot, `${label}-${nonce}`);
  if (existsSync(target)) {
    throw new Error(`disposable fixture already exists: ${target}`);
  }
  const boundedRunGit = deadlineBoundGit({ runGit, deadlineMs, now });
  try {
    checkedGit({
      args: [
        "clone",
        "--quiet",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        seed,
        target,
      ],
      cwd: root,
      runGit: boundedRunGit,
      label: "disposable fixture clone",
    });
    checkedGit({
      args: ["remote", "remove", "origin"],
      cwd: target,
      runGit: boundedRunGit,
      label: "disposable fixture origin removal",
    });
    checkedGit({
      args: ["config", "--local", "core.hooksPath", "/dev/null"],
      cwd: target,
      runGit: boundedRunGit,
      label: "disposable fixture hook isolation",
    });
    resetFixture({
      fixturePath: target,
      head,
      cellId,
      runGit: boundedRunGit,
    });
    checkedGit({
      args: ["branch", "--force", "base", base],
      cwd: target,
      runGit: boundedRunGit,
      label: "disposable fixture base pin",
    });
    return { ...seedFixture, seed_path: seed, path: target };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only a disposable checkout created under this fixture cache. */
export function disposeDisposableExperimentFixture({
  fixturePath,
  fixtureCacheDir,
}) {
  const root = canonicalPath(path.join(fixtureCacheDir, "active"));
  const target = canonicalPath(fixturePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("refusing to remove a non-disposable experiment fixture");
  }
  rmSync(target, { recursive: true, force: true });
}

/** Wrap one untrusted command in Darwin Seatbelt and fail closed elsewhere. */
export function isolateExperimentCommand({
  file,
  args,
  repoRoot,
  artifactRoot,
  fixtureCacheDir,
  fixturePath,
  protectedRoots = [],
  worktreeRoots = null,
  platform = process.platform,
}) {
  if (platform !== "darwin") {
    throw new Error(
      "paid review experiments require Darwin sandbox-exec isolation",
    );
  }
  const registered =
    worktreeRoots ?? registeredExperimentWorktrees({ repoRoot });
  const profile = buildExperimentSandboxProfile({
    deniedRoots: [
      ...registered,
      canonicalPath(repoRoot),
      canonicalPath(artifactRoot),
      canonicalPath(fixtureCacheDir),
    ],
    fixturePath,
    protectedRoots,
  });
  return {
    file: "/usr/bin/sandbox-exec",
    args: ["-p", profile, file, ...args],
  };
}

/** Isolate only judge requests that expose tools to the model. */
export function createExperimentJudgeExec({
  claudeFile,
  repoRoot,
  artifactRoot,
  fixtureCacheDir,
  env,
  timeoutMs,
  signal,
  runCommand,
  isolateCommand = isolateExperimentCommand,
  worktreeRoots = null,
  protectedRoots = [],
}) {
  return async (request) => {
    const file = claudeFile;
    const args = claudeStdinArgv(request);
    const command =
      (request.allowedTools ?? []).length === 0
        ? { file, args }
        : isolateCommand({
            file,
            args,
            repoRoot,
            artifactRoot,
            fixtureCacheDir,
            fixturePath: request.cwd,
            worktreeRoots,
            protectedRoots,
          });
    const response = await runCommand({
      ...command,
      cwd: request.cwd,
      env,
      input: request.prompt,
      timeoutMs,
      signal,
    });
    return response.stdout;
  };
}

/** Prove the host enforces fixture access and hides campaign evidence. */
export function verifyExperimentSandbox({
  repoRoot,
  artifactRoot,
  fixtureCacheDir,
  fixturePath,
  protectedRoots = [],
  worktreeRoots = null,
  platform = process.platform,
  run = spawnSync,
}) {
  const evidenceFile = path.join(artifactRoot, "plan.json");
  const fixtureGit = path.join(fixturePath, ".git");
  if (!existsSync(evidenceFile) || !existsSync(fixtureGit)) {
    throw new Error("experiment sandbox probe inputs are missing");
  }
  const execute = (args, label) => {
    const wrapped = isolateExperimentCommand({
      file: "/bin/test",
      args,
      repoRoot,
      artifactRoot,
      fixtureCacheDir,
      fixturePath,
      worktreeRoots,
      protectedRoots,
      platform,
    });
    const result = run(wrapped.file, wrapped.args, {
      cwd: fixturePath,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${label} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
      );
    }
  };
  execute(["-r", fixtureGit], "experiment fixture allow probe");
  execute(["-w", fixtureGit], "experiment fixture write probe");
  execute(["!", "-r", evidenceFile], "experiment evidence deny probe");
  execute(["!", "-w", evidenceFile], "experiment evidence write deny probe");
  const deniedRoots = [
    ...(worktreeRoots ?? registeredExperimentWorktrees({ repoRoot })),
    ...protectedRoots,
  ];
  for (const [index, deniedRoot] of deniedRoots.entries()) {
    execute(
      ["!", "-r", canonicalPath(deniedRoot)],
      `experiment protected-root read deny probe ${index + 1}`,
    );
    execute(
      ["!", "-w", canonicalPath(deniedRoot)],
      `experiment protected-root write deny probe ${index + 1}`,
    );
  }
  const processProbe = isolateExperimentCommand({
    file: "/bin/ps",
    args: ["-p", "1"],
    repoRoot,
    artifactRoot,
    fixtureCacheDir,
    fixturePath,
    worktreeRoots,
    protectedRoots,
    platform,
  });
  const processResult = run(processProbe.file, processProbe.args, {
    cwd: fixturePath,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (!processResult.error && processResult.status === 0) {
    throw new Error("experiment process-info deny probe failed open");
  }
  return true;
}
