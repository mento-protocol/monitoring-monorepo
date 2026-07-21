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

// The ONLY guard form the checker credits mechanically: a genuine EXCLUDING
// `if:` condition on the autofix head-ref namespace. A bare `sentry-autofix/`
// occurrence (a comment, a step name, a POSITIVE `startsWith` that routes
// autofix PRs TOWARD a lane) must not certify a job — anything that isn't
// this exact exclusion shape needs the reviewed annotation escape hatch.
const GUARD_PATTERN =
  /!\s*startsWith\(\s*github\.(?:event\.pull_request\.head\.ref|head_ref)\s*,\s*'sentry-autofix\/'\s*\)/;
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

/** Strip YAML comments line-wise (good enough for trigger detection — the
 * `#` character inside trigger keys never appears in valid workflow syntax). */
function stripComments(body) {
  return body
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

/**
 * True when the comment-stripped body declares the given trigger in ANY valid
 * GitHub Actions form:
 *   - block mapping:  `on:` newline `  pull_request:` (or bare `pull_request`)
 *   - inline list:    `on: [push, pull_request]`
 *   - inline scalar:  `on: pull_request`
 *   - inline mapping: `on: { pull_request: { … } }`
 * A pure line-anchored match misses the inline forms, which would let a
 * workflow adopt the trigger while bypassing this check entirely.
 */
export function hasTrigger(body, trigger) {
  const stripped = stripComments(body);
  // Word-ish boundary that will not let `pull_request` match inside
  // `pull_request_target` (nor `_target` match a longer name).
  const t = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asKeyOrItem = new RegExp(`(^|[\\s\\[{,])${t}(?![\\w-])`, "m");
  // Only consider occurrences in trigger position: either inside the value of
  // a top-level `on:` line (inline forms) or as an indented key/item in the
  // block following `on:`. Scanning the whole body for the bare word would
  // false-positive on step names; scoping to the `on:` region keeps precision.
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const onInline = line.match(/^on\s*:\s*(.+)$/);
    if (onInline && asKeyOrItem.test(onInline[1])) return true;
    if (/^on\s*:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (!/^\s/.test(l)) break; // left the `on:` block
        // Trigger names appear as 2-space-indented keys or list items.
        if (new RegExp(`^\\s{2}-?\\s*${t}(?![\\w-])`).test(l)) return true;
        // Deeper-indented lines are trigger CONFIG (branches/paths), skip.
      }
    }
  }
  return false;
}

/** True when the job/workflow text can receive repository secrets, in ANY of
 * GitHub's secret-passing syntaxes:
 *   - dot expression:      `${{ secrets.NAME }}`
 *   - bracket expression:  `${{ secrets['NAME'] }}` / `secrets["NAME"]`
 *   - expression via functions: any `secrets.` / `secrets[` inside `${{ }}`
 *   - reusable-workflow inheritance: `secrets: inherit` (hands the CALLER'S
 *     whole secret set to the called workflow, which may execute PR-head code)
 *   - reusable-workflow explicit block: a `secrets:` mapping under a job that
 *     `uses:` another workflow. */
export function referencesSecrets(body) {
  if (/\$\{\{[^}]*\bsecrets\s*[.[]/.test(body)) return true;
  const stripped = stripComments(body);
  if (/^\s*secrets\s*:\s*inherit\s*$/m.test(stripped)) return true;
  // Explicit `secrets:` mapping on a reusable-workflow call. Only meaningful
  // when the block also calls a workflow (`uses: .../.github/workflows/...`).
  if (
    /^\s*secrets\s*:\s*$/m.test(stripped) &&
    /^\s*uses\s*:\s*\S*\.github\/workflows\//m.test(stripped)
  ) {
    return true;
  }
  return false;
}

/** True when the workflow uses the pull_request_target trigger in any form. */
export function usesPullRequestTarget(body) {
  return hasTrigger(body, "pull_request_target");
}

/** True when the workflow triggers on pull_request (any form). */
export function hasPullRequestTrigger(body) {
  return hasTrigger(body, "pull_request");
}

/**
 * Split the workflow body into named job blocks. Textual, indentation-based:
 * the repo's workflows are prettier/trunk-formatted with 2-space YAML indent,
 * so a job is a `  name:` key directly under the top-level `jobs:` key. Lines
 * before `jobs:` form the file HEADER (returned under the empty-string key) —
 * a file-level annotation there covers every job.
 */
export function splitJobs(body) {
  const lines = body.split("\n");
  const blocks = new Map();
  let current = "";
  let inJobs = false;
  let buf = [];
  for (const line of lines) {
    if (!inJobs && /^jobs\s*:\s*(#.*)?$/.test(line)) {
      blocks.set(current, buf.join("\n"));
      inJobs = true;
      current = null;
      buf = [];
      continue;
    }
    if (inJobs) {
      const jobKey = line.match(/^ {2}([A-Za-z0-9_-]+)\s*:\s*(#.*)?$/);
      if (jobKey) {
        if (current !== null) blocks.set(current, buf.join("\n"));
        current = jobKey[1];
        buf = [];
        continue;
      }
      if (/^\S/.test(line) && line.trim() !== "") {
        // Left the jobs: block (another top-level key).
        if (current !== null) blocks.set(current, buf.join("\n"));
        current = null;
        inJobs = false;
        buf = [];
        continue;
      }
    }
    buf.push(line);
  }
  if (current !== null && current !== undefined) {
    blocks.set(current === null ? "" : current, buf.join("\n"));
  } else if (!inJobs) {
    blocks.set("", buf.join("\n"));
  }
  return blocks;
}

/**
 * Evaluate one workflow body. Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * Granularity is PER JOB, not per file: in a multi-job workflow, one guarded
 * job must not vouch for an unguarded sibling that also reaches secrets. A
 * job passes when ITS OWN block contains the strict excluding-`if:` guard
 * (GUARD_PATTERN — a bare `sentry-autofix/` mention in a comment or a
 * positive lane-router does NOT count) or an `# autofix-ci-trust:`
 * annotation; a file-level annotation in the header (before `jobs:`) covers
 * all jobs — annotations are deliberate reasoned prose, so file scope is
 * acceptable for them, while the guard must sit in the job it protects.
 *
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
  if (!hasPullRequestTrigger(body)) {
    return { ok: true };
  }
  const blocks = splitJobs(body);
  const header = blocks.get("") ?? "";
  const fileAnnotated = header.includes(ANNOTATION);
  const offenders = [];
  for (const [job, block] of blocks) {
    if (job === "") continue;
    if (!referencesSecrets(block)) continue;
    if (fileAnnotated) continue;
    if (GUARD_PATTERN.test(block) || block.includes(ANNOTATION)) continue;
    offenders.push(job);
  }
  if (offenders.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `triggers on pull_request, and job(s) [${offenders.join(", ")}] can receive secrets without an excluding autofix guard (\`!startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')\` on the job's if:) or an '${ANNOTATION}' annotation in that job (or a file-level annotation above \`jobs:\`). ` +
      "Machine-authored autofix PRs pass every fork/dependabot check, so each secret-bearing PR job must either exclude the sentry-autofix/* head branch " +
      "or document why its secrets are unreachable from PR-head code execution.",
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
