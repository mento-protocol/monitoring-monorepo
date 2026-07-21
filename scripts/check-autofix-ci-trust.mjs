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
 *  2. Every JOB that can receive secrets in a `pull_request`-triggered
 *     workflow (its own reference, or one inherited from workflow-level
 *     `env:`) must either
 *       (a) carry the strict EXCLUDING guard on its job-level `if:`
 *           (`!startsWith(github.event.pull_request.head.ref,
 *           'sentry-autofix/')` — see GUARD_PATTERN; nothing looser counts),
 *           or
 *       (b) carry an `# autofix-ci-trust:` annotation COMMENT LINE stating
 *           WHY no guard is needed (secret step-scoped away from PR-head code
 *           execution, actor-gated job, paths the autofix diff guard forbids,
 *           …) — in the job block, or at file level covering all jobs. The
 *           annotation is deliberate friction: it forces the author of a new
 *           secret lane to reason about the autofix trust boundary in the
 *           diff, where review sees it.
 *
 * SCOPE / STATED LIMITATION: this is a textual tripwire, not an expression
 * evaluator. It verifies the excluding guard is PRESENT on the job-level
 * `if:`; it cannot prove the surrounding expression ENFORCES it (e.g. a guard
 * OR-ed against a bypass would pass — as would any semantics a YAML/expression
 * theorem prover would need). That residual is owned by human review of the
 * workflow diff, which this checker forces to happen by refusing silent
 * additions; the reviewed annotation is the escape hatch for anything the
 * pattern cannot express. Do not weaken the guard pattern to "contains the
 * branch name" — see the test suite for the shapes deliberately refused.
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

/** True when the text contains a GENUINE annotation: a YAML comment line
 * (optionally indented `#` at line start). A raw substring check would accept
 * lookalikes smuggled into string values (`run: "echo '# autofix-ci-trust:'"`)
 * — the line-anchored form refuses those. (A lookalike nested inside a block
 * scalar still line-starts with `#` and passes; distinguishing that needs a
 * YAML parser. Accepted: workflow files are NOT autofix-editable — the diff
 * guard forbids `.github/` — so this checker defends against honest omissions
 * in reviewed human PRs, not adversarial workflow authors, who by definition
 * hold write access to CI itself.) */
function hasAnnotation(text) {
  return /^\s*#\s*autofix-ci-trust:/m.test(text);
}

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
 * True when the file uses YAML the textual analyzer cannot affirmatively
 * resolve, ANYWHERE in the document:
 *   - any YAML anchor (`&name`) or alias (`*name`) — an alias can carry a
 *     pull_request trigger, a secret-bearing env mapping, or a whole job body
 *     defined elsewhere, so every occurrence is a potential smuggling channel
 *     for BOTH the trigger analysis and the per-job secret analysis;
 *   - a flow sequence/mapping left unterminated on the `on:` line
 *     (multi-line `on: [pull_request,`).
 * The only safe answer is to REFUSE analysis (fail closed) and make the
 * author write the workflow literally — no repo workflow uses anchors, and
 * the repo's prettier/trunk YAML style never produces them.
 */
export function hasUnanalyzableTriggers(body) {
  const stripped = stripComments(body);
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Anchor/alias token in a YAML VALUE position — the only places YAML
    // grammar allows them: as a mapping value (`key: &name` / `key: *name`),
    // as a list item (`- *name`), or as a flow-sequence element
    // (`on: [*pr]`). Content INSIDE quoted strings (Slack mrkdwn `*bold*`,
    // glob patterns) starts with a quote or other char at the value boundary
    // and therefore never matches.
    // Anchor names may be ANY non-space run (incl. numeric `&1`).
    if (/(?:^|:\s+|-\s+|[[,{]\s*)[&*][^\s,\]}]+/.test(line)) return true;
    // YAML explicit-key syntax (`? pull_request`) is valid for triggers and
    // invisible to the block matcher — refuse it (write keys plainly).
    if (/^\s*\?\s/.test(line)) return true;
    const m = line.match(/^(['"]?)on\1\s*:\s*(.*)$/);
    if (m) {
      const value = m[2].trim();
      // Unterminated flow form: opens [ or { without closing on the same line.
      const opens = (value.match(/[[{]/g) ?? []).length;
      const closes = (value.match(/[\]}]/g) ?? []).length;
      if (opens > closes) return true;
    }
    // Block-scalar introducer (`run: |`, `script: >-`, `- |2`): every deeper-
    // indented line that follows is STRING content with zero YAML semantics
    // (JS ternaries starting `? `, markdown `- **bold**`, shell globs), so
    // skipping it is exact, not a heuristic. This skip runs AFTER the checks
    // above so an introducer line like `key: &a |` still fails on its anchor.
    // A false introducer (plain scalar ending in ` |`) is harmless: deeper
    // lines after a scalar-valued key can only be scalar continuations or
    // YAML errors, never active structure.
    if (/(?:^|\s)[|>][0-9+-]{0,2}\s*$/.test(line)) {
      const indent = /^ */.exec(line)[0].length;
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j].trim() === "" || /^ */.exec(lines[j])[0].length > indent)
      ) {
        j += 1;
      }
      i = j - 1;
    }
  }
  return false;
}

