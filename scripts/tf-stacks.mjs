#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkTerraformFormat } from "./terraform-fmt-check.mjs";
import {
  assertPlatformTerraformEnvironment,
  parsePlatformCommandArgs,
  runGuardedPlatformCommand,
} from "./tf-platform-plan-guard.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryPath = path.join(repoRoot, "terraform.stacks.json");
const AUTO_APPLY_CI_POLICY = "push-main-production-infra-environment";
const FORCE_LOCAL_APPLY_ARG = "--force-local-apply";
const ORIGIN_MAIN_FETCH_REFSPEC = "refs/heads/main:refs/remotes/origin/main";
const WRITE_ONLY_SECRET_STACKS = new Set(["platform"]);
const WORKFLOW_ONLY_LOCAL_STATEFUL_STACKS = new Map([
  ["peg-policy-publication", ".github/workflows/peg-policy-publication.yml"],
]);
const PLATFORM_STACK_ID = "platform";

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  pnpm tf list [--json]
  pnpm tf changed [--base <ref>] [--head <ref>] [--paths-file <file>] [--json]
  pnpm tf validate [<stack-id>]
  pnpm tf plan <stack-id> [terraform args...]
  pnpm tf apply <stack-id> [--force-local-apply] [terraform args...]

Platform apply requires an explicit -auto-approve acknowledgement after human approval.

Stack ids come from terraform.stacks.json.
`);
  process.exit(exitCode);
}

function loadRegistry() {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (registry.version !== 1 || !Array.isArray(registry.stacks)) {
    throw new Error(
      "terraform.stacks.json must contain version=1 and a stacks array",
    );
  }

  const seen = new Set();
  for (const stack of registry.stacks) {
    for (const field of [
      "id",
      "name",
      "path",
      "state",
      "providers",
      "ci",
      "applyPolicy",
      "changedPathPatterns",
    ]) {
      if (stack[field] === undefined) {
        throw new Error(`stack is missing ${field}: ${JSON.stringify(stack)}`);
      }
    }
    if (seen.has(stack.id)) {
      throw new Error(`duplicate stack id: ${stack.id}`);
    }
    seen.add(stack.id);
  }

  return registry;
}

const registry = loadRegistry();

function stackById(id) {
  const stack = registry.stacks.find((candidate) => candidate.id === id);
  if (!stack) {
    throw new Error(`unknown Terraform stack: ${id}`);
  }
  return stack;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `${command} exited with status ${result.status ?? 1}`,
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result.stdout ?? "";
}

function runTerraform(stack, args, options = {}) {
  return run("terraform", [`-chdir=${stack.path}`, ...args], options);
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function gitSource(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result.stdout;
}

function printStacks(json) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ stacks: registry.stacks }, null, 2)}\n`,
    );
    return;
  }

  for (const stack of registry.stacks) {
    process.stdout.write(
      [
        `${stack.id} (${stack.path})`,
        `  state: ${stack.state.backend}/${stack.state.bucket}/${stack.state.prefix}`,
        `  providers: ${stack.providers.join(", ")}`,
        `  ci: validate=${stack.ci.validate}, plan=${stack.ci.plan}, apply=${stack.ci.apply}`,
        `  apply policy: ${stack.applyPolicy}`,
      ].join("\n") + "\n",
    );
  }
}

