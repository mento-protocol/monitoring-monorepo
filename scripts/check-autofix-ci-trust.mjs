#!/usr/bin/env node
/**
 * Structural assertion: machine-authored Sentry-autofix PRs (head branch
 * `sentry-autofix/*`) must be treated as UNTRUSTED by every secret-bearing
 * `pull_request` workflow (issue #1388, an activation gate for the autofix
 * leg — ADR 0036 Phase 2b).
 *
 * Why: autofix diffs derive from untrusted Sentry input, but they arrive as
 * same-repo, non-fork, non-dependabot PRs — so every historical CI trust
 * check ("not a fork, not dependabot") classifies them as trusted and hands
 * their PR-head code repo secrets (the Vercel deploy-protection bypass, the
 * Terraform plan SA, …). A new secret-bearing lane added without thinking
 * about this silently re-opens the exfiltration channel; this check makes
 * that a hard CI failure instead.
 *
 * Assertions:
 *  1. NO workflow may use `pull_request_target` (it hands secrets to
 *     PR-controlled context by design; the repo has none and must stay that
 *     way).
 *  2. Every workflow that triggers on `pull_request` AND references
 *     `${{ secrets.* }}` must either
 *       (a) contain the literal `sentry-autofix/` — evidence of an explicit
 *           guard (a job `if:` exclusion or an untrusted-lane branch), or
 *       (b) carry an `# autofix-ci-trust:` annotation comment stating WHY no
 *           guard is needed (secret step-scoped away from PR-head code
 *           execution, actor-gated job, paths the autofix diff guard forbids,
 *           …). The annotation is deliberate friction: it forces the author
 *           of a new secret lane to reason about the autofix trust boundary
 *           in the diff, where review sees it.
 *
 * No external dependencies — reads files with pure Node.js.
 *
 * Run: `node scripts/check-autofix-ci-trust.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

const GUARD_LITERAL = "sentry-autofix/";
const ANNOTATION = "# autofix-ci-trust:";

let failures = 0;

/** @param {string} msg */
function fail(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  failures += 1;
}

/** @param {string} msg */
function ok(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

/** True when the workflow body declares a `pull_request:` trigger (block or
 * inline list form). Comment lines are ignored so prose mentioning the
 * trigger cannot false-positive. */
export function hasPullRequestTrigger(body) {
  return body
    .split("\n")
    .some((line) => /^\s*pull_request\s*:?\s*$/.test(line.replace(/#.*$/, "")));
}

/** True when the workflow references any repository secret via the
 * `${{ secrets.* }}` expression syntax (the only way a secret enters a job). */
export function referencesSecrets(body) {
  return /\$\{\{\s*secrets\./.test(body);
}

/** True when the workflow uses the pull_request_target trigger anywhere
 * outside a comment. */
export function usesPullRequestTarget(body) {
  return body
    .split("\n")
    .some((line) => /^\s*pull_request_target\b/.test(line.replace(/#.*$/, "")));
}

/**
 * Evaluate one workflow body. Returns `{ ok: true }` or `{ ok: false, reason }`.
 * Exported for tests.
 */
export function evaluateWorkflow(body) {
  if (usesPullRequestTarget(body)) {
    return {
      ok: false,
      reason:
        "uses pull_request_target, which hands secrets to PR-controlled context by design — use pull_request with an explicit trust gate instead",
    };
  }
  if (!hasPullRequestTrigger(body) || !referencesSecrets(body)) {
    return { ok: true };
  }
  if (body.includes(GUARD_LITERAL) || body.includes(ANNOTATION)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `triggers on pull_request and references \${{ secrets.* }} but has neither a '${GUARD_LITERAL}' guard nor an '${ANNOTATION}' annotation. ` +
      "Machine-authored autofix PRs pass every fork/dependabot check, so a secret-bearing PR lane must either exclude the sentry-autofix/* head branch " +
      "(or route it to a secretless lane) or document why its secrets are unreachable from PR-head code execution.",
  };
}

function main() {
  const files = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  let checked = 0;
  for (const file of files) {
    const body = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
    checked += 1;
    const verdict = evaluateWorkflow(body);
    if (!verdict.ok) {
      fail(`${file}: ${verdict.reason}`);
    }
  }
  if (checked === 0) {
    fail("no workflow files found — the workflows directory moved?");
  }
  if (failures > 0) {
    console.error(
      `\n${failures} workflow(s) violate the autofix CI trust boundary (issue #1388).`,
    );
    process.exit(1);
  }
  ok(
    `All ${checked} workflow(s) respect the autofix CI trust boundary (no pull_request_target; every secret-bearing pull_request lane guards or annotates).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
