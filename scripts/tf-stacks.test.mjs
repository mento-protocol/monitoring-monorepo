#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(repoRoot, "scripts/tf-stacks.mjs");
const originMainFetchCommand =
  "fetch --quiet origin refs/heads/main:refs/remotes/origin/main";

function runRaw(args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function run(args, options = {}) {
  const result = runRaw(args, options);
  if (result.status !== 0) {
    throw new Error(
      `tf-stacks ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function runFail(args, options = {}) {
  const result = runRaw(args, options);
  if (result.status === 0) {
    throw new Error(`tf-stacks ${args.join(" ")} unexpectedly succeeded`);
  }
  return result;
}

function assertIncludes(value, expected, message) {
  assert(value.includes(expected), `${message}\nexpected: ${expected}`);
}

function writeExecutable(filePath, body) {
  writeFileSync(filePath, body);
  chmodSync(filePath, 0o755);
}

function terraformCalls(logFile) {
  if (!existsSync(logFile)) {
    return [];
  }
  const contents = readFileSync(logFile, "utf8").trim();
  return contents
    ? contents.split(/\r?\n/u).map((line) => JSON.parse(line))
    : [];
}

function gitCalls(logFile) {
  if (!existsSync(logFile)) {
    return [];
  }
  return readFileSync(logFile, "utf8").trim().split(/\r?\n/u).filter(Boolean);
}

function makeFakeTools(tempDir) {
  const binDir = path.join(tempDir, "bin");
  const terraformLog = path.join(tempDir, "terraform.log");
  const gitLog = path.join(tempDir, "git.log");
  mkdirSync(binDir);

  writeExecutable(
    path.join(binDir, "terraform"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const log = process.env.TF_STACKS_TEST_TERRAFORM_LOG;
if (log) {
  appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
}
`,
  );

  writeExecutable(
    path.join(binDir, "git"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");
const gitLog = process.env.TF_STACKS_TEST_GIT_LOG;
if (gitLog) {
  appendFileSync(gitLog, command + "\\n");
}

if (process.env.TF_STACKS_TEST_FAIL_ON_GIT === "1") {
  process.stderr.write("unexpected git call: " + command + "\\n");
  process.exit(91);
}

if (command === "rev-parse --abbrev-ref HEAD") {
  process.stdout.write((process.env.TF_STACKS_TEST_BRANCH ?? "main") + "\\n");
} else if (command === "status --porcelain") {
  process.stdout.write(process.env.TF_STACKS_TEST_STATUS ?? "");
} else if (command === "rev-parse HEAD") {
  process.stdout.write((process.env.TF_STACKS_TEST_HEAD ?? "abc123") + "\\n");
} else if (command === "${originMainFetchCommand}") {
  if (process.env.TF_STACKS_TEST_FETCH_FAIL === "1") {
    process.stderr.write("fatal: could not fetch origin main\\n");
    process.exit(128);
  }
} else if (command === "rev-parse origin/main") {
  if (process.env.TF_STACKS_TEST_ORIGIN_MAIN_MISSING === "1") {
    process.stderr.write("fatal: ambiguous argument 'origin/main'\\n");
    process.exit(128);
  }
  process.stdout.write(
    (process.env.TF_STACKS_TEST_ORIGIN_MAIN ??
      process.env.TF_STACKS_TEST_HEAD ??
      "abc123") + "\\n",
  );
} else {
  process.stderr.write("unexpected git command: " + command + "\\n");
  process.exit(92);
}
`,
  );

  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      TF_STACKS_TEST_GIT_LOG: gitLog,
      TF_STACKS_TEST_TERRAFORM_LOG: terraformLog,
    },
    gitLog,
    terraformLog,
  };
}

function assertTerraformCommands(logFile, expectedCommands, message) {
  const commands = terraformCalls(logFile).map((args) => args[1]);
  assert(
    JSON.stringify(commands) === JSON.stringify(expectedCommands),
    `${message}: ${JSON.stringify(commands)}`,
  );
}

function assertNoTerraformCalls(logFile, message) {
  assert(terraformCalls(logFile).length === 0, message);
}

function assertNoGitCalls(logFile, message) {
  assert(gitCalls(logFile).length === 0, message);
}

function assertGitCallsInclude(logFile, expected, message) {
  assert(gitCalls(logFile).includes(expected), message);
}

function assertApplyRefused(result) {
  assertIncludes(
    result.stderr,
    "refusing local Terraform apply for auto-applied stack alerts-rules",
    "refusal should identify the guarded stack",
  );
  assertIncludes(
    result.stderr,
    "Expected safe path: merge to main and let GitHub Actions apply through the production environment.",
    "refusal should explain the safe path",
  );
  assertIncludes(
    result.stderr,
    "Override for a deliberate local apply: pass --force-local-apply.",
    "refusal should explain the override",
  );
}

function assertApplyCallWithoutForce(logFile) {
  const calls = terraformCalls(logFile);
  const applyCall = calls.find((args) => args[1] === "apply");
  assert(applyCall, "expected terraform apply to run");
  assert(
    !applyCall.includes("--force-local-apply"),
    "wrapper override must not be forwarded to terraform",
  );
}

function resetLogs(...logFiles) {
  for (const logFile of logFiles) {
    writeFileSync(logFile, "");
  }
}

function runApplyGuardTests(tempDir) {
  const fakeTools = makeFakeTools(tempDir);
  const baseEnv = fakeTools.env;

  let result = runFail(["apply", "alerts-rules"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_BRANCH: "feature/local-apply-guard",
    },
  });
  assertApplyRefused(result);
  assertIncludes(
    result.stderr,
    "branch=feature/local-apply-guard",
    "refusal should explain the current branch",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "guarded apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "alerts-rules"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_STATUS: " M docs/terraform.md\n",
    },
  });
  assertApplyRefused(result);
  assertIncludes(
    result.stderr,
    "clean=no",
    "refusal should explain dirty worktrees",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "dirty guarded apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "alerts-rules"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_HEAD: "abc123",
      TF_STACKS_TEST_ORIGIN_MAIN: "def456",
    },
  });
  assertApplyRefused(result);
  assertIncludes(
    result.stderr,
    "HEAD==origin/main=no",
    "refusal should explain stale local main",
  );
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "guarded main apply should refresh origin/main before comparing",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "stale guarded apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "alerts-rules"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_ORIGIN_MAIN_MISSING: "1",
    },
  });
  assertApplyRefused(result);
  assertIncludes(
    result.stderr,
    "Could not verify checkout safety",
    "refusal should surface git verification errors",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "unverifiable guarded apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "alerts-rules"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_FETCH_FAIL: "1",
    },
  });
  assertApplyRefused(result);
  assertIncludes(
    result.stderr,
    "Could not verify checkout safety",
    "refusal should surface origin/main freshness errors",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "unfresh guarded apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["apply", "alerts-rules", "--force-local-apply", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_BRANCH: "feature/local-apply-guard",
      TF_STACKS_TEST_FAIL_ON_GIT: "1",
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "apply"],
    "forced apply should run terraform",
  );
  assertNoGitCalls(
    fakeTools.gitLog,
    "forced apply should skip git safety checks",
  );
  assertApplyCallWithoutForce(fakeTools.terraformLog);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["apply", "alerts-rules", "-auto-approve"], {
    env: baseEnv,
  });
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "safe main apply should refresh origin/main before comparing",
  );
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "apply"],
    "safe main apply should run terraform",
  );
  assertApplyCallWithoutForce(fakeTools.terraformLog);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["plan", "alerts-rules", "-out=tfplan"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_FAIL_ON_GIT: "1",
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan"],
    "plan must not be guarded",
  );
  assertNoGitCalls(fakeTools.gitLog, "plan should not inspect git state");
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["apply", "platform", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_FAIL_ON_GIT: "1",
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "apply"],
    "manual apply stacks must not be guarded",
  );
  assertNoGitCalls(
    fakeTools.gitLog,
    "manual apply should not inspect git state",
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const registry = JSON.parse(run(["list", "--json"]));
const stackIds = registry.stacks.map((stack) => stack.id);
const requiredStackIds = [
  "platform",
  "alerts-rules",
  "alerts-delivery",
  "aegis",
];
const missingStackIds = requiredStackIds.filter((id) => !stackIds.includes(id));
assert(
  missingStackIds.length === 0,
  `missing required stack ids: ${missingStackIds.join(", ")}`,
);

for (const stack of registry.stacks) {
  assert(
    stack.path && stack.state?.prefix && Array.isArray(stack.providers),
    `invalid stack: ${stack.id}`,
  );
  assert(
    stack.changedPathPatterns.includes("terraform.stacks.json"),
    `${stack.id} must react to registry edits`,
  );
  assert(
    stack.changedPathPatterns.includes("scripts/tf-stacks.mjs"),
    `${stack.id} must react to wrapper edits`,
  );
}

const tempDir = mkdtempSync(path.join(tmpdir(), "tf-stacks-test-"));
try {
  const pathsFile = path.join(tempDir, "paths.txt");

  writeFileSync(pathsFile, "alerts/rules/rules-fpmms.tf\n");
  let matrix = JSON.parse(
    run(["changed", "--paths-file", pathsFile, "--json"]),
  );
  assert(
    matrix.include.length === 1,
    "alerts/rules change should map to one stack",
  );
  assert(
    matrix.include[0].id === "alerts-rules",
    "alerts/rules change should map to alerts-rules",
  );

  writeFileSync(pathsFile, "terraform.stacks.json\n");
  matrix = JSON.parse(run(["changed", "--paths-file", pathsFile, "--json"]));
  assert(
    matrix.include.length === 4,
    "registry change should validate every stack",
  );

  writeFileSync(pathsFile, "docs/terraform.md\n");
  matrix = JSON.parse(run(["changed", "--paths-file", pathsFile, "--json"]));
  assert(
    matrix.include.length === 0,
    "docs-only Terraform overview should not run Terraform validate",
  );

  runApplyGuardTests(tempDir);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("tf-stacks tests passed");
