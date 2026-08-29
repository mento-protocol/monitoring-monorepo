#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_RULESETS = 100;

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

export function collectMainRulesets({ repository, runGh = defaultRunGh }) {
  validateRepository(repository);
  const runBoundedGh = boundedRunner(runGh);
  const ids = listRulesetIds(repository, runBoundedGh);
  return {
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
