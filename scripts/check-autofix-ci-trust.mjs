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
 *  2. Every JOB that can receive a CREDENTIAL in a workflow REACHABLE on an
 *     autofix branch — the eventual `pull_request`, the `push` the finalizer
 *     makes to `sentry-autofix/*` before the PR exists (when its branch filter
 *     admits that branch), or the `create` event of that branch — must guard or
 *     annotate. "Credential" is: a `${{ secrets.* }}` reference (its own or
 *     inherited from workflow-level `env:`), a reusable-workflow `secrets:`
 *     forward or local reusable-workflow (`uses: ./…`) call, an
 *     `id-token: write` / `permissions: write-all` OIDC grant (this repo's WIF
 *     pool trusts any repository-attributed OIDC token — `terraform/ci-wif.tf`),
 *     a write-scoped automatic `${{ github.token }}`, or a GitHub
 *     `environment:` binding. Such a job must either
 *       (a) carry the strict EXCLUDING guard on its job-level `if:` for EACH
 *           reachable context — `!startsWith(github.event.pull_request.head.ref,
 *           'sentry-autofix/')` for pull_request (GUARD_PATTERN),
 *           `!startsWith(github.ref, 'refs/heads/sentry-autofix/')` (or
 *           `github.ref_name`, `'sentry-autofix/'`) for push/create
 *           (PUSH_GUARD_PATTERN); nothing looser counts — or
 *       (b) carry an `# autofix-ci-trust:` annotation COMMENT LINE stating
 *           WHY no guard is needed (secret step-scoped away from PR-head code
 *           execution, actor-gated job, paths the autofix diff guard forbids,
 *           …) — in the job block, or at file level covering all jobs. The
 *           annotation is deliberate friction: it forces the author of a new
 *           secret lane to reason about the autofix trust boundary in the
 *           diff, where review sees it.
 *
 * HOW: the workflow is parsed with `js-yaml` (a real YAML 1.2 parser), and the
 * trigger / credential / job analysis runs over the PARSED structure. This is
 * a deliberate rewrite of an earlier textual-regex tripwire (issue #1424): raw
 * text diverges from YAML semantics in unbounded ways (anchors and aliases,
 * `\uXXXX` escapes, block scalars, flow/JSON document roots, comment-split job
 * blocks) — every one an evasion the parser resolves for free. Parsing fails
 * CLOSED: malformed YAML, multi-document streams, and tab-indented files all
 * throw, and a throw is treated as a violation.
 *
 * The one place raw text is still consulted is COMMENT attribution: `js-yaml`
 * drops comments, but the `# autofix-ci-trust:` annotation IS a comment, so
 * annotations are located in the source and attributed to jobs by the line
 * range of each (parser-known) job key.
 *
 * SCOPE / STATED LIMITATION: the guard check verifies the excluding guard is
 * PRESENT on the job-level `if:`; it does not prove the surrounding expression
 * ENFORCES it (a guard OR-ed against a bypass would pass). That residual is
 * owned by human review of the workflow diff, which this checker forces to
 * happen by refusing silent additions; the reviewed annotation is the escape
 * hatch. Do not weaken GUARD_PATTERN to "contains the branch name" — see the
 * test suite for the shapes deliberately refused.
 *
 * Run: `node scripts/check-autofix-ci-trust.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = process.cwd();
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

// The ONLY guard form the checker credits mechanically: a genuine EXCLUDING
// `if:` condition on the autofix head-ref namespace. A bare `sentry-autofix/`
// occurrence (a comment, a step name, a POSITIVE `startsWith` that routes
// autofix PRs TOWARD a lane) must not certify a job — anything that isn't
// this exact exclusion shape needs the reviewed annotation escape hatch.
// Case-insensitive: GitHub Actions resolves function names (`startswith`),
// context paths (`github.EVENT…`), AND the `startsWith` string comparison
// itself case-insensitively, so a guard written in any casing is genuinely
// enforced and must be credited (`sentry-autofix/*` heads are excluded
// regardless of the literal's case).
const GUARD_PATTERN =
  /!\s*startsWith\s*\(\s*github\.(?:event\.pull_request\.head\.ref|head_ref)\s*,\s*'sentry-autofix\/'\s*\)/i;
// The push-context analogue: on a `push` event the pull_request context is
// empty, so a job that runs on the pushed `sentry-autofix/*` branch is excluded
// by a `github.ref` / `github.ref_name` test instead. The two are paired to
// their CORRECT value: `github.ref` is the FULL `refs/heads/sentry-autofix/…`
// on a branch push (the short prefix would never match — the guard would
// evaluate true and the job would run), while `github.ref_name` is the short
// `sentry-autofix/…`.
const PUSH_GUARD_PATTERN =
  /!\s*startsWith\s*\(\s*github\.(?:ref\s*,\s*'refs\/heads\/sentry-autofix\/'|ref_name\s*,\s*'sentry-autofix\/')\s*\)/i;
const ANNOTATION = "# autofix-ci-trust:";
const ANNOTATION_LINE = /^\s*#\s*autofix-ci-trust:/;

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

/**
 * Parse a workflow body. Returns the parsed document, or null when the source
 * is not analyzable as a single YAML document (syntax error, multi-document
 * stream, tab indentation — all of which `js-yaml` throws on). A null return
 * is the signal to FAIL CLOSED.
 *
 * Exported for tests.
 * @param {string} body
 * @returns {any}
 */
export function parseWorkflow(body) {
  try {
    return yaml.load(body, { schema: yaml.CORE_SCHEMA });
  } catch {
    return null;
  }
}

/**
 * Normalize the parsed `on:` value into the set of event names it declares,
 * across every legal shape: a scalar (`on: pull_request`), a sequence
 * (`on: [push, pull_request]`), or a mapping (`on: { pull_request: {…} }`).
 * `js-yaml` has already resolved anchors, flow/JSON forms, and quoting, so
 * this only has to walk the resulting value. Defends against the YAML 1.1
 * `on`→boolean coercion by also reading a `true` key.
 *
 * Exported for tests.
 * @param {any} doc
 * @returns {Set<string>}
 */
export function collectTriggers(doc) {
  const events = new Set();
  if (!doc || typeof doc !== "object") return events;
  const on = "on" in doc ? doc.on : doc[true];
  if (on == null) return events;
  if (typeof on === "string") events.add(on);
  else if (Array.isArray(on)) {
    for (const e of on) if (typeof e === "string") events.add(e);
  } else if (typeof on === "object") {
    for (const k of Object.keys(on)) events.add(k);
  }
  return events;
}

/** True when the workflow triggers on pull_request (any form). */
export function hasPullRequestTrigger(body) {
  return collectTriggers(parseWorkflow(body)).has("pull_request");
}

/** True when the workflow uses the pull_request_target trigger in any form. */
export function usesPullRequestTarget(body) {
  return collectTriggers(parseWorkflow(body)).has("pull_request_target");
}

/** Three-valued match of a GitHub Actions ref-glob (`main`, `sentry-autofix/**`,
 * `**`, …) against a pushed autofix branch: `"match"`, `"no-match"`, or
 * `"unknown"`. `*` matches within a path segment, `**` across segments, `?` one
 * char — the forms GitHub documents. A pattern with other glob metacharacters
 * (`[`, `+`, `!`, `{`) is `"unknown"` — never asserted as a definite match OR a
 * definite non-match, so BOTH the `branches` (admit-if-could-match) and the
 * `branches-ignore` (exclude-only-if-definitely-matches) directions fail
 * closed. (An earlier two-valued version fed `true` into the negated
 * branches-ignore path and became fail-OPEN there.) */
function refGlobMatch(pattern) {
  if (typeof pattern !== "string") return "unknown";
  if (/[[\]{}!+]/.test(pattern)) return "unknown";
  const rx = pattern
    .replace(/[.^$()|\\]/g, "\\$&")
    .replace(/\*\*/g, "\0") // placeholder for cross-segment
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`).test("sentry-autofix/x") ? "match" : "no-match";
}

/**
 * True when a `push` trigger config could fire on a pushed `sentry-autofix/*`
 * branch — the finalizer pushes that branch (with an App token) BEFORE opening
 * the PR, so a secret-bearing push job that runs on it is an exfiltration lane
 * with no `pull_request` in sight.
 *   - bare `push` (null/true) or a config with no branch filter → all branches,
 *     UNLESS it is tags-only (`tags:` without `branches:` never fires on branch
 *     pushes);
 *   - `branches: […]` → admits if any pattern matches;
 *   - `branches-ignore: […]` → admits unless a pattern matches.
 *
 * Exported for tests.
 * @param {any} pushCfg the parsed value of `on.push`
 */
export function pushAdmitsAutofix(pushCfg) {
  if (pushCfg == null || pushCfg === true) return true;
  if (typeof pushCfg !== "object" || Array.isArray(pushCfg)) return true;
  if ("branches" in pushCfg) {
    const pats = Array.isArray(pushCfg.branches)
      ? pushCfg.branches
      : [pushCfg.branches];
    // Admit if any pattern could match (match or unknown) — fail closed.
    return pats.some((p) => refGlobMatch(p) !== "no-match");
  }
  if ("branches-ignore" in pushCfg) {
    const pats = Array.isArray(pushCfg["branches-ignore"])
      ? pushCfg["branches-ignore"]
      : [pushCfg["branches-ignore"]];
    // Excluded ONLY if a pattern DEFINITELY matches; an unknown pattern is not
    // a definite exclusion, so it leaves the branch admitted — fail closed.
    return !pats.some((p) => refGlobMatch(p) === "match");
  }
  // No branch filter: a tags-only config never fires on branch pushes; anything
  // else (paths-only, or an empty config) fires on every branch.
  const tagsOnly = "tags" in pushCfg || "tags-ignore" in pushCfg;
  return !tagsOnly;
}

/** Yield every string value nested anywhere inside a parsed value. Secret and
 * other expression references only ever live in VALUES (`${{ … }}` scalars),
 * so keys are intentionally not walked. */
function* walkStrings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) {
    for (const item of value) yield* walkStrings(item);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) yield* walkStrings(value[key]);
  }
}

