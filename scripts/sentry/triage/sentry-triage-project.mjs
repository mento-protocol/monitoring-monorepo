#!/usr/bin/env node
/**
 * Verdict projection leg of the Sentry triage pipeline (ADR 0036 Stage C,
 * refined by ADR 0038, docs/adr/0038-sentry-central-plane-verdict-projection.md):
 * a deterministic, no-LLM step that turns an ACTIONABLE triage verdict
 * (`code-fix` / `config-fix`) into a proper, human-readable work issue. An
 * allowlisted external owner uses the projection PAT. An exact local
 * `config-fix` uses the ambient Actions token. The central queue stub is a
 * machine ledger; the projected issue is the human artifact.
 *
 * This script is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md — it reads a queue stub's title/body and
 * its latest `<!-- sentry-triage-verdict:v1 -->` comment, and never re-fetches
 * Sentry, never runs an LLM, never touches the verdict/label logic. It slots in
 * AFTER the deterministic verdict-label step and BEFORE the queue-close step.
 *
 * Security posture (the external route crosses a repo boundary with a write
 * token, so the bar is higher than the read-only legs):
 *   - `affected_repo` from the verdict yaml is UNTRUSTED agent-authored text.
 *     A fixed three-repo allowlist permits external projection. An exact local
 *     `config-fix` routes to this repo with the ambient token. Every other
 *     non-allowlisted or non-local destination is a no-op with a `::warning::`.
 *   - Only `code-fix` / `config-fix` verdicts project. `needs-human` and
 *     `upstream-transient` never leave the queue.
 *   - The projected issue body renders ONLY verdict-contract fields (already
 *     redaction-governed — no raw Sentry payload is copied), the Sentry
 *     permalink, a back-link to the queue stub, and a fixed footer. Every
 *     agent-derived string is neutralized (control chars stripped, backticks
 *     defanged so a hostile value can't break a code fence, `@` defanged so it
 *     can't become a live GitHub mention) and multi-line fields are rendered
 *     inside a fenced block so embedded markdown is inert. Same philosophy as
 *     the Stage A queue-body defense.
 *   - Idempotency: before creating, the owning repo is searched (ALL states)
 *     for an existing issue back-linking the same Sentry SHORT-ID (a hidden
 *     `<!-- sentry-projection:v1 SHORT-ID -->` marker), so a re-run — including
 *     after a regression reopen — never files a duplicate.
 *   - Token routing: external create/search use the fine-grained
 *     `SENTRY_PROJECTION_TOKEN` PAT. Local config work and queue-stub
 *     mutations use the ambient `GH_TOKEN` (github.token, issues:write here).
 *     The PAT never reaches the triage agent.
 */

import { fileURLToPath } from "node:url";

// All pure logic — constants, neutralization, parsing, verdict selection,
// allowlist validation, and body/title rendering — lives in the core module
// (repo splitting convention, mirroring pr-feedback-state-core.mjs). Re-export
// it so tests and consumers keep a single import surface.
export * from "./sentry-triage-project-core.mjs";

