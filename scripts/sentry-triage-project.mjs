#!/usr/bin/env node
/**
 * Verdict projection leg of the Sentry triage pipeline (ADR 0036 Stage C,
 * refined by ADR 0038, docs/adr/0038-sentry-central-plane-verdict-projection.md):
 * a deterministic, no-LLM step that turns an ACTIONABLE triage verdict
 * (`code-fix` / `config-fix`) for an EXTERNAL owning repo into a proper,
 * human-readable issue in that repo, so product teams see findings where they
 * work. The central queue stub in this repo is a machine ledger; the projected
 * owning-repo issue is the human artifact.
 *
 * This script is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md — it reads a queue stub's title/body and
 * its latest `<!-- sentry-triage-verdict:v1 -->` comment, and never re-fetches
 * Sentry, never runs an LLM, never touches the verdict/label logic. It slots in
 * AFTER the deterministic verdict-label step and BEFORE the queue-close step.
 *
 * Security posture (this leg crosses a repo boundary with a write token, so the
 * bar is higher than the read-only legs):
 *   - `affected_repo` from the verdict yaml is UNTRUSTED agent-authored text.
 *     It is validated against a FIXED three-repo allowlist; anything else is a
 *     no-op with a `::warning::` (treated as this repo — no projection).
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
 *   - Token routing: the cross-repo create/search use the fine-grained
 *     `SENTRY_PROJECTION_TOKEN` PAT (Issues R/W on exactly the three owning
 *     repos); the local stub mutations use the ambient `GH_TOKEN`
 *     (github.token, issues:write on THIS repo). The PAT is never used for a
 *     local call and never reaches the triage agent (it is step-scoped env).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// All pure logic — constants, neutralization, parsing, verdict selection,
// allowlist validation, and body/title rendering — lives in the core module
// (repo splitting convention, mirroring pr-feedback-state-core.mjs). Re-export
// it so tests and consumers keep a single import surface.
export * from "./sentry-triage-project-core.mjs";

import {
  ALIAS_NOTE_PREFIX,
  bodyBacklinksShortId,
  buildAliasComment,
  buildProjectedBody,
  buildProjectedTitle,
  commentBacklinksShortId,
  DEFAULT_REPO,
  extractPermalink,
  isValidShortId,
  MAX_DUPLICATE_LOOKUPS,
  parseShortId,
  PROJECTABLE_VERDICTS,
  PROJECTED_LABEL,
  resolveVerdict,
  VALID_VERDICTS,
  validateAffectedRepo,
} from "./sentry-triage-project-core.mjs";

// ---------------------------------------------------------------------------
// GitHub I/O (via `gh`, mirroring the ingest/digest scripts). `runGh` is
// injectable for tests; the real one routes the fine-grained PAT to cross-repo
// calls only via a per-call GH_TOKEN override.
// ---------------------------------------------------------------------------

function defaultRunGh(args, { token } = {}) {
  return new Promise((resolve, reject) => {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function readQueueIssue(localRun, repo, number) {
  const stdout = await localRun([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,url,state,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    url: data.url ?? "",
    state: String(data.state ?? "").toUpperCase(),
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

// Fixed, markup-free phrase from the projected-issue footer, ANDed with the
// SHORT-ID in the idempotency pre-filter so only pipeline-filed issues
// surface — a bare SHORT-ID substring could over-match in a busy repo and
// push the real projected issue past the result cap.
const FOOTER_SEARCH_PHRASE = "Sentry triage pipeline";

/** The projector identity is the PAT's own user: only issues IT authored can
 * count as genuine projections. Resolved once per run via `gh api user` under
 * the projection token; empty/failed resolution throws (fail loud) rather
 * than falling back to an unauthenticated match. */
async function fetchProjectorLogin(owningRun) {
  const stdout = await owningRun(["api", "user", "--jq", ".login"]);
  const login = String(stdout ?? "").trim();
  if (!login) {
    throw new Error(
      "Could not resolve the projection token's own user login (gh api user returned empty); refusing to match existing projections without an author identity.",
    );
  }
  return login;
}

