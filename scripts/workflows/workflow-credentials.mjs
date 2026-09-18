/**
 * Credential analysis over a PARSED GitHub Actions workflow.
 *
 * These predicates answer one question: can this job receive a repository
 * credential? `check-pr-validation-boundary.mjs` uses them to build the closed
 * inventory of PR-reachable jobs that hold write authority or a credential
 * binding, so its pinned inventory fails the moment a new lane appears.
 *
 * They were the reusable half of the retired `check-autofix-ci-trust.mjs`
 * (issue #2486); the trust rules that named the `sentry-autofix/*` namespace
 * went with it, and the repo-wide `pull_request_target` refusal moved to
 * `check-ci-contract.mjs`.
 *
 * Every predicate fails CLOSED: an unparsable workflow, an unfollowable
 * reusable-workflow call, or an ambiguous `with:` value counts as
 * credential-bearing rather than clean.
 */

import yaml from "js-yaml";

/**
 * Parse a workflow body. Returns the parsed document, or null when the source
 * is not analyzable as a single YAML document (syntax error, multi-document
 * stream, tab indentation — all of which `js-yaml` throws on). A null return
 * is the signal to FAIL CLOSED.
 *
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
 * True when a parsed `permissions:` value grants OIDC token minting —
 * `id-token: write` or the umbrella `write-all`. OIDC capability is a
 * credential even with zero `secrets.*` references: this repo's WIF pool
 * (terraform/ci-wif.tf) trusts any OIDC token carrying this repository's
 * `attribute.repository`, so a PR job holding it can exchange the token for
 * the plan-readonly service account.
 *
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
 * (`${{ github.token }}`) exposed to PR-head code can mutate the repo (push,
 * open/label issues and PRs, …), so it is a credential too. */
export function hasWritePermission(permissions) {
  if (permissions === "write-all") return true;
  if (permissions && typeof permissions === "object") {
    return Object.values(permissions).some((v) => v === "write");
  }
  return false;
}

/**
 * True when a step `uses:` value invokes `actions/checkout` at ANY ref — the
 * canonical `actions/checkout@<ref>`, a bare `actions/checkout`, or a subpath
 * action under that repo — matched case-insensitively (GitHub resolves action
 * owner/repo case-insensitively). Anchored on the path segment so a LOOKALIKE
 * like `actions/checkout-something-else` is NOT credited: the `checkout`
 * segment must terminate at `@`, `/`, or end-of-string.
 *
 * The value is TRIMMED first: js-yaml preserves leading/trailing whitespace
 * inside a QUOTED scalar (`uses: " actions/checkout@v4"`), and the anchored
 * match would otherwise MISS it — a fail-OPEN. Trimming can only ever match
 * MORE, never fewer, so it is strictly fail-closed.
 */
function isCheckoutAction(uses) {
  return /^actions\/checkout(?=@|\/|$)/i.test(uses.trim());
}

/**
 * True when a job with an effective WRITE permission runs `actions/checkout`
 * that PERSISTS the automatic GITHUB_TOKEN into `.git/config`. checkout's
 * `persist-credentials` defaults to TRUE, writing the run's write-scoped
 * `GITHUB_TOKEN` into the working tree's git config, where any later step —
 * including one executing PR-head code — can read it and push/mutate the repo.
 * So a write-permission job that checks out WITHOUT `persist-credentials: false`
 * holds a mutating credential even when it never names `github.token` textually.
 *
 * A step opts OUT only with the boolean `false` or a string that
 * case-insensitively equals "false" — exactly what actions/checkout's own
 * core.getBooleanInput accepts (false/False/FALSE; js-yaml's CORE_SCHEMA yields
 * a boolean for unquoted `false`, a string for a quoted `"false"`). ANY other
 * value (true, an expression, unset, a missing `with:` block) leaves the token
 * on disk. Multiple checkout steps: if ANY persists, the token is written →
 * flag (a persist-credentials:false step does not undo a sibling plain
 * checkout).
 *
 * Fails CLOSED on ambiguity: reached only for object jobs; a missing/non-array
 * `steps`, non-object steps, steps without a string `uses`, or a non-object
 * `with:` contribute no opt-out and cannot clear the job.
 *
 * ASSUMPTIONS (kept explicit, same as the github.token branch): a job with no
 * explicit `permissions:` anywhere resolves to effectivePermissions=undefined →
 * hasWritePermission=false → not flagged; this relies on the repo default token
 * being read-only (pinned in terraform/github-actions-permissions.tf and watched
 * daily by .github/workflows/platform-settings-drift.yml). A composite/local
 * action that internally checks out is not followed cross-file.
 *
 * @param {any} job
 * @param {any} effectivePermissions the job's effective `permissions:` (own or inherited)
 */
