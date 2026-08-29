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
import "./lib/hcl.test.mjs";
import "./deploy-staging-contract.test.mjs";
import "./production-infra-identity-contract/index.test.mjs";
import "./sentry/gate/sentry-provider-contract.test.mjs";
import "./alerts/check-peg-policy-publication.test.mjs";
import "./terraform/check-metrics-bridge-template-plan.test.mjs";
import "./terraform/check-human-merge-boundary-plan.test.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(repoRoot, "scripts/tf-stacks.mjs");
const originMainFetchCommand =
  "fetch --quiet origin refs/heads/main:refs/remotes/origin/main";
const testHumanMergeBoundaryPolicy = Object.freeze({
  repository: "mento-protocol/monitoring-monorepo",
  human_merge_operator_team_id: 424242,
  human_main_lifecycle_ruleset_id: 24680,
  human_main_lifecycle_ruleset_enforcement: "active",
  ruleset_audit_active: false,
  local_agent_github_broker_impersonator: "",
});
const defaultLifecycleRuleset = {
  name: "human-only-main-lifecycle",
  repository: "monitoring-monorepo",
  target: "branch",
  enforcement: "active",
  ruleset_id: testHumanMergeBoundaryPolicy.human_main_lifecycle_ruleset_id,
  conditions: [
    {
      ref_name: [{ include: ["refs/heads/main"], exclude: [] }],
    },
  ],
  bypass_actors: [
    {
      actor_id: testHumanMergeBoundaryPolicy.human_merge_operator_team_id,
      actor_type: "Team",
      bypass_mode: "pull_request",
    },
  ],
  rules: [{ creation: true, update: true, deletion: true }],
};
const defaultPlatformPlan = {
  format_version: "1.2",
  terraform_version: "1.14.0",
  applyable: true,
  complete: true,
  errored: false,
  configuration: {
    provider_config: {
      github: {
        name: "github",
        full_name: "registry.terraform.io/integrations/github",
        expressions: {
          owner: { constant_value: "mento-protocol" },
          base_url: { constant_value: "https://api.github.com/" },
          token: { references: ["var.github_token"] },
        },
      },
    },
  },
  resource_changes: [
    {
      address: "google_cloud_run_v2_service.metrics_bridge",
      mode: "managed",
      type: "google_cloud_run_v2_service",
      name: "metrics_bridge",
      change: {
        actions: ["no-op"],
        before: { template: [{ revision: "metrics-bridge-r-test" }] },
        after: { template: [{ revision: "metrics-bridge-r-test" }] },
        after_unknown: {},
      },
    },
    {
      address: "github_repository_ruleset.human_only_main_lifecycle",
      mode: "managed",
      type: "github_repository_ruleset",
      name: "human_only_main_lifecycle",
      change: {
        actions: ["no-op"],
        before: structuredClone(defaultLifecycleRuleset),
        after: structuredClone(defaultLifecycleRuleset),
        after_unknown: {},
      },
    },
  ],
};

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
  const terraformCwdLog = path.join(tempDir, "terraform-cwd.log");
  const terraformEnvironmentLog = path.join(
    tempDir,
    "terraform-environment.log",
  );
  const planModeLog = path.join(tempDir, "plan-mode.log");
  const gitLog = path.join(tempDir, "git.log");
  mkdirSync(binDir);

  writeExecutable(
    path.join(binDir, "terraform"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
const log = process.env.TF_STACKS_TEST_TERRAFORM_LOG;
if (log) {
  appendFileSync(log, JSON.stringify(args) + "\\n");
}
const cwdLog = process.env.TF_STACKS_TEST_TERRAFORM_CWD_LOG;
if (cwdLog) {
  appendFileSync(cwdLog, process.cwd() + "\\n");
}
const environmentLog = process.env.TF_STACKS_TEST_TERRAFORM_ENV_LOG;
if (environmentLog) {
  appendFileSync(
    environmentLog,
    JSON.stringify({
      cliConfig: process.env.TF_CLI_CONFIG_FILE,
      cliConfigContents: process.env.TF_CLI_CONFIG_FILE
        ? readFileSync(process.env.TF_CLI_CONFIG_FILE, "utf8")
        : null,
      cliConfigMode: process.env.TF_CLI_CONFIG_FILE
        ? (statSync(process.env.TF_CLI_CONFIG_FILE).mode & 0o777).toString(8)
        : null,
      dataDir: process.env.TF_DATA_DIR,
      reattachPresent: Object.hasOwn(process.env, "TF_REATTACH_PROVIDERS"),
      workspace: process.env.TF_WORKSPACE,
    }) + "\\n",
  );
}
const command = args[1];
if (process.env.TF_STACKS_TEST_FAIL_TERRAFORM_COMMAND === command) {
  process.stderr.write("synthetic terraform failure\\n");
  process.exit(93);
}
if (command === "plan") {
  const out = args.find((arg) => arg.startsWith("-out="));
  if (out) writeFileSync(out.slice("-out=".length), "private plan fixture");
}
if (command === "show") {
  const planPath = args.at(-1);
  const modeLog = process.env.TF_STACKS_TEST_PLAN_MODE_LOG;
  if (modeLog) {
    appendFileSync(
      modeLog,
      JSON.stringify({
        directory: statSync(dirname(planPath)).mode & 0o777,
        file: statSync(planPath).mode & 0o777,
        variables: readdirSync(dirname(planPath))
          .filter((name) => name.startsWith("variables-"))
          .map((name) => statSync(dirname(planPath) + "/" + name).mode & 0o777),
      }) + "\\n",
    );
  }
  process.stdout.write(
    process.env.TF_STACKS_TEST_PLAN_JSON ??
      ${JSON.stringify(JSON.stringify(defaultPlatformPlan))},
  );
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

if (args[0] === "-C" && args[2] === "ls-files") {
  process.stdout.write("main.tf\\0");
} else if (command === "rev-parse --abbrev-ref HEAD") {
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
} else if (
  args[0] === "ls-tree" &&
  args[1] === "-r" &&
  args[2] === "--name-only" &&
  args[3] === "-z"
) {
  process.stdout.write(
    "terraform/main.tf\\0terraform/metrics-bridge.tf\\0" +
      "terraform/human-merge-boundary-policy.json\\0",
  );
} else if (args[0] === "show" && args[1]?.endsWith(":terraform/main.tf")) {
  process.stdout.write("terraform {}\\n");
} else if (
  args[0] === "show" &&
  args[1]?.endsWith(":terraform/metrics-bridge.tf")
) {
  process.stdout.write(
    "locals {\\n  metrics_bridge_template_rollout_active = " +
      (process.env.TF_STACKS_TEST_ROLLOUT_ACTIVE ?? "false") +
      "\\n}\\n",
  );
} else if (
  args[0] === "show" &&
  args[1]?.endsWith(":terraform/human-merge-boundary-policy.json")
) {
  process.stdout.write(${JSON.stringify(
    `${JSON.stringify(testHumanMergeBoundaryPolicy, null, 2)}\n`,
  )});
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
      TF_STACKS_TEST_PLAN_MODE_LOG: planModeLog,
      TF_STACKS_TEST_TERRAFORM_CWD_LOG: terraformCwdLog,
      TF_STACKS_TEST_TERRAFORM_ENV_LOG: terraformEnvironmentLog,
      TF_STACKS_TEST_TERRAFORM_LOG: terraformLog,
    },
    gitLog,
    planModeLog,
    terraformCwdLog,
    terraformEnvironmentLog,
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

function assertWorkflowOnlyStatefulCommandRefused(
  result,
  command,
  stackId,
  workflowPath,
) {
  assertIncludes(
    result.stderr,
    `refusing local Terraform ${command} for workflow-only stack ${stackId}`,
    "refusal should identify the workflow-only stack",
  );
  assertIncludes(
    result.stderr,
    `Local wrapper plans and applies are disabled for ${stackId}`,
    "refusal should explain the stateful local-command boundary",
  );
  assertIncludes(
    result.stderr,
    `Expected safe path: dispatch ${workflowPath} from main.`,
    "refusal should direct the operator to the protected workflow",
  );
  assert(
    result.stderr.includes(`pnpm tf validate ${stackId}`),
    "refusal should direct operators to credential-free local validation",
  );
}

function assertPlatformCommandRefused(result, command) {
  assertIncludes(
    result.stderr,
    `refusing platform Terraform ${command} outside clean current main`,
    "refusal should identify the platform current-main guard",
  );
  assertIncludes(
    result.stderr,
    "Platform secret inputs require a clean main checkout whose HEAD matches freshly fetched origin/main before plan or apply.",
    "refusal should explain the platform secret-input boundary",
  );
}

function runValidateFormatTest(tempDir) {
  const fixtureRoot = path.join(tempDir, "validate-format");
  mkdirSync(fixtureRoot);
  const fakeTools = makeFakeTools(fixtureRoot);

  run(["validate", "platform"], { env: fakeTools.env });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["fmt", "init", "validate"],
    "validate should format Git-visible sources before init and validate",
  );

  const [formatCall] = terraformCalls(fakeTools.terraformLog);
  assert(
    formatCall[0] === `-chdir=${path.join(repoRoot, "terraform")}`,
    `format helper should bind the stack root: ${JSON.stringify(formatCall)}`,
  );
  assert(
    formatCall.includes("./main.tf"),
    `format helper should pass an explicit Git-visible target: ${JSON.stringify(formatCall)}`,
  );
  assert(
    gitCalls(fakeTools.gitLog).some(
      (call) =>
        call.startsWith(`-C ${path.join(repoRoot, "terraform")} ls-files `) &&
        call.includes("--exclude-standard") &&
        call.includes("-z"),
    ),
    "validate should enumerate non-ignored Terraform sources through Git",
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

function platformPrivatePlanPath(logFile) {
  const planCall = terraformCalls(logFile).find((args) => args[1] === "plan");
  const outArg = planCall?.find((arg) => arg.startsWith("-out="));
  assert(outArg, `expected private platform plan: ${JSON.stringify(planCall)}`);
  return outArg.slice("-out=".length);
}

function assertExactSavedPlanBinding(logFile, shouldApply = true) {
  const calls = terraformCalls(logFile);
  const planPath = platformPrivatePlanPath(logFile);
  const showCall = calls.find((args) => args[1] === "show");
  assert(
    showCall?.at(-1) === planPath && showCall.includes("-json"),
    `terraform show must inspect the private saved plan: ${JSON.stringify(showCall)}`,
  );
  const applyCall = calls.find((args) => args[1] === "apply");
  if (shouldApply) {
    assert(
      applyCall?.at(-1) === planPath,
      `terraform apply must consume the validated saved plan: ${JSON.stringify(applyCall)}`,
    );
  } else {
    assert(!applyCall, "guarded or empty platform plan must not run apply");
  }
  assert(!existsSync(planPath), "private platform plan must be removed");
  assert(
    !existsSync(path.dirname(planPath)),
    "private platform plan directory must be removed",
  );
}

function assertPrivatePlanModes(modeLog) {
  const entries = readFileSync(modeLog, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const mode = entries.at(-1);
  assert(
    mode?.directory === 0o700,
    `private plan directory mode: ${mode?.directory}`,
  );
  assert(mode?.file === 0o600, `private plan file mode: ${mode?.file}`);
  assert(
    mode?.variables?.every((value) => value === 0o600),
    `private variable file modes: ${JSON.stringify(mode?.variables)}`,
  );
}

function assertTerraformUsesCommittedSnapshot(logFile, message) {
  const sourcePath = `-chdir=${path.join(repoRoot, "terraform")}`;
  const calls = terraformCalls(logFile);
  assert(calls.length > 0, `${message}: expected Terraform calls`);
  assert(
    calls.every(
      (args) =>
        args[0] !== sourcePath &&
        args[0].startsWith(
          `-chdir=${path.join(tmpdir(), "tf-stacks-platform-source.")}`,
        ),
    ),
    `${message}: ${JSON.stringify(calls)}`,
  );
  const snapshotStackPath = calls[0][0].slice("-chdir=".length);
  assert(
    !existsSync(snapshotStackPath),
    `${message}: temporary source snapshot should be removed`,
  );
}

function terraformEnvironments(logFile) {
  const contents = readFileSync(logFile, "utf8").trim();
  return contents
    ? contents.split(/\r?\n/u).map((line) => JSON.parse(line))
    : [];
}

function assertPlatformTerraformUsesPrivateDefaultWorkspace(
  terraformLog,
  environmentLog,
  message,
) {
  const calls = terraformCalls(terraformLog);
  const environments = terraformEnvironments(environmentLog);
  assert(
    calls.length === environments.length && calls.length > 0,
    `${message}: expected one environment record per Terraform invocation`,
  );
  const snapshotStackPath = calls[0][0].slice("-chdir=".length);
  const expectedDataDir = path.join(
    path.dirname(snapshotStackPath),
    ".terraform-data",
  );
  const expectedCliConfig = path.join(
    path.dirname(snapshotStackPath),
    ".terraformrc",
  );
  assert(
    environments.every(
      ({
        cliConfig,
        cliConfigContents,
        cliConfigMode,
        dataDir,
        reattachPresent,
        workspace,
      }) =>
        cliConfig === expectedCliConfig &&
        cliConfigContents === "disable_checkpoint = true\n" &&
        cliConfigMode === "600" &&
        dataDir === expectedDataDir &&
        reattachPresent === false &&
        workspace === "default",
    ),
    `${message}: ${JSON.stringify(environments)}`,
  );
}

function assertTerraformRunsFromRepository(logFile, message) {
  const workingDirectories = readFileSync(logFile, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  assert(
    workingDirectories.length > 0 &&
      workingDirectories.every((cwd) => cwd === repoRoot),
    `${message}: ${JSON.stringify(workingDirectories)}`,
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

  result = runFail(["plan", "peg-policy-publication", "-out=tfplan"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_BRANCH: "feature/peg-policy-publication",
      TF_STACKS_TEST_FAIL_ON_GIT: "1",
    },
  });
  assertWorkflowOnlyStatefulCommandRefused(
    result,
    "plan",
    "peg-policy-publication",
    ".github/workflows/peg-policy-publication.yml",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "publication plan must not run terraform",
  );
  assertNoGitCalls(
    fakeTools.gitLog,
    "publication plan must stop before git safety checks",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "peg-policy-publication", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_BRANCH: "feature/peg-policy-publication",
      TF_STACKS_TEST_FAIL_ON_GIT: "1",
    },
  });
  assertWorkflowOnlyStatefulCommandRefused(
    result,
    "apply",
    "peg-policy-publication",
    ".github/workflows/peg-policy-publication.yml",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "publication apply must not run terraform",
  );
  assertNoGitCalls(
    fakeTools.gitLog,
    "publication apply must stop before git safety checks",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(
    ["apply", "peg-policy-publication", "--force-local-apply", "-auto-approve"],
    {
      env: {
        ...baseEnv,
        TF_STACKS_TEST_BRANCH: "feature/forced-peg-policy-publication",
        TF_STACKS_TEST_FAIL_ON_GIT: "1",
      },
    },
  );
  assertWorkflowOnlyStatefulCommandRefused(
    result,
    "apply",
    "peg-policy-publication",
    ".github/workflows/peg-policy-publication.yml",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "forced publication apply must not run terraform",
  );
  assertNoGitCalls(
    fakeTools.gitLog,
    "forced publication apply must stop before git safety checks",
  );
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

  run(
    [
      "plan",
      "alerts-rules",
      `-out=${path.join(tempDir, "alerts-rules.tfplan")}`,
    ],
    {
      env: {
        ...baseEnv,
        TF_STACKS_TEST_FAIL_ON_GIT: "1",
      },
    },
  );
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan"],
    "plan must not be guarded",
  );
  assertNoGitCalls(fakeTools.gitLog, "plan should not inspect git state");
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(
    ["apply", "platform", "--force-local-apply", "-auto-approve"],
    {
      env: {
        ...baseEnv,
        TF_STACKS_TEST_BRANCH: "feature/platform-secret-rotation",
      },
    },
  );
  assertPlatformCommandRefused(result, "apply");
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "feature-branch platform apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "platform", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_STATUS: " M terraform/aegis-bootstrap.tf\n",
    },
  });
  assertPlatformCommandRefused(result, "apply");
  assertIncludes(
    result.stderr,
    "clean=no",
    "platform refusal should explain dirty worktrees",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "dirty platform apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "platform", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_HEAD: "abc123",
      TF_STACKS_TEST_ORIGIN_MAIN: "def456",
    },
  });
  assertPlatformCommandRefused(result, "apply");
  assertIncludes(
    result.stderr,
    "HEAD==origin/main=no",
    "platform refusal should explain stale main",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "stale platform apply must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["apply", "platform", "-auto-approve"], {
    env: baseEnv,
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show", "apply"],
    "safe current-main platform apply should run terraform",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog);
  assertPrivatePlanModes(fakeTools.planModeLog);
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "platform apply should refresh origin/main before terraform",
  );
  assertTerraformUsesCommittedSnapshot(
    fakeTools.terraformLog,
    "platform apply must execute committed source",
  );
  assertTerraformRunsFromRepository(
    fakeTools.terraformCwdLog,
    "platform wrapper must keep Terraform's original cwd at the repository root",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["plan", "platform"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_BRANCH: "feature/platform-secret-plan",
    },
  });
  assertPlatformCommandRefused(result, "plan");
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "feature-branch platform plan must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["plan", "platform"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_STATUS: " M terraform/aegis-bootstrap.tf\n",
    },
  });
  assertPlatformCommandRefused(result, "plan");
  assertIncludes(
    result.stderr,
    "clean=no",
    "platform plan refusal should explain dirty worktrees",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "dirty platform plan must not run terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["plan", "platform", "-var-file=terraform.tfvars.example"], {
    env: baseEnv,
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "safe current-main platform plan should run terraform",
  );
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "platform plan should refresh origin/main before terraform",
  );
  const platformPlanGitCalls = gitCalls(fakeTools.gitLog);
  assert(
    platformPlanGitCalls.indexOf(originMainFetchCommand) <
      platformPlanGitCalls.indexOf("status --porcelain"),
    "platform plan should fetch origin/main before capturing worktree status",
  );
  assert(
    platformPlanGitCalls.includes("show abc123:terraform/main.tf"),
    "platform plan snapshot should read source from the verified commit object",
  );
  assertTerraformUsesCommittedSnapshot(
    fakeTools.terraformLog,
    "platform plan must execute committed source",
  );
  const platformPlanCall = terraformCalls(fakeTools.terraformLog).find(
    (args) => args[1] === "plan",
  );
  const platformPlanVarFile = platformPlanCall.find((arg) =>
    arg.startsWith("-var-file="),
  );
  assert(
    platformPlanVarFile?.includes("tf-stacks-platform-plan.") &&
      !platformPlanVarFile.includes("terraform.tfvars.example"),
    `platform plan should snapshot operator inputs outside the source snapshot: ${JSON.stringify(platformPlanCall)}`,
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  assertPrivatePlanModes(fakeTools.planModeLog);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
}