async function findExistingProjection(
  owningRun,
  owningRepo,
  shortId,
  projectorLogin,
) {
  // `in:body,comments`: a SHORT-ID lives either in a primary projection's
  // BODY (marker + visible fields) or in an alias COMMENT on a coalesced
  // issue (buildAliasComment's visible note) — both carry the footer phrase.
  const stdout = await owningRun([
    "issue",
    "list",
    "-R",
    owningRepo,
    "--state",
    "all",
    "--search",
    `"${shortId}" "${FOOTER_SEARCH_PHRASE}" in:body,comments`,
    "--json",
    "number,url,body,state,author",
    "--limit",
    "200",
  ]);
  const items = stdout && stdout.trim() ? JSON.parse(stdout) : [];
  // Search is a coarse pre-filter (GitHub search may not index HTML-comment
  // text, so the marker itself can't be the search term); the footer-phrase
  // AND keeps it sharp and the 200 cap (matching the duplicate search) keeps
  // it deep. The authoritative check is layered and author-verified — anyone
  // with Issues access in the owning repo can pre-create marker-shaped
  // content, and a hostile issue must not steal the projection slot (the
  // stub would close "reused" pointing at attacker-controlled content):
  //   1. the candidate ISSUE must be authored by the projector identity;
  //   2. its body's leading marker block matches the SHORT-ID (primary
  //      projection), OR a projector-authored alias comment does
  //      (coalesced duplicate).
  const authorMatched = (Array.isArray(items) ? items : []).filter(
    (item) => (item.author?.login ?? "") === projectorLogin,
  );
  const toResult = (item) => ({
    number: item.number,
    url: item.url,
    state: String(item.state ?? "").toUpperCase(),
  });
  // Cheap body-marker check across ALL author-matched candidates: the bodies
  // are already in the search payload, so a genuine primary projection is
  // found regardless of where best-match ranking placed it — other
  // projector-authored issues legitimately mention this SHORT-ID in their
  // rendered "Possible duplicates" lists, and any cap applied before this
  // scan could rank those ahead of the real projection and miss it.
  const direct = authorMatched.find((item) =>
    bodyBacklinksShortId(item.body, shortId),
  );
  if (direct) return toResult(direct);

  // Alias phase: a coalesced SHORT-ID lives in an alias COMMENT, not a body,
  // so run a DEDICATED exact-phrase search (`"<prefix> <shortId>"` — the
  // fixed lead-in buildAliasComment renders) that essentially only alias
  // comments for this id can match; mere mentions of the id in rendered
  // duplicate lists cannot. Candidates are author-filtered and their comments
  // verified (the phrase alone is mimicable by anyone with Issues access).
  // The per-candidate comments read is the expensive call, so the candidate
  // set is bounded — but bounded by FAILING LOUD, never by truncating: a
  // genuine alias must never be skipped because hostile mimics outranked it,
  // so an implausible candidate count (> MAX_CANDIDATE_READS, when the
  // genuine population per id is 0 or 1) aborts into the workflow's
  // compensation path instead of risking a duplicate filing.
  const aliasStdout = await owningRun([
    "issue",
    "list",
    "-R",
    owningRepo,
    "--state",
    "all",
    "--search",
    `"${ALIAS_NOTE_PREFIX} ${shortId}" in:comments`,
    "--json",
    "number,url,state,author",
    "--limit",
    "200",
  ]);
  const aliasItems =
    aliasStdout && aliasStdout.trim() ? JSON.parse(aliasStdout) : [];
  const aliasCandidates = (Array.isArray(aliasItems) ? aliasItems : []).filter(
    (item) => (item.author?.login ?? "") === projectorLogin,
  );
  const MAX_CANDIDATE_READS = 10;
  if (aliasCandidates.length > MAX_CANDIDATE_READS) {
    throw new Error(
      `Alias lookup for ${shortId} in ${owningRepo} returned ${aliasCandidates.length} projector-authored candidates (max ${MAX_CANDIDATE_READS}); refusing to risk missing the genuine alias — failing loud for retry.`,
    );
  }
  for (const item of aliasCandidates) {
    const hasAlias = await hasAliasComment(
      owningRun,
      owningRepo,
      item.number,
      shortId,
      projectorLogin,
    );
    if (hasAlias) return toResult(item);
  }
  return null;
}

// Fixed, deterministic text — no agent-derived content.
const REPROJECTION_REOPEN_COMMENT =
  "Reopened by the Mento Sentry triage pipeline: the underlying Sentry issue " +
  "regressed and was re-triaged as actionable.";

/** A regression that re-projects onto a CLOSED owning-repo issue must
 * resurface for the product team — silently linking a closed issue would bury
 * the regression. Reopen it and leave a fixed comment (Issues R/W covers
 * both); a failure here rejects, landing in the workflow's loud compensation
 * path. */
async function reopenProjectedIssue(owningRun, owningRepo, existing) {
  await owningRun([
    "issue",
    "reopen",
    String(existing.number),
    "-R",
    owningRepo,
  ]);
  await owningRun([
    "issue",
    "comment",
    String(existing.number),
    "-R",
    owningRepo,
    "--body",
    REPROJECTION_REOPEN_COMMENT,
  ]);
}