function printList(args) {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown list argument: ${arg}`);
    }
  }
  printStacks(json);
}

function patternMatches(pattern, changedPath) {
  const isPrefixPattern = pattern.endsWith("/**");
  const literalPart = isPrefixPattern ? pattern.slice(0, -3) : pattern;
  if (
    ["*", "?", "{", "}", "[", "]"].some((char) => literalPart.includes(char))
  ) {
    throw new Error(
      `unsupported glob pattern in changedPathPatterns: ${pattern}`,
    );
  }

  if (isPrefixPattern) {
    const prefix = literalPart;
    return changedPath === prefix || changedPath.startsWith(`${prefix}/`);
  }
  return changedPath === pattern;
}

function changedPathsFromFile(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitChangedPaths(baseRef, headRef) {
  if (
    !baseRef &&
    !headRef &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
  ) {
    return ["terraform.stacks.json"];
  }

  const candidates = [];
  if (baseRef && headRef) {
    candidates.push([
      "diff",
      "--name-only",
      "--no-renames",
      `${baseRef}...${headRef}`,
    ]);
    candidates.push(["diff", "--name-only", "--no-renames", baseRef, headRef]);
  } else if (process.env.GITHUB_BASE_REF) {
    candidates.push([
      "diff",
      "--name-only",
      "--no-renames",
      `origin/${process.env.GITHUB_BASE_REF}...HEAD`,
    ]);
  } else if (process.env.GITHUB_EVENT_BEFORE) {
    candidates.push([
      "diff",
      "--name-only",
      "--no-renames",
      process.env.GITHUB_EVENT_BEFORE,
      "HEAD",
    ]);
  } else {
    candidates.push(["diff", "--name-only", "--no-renames", "HEAD^", "HEAD"]);
  }

  for (const args of candidates) {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/u).filter(Boolean);
    }
  }

  throw new Error("could not determine changed paths");
}

function changedStacks(changedPaths) {
  const matched = registry.stacks.filter((stack) =>
    changedPaths.some((changedPath) =>
      (stack.changedPathPatterns ?? [`${stack.path}/**`]).some((pattern) =>
        patternMatches(pattern, changedPath),
      ),
    ),
  );

  return matched.map((stack) => ({
    id: stack.id,
    name: stack.name,
    path: stack.path,
    state_prefix: stack.state.prefix,
    ci_plan: stack.ci.plan,
    ci_apply: stack.ci.apply,
    apply_policy: stack.applyPolicy,
  }));
}

function printChanged(args) {
  let baseRef = "";
  let headRef = "";
  let pathsFile = "";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base") {
      baseRef = args[++index] ?? "";
    } else if (arg === "--head") {
      headRef = args[++index] ?? "";
    } else if (arg === "--paths-file") {
      pathsFile = args[++index] ?? "";
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`unknown changed argument: ${arg}`);
    }
  }

  const paths = pathsFile
    ? changedPathsFromFile(pathsFile)
    : gitChangedPaths(baseRef, headRef);
  const include = changedStacks(paths);
  if (json) {
    process.stdout.write(`${JSON.stringify({ include })}\n`);
    return;
  }

  for (const stack of include) {
    process.stdout.write(`${stack.id}\t${stack.path}\n`);
  }
}

function validateStacks(stackIds) {
  const stacks =
    stackIds.length > 0 ? stackIds.map(stackById) : registry.stacks;
  for (const stack of stacks) {
    const tfDataDir = path.join(repoRoot, stack.path, ".terraform-tf-wrapper");
    process.stdout.write(
      `\n==> terraform validate stack ${stack.id} (${stack.path})\n`,
    );
    checkTerraformFormat(stack.path, {
      env: { ...process.env, TF_DATA_DIR: tfDataDir },
      repoRoot,
    });
    runTerraform(stack, ["init", "-backend=false", "-input=false"], {
      env: { TF_DATA_DIR: tfDataDir },
    });
    runTerraform(stack, ["validate", "-no-color"], {
      env: { TF_DATA_DIR: tfDataDir },
    });
  }
}

function splitApplyArgs(args) {
  let forceLocalApply = false;
  const terraformArgs = [];
  for (const arg of args) {
    if (arg === FORCE_LOCAL_APPLY_ARG) {
      forceLocalApply = true;
    } else {
      terraformArgs.push(arg);
    }
  }
  return { forceLocalApply, terraformArgs };
}

function consumeTerraformArgSeparator(args) {
  const normalized = args[0] === "--" ? args.slice(1) : [...args];
  if (normalized.includes("--")) {
    throw new Error(
      "Terraform arguments may contain at most one leading -- separator",
    );
  }
  return normalized;
}

function localApplySafetyStatus() {
  try {
    gitOutput(["fetch", "--quiet", "origin", ORIGIN_MAIN_FETCH_REFSPEC]);
    const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = gitOutput(["status", "--porcelain"]);
    const head = gitOutput(["rev-parse", "HEAD"]);
    const clean = status.length === 0;

    if (branch !== "main" || !clean) {
      return {
        branch,
        clean,
        safe: false,
      };
    }

    const originMain = gitOutput(["rev-parse", "origin/main"]);
    const headMatchesOriginMain = head === originMain;

    return {
      branch,
      clean,
      headMatchesOriginMain,
      safe: branch === "main" && clean && headMatchesOriginMain,
      sourceHead: head,
    };
  } catch (error) {
    return {
      error: error.message,
      safe: false,
    };
  }
}

function assertTrustedCheckoutAllowed(stack, command, forceLocalApply) {
  const protectedWorkflow = WORKFLOW_ONLY_LOCAL_STATEFUL_STACKS.get(stack.id);
  if (protectedWorkflow) {
    throw new Error(
      [
        `refusing local Terraform ${command} for workflow-only stack ${stack.id}`,
        `Local wrapper plans and applies are disabled for ${stack.id}, including ${FORCE_LOCAL_APPLY_ARG}.`,
        `Expected safe path: dispatch ${protectedWorkflow} from main.`,
        `For credential-free local validation, run pnpm tf validate ${stack.id}.`,
      ].join("\n"),
    );
  }

  const isManualSecretCommand =
    WRITE_ONLY_SECRET_STACKS.has(stack.id) &&
    ["plan", "apply"].includes(command);
  const isAutoAppliedStack =
    command === "apply" && stack.ci.apply === AUTO_APPLY_CI_POLICY;
  if (
    (!isManualSecretCommand && !isAutoAppliedStack) ||
    (!isManualSecretCommand && forceLocalApply)
  ) {
    return;
  }

  const status = localApplySafetyStatus();
  if (status.safe) {
    return status.sourceHead;
  }

  const checkoutDetails = status.error
    ? `Could not verify checkout safety: ${status.error}`
    : [
        `Current checkout: branch=${status.branch}`,
        `clean=${status.clean ? "yes" : "no"}`,
        ...(status.headMatchesOriginMain === undefined
          ? []
          : [
              `HEAD==origin/main=${
                status.headMatchesOriginMain ? "yes" : "no"
              }`,
            ]),
      ].join(", ");

  throw new Error(
    [
      isManualSecretCommand
        ? `refusing platform Terraform ${command} outside clean current main`
        : `refusing local Terraform apply for auto-applied stack ${stack.id}`,
      isManualSecretCommand
        ? "Platform secret inputs require a clean main checkout whose HEAD matches freshly fetched origin/main before plan or apply."
        : "Expected safe path: merge to main and let GitHub Actions apply through the production environment.",
      ...(isManualSecretCommand
        ? []
        : [
            `Override for a deliberate local apply: pass ${FORCE_LOCAL_APPLY_ARG}.`,
          ]),
      checkoutDetails,
    ].join("\n"),
  );
}

function materializeCommittedStackSnapshot(stack, sourceHead) {
  const snapshotRoot = mkdtempSync(
    path.join(tmpdir(), "tf-stacks-platform-source."),
  );
  const trackedFiles = gitOutput([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    sourceHead,
    "--",
    stack.path,
  ])
    .split("\0")
    .filter(Boolean);

  if (trackedFiles.length === 0) {
    rmSync(snapshotRoot, { force: true, recursive: true });
    throw new Error(
      `could not materialize committed source for Terraform stack ${stack.id}`,
    );
  }

  try {
    for (const trackedFile of trackedFiles) {
      if (
        trackedFile !== stack.path &&
        !trackedFile.startsWith(`${stack.path}/`)
      ) {
        throw new Error(
          `refusing committed Terraform source outside ${stack.path}: ${trackedFile}`,
        );
      }
      const destination = path.join(snapshotRoot, trackedFile);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(
        destination,
        gitSource(["show", `${sourceHead}:${trackedFile}`]),
      );
    }
  } catch (error) {
    rmSync(snapshotRoot, { force: true, recursive: true });
    throw error;
  }

  return snapshotRoot;
}

function platformVariableArgs(stack, terraformArgs) {
  const sourceRoot = path.join(repoRoot, stack.path);
  const implicitVariableFiles = [
    "terraform.tfvars",
    "terraform.tfvars.json",
    ...readdirSync(sourceRoot)
      .filter(
        (name) =>
          name.endsWith(".auto.tfvars") || name.endsWith(".auto.tfvars.json"),
      )
      .sort(),
  ]
    .map((name) => path.join(sourceRoot, name))
    .filter(existsSync)
    .map((filePath) => `-var-file=${filePath}`);

  const normalizedArgs = [];
  for (let index = 0; index < terraformArgs.length; index += 1) {
    const arg = terraformArgs[index];
    if (arg === "-var-file") {
      const value = terraformArgs[++index];
      if (!value) {
        throw new Error("-var-file requires a path");
      }
      normalizedArgs.push(
        "-var-file",
        path.isAbsolute(value) ? value : path.join(sourceRoot, value),
      );
    } else if (arg.startsWith("-var-file=")) {
      const value = arg.slice("-var-file=".length);
      if (!value) {
        throw new Error("-var-file requires a path");
      }
      normalizedArgs.push(
        `-var-file=${
          path.isAbsolute(value) ? value : path.join(sourceRoot, value)
        }`,
      );
    } else {
      normalizedArgs.push(arg);
    }
  }

  const planArgs = [...implicitVariableFiles, ...normalizedArgs];
  const savedPlanApplyArgs = [];
  for (let index = 0; index < planArgs.length; index += 1) {
    const arg = planArgs[index];
    if (arg === "-var" || arg === "-var-file") {
      savedPlanApplyArgs.push(arg, planArgs[index + 1]);
      index += 1;
    } else if (arg.startsWith("-var=") || arg.startsWith("-var-file=")) {
      savedPlanApplyArgs.push(arg);
    }
  }

  return { planArgs, savedPlanApplyArgs };
}

function assertWriteOnlySecretLoggingDisabled(stack, command) {
  if (
    !WRITE_ONLY_SECRET_STACKS.has(stack.id) ||
    !["plan", "apply"].includes(command)
  ) {
    return;
  }

  const enabledLoggingVariables = Object.keys(process.env)
    .filter(
      (name) =>
        ["TF_LOG", "TF_LOG_CORE", "TF_LOG_PROVIDER", "TF_LOG_SDK"].includes(
          name,
        ) ||
        name.startsWith("TF_LOG_PROVIDER_") ||
        name.startsWith("TF_LOG_SDK_"),
    )
    .filter((name) => {
      const value = process.env[name]?.trim().toLowerCase();
      if (!value) {
        return false;
      }
      const isSdkLevel = name === "TF_LOG_SDK_PROTO";
      const isSdkDataOrUnknown = name.startsWith("TF_LOG_SDK_") && !isSdkLevel;
      return isSdkDataOrUnknown || value !== "off";
    })
    .sort();
  if (enabledLoggingVariables.length > 0) {
    throw new Error(
      `refusing platform Terraform ${command}: ${enabledLoggingVariables.join(
        ", ",
      )} can expose write-only secret payloads in provider logs or protocol dumps; unset them (OFF is accepted only for Terraform log-level variables)`,
    );
  }
}

function runStackCommand(command, args) {
  const stackId = args[0];
  if (!stackId) {
    throw new Error(`${command} requires a stack id`);
  }
  const stack = stackById(stackId);
  const rawTerraformArgs = consumeTerraformArgSeparator(args.slice(1));
  const { forceLocalApply, terraformArgs } =
    command === "apply"
      ? splitApplyArgs(rawTerraformArgs)
      : { forceLocalApply: false, terraformArgs: rawTerraformArgs };
  const initArgs = ["init", "-input=false"];

  assertWriteOnlySecretLoggingDisabled(stack, command);
  if (stack.id === PLATFORM_STACK_ID && ["plan", "apply"].includes(command)) {
    assertPlatformTerraformEnvironment();
  }
  const trustedSourceHead = ["plan", "apply"].includes(command)
    ? assertTrustedCheckoutAllowed(stack, command, forceLocalApply)
    : undefined;
  let snapshotRoot;

  process.stderr.write(
    `Terraform stack ${stack.id}: path=${stack.path}, state=${stack.state.prefix}, applyPolicy=${stack.applyPolicy}\n`,
  );
  try {
    const executionStack =
      WRITE_ONLY_SECRET_STACKS.has(stack.id) && trustedSourceHead
        ? (() => {
            snapshotRoot = materializeCommittedStackSnapshot(
              stack,
              trustedSourceHead,
            );
            return {
              ...stack,
              path: path.join(snapshotRoot, stack.path),
            };
          })()
        : stack;
    const platformPolicy =
      stack.id === PLATFORM_STACK_ID && ["plan", "apply"].includes(command)
        ? parsePlatformCommandArgs(command, terraformArgs)
        : undefined;
    const platformTerraformEnvironment = platformPolicy
      ? {
          TF_DATA_DIR: path.join(snapshotRoot, ".terraform-data"),
          TF_WORKSPACE: "default",
        }
      : undefined;
    const runExecutionTerraform = platformTerraformEnvironment
      ? (targetStack, terraformCommandArgs, options = {}) =>
          runTerraform(targetStack, terraformCommandArgs, {
            ...options,
            env: {
              ...options.env,
              ...platformTerraformEnvironment,
            },
          })
      : runTerraform;
    const platformVariables = WRITE_ONLY_SECRET_STACKS.has(stack.id)
      ? platformVariableArgs(stack, platformPolicy?.planArgs ?? terraformArgs)
      : undefined;
    const executionArgs = platformVariables?.planArgs ?? terraformArgs;
    runExecutionTerraform(executionStack, initArgs);
    if (platformPolicy) {
      runGuardedPlatformCommand({
        command,
        executionStack,
        planArgs: executionArgs,
        recoveryTargetOnly: platformPolicy.recoveryTargetOnly,
        runTerraform: runExecutionTerraform,
        savedPlanApplyArgs: [
          ...(platformVariables?.savedPlanApplyArgs ?? []),
          ...platformPolicy.savedPlanApplyArgs,
        ],
      });
    } else {
      runExecutionTerraform(executionStack, [command, ...executionArgs]);
    }
  } finally {
    if (snapshotRoot) {
      rmSync(snapshotRoot, { force: true, recursive: true });
    }
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list":
      printList(args);
      break;
    case "changed":
      printChanged(args);
      break;
    case "validate":
      validateStacks(args);
      break;
    case "plan":
    case "apply":
      runStackCommand(command, args);
      break;
    case "-h":
    case "--help":
      usage(0);
      break;
    default:
      usage(command ? 2 : 0);
  }
} catch (error) {
  process.stderr.write(`tf-stacks: ${error.message}\n`);
  process.exit(error.exitCode ?? 1);
}
