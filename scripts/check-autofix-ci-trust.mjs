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

/** Compile a GitHub Actions ref-glob to a RegExp, or null when it uses a glob
 * metacharacter this checker does not model (`[`, `+`, `!`, `{`). `*` matches
 * within a path segment, `**` across segments, `?` one char. */
function globToRegExp(pattern) {
  if (typeof pattern !== "string" || /[[\]{}!+]/.test(pattern)) return null;
  const rx = pattern
    .replace(/[.^$()|\\]/g, "\\$&")
    .replace(/\*\*/g, "\0") // placeholder for cross-segment
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`);
}

// The finalizer pushes `sentry-autofix/<lowercased Sentry short-id>` — a
// single extra path segment whose content is project-derived and open-ended.
// A branch filter must be tested against the WHOLE namespace, not one sample:
// `sentry-autofix/app-*` matches a future `app-…` project's branch even though
// it misses `sentry-autofix/x`.
const AUTOFIX_BRANCH_PROBES = [
  "sentry-autofix/x",
  "sentry-autofix/app-mento-org-2g",
  "sentry-autofix/analytics-mento-org-7x",
  "sentry-autofix/aegis-1a",
];

/** True when SOME autofix branch could match `pattern` — used for the `branches`
 * (admit-if-could-match) direction, so it over-approximates (fail closed toward
 * admitting): any probe match, or any un-modeled pattern that names the
 * namespace, counts. */
function patternAdmitsSomeAutofix(pattern) {
  const rx = globToRegExp(pattern);
  if (rx === null) return true; // un-modeled → could match → admit (fail closed)
  if (AUTOFIX_BRANCH_PROBES.some((b) => rx.test(b))) return true;
  // A pattern that names the namespace but matched no probe (e.g. a future
  // project prefix) could still match a real branch — fail closed.
  return typeof pattern === "string" && pattern.includes("sentry-autofix");
}

/** True when EVERY autofix branch definitely matches `pattern` — used for the
 * `branches-ignore` (exclude-only-if-certain) direction, so it MUST be
 * conservative: only the structural whole-namespace wildcards qualify. Anything
 * partial (`sentry-autofix/app-*`) does not exclude the whole namespace and so
 * leaves the branch admitted. */
function patternExcludesAllAutofix(pattern) {
  return (
    pattern === "**" ||
    pattern === "sentry-autofix/*" ||
    pattern === "sentry-autofix/**"
  );
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
    // Admit if any pattern could match some autofix branch — fail closed.
    return pats.some(patternAdmitsSomeAutofix);
  }
  if ("branches-ignore" in pushCfg) {
    const pats = Array.isArray(pushCfg["branches-ignore"])
      ? pushCfg["branches-ignore"]
      : [pushCfg["branches-ignore"]];
    // Excluded ONLY if a pattern excludes the WHOLE autofix namespace; a partial
    // or un-modeled pattern is not a definite exclusion — fail closed (admit).
    return !pats.some(patternExcludesAllAutofix);
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

const THIS_REPO = "mento-protocol/monitoring-monorepo";

/** True when a job's `uses:` value names a reusable workflow IN THIS REPO —
 * either the relative form (`./.github/workflows/…`) or the fully-qualified
 * self-reference (`mento-protocol/monitoring-monorepo/.github/workflows/…@ref`),
 * which GitHub resolves to the same repository. */
function callsInRepoReusableWorkflow(uses) {
  if (/^\.\.?\//.test(uses)) return true;
  return uses.startsWith(`${THIS_REPO}/.github/workflows/`);
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
  // A job that CALLS a reusable workflow IN THIS REPOSITORY can receive a
  // credential the CALLEE binds — an `environment:` or its own `secrets:`/OIDC —
  // with no caller-side `secrets:` key at all. Following the callee cross-file
  // is out of this pass's scope, so fail closed: treat an in-repo reusable-
  // workflow call as credential-bearing (the author guards or annotates,
  // stating the callee is credential-free). This covers the relative form
  // (`./.github/workflows/…`) AND the fully-qualified self-reference
  // (`mento-protocol/monitoring-monorepo/.github/workflows/…@ref`), which
  // GitHub resolves to the same repo. Step `uses:` (actions) live under
  // `steps[]`, not here. A reusable workflow in ANOTHER repo receives secrets
  // only via an explicit caller `secrets:` key, already caught above.
  if (typeof job.uses === "string" && callsInRepoReusableWorkflow(job.uses)) {
    return true;
  }
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

/** Mark every source line that is scalar CONTENT — inside a block scalar
 * (`run: |`, `script: >-`) or a continuation of a multiline quoted scalar
 * (`key: "a\n# not-a-comment\nb"`). A line-leading `#` in either is string
 * content, not a YAML comment, so it must not be read as an annotation.
 *
 * The two are tracked in ONE pass with quote state checked FIRST: a structural
 * line that ends inside an open quote opens a quoted scalar (its trailing `|`
 * is a character INSIDE the string, never a block-scalar introducer), and only
 * a line that ends OUTSIDE any quote can introduce a block scalar. That
 * ordering is what stops a quoted continuation ending in `|` from being
 * misread as a block introducer (which would reset the quote state and let a
 * later `#` line in the same scalar pose as a comment). */
function scalarContentLines(lines) {
  const content = new Array(lines.length).fill(false);
  let inQuote = null; // open quote char, or null
  let blockIndent = null; // indent of the active block-scalar introducer, or null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (blockIndent !== null) {
      if (line.trim() === "" || line.search(/\S/) > blockIndent) {
        content[i] = true;
        continue;
      }
      blockIndent = null; // dedented out of the block scalar — reprocess line
    }
    if (inQuote) {
      content[i] = true;
      inQuote = quoteStateAfter(line, inQuote);
      continue;
    }
    // Structural line. A quote it leaves OPEN wins over a `|` introducer (the
    // `|` would be inside that quote).
    const q = quoteStateAfter(line, null);
    if (q) {
      inQuote = q;
      continue;
    }
    if (
      !/^\s*#/.test(line) &&
      /(?:^|\s)[|>][0-9+-]{0,2}\s*(#.*)?$/.test(line)
    ) {
      blockIndent = line.search(/\S/);
    }
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
  const inScalar = scalarContentLines(lines);
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