/**
 * True when the comment-stripped body declares the given trigger in ANY valid
 * GitHub Actions form:
 *   - block mapping:  `on:` newline `  pull_request:` (or bare `pull_request`)
 *   - inline list:    `on: [push, pull_request]`
 *   - inline scalar:  `on: pull_request`
 *   - inline mapping: `on: { pull_request: { … } }`
 *   - any of the above with the event name in single or double QUOTES
 *     (`on: ["pull_request"]`, `"pull_request":` — valid YAML scalars/keys)
 * A pure line-anchored match misses the inline/quoted forms, which would let
 * a workflow adopt the trigger while bypassing this check entirely.
 */
export function hasTrigger(body, trigger) {
  const stripped = stripComments(body);
  // Word-ish boundary that will not let `pull_request` match inside
  // `pull_request_target` (nor `_target` match a longer name). Optional
  // single/double quote on either side covers quoted YAML scalars and keys.
  const t = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const q = `['"]?`;
  const asKeyOrItem = new RegExp(`(^|[\\s\\[{,])${q}${t}${q}(?![\\w-])`, "m");
  // Only consider occurrences in trigger position: either inside the value of
  // a top-level `on:` line (inline forms) or as an indented key/item in the
  // block following `on:`. Scanning the whole body for the bare word would
  // false-positive on step names; scoping to the `on:` region keeps precision.
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const onInline = line.match(/^(['"]?)on\1\s*:\s*(.+)$/);
    if (onInline && asKeyOrItem.test(onInline[2])) return true;
    if (/^(['"]?)on\1\s*:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (!/^\s/.test(l)) break; // left the `on:` block
        // Trigger names appear as indented keys or list items at ANY positive
        // indentation (one-space indent is valid YAML), optionally quoted.
        // Config keys (branches/paths) never equal a trigger name, so
        // accepting any depth cannot false-positive on config.
        if (new RegExp(`^\\s+-?\\s*${q}${t}${q}(?![\\w-])`).test(l)) {
          return true;
        }
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
  // Any use of the `secrets` CONTEXT inside an expression counts — dot and
  // bracket access, but also bare references like `toJSON(secrets)`, which
  // expand EVERY repository secret at once.
  if (/\$\{\{[^}]*\bsecrets\b/.test(body)) return true;
  const stripped = stripComments(body);
  // `inherit` may be a quoted YAML scalar with identical semantics.
  if (/^\s*(['"]?)secrets\1\s*:\s*(['"]?)inherit\2\s*$/m.test(stripped))
    return true;
  // Explicit `secrets:` mapping on a reusable-workflow call. Only meaningful
  // when the block also calls a workflow (`uses: .../.github/workflows/...`).
  if (
    /^\s*(['"]?)secrets\1\s*:\s*$/m.test(stripped) &&
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
 * so a job is a `  name:` key directly under the top-level `jobs:` key. ALL
 * top-level content OUTSIDE the jobs block — before it AND after it (YAML
 * allows `env:`/`permissions:` etc. below `jobs:`) — is merged into the file
 * HEADER (returned under the empty-string key): a file-level annotation there
 * covers every job, and a workflow-level `env:` secret there is inherited by
 * every job, wherever it appears in the file.
 */
export function splitJobs(body) {
  const lines = body.split("\n");
  const blocks = new Map();
  const headerParts = [];
  let current = ""; // "" = accumulating header content
  let inJobs = false;
  let buf = [];
  const flush = () => {
    if (current === "") headerParts.push(buf.join("\n"));
    else blocks.set(current, buf.join("\n"));
    buf = [];
  };
  for (const line of lines) {
    if (!inJobs && /^jobs\s*:\s*(#.*)?$/.test(line)) {
      flush();
      inJobs = true;
      current = null;
      continue;
    }
    if (inJobs) {
      // Job IDs may be quoted (valid YAML): `"leak":` — accept optional
      // matching quotes so a quoted job cannot hide inside a sibling's block.
      const jobKey = line.match(/^ {2}(['"]?)([A-Za-z0-9_-]+)\1\s*:\s*(#.*)?$/);
      if (jobKey) {
        if (current !== null) flush();
        current = jobKey[2];
        continue;
      }
      if (/^\S/.test(line) && line.trim() !== "") {
        // Left the jobs: block — this and following top-level content is
        // header material again (workflow-level env:, concurrency:, …).
        if (current !== null) flush();
        current = "";
        inJobs = false;
        buf.push(line);
        continue;
      }
    }
    buf.push(line);
  }
  if (current !== null) flush();
  blocks.set("", headerParts.join("\n"));
  return blocks;
}

/**
 * True when the job block's JOB-LEVEL `if:` condition contains the excluding
 * autofix guard. Only the `if:` value counts — the same text inside a step's
 * `run:`, a comment, or a step-level `if:` does not gate whether the JOB (and
 * its secret-bearing env/steps) runs for an autofix PR. A job block's own
 * keys sit at 4-space indent; the job-level `if:` value is the rest of that
 * line plus any deeper-indented continuation lines (block scalars `|`/`>`,
 * folded expressions) up to the next 4-space key.
 *
 * Exported for tests.
 */
export function jobIfGuarded(block) {
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {4}if\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[1];
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (/^ {4}[A-Za-z0-9_-]+\s*:/.test(l) || /^ {0,3}\S/.test(l)) break;
      value += `\n${l}`;
    }
    // Strip YAML comments BEFORE testing: `if: X # !startsWith(...)` runs as
    // just `X` (YAML drops the trailing comment), so guard text inside a
    // comment must not certify the job. Over-stripping (a # inside a quoted
    // string) can only REMOVE guard evidence — fail-closed by construction.
    if (GUARD_PATTERN.test(stripComments(value))) return true;
  }
  return false;
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
  if (hasUnanalyzableTriggers(body)) {
    return {
      ok: false,
      reason:
        "the on: declaration uses YAML anchors/aliases or a multi-line flow form this checker cannot resolve — write triggers literally (fail-closed: an alias could smuggle a pull_request trigger past the analysis)",
    };
  }
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
  const fileAnnotated = hasAnnotation(header);
  const jobNames = [...blocks.keys()].filter((k) => k !== "");
  // FAIL CLOSED when segmentation finds no jobs but the file as a whole can
  // receive secrets: a workflow written with non-2-space indentation (or any
  // shape this textual splitter cannot segment) must not silently bypass the
  // per-job analysis. Reformat the workflow (trunk/prettier enforce 2-space
  // YAML in this repo) or annotate at file level.
  if (jobNames.length === 0 && referencesSecrets(body)) {
    if (fileAnnotated) return { ok: true };
    return {
      ok: false,
      reason:
        "triggers on pull_request and references secrets, but no job blocks could be segmented (non-standard indentation?). The per-job trust analysis cannot run — reformat to the repo's 2-space YAML style or add a file-level '# autofix-ci-trust:' annotation above `jobs:`.",
    };
  }
  // Workflow-level `env:` (or any header secret expression) is inherited by
  // EVERY job, so a header secret makes every job secret-bearing even when no
  // job block contains the textual reference itself.
  const headerHasSecrets = referencesSecrets(header);
  // `id-token: write` is a CREDENTIAL even with zero secrets references: this
  // repo's WIF pool (terraform/ci-wif.tf) trusts any OIDC token carrying this
  // repository's `attribute.repository`, so a PR job holding the permission
  // can mint a token and exchange it for the plan-readonly service account —
  // the same state-reading identity the Terraform lanes guard. Match block
  // and inline-flow permission forms plus `permissions: write-all` (which
  // includes id-token), at job level or inherited from the workflow header.
  // Non-anchored on purpose: matching prose that merely mentions the string
  // only ADDS scrutiny (fail-safe direction).
  const grantsOidc = (text) => {
    const s = stripComments(text);
    return (
      /(['"]?)\bid-token\1\s*:\s*(['"]?)write\2/.test(s) ||
      /(['"]?)\bpermissions\1\s*:\s*(['"]?)write-all\2/.test(s)
    );
  };
  const headerGrantsOidc = grantsOidc(header);
  const offenders = [];
  for (const [job, block] of blocks) {
    if (job === "") continue;
    // A job bound to a GitHub ENVIRONMENT receives that environment's secrets
    // server-side with no textual secrets reference in the YAML at all.
    const environmentBound = /^ {4}(['"]?)environment\1\s*:/m.test(block);
    // Workflow-level permissions are inherited unless the job declares its
    // own `permissions:` key, but a job that overrides COULD still include
    // id-token — grantsOidc(block) catches that; treating a narrowing
    // override as still-inheriting only over-approximates (fail-safe).
    const oidcCapable = grantsOidc(block) || headerGrantsOidc;
    if (
      !referencesSecrets(block) &&
      !headerHasSecrets &&
      !environmentBound &&
      !oidcCapable
    )
      continue;
    if (fileAnnotated) continue;
    if (jobIfGuarded(block) || hasAnnotation(block)) continue;
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
