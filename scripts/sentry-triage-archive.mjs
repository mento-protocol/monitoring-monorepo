#!/usr/bin/env node
/**
 * Phase 2a of the Sentry triage pipeline (ADR 0036 Stage C,
 * docs/adr/0036-sentry-triage-pipeline.md): the deterministic, ZERO-LLM archive
 * leg. A human reviews a verdicted queue stub and applies the
 * `sentry:approved-archive` label; `.github/workflows/sentry-triage-archive.yml`
 * runs the deterministic approval-authority + verdict guards and then invokes
 * this script, which archives the underlying Sentry issue as
 * `archived_until_escalating` (NEVER a hard resolve — escalation must resurface
 * a mistake, ADR 0036), leaves an audit trail on the queue stub, and closes it.
 *
 * Trust boundary: automation may only ever set a Sentry issue to
 * `archived_until_escalating`. The mutation runs under the separate,
 * write-scoped `SENTRY_ARCHIVE_TOKEN` (Issue & Event: Read + Write) — never the
 * read-only triage token, never the projection PAT. The queue-stub mutations
 * use the ambient `GH_TOKEN` (issues:write on THIS repo).
 *
 * Testability mirrors the sibling scripts: `runGh` and global `fetch` are
 * dependency-injected so the test file drives the whole flow with mocked I/O.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  APPROVED_ARCHIVE_LABEL,
  ARCHIVED_LABEL,
  LABEL_DEFINITIONS,
  neutralizeUntrusted,
  REOPEN_SHED_LABELS,
  truncateTitle,
} from "./sentry-triage-ingest.mjs";

const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_ORG = "mento-labs";
export const DEFAULT_SENTRY_BASE_URL = "https://us.sentry.io";

// Fixed marker line on the queue-stub audit comment; also the idempotency key
// that stops a workflow_dispatch retry from double-posting the audit.
export const ARCHIVE_COMMENT_MARKER = "<!-- sentry-triage-archive:v1 -->";

// The ONLY Sentry status this automation may set (ADR 0036 trust boundary):
// archived-until-escalating. Never `resolved`, never a bare `ignored` without
// the escalating substatus. Verified against the official Sentry API docs:
// PUT /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/
// https://docs.sentry.io/api/events/update-an-issue/ — the documented payload
// for "archive until it escalates" is exactly this shape.
export const ARCHIVE_PAYLOAD = Object.freeze({
  status: "ignored",
  substatus: "archived_until_escalating",
  statusDetails: {},
});

/**
 * Compensation payload: restore the EXACT status/substatus the issue had before
 * this run archived it (captured from the pre-archive fetch). Used ONLY to undo
 * an archive this run performed when a concurrent regression-reopen invalidated
 * the human approval mid-flight, so the regression stays surfaced in Sentry (the
 * self-correction the pipeline promises) instead of being buried under a stale
 * approval. Restoring the captured prior state — rather than forcing
 * `unresolved` — preserves a legitimate pre-existing archive mode (e.g.
 * `archived_forever`). Same update-an-issue endpoint as ARCHIVE_PAYLOAD.
 */
export function buildRestorePayload(preArchive) {
  const status = String(preArchive?.status ?? "").toLowerCase() || "unresolved";
  const substatus = String(preArchive?.substatus ?? "").toLowerCase();
  return substatus ? { status, substatus } : { status };
}

// Archive labels this script self-heals + swaps (defined once in the ingest
// LABEL_DEFINITIONS — single source of truth for colors/descriptions).
const ARCHIVE_LABEL_NAMES = new Set([APPROVED_ARCHIVE_LABEL, ARCHIVED_LABEL]);

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

