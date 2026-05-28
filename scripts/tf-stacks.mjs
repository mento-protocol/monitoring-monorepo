#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryPath = path.join(repoRoot, "terraform.stacks.json");
const AUTO_APPLY_CI_POLICY = "push-main-production-environment";
const FORCE_LOCAL_APPLY_ARG = "--force-local-apply";
const ORIGIN_MAIN_FETCH_REFSPEC = "refs/heads/main:refs/remotes/origin/main";

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage:
  pnpm tf list [--json]
  pnpm tf changed [--base <ref>] [--head <ref>] [--paths-file <file>] [--json]
  pnpm tf validate [<stack-id>]
  pnpm tf plan <stack-id> [terraform args...]
  pnpm tf apply <stack-id> [--force-local-apply] [terraform args...]

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
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
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
    runTerraform(stack, ["fmt", "-check", "-recursive"], {
      env: { TF_DATA_DIR: tfDataDir },
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

function localApplySafetyStatus() {
  try {
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

    gitOutput(["fetch", "--quiet", "origin", ORIGIN_MAIN_FETCH_REFSPEC]);
    const originMain = gitOutput(["rev-parse", "origin/main"]);
    const headMatchesOriginMain = head === originMain;

    return {
      branch,
      clean,
      headMatchesOriginMain,
      safe: branch === "main" && clean && headMatchesOriginMain,
    };
  } catch (error) {
    return {
      error: error.message,
      safe: false,
    };
  }
}

function assertLocalApplyAllowed(stack, forceLocalApply) {
  if (stack.ci.apply !== AUTO_APPLY_CI_POLICY || forceLocalApply) {
    return;
  }

  const status = localApplySafetyStatus();
  if (status.safe) {
    return;
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
      `refusing local Terraform apply for auto-applied stack ${stack.id}`,
      "Expected safe path: merge to main and let GitHub Actions apply through the production environment.",
      `Override for a deliberate local apply: pass ${FORCE_LOCAL_APPLY_ARG}.`,
      checkoutDetails,
    ].join("\n"),
  );
}

function runStackCommand(command, args) {
  const stackId = args[0];
  if (!stackId) {
    throw new Error(`${command} requires a stack id`);
  }
  const stack = stackById(stackId);
  const rawTerraformArgs = args.slice(1);
  const { forceLocalApply, terraformArgs } =
    command === "apply"
      ? splitApplyArgs(rawTerraformArgs)
      : { forceLocalApply: false, terraformArgs: rawTerraformArgs };
  const initArgs = ["init", "-input=false"];

  if (command === "apply") {
    assertLocalApplyAllowed(stack, forceLocalApply);
  }

  process.stderr.write(
    `Terraform stack ${stack.id}: path=${stack.path}, state=${stack.state.prefix}, applyPolicy=${stack.applyPolicy}\n`,
  );
  runTerraform(stack, initArgs);
  runTerraform(stack, [command, ...terraformArgs]);
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
  process.exit(1);
}
