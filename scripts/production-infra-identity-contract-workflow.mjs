import { isDeepStrictEqual } from "node:util";
import { load as loadYaml } from "js-yaml";
import {
  APPLY_WORKFLOWS,
  PRODUCTION_PROVIDER_VARIABLE,
  PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
  REFRESH_SERVICE_ACCOUNT_VARIABLE,
  SERVICE_AND_DRIFT_WORKFLOWS,
} from "./production-infra-identity-contract-constants.mjs";
import {
  escapeRegExp,
  requireFile,
} from "./production-infra-identity-contract-hcl.mjs";
import {
  validateWorkflowDependencyInventory,
  validateWorkflowInventory,
} from "./production-infra-identity-contract-workflow-inventory.mjs";

function stripYamlComments(contents) {
  return contents
    .split(/(?<=\n)/u)
    .map((line) => {
      let singleQuoted = false;
      let doubleQuoted = false;
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (doubleQuoted) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            doubleQuoted = false;
          }
          continue;
        }
        if (singleQuoted) {
          if (character === "'") singleQuoted = false;
          continue;
        }
        if (character === '"') {
          doubleQuoted = true;
        } else if (character === "'") {
          singleQuoted = true;
        } else if (
          character === "#" &&
          (index === 0 || /\s/u.test(line[index - 1]))
        ) {
          return `${line.slice(0, index)}${line
            .slice(index)
            .replace(/[^\r\n]/gu, " ")}`;
        }
      }
      return line;
    })
    .join("");
}

function extractTopLevelJob(contents, jobName) {
  const startPattern = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, "mu");
  const match = startPattern.exec(contents);
  if (!match) return undefined;
  const remainder = contents.slice(match.index + match[0].length);
  const nextJob = /^ {2}[A-Za-z0-9_-]+:\s*$/mu.exec(remainder);
  const end = nextJob
    ? match.index + match[0].length + nextJob.index
    : contents.length;
  return {
    start: match.index,
    end,
    text: contents.slice(match.index, end),
  };
}

function extractJobSteps(jobText) {
  const stepsHeader = /^ {4}steps:\s*$/mu.exec(jobText);
  if (!stepsHeader) return [];
  const bodyStart = stepsHeader.index + stepsHeader[0].length;
  const remainder = jobText.slice(bodyStart);
  const nextJobProperty = /^ {4}[A-Za-z0-9_-]+:\s*(?:.*)$/mu.exec(remainder);
  const bodyEnd = nextJobProperty
    ? bodyStart + nextJobProperty.index
    : jobText.length;
  const body = jobText.slice(bodyStart, bodyEnd);
  const starts = [...body.matchAll(/^ {6}-(?:\s|$)/gmu)].map(
    (match) => bodyStart + match.index,
  );
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? bodyEnd,
    text: jobText.slice(start, starts[index + 1] ?? bodyEnd),
  }));
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactProductionEnvironment(job) {
  const environment = job.environment;
  if (typeof environment === "string") {
    return environment === "production-infra";
  }
  if (!isMapping(environment)) return false;

  const keys = Object.keys(environment);
  return (
    environment.name === "production-infra" &&
    keys.every((key) => key === "name" || key === "url") &&
    (!Object.hasOwn(environment, "url") || typeof environment.url === "string")
  );
}

function extractedJobMatchesParsedWorkflow(jobText, parsedJob) {
  try {
    const extracted = loadYaml(`jobs:\n${jobText}`);
    return isDeepStrictEqual(extracted?.jobs?.apply, parsedJob);
  } catch {
    return false;
  }
}