export function truncate(text, maxLen) {
  const clean = String(text ?? "");
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trimEnd()}…`;
}

function stripYamlQuotes(value) {
  const v = String(value ?? "").trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

export function isSafeSentryPermalink(url) {
  try {
    const parsed = new URL(String(url));
    return (
      parsed.protocol === "https:" && /(^|\.)sentry\.io$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Read a single scalar field out of the queue stub's yaml body. The keys are
 * fixed literals (no regex injection) and the ingest writes each on its own
 * line as `key: "value"`; quotes are stripped. */
function readYamlField(body, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(
    String(body ?? ""),
  );
  return match ? stripYamlQuotes(match[1].trim()) : "";
}

/**
 * Parse the ingest yaml block for the fields the archive leg needs. The ingest
 * stub (scripts/sentry-triage-ingest.mjs, `METADATA_FIELDS`) always renders
 * `sentry_issue_id`, so `sentryIssueId` is normally the numeric Sentry id
 * directly; `resolveIssueIdFromShortId` is the fallback for a stub that lacks
 * a usable numeric id.
 */
export function parseStubMetadata(body) {
  const permalinkRaw = readYamlField(body, "permalink");
  return {
    shortId: readYamlField(body, "short_id"),
    sentryIssueId: readYamlField(body, "sentry_issue_id"),
    project: readYamlField(body, "project"),
    permalink: isSafeSentryPermalink(permalinkRaw) ? permalinkRaw : null,
  };
}

export function isNumericId(id) {
  return /^\d+$/.test(String(id ?? ""));
}

export const SENTRY_TRIAGE_LABEL = "sentry-triage";

/**
 * True when a stub still carries the exact state the archive leg requires: the
 * queue marker, a human archive approval, AND a verdict label. Checked on the
 * live labels both BEFORE the Sentry mutation and again (on a fresh re-read)
 * immediately before queue settlement, so a concurrent ingest regression-reopen
 * (a separate concurrency group) that sheds these labels can never let a stale
 * human approval drive an archive or close a freshly-reopened stub.
 */
export function stubIsArchivable(labels) {
  const names = Array.isArray(labels) ? labels : [];
  return (
    names.includes(SENTRY_TRIAGE_LABEL) &&
    names.includes(APPROVED_ARCHIVE_LABEL) &&
    names.some((name) => name.startsWith("sentry:verdict-"))
  );
}

/** GitHub logins are `[A-Za-z0-9-]` (≤39 chars). Anything else is not a real
 * login — fall back to a neutral phrase so a malformed value can never inject
 * markup or a mention into the audit comment. No `@` is ever emitted. */
export function sanitizeApprover(login) {
  const v = String(login ?? "").trim();
  return /^[A-Za-z0-9-]{1,39}$/.test(v) ? v : "an authorized user";
}

/** The queue-stub audit comment: a fixed marker line, the approver, a UTC
 * timestamp, what was archived, the permalink, and the escalation-auto-reopen
 * note. `shortId` is neutralized + backtick-defanged as defense in depth even
 * though it is Sentry-assigned; `sentryIssueId` is numeric-validated upstream. */
export function buildAuditComment({
  approver,
  shortId,
  sentryIssueId,
  permalink,
  timestampIso,
  alreadyArchived = false,
}) {
  const safeApprover = sanitizeApprover(approver);
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  const idNote = isNumericId(sentryIssueId) ? ` (id ${sentryIssueId})` : "";
  const action = alreadyArchived
    ? "was already archived in Sentry (archived_until_escalating)"
    : "archived in Sentry as archived_until_escalating";
  const lines = [
    ARCHIVE_COMMENT_MARKER,
    "",
    `**Sentry issue archived** — approved by \`${safeApprover}\` at ${timestampIso}.`,
    "",
    `- Sentry issue \`${safeShortId}\`${idNote} ${action}.`,
  ];
  if (permalink) lines.push(`- [View in Sentry](${permalink})`);
  lines.push(
    "",
    "Never hard-resolved: the issue stays archived only until it escalates. If",
    "it escalates/regresses in Sentry, Stage A's regression-reopen path reopens",
    "this queue stub for fresh triage automatically (ADR 0036) — a fresh archive",
    "would then need a fresh human approval.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Token guard: the write-scoped Sentry token is read from the environment ONLY
// (never a CLI flag, never echoed). The workflow guards on its presence before
// invoking; this fails loud if it is somehow missing.
// ---------------------------------------------------------------------------

export function resolveArchiveToken(env = process.env) {
  const token = env.SENTRY_ARCHIVE_TOKEN;
  if (!token || !token.trim()) {
    throw new Error(
      "SENTRY_ARCHIVE_TOKEN is not set; refusing to run the archive step without a write-scoped Sentry token.",
    );
  }
  return token.trim();
}

// ---------------------------------------------------------------------------
// Sentry REST client (injectable fetch). All calls go to
// `${baseUrl}/api/0${path}` with a bearer token; JSON bodies are stringified.
//
// Endpoint form: the issue detail/update routes are the ORG-SCOPED
// `/api/0/organizations/{org}/issues/{issue_id}/` — the CURRENT documented form
// (verified 2026-07 against docs.sentry.io/api/events/retrieve-an-issue and
// .../update-an-issue). The bare `/api/0/issues/{issue_id}/` is the legacy
// route; both resolve, but we use the documented org-scoped one.
// ---------------------------------------------------------------------------

function sentryRequest(
  fetchImpl,
  { baseUrl, path, method = "GET", token, body },
) {
  const url = `${baseUrl}/api/0${path}`;
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetchImpl(url, init);
}

/**
 * Resolve a Sentry SHORT-ID to its numeric issue id. Verified against the
 * official docs:
 * GET /api/0/organizations/{organization_id_or_slug}/shortids/{short_id}/
 * https://docs.sentry.io/api/organizations/resolve-a-short-id/ — the response
 * carries the numeric id as `groupId` (also `group.id`). Only used when the
 * queue stub lacks a usable numeric `sentry_issue_id`.
 */
export async function resolveIssueIdFromShortId(
  fetchImpl,
  { baseUrl, org, token, shortId },
) {
  const res = await sentryRequest(fetchImpl, {
    baseUrl,
    token,
    method: "GET",
    path: `/organizations/${encodeURIComponent(org)}/shortids/${encodeURIComponent(shortId)}/`,
  });
  if (!res.ok) {
    throw new Error(
      `Sentry short-ID resolution failed: ${res.status} ${res.statusText} (${shortId})`,
    );
  }
  const body = await res.json();
  const id = body?.groupId ?? body?.group?.id;
  const idStr = id == null ? "" : String(id);
  if (!isNumericId(idStr)) {
    throw new Error(
      `Sentry short-ID ${shortId} did not resolve to a numeric issue id (got ${JSON.stringify(id)}).`,
    );
  }
  return idStr;
}

/**
 * Fetch the current Sentry issue (used for the idempotency check).
 * GET /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/
 * https://docs.sentry.io/api/events/retrieve-an-issue/
 */
export async function fetchSentryIssue(
  fetchImpl,
  { baseUrl, org, token, issueId },
) {
  const res = await sentryRequest(fetchImpl, {
    baseUrl,
    token,
    method: "GET",
    path: `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/`,
  });
  if (!res.ok) {
    throw new Error(
      `Sentry issue fetch failed: ${res.status} ${res.statusText} (${issueId})`,
    );
  }
  return res.json();
}

/**
 * A settled no-op requires the EXACT target state: status `ignored` (legacy:
 * `muted`) AND substatus `archived_until_escalating`. Sentry uses `ignored`
 * for other archive modes too — `archived_forever`,
 * `archived_until_condition_met`, and timed ignores — and a missing substatus
 * is likewise unconfirmed. Those must still receive the corrective PUT so the
 * escalation-reopen safety loop the pipeline promises actually holds; otherwise
 * this would close the queue ledger claiming until-escalating semantics while
 * the underlying issue is indefinitely (or conditionally) archived. Biasing
 * toward the PUT is safe — it is idempotent for an already-escalating issue.
 */
export function isAlreadyArchived(issue) {
  const status = String(issue?.status ?? "").toLowerCase();
  const substatus = String(issue?.substatus ?? "").toLowerCase();
  return (
    (status === "ignored" || status === "muted") &&
    substatus === "archived_until_escalating"
  );
}

/**
 * True when Sentry has flagged the issue as a LIVE regression/escalation
 * (unresolved substatus `regressed` or `escalating`). Archiving such an issue
 * would be a "close over the regression": the archive script would close the
 * queue stub AFTER the regression's `lastSeen`, and ingest's reopen gate
 * (`lastSeen` strictly newer than the stub's `closedAt`,
 * scripts/sentry-triage-ingest.mjs `decideDedupAction`) would then permanently
 * skip that already-observed regression until some FURTHER event arrives —
 * burying a real issue. So the archive leg refuses and re-queues instead. This
 * consumes Sentry's own escalation flag; the (rare) window where a regression
 * has landed but Sentry has not yet flipped the substatus is a documented
 * residual, tightened only by full ingest/archive synchronization.
 */
export function isActivelyRegressing(issue) {
  const status = String(issue?.status ?? "").toLowerCase();
  const substatus = String(issue?.substatus ?? "").toLowerCase();
  return (
    status === "unresolved" &&
    (substatus === "regressed" || substatus === "escalating")
  );
}

/** Fixed refusal comment for the live-regression path (no marker — this stub is
 * re-queued, not settled). `shortId` is Sentry-assigned but still neutralized as
 * defense in depth. */
export function buildRegressionRefusalComment(shortId) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    `**Not archived.** The underlying Sentry issue \`${safeShortId}\` currently`,
    "shows a live regression/escalation (new events since triage). Archiving it",
    "now would close this stub over that regression and reset Sentry's escalation",
    "baseline, hiding a real issue. Re-queued for fresh triage instead — a new",
    "human approval is required once it is re-triaged.",
  ].join("\n");
}