import {
  extractPermalink,
  FIX_SCOPE_ARCHITECTURAL,
  isValidShortId,
  MAX_DUPLICATE_LOOKUPS,
  isTrustedComment,
  parseShortId,
  PRIOR_VERDICT_NONE,
  PRIOR_VERDICT_UNKNOWN,
  PROJECTABLE_VERDICTS,
  PROJECTED_COMMENT_PREFIX,
  PROJECTED_LABEL,
  resolveVerdict,
  selectVerdictComment,
  validateAffectedRepo,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";

// Projected-issue rendering lives in its own module (#1769), imported HERE
// rather than re-exported through the verdict contract so the contract stays
// out of the untrusted agent wrapper's runtime closure. Re-exported below so
// this leg's tests keep reaching the renderers through this entry module.
export {
  ALIAS_NOTE_PREFIX,
  bodyBacklinksShortId,
  buildAliasComment,
  buildProjectedBody,
  buildProjectedTitle,
  buildProjectionMarker,
  commentBacklinksShortId,
  leadingProjectionMarkers,
} from "./sentry-triage-projection.mjs";
import {
  buildAliasComment,
  buildProjectedBody,
  buildProjectedTitle,
} from "./sentry-triage-projection.mjs";
import {
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  VERDICT_LABELS,
} from "./sentry-triage-ingest.mjs";
// The argv surface and the label self-heal are siblings, split out of this file
// (#1827) to bring it back under the 1,000-line hard cap. Both are re-exported
// so the import surface tests and consumers use through this entry module is
// unchanged, and so the leg keeps ONE implementation of each.
export {
  ensureQueueLabels,
  parseEnsureLabelNames,
  runEnsureLabels,
} from "./sentry-triage-label-ensure.mjs";
import {
  ensureQueueLabels,
  runEnsureLabels,
} from "./sentry-triage-label-ensure.mjs";
export {
  parseArgs,
  parseIssueNumbers,
  usage,
} from "./sentry-triage-project-cli.mjs";
import { parseArgs, usage } from "./sentry-triage-project-cli.mjs";
// Clear any stale needs-human brief before this job CLOSES a projected stub: a
// stub re-triaged needs-human -> code-fix/config-fix whose brief-clear failed in
// the matrix would otherwise be projected and closed here still showing the
// obsolete "Decision needed" (#1769 round 11 P2). Idempotent — a normal
// projectable stub never carries a brief — and a failure marks the row failed
// (the workflow restores needs-triage instead of closing).
import { clearBriefComments } from "./sentry-triage-brief.mjs";
import {
  createProjectedIssue,
  defaultRunGh,
  fetchProjectorLogin,
  findExistingProjection,
  markStubProjected,
  readQueueIssue,
  reopenProjectedIssue,
  projectionDestination,
  WORKFLOW_ISSUE_AUTHOR,
  isWorkflowCreatedIssue,
} from "./sentry-triage-project-route.mjs";
export {
  PROJECTION_DESTINATIONS,
  projectionDestination,
} from "./sentry-triage-project-route.mjs";

// ---------------------------------------------------------------------------
// GitHub routing lives in sentry-triage-project-route.mjs. The entry module
// keeps the serialized orchestration and supplies the destination-specific
// credential and author fences.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestration. Dependency-injectable (`runGh`) so tests drive the full flow
// with mocked I/O and assert token routing + gh args.
// ---------------------------------------------------------------------------

/**
 * `--parse-only` mode: resolve and emit the validated verdict + mapped label
 * for the workflow's deterministic LABEL step, so labeling and projection run
 * the exact same parser (see resolveVerdict), plus `projectable` and its
 * closed projection destination. `projectable` remains external-only. The
 * local-config destination is only for an exact local `config-fix`. The matrix
 * close step uses the destination to decide whether to defer the stub to the
 * serialized project job. Read-only — one
 * `gh issue view` with the ambient token; the projection PAT is never needed
 * here. Throws on missing/stale/invalid verdicts so the label step fails
 * loudly and leaves `sentry:needs-triage` in place for retry.
 *
 * It also emits `shed`: the comma-joined verdict labels the label step must
 * REMOVE in the same `gh issue edit` (#1745). A re-dispatched stub already
 * carries a verdict label and `gh issue edit --add-label` only adds, so
 * without the shed the stub ends up carrying two contradictory verdicts and
 * the digest — which buckets on the FIRST matching label — reports whichever
 * one GitHub happens to order first. Bash cannot import a JS constant, so the
 * list travels through this single authoritative parser's output rather than
 * becoming a second literal list in the workflow.
 *
 * `label` is a COMMA LIST, not always one name (issue #1812): a local `code-fix`
 * verdict whose `fix_scope` is `architectural` adds
 * `sentry:fix-scope-architectural` beside the verdict label, riding the same
 * atomic `--add-label`. `architecturalHold` (boolean) tells the close step to
 * leave that stub OPEN as human design work rather than closing it. The hold
 * label sits OUTSIDE the `sentry:verdict-*` namespace, so the label step's
 * post-condition reread still counts exactly one verdict label; `shed` carries
 * the hold label EXACTLY when the hold does not apply, so a re-dispatched stub
 * whose scope flips to mechanical un-strands in the same edit and no name ever
 * lands in both lists.
 */
export async function runParseOnly(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const issue = await readQueueIssue(
    localRun,
    options.localRepo,
    options.queueIssue,
  );
  // The round binding (#1717): `--prior-verdict-comment` carries what the
  // select job saw on this stub BEFORE the agent ran, so a round that posted
  // nothing cannot settle the stub on the previous round's verdict. Absent flag
  // -> null -> unbound, the pre-#1717 behaviour.
  const { parsed, verdict, label } = resolveVerdict(issue, options.queueIssue, {
    priorVerdictCommentId: options.priorVerdictCommentId,
  });
  // Hoist `repoCheck` out of the projectable branch: PROJECTABLE_VERDICTS holds
  // code-fix, so the architectural-hold gate below (which is code-fix only) always
  // has it computed on that path — computing it once here keeps the selector's
  // gate (evaluateCandidate) and this settlement gate reading the exact same
  // reason, so they can never disagree about which stub holds.
  let projectable = false;
  let repoCheck = null;
  if (PROJECTABLE_VERDICTS.includes(verdict)) {
    repoCheck = validateAffectedRepo(parsed.affectedRepo);
    if (repoCheck.warning) {
      process.stderr.write(`::warning::${repoCheck.warning}\n`);
    }
    projectable = repoCheck.projectable;
  }
  // The architectural hold (issue #1812): a LOCAL `code-fix` verdict whose
  // `fix_scope` is `architectural` is open human design work, not a mechanical
  // diff — the autofix leg must never select it, and the stub stays OPEN as the
  // visible human backlog. The gate is the EXACT triple evaluateCandidate uses
  // (verdict === code-fix, local owning repo, scope architectural), so the
  // selector and settlement can never disagree.
  const architecturalHold =
    verdict === "code-fix" &&
    repoCheck?.reason === "local-repo" &&
    parsed.fixScope === FIX_SCOPE_ARCHITECTURAL;
  // `label` is the comma-joined ADD list for the label step's single
  // `gh issue edit --add-label`: the bare verdict label, or — on the hold — the
  // verdict label PLUS `sentry:fix-scope-architectural`. gh accepts a comma list
  // in one --add-label value, so the hold label rides the SAME atomic edit; it
  // sits OUTSIDE the `sentry:verdict-*` namespace, so the settlement
  // post-condition still counts exactly one verdict label.
  const addLabel = architecturalHold
    ? `${label},${FIX_SCOPE_ARCHITECTURAL_LABEL}`
    : label;
  // The VERDICT namespace only — deliberately not REOPEN_SHED_LABELS, which
  // also carries `sentry:projected` and the autofix/archive markers. Shedding
  // the autofix markers here would un-dedup the select step and let the same
  // stub be fixed twice; shedding `sentry:archived` would erase an audit
  // marker. The label being applied is excluded so one name never reaches both
  // `--remove-label` and `--add-label` in a single edit. Removing a label the
  // stub does not carry is a no-op — the same property
  // `buildReopenLabelEditArgs` relies on — so the first-pass case (no verdict
  // label yet) costs nothing.
  //
  // Append `sentry:fix-scope-architectural` to the shed list EXACTLY when the
  // hold does NOT apply: a re-dispatched stub whose fresh verdict flips to
  // mechanical (or off code-fix) then un-strands in the same edit, and one name
  // never lands in both `--add-label` and `--remove-label`. When the hold DOES
  // apply the label is in the add list only, so it is deliberately absent here.
  const shedLabels = VERDICT_LABELS.filter((name) => name !== label);
  if (!architecturalHold) shedLabels.push(FIX_SCOPE_ARCHITECTURAL_LABEL);
  const shed = shedLabels.join(",");
  return {
    verdict,
    label: addLabel,
    projectable,
    projectionDestination: projectionDestination(verdict, repoCheck),
    shed,
    architecturalHold,
  };
}

/**
 * `--prior-verdicts` mode: the SELECT job's recorder for the round binding
 * (issue #1717). For each stub about to be triaged, emit the id of the verdict
 * comment already on it — `{"<issue>": "<comment-id>" | "none" | "unknown"}` —
 * so the `verdict` job can later refuse to settle the stub on a comment that
 * predates the round. It must run in the trusted select job, BEFORE the agent:
 * read it afterwards and it would see the round's own comment and prove
 * nothing.
 *
 * Selection runs through `selectVerdictComment`, the same single selector the
 * verdict job resolves with, so the two ends cannot drift into disagreeing
 * about which comment "the previous verdict" is.
 *
 * Fail CLOSED per stub, never per run: an unreadable stub, or a selected
 * comment whose url carries no parseable id, records `unknown`, which
 * `resolveVerdict` refuses. That costs one wasted triage round on the affected
 * stub — loud, and self-healing on the next run, since that round's own verdict
 * comment becomes the next baseline — where waving it through is exactly the
 * laundering this closes. One unreadable stub does not fail the whole select
 * job and starve the rest of the batch.
 */
export async function runPriorVerdicts(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const priorVerdicts = {};
  for (const number of options.queueIssues) {
    let issue;
    try {
      // The shared reader, not a leaner `--json comments` of its own: one
      // reader means one normalization, and the extra fields cost nothing on a
      // batch capped at ten stubs.
      issue = await readQueueIssue(localRun, options.localRepo, number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `::warning::Could not read queue issue #${number} to record its prior verdict comment (${message}); recording '${PRIOR_VERDICT_UNKNOWN}', which makes this run refuse to settle it.\n`,
      );
      priorVerdicts[String(number)] = PRIOR_VERDICT_UNKNOWN;
      continue;
    }
    const selected = selectVerdictComment(issue.comments);
    if (!selected.body) {
      priorVerdicts[String(number)] = PRIOR_VERDICT_NONE;
      continue;
    }
    const id = verdictCommentIdFromUrl(selected.url);
    if (!id) {
      process.stderr.write(
        `::warning::Queue issue #${number} carries a usable verdict comment with no parseable id (url=${selected.url}); recording '${PRIOR_VERDICT_UNKNOWN}', which makes this run refuse to settle it.\n`,
      );
      priorVerdicts[String(number)] = PRIOR_VERDICT_UNKNOWN;
      continue;
    }
    priorVerdicts[String(number)] = id;
  }
  return priorVerdicts;
}

export async function runProjection(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});

  const issue = await readQueueIssue(
    localRun,
    options.localRepo,
    options.queueIssue,
  );

  const shortId = parseShortId(issue.title);
  if (!isValidShortId(shortId)) {
    throw new Error(
      `Queue issue #${options.queueIssue} has no parseable Sentry short-ID in its title; cannot project.`,
    );
  }

  // Same single parser as the label step (resolveVerdict). Missing, stale, or
  // invalid verdicts THROW — fail loud so the workflow compensates (restore
  // needs-triage, shed verdict label) instead of closing an unhandled stub.
  const { parsed } = resolveVerdict(issue, options.queueIssue);

  // The workflow passes the label step's already-validated verdict back via
  // --verdict. Both steps run the same parser, so a mismatch can only mean the
  // issue changed between steps (e.g. a newer verdict comment landed) — refuse
  // to project against divergent state, loudly, never silently skip.
  if (options.expectedVerdict && parsed.verdict !== options.expectedVerdict) {
    throw new Error(
      `Verdict mismatch on issue #${options.queueIssue}: the label step validated '${options.expectedVerdict}' but the newest verdict comment parses as '${parsed.verdict}'; refusing to project against divergent state.`,
    );
  }

  if (!PROJECTABLE_VERDICTS.includes(parsed.verdict)) {
    return { status: "skipped-verdict", verdict: parsed.verdict };
  }

  const repoCheck = validateAffectedRepo(parsed.affectedRepo);
  if (repoCheck.warning) {
    process.stderr.write(`::warning::${repoCheck.warning}\n`);
  }
  const destination = projectionDestination(parsed.verdict, repoCheck);
  if (destination === "none") {
    return { status: "skipped-repo", reason: repoCheck.reason };
  }

  // Graceful no-op only for an external route without its PAT. Local config
  // projection uses the ambient Actions token and never needs this secret.
  if (destination === "external" && !options.projectionToken) {
    process.stderr.write(
      "::notice::SENTRY_PROJECTION_TOKEN is not set; skipping cross-repo verdict projection (secret not yet provisioned).\n",
    );
    return { status: "skipped-no-token" };
  }

  const owningRepo = repoCheck.repo;
  const localConfig = destination === "local-config";
  const owningRun = localConfig
    ? localRun
    : (args) => runGh(args, { token: options.projectionToken });
  const projectorLogin = localConfig
    ? WORKFLOW_ISSUE_AUTHOR
    : await fetchProjectorLogin(owningRun);
  const authorFences = localConfig
    ? {
        isIssueAuthor: isWorkflowCreatedIssue,
        isCommentAuthor: (login) => isTrustedComment({ author: { login } }),
      }
    : {
        isIssueAuthor: (login) => login === projectorLogin,
        isCommentAuthor: (login) => login === projectorLogin,
      };
  const queueIssueUrl =
    issue.url ||
    `https://github.com/${options.localRepo}/issues/${options.queueIssue}`;

  // Duplicate ids (agent-produced): sanitized (shape-validated, deduplicated),
  // the stub's own SHORT-ID excluded, and only THEN budget-capped — a
  // self-reference must not consume budget and push a real duplicate past the
  // cap. Each entry costs bounded owning-repo lookups, never an open-ended
  // fan-out.
  const dupIds = parsed.duplicateOf
    .filter((dupId) => dupId !== shortId)
    .slice(0, MAX_DUPLICATE_LOOKUPS);

  // In-run registry (batch mode): `<owningRepo>:<SHORT-ID>` -> issue
  // projected/reused EARLIER IN THIS RUN. Consulted before every search
  // because GitHub's search index lags issue creation — two duplicate-family
  // stubs in one batch would otherwise both search, both miss the seconds-old
  // issue, and double-file. Keys are REPO-QUALIFIED so a family whose members
  // name different owning repos never aliases across repositories, and every
  // settlement registers the issue under the stub's own SHORT-ID AND its
  // declared duplicates (first entry wins) — so coalescing is symmetric in
  // batch order: whether A or its duplicate B processes first, the second one
  // finds the family issue in the registry.
  const registry = options.registry;
  const regKey = (id) => `${owningRepo}:${id}`;
  const registerFamily = (entry) => {
    if (!registry) return;
    for (const id of [shortId, ...dupIds]) {
      if (!registry.has(regKey(id))) registry.set(regKey(id), entry);
    }
  };
  const postAliasComment = (targetNumber) =>
    owningRun([
      "issue",
      "comment",
      String(targetNumber),
      "-R",
      owningRepo,
      "--body",
      buildAliasComment({
        shortId,
        queueIssueUrl,
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        summary: parsed.summary,
        rootCause: parsed.rootCause,
        proposedAction: parsed.proposedAction,
      }),
    ]);

  const fromRegistry = registry?.get(regKey(shortId));
  if (fromRegistry) {
    // An earlier batch stub registered this SHORT-ID (it declared this stub a
    // duplicate). Persist the membership durably with the alias comment — the
    // in-memory registration alone would let a future regression double-file
    // once this run's registry is gone (the issue carries no marker/alias for
    // this id yet).
    await postAliasComment(fromRegistry.number);
    registerFamily(fromRegistry);
    await markStubProjected(
      localRun,
      options.localRepo,
      issue,
      fromRegistry.url,
      PROJECTED_COMMENT_PREFIX,
    );
    return { status: "reused", url: fromRegistry.url };
  }

  // Idempotency: reuse an existing projected issue (any state) that back-links
  // this SHORT-ID rather than filing a duplicate. A CLOSED one is reopened
  // first so the regression resurfaces for the product team.
  const existing = await findExistingProjection(
    owningRun,
    owningRepo,
    shortId,
    authorFences,
  );
  if (existing) {
    if (existing.state === "CLOSED") {
      await reopenProjectedIssue(owningRun, owningRepo, existing, {
        restoreAgentReady: localConfig,
      });
    }
    registerFamily({ number: existing.number, url: existing.url });
    await markStubProjected(
      localRun,
      options.localRepo,
      issue,
      existing.url,
      PROJECTED_COMMENT_PREFIX,
    );
    return { status: "reused", url: existing.url };
  }

  // Duplicate coalescing: when the verdict marks this error a duplicate of
  // another SHORT-ID that ALREADY has a genuine projection, reuse that issue
  // (comment the new SHORT-ID onto it) instead of filing a second owning-repo
  // issue for the same underlying bug. The same leading-marker + author
  // checks apply, so a hostile marker-shaped issue can't capture the
  // coalescing path either.
  for (const dupId of dupIds) {
    // Registry first (see above): a duplicate-family issue projected earlier
    // in this run is not yet searchable, but it IS in the registry.
    const dupExisting =
      registry?.get(regKey(dupId)) ??
      (await findExistingProjection(
        owningRun,
        owningRepo,
        dupId,
        authorFences,
      ));
    if (!dupExisting) continue;
    if (dupExisting.state === "CLOSED") {
      await reopenProjectedIssue(owningRun, owningRepo, dupExisting, {
        restoreAgentReady: localConfig,
      });
    }
    // Persist the coalesced SHORT-ID into the idempotency index as ONE atomic
    // comment APPEND (marker-anchored alias comment — see buildAliasComment
    // for why a comment, never a body edit). This is what makes coalescing
    // durable AND race-free: a later regression whose fresh verdict
    // omits/changes `duplicate_of` still resolves this SHORT-ID to the same
    // issue via the primary lookup above (which matches alias comments), a
    // retry after a partial failure takes the plain reused path without
    // re-commenting, and independent coalescers append — nothing to
    // overwrite.
    await postAliasComment(dupExisting.number);
    registerFamily({ number: dupExisting.number, url: dupExisting.url });
    await markStubProjected(
      localRun,
      options.localRepo,
      issue,
      dupExisting.url,
      PROJECTED_COMMENT_PREFIX,
    );
    return { status: "reused", url: dupExisting.url };
  }

  const title = buildProjectedTitle(parsed.summary);
  const body = buildProjectedBody({
    shortId,
    verdict: parsed.verdict,
    confidence: parsed.confidence,
    summary: parsed.summary,
    rootCause: parsed.rootCause,
    proposedAction: parsed.proposedAction,
    duplicateOf: parsed.duplicateOf,
    permalink: extractPermalink(issue.body),
    queueIssueUrl,
  });

  const url = await createProjectedIssue(owningRun, owningRepo, title, body, {
    labels: localConfig ? ["agent-ready"] : [],
  });
  registerFamily({ number: Number(url.split("/").pop()), url });
  await markStubProjected(
    localRun,
    options.localRepo,
    issue,
    url,
    PROJECTED_COMMENT_PREFIX,
  );
  return { status: "projected", url };
}