/** True when any nested string is a `${{ … secrets … }}` expression. Post-parse
 * the scalar is fully decoded (escapes resolved, quoting stripped, braces from
 * `fromJSON('{}')` are literal characters inside the string), so a per-string
 * scan sees the real `secrets` context the raw source could hide. The match is
 * case-INSENSITIVE: GitHub resolves the `secrets` context case-insensitively
 * (`${{ SECRETS.X }}` injects the real credential), so the checker must too. */
function referencesSecrets(value) {
  for (const s of walkStrings(value)) {
    if (/\$\{\{[\s\S]*?\bsecrets\b/i.test(s)) return true;
  }
  return false;
}

/**
 * True when a parsed `permissions:` value grants OIDC token minting —
 * `id-token: write` or the umbrella `write-all`. OIDC capability is a
 * credential even with zero `secrets.*` references: this repo's WIF pool
 * (terraform/ci-wif.tf) trusts any OIDC token carrying this repository's
 * `attribute.repository`, so a PR job holding it can exchange the token for
 * the plan-readonly service account.
 *
 * Exported for tests.
 * @param {any} permissions
 */
export function grantsOidc(permissions) {
  if (permissions === "write-all") return true;
  if (permissions && typeof permissions === "object") {
    return permissions["id-token"] === "write";
  }
  return false;
}

/** True when a parsed `permissions:` value grants ANY write scope — `write-all`
 * or a mapping with a `write` value. A write-scoped automatic `GITHUB_TOKEN`
 * (`${{ github.token }}`) exposed to autofix-branch code can mutate the repo
 * (push, open/label issues and PRs, …), so it is a credential too.
 *
 * Exported for tests. */
export function hasWritePermission(permissions) {
  if (permissions === "write-all") return true;
  if (permissions && typeof permissions === "object") {
    return Object.values(permissions).some((v) => v === "write");
  }
  return false;
}

/** True when a nested string references the automatic workflow token via the
 * `github` context (`${{ github.token }}`). The `secrets.GITHUB_TOKEN` spelling
 * is caught by referencesSecrets; this is the OTHER spelling of the same
 * token. */
function referencesWorkflowToken(value) {
  for (const s of walkStrings(value)) {
    if (/\$\{\{[\s\S]*?\bgithub\s*\.\s*token\b/i.test(s)) return true;
  }
  return false;
}

/**
 * True when a parsed job can receive a repository credential, considering
 * workflow-level inheritance. "Credential" is the full set: a `${{ secrets.* }}`
 * reference, a reusable-workflow `secrets:` forward (`inherit` or an explicit
 * map), an OIDC grant, or an `environment:` binding (delivers that
 * environment's secrets server-side).
 *
 * `inherited.workflowPermissions` is the workflow-level `permissions:` value. A
 * job's OWN `permissions:` block REPLACES it wholesale (unspecified scopes drop
 * to none), so OIDC is inherited ONLY when the job declares no permissions of
 * its own — matching GitHub's semantics and avoiding a false positive on a job
 * that narrows a broad workflow grant.
 *
 * Exported for tests.
 * @param {any} job
 * @param {{ envSecrets: boolean, workflowPermissions: any }} inherited
 */
export function jobReceivesCredential(job, inherited) {
  const effectivePermissions =
    job && typeof job === "object" && job.permissions !== undefined
      ? job.permissions
      : inherited.workflowPermissions;
  if (grantsOidc(effectivePermissions)) return true;
  if (!job || typeof job !== "object") return inherited.envSecrets;
  if (inherited.envSecrets) return true;
  if (referencesSecrets(job)) return true;
  // The automatic GITHUB_TOKEN via the github context, when the job's effective
  // permissions grant a write scope, is a mutating credential in autofix-branch
  // code's hands. The `github.token` reference may sit in the JOB body or be
  // inherited from a workflow-level `env:` (available to every job/step).
  if (
    hasWritePermission(effectivePermissions) &&
    (referencesWorkflowToken(job) || inherited.envWorkflowToken)
  ) {
    return true;
  }
  // A `secrets:` key exists only on a reusable-workflow (`uses:`) call and
  // always forwards the caller's secrets — `inherit` (string) or a map.
  if (job.secrets != null) return true;
  if (job.environment != null) return true;
  // A job that CALLS a LOCAL reusable workflow (`uses: ./.github/workflows/…`)
  // can receive a credential the CALLEE binds — an `environment:` or its own
  // `secrets:`/OIDC — with no caller-side `secrets:` key at all. Following the
  // callee cross-file is out of this pass's scope, so fail closed: treat any
  // local reusable-workflow call as credential-bearing (the author guards or
  // annotates, stating the callee is credential-free). Step `uses:` (actions)
  // live under `steps[]`, not here, so this only matches reusable-workflow
  // calls. Remote reusable workflows (`org/repo/.github/…@ref`) receive secrets
  // only via an explicit caller `secrets:` key, already caught above.
  if (typeof job.uses === "string" && /^\.\.?\//.test(job.uses)) return true;
  return false;
}

/** True when a parsed job's OWN job-level `if:` carries the excluding guard for
 * the given trigger CONTEXT — `"pull_request"` excludes on the PR head ref,
 * `"push"` excludes on `github.ref`. The contexts are independent: a job
 * reachable via both must exclude in both. `js-yaml` already dropped any
 * trailing comment, so the value is exactly the expression GitHub evaluates; a
 * step-level `if:` lives under `steps[]` and is correctly not consulted here.
 *
 * Exported for tests.
 * @param {any} job
 * @param {"pull_request"|"push"} context
 */
export function jobGuarded(job, context = "pull_request") {
  if (!job || typeof job !== "object") return false;
  const expr = String(job.if ?? "");
  const pattern = context === "push" ? PUSH_GUARD_PATTERN : GUARD_PATTERN;
  return pattern.test(expr);
}

/** Mark the source lines that are CONTENT of a block scalar (`run: |`,
 * `script: >-`, `- |2`). A `#` inside such content is literal script/text, not
 * a YAML comment, so it must not be read as an annotation. Every content line
 * is more-indented than its introducer (blank lines belong to it too). */
function blockScalarContentLines(lines) {
  const content = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // the introducer itself is never a comment
    if (!/(?:^|\s)[|>][0-9+-]{0,2}\s*(#.*)?$/.test(line)) continue;
    const indent = line.search(/\S/);
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== "" && lines[j].search(/\S/) <= indent) break;
      content[j] = true;
    }
  }
  return content;
}

/** The quote character (`"` or `'`) left OPEN at the end of `line`, given the
 * quote state entering it — or null when the line ends outside any quote.
 * Honors `\`-escapes inside `"…"` and `''`-escapes inside `'…'`, and stops at
 * an unquoted `#` (a YAML comment start, at line-start or after whitespace). A
 * best-effort scanner: any imprecision only ever marks MORE lines as scalar
 * content, which fails CLOSED for annotation detection (an uncredited
 * annotation just means the job must guard instead). */
function quoteStateAfter(line, openQuote) {
  let q = openQuote;
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k];
    if (q === '"') {
      if (c === "\\") k += 1;
      else if (c === '"') q = null;
    } else if (q === "'") {
      if (c === "'") {
        if (line[k + 1] === "'") k += 1;
        else q = null;
      }
    } else {
      if (c === "#" && (k === 0 || /\s/.test(line[k - 1]))) break;
      if (c === '"' || c === "'") q = c;
    }
  }
  return q;
}

/** Lines that are CONTINUATIONS of a multiline quoted scalar (2nd+ line of a
 * `key: "a\n# not-a-comment\nb"`). A line-leading `#` there is string content,
 * not a YAML comment. Block-scalar content (already marked) is literal and
 * cannot be mid-quote, so it resets the quote scan. */
function quotedScalarContentLines(lines, blockContent) {
  const content = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (blockContent[i]) {
      open = null;
      continue;
    }
    if (open) content[i] = true;
    open = quoteStateAfter(lines[i], open);
  }
  return content;
}

/**
 * Locate `# autofix-ci-trust:` annotation comments in the SOURCE and attribute
 * them to jobs. `js-yaml` discards comments, so this is the one raw-text pass.
 * It is anchored to the parser's ground truth and attributes UNAMBIGUOUSLY:
 *   1. Only GENUINE comment lines count — a `#` line inside a block scalar OR a
 *      multiline quoted scalar is string content, not a comment, and is excluded.
 *   2. Each job's key line is matched at the exact job-block indentation (not
 *      any depth), so a same-named nested key — an `outputs:` entry called
 *      `deploy`, say — cannot be mistaken for the `deploy` job.
 *   3. A JOB annotation must sit INSIDE that job's body: after its key line and
 *      indented deeper than the key. A comment at job-key indent between jobs
 *      documents the job BELOW it (universal convention), and a column-0 footer
 *      after the last job belongs to no job — neither may silence a credential
 *      job it happens to physically follow.
 *   4. A FILE annotation must sit above `jobs:` (the true header); a comment
 *      inside the jobs section is scoped to a job, never file-wide.
 *
 * @param {string} body
 * @param {string[]} jobNames
 * @returns {{ fileAnnotated: boolean, jobAnnotated: (name: string) => boolean }}
 */
function annotationScopes(body, jobNames) {
  const lines = body.split("\n");
  const blockContent = blockScalarContentLines(lines);
  const quotedContent = quotedScalarContentLines(lines, blockContent);
  const inScalar = lines.map((_, i) => blockContent[i] || quotedContent[i]);
  const annotationLines = [];
  lines.forEach((line, i) => {
    if (!inScalar[i] && ANNOTATION_LINE.test(line)) annotationLines.push(i);
  });
  if (annotationLines.length === 0) {
    return { fileAnnotated: false, jobAnnotated: () => false };
  }
  const jobsLine = lines.findIndex(
    (l, i) => !inScalar[i] && /^(['"]?)jobs\1\s*:\s*(#.*)?$/.test(l),
  );
  // Indentation of the job keys: the first real mapping key under `jobs:`.
  let jobIndent = null;
  if (jobsLine >= 0) {
    for (let i = jobsLine + 1; i < lines.length; i += 1) {
      if (inScalar[i] || lines[i].trim() === "" || /^\s*#/.test(lines[i]))
        continue;
      const ind = lines[i].search(/\S/);
      if (ind === 0) break; // dedented out of the jobs block
      jobIndent = ind;
      break;
    }
  }
  const jobStart = new Map();
  if (jobIndent != null) {
    const pad = " ".repeat(jobIndent);
    for (const name of jobNames) {
      const re = new RegExp(
        `^${pad}(['"]?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1\\s*:`,
      );
      for (let i = jobsLine + 1; i < lines.length; i += 1) {
        if (!inScalar[i] && re.test(lines[i])) {
          jobStart.set(name, i);
          break;
        }
      }
    }
  }
  const ordered = [...jobStart.entries()].sort((a, b) => a[1] - b[1]);
  // File-level annotation: a comment ABOVE `jobs:` (the true header). This is
  // deliberately stricter than "before the first job": a comment sitting
  // between `jobs:` and the first job key, or at job-key indent above a job,
  // documents the job BELOW it by universal convention and must not blanket
  // the whole file.
  const fileAnnotated =
    jobsLine >= 0 && annotationLines.some((i) => i < jobsLine);
  const jobAnnotated = (name) => {
    const idx = jobStart.get(name);
    if (idx == null || jobIndent == null) return false;
    const pos = ordered.findIndex(([n]) => n === name);
    const end = pos + 1 < ordered.length ? ordered[pos + 1][1] : lines.length;
    // The annotation must be UNAMBIGUOUSLY inside this job's body: strictly
    // after its key line, before the next job, and indented DEEPER than the
    // job key. A comment at job-key indent (or shallower) between two jobs
    // describes the following job — crediting it to the preceding one silences
    // the wrong job; a column-0 footer after the last job belongs to no job at
    // all. Requiring deeper indentation ties the annotation to the job it is
    // structurally part of.
    return annotationLines.some(
      (i) => i > idx && i < end && lines[i].search(/\S/) > jobIndent,
    );
  };
  return { fileAnnotated, jobAnnotated };
}

/**
 * Evaluate one workflow body. Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * Granularity is PER JOB: in a multi-job workflow, one guarded job must not
 * vouch for an unguarded sibling that also reaches a credential.
 *
 * Exported for tests.
 * @param {string} body
 */
export function evaluateWorkflow(body) {
  const doc = parseWorkflow(body);
  if (doc === null) {
    return {
      ok: false,
      reason:
        "could not be parsed as a single YAML document (syntax error, multi-document stream, or tab indentation) — fail closed: an unparsable workflow cannot be proven safe. Write it as one well-formed YAML document.",
    };
  }
  // A non-mapping root (or empty file) is not a runnable workflow — nothing to
  // trigger, nothing to leak.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: true };
  }
  const triggers = collectTriggers(doc);
  if (triggers.has("pull_request_target")) {
    return {
      ok: false,
      reason:
        "uses pull_request_target, which hands secrets to PR-controlled context by design — use pull_request with an explicit trust gate instead",
    };
  }
  // A workflow is reachable on an UNTRUSTED autofix branch two ways: the PR it
  // eventually opens (`pull_request`), or the branch PUSH the finalizer makes
  // before the PR exists (`push`, when its branch filter admits
  // `sentry-autofix/*`). Each is its own guard context — a job reachable via
  // both must exclude in both.
  const contextSet = new Set();
  if (triggers.has("pull_request")) contextSet.add("pull_request");
  const onValue = "on" in doc ? doc.on : doc[true];
  const pushCfg =
    onValue && typeof onValue === "object" && !Array.isArray(onValue)
      ? onValue.push
      : undefined;
  if (triggers.has("push") && pushAdmitsAutofix(pushCfg))
    contextSet.add("push");
  // `create` fires when the finalizer creates the sentry-autofix/* branch; the
  // job then sees that ref, so it needs the same ref-based exclusion as push.
  if (triggers.has("create")) contextSet.add("push");
  const contexts = [...contextSet];
  if (contexts.length === 0) {
    return { ok: true };
  }
  const via = contexts.join("/");
  const jobs =
    doc.jobs && typeof doc.jobs === "object" && !Array.isArray(doc.jobs)
      ? doc.jobs
      : {};
  const jobNames = Object.keys(jobs);
  const inherited = {
    envSecrets: referencesSecrets(doc.env),
    envWorkflowToken: referencesWorkflowToken(doc.env),
    workflowPermissions: doc.permissions,
  };
  // A reachable workflow with a workflow-level credential but no analyzable
  // jobs still leaks — fail closed unless file-annotated.
  const { fileAnnotated, jobAnnotated } = annotationScopes(body, jobNames);
  if (jobNames.length === 0) {
    if (inherited.envSecrets || grantsOidc(doc.permissions)) {
      if (fileAnnotated) return { ok: true };
      return {
        ok: false,
        reason: `triggers on ${via} (reachable on an autofix branch) and inherits a workflow-level credential (env secrets or an OIDC grant) but declares no jobs to guard — add a file-level '# autofix-ci-trust:' annotation or remove the credential.`,
      };
    }
    return { ok: true };
  }
  const offenders = [];
  for (const name of jobNames) {
    if (!jobReceivesCredential(jobs[name], inherited)) continue;
    if (fileAnnotated || jobAnnotated(name)) continue;
    // Reachable via both contexts → must be guarded in BOTH.
    if (contexts.every((ctx) => jobGuarded(jobs[name], ctx))) continue;
    offenders.push(name);
  }
  if (offenders.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `triggers on ${via} (reachable on an autofix branch), and job(s) [${offenders.join(", ")}] can receive a credential without an excluding autofix guard (${via.includes("push") ? "`!startsWith(github.ref, 'refs/heads/sentry-autofix/')` for push, " : ""}\`!startsWith(github.event.pull_request.head.ref, 'sentry-autofix/')\` for pull_request, on the job's if:) or an '${ANNOTATION}' annotation in that job (or a file-level annotation above \`jobs:\`). ` +
      "Machine-authored autofix PRs pass every fork/dependabot check, and the finalizer pushes the sentry-autofix/* branch before the PR exists, so each credential-bearing job reachable on that branch must exclude it " +
      "or document why its secrets are unreachable from autofix-branch code execution.",
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
    `All ${checked} workflow(s) respect the autofix CI trust boundary (no pull_request_target; every credential-bearing pull_request lane guards or annotates).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
