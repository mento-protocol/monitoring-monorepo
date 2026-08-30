#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_RULESETS = 100;
const MAX_ENVIRONMENT_METADATA_ENTRIES = 100;
const DEPENDABOT_MERGE_ENVIRONMENT = "dependabot-merge";

class MainRulesetReadError extends Error {}

function boundedRunner(runGh) {
  let capturedBytes = 0;
  return (args) => {
    const raw = runGh(args);
    if (typeof raw !== "string") {
      throw new MainRulesetReadError(
        "repository ruleset capture returned an unexpected output type",
      );
    }
    capturedBytes += Buffer.byteLength(raw, "utf8");
    if (capturedBytes > MAX_CAPTURE_BYTES) {
      throw new MainRulesetReadError(
        "repository ruleset capture exceeded the total safety limit",
      );
    }
    return raw;
  };
}

function defaultRunGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: Object.fromEntries(
      ["GH_TOKEN", "PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJson(raw, message) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MainRulesetReadError(message);
  }
}

function validateRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new MainRulesetReadError(
      "repository identity is missing or malformed",
    );
  }
}

function listRulesetIds(repository, runGh) {
  let raw;
  try {
    raw = runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
    ]);
  } catch (error) {
    if (error instanceof MainRulesetReadError) throw error;
    throw new MainRulesetReadError("could not list repository rulesets");
  }
  const pages = parseJson(raw, "repository ruleset list was not valid JSON");
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new MainRulesetReadError(
      "repository ruleset list had an unexpected shape",
    );
  }
  const entries = pages.flat();
  if (entries.length > MAX_RULESETS) {
    throw new MainRulesetReadError(
      "repository ruleset list exceeded the safety limit",
    );
  }
  const ids = entries.map((entry) => entry?.id);
  if (
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new MainRulesetReadError(
      "repository ruleset list contained an invalid or duplicate ID",
    );
  }
  return ids;
}

function readRuleset(repository, rulesetId, runGh) {
  let raw;
  try {
    raw = runGh(["api", `repos/${repository}/rulesets/${rulesetId}`]);
  } catch (error) {
    if (error instanceof MainRulesetReadError) throw error;
    throw new MainRulesetReadError(
      "could not read a repository ruleset detail",
    );
  }
  const ruleset = parseJson(
    raw,
    "repository ruleset detail was not valid JSON",
  );
  if (
    ruleset === null ||
    typeof ruleset !== "object" ||
    Array.isArray(ruleset) ||
    ruleset.id !== rulesetId
  ) {
    throw new MainRulesetReadError(
      "repository ruleset detail did not match its requested ID",
    );
  }
  return ruleset;
}

function readJsonObject(repository, path, runGh, noun) {
  let raw;
  try {
    raw = runGh(["api", `repos/${repository}/${path}`]);
  } catch (error) {
    if (error instanceof MainRulesetReadError) throw error;
    throw new MainRulesetReadError(`could not read ${noun}`);
  }
  const value = parseJson(raw, `${noun} was not valid JSON`);
  if (!isObject(value)) {
    throw new MainRulesetReadError(`${noun} had an unexpected shape`);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDependabotMergeEnvironment(repository, runGh) {
  const value = readJsonObject(
    repository,
    `environments/${DEPENDABOT_MERGE_ENVIRONMENT}`,
    runGh,
    "Dependabot merge Environment",
  );
  if (value.name !== DEPENDABOT_MERGE_ENVIRONMENT) {
    throw new MainRulesetReadError(
      "Dependabot merge Environment did not match its requested name",
    );
  }
  return {
    can_admins_bypass: value.can_admins_bypass,
    deployment_branch_policy: value.deployment_branch_policy,
    name: value.name,
  };
}

function exactCountedList(value, field, noun) {
  const entries = value[field];
  if (
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > MAX_ENVIRONMENT_METADATA_ENTRIES ||
    !Array.isArray(entries) ||
    entries.length !== value.total_count
  ) {
    throw new MainRulesetReadError(
      `${noun} count or pagination shape was inconsistent`,
    );
  }
  return entries;
}

function readDependabotMergeDeploymentPolicies(repository, runGh) {
  const value = readJsonObject(
    repository,
    `environments/${DEPENDABOT_MERGE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
    runGh,
    "Dependabot merge deployment-policy list",
  );
  const entries = exactCountedList(
    value,
    "branch_policies",
    "Dependabot merge deployment-policy list",
  );
  if (
    entries.some(
      (entry) =>
        !isObject(entry) ||
        !Number.isSafeInteger(entry.id) ||
        entry.id <= 0 ||
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name.length > 255 ||
        typeof entry.type !== "string" ||
        entry.type.length === 0 ||
        entry.type.length > 32,
    )
  ) {
    throw new MainRulesetReadError(
      "Dependabot merge deployment-policy list contained malformed metadata",
    );
  }
  return entries.map(({ id, name, type }) => ({ id, name, type }));
}

function readDependabotMergeSecretNames(repository, runGh) {
  const value = readJsonObject(
    repository,
    `environments/${DEPENDABOT_MERGE_ENVIRONMENT}/secrets?per_page=100`,
    runGh,
    "Dependabot merge Environment secret list",
  );
  const entries = exactCountedList(
    value,
    "secrets",
    "Dependabot merge Environment secret list",
  );
  const names = entries.map((entry) => entry?.name);
  if (
    names.some(
      (name) =>
        typeof name !== "string" || name.length === 0 || name.length > 255,
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new MainRulesetReadError(
      "Dependabot merge Environment secret list contained malformed or duplicate names",
    );
  }
  return names;
}

export function collectMainRulesets({ repository, runGh = defaultRunGh }) {
  validateRepository(repository);
  const runBoundedGh = boundedRunner(runGh);
  const ids = listRulesetIds(repository, runBoundedGh);
  return {
    dependabotMergeEnvironment: readDependabotMergeEnvironment(
      repository,
      runBoundedGh,
    ),
    dependabotMergeDeploymentBranchPolicies:
      readDependabotMergeDeploymentPolicies(repository, runBoundedGh),
    dependabotMergeEnvironmentSecretNames: readDependabotMergeSecretNames(
      repository,
      runBoundedGh,
    ),
    rulesets: ids.map((rulesetId) =>
      readRuleset(repository, rulesetId, runBoundedGh),
    ),
  };
}

export function runCli({
  environment = process.env,
  runGh = defaultRunGh,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  try {
    const captured = collectMainRulesets({
      repository: environment.REPO,
      runGh,
    });
    stdout.write(`${JSON.stringify(captured)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof MainRulesetReadError
        ? error.message
        : "unexpected repository ruleset capture failure";
    stderr.write(`Main ruleset read failed: ${message}.\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