/**
 * Archive the issue as `archived_until_escalating` (never a hard resolve).
 * PUT /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/
 * https://docs.sentry.io/api/events/update-an-issue/
 */
export async function archiveIssue(
  fetchImpl,
  { baseUrl, org, token, issueId },
) {
  const res = await sentryRequest(fetchImpl, {
    baseUrl,
    token,
    method: "PUT",
    path: `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/`,
    body: ARCHIVE_PAYLOAD,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // Body already consumed / not text — the status line is enough.
    }
    throw new Error(
      `Sentry archive request failed: ${res.status} ${res.statusText} (${issueId})${
        detail ? ` — ${truncate(detail, 200)}` : ""
      }`,
    );
  }
}

/**
 * Compensation: undo an archive this run performed after a mid-flight
 * regression-reopen made the human approval stale, restoring the issue's
 * captured pre-archive status/substatus.
 *
 * Race-safe: re-fetch first and restore ONLY if the issue is STILL exactly what
 * THIS run wrote (`archived_until_escalating`). If a concurrent escalation or an
 * operator has already moved it (e.g. to `resolved`, or Sentry auto-flipped it
 * to `unresolved` on the regression), leave it untouched — never clobber
 * another actor's transition. A restore failure is loud (throws) so an operator
 * repairs the mismatch. Returns `{ restored, reason }`.
 * PUT /api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/
 * https://docs.sentry.io/api/events/update-an-issue/
 */
