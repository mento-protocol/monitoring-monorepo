/**
 * Policy-lineage half of the peg registry integrity checker.
 *
 * It shells out to git for the base revision of alerts/rules/peg-thresholds.json
 * and compares the candidate bundle's active/previous pair against it: an active
 * version may not change content in place, a rollover must retain the complete
 * prior active version as `previous`, and a second rollover may not run before
 * the retained predecessor is ACK-cleaned. Nothing here reads the registry or
 * Mento config.
 *
 * `isRecord` and `printable` are defined here rather than in the checker because
 * the dependency runs one way — the checker imports this module — so a helper
 * defined here reaches both halves without a cycle.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pegPolicyVersionFingerprint } from "../lib/peg-policy-digest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY_REPO_PATH = "alerts/rules/peg-thresholds.json";

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function printable(value) {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

export function validatePegPolicyLineage(basePolicy, policy) {
  const errors = [];
  if (!isRecord(basePolicy?.active) || !isRecord(policy?.active)) {
    return ["policy lineage: base and candidate must contain active versions"];
  }

  const baseActive = basePolicy.active;
  const nextActive = policy.active;
  const sameActiveVersion = baseActive.version === nextActive.version;
  if (!sameActiveVersion) {
    if (basePolicy.previous !== null) {
      errors.push(
        `policy.active: rollover ${printable(baseActive.version)} -> ${printable(nextActive.version)} requires ACK cleanup of the retained predecessor before another active rollover`,
      );
      return errors;
    }
    if (
      !isRecord(policy.previous) ||
      pegPolicyVersionFingerprint(policy.previous) !==
        pegPolicyVersionFingerprint(baseActive)
    ) {
      errors.push(
        `policy.previous: active rollover ${printable(baseActive.version)} -> ${printable(nextActive.version)} must retain the complete prior active version`,
      );
    }
    return errors;
  }

  if (
    pegPolicyVersionFingerprint(baseActive) !==
    pegPolicyVersionFingerprint(nextActive)
  ) {
    errors.push(
      `policy.active: version ${printable(nextActive.version)} changed content in place`,
    );
  }

  const basePrevious = isRecord(basePolicy.previous)
    ? basePolicy.previous
    : null;
  const nextPrevious = isRecord(policy.previous) ? policy.previous : null;
  if (basePrevious === null && nextPrevious !== null) {
    errors.push(
      `policy.previous: version ${printable(nextActive.version)} reintroduced a retained predecessor without an active rollover`,
    );
  } else if (
    basePrevious !== null &&
    nextPrevious !== null &&
    pegPolicyVersionFingerprint(basePrevious) !==
      pegPolicyVersionFingerprint(nextPrevious)
  ) {
    errors.push(
      `policy.previous: version ${printable(nextActive.version)} changed its retained predecessor in place`,
    );
  }
  return errors;
}

function validateGitRef(ref) {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 256 ||
    ref.startsWith("-") ||
    !/^[A-Za-z0-9._/-]+$/.test(ref)
  ) {
    throw new Error(`invalid policy base ref ${printable(ref)}`);
  }
}

function gitObjectExists(specifier) {
  const result = spawnSync("git", ["cat-file", "-e", specifier], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

export function readPolicyFromGit(baseRef) {
  validateGitRef(baseRef);
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(`cannot resolve policy base ref ${baseRef}`, {
      cause: error,
    });
  }
  const specifier = `${baseRef}:${POLICY_REPO_PATH}`;
  if (!gitObjectExists(specifier)) return null;
  let source;
  try {
    source = execFileSync("git", ["show", specifier], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`cannot read policy from ${specifier}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`base policy: invalid JSON in ${specifier}`, {
      cause: error,
    });
  }
}

export function inferredPolicyBaseRef() {
  const explicit = process.env.PEG_POLICY_BASE_REF?.trim();
  if (explicit) return explicit;
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  if (githubBase) return `origin/${githubBase}`;
  // Local and hosted callers must prove the base commit exists. The only
  // valid no-baseline case is a resolved base that does not yet contain the
  // policy path (the initial introduction); an unavailable ref is an error.
  return "origin/main";
}