async function createProjectedIssue(owningRun, owningRepo, title, body) {
  const stdout = await owningRun([
    "issue",
    "create",
    "-R",
    owningRepo,
    "--title",
    title,
    "--body",
    body,
  ]);
  const url = String(stdout).trim().split(/\s+/).filter(Boolean).pop();
  if (!url || !/^https:\/\/github\.com\//.test(url)) {
    throw new Error(
      `gh issue create did not return a github.com URL (got: ${JSON.stringify(url)})`,
    );
  }
  return url;
}

/** True when the owning-repo issue carries a genuine ALIAS for `shortId`: a
 * comment authored by the projector identity whose first line is the marker
 * (see buildAliasComment in the core module for why aliases are atomic
 * comment appends, never body edits). */
async function hasAliasComment(
  owningRun,
  owningRepo,
  number,
  shortId,
  projectorLogin,
) {
  const stdout = await owningRun([
    "issue",
    "view",
    String(number),
    "-R",
    owningRepo,
    "--json",
    "comments",
  ]);
  const comments = JSON.parse(stdout).comments ?? [];
  return comments.some(
    (comment) =>
      (comment?.author?.login ?? "") === projectorLogin &&
      commentBacklinksShortId(comment?.body, shortId),
  );
}

async function markStubProjected(localRun, localRepo, issue, projectedUrl) {
  // Label is idempotent (`--add-label` no-ops if present). Only add the
  // pointer comment when the stub is not already marked, so a re-run (e.g. the
  // reused path after a partial earlier run) never duplicates the comment.
  await localRun([
    "issue",
    "edit",
    String(issue.number),
    "-R",
    localRepo,
    "--add-label",
    PROJECTED_LABEL,
  ]);
  if (!issue.labels.includes(PROJECTED_LABEL)) {
    await localRun([
      "issue",
      "comment",
      String(issue.number),
      "-R",
      localRepo,
      "--body",
      `Projected to owning repo: ${projectedUrl}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Orchestration. Dependency-injectable (`runGh`) so tests drive the full flow
// with mocked I/O and assert token routing + gh args.
// ---------------------------------------------------------------------------

/**
 * `--parse-only` mode: resolve and emit the validated verdict + mapped label
 * for the workflow's deterministic LABEL step, so labeling and projection run
 * the exact same parser (see resolveVerdict), plus `projectable` — whether
 * this verdict is actionable AND its `affected_repo` is an allowlisted
 * EXTERNAL owning repo. The matrix close step uses `projectable` to decide
 * whether to close the stub itself (upstream/local/unrecognized) or defer it
 * to the serialized `project` job (external actionable). Read-only — one
 * `gh issue view` with the ambient token; the projection PAT is never needed
 * here. Throws on missing/stale/invalid verdicts so the label step fails
 * loudly and leaves `sentry:needs-triage` in place for retry.
 */
export async function runParseOnly(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const issue = await readQueueIssue(
    localRun,
    options.localRepo,
    options.queueIssue,
  );
  const { parsed, verdict, label } = resolveVerdict(issue, options.queueIssue);
  let projectable = false;
  if (PROJECTABLE_VERDICTS.includes(verdict)) {
    const repoCheck = validateAffectedRepo(parsed.affectedRepo);
    if (repoCheck.warning) {
      process.stderr.write(`::warning::${repoCheck.warning}\n`);
    }
    projectable = repoCheck.projectable;
  }
  return { verdict, label, projectable };
}

export async function runProjection(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const owningRun = (args) => runGh(args, { token: options.projectionToken });

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
  if (!repoCheck.projectable) {
    return { status: "skipped-repo", reason: repoCheck.reason };
  }

  // Graceful no-op while the PAT is not provisioned: the queue-close step makes
  // this visible (not silent) in the closing comment.
  if (!options.projectionToken) {
    process.stderr.write(
      "::notice::SENTRY_PROJECTION_TOKEN is not set; skipping cross-repo verdict projection (secret not yet provisioned).\n",
    );
    return { status: "skipped-no-token" };
  }

  const owningRepo = repoCheck.repo;
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
    );
    return { status: "reused", url: fromRegistry.url };
  }

  // Author identity for genuine-projection matching (see
  // findExistingProjection): only issues the PAT's own user filed count.
  const projectorLogin = await fetchProjectorLogin(owningRun);

  // Idempotency: reuse an existing projected issue (any state) that back-links
  // this SHORT-ID rather than filing a duplicate. A CLOSED one is reopened
  // first so the regression resurfaces for the product team.
  const existing = await findExistingProjection(
    owningRun,
    owningRepo,
    shortId,
    projectorLogin,
  );
  if (existing) {
    if (existing.state === "CLOSED") {
      await reopenProjectedIssue(owningRun, owningRepo, existing);
    }
    registerFamily({ number: existing.number, url: existing.url });
    await markStubProjected(localRun, options.localRepo, issue, existing.url);
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
        projectorLogin,
      ));
    if (!dupExisting) continue;
    if (dupExisting.state === "CLOSED") {
      await reopenProjectedIssue(owningRun, owningRepo, dupExisting);
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

  const url = await createProjectedIssue(owningRun, owningRepo, title, body);
  registerFamily({ number: Number(url.split("/").pop()), url });
  await markStubProjected(localRun, options.localRepo, issue, url);
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
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:project --issue <queue-issue-number> [options]

Deterministically projects an actionable (code-fix/config-fix) triage verdict
for an EXTERNAL owning repo into a human-readable issue in that repo, labels the
queue stub ${PROJECTED_LABEL}, and comments the projected issue URL. Prints a
single-line JSON result ({"status": "...", "url": "..."}) to stdout; diagnostics
and workflow annotations go to stderr.

Statuses: projected | reused | skipped-verdict | skipped-repo | skipped-no-token
(batch rows additionally: skipped-state | failed)

Options:
  --issue <number>     Queue issue number to project (positive int; required
                       unless --batch).
  --batch              Serialized batch mode (the workflow's project job):
                       process --issues one at a time in ONE process, sharing
                       an in-run registry so duplicate-family SHORT-IDs can
                       never double-file while GitHub search still lags issue
                       creation. Emits a JSON array of per-issue result rows.
  --issues <json>      JSON array of queue-issue numbers (batch mode).
  --repo <owner/name>  Repo the queue stub lives in (default: ${DEFAULT_REPO}).
  --parse-only         Resolve and print the validated verdict + mapped label +
                       projectability ({"verdict","label","projectable"} JSON)
                       without projecting. Used by the workflow's label step so
                       labeling and projection share ONE parser. Fails (exit 1)
                       on a missing, stale pre-regression, or invalid verdict
                       comment.
  --verdict <value>    Already-validated verdict from the label step. When set,
                       the script fails loud if its own parse of the newest
                       verdict comment disagrees (never a silent skip).
  -h, --help           Show this help.

Env:
  SENTRY_PROJECTION_TOKEN  Fine-grained PAT (Issues R/W on the three owning
                           repos) for the cross-repo create/search. Absent ->
                           graceful no-op (status skipped-no-token).
  GH_TOKEN                 Ambient github.token for local queue-stub mutations.
`;
}

/** Parse a `--issues` JSON array of positive integers (the select job's
 * output). Fails loud on anything else. */
export function parseIssueNumbers(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(
      `--issues must be a JSON array of issue numbers, got: ${raw}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--issues must be a JSON array of issue numbers");
  }
  return parsed.map((value) => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid issue number: ${JSON.stringify(value)}`);
    }
    return value;
  });
}