export async function restoreArchivedIssue(
  fetchImpl,
  { baseUrl, org, token, issueId, preArchive },
) {
  const fresh = await fetchSentryIssue(fetchImpl, {
    baseUrl,
    org,
    token,
    issueId,
  });
  if (!isAlreadyArchived(fresh)) {
    // Someone/something already moved it off our archive — don't clobber it.
    return { restored: false, reason: "state-changed" };
  }
  const res = await sentryRequest(fetchImpl, {
    baseUrl,
    token,
    method: "PUT",
    path: `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/`,
    body: buildRestorePayload(preArchive),
  });
  if (!res.ok) {
    throw new Error(
      `Sentry restore (compensation) request failed: ${res.status} ${res.statusText} (${issueId})`,
    );
  }
  return { restored: true };
}

/**
 * Best-effort link-back note on the Sentry issue pointing at the queue stub.
 *
 * The Sentry issue-comment ("note") REST endpoint is UNDOCUMENTED in the public
 * API reference (verified 2026-07: no create-issue-note page exists under
 * docs.sentry.io/api). We attempt the conventional
 * `POST /api/0/organizations/{org}/issues/{issue_id}/comments/` shape purely
 * for a human audit trail. A failure here must NEVER fail the run — the archive
 * itself already succeeded — so it is swallowed with a `::notice::`. NEEDS A
 * LIVE TEST AT ACTIVATION to confirm the exact endpoint/payload.
 */
