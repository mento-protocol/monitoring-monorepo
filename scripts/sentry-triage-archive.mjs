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
  parseArchiveBaseline,
  REOPEN_SHED_LABELS,
  truncateTitle,
  withArchiveBaseline,
} from "./sentry-triage-ingest.mjs";
import {
  ARCHIVE_COMMENT_MARKER,
  isTrustedComment,
} from "./sentry-triage-project-core.mjs";

const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_ORG = "mento-labs";
export const DEFAULT_SENTRY_BASE_URL = "https://us.sentry.io";

// Fixed marker line on the queue-stub audit comment; part of the idempotency key
// that stops a workflow_dispatch retry from double-posting the audit note (see
// isSettledAuditComment, which also scopes on the archive generation). Only this
// module reads or writes it — ingest takes the baseline from the stub BODY and
// has no comment reader at all.
export { ARCHIVE_COMMENT_MARKER };

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

// Same URL-shape guard the digest and ingest apply (issue #1586): reject `<`,
// `>`, `|` — which would break out of a Slack/Markdown link target — plus any
// ASCII control char or whitespace. `new URL()` accepts all of them in the
// path/query and this validator returns the RAW input string, so the shape
// check must run on the original — not on the re-encoded `parsed.href`.
// eslint-disable-next-line no-control-regex -- rejecting control chars in a link target is the point
const UNSAFE_URL_CHARS = /[<>|\x00-\x20\x7f]/;

export function isSafeSentryPermalink(url) {
  const value = String(url);
  if (UNSAFE_URL_CHARS.test(value)) return false;
  try {
    const parsed = new URL(value);
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

/** Bound + neutralize a value before it renders into the audit note or a refusal
 * comment, then quote it — same treatment the ingest gives its own yaml scalars,
 * which is where the name comes from. */
function yamlScalar(value) {
  return JSON.stringify(truncateTitle(neutralizeUntrusted(value), 90));
}

/** The baseline as it renders inside the audit note. `isSettledAuditComment`
 * matches on this exact token to scope its dedup to one archive generation, so
 * the emitter and the matcher must share it — a drift between them would either
 * double-post every audit or suppress every one. */
function auditBaselineToken(baselineLastSeen) {
  return `\`${yamlScalar(baselineLastSeen ?? "")}\``;
}

/** The queue-stub audit comment: a fixed marker line, the approver, a UTC
 * timestamp, what was archived, the permalink, the freshness baseline in prose,
 * and the escalation-auto-reopen note. `shortId` is neutralized +
 * backtick-defanged as defense in depth even though it is Sentry-assigned;
 * `sentryIssueId` is numeric-validated upstream.
 *
 * This note is for HUMANS. Nothing machine-readable lives here: the baseline
 * ingest actually consumes is written into the stub BODY (see the body write in
 * settleQueueStub), because the triage agent can post comments under this same
 * bot identity and so no fence applied to a comment is worth anything. The
 * rendered baseline does carry one machine use, but only within this module —
 * `isSettledAuditComment` matches it to scope the note's dedup to one archive
 * generation. */
export function buildAuditComment({
  approver,
  shortId,
  sentryIssueId,
  permalink,
  timestampIso,
  alreadyArchived = false,
  baselineLastSeen = null,
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
  // The baseline renders as prose for a human skimming the stub. The
  // machine-readable copy ingest actually reads lives in the issue BODY — a
  // comment cannot hold it, because the triage LLM can post comments under this
  // same bot identity (see isSettledAuditComment).
  lines.push(
    `- Freshness baseline recorded in the issue body: ${auditBaselineToken(baselineLastSeen)}.`,
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
 * consumes Sentry's own escalation flag; the window where a regression has
 * landed but Sentry has not yet flipped the substatus is covered separately by
 * the freshness baseline (`lastSeenMoved` below plus the baseline recorded in
 * the stub BODY), since the flag alone lags the event.
 */
export function isActivelyRegressing(issue) {
  const status = String(issue?.status ?? "").toLowerCase();
  const substatus = String(issue?.substatus ?? "").toLowerCase();
  return (
    status === "unresolved" &&
    (substatus === "regressed" || substatus === "escalating")
  );
}

/**
 * True when a Sentry event landed inside the archive's mutation window: the
 * `lastSeen` read back after the PUT is strictly newer than the one read before
 * it. Sentry's `substatus` lags a fresh event, so this timestamp comparison —
 * not `isActivelyRegressing` — is what catches an event that arrived while the
 * archive ran (issue #1371).
 *
 * Strictly a comparison: an unparsable side is not a move, so this returns
 * false. That is NOT a decision to proceed. Both call sites gate parsability
 * themselves and refuse — `isUsableBaseline` before the PUT, an explicit
 * `Date.parse` check on the read-back after it — because an unusable baseline
 * sends ingest back to the `closedAt` comparison this mechanism replaces.
 */
export function lastSeenMoved(baseline, latest) {
  const baselineMs = Date.parse(baseline ?? "");
  const latestMs = Date.parse(latest ?? "");
  if (Number.isNaN(baselineMs) || Number.isNaN(latestMs)) return false;
  return latestMs > baselineMs;
}

/** A baseline is usable only when it is a real date. Anything else would land
 * in the stub body as junk, and ingest's `decideDedupAction` would silently fall
 * back to comparing against `closedAt` — the exact race the baseline closes. So
 * an unusable baseline gates the mutation instead of riding along. */
export function isUsableBaseline(lastSeen) {
  return !Number.isNaN(Date.parse(lastSeen ?? ""));
}

/**
 * True when `comment` is THIS pipeline's settled audit comment for the Sentry
 * issue being archived — the at-most-once key for the audit post.
 *
 * This governs a HUMAN-READABLE note only. The machine-readable baseline lives
 * in the stub body (scripts/sentry-triage-ingest.mjs, `withArchiveBaseline`),
 * because the Stage B triage agent is an LLM reading attacker-controlled Sentry
 * payloads and holds `Bash(gh issue comment <its stub>:*)` — so it can post a
 * comment under the trusted Actions identity, on the right stub, with any
 * content it likes. No fence applied to a comment survives that. Keeping the
 * baseline out of comments means the worst a forged marker comment can now do is
 * suppress a duplicate audit note; it cannot change any decision.
 *
 * The author + marker + id checks stay anyway: they cost nothing and keep a
 * drive-by from suppressing the note on a stub it does not even name.
 */
export function isSettledAuditComment(comment, { sentryIssueId, baseline }) {
  if (!isTrustedComment(comment)) return false;
  const body = comment?.body;
  if (typeof body !== "string" || !body.startsWith(ARCHIVE_COMMENT_MARKER)) {
    return false;
  }
  if (!body.includes(`(id ${String(sentryIssueId ?? "")})`)) return false;
  // Scope to THIS archive, not to the Sentry issue. A stub can be archived,
  // regress, be reopened by ingest (which keeps its comments), be re-triaged and
  // re-approved, and archived again — at which point the previous archive's
  // marker and issue id both still match, and keying on those alone suppressed
  // the new audit, losing the new approver, timestamp and disposition. The
  // freshness baseline advances with every genuine re-archive (a regression
  // implies a newer event), so it is the generation token; a true retry of the
  // SAME archive carries the same baseline and still dedups.
  return body.includes(auditBaselineToken(baseline));
}

/** What the compensation actually did, for the human reading the stub.
 * `restoreArchivedIssue` deliberately no-ops when another actor already moved
 * the issue off our archive, so a refusal comment must never assert a revert
 * that did not happen — and it must say so loudly, since that branch leaves
 * Sentry in a state nobody on this run chose. */
function describeRestore(restored) {
  return restored
    ? "The archive was reverted."
    : "The archive could NOT be reverted: Sentry had already moved the issue off `archived_until_escalating`, so this run left its state alone. Check the Sentry issue.";
}

/** Fixed refusal comment for the fresh-event path (no marker — this stub is not
 * settled). `shortId` is Sentry-assigned but still neutralized as defense in
 * depth. */
export function buildFreshEventRefusalComment(shortId, restored = true) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    `**Not archived.** A new Sentry event for \`${safeShortId}\` landed while the`,
    `archive was running. ${describeRestore(restored)} Closing this stub over an`,
    "event Sentry has not yet flagged would hide it: the close would postdate the",
    "event and the regression-reopen gate would never fire for it. The stub stays",
    "open and the `sentry:approved-archive` approval was removed; archiving again",
    "needs a fresh human approval once the new activity has been triaged.",
  ].join("\n");
}

/** Fixed refusal comment for a Sentry `lastSeen` that does not parse BEFORE the
 * mutation. Nothing is mutated on this path, so the stub keeps its approval and
 * stays re-dispatchable. */
export function buildMissingBaselineRefusalComment(shortId) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    `**Not archived.** Sentry returned no usable \`lastSeen\` for \`${safeShortId}\`,`,
    "so this run cannot record the freshness baseline the archive depends on.",
    "Without it the regression-reopen gate falls back to comparing against this",
    "stub's close time, and any event landing while the archive runs would be",
    "hidden permanently. Nothing was changed in Sentry or on this stub; re-run",
    "the archive once Sentry reports the issue normally.",
  ].join("\n");
}

/** Fixed refusal comment for a `lastSeen` that stops parsing AFTER the mutation.
 * Deliberately distinct from the fresh-event comment: we do not know an event
 * landed, only that we can no longer prove none did. */
export function buildUnreadableFreshnessRefusalComment(
  shortId,
  restored = true,
) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    "**Not archived.** Sentry stopped reporting a usable `lastSeen` for",
    `\`${safeShortId}\` immediately after the archive, so this run cannot confirm`,
    "that no event landed while it ran. The field parsed moments earlier, so the",
    `read-back is anomalous. ${describeRestore(restored)} The stub stays open and`,
    "the `sentry:approved-archive` approval was removed; re-approve once Sentry",
    "reports the issue normally.",
  ].join("\n");
}