// Verdict labels that route through projection, mapped back to their verdict
// values (deterministically applied by the matrix label step from the closed
// enum — trusted input for the batch dispatch below).
const ACTIONABLE_LABEL_TO_VERDICT = {
  "sentry:verdict-code-fix": "code-fix",
  "sentry:verdict-config-fix": "config-fix",
};

/**
 * `--batch` mode: the serialized `project` job's driver. Processes the run's
 * queue issues ONE AT A TIME in a single node process, which kills the
 * same-run duplicate-family race by construction — no two projections are
 * ever in flight together, and the shared in-run registry resolves
 * SHORT-IDs created seconds ago that GitHub search has not indexed yet.
 *
 * Per issue: skip anything the matrix already settled (closed stubs,
 * needs-triage retries, non-actionable verdict labels), then run the normal
 * single-issue projection with the label-derived verdict as the
 * cross-check. Per-issue failures are recorded (status "failed") and the
 * batch CONTINUES — one broken stub must not strand the rest; the workflow
 * compensates per failed row and turns the job red at the end.
 *
 * Emits one result row per issue; `verdict`/`label` ride along so the
 * workflow can build closing comments and compensation label edits from
 * closed-enum values only.
 */
export async function runProjectionBatch(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const registry = new Map();
  const results = [];

  // Self-heal the projection label from the single source of truth (Stage A's
  // LABEL_DEFINITIONS): this job can run before any post-deploy ingest has
  // bootstrapped it, and gh errors on repo-nonexistent labels — which failed
  // both the stub labeling and the compensation removals on first activation.
  // Best-effort: if the ensure itself fails, per-row settling fails loudly
  // with compensation as before.
  await ensureQueueLabels(localRun, options.localRepo, [PROJECTED_LABEL]);

  for (const number of options.queueIssues) {
    let verdict = null;
    let label = null;
    try {
      const stub = await readQueueIssue(localRun, options.localRepo, number);
      if (stub.state === "CLOSED") {
        results.push({
          issue: number,
          status: "skipped-state",
          reason: "closed",
        });
        continue;
      }
      if (stub.labels.includes("sentry:needs-triage")) {
        results.push({
          issue: number,
          status: "skipped-state",
          reason: "needs-triage",
        });
        continue;
      }
      // Architectural hold (issue #1812): a held stub is OPEN and carries the
      // actionable `sentry:verdict-code-fix` label, so without this guard it
      // reaches runProjection, which returns `skipped-repo` for a local owning
      // repo — and the batch project workflow reds on `skipped-repo`. The hold
      // label rides the SAME atomic edit as the verdict label minutes earlier in
      // this run, and the batch only ever holds the current run's issues, so the
      // label is a reliable in-run signal. Skip it as a benign state (the
      // workflow's `skipped-state` arm continues) — the stub stays open as human
      // design work, which is the intended terminal shape.
      if (stub.labels.includes(FIX_SCOPE_ARCHITECTURAL_LABEL)) {
        results.push({
          issue: number,
          status: "skipped-state",
          reason: "architectural-open",
        });
        continue;
      }
      label =
        stub.labels.find((name) =>
          Object.hasOwn(ACTIONABLE_LABEL_TO_VERDICT, name),
        ) ?? null;
      if (!label) {
        results.push({
          issue: number,
          status: "skipped-state",
          reason: "not-actionable",
        });
        continue;
      }
      verdict = ACTIONABLE_LABEL_TO_VERDICT[label];
      // Clear any stale needs-human brief BEFORE this stub is projected and
      // closed. A projectable stub should never carry one (needs-human does not
      // project), so this is normally a no-op — but if the stub was re-triaged
      // from needs-human and the matrix brief-clear failed, closing it here would
      // preserve the obsolete "Decision needed" on the closed stub (#1769 round
      // 11 P2). If the clear itself fails it throws, and the per-row catch marks
      // the row failed so the workflow restores sentry:needs-triage instead of
      // closing on a stale brief.
      await clearBriefComments({
        runGh: localRun,
        repo: options.localRepo,
        issueNumber: number,
        comments: stub.comments,
        log: (message) => process.stderr.write(`${message}\n`),
      });
      const result = await runProjection(
        {
          ...options,
          queueIssue: number,
          expectedVerdict: verdict,
          registry,
        },
        deps,
      );
      results.push({ issue: number, verdict, label, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Projection failed for queue issue #${number}: ${message}\n`,
      );
      results.push({
        issue: number,
        status: "failed",
        verdict,
        label,
        message,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI. The argv surface lives in ./sentry-triage-project-cli.mjs; this file
// keeps the dispatch, which is the only part that needs the mode drivers above.
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (options.ensureLabels) {
    // The self-heal module owns no runner, so the leg's `gh` wrapper is handed
    // in here rather than defaulted there.
    result = await runEnsureLabels(options, { runGh: defaultRunGh });
  } else if (options.batch) {
    result = await runProjectionBatch(options);
  } else if (options.priorVerdicts) {
    result = await runPriorVerdicts(options);
  } else if (options.parseOnly) {
    result = await runParseOnly(options);
  } else {
    result = await runProjection(options);
  }
  // ONLY the JSON result goes to stdout (the workflow captures it to decide
  // labeling / the closing comment); every diagnostic/annotation already went
  // to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