export async function tryPostSentryLinkback(
  fetchImpl,
  { baseUrl, org, token, issueId, shortId, queueIssueUrl },
) {
  try {
    const res = await sentryRequest(fetchImpl, {
      baseUrl,
      token,
      method: "POST",
      path: `/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/comments/`,
      body: {
        text: `Archived (archived_until_escalating) by the Mento Sentry triage pipeline. Queue stub: ${queueIssueUrl}`,
      },
    });
    if (!res.ok) {
      process.stderr.write(
        `::notice::Sentry link-back note on ${shortId} returned ${res.status}; archive already succeeded, continuing.\n`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `::notice::Sentry link-back note on ${shortId} failed (${message}); archive already succeeded, continuing.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// GitHub side effects (via `gh`, mirroring the sibling scripts). `runGh` is
// injectable for tests. All calls use the ambient GH_TOKEN (issues:write on
// this repo) — the Sentry token never touches a gh call.
// ---------------------------------------------------------------------------

function defaultRunGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function readQueueIssue(runGh, repo, number) {
  const stdout = await runGh([
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

/** Self-heal the two archive labels from Stage A's LABEL_DEFINITIONS before use
 * (like the project job does for sentry:projected): this workflow can run
 * before any post-deploy ingest has bootstrapped `sentry:archived`, and
 * `gh issue edit --add-label` errors on a repo-nonexistent label. Best-effort —
 * a failure surfaces loudly at the label-edit step below. */
async function ensureArchiveLabels(runGh, repo) {
  for (const label of LABEL_DEFINITIONS) {
    if (!ARCHIVE_LABEL_NAMES.has(label.name)) continue;
    try {
      await runGh([
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description,
        "-R",
        repo,
        "--force",
      ]);
    } catch (err) {
      process.stderr.write(
        `warning: could not ensure label ${label.name}: ${err.message}\n`,
      );
    }
  }
}

async function settleQueueStub(
  runGh,
  { repo, queueIssue, meta, approver, timestampIso, alreadyArchived },
) {
  // Time-of-check/time-of-use guard (2 of 2). Re-read the LIVE stub immediately
  // before touching it: a concurrent ingest regression-reopen (separate
  // concurrency group) could have reopened the stub and shed its
  // approval/verdict labels during the Sentry I/O that just ran. Closing +
  // marking archived off a stale snapshot would consume a stale human approval
  // and bury a fresh regression. If the required labels are gone, abort the
  // settlement (no queue mutation) and leave the reopened stub for re-triage.
  // Residual: the sub-second window between this re-read and the close/edit is
  // irreducible without cross-workflow serialization (GitHub has no conditional
  // close) — tracked as a follow-up; the OPEN-stub common path is already
  // race-free because ingest only ever reopens a CLOSED match.
  const live = await readQueueIssue(runGh, repo, queueIssue);
  if (!stubIsArchivable(live.labels)) {
    process.stderr.write(
      `::notice::Issue #${queueIssue} lost its sentry-triage + ${APPROVED_ARCHIVE_LABEL} + verdict labels before settlement (a concurrent regression reopen); leaving it for re-triage instead of closing.\n`,
    );
    return { settled: false };
  }

  // Idempotency: a workflow_dispatch retry must not double-post the audit.
  const alreadyAudited = (live.comments ?? []).some(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.includes(ARCHIVE_COMMENT_MARKER),
  );
  if (!alreadyAudited) {
    await runGh([
      "issue",
      "comment",
      String(queueIssue),
      "-R",
      repo,
      "--body",
      buildAuditComment({
        approver,
        shortId: meta.shortId,
        sentryIssueId: meta.sentryIssueId,
        permalink: meta.permalink,
        timestampIso,
        alreadyArchived,
      }),
    ]);
  } else {
    process.stderr.write(
      `::notice::Audit comment already present on issue #${queueIssue}; not re-posting.\n`,
    );
  }

  // Close BEFORE consuming the approval marker. Ordering is load-bearing for
  // crash-safety: if the close fails transiently, `sentry:approved-archive` is
  // still present, so the documented workflow_dispatch retry path stays open
  // (its verdict guard requires that label) and the whole idempotent settle is
  // retried. Removing the approval first (then failing the close) would strand
  // an OPEN terminal stub the retry guard refuses. A stub already CLOSED (a
  // retry, or a previously-verdict-closed stub) skips the close.
  if (live.state !== "CLOSED") {
    await runGh([
      "issue",
      "close",
      String(queueIssue),
      "-R",
      repo,
      "--reason",
      "completed",
    ]);
  }

  // Swap labels LAST: add the terminal marker, drop the approval marker.
  // Idempotent: --add-label no-ops if present, --remove-label no-ops if absent.
  // Once the stub is closed above, even a partial failure here can only leave a
  // CLOSED (settled) stub — never a stranded open one.
  await runGh([
    "issue",
    "edit",
    String(queueIssue),
    "-R",
    repo,
    "--add-label",
    ARCHIVED_LABEL,
    "--remove-label",
    APPROVED_ARCHIVE_LABEL,
  ]);
  return { settled: true };
}

// ---------------------------------------------------------------------------
// Orchestration. Dependency-injectable (`runGh`, `fetchImpl`, `now`) so tests
// drive the full flow with mocked I/O.
// ---------------------------------------------------------------------------

export async function runArchive(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const { repo, org, sentryBaseUrl, queueIssue, approver, sentryToken } =
    options;
  const sentry = { baseUrl: sentryBaseUrl, org, token: sentryToken };

  await ensureArchiveLabels(runGh, repo);

  const stub = await readQueueIssue(runGh, repo, queueIssue);
  const meta = parseStubMetadata(stub.body);
  if (!meta.shortId) {
    throw new Error(
      `Queue issue #${queueIssue} has no parseable Sentry short_id in its body; cannot archive.`,
    );
  }

  // Time-of-check/time-of-use guard (1 of 2). The workflow validated the
  // approval + verdict labels in an earlier step, but a concurrent ingest
  // regression-reopen (a SEPARATE concurrency group) can shed those labels
  // between that guard and this mutation. Re-read the stub's LIVE labels here —
  // as close to the Sentry PUT as practical — and refuse if the queue marker,
  // the human approval, or a verdict label is no longer present, so a
  // regression can never consume a stale human approval. Clean no-op (no Sentry
  // or queue mutation); the reopened stub re-triages via the normal path. A
  // second live re-check runs immediately before queue settlement (see
  // settleQueueStub) to cover a reopen that lands during the Sentry I/O below.
  if (!stubIsArchivable(stub.labels)) {
    process.stderr.write(
      `::notice::Issue #${queueIssue} no longer carries sentry-triage + ${APPROVED_ARCHIVE_LABEL} + a sentry:verdict-* label (state changed since the workflow guard, e.g. a regression reopen); refusing to archive.\n`,
    );
    return {
      issue: queueIssue,
      shortId: meta.shortId,
      status: "skipped-state",
    };
  }

  // Prefer the numeric id the stub already carries; fall back to short-ID
  // resolution only when it is missing/malformed.
  let issueId = meta.sentryIssueId;
  if (!isNumericId(issueId)) {
    issueId = await resolveIssueIdFromShortId(fetchImpl, {
      ...sentry,
      shortId: meta.shortId,
    });
  }

  const current = await fetchSentryIssue(fetchImpl, { ...sentry, issueId });

  // Live-regression guard. If Sentry has flagged the issue as regressed/
  // escalating, DO NOT archive: closing the stub after that regression's
  // lastSeen would make ingest's reopen gate skip it permanently (see
  // isActivelyRegressing). Re-queue the stub for fresh triage instead — shed
  // the SAME label set ingest sheds on a regression reopen (verdicts, the
  // projection marker, and both archive markers — REOPEN_SHED_LABELS, so the
  // two reopen paths can't drift), add sentry:needs-triage, leave it OPEN —
  // so the triage agent re-investigates and a new human approval is required.
  if (isActivelyRegressing(current)) {
    process.stderr.write(
      `::notice::Sentry issue ${meta.shortId} (${issueId}) is a live regression/escalation; refusing to archive over it and re-queuing the stub for triage.\n`,
    );
    await runGh([
      "issue",
      "comment",
      String(queueIssue),
      "-R",
      repo,
      "--body",
      buildRegressionRefusalComment(meta.shortId),
    ]);
    await runGh([
      "issue",
      "edit",
      String(queueIssue),
      "-R",
      repo,
      "--add-label",
      NEEDS_TRIAGE_LABEL,
      "--remove-label",
      REOPEN_SHED_LABELS.join(","),
    ]);
    return {
      issue: queueIssue,
      shortId: meta.shortId,
      sentryIssueId: issueId,
      status: "skipped-regressed",
    };
  }

  // Idempotency: an already-archived Sentry issue is a success (log a notice
  // and skip the redundant PUT); the queue-stub settle still runs.
  const alreadyArchived = isAlreadyArchived(current);
  if (alreadyArchived) {
    process.stderr.write(
      `::notice::Sentry issue ${meta.shortId} (${issueId}) is already archived_until_escalating (${issueId}); treating as success.\n`,
    );
  } else {
    await archiveIssue(fetchImpl, { ...sentry, issueId });
    // Best-effort Sentry link-back (never fails the run — see the function
    // doc). Posted ONLY after a FRESH archive so a workflow_dispatch retry
    // (which finds the issue already archived_until_escalating) does not spam
    // duplicate Sentry notes — the Sentry note has no server-side idempotency
    // marker of its own, so `!alreadyArchived` is its at-most-once gate.
    await tryPostSentryLinkback(fetchImpl, {
      ...sentry,
      issueId,
      shortId: meta.shortId,
      queueIssueUrl: stub.url,
    });
  }

  const settle = await settleQueueStub(runGh, {
    repo,
    queueIssue,
    meta,
    approver,
    timestampIso: now().toISOString(),
    alreadyArchived,
  });

  if (!settle.settled) {
    // A regression reopened the stub during the Sentry I/O, so the human
    // approval is now stale. If WE archived the issue this run, UNDO it —
    // restoring its captured pre-archive state — so the regression stays
    // surfaced in Sentry (the self-correction the pipeline promises) instead of
    // being buried under a stale approval. The restore is race-safe (it only
    // acts if the issue is still exactly what we wrote) and loud on failure. If
    // the issue was already archived before this run, we performed no mutation
    // to revert.
    let restored = false;
    if (!alreadyArchived) {
      const outcome = await restoreArchivedIssue(fetchImpl, {
        ...sentry,
        issueId,
        preArchive: current,
      });
      restored = outcome.restored;
      process.stderr.write(
        restored
          ? `::notice::Reverted our archive of ${meta.shortId} (${issueId}) to its prior state after a mid-flight regression reopen; queue stub left open for re-triage.\n`
          : `::notice::Stub #${queueIssue} reopened mid-flight, but Sentry issue ${issueId} was already moved off archived_until_escalating by another actor; leaving Sentry untouched.\n`,
      );
    } else {
      process.stderr.write(
        `::notice::Queue stub #${queueIssue} was reopened mid-flight; left open for re-triage (Sentry unchanged — already archived before this run).\n`,
      );
    }
    return {
      issue: queueIssue,
      shortId: meta.shortId,
      sentryIssueId: issueId,
      status: restored ? "reverted-reopened" : "unsettled-reopened",
    };
  }

  return {
    issue: queueIssue,
    shortId: meta.shortId,
    sentryIssueId: issueId,
    status: alreadyArchived ? "already-archived" : "archived",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:archive --issue <queue-issue-number> [options]

Archives the Sentry issue behind a human-approved (sentry:approved-archive) queue
stub as archived_until_escalating (never a hard resolve; ADR 0036), leaves an
audit comment, swaps the stub to sentry:archived, and closes it. Prints a
single-line JSON result to stdout; diagnostics/annotations go to stderr.

Options:
  --issue <number>         Queue issue number to settle (positive int; required).
  --approver <login>       GitHub login of the approving human (fallback env
                           ARCHIVE_APPROVER). Rendered into the audit comment.
  --repo <owner/name>      Queue-stub repo (default: ${DEFAULT_REPO}).
  --org <sentry-org>       Sentry organization slug (default: ${DEFAULT_ORG}).
  --sentry-base-url <url>  Sentry API base URL (default: ${DEFAULT_SENTRY_BASE_URL}).
  -h, --help               Show this help.

Env:
  SENTRY_ARCHIVE_TOKEN     Write-scoped Sentry token (Issue & Event: Read+Write)
                           for the archive mutation. Read from env ONLY.
  GH_TOKEN                 Ambient github.token for the queue-stub gh mutations.
`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    repo: DEFAULT_REPO,
    org: DEFAULT_ORG,
    sentryBaseUrl: DEFAULT_SENTRY_BASE_URL,
    queueIssue: null,
    approver: "",
    help: false,
  };
  let cliApprover = null;
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
      case "--approver":
        cliApprover = readValue();
        break;
      case "--repo":
        options.repo = readValue();
        break;
      case "--org":
        options.org = readValue();
        break;
      case "--sentry-base-url":
        options.sentryBaseUrl = readValue();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (
    !options.help &&
    (!Number.isInteger(options.queueIssue) || options.queueIssue <= 0)
  ) {
    throw new Error("--issue must be a positive integer");
  }
  options.approver = (cliApprover ?? env.ARCHIVE_APPROVER ?? "").trim();
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  options.sentryToken = resolveArchiveToken(process.env);
  const result = await runArchive(options);
  // ONLY the JSON result to stdout; diagnostics/annotations went to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