/** Fixed refusal comment for a re-approval over an archive the stub records no
 * bound baseline for. Nothing was mutated on this path. */
export function buildUnbaselinedRetryRefusalComment(shortId, observed) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    `**Not archived.** \`${safeShortId}\` is already archived in Sentry, but this`,
    "stub records no freshness baseline for it — so there is nothing to compare",
    `its current last event (${yamlScalar(observed ?? "")}) against.`,
    "",
    "Recording that timestamp now would adopt it as the baseline and hide",
    "everything that arrived since the archive: an archived issue matches neither",
    "ingest query, so the reopen gate would never fire for those events. There is",
    "no trustworthy value to reconstruct the baseline from, so nothing was",
    "changed and the `sentry:approved-archive` label was removed.",
    "",
    "Un-archive the Sentry issue and let it re-triage. That puts it back in front",
    "of ingest, and the next archive records a baseline it can stand behind.",
  ].join("\n");
}

/** Fixed refusal comment for a re-approval over an archive whose recorded
 * baseline Sentry has already moved past. Nothing was mutated on this path. */
export function buildStaleRetryRefusalComment(shortId, recorded, observed) {
  const safeShortId = truncateTitle(neutralizeUntrusted(shortId), 90);
  return [
    `**Not archived.** \`${safeShortId}\` is already archived in Sentry, and its`,
    `last event (${yamlScalar(observed ?? "")}) is newer than the freshness`,
    `baseline this stub recorded (${yamlScalar(recorded ?? "")}). Settling now`,
    "would stamp the newer timestamp as the baseline, and the reopen gate would",
    "then never fire for the event in between — it would be archived and",
    "invisible to both ingest queries, which only match unresolved issues.",
    "",
    "Nothing was changed, and the `sentry:approved-archive` label was removed.",
    "Re-applying it will refuse again — the recorded baseline is still older and",
    "the issue is still archived, so nothing about the comparison changes.",
    "",
    "Un-archive the Sentry issue instead. That puts it back in front of ingest,",
    "which re-queues it for triage, and the approval that follows records a",
    "baseline covering the newer activity.",
  ].join("\n");
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

/** Outcomes where the archive stands and the ledger is settled. Everything else
 * — refusals, unsettled reopens, throws — must leave the approval spent. */
const CLEAN_ARCHIVE_STATUSES = new Set(["archived", "already-archived"]);

/** True when Sentry may be holding this run's archive, so a spendable approval
 * would let a retry re-baseline over it. `rejected` means Sentry answered and
 * refused (nothing archived, nothing to disarm); `not-attempted` never issued a
 * PUT, and those paths deliberately keep the approval re-dispatchable. */
export function sentryMayBeArchived(archiveState) {
  return (
    archiveState === "confirmed" ||
    archiveState === "pre-existing" ||
    archiveState === "unknown"
  );
}

/**
 * True only when Sentry ANSWERED and declined — a 4xx, where the server
 * evaluated the request and refused it, so the mutation definitely did not
 * apply.
 *
 * A 5xx is NOT a rejection. Sentry may have applied the PUT before its server
 * or proxy failed, so the outcome is ambiguous and must be `unknown`, which
 * routes through `sentryMayBeArchived` and spends the approval. Transport
 * errors, timeouts and aborted sockets produce no status line at all and are
 * likewise unknown. Reading any error as proof the mutation did not happen is
 * the same false inference this whole area was rebuilt to remove; it survived
 * here longest because this is the one place that classifies an error rather
 * than reacting to live state.
 */
export function isDefiniteRejection(err) {
  return /^Sentry archive request failed: 4\d{2}\b/.test(
    err instanceof Error ? err.message : "",
  );
}

/** A `gh api -X DELETE .../labels/<name>` that 404s means the label is no
 * longer on the issue — the only realistic 404 here, since the issue and repo
 * were both read successfully moments earlier. */
export function isNotFoundError(err) {
  return /HTTP 404|Not Found/i.test(err instanceof Error ? err.message : "");
}

/**
 * Compare-and-swap on the human approval marker: delete
 * `sentry:approved-archive` and report whether THIS run was the one that
 * removed it. Returns false on 404 — someone else already consumed it, which in
 * practice means ingest's regression reopen shed it (REOPEN_SHED_LABELS) — and
 * rethrows anything else so a real API failure stays loud.
 *
 * `gh api -X DELETE` rather than `gh issue edit --remove-label`: the latter
 * swallows the 404 and exits 0, which is exactly the observation this CAS needs.
 * The label name goes into the path unencoded — `:` and `-` are legal path
 * characters and the name is a module constant, never user input.
 */
async function consumeApprovalLabel(runGh, repo, queueIssue) {
  try {
    await runGh([
      "api",
      "-X",
      "DELETE",
      `repos/${repo}/issues/${queueIssue}/labels/${APPROVED_ARCHIVE_LABEL}`,
    ]);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/**
 * True when the stub still looks exactly like THIS run settled it: closed,
 * carrying the queue marker, its verdict, and `sentry:archived`. The approval is
 * deliberately absent — settlement consumed it.
 *
 * Read AFTER the settlement writes, because ingest's regression reopen does not
 * need `sentry:approved-archive` to run: `buildReopenLabelEditArgs` only
 * `--remove-label`s it, which no-ops once this run's CAS took it. So a reopen
 * can complete entirely inside the settlement window, and the close would then
 * land on a stub ingest just reopened for a live regression. Any of the three
 * signals catches it whichever order the two runs interleave — the reopen sheds
 * every verdict label AND `sentry:archived` (REOPEN_SHED_LABELS) and flips the
 * state — so this is robust to all of them, not just the tidy one.
 */
export function settlementHeld({ state, labels, body } = {}, expected = null) {
  const names = Array.isArray(labels) ? labels : [];
  const shapeHolds =
    String(state ?? "").toUpperCase() === "CLOSED" &&
    names.includes(SENTRY_TRIAGE_LABEL) &&
    names.includes(ARCHIVED_LABEL) &&
    names.some((name) => name.startsWith("sentry:verdict-"));
  if (!shapeHolds || !expected) return shapeHolds;
  // The baseline is the thing this whole change exists to guarantee, so the
  // verification read must not be the one place that skips it. A body write can
  // report success and still leave the baseline absent or wrong — an authorised
  // body edit racing between the write and this check — and state-and-labels
  // alone would call that settled, reporting success on a closed
  // `sentry:archived` stub whose body sends ingest straight back to `closedAt`.
  const recorded = parseArchiveBaseline(body);
  return (
    !!recorded &&
    recorded.lastSeen === String(expected.lastSeen ?? "") &&
    recorded.sentryIssueId === String(expected.sentryIssueId ?? "")
  );
}

/**
 * Roll the QUEUE STUB back to the state observed before this run started
 * mutating, by RECONCILING against live state rather than replaying a log of
 * what we believe we did.
 *
 * The distinction is the whole point. Every earlier version of this compensation
 * inferred what had happened from which line threw, and that inference is false
 * whenever a request succeeds server-side and its response is lost: `gh issue
 * close` can close the stub and then fail. A did-we-close flag is unset in
 * exactly that case, so the repair skipped the reopen and left a CLOSED stub
 * without `sentry:archived` — back on the `closedAt` fallback, invisibly. A
 * rejected command is not proof its remote mutation did not happen.
 *
 * So: re-read the stub, compare against `target` (the pre-mutation OBSERVATION,
 * not a record of our intentions), and issue only the corrections live state
 * actually calls for. Idempotent by construction — a second run finds nothing to
 * correct — and safe to call on any failure path, including ones where nothing
 * was written.
 *
 * SENTRY IS DELIBERATELY NOT ROLLED BACK HERE. Automation may only ever set
 * `archived_until_escalating` (ADR 0036), which is self-healing: escalation
 * resurfaces the issue on its own. A settlement that failed after the PUT
 * therefore leaves Sentry in exactly the state a SUCCESSFUL archive would have
 * produced — the state a human already approved. Reverting it bought nothing and
 * cost a check-then-PUT race against Sentry's own transitions, where the GET can
 * still read `archived_until_escalating` while Sentry is concurrently flipping a
 * freshly-escalated issue to `unresolved/regressed`; the PUT then erases that
 * regression signal, and since ingest finds old issues only through
 * `is:regressed`, the event vanishes from both systems. Removing the revert
 * removes that failure mode instead of guarding it.
 *
 * Returns a report; the caller decides how loud to be. Never throws on a
 * mismatch it cannot fix: it reports, so the original error stays the headline.
 */
/** The baseline a body carries, as a comparable scalar. Two bodies with the same
 * baseline are equivalent for reconciliation even if they differ elsewhere. */
function baselineOf(body) {
  const parsed = parseArchiveBaseline(body);
  return parsed ? `${parsed.lastSeen}|${parsed.sentryIssueId}` : "";
}

export async function reconcileToTarget(
  { runGh },
  { repo, queueIssue, target },
) {
  const report = { queue: null, converged: true, errors: [] };

  // `target` is absent only when this run never read the stub inside
  // settlement, which means it never wrote to it either — that is a fact about
  // the code path, not an inference about a remote call.
  if (!target) {
    report.queue = "untouched";
    return report;
  }

  let live;
  try {
    live = await readQueueIssue(runGh, repo, queueIssue);
  } catch (err) {
    report.converged = false;
    report.errors.push(
      `Queue re-read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return report;
  }

  const corrections = [];
  // Body: restore the exact pre-mutation baseline whenever its VALUE changed,
  // not merely when the target had none. A re-approved stub already carries a
  // baseline from its previous archive, and a failed run would otherwise leave
  // its newer timestamp behind — which, on a stub that still carries
  // `sentry:archived`, ingest trusts, and a regression predating that timestamp
  // is then skipped.
  //
  // Detect on the parsed baseline, and WRITE by rebuilding just those two fields
  // on top of the LIVE body. Writing back the whole snapshot would erase any
  // unrelated edit made after it — a human correcting the permalink, say — which
  // is a silent data loss the detection was already careful to avoid causing.
  if (
    typeof target.body === "string" &&
    baselineOf(live.body) !== baselineOf(target.body)
  ) {
    const restoredBody = withArchiveBaseline(
      live.body,
      parseArchiveBaseline(target.body),
    );
    if (restoredBody === null) {
      // No yaml block live to rebuild into. Fall back to the snapshot rather
      // than leave a wrong baseline standing, and say so.
      process.stderr.write(
        `::warning::Issue #${queueIssue} has no parseable yaml block to rebuild its baseline into; restoring the pre-run body wholesale, which discards any concurrent body edit.\n`,
      );
    }
    corrections.push({
      what: "body",
      args: [
        "issue",
        "edit",
        String(queueIssue),
        "-R",
        repo,
        "--body",
        restoredBody ?? target.body,
      ],
    });
  }
  // Terminal marker: remove it if present now and absent in the target.
  if (live.labels.includes(ARCHIVED_LABEL) && !target.hadArchivedLabel) {
    corrections.push({
      what: "archived-label",
      args: [
        "issue",
        "edit",
        String(queueIssue),
        "-R",
        repo,
        "--remove-label",
        ARCHIVED_LABEL,
      ],
    });
  }
  // State: reopen only if it is closed NOW and was open in the target. This is
  // the correction the did-we-close flag used to miss on a lost close response.
  if (live.state === "CLOSED" && target.state !== "CLOSED") {
    corrections.push({
      what: "reopen",
      args: ["issue", "reopen", String(queueIssue), "-R", repo],
    });
  }

  // Correction errors are PROVISIONAL, not verdicts. A corrective write can be
  // accepted and still lose its response — the very ambiguity this reconciler
  // exists to handle — so a rejection here proves nothing about the final state.
  // The authoritative read below decides. Letting the catch decide turned
  // successful recoveries into red runs telling operators to repair by hand.
  const provisional = [];
  for (const correction of corrections) {
    try {
      await runGh(correction.args);
    } catch (err) {
      provisional.push(
        `Queue ${correction.what} correction reported failure: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  report.queue = corrections.length
    ? corrections.map((c) => c.what).join("+")
    : "already-consistent";

  // --- Verify ------------------------------------------------------------
  // The single source of truth for `converged`.
  if (corrections.length) {
    try {
      const after = await readQueueIssue(runGh, repo, queueIssue);
      const stillWrong = [];
      if (baselineOf(after.body) !== baselineOf(target.body))
        stillWrong.push("body baseline still diverges");
      if (after.labels.includes(ARCHIVED_LABEL) && !target.hadArchivedLabel)
        stillWrong.push(`still labeled ${ARCHIVED_LABEL}`);
      if (after.state === "CLOSED" && target.state !== "CLOSED")
        stillWrong.push("still closed");
      if (stillWrong.length) {
        report.converged = false;
        report.errors.push(
          `Queue still diverges: ${stillWrong.join(", ")}`,
          ...provisional,
        );
      } else if (provisional.length) {
        // Reported failure, confirmed success: the writes landed and their
        // responses were lost. Worth a line, not a red run.
        process.stderr.write(
          `::notice::Queue rollback of #${queueIssue} reported errors the verification read disproved (${provisional.join(
            "; ",
          )}); the final state matches the target.\n`,
        );
      }
    } catch (err) {
      // Cannot confirm, so cannot claim convergence.
      report.converged = false;
      report.errors.push(
        `Queue verification read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ...provisional,
      );
    }
  }

  return report;
}