export function jobPersistsWriteCheckout(job, effectivePermissions) {
  if (!hasWritePermission(effectivePermissions)) return false;
  if (!job || typeof job !== "object" || !Array.isArray(job.steps))
    return false;
  for (const step of job.steps) {
    if (!step || typeof step !== "object") continue;
    if (typeof step.uses !== "string" || !isCheckoutAction(step.uses)) continue;
    const w = step.with;
    const pc =
      w != null && typeof w === "object" ? w["persist-credentials"] : undefined;
    const optsOut =
      pc === false || (typeof pc === "string" && pc.toLowerCase() === "false");
    if (!optsOut) return true;
  }
  return false;
}

const THIS_REPO = "mento-protocol/monitoring-monorepo";

/** True when a job's `uses:` value names a reusable workflow IN THIS REPO —
 * the self-repository or relative form, or the fully-qualified
 * self-reference (`mento-protocol/monitoring-monorepo/.github/workflows/…@ref`),
 * which GitHub resolves to the same repository. */
function callsInRepoReusableWorkflow(uses) {
  if (uses.startsWith("$/")) return true;
  if (/^\.\.?\//.test(uses)) return true;
  // GitHub owner/repo matching is case-insensitive, so compare lowercased
  // (THIS_REPO is already lowercase). Over-matching here only ADDS scrutiny.
  return uses.toLowerCase().startsWith(`${THIS_REPO}/.github/workflows/`);
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
 * @param {any} job
 * @param {{ envSecrets: boolean, envWorkflowToken?: boolean, workflowPermissions: any }} inherited
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
  // permissions grant a write scope, is a mutating credential in PR-head code's
  // hands. The `github.token` reference may sit in the JOB body or be inherited
  // from a workflow-level `env:` (available to every job/step).
  if (
    hasWritePermission(effectivePermissions) &&
    (referencesWorkflowToken(job) || inherited.envWorkflowToken)
  ) {
    return true;
  }
  // A write-permission job that runs actions/checkout WITHOUT
  // `persist-credentials: false` leaves the run's write-scoped GITHUB_TOKEN in
  // .git/config, readable by any later step that executes PR-head code — a
  // mutating credential even with no textual github.token reference.
  if (jobPersistsWriteCheckout(job, effectivePermissions)) return true;
  // A `secrets:` key exists only on a reusable-workflow (`uses:`) call and
  // always forwards the caller's secrets — `inherit` (string) or a map.
  if (job.secrets != null) return true;
  if (job.environment != null) return true;
  // A job that CALLS a reusable workflow IN THIS REPOSITORY can receive a
  // credential the CALLEE binds — an `environment:` or its own `secrets:`/OIDC —
  // with no caller-side `secrets:` key at all. Following the callee cross-file
  // is out of this pass's scope, so fail closed: treat an in-repo reusable-
  // workflow call as credential-bearing. This covers the relative form
  // (`$/.github/workflows/…` or `./.github/workflows/…`) and the qualified form
  // (`mento-protocol/monitoring-monorepo/.github/workflows/…@ref`), which
  // GitHub resolves to the same repo. Step `uses:` (actions) live under
  // `steps[]`, not here. A reusable workflow in ANOTHER repo receives secrets
  // only via an explicit caller `secrets:` key, already caught above.
  if (typeof job.uses === "string" && callsInRepoReusableWorkflow(job.uses)) {
    return true;
  }
  return false;
}
