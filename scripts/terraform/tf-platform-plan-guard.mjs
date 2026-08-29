import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertMetricsBridgeTemplatePlan,
  parseMetricsBridgeTemplateRolloutActive,
} from "./check-metrics-bridge-template-plan.mjs";
import { assertHumanMergeBoundaryPlan } from "./check-human-merge-boundary-plan.mjs";

const PLAN_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const PEG_POLICY_CONTROLLER_RECOVERY_TARGET =
  "google_project_iam_custom_role.peg_policy_bucket_controller";
const APP_PRIVATE_KEY_VARIABLE = "local_agent_github_app_private_key";
const APP_CREDENTIAL_ACTIVE_VARIABLE =
  "local_agent_github_app_credential_active";
const APP_PRIVATE_KEY_RESOURCE_ADDRESS =
  "google_secret_manager_secret_version.local_agent_github_app_private_key[0]";
const GITHUB_PROVIDER_TOKEN_VARIABLE = "github_token";
const APP_PRIVATE_KEY_MAX_BYTES = 65536;
const APP_PRIVATE_KEY_PREFLIGHT_ERROR =
  "refusing platform Terraform because the operator tfvars App key is missing or is not a canonical, parseable 2048-bit-or-stronger RSA PKCS#1 or unencrypted PKCS#8 private key";
const CANONICAL_BASE64_LINES =
  "(?:[A-Za-z0-9+/]{64}\\n)*(?:[A-Za-z0-9+/]{4}){0,15}(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)";
const CANONICAL_APP_PRIVATE_KEY_PATTERN = new RegExp(
  `^(?:-----BEGIN RSA PRIVATE KEY-----\\n${CANONICAL_BASE64_LINES}\\n-----END RSA PRIVATE KEY-----|-----BEGIN PRIVATE KEY-----\\n${CANONICAL_BASE64_LINES}\\n-----END PRIVATE KEY-----)\\n?$`,
  "u",
);
const RESTRICTED_CLI_VARIABLES = new Set([
  APP_PRIVATE_KEY_VARIABLE,
  GITHUB_PROVIDER_TOKEN_VARIABLE,
]);
const AMBIENT_GITHUB_AUTH_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PEM_FILE",
];

function assertNotRestrictedCliVariable(value) {
  const name = String(value).split("=", 1)[0].trim();
  if (RESTRICTED_CLI_VARIABLES.has(name)) {
    throw new Error(
      "refusing platform Terraform with a restricted CLI credential variable; supply credentials through the operator tfvars file",
    );
  }
}

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
      if (arg === "-var") assertNotRestrictedCliVariable(value);
      planArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-var=") || arg.startsWith("-var-file=")) {
      if (arg.endsWith("=")) {
        throw new Error(`${arg.split("=")[0]} requires a value`);
      }
      if (arg.startsWith("-var=")) {
        assertNotRestrictedCliVariable(arg.slice("-var=".length));
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
    throw new Error("unsupported platform Terraform argument");
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
  const providerRuntimeOverrides = [
    "TF_CLI_CONFIG_FILE",
    "TF_REATTACH_PROVIDERS",
  ].filter((name) => Object.hasOwn(environment, name));
  if (providerRuntimeOverrides.length > 0) {
    throw new Error(
      "refusing platform Terraform with a provider runtime override present; the wrapper owns provider selection and CLI configuration",
    );
  }
  const restrictedCredentialVariables = [
    "TF_VAR_local_agent_github_app_private_key",
    "TF_VAR_github_token",
  ].filter((name) => Object.hasOwn(environment, name));
  if (restrictedCredentialVariables.length > 0) {
    throw new Error(
      "refusing platform Terraform with a restricted TF_VAR credential present; supply credentials through the operator tfvars file",
    );
  }
  if (
    AMBIENT_GITHUB_AUTH_VARIABLES.some((name) =>
      Object.hasOwn(environment, name),
    )
  ) {
    throw new Error(
      "refusing platform Terraform with ambient GitHub authentication present; supply the platform GitHub PAT only through the operator tfvars file",
    );
  }
  const githubProviderOverrides = [
    "GITHUB_OWNER",
    "GITHUB_ORGANIZATION",
    "GITHUB_BASE_URL",
    "GITHUB_MAX_PER_PAGE",
  ].filter((name) => Object.hasOwn(environment, name));
  if (githubProviderOverrides.length > 0) {
    throw new Error(
      `refusing platform Terraform with GitHub provider override environment: ${githubProviderOverrides.sort().join(", ")}`,
    );
  }
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

function readHumanMergeBoundaryPolicy(executionStack) {
  try {
    return JSON.parse(
      readFileSync(
        path.join(executionStack.path, "human-merge-boundary-policy.json"),
        "utf8",
      ),
    );
  } catch {
    throw new Error(
      "could not read the human merge boundary policy from the verified Terraform source snapshot",
    );
  }
}

function fixedPrivateKeyFailure() {
  throw new Error(APP_PRIVATE_KEY_PREFLIGHT_ERROR);
}

function scanHclLine(line, state) {
  let code = "";
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (state.blockComment) {
      code += " ";
      if (character === "*" && next === "/") {
        code += " ";
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quoted) {
      code += " ";
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === "#" || (character === "/" && next === "/")) {
      code += " ".repeat(line.length - index);
      break;
    }
    if (character === "/" && next === "*") {
      code += "  ";
      state.blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      code += " ";
      quoted = true;
      continue;
    }
    code += character;
  }
  if (quoted) fixedPrivateKeyFailure();
  return code;
}

function updateHclDepth(code, state) {
  for (const character of code) {
    if (["{", "[", "("].includes(character)) {
      state.depth += 1;
    } else if (["}", "]", ")"].includes(character)) {
      state.depth -= 1;
      if (state.depth < 0) fixedPrivateKeyFailure();
    }
  }
}

function readLiteralPrivateKeyHeredoc(contents) {
  if (contents.includes("\r")) fixedPrivateKeyFailure();
  const lines = contents.split("\n");
  const state = { blockComment: false, depth: 0, heredoc: undefined };
  const assignments = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (state.heredoc) {
      if (line.trim() === state.heredoc) state.heredoc = undefined;
      continue;
    }

    const code = scanHclLine(line, state);
    const assignment =
      state.depth === 0
        ? new RegExp(
            `^[ \\t]*${APP_PRIVATE_KEY_VARIABLE}[ \\t]*=[ \\t]*<<([A-Za-z_][A-Za-z0-9_]*)[ \\t]*$`,
            "u",
          ).exec(code)
        : null;
    if (assignment) {
      const delimiter = assignment[1];
      const valueLines = [];
      let end = index + 1;
      for (; end < lines.length && lines[end] !== delimiter; end += 1) {
        valueLines.push(lines[end]);
      }
      if (end >= lines.length) fixedPrivateKeyFailure();
      assignments.push(`${valueLines.join("\n")}\n`);
      index = end;
      continue;
    }
    if (
      state.depth === 0 &&
      new RegExp(`^[ \\t]*${APP_PRIVATE_KEY_VARIABLE}[ \\t]*=`, "u").test(code)
    ) {
      fixedPrivateKeyFailure();
    }

    const genericHeredoc = /<<-?([A-Za-z_][A-Za-z0-9_]*)/u.exec(code);
    updateHclDepth(code, state);
    if (genericHeredoc) state.heredoc = genericHeredoc[1];
  }
  if (state.blockComment || state.depth !== 0 || state.heredoc) {
    fixedPrivateKeyFailure();
  }
  if (assignments.length > 1) fixedPrivateKeyFailure();
  return assignments[0];
}