function parseStep(stepText) {
  const lines = stepText.split(/\r?\n/u);
  const properties = [];
  let malformed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;

    const propertyPattern =
      index === 0
        ? /^ {6}-\s+([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/u
        : /^ {8}([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/u;
    const property = propertyPattern.exec(line);
    if (property) {
      properties.push({
        key: property[1],
        value: (property[2] ?? "").trim(),
        line: index,
      });
      continue;
    }

    const indentation = /^ */u.exec(line)?.[0].length ?? 0;
    if (index === 0 || indentation <= 8) malformed = true;
  }

  return { lines, malformed, properties };
}

function propertiesNamed(parsedStep, name) {
  return parsedStep.properties.filter((property) => property.key === name);
}

function parseExactChildMapping(parsedStep, name) {
  const properties = propertiesNamed(parsedStep, name);
  if (properties.length !== 1 || properties[0].value !== "") {
    return { entries: [], valid: false };
  }

  const start = properties[0].line + 1;
  const nextProperty = parsedStep.properties.find(
    (property) => property.line >= start,
  );
  const end = nextProperty?.line ?? parsedStep.lines.length;
  const entries = [];

  for (let index = start; index < end; index += 1) {
    const line = parsedStep.lines[index];
    if (line.trim() === "") continue;
    const entry = /^ {10}([A-Za-z0-9_-]+):[ \t]*(.*?)\s*$/u.exec(line);
    if (!entry || entry[2] === "") return { entries: [], valid: false };
    entries.push({ key: entry[1], value: entry[2] });
  }

  return { entries, valid: entries.length > 0 };
}

function hasExactAuthInputs(parsedStep) {
  const mapping = parseExactChildMapping(parsedStep, "with");
  if (!mapping.valid || mapping.entries.length !== 2) return false;

  const inputs = new Map();
  for (const entry of mapping.entries) {
    if (inputs.has(entry.key)) return false;
    inputs.set(entry.key, entry.value);
  }

  return (
    inputs.get("workload_identity_provider") ===
      `\${{ vars.${PRODUCTION_PROVIDER_VARIABLE} }}` &&
    inputs.get("service_account") ===
      `\${{ vars.${PRODUCTION_SERVICE_ACCOUNT_VARIABLE} }}`
  );
}

const AUTH_ACTION_PATTERN = /^google-github-actions\/auth@[A-Za-z0-9._/-]+$/u;
const PROTECTION_COMMANDS = new Set([
  "node scripts/verify-github-environment-protection.mjs",
  'node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"',
]);
const ABSOLUTE_PROTECTION_COMMAND =
  'node "$GITHUB_WORKSPACE/scripts/verify-github-environment-protection.mjs"';
const PROTECTION_ENVIRONMENT = new Map([
  ["GITHUB_TOKEN", "${{ github.token }}"],
  ["GITHUB_ENVIRONMENT_NAME", "production-infra"],
]);
const CHECKOUT_ACTION_PATTERN = /^actions\/checkout@[0-9a-f]{40}$/u;
const CHECKOUT_STEP_KEYS = new Set(["uses"]);
const PROTECTION_STEP_KEYS = new Set(["env", "name", "run"]);
const AUTH_STEP_KEYS = new Set(["name", "uses", "with"]);

function hasOnlyKeys(mapping, allowedKeys) {
  return (
    isMapping(mapping) &&
    Object.keys(mapping).every((key) => allowedKeys.has(key))
  );
}

function isExactProtectionStep(parsedStep) {
  const runs = propertiesNamed(parsedStep, "run");
  const environments = propertiesNamed(parsedStep, "env");
  if (
    parsedStep.malformed ||
    runs.length !== 1 ||
    !PROTECTION_COMMANDS.has(runs[0].value) ||
    environments.length > 1 ||
    (environments.length === 1 && environments[0].value !== "")
  ) {
    return false;
  }

  return parsedStep.properties.every((property) =>
    PROTECTION_STEP_KEYS.has(property.key),
  );
}

function hasExactProtectionEnvironment(step) {
  if (!Object.hasOwn(step, "env")) return true;
  if (!isMapping(step.env)) return false;

  return (
    Object.keys(step.env).length === PROTECTION_ENVIRONMENT.size &&
    Object.entries(step.env).every(
      ([key, value]) => PROTECTION_ENVIRONMENT.get(key) === value,
    )
  );
}

function hasExactSemanticProtectionStep(step) {
  return (
    hasOnlyKeys(step, PROTECTION_STEP_KEYS) &&
    typeof step.run === "string" &&
    PROTECTION_COMMANDS.has(step.run) &&
    (!Object.hasOwn(step, "name") || typeof step.name === "string") &&
    hasExactProtectionEnvironment(step)
  );
}

function hasExactSemanticAuthStep(step) {
  if (
    !hasOnlyKeys(step, AUTH_STEP_KEYS) ||
    !AUTH_ACTION_PATTERN.test(step.uses) ||
    !isMapping(step.with)
  ) {
    return false;
  }

  const inputs = Object.keys(step.with);
  return (
    inputs.length === 2 &&
    step.with.workload_identity_provider ===
      `\${{ vars.${PRODUCTION_PROVIDER_VARIABLE} }}` &&
    step.with.service_account ===
      `\${{ vars.${PRODUCTION_SERVICE_ACCOUNT_VARIABLE} }}` &&
    (!Object.hasOwn(step, "name") || typeof step.name === "string")
  );
}

function hasExactSourceCheckoutStep(parsedStep) {
  if (parsedStep.malformed || parsedStep.properties.length !== 1) return false;
  const [uses] = propertiesNamed(parsedStep, "uses");
  return Boolean(uses && CHECKOUT_ACTION_PATTERN.test(uses.value));
}

function hasExactSemanticCheckoutStep(step) {
  return (
    hasOnlyKeys(step, CHECKOUT_STEP_KEYS) &&
    typeof step.uses === "string" &&
    CHECKOUT_ACTION_PATTERN.test(step.uses)
  );
}

function hasSafeParentEnvironment(parsedWorkflow, parsedApplyJob) {
  if (Object.hasOwn(parsedWorkflow, "env")) return false;
  if (!Object.hasOwn(parsedApplyJob, "env")) return true;
  return (
    isMapping(parsedApplyJob.env) &&
    Object.keys(parsedApplyJob.env).every((key) => key.startsWith("TF_VAR_"))
  );
}

function runDefaultsCannotOverrideProtection(
  parsedWorkflow,
  parsedApplyJob,
  protectionCommand,
) {
  for (const defaults of [parsedWorkflow.defaults, parsedApplyJob.defaults]) {
    if (defaults === undefined) continue;
    if (!isMapping(defaults) || !isMapping(defaults.run)) return false;
    if (Object.hasOwn(defaults.run, "shell")) return false;
    if (
      Object.hasOwn(defaults.run, "working-directory") &&
      protectionCommand !== ABSOLUTE_PROTECTION_COMMAND
    ) {
      return false;
    }
  }
  return true;
}

function contextVariableOccurrences(contents, contextName, variableName) {
  const pattern = new RegExp(
    `\\b${escapeRegExp(contextName)}\\s*(?:\\.\\s*${escapeRegExp(variableName)}\\b|\\[\\s*["']${escapeRegExp(variableName)}["']\\s*\\])`,
    "gu",
  );
  return [...contents.matchAll(pattern)].map((match) => match.index);
}

function variableOccurrences(contents, variableName) {
  return contextVariableOccurrences(contents, "vars", variableName);
}

function decodedVariableOccurrenceCount(root, variableName) {
  const ancestors = new WeakSet();

  function visit(value) {
    if (typeof value === "string") {
      return variableOccurrences(value, variableName).length;
    }
    if (value === null || typeof value !== "object") return 0;
    if (ancestors.has(value)) return 0;

    ancestors.add(value);
    let count = 0;
    if (Array.isArray(value)) {
      for (const entry of value) count += visit(entry);
    } else {
      for (const [key, entry] of Object.entries(value)) {
        count += variableOccurrences(key, variableName).length;
        count += visit(entry);
      }
    }
    ancestors.delete(value);
    return count;
  }

  return visit(root);
}

export function validateWorkflowContract(files, errors) {
  for (const workflowPath of [
    ...APPLY_WORKFLOWS,
    ...SERVICE_AND_DRIFT_WORKFLOWS,
  ]) {
    requireFile(files, workflowPath, errors);
  }
  validateWorkflowDependencyInventory(files, errors);

  const workflowPaths = Object.keys(files)
    .filter((filePath) => /^\.github\/workflows\/.+\.ya?ml$/u.test(filePath))
    .sort();

  for (const workflowPath of workflowPaths) {
    let parsedWorkflow;
    try {
      parsedWorkflow = loadYaml(files[workflowPath]);
    } catch {
      errors.push(
        `${workflowPath}: workflow YAML must be valid and duplicate-free`,
      );
      continue;
    }
    if (!isMapping(parsedWorkflow)) {
      errors.push(`${workflowPath}: workflow YAML must be a top-level mapping`);
      continue;
    }

    validateWorkflowInventory(workflowPath, parsedWorkflow, errors);

    const code = stripYamlComments(files[workflowPath]);
    const decodedRefreshUses = decodedVariableOccurrenceCount(
      parsedWorkflow,
      REFRESH_SERVICE_ACCOUNT_VARIABLE,
    );
    if (
      variableOccurrences(code, REFRESH_SERVICE_ACCOUNT_VARIABLE).length > 0 ||
      decodedRefreshUses > 0
    ) {
      errors.push(
        `${workflowPath}: vars.${REFRESH_SERVICE_ACCOUNT_VARIABLE} must not be used during bootstrap`,
      );
    }

    const providerUses = variableOccurrences(
      code,
      PRODUCTION_PROVIDER_VARIABLE,
    );
    const serviceAccountUses = variableOccurrences(
      code,
      PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
    );
    const decodedProviderUses = decodedVariableOccurrenceCount(
      parsedWorkflow,
      PRODUCTION_PROVIDER_VARIABLE,
    );
    const decodedServiceAccountUses = decodedVariableOccurrenceCount(
      parsedWorkflow,
      PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
    );

    if (!APPLY_WORKFLOWS.includes(workflowPath)) {
      if (
        providerUses.length > 0 ||
        serviceAccountUses.length > 0 ||
        decodedProviderUses > 0 ||
        decodedServiceAccountUses > 0
      ) {
        errors.push(
          `${workflowPath}: production identity variables are allowed only in a protected apply auth step`,
        );
      }
      continue;
    }

    const parsedApplyJob = parsedWorkflow.jobs?.apply;
    const applyJob = extractTopLevelJob(code, "apply");
    if (
      !isMapping(parsedApplyJob) ||
      !applyJob ||
      !extractedJobMatchesParsedWorkflow(
        files[workflowPath].slice(applyJob.start, applyJob.end),
        parsedApplyJob,
      )
    ) {
      errors.push(`${workflowPath}: apply job is missing`);
      continue;
    }
    if (!hasExactProductionEnvironment(parsedApplyJob)) {
      errors.push(
        `${workflowPath}: apply job must use exactly the production-infra environment`,
      );
    }
    if (!hasSafeParentEnvironment(parsedWorkflow, parsedApplyJob)) {
      errors.push(
        `${workflowPath}: workflow env must be absent and apply job env may contain only TF_VAR_ variables`,
      );
    }

    const sourceSteps = extractJobSteps(applyJob.text).map((step) => ({
      ...step,
      parsed: parseStep(step.text),
    }));
    const semanticSteps = Array.isArray(parsedApplyJob.steps)
      ? parsedApplyJob.steps
      : [];
    const authReferences = [
      ...applyJob.text.matchAll(/google-github-actions\/auth@[^\s"'#]+/gu),
    ];
    const semanticAuthIndexes = semanticSteps
      .map((step, index) =>
        isMapping(step) &&
        typeof step.uses === "string" &&
        AUTH_ACTION_PATTERN.test(step.uses)
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (
      authReferences.length !== 1 ||
      semanticAuthIndexes.length !== 1 ||
      sourceSteps.length !== semanticSteps.length
    ) {
      errors.push(
        `${workflowPath}: apply job must contain exactly one Google auth action`,
      );
      continue;
    }

    const authStepIndex = semanticAuthIndexes[0];
    const authStep = sourceSteps[authStepIndex];
    const semanticAuthStep = semanticSteps[authStepIndex];
    const authUses = propertiesNamed(authStep.parsed, "uses");
    if (
      authStep.parsed.malformed ||
      authUses.length !== 1 ||
      !hasExactAuthInputs(authStep.parsed) ||
      !hasExactSemanticAuthStep(semanticAuthStep)
    ) {
      errors.push(
        `${workflowPath}: apply auth must use only the production provider and service account variables`,
      );
    }
    if (
      [
        "GCP_WORKLOAD_IDENTITY_PROVIDER",
        "GCP_SERVICE_ACCOUNT",
        "GCP_SERVICE_ACCOUNT_PLAN",
      ].some(
        (name) =>
          contextVariableOccurrences(authStep.text, "secrets", name).length > 0,
      )
    ) {
      errors.push(
        `${workflowPath}: apply auth must not fall back to a generic or plan identity`,
      );
    }

    const authStart = applyJob.start + authStep.start;
    const authEnd = applyJob.start + authStep.end;
    const outsideAuth = (index) => index < authStart || index >= authEnd;
    if (
      providerUses.length !== 1 ||
      serviceAccountUses.length !== 1 ||
      decodedProviderUses !== 1 ||
      decodedServiceAccountUses !== 1 ||
      providerUses.some(outsideAuth) ||
      serviceAccountUses.some(outsideAuth)
    ) {
      errors.push(
        `${workflowPath}: production identity variables must appear exactly once and only in the apply auth step`,
      );
    }

    const protectionReferences = [
      ...applyJob.text.matchAll(/verify-github-environment-protection\.mjs/gu),
    ];
    const protectionStep = sourceSteps[authStepIndex - 1];
    const semanticProtectionStep = semanticSteps[authStepIndex - 1];
    const checkoutStep = sourceSteps[0];
    const semanticCheckoutStep = semanticSteps[0];
    if (
      protectionReferences.length !== 1 ||
      authStepIndex !== 2 ||
      !checkoutStep ||
      !hasExactSourceCheckoutStep(checkoutStep.parsed) ||
      !hasExactSemanticCheckoutStep(semanticCheckoutStep) ||
      !protectionStep ||
      !isExactProtectionStep(protectionStep.parsed) ||
      !hasExactSemanticProtectionStep(semanticProtectionStep) ||
      !runDefaultsCannotOverrideProtection(
        parsedWorkflow,
        parsedApplyJob,
        semanticProtectionStep?.run,
      )
    ) {
      errors.push(
        `${workflowPath}: apply job must verify environment protection exactly once before Google authentication`,
      );
    }
  }
}