export function parseArgs(argv, env = process.env) {
  const options = {
    localRepo: DEFAULT_REPO,
    queueIssue: null,
    queueIssues: [],
    batch: false,
    parseOnly: false,
    expectedVerdict: null,
    help: false,
  };
  let issuesRaw = null;
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--issue":
        options.queueIssue = Number(readValue());
        break;
      case "--issues":
        issuesRaw = readValue();
        break;
      case "--batch":
        options.batch = true;
        break;
      case "--repo":
        options.localRepo = readValue();
        break;
      case "--parse-only":
        options.parseOnly = true;
        break;
      case "--verdict": {
        // Comes from the label step's closed-enum output; anything else is a
        // wiring bug — fail loud rather than carrying an invalid expectation.
        const value = readValue();
        if (!VALID_VERDICTS.includes(value)) {
          throw new Error(
            `--verdict must be one of ${VALID_VERDICTS.join(", ")}, got: ${value}`,
          );
        }
        options.expectedVerdict = value;
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.help) {
    if (options.batch) {
      options.queueIssues = parseIssueNumbers(issuesRaw);
    } else if (
      !Number.isInteger(options.queueIssue) ||
      options.queueIssue <= 0
    ) {
      throw new Error("--issue must be a positive integer");
    }
  }
  options.projectionToken = (env.SENTRY_PROJECTION_TOKEN ?? "").trim();
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (options.batch) {
    result = await runProjectionBatch(options);
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