/**
 * How this run left Sentry, stated only as far as it actually knows. The
 * summary line is what the runbook tells operators to trust, so it must never
 * assert "archived" on a run whose PUT was rejected or never issued.
 */
export function describeSentryDisposition(archiveState, issueId) {
  switch (archiveState) {
    case "pre-existing":
    case "confirmed":
      return `Sentry issue ${issueId} stays archived_until_escalating by design (ADR 0036): that is the approved outcome and it self-heals on escalation.`;
    case "rejected":
      return `Sentry issue ${issueId} was NOT archived — the update was rejected, so there is no Sentry change to undo.`;
    case "unknown":
      return `Sentry issue ${issueId} is in an UNKNOWN state: the archive request did not complete cleanly, so it may or may not have applied. Read the issue before acting on it.`;
    default:
      return `Sentry issue ${issueId} was never touched by this run.`;
  }
}

/** One line naming what the queue was observed to hold and what this run knows
 * about Sentry, so the runbook's recovery entry has something real to point at. */
function reportReconciliation(
  report,
  { queueIssue, shortId, issueId, why, archiveState },
) {
  const sentry = describeSentryDisposition(archiveState, issueId);
  if (report.converged) {
    process.stderr.write(
      `::notice::Rolled the queue stub #${queueIssue} / ${shortId} back after ${why} — queue: ${report.queue}. ${sentry}\n`,
    );
    return;
  }
  process.stderr.write(
    `::error::Queue rollback of #${queueIssue} / ${shortId} after ${why} did NOT converge (${
      report.queue ?? "unknown"
    }): ${report.errors.join("; ")}. ${sentry} Fix the stub by hand.\n`,
  );
}