function readPrivateKeyAssignment(variableFilePath) {
  let contents;
  try {
    contents = readFileSync(variableFilePath, "utf8");
  } catch {
    fixedPrivateKeyFailure();
  }
  if (variableFilePath.endsWith(".tfvars.json")) {
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      fixedPrivateKeyFailure();
    }
    if (!isPlainObject(parsed)) fixedPrivateKeyFailure();
    if (!Object.hasOwn(parsed, APP_PRIVATE_KEY_VARIABLE)) return undefined;
    if (typeof parsed[APP_PRIVATE_KEY_VARIABLE] !== "string") {
      fixedPrivateKeyFailure();
    }
    return parsed[APP_PRIVATE_KEY_VARIABLE];
  }
  return readLiteralPrivateKeyHeredoc(contents);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function variableFilePaths(args) {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-var-file") {
      const value = args[index + 1];
      if (value === undefined) fixedPrivateKeyFailure();
      paths.push(value);
      index += 1;
    } else if (args[index].startsWith("-var-file=")) {
      paths.push(args[index].slice("-var-file=".length));
    }
  }
  return paths;
}

function planUsesActiveAppCredential(plan) {
  if (plan?.variables?.[APP_CREDENTIAL_ACTIVE_VARIABLE]?.value === true) {
    return true;
  }
  return plan?.resource_changes?.some(
    (entry) => entry?.address === APP_PRIVATE_KEY_RESOURCE_ADDRESS,
  );
}

export function assertLocalAgentAppPrivateKeyPreflight(plan, privatePlanArgs) {
  if (!planUsesActiveAppCredential(plan)) return;
  let privateKey;
  for (const variableFilePath of variableFilePaths(privatePlanArgs)) {
    const candidate = readPrivateKeyAssignment(variableFilePath);
    if (candidate !== undefined) privateKey = candidate;
  }
  if (
    typeof privateKey !== "string" ||
    Buffer.byteLength(privateKey, "utf8") > APP_PRIVATE_KEY_MAX_BYTES ||
    !CANONICAL_APP_PRIVATE_KEY_PATTERN.test(privateKey)
  ) {
    fixedPrivateKeyFailure();
  }

  try {
    const key = createPrivateKey({ format: "pem", key: privateKey });
    if (
      key.type !== "private" ||
      key.asymmetricKeyType !== "rsa" ||
      !Number.isSafeInteger(key.asymmetricKeyDetails?.modulusLength) ||
      key.asymmetricKeyDetails.modulusLength < 2048
    ) {
      fixedPrivateKeyFailure();
    }
    const signature = sign(
      "RSA-SHA256",
      Buffer.from("local-agent-github-app-key-preflight-v1", "ascii"),
      key,
    );
    signature.fill(0);
  } catch {
    fixedPrivateKeyFailure();
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
    assertLocalAgentAppPrivateKeyPreflight(plan, privatePlanArgs);
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
    const humanMergeBoundaryPolicy =
      readHumanMergeBoundaryPolicy(executionStack);
    assertHumanMergeBoundaryPlan(plan, {
      policy: humanMergeBoundaryPolicy,
      recoveryTargetOnly,
    });
    process.stderr.write("Human merge boundary plan policy: safe\n");

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
