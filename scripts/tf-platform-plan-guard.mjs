import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertMetricsBridgeTemplatePlan,
  parseMetricsBridgeTemplateRolloutActive,
} from "./check-metrics-bridge-template-plan.mjs";

const PLAN_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const PEG_POLICY_CONTROLLER_RECOVERY_TARGET =
  "google_project_iam_custom_role.peg_policy_bucket_controller";

function takeOptionValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

export function parsePlatformCommandArgs(command, args) {
  const planArgs = [];
  const savedPlanApplyArgs = [];
  const targets = [];
  let autoApproveCount = 0;
  let refreshFalse = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["-var", "-var-file"].includes(arg)) {
      const value = takeOptionValue(args, index, arg);
      planArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-var=") || arg.startsWith("-var-file=")) {
      if (arg.endsWith("=")) {
        throw new Error(`${arg.split("=")[0]} requires a value`);
      }
      planArgs.push(arg);
      continue;
    }
    if (["-lock-timeout", "-parallelism"].includes(arg)) {
      const value = takeOptionValue(args, index, arg);
      planArgs.push(arg, value);
      savedPlanApplyArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-lock-timeout=") || arg.startsWith("-parallelism=")) {
      if (arg.endsWith("=")) {
        throw new Error(`${arg.split("=")[0]} requires a value`);
      }
      planArgs.push(arg);
      savedPlanApplyArgs.push(arg);
      continue;
    }
    if (["-compact-warnings", "-no-color"].includes(arg)) {
      planArgs.push(arg);
      savedPlanApplyArgs.push(arg);
      continue;
    }
    if (arg === "-input=false") {
      continue;
    }
    if (arg === "-lock=true") {
      planArgs.push(arg);
      savedPlanApplyArgs.push(arg);
      continue;
    }
    if (arg === "-refresh=true") {
      planArgs.push(arg);
      continue;
    }
    if (arg === "-auto-approve") {
      autoApproveCount += 1;
      continue;
    }
    if (arg === "-refresh=false") {
      refreshFalse = true;
      planArgs.push(arg);
      continue;
    }
    if (arg === "-target") {
      const value = takeOptionValue(args, index, arg);
      targets.push(value);
      planArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-target=")) {
      const value = arg.slice("-target=".length);
      if (!value) throw new Error("-target requires a value");
      targets.push(value);
      planArgs.push(arg);
      continue;
    }
    throw new Error(`unsupported platform Terraform argument: ${arg}`);
  }

  if (command === "plan" && autoApproveCount > 0) {
    throw new Error("-auto-approve is valid only for platform apply");
  }
  if (command === "apply" && autoApproveCount !== 1) {
    throw new Error(
      "platform apply requires exactly one -auto-approve acknowledgement after explicit human approval",
    );
  }

  const recoveryTargetOnly =
    refreshFalse &&
    targets.length === 1 &&
    targets[0] === PEG_POLICY_CONTROLLER_RECOVERY_TARGET;
  if ((refreshFalse || targets.length > 0) && !recoveryTargetOnly) {
    throw new Error(
      "platform Terraform permits -refresh=false and -target only for the exact ADR 0055 controller recovery",
    );
  }
  return { planArgs, recoveryTargetOnly, savedPlanApplyArgs };
}

export function assertPlatformTerraformEnvironment(environment = process.env) {
  const injectedArgs = Object.keys(environment)
    .filter((name) => name === "TF_CLI_ARGS" || name.startsWith("TF_CLI_ARGS_"))
    .filter((name) => environment[name]?.trim());
  if (injectedArgs.length > 0) {
    throw new Error(
      `refusing platform Terraform with injected CLI arguments: ${injectedArgs.sort().join(", ")}`,
    );
  }
  const workspace = environment.TF_WORKSPACE?.trim();
  if (workspace && workspace !== "default") {
    throw new Error(
      `refusing platform Terraform outside the default workspace: ${workspace}`,
    );
  }
}

function parsePrivatePlanJson(runTerraform, executionStack, planPath) {
  const rawPlan = runTerraform(executionStack, ["show", "-json", planPath], {
    maxBuffer: PLAN_CAPTURE_MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(rawPlan);
  } catch {
    throw new Error("terraform show returned invalid or oversized plan JSON");
  }
}

function snapshotVariableFileArgs(args, privatePlanRoot, copies) {
  const snapshotted = [];
  const snapshot = (sourcePath) => {
    const absoluteSource = path.resolve(sourcePath);
    const existing = copies.get(absoluteSource);
    if (existing) return existing;
    const suffix = absoluteSource.endsWith(".json")
      ? ".tfvars.json"
      : ".tfvars";
    const destination = path.join(
      privatePlanRoot,
      `variables-${String(copies.size).padStart(4, "0")}${suffix}`,
    );
    copyFileSync(absoluteSource, destination);
    chmodSync(destination, 0o600);
    copies.set(absoluteSource, destination);
    return destination;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-var-file") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("-var-file requires a value");
      snapshotted.push(arg, snapshot(value));
      index += 1;
    } else if (arg.startsWith("-var-file=")) {
      snapshotted.push(`-var-file=${snapshot(arg.slice("-var-file=".length))}`);
    } else {
      snapshotted.push(arg);
    }
  }
  return snapshotted;
}

export function runGuardedPlatformCommand({
  command,
  executionStack,
  planArgs,
  recoveryTargetOnly,
  runTerraform,
  savedPlanApplyArgs,
}) {
  const privatePlanRoot = mkdtempSync(
    path.join(tmpdir(), "tf-stacks-platform-plan."),
  );
  const planPath = path.join(privatePlanRoot, "platform.tfplan");
  try {
    const variableFileCopies = new Map();
    const privatePlanArgs = snapshotVariableFileArgs(
      planArgs,
      privatePlanRoot,
      variableFileCopies,
    );
    const privateApplyArgs = snapshotVariableFileArgs(
      savedPlanApplyArgs,
      privatePlanRoot,
      variableFileCopies,
    );
    runTerraform(executionStack, [
      "plan",
      "-input=false",
      ...privatePlanArgs,
      `-out=${planPath}`,
    ]);
    chmodSync(planPath, 0o600);
    const plan = parsePrivatePlanJson(runTerraform, executionStack, planPath);
    const markerSource = readFileSync(
      path.join(executionStack.path, "metrics-bridge.tf"),
      "utf8",
    );
    const rolloutActive = parseMetricsBridgeTemplateRolloutActive(markerSource);
    assertMetricsBridgeTemplatePlan(plan, {
      recoveryTargetOnly,
      requireService: !recoveryTargetOnly,
      rolloutActive,
    });
    process.stderr.write(
      `Metrics Bridge platform plan policy: safe (${rolloutActive ? "rollout" : "stable"})\n`,
    );

    if (command !== "apply") return;
    if (!plan.applyable) {
      process.stderr.write(
        "Validated platform plan has no changes; skipping apply.\n",
      );
      return;
    }
    runTerraform(executionStack, [
      "apply",
      "-input=false",
      ...privateApplyArgs,
      planPath,
    ]);
  } finally {
    rmSync(privatePlanRoot, { force: true, recursive: true });
  }
}