function runPlatformPlanPolicyTests(tempDir) {
  const fixtureRoot = path.join(tempDir, "platform-plan-policy");
  mkdirSync(fixtureRoot);
  const fakeTools = makeFakeTools(fixtureRoot);
  const baseEnv = fakeTools.env;
  const operatorVarFile = path.join(fixtureRoot, "operator.tfvars");
  writeFileSync(operatorVarFile, 'ephemeral_probe = "present"\n');

  let result = runFail(["apply", "platform"], { env: baseEnv });
  assertIncludes(
    result.stderr,
    "requires exactly one -auto-approve acknowledgement",
    "saved-plan apply must require explicit acknowledgement",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "unacknowledged platform apply must not run Terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "platform", "-auto-approve", "-auto-approve"], {
    env: baseEnv,
  });
  assertIncludes(
    result.stderr,
    "requires exactly one -auto-approve acknowledgement",
    "duplicate apply acknowledgement must fail closed",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "duplicate acknowledgement must not run Terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  for (const [name, value] of [
    ["TF_CLI_ARGS", "-refresh=false"],
    ["TF_CLI_ARGS_plan", "-target=google_project_service.run"],
    ["TF_CLI_ARGS_show", "-json=false"],
    ["TF_CLI_ARGS_apply", "-lock=false"],
  ]) {
    result = runFail(["plan", "platform"], {
      env: { ...baseEnv, [name]: value },
    });
    assertIncludes(
      result.stderr,
      "refusing platform Terraform with injected CLI arguments",
      `${name} must fail closed`,
    );
    assertNoTerraformCalls(
      fakeTools.terraformLog,
      `${name} must fail before Terraform`,
    );
    resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
  }

  const providerRuntimeCanary = "PROVIDER_RUNTIME_OVERRIDE_CANARY";
  for (const variable of ["TF_CLI_CONFIG_FILE", "TF_REATTACH_PROVIDERS"]) {
    for (const commandArgs of [
      ["plan", "platform"],
      ["apply", "platform", "-auto-approve"],
    ]) {
      for (const value of ["", providerRuntimeCanary]) {
        result = runFail(commandArgs, {
          env: { ...baseEnv, [variable]: value },
        });
        assertIncludes(
          result.stderr,
          "refusing platform Terraform with a provider runtime override present",
          `${variable} must fail closed even when it is empty`,
        );
        assert(
          !result.stdout.includes(providerRuntimeCanary) &&
            !result.stderr.includes(providerRuntimeCanary),
          "a provider runtime override value must not reach output",
        );
        assertNoTerraformCalls(
          fakeTools.terraformLog,
          "a provider runtime override must fail before Terraform",
        );
        assertNoGitCalls(
          fakeTools.gitLog,
          "a provider runtime override must fail before Git checks",
        );
        resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
      }
    }
  }

  const environmentCanary = "RESTRICTED_ENV_CREDENTIAL_CANARY";
  for (const variable of [
    "TF_VAR_local_agent_github_app_private_key",
    "TF_VAR_github_token",
  ]) {
    for (const commandArgs of [
      ["plan", "platform"],
      ["apply", "platform", "-auto-approve"],
    ]) {
      for (const value of ["", environmentCanary]) {
        result = runFail(commandArgs, {
          env: { ...baseEnv, [variable]: value },
        });
        assertIncludes(
          result.stderr,
          "refusing platform Terraform with a restricted TF_VAR credential present",
          `${variable} must fail closed even when it is empty`,
        );
        assert(
          !result.stdout.includes(environmentCanary) &&
            !result.stderr.includes(environmentCanary),
          "a restricted environment credential value must not reach output",
        );
        assertNoTerraformCalls(
          fakeTools.terraformLog,
          "a restricted TF_VAR credential must fail before Terraform",
        );
        assertNoGitCalls(
          fakeTools.gitLog,
          "a restricted TF_VAR credential must fail before Git checks",
        );
        resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
      }
    }
  }

  for (const variable of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PEM_FILE",
  ]) {
    for (const commandArgs of [
      ["plan", "platform"],
      ["apply", "platform", "-auto-approve"],
    ]) {
      for (const value of ["", environmentCanary]) {
        result = runFail(commandArgs, {
          env: { ...baseEnv, [variable]: value },
        });
        assertIncludes(
          result.stderr,
          "refusing platform Terraform with ambient GitHub authentication present",
          `${variable} must fail closed`,
        );
        assert(
          !result.stdout.includes(environmentCanary) &&
            !result.stderr.includes(environmentCanary),
          "an ambient GitHub authentication value must not reach output",
        );
        assertNoTerraformCalls(
          fakeTools.terraformLog,
          "ambient GitHub authentication must fail before Terraform",
        );
        assertNoGitCalls(
          fakeTools.gitLog,
          "ambient GitHub authentication must fail before Git checks",
        );
        resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
      }
    }
  }

  const cliCanary = "RESTRICTED_CLI_CREDENTIAL_CANARY";
  for (const variable of [
    "local_agent_github_app_private_key",
    "github_token",
  ]) {
    for (const args of [
      ["plan", "platform", "--", "-var", `${variable}=${cliCanary}`],
      ["plan", "platform", "--", "-var", `${variable} =${cliCanary}`],
      ["plan", "platform", "--", `-var=${variable}=${cliCanary}`],
      [
        "apply",
        "platform",
        "--",
        "-auto-approve",
        "-var",
        `${variable}=${cliCanary}`,
      ],
      [
        "apply",
        "platform",
        "--",
        "-auto-approve",
        `-var=${variable}=${cliCanary}`,
      ],
    ]) {
      result = runFail(args, { env: baseEnv });
      assertIncludes(
        result.stderr,
        "refusing platform Terraform with a restricted CLI credential variable",
        `${variable} must not enter Terraform argv`,
      );
      assert(
        !result.stdout.includes(cliCanary) &&
          !result.stderr.includes(cliCanary),
        "a restricted CLI credential value must not reach output",
      );
      assertNoTerraformCalls(
        fakeTools.terraformLog,
        "a restricted CLI credential must fail before Terraform",
      );
      assertNoGitCalls(
        fakeTools.gitLog,
        "a restricted CLI credential must fail before Git checks",
      );
      resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
    }
  }

  for (const name of [
    "GITHUB_OWNER",
    "GITHUB_ORGANIZATION",
    "GITHUB_BASE_URL",
    "GITHUB_MAX_PER_PAGE",
  ]) {
    for (const commandArgs of [
      ["plan", "platform"],
      ["apply", "platform", "-auto-approve"],
    ]) {
      for (const value of ["", "attacker.invalid"]) {
        result = runFail(commandArgs, {
          env: { ...baseEnv, [name]: value },
        });
        assertIncludes(
          result.stderr,
          "refusing platform Terraform with GitHub provider override environment",
          `${name} must not retarget the GitHub provider`,
        );
        assertNoTerraformCalls(
          fakeTools.terraformLog,
          `${name} must fail before Terraform`,
        );
        assertNoGitCalls(
          fakeTools.gitLog,
          `${name} must fail before Git checks`,
        );
        resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
      }
    }
  }

  result = runFail(["plan", "platform"], {
    env: { ...baseEnv, TF_WORKSPACE: "shadow" },
  });
  assertIncludes(
    result.stderr,
    "outside the default workspace",
    "non-default platform workspace must fail closed",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "non-default workspace must fail before Terraform",
  );
  resetLogs(
    fakeTools.terraformLog,
    fakeTools.gitLog,
    fakeTools.terraformEnvironmentLog,
  );

  const inheritedDataDir = path.join(fixtureRoot, "inherited-terraform-data");
  mkdirSync(inheritedDataDir);
  writeFileSync(path.join(inheritedDataDir, "environment"), "shadow\n");
  run(["plan", "platform"], {
    env: {
      ...baseEnv,
      TF_DATA_DIR: inheritedDataDir,
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "platform plan must not inherit a selected workspace",
  );
  assertPlatformTerraformUsesPrivateDefaultWorkspace(
    fakeTools.terraformLog,
    fakeTools.terraformEnvironmentLog,
    "platform Terraform must use the source snapshot's private default workspace data directory",
  );
  resetLogs(
    fakeTools.terraformLog,
    fakeTools.gitLog,
    fakeTools.terraformEnvironmentLog,
  );

  for (const args of [
    ["-invoke=action.test.example"],
    ["-replace=google_project.monitoring"],
    ["-destroy"],
    ["-refresh-only"],
    ["-out=caller.tfplan"],
    ["-json"],
    ["-detailed-exitcode"],
    ["-lock=false"],
    ["-input=true"],
    ["caller.tfplan"],
  ]) {
    result = runFail(["plan", "platform", ...args], { env: baseEnv });
    assertIncludes(
      result.stderr,
      "unsupported platform Terraform argument",
      `${args[0]} must fail closed`,
    );
    assertNoTerraformCalls(
      fakeTools.terraformLog,
      `${args[0]} must fail before Terraform`,
    );
    resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
  }

  const unsupportedArgumentCanary = "UNSUPPORTED_ARGUMENT_SECRET_CANARY";
  result = runFail(
    ["plan", "platform", `-unsupported=${unsupportedArgumentCanary}`],
    { env: baseEnv },
  );
  assertIncludes(
    result.stderr,
    "unsupported platform Terraform argument",
    "an unsupported argument must fail closed",
  );
  assert(
    !result.stdout.includes(unsupportedArgumentCanary) &&
      !result.stderr.includes(unsupportedArgumentCanary),
    "an unsupported argument value must not reach output",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "an unsupported argument must fail before Terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(
    [
      "plan",
      "platform",
      "--",
      "-var",
      "probe=-target=google_project_service.run",
    ],
    { env: baseEnv },
  );
  const separatorPlanCall = terraformCalls(fakeTools.terraformLog).find(
    (args) => args[1] === "plan",
  );
  assert(
    separatorPlanCall.includes("probe=-target=google_project_service.run"),
    "-var values must remain opaque after consuming one leading separator",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["plan", "platform", "-no-color", "--"], {
    env: baseEnv,
  });
  assertIncludes(
    result.stderr,
    "at most one leading -- separator",
    "midstream separators must fail closed",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "midstream separator must fail before Terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  const secretSentinel = "PLAN_JSON_SECRET_MUST_NOT_LEAK";
  const unsafeStablePlan = structuredClone(defaultPlatformPlan);
  unsafeStablePlan.variables = { secret: { value: secretSentinel } };
  unsafeStablePlan.resource_changes[0].change.actions = ["update"];
  unsafeStablePlan.resource_changes[0].change.before.template[0].containers = [
    { env: [{ name: "PEG_POLICY_URL", value: "generation-a" }] },
  ];
  unsafeStablePlan.resource_changes[0].change.after.template[0].containers = [
    { env: [{ name: "PEG_POLICY_URL", value: secretSentinel }] },
  ];
  result = runFail(
    ["apply", "platform", "-auto-approve", `-var-file=${operatorVarFile}`],
    {
      env: {
        ...baseEnv,
        TF_STACKS_TEST_PLAN_JSON: JSON.stringify(unsafeStablePlan),
      },
    },
  );
  assertIncludes(
    result.stderr,
    "must not change or obscure the service template",
    "stable template mutation must fail closed",
  );
  assert(
    !result.stdout.includes(secretSentinel) &&
      !result.stderr.includes(secretSentinel),
    "captured plan JSON values must never reach wrapper output",
  );
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "invalid saved plan must stop before apply",
  );
  const rejectedPlanCall = terraformCalls(fakeTools.terraformLog).find(
    (args) => args[1] === "plan",
  );
  const rejectedVarFile = rejectedPlanCall.find((arg) =>
    arg.startsWith("-var-file="),
  );
  assert(
    rejectedVarFile?.includes("tf-stacks-platform-plan.") &&
      !rejectedVarFile.includes(operatorVarFile),
    "a private copy of operator tfvars must reach the validated plan",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  const invalidLifecyclePlan = structuredClone(defaultPlatformPlan);
  const invalidLifecycleRuleset = invalidLifecyclePlan.resource_changes.find(
    (entry) =>
      entry.address === "github_repository_ruleset.human_only_main_lifecycle",
  );
  invalidLifecycleRuleset.change.actions = ["update"];
  invalidLifecycleRuleset.change.after.etag = "unexpected-update";
  result = runFail(["apply", "platform", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_PLAN_JSON: JSON.stringify(invalidLifecyclePlan),
    },
  });
  assertIncludes(
    result.stderr,
    "a human lifecycle ruleset update may only activate disabled enforcement",
    "the platform wrapper must invoke the human lifecycle plan guard",
  );
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "an invalid lifecycle plan must stop before apply",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  const noChangesPlan = structuredClone(defaultPlatformPlan);
  noChangesPlan.applyable = false;
  run(["apply", "platform", "-auto-approve"], {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_PLAN_JSON: JSON.stringify(noChangesPlan),
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "non-applyable no-op plan must skip apply",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  const recoveryPlan = {
    ...structuredClone(defaultPlatformPlan),
    complete: false,
    resource_changes: [
      {
        address: "google_project_iam_custom_role.peg_policy_bucket_controller",
        mode: "managed",
        type: "google_project_iam_custom_role",
        name: "peg_policy_bucket_controller",
        change: { actions: ["create"], before: null, after: {} },
      },
    ],
  };
  const recoveryArgs = [
    "plan",
    "platform",
    "-refresh=false",
    "-target=google_project_iam_custom_role.peg_policy_bucket_controller",
  ];
  run(recoveryArgs, {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_PLAN_JSON: JSON.stringify(recoveryPlan),
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "exact ADR 0055 recovery plan should pass",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(
    [
      "plan",
      "platform",
      "-refresh=false",
      "-target=google_project_service.storage",
    ],
    { env: baseEnv },
  );
  assertIncludes(
    result.stderr,
    "permits -refresh=false and -target only for the exact ADR 0055 controller recovery",
    "recovery target arguments must fail closed before Terraform",
  );
  assertNoTerraformCalls(
    fakeTools.terraformLog,
    "unexpected recovery target must not run Terraform",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  const expandedRecoveryPlan = structuredClone(recoveryPlan);
  expandedRecoveryPlan.resource_changes.push({
    address: "google_project_service.storage",
    mode: "managed",
    type: "google_project_service",
    name: "storage",
    change: { actions: ["create"], before: null, after: {} },
  });
  result = runFail(recoveryArgs, {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_PLAN_JSON: JSON.stringify(expandedRecoveryPlan),
    },
  });
  assertIncludes(
    result.stderr,
    "may only create the Peg policy bucket controller role",
    "expanded recovery dependency mutations must fail closed",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(recoveryArgs, {
    env: {
      ...baseEnv,
      TF_STACKS_TEST_PLAN_JSON: JSON.stringify(recoveryPlan),
      TF_STACKS_TEST_ROLLOUT_ACTIVE: "true",
    },
  });
  assertIncludes(
    result.stderr,
    "rollout mode forbids targeted platform recovery",
    "rollout mode must pause targeted recovery applies",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(
    [
      "apply",
      "platform",
      "--",
      "-auto-approve",
      `-var-file=${operatorVarFile}`,
      "-var",
      "ephemeral_probe=present",
      "-lock-timeout=10m",
      "-no-color",
    ],
    { env: baseEnv },
  );
  const safeOptionCalls = terraformCalls(fakeTools.terraformLog);
  const safeOptionPlan = safeOptionCalls.find((args) => args[1] === "plan");
  const safeOptionApply = safeOptionCalls.find((args) => args[1] === "apply");
  const planVarFile = safeOptionPlan.find((arg) =>
    arg.startsWith("-var-file="),
  );
  const applyVarFile = safeOptionApply.find((arg) =>
    arg.startsWith("-var-file="),
  );
  assert(
    safeOptionPlan.filter((arg) => arg === "-input=false").length === 1 &&
      safeOptionApply.filter((arg) => arg === "-input=false").length === 1 &&
      safeOptionApply.includes("-lock-timeout=10m") &&
      safeOptionApply.includes("-no-color") &&
      planVarFile === applyVarFile &&
      planVarFile?.includes("tf-stacks-platform-plan.") &&
      !planVarFile.includes(operatorVarFile) &&
      safeOptionApply.includes("ephemeral_probe=present") &&
      !safeOptionApply.includes("-auto-approve"),
    "safe execution flags and ephemeral inputs must reach saved-plan apply without the acknowledgement flag",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["plan", "platform"], {
    env: { ...baseEnv, TF_STACKS_TEST_FAIL_TERRAFORM_COMMAND: "show" },
  });
  assertIncludes(
    result.stderr,
    "terraform exited with status 93",
    "show failure should stay bounded",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog, false);
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  result = runFail(["apply", "platform", "-auto-approve"], {
    env: { ...baseEnv, TF_STACKS_TEST_FAIL_TERRAFORM_COMMAND: "apply" },
  });
  assertIncludes(
    result.stderr,
    "terraform exited with status 93",
    "apply failure should be reported",
  );
  assertExactSavedPlanBinding(fakeTools.terraformLog);
}

function runWriteOnlyLoggingGuardTests(tempDir) {
  const fixtureRoot = path.join(tempDir, "logging-guard");
  mkdirSync(fixtureRoot);
  const fakeTools = makeFakeTools(fixtureRoot);

  for (const command of ["plan", "apply"]) {
    for (const variable of [
      "TF_LOG",
      "TF_LOG_CORE",
      "TF_LOG_PROVIDER",
      "TF_LOG_PROVIDER_GOOGLE",
      "TF_LOG_SDK",
      "TF_LOG_SDK_PROTO",
      "TF_LOG_SDK_PROTO_DATA_DIR",
      "TF_LOG_SDK_FUTURE_OUTPUT",
    ]) {
      const result = runFail([command, "platform"], {
        env: {
          ...fakeTools.env,
          [variable]: "DEBUG",
          TF_STACKS_TEST_FAIL_ON_GIT: "1",
        },
      });
      assertIncludes(
        result.stderr,
        `refusing platform Terraform ${command}: ${variable} can expose write-only secret payloads`,
        `${variable} should fail closed for platform ${command}`,
      );
      assertNoTerraformCalls(
        fakeTools.terraformLog,
        `${variable} platform ${command} must not run terraform`,
      );
      assertNoGitCalls(
        fakeTools.gitLog,
        `${variable} platform ${command} must fail before git checks`,
      );
      resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
    }
  }

  for (const variable of [
    "TF_LOG_SDK_PROTO_DATA_DIR",
    "TF_LOG_SDK_FUTURE_OUTPUT",
  ]) {
    const result = runFail(["plan", "platform"], {
      env: {
        ...fakeTools.env,
        [variable]: "OFF",
        TF_STACKS_TEST_FAIL_ON_GIT: "1",
      },
    });
    assertIncludes(
      result.stderr,
      `refusing platform Terraform plan: ${variable} can expose write-only secret payloads`,
      `${variable}=OFF must not bypass the path-or-unknown guard`,
    );
    assertNoTerraformCalls(
      fakeTools.terraformLog,
      `${variable}=OFF must not run terraform`,
    );
    assertNoGitCalls(
      fakeTools.gitLog,
      `${variable}=OFF must fail before git checks`,
    );
    resetLogs(fakeTools.terraformLog, fakeTools.gitLog);
  }

  run(["plan", "platform"], {
    env: {
      ...fakeTools.env,
      TF_LOG_PATH: "/tmp/inert-terraform.log",
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "TF_LOG_PATH alone should remain allowed because it does not enable logging",
  );
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "allowed platform plan should still verify current main",
  );
  resetLogs(fakeTools.terraformLog, fakeTools.gitLog);

  run(["plan", "platform"], {
    env: {
      ...fakeTools.env,
      TF_LOG: "OFF",
      TF_LOG_CORE: "OFF",
      TF_LOG_PROVIDER: "off",
      TF_LOG_PROVIDER_GOOGLE: "OFF",
      TF_LOG_SDK: "off",
      TF_LOG_SDK_PROTO: "OFF",
      TF_LOG_PATH: "/tmp/inert-terraform.log",
    },
  });
  assertTerraformCommands(
    fakeTools.terraformLog,
    ["init", "plan", "show"],
    "explicitly disabled Terraform logging should be accepted",
  );
  assertGitCallsInclude(
    fakeTools.gitLog,
    originMainFetchCommand,
    "logging-disabled platform plan should still verify current main",
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractHclBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert(markerIndex !== -1, `missing HCL block: ${marker}`);

  const openingBrace = source.indexOf("{", markerIndex + marker.length);
  assert(openingBrace !== -1, `missing opening brace for HCL block: ${marker}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingBrace + 1, index);
      }
    }
  }

  throw new Error(`missing closing brace for HCL block: ${marker}`);
}

const metricsBridgeScalingOwnershipError =
  "metrics_bridge must keep service scaling and scaling_mode Terraform-managed";

function assertMetricsBridgeScalingOwnershipSource(source) {
  const service = extractHclBlock(
    source,
    'resource "google_cloud_run_v2_service" "metrics_bridge"',
  );
  const lifecycle = extractHclBlock(service, "lifecycle");

  assert(
    /^ {2}scaling \{\}$/mu.test(service),
    "metrics_bridge must keep an explicit empty service-level scaling block so child ignore paths remain addressable",
  );
  assert(
    /^ {6}scaling\[0\]\.manual_instance_count,$/mu.test(lifecycle),
    "metrics_bridge must ignore the deploy-stamped service manual instance count",
  );
  assert(
    /^ {6}scaling\[0\]\.min_instance_count,$/mu.test(lifecycle),
    "metrics_bridge must ignore the deploy-stamped service minimum instance count",
  );
  assert(
    !/^ {6}(?:scaling|scaling\[0\]|scaling\[0\]\.scaling_mode),$/mu.test(
      lifecycle,
    ),
    metricsBridgeScalingOwnershipError,
  );
}

function assertMetricsBridgeScalingOwnership() {
  const source = readFileSync(
    path.join(repoRoot, "terraform/metrics-bridge.tf"),
    "utf8",
  );
  assertMetricsBridgeScalingOwnershipSource(source);

  const fixtureAnchor = "      scaling[0].min_instance_count,\n";
  assert(
    source.includes(fixtureAnchor),
    "metrics_bridge scaling ownership fixture anchor is missing",
  );

  for (const forbiddenIgnore of [
    "scaling,",
    "scaling[0],",
    "scaling[0].scaling_mode,",
  ]) {
    const fixture = source.replace(
      fixtureAnchor,
      `${fixtureAnchor}      ${forbiddenIgnore}\n`,
    );
    let failure = null;
    try {
      assertMetricsBridgeScalingOwnershipSource(fixture);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof Error &&
        failure.message === metricsBridgeScalingOwnershipError,
      `metrics_bridge ownership guard must reject ${forbiddenIgnore}`,
    );
  }
}

function assertRepositoryLocalOutputsStayInCheckoutSource(source) {
  const localFile = extractHclBlock(
    source,
    'resource "local_file" "vercel_project_json"',
  );

  assert(
    /repository_root\s*=\s*fileexists\("\$\{path\.cwd\}\/terraform\.stacks\.json"\) \? abspath\(path\.cwd\) : abspath\("\$\{path\.module\}\/\.\."\)/u.test(
      source,
    ),
    "platform Terraform may trust path.cwd only when the repository registry marker is present",
  );
  assert(
    /filename\s*=\s*"\$\{local\.repository_root\}\/\.vercel\/project\.json"/u.test(
      localFile,
    ),
    "vercel_project_json must stay in the repository when platform Terraform runs from a source snapshot",
  );
}

function assertRepositoryLocalOutputsStayInCheckout() {
  const source = readFileSync(
    path.join(repoRoot, "terraform/dashboard.tf"),
    "utf8",
  );
  assertRepositoryLocalOutputsStayInCheckoutSource(source);

  let failure = null;
  try {
    assertRepositoryLocalOutputsStayInCheckoutSource(
      source.replace('fileexists("${path.cwd}/terraform.stacks.json")', "true"),
    );
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof Error &&
      /may trust path\.cwd only when the repository registry marker is present/u.test(
        failure.message,
      ),
    "repository-local output guard must reject an unverified caller cwd",
  );
}

function terraformEnvNames(workflowPath) {
  const contents = readFileSync(path.join(repoRoot, workflowPath), "utf8");
  const names = new Set();
  const terraformEnvLine = /^\s+(TF_VAR_[A-Za-z0-9_]+):\s+.+$/gmu;

  for (const match of contents.matchAll(terraformEnvLine)) {
    names.add(match[1]);
  }

  return names;
}

function autoAppliedStackWorkflowPaths(stacks) {
  return [
    ...new Set(
      stacks
        .filter(
          (stack) =>
            stack.ci?.apply === "push-main-production-infra-environment",
        )
        .flatMap((stack) =>
          (stack.changedPathPatterns ?? []).filter((pattern) =>
            pattern.startsWith(".github/workflows/"),
          ),
        ),
    ),
  ].sort();
}

function assertDriftWorkflowEnvCoversAutoAppliedStackVars(stacks) {
  const stackWorkflowPaths = autoAppliedStackWorkflowPaths(stacks);
  const requiredNames = new Set();

  for (const workflowPath of stackWorkflowPaths) {
    for (const name of terraformEnvNames(workflowPath)) {
      requiredNames.add(name);
    }
  }

  const driftNames = terraformEnvNames(".github/workflows/terraform-drift.yml");
  const missingNames = [...requiredNames]
    .filter((name) => !driftNames.has(name))
    .sort();

  assert(
    missingNames.length === 0,
    `terraform-drift.yml is missing TF_VAR_* values used by auto-applied stack workflows: ${missingNames.join(", ")}`,
  );
}

const registry = JSON.parse(run(["list", "--json"]));
const stackIds = registry.stacks.map((stack) => stack.id);
const requiredStackIds = [
  "platform",
  "alerts-rules",
  "alerts-delivery",
  "aegis",
  "governance-watchdog",
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
  assert(
    stack.changedPathPatterns.includes(
      "scripts/terraform/terraform-fmt-check.mjs",
    ),
    `${stack.id} must react to format-helper edits`,
  );
}

assertDriftWorkflowEnvCoversAutoAppliedStackVars(registry.stacks);
assertMetricsBridgeScalingOwnership();
assertRepositoryLocalOutputsStayInCheckout();

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
    matrix.include.length === registry.stacks.length,
    "registry change should validate every stack",
  );

  writeFileSync(pathsFile, "docs/terraform.md\n");
  matrix = JSON.parse(run(["changed", "--paths-file", pathsFile, "--json"]));
  assert(
    matrix.include.length === 0,
    "docs-only Terraform overview should not run Terraform validate",
  );

  runValidateFormatTest(tempDir);
  runApplyGuardTests(tempDir);
  runPlatformPlanPolicyTests(tempDir);
  runWriteOnlyLoggingGuardTests(tempDir);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("tf-stacks tests passed");