async function settleQueueStub(
  runGh,
  {
    repo,
    queueIssue,
    meta,
    sentryIssueId,
    approver,
    timestampIso,
    alreadyArchived,
    baselineLastSeen,
    onTarget,
  },
) {
  // This function no longer compensates. It publishes its pre-mutation
  // OBSERVATION via `onTarget` and lets every failure propagate to runArchive's
  // single reconciling catch, which rolls both systems back against LIVE state.
  // Nothing here records what we believe we did, because a rejected command is
  // not proof its remote mutation did not happen — `gh issue close` can close
  // the stub and then fail, and every did-we-close flag is wrong in exactly that
  // case.

  // Time-of-check/time-of-use guard (2 of 2). Re-read the LIVE stub immediately
  // before touching it: a concurrent ingest regression-reopen (separate
  // concurrency group) could have reopened the stub and shed its
  // approval/verdict labels during the Sentry I/O that just ran. Closing +
  // marking archived off a stale snapshot would consume a stale human approval
  // and bury a fresh regression. If the required labels are gone, abort the
  // settlement (no queue mutation) and leave the reopened stub for re-triage.
  // This read is a cheap pre-check only; the authoritative ones are the CAS
  // below and the post-settlement verification after it.
  const live = await readQueueIssue(runGh, repo, queueIssue);
  onTarget?.({
    state: live.state,
    body: live.body,
    hadArchivedLabel: live.labels.includes(ARCHIVED_LABEL),
  });
  if (!stubIsArchivable(live.labels)) {
    process.stderr.write(
      `::notice::Issue #${queueIssue} lost its sentry-triage + ${APPROVED_ARCHIVE_LABEL} + verdict labels before settlement (a concurrent regression reopen); leaving it for re-triage instead of closing.\n`,
    );
    return { settled: false };
  }

  // Consume the approval marker FIRST, as an observable compare-and-swap
  // (issue #1371). The re-read above is a snapshot; between it and the close
  // there is no conditional-close primitive, so a reopen landing in that window
  // used to close a stub ingest had just reopened for a fresh regression. The
  // approval label is the single token both writers contend for — ingest's
  // reopen sheds it, this delete consumes it — so whoever's delete returns 404
  // lost, and losing here aborts settlement and runs the same compensation as
  // the label-shed path above.
  //
  // The previous ordering closed the stub before consuming the marker so a
  // failed label step could not leave an approved-but-open stub that re-triggers
  // the `issues: labeled` workflow. That property survives inverted: if the CAS
  // succeeds and the close then fails, the stub is open WITHOUT the approval
  // label, so nothing re-triggers.
  //
  // Be precise about what that leaves behind — no automation picks it up. The
  // stub is OPEN, so ingest's dedup skips it ("already open"); it keeps its
  // verdict label and never regains `sentry:needs-triage`, so the triage agent's
  // selector skips it too; and the approval is spent, so workflow_dispatch
  // refuses it. It sits there until a human re-approves. That is the accepted
  // cost of not silently burying a live regression, and it is bounded: the run
  // fails RED and the queue side is rolled back. Sentry deliberately stays
  // archived_until_escalating — the outcome the approver asked for, which
  // escalation undoes on its own (see reconcileToTarget).
  if (!(await consumeApprovalLabel(runGh, repo, queueIssue))) {
    process.stderr.write(
      `::notice::Issue #${queueIssue} no longer carried ${APPROVED_ARCHIVE_LABEL} when settlement tried to consume it (a concurrent regression reopen won the race); leaving it for re-triage instead of closing.\n`,
    );
    return { settled: false };
  }

  // Past the CAS this run holds a partial commit: the approval marker is gone,
  // so a workflow_dispatch retry can no longer re-drive the settlement (its
  // guard needs that label). Any failure from here rolls the QUEUE back — see
  // reconcileToTarget, which deliberately leaves Sentry archived. The sharpest
  // case is a close that SUCCEEDS and the terminal `sentry:archived` edit that
  // then fails: that leaves a CLOSED stub whose `closedAt` postdates any event
  // from the archive window, so ingest compares against `closedAt` and buries it
  // — issue #1371, reinstated silently. Reopening such a stub is the correction
  // the reconciler makes from observed state.

  // Write the freshness baseline into the stub BODY first, before anything
  // marks the stub settled. Ordering is the invariant: a stub that is CLOSED
  // and carries `sentry:archived` must always have a baseline ingest can read,
  // or ingest silently drops to the `closedAt` comparison for it.
  //
  // The body — not a comment — because the Stage B triage agent is an LLM
  // reading attacker-controlled Sentry payloads and holds
  // `Bash(gh issue comment <its stub>:*)`, so anything it writes clears an
  // author fence, a marker fence, and an id fence alike. It has no tool that
  // edits a body (its allowlist is Read/Grep/Glob plus three scoped `gh issue`
  // subcommands), and this deterministic zero-LLM step is the only writer that
  // ever rewrites one. Refuse rather than settle if the body has no yaml block
  // to extend: a body this cannot parse is one ingest cannot read back.
  const nextBody = withArchiveBaseline(live.body, {
    lastSeen: baselineLastSeen,
    sentryIssueId,
  });
  if (!nextBody) {
    throw new Error(
      `Queue issue #${queueIssue} has no parseable yaml block in its body; refusing to settle an archive whose freshness baseline could not be recorded.`,
    );
  }
  await runGh([
    "issue",
    "edit",
    String(queueIssue),
    "-R",
    repo,
    "--body",
    nextBody,
  ]);

  // A stub already CLOSED (a retry, or a previously-verdict-closed stub) skips
  // the close. Nothing records that we closed it — `target.state` already says
  // what it was, and the reconciler compares that against live state, which is
  // the only thing a lost close response cannot lie about.
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

  // Terminal marker LAST. Idempotent: --add-label no-ops if already present.
  await runGh([
    "issue",
    "edit",
    String(queueIssue),
    "-R",
    repo,
    "--add-label",
    ARCHIVED_LABEL,
  ]);

  // Post-settlement verification. Winning the CAS bought exclusivity on the
  // APPROVAL, not on the stub: ingest's reopen sheds that label with a
  // `--remove-label` that simply no-ops once we took it, so its whole reopen
  // sequence can still complete inside this window. Everything above ran off
  // the pre-CAS snapshot, so without this read the close lands on a stub
  // ingest just reopened for a live regression and we return settled — Sentry
  // archived, regression buried, no compensation. Re-read and check the state
  // we should have produced.
  const verify = await readQueueIssue(runGh, repo, queueIssue);
  if (
    !settlementHeld(verify, {
      lastSeen: baselineLastSeen,
      sentryIssueId,
    })
  ) {
    process.stderr.write(
      `::notice::Issue #${queueIssue} did not hold the settled shape after settlement (state=${verify.state}, labels=${verify.labels.join("|")}, baseline=${JSON.stringify(parseArchiveBaseline(verify.body))}); a concurrent regression reopen or body edit landed inside the settlement window.\n`,
    );
    // The caller's reconciler rolls the queue stub back against live state.
    return { settled: false };
  }

  // Audit note LAST, after everything failure-prone has converged. Posting it
  // earlier meant a comment could land, the close or the label write then fail,
  // and a stale comment would claim the issue was archived — after which a later
  // successful re-approval saw the marker, suppressed the real audit, and left
  // the durable record showing the FAILED attempt's approver, timestamp and
  // baseline. Ordering removes that; tracking-and-deleting the comment would
  // just be more compensation, which is the thing this whole change is moving
  // away from.
  //
  // Deliberately best-effort: the settlement is already correct and verified, so
  // a failed note must not roll back a legitimate archive. The machine-readable
  // record lives in the body; this is the human-facing one.
  const alreadyAudited = (verify.comments ?? []).some((comment) =>
    isSettledAuditComment(comment, {
      sentryIssueId,
      baseline: baselineLastSeen,
    }),
  );
  if (alreadyAudited) {
    process.stderr.write(
      `::notice::Audit comment already present on issue #${queueIssue}; not re-posting.\n`,
    );
  } else {
    try {
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
          sentryIssueId,
          permalink: meta.permalink,
          timestampIso,
          alreadyArchived,
          baselineLastSeen,
        }),
      ]);
    } catch (err) {
      process.stderr.write(
        `::warning::Issue #${queueIssue} settled correctly but its audit note could not be posted (${
          err instanceof Error ? err.message : String(err)
        }); the machine-readable baseline is in the issue body.\n`,
      );
    }
  }
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
  // Freshness baseline (issue #1371): the last event Sentry had recorded when
  // this run decided to archive. It is re-checked after the PUT and written into
  // the stub BODY, where ingest's regression-reopen gate reads it instead of the
  // stub's `closedAt`.
  const baselineLastSeen = current?.lastSeen ?? null;

  // Fail CLOSED on an unusable baseline, BEFORE any mutation. Archiving without
  // one would record junk in the stub body, ingest would silently fall back
  // to the `closedAt` comparison, and the race this baseline closes would be
  // wide open again — invisibly, because nothing downstream can tell a missing
  // baseline from a stub archived before the contract existed. Refuse instead:
  // no Sentry PUT, no queue mutation (the approval label survives, so the stub
  // stays re-dispatchable), comment + exit 0 like the other policy refusals.
  if (!isUsableBaseline(baselineLastSeen)) {
    process.stderr.write(
      `::notice::Sentry returned no parsable lastSeen for ${meta.shortId} (${issueId}); refusing to archive without a freshness baseline (ingest would fall back to closedAt and could bury a regression).\n`,
    );
    await runGh([
      "issue",
      "comment",
      String(queueIssue),
      "-R",
      repo,
      "--body",
      buildMissingBaselineRefusalComment(meta.shortId),
    ]);
    return {
      issue: queueIssue,
      shortId: meta.shortId,
      sentryIssueId: issueId,
      status: "skipped-no-baseline",
    };
  }

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
    // Re-queuing means nothing while the stub is CLOSED. The triage selector
    // filters on `--state open` (.github/workflows/sentry-triage-agent.yml), and
    // ingest leaves a closed stub alone whenever this occurrence's `lastSeen` is
    // not newer than the later `closedAt` — so a stub Stage B already closed
    // would sit closed wearing `sentry:needs-triage`, seen by nothing, over a
    // regression we KNOW is live. Decide from observed state rather than from
    // what this run assumes: re-read and reopen only if it is closed now.
    //
    // Reopen LAST, matching ingest's reopen ordering: the state change is what
    // makes the stub selectable, so if the label edit above had failed we want
    // it still closed and the whole idempotent sequence retried, rather than
    // open without `sentry:needs-triage`.
    const liveStub = await readQueueIssue(runGh, repo, queueIssue);
    if (liveStub.state === "CLOSED") {
      process.stderr.write(
        `::notice::Reopening closed stub #${queueIssue} so the live regression is visible to triage.\n`,
      );
      await runGh(["issue", "reopen", String(queueIssue), "-R", repo]);
    }
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

  // What this run KNOWS about Sentry, so the summary line never asserts an
  // archive that a rejected PUT never made. "unknown" is a real answer and the
  // only honest one when the request did not complete cleanly.
  let archiveState = alreadyArchived ? "pre-existing" : "not-attempted";

  // THE RULE, in one place: while Sentry may be archived, no exit other than a
  // clean success may leave `sentry:approved-archive` spendable. A stale
  // approval is the load-bearing hazard behind every finding in this area — an
  // archive that cannot be silently retried is recoverable, one that can is not,
  // because the retry takes the already-archived path and stamps its own read
  // time as the baseline, absorbing whatever landed in between. Enforced below
  // at exactly two points (the catch, and a post-condition on the returned
  // status) so a path added later inherits it without remembering to.
  const disarmApproval = async () => {
    try {
      await runGh([
        "issue",
        "edit",
        String(queueIssue),
        "-R",
        repo,
        "--remove-label",
        APPROVED_ARCHIVE_LABEL,
      ]);
      return true;
    } catch (err) {
      // A reported failure is not proof the label survived — GitHub can remove
      // it and lose the response, the same ambiguity the queue reconciler exists
      // to handle, and this was the last path exempt from it. Verify against
      // live labels: gone means the disarm succeeded whatever the CLI said, and
      // reporting failure there would demand manual repair of a state that had
      // already converged.
      const reported = err instanceof Error ? err.message : String(err);
      try {
        const live = await readQueueIssue(runGh, repo, queueIssue);
        if (!live.labels.includes(APPROVED_ARCHIVE_LABEL)) {
          process.stderr.write(
            `::notice::Shedding ${APPROVED_ARCHIVE_LABEL} from #${queueIssue} reported an error (${reported}) that the live labels disprove; the approval is gone.\n`,
          );
          return true;
        }
      } catch (readErr) {
        process.stderr.write(
          `::notice::Could not re-read #${queueIssue} to confirm the approval label (${
            readErr instanceof Error ? readErr.message : String(readErr)
          }); treating the disarm as failed.\n`,
        );
      }
      process.stderr.write(
        `::error::Could not shed ${APPROVED_ARCHIVE_LABEL} from #${queueIssue} after a failed archive (${reported}); a workflow_dispatch retry could re-archive and re-baseline over an untriaged event. Remove the label by hand.\n`,
      );
      return false;
    }
  };

  // Pre-mutation observation of the stub, filled in by settleQueueStub's own
  // pre-CAS read. Stays null if settlement never got that far, which is a fact
  // about the code path (no queue write can precede that read), not a guess.
  let settleTarget = null;
  const reconcile = async (why) => {
    const report = await reconcileToTarget(
      { runGh },
      { repo, queueIssue, target: settleTarget },
    );
    reportReconciliation(report, {
      queueIssue,
      shortId: meta.shortId,
      issueId,
      why,
      archiveState,
    });
    return report;
  };

  // From the archive PUT to the end of settlement, EVERY failure reconciles.
  // The PUT is inside deliberately: a lost response leaves the issue archived
  // while the call rejects, and the old shape skipped compensation in exactly
  // that case — then a dispatch retry took the `alreadyArchived` path and
  // re-baselined off retry-time `lastSeen`, absorbing the window's events.
  const perform = async () => {
    // A retry over an existing archive must NOT re-stamp the baseline.
    // Queue-only rollback leaves Sentry archived and the runbook tells the
    // operator to re-approve, so this path is the normal recovery — and stamping
    // the retry-time `lastSeen` would absorb any event that arrived after the
    // FIRST run's freshness read while Sentry's substatus still lagged. Ingest
    // would then skip that event when the regression finally surfaces.
    //
    // A visible refusal is the whole mechanism, and it needs no bookkeeping. It
    // lives inside `perform` so its refusals exit through the shared
    // post-condition rather than carrying a disarm of their own.
    //
    // ABSENT and STALE both refuse. Absent is the complement the stale check
    // alone left open: when a run archives Sentry and then fails before writing
    // the body baseline, rollback deliberately leaves none, and the runbook
    // permits re-approving. On that retry there is nothing to compare against,
    // and initialising a baseline from the retry's own read would absorb every
    // event that arrived between the first archive and the re-approval — which
    // ingest never reopens for, since it cannot see an archived issue at all.
    // There is no trustworthy value to reconstruct one from; that is exactly why
    // refusing is right. A baseline naming a different Sentry issue is not this
    // issue's evidence either, so it counts as absent.
    //
    // With a bound baseline in hand only two cases remain: equal, where
    // re-stamping is a no-op, or newer, which IS the untriaged event. (Older
    // would mean a stale read replica; stamping the older value only makes
    // ingest reopen more eagerly, the safe direction.)
    if (alreadyArchived) {
      const recordedBaseline = parseArchiveBaseline(stub.body);
      const bound =
        !!recordedBaseline &&
        isUsableBaseline(recordedBaseline.lastSeen) &&
        recordedBaseline.sentryIssueId === String(issueId);
      if (!bound) {
        process.stderr.write(
          `::notice::Sentry issue ${meta.shortId} (${issueId}) is already archived but stub #${queueIssue} records no freshness baseline bound to it; refusing rather than initialising one from this run's read, which would absorb anything that arrived since the archive.\n`,
        );
        await runGh([
          "issue",
          "comment",
          String(queueIssue),
          "-R",
          repo,
          "--body",
          buildUnbaselinedRetryRefusalComment(meta.shortId, current?.lastSeen),
        ]);
        return {
          issue: queueIssue,
          shortId: meta.shortId,
          sentryIssueId: issueId,
          status: "skipped-unbaselined-retry",
        };
      }
      if (lastSeenMoved(recordedBaseline.lastSeen, current?.lastSeen)) {
        process.stderr.write(
          `::notice::Sentry issue ${meta.shortId} (${issueId}) is already archived and its lastSeen (${current?.lastSeen}) has moved past the baseline this stub recorded (${recordedBaseline.lastSeen}); refusing to re-stamp a newer baseline over an untriaged event.\n`,
        );
        await runGh([
          "issue",
          "comment",
          String(queueIssue),
          "-R",
          repo,
          "--body",
          buildStaleRetryRefusalComment(
            meta.shortId,
            recordedBaseline.lastSeen,
            current?.lastSeen,
          ),
        ]);
        return {
          issue: queueIssue,
          shortId: meta.shortId,
          sentryIssueId: issueId,
          status: "skipped-stale-retry",
        };
      }
    }

    if (alreadyArchived) {
      process.stderr.write(
        `::notice::Sentry issue ${meta.shortId} (${issueId}) is already archived_until_escalating (${issueId}); treating as success.\n`,
      );
    } else {
      // Record what we learn from the PUT. Only a 4xx means Sentry evaluated the
      // request and refused it, so nothing was archived; a 5xx, a timeout or a
      // dropped socket leaves it genuinely unknown, because the write may have
      // landed and only the response been lost.
      try {
        await archiveIssue(fetchImpl, { ...sentry, issueId });
        archiveState = "confirmed";
      } catch (err) {
        archiveState = isDefiniteRejection(err) ? "rejected" : "unknown";
        throw err;
      }

      // Post-mutation freshness re-check (issue #1371). Sentry's substatus lags a
      // fresh event, so the guard above can pass while an event is already in
      // flight. Read `lastSeen` back once: if it moved, an event landed inside the
      // mutation window — settling now would close the stub after that event and
      // the regression-reopen gate would never fire for it. Revert and refuse
      // (comment + exit 0; a policy refusal is not a failed run).
      // A THROWN read-back is the same refusal as an unparsable one, and for a
      // sharper reason. `fetchSentryIssue` throws on any non-2xx or transport
      // error; letting that propagate would exit here with the issue archived and
      // the approval still live, so the documented workflow_dispatch retry walks
      // straight into the `alreadyArchived` branch and records the RETRY-time
      // `lastSeen` as its baseline — silently absorbing whatever landed during the
      // failed run's window. Catch it and refuse through the same path.
      let afterLastSeen = null;
      let readbackError = null;
      try {
        const after = await fetchSentryIssue(fetchImpl, { ...sentry, issueId });
        afterLastSeen = after?.lastSeen ?? null;
      } catch (err) {
        readbackError = err instanceof Error ? err.message : String(err);
      }
      // An unreadable read-back is ALSO a refusal, not a "nothing moved". The
      // field parsed a moment ago (the pre-PUT gate proved it), so a malformed one
      // now is anomalous and cannot establish that no event landed. Separate from
      // the moved case so the two reasons stay distinguishable in the logs.
      const unreadable =
        readbackError !== null || !isUsableBaseline(afterLastSeen);
      if (unreadable || lastSeenMoved(baselineLastSeen, afterLastSeen)) {
        // No disarm here: this returns a non-clean status, so the single
        // post-condition at the end of runArchive sheds the approval, and the
        // catch sheds it if the restore below throws first. Verdict labels stay
        // — this is a freshness refusal, not a Sentry-declared regression, so
        // the stub needs a fresh approval rather than a full re-triage.
        let outcome = { restored: false };
        let restoreError = null;
        try {
          outcome = await restoreArchivedIssue(fetchImpl, {
            ...sentry,
            issueId,
            preArchive: current,
          });
        } catch (err) {
          restoreError = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `::error::Refusing the archive of ${meta.shortId} (${issueId}), but the revert FAILED (${restoreError}); the Sentry issue is left archived_until_escalating and needs a manual check.\n`,
          );
        }
        const disposition = outcome.restored
          ? "reverted the archive"
          : "left Sentry untouched (another actor had already moved the issue off archived_until_escalating)";
        process.stderr.write(
          unreadable
            ? `::notice::Could not confirm Sentry's lastSeen for ${meta.shortId} (${issueId}) after the archive PUT (${readbackError ?? "unparsable value"}); cannot establish that no event landed, so ${disposition} and left the stub open.\n`
            : `::notice::A Sentry event for ${meta.shortId} (${issueId}) landed during the archive (lastSeen ${baselineLastSeen} -> ${afterLastSeen}); ${disposition} and left the stub open.\n`,
        );
        // Best effort: the labels and the Sentry state above carry the meaning.
        try {
          await runGh([
            "issue",
            "comment",
            String(queueIssue),
            "-R",
            repo,
            "--body",
            unreadable
              ? buildUnreadableFreshnessRefusalComment(
                  meta.shortId,
                  outcome.restored,
                )
              : buildFreshEventRefusalComment(meta.shortId, outcome.restored),
          ]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `::notice::Could not post the refusal comment on #${queueIssue} (${message}); the label and Sentry state are already correct.\n`,
          );
        }
        // Exit 0 only when the compensation actually completed. A refusal whose
        // own cleanup half-failed is an operational failure, not a policy
        // outcome. (The approval half is enforced by the post-condition.)
        if (restoreError !== null) {
          throw new Error(
            `Archive refused for #${queueIssue} (${meta.shortId}) but compensation was incomplete; Sentry revert failed: ${restoreError}.`,
          );
        }
        return {
          issue: queueIssue,
          shortId: meta.shortId,
          sentryIssueId: issueId,
          status: `${outcome.restored ? "reverted" : "unreverted"}-${
            unreadable ? "unreadable-freshness" : "fresh-events"
          }`,
        };
      }

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
      sentryIssueId: issueId,
      approver,
      timestampIso: now().toISOString(),
      alreadyArchived,
      baselineLastSeen,
      onTarget: (t) => {
        settleTarget = t;
      },
    });

    if (!settle.settled) {
      // A regression reopened the stub during the Sentry I/O — observed at the
      // pre-settlement re-read, by losing the approval-marker CAS, or by the
      // post-settlement verification. Roll the QUEUE back; Sentry stays
      // archived_until_escalating, which is what the human approved and what
      // escalation undoes on its own.
      const report = await reconcile("concurrent regression reopen");
      if (!report.converged) {
        throw new Error(
          `Stub #${queueIssue} was reopened mid-flight and the queue rollback did not converge: ${report.errors.join("; ")}`,
        );
      }
      return {
        issue: queueIssue,
        shortId: meta.shortId,
        sentryIssueId: issueId,
        status: "unsettled-reopened",
      };
    }

    return {
      issue: queueIssue,
      shortId: meta.shortId,
      sentryIssueId: issueId,
      status: alreadyArchived ? "already-archived" : "archived",
    };
  };

  let result;
  try {
    result = await perform();
  } catch (err) {
    // Rule enforcement point 1 of 2. Runs BEFORE the reconcile so a reconciler
    // that itself throws cannot leave the approval live. This is what covers a
    // failure that never reached settlement at all — the first
    // `readQueueIssue` throwing after the PUT, say — where no target was ever
    // captured and nothing else in the run would have disarmed anything.
    if (sentryMayBeArchived(archiveState)) await disarmApproval();
    // Reconcile, then rethrow the ORIGINAL error — it is the diagnostic an
    // operator needs first, and the run fails either way. A bug in the
    // reconciler must never mask it.
    try {
      await reconcile("settlement failure");
    } catch (reconcileErr) {
      process.stderr.write(
        `::error::Queue rollback of #${queueIssue} itself threw (${
          reconcileErr instanceof Error
            ? reconcileErr.message
            : String(reconcileErr)
        }); check the stub by hand.\n`,
      );
    }
    throw err;
  }

  // Rule enforcement point 2 of 2: the exits that RETURN rather than throw.
  // Every refusal and every unsettled outcome passes through here, so no path
  // carries its own disarm and none can forget to.
  if (!CLEAN_ARCHIVE_STATUSES.has(result.status)) {
    if (sentryMayBeArchived(archiveState) && !(await disarmApproval())) {
      throw new Error(
        `Archive for #${queueIssue} (${meta.shortId}) ended as ${result.status} but ${APPROVED_ARCHIVE_LABEL} could not be shed; a retry could re-archive over an untriaged event.`,
      );
    }
  }
  return result;
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
