/**
 * Projected-issue rendering for the Sentry triage pipeline (ADR 0038): the
 * owning-repo issue body/title, the duplicate-coalescing alias comment, and the
 * idempotency back-link marker + its structural matchers.
 *
 * Split out of `sentry-triage-project-core.mjs` (#1769) to keep that file under
 * the 1,000-line hard cap in docs/pr-checklists/recurring-review-patterns.md. It
 * is a MOVE, not a rewrite: `sentry-triage-project-core.mjs` re-exports every
 * name here, so no importer or test changed. This module sits ABOVE the
 * lowest-layer helpers (`sentry-triage-text.mjs`) and imports NOTHING from the
 * verdict contract, so re-exporting it from the contract cannot create a cycle.
 *
 * Security posture: every free-text field is fenced + `neutralizeBlock`-bounded
 * (600 chars / 8 lines, backticks defanged) so agent-derived Sentry text can
 * never render live markdown or close the fence early; SHORT-IDs are
 * shape-validated (`isValidShortId`) before they enter a marker or search query;
 * the back-link marker is only ever accepted at its fixed structural position
 * (the body's leading marker block / the alias comment's first line), never via
 * a broad substring search that a rendered field could satisfy.
 */

import {
  isValidShortId,
  neutralizeBlock,
  neutralizeUntrusted,
  sanitizeDuplicateIds,
  truncate,
} from "./sentry-triage-text.mjs";

const FOOTER =
  "Filed by the Mento Sentry triage pipeline (ADR 0036 / ADR 0038 — verdict " +
  "projection). Machine-filed from a triage verdict; advisory only, so confirm " +
  "the root cause in Sentry before acting. The HTML comment marker at the top " +
  "keys automatic de-duplication — please keep it.";

// ---------------------------------------------------------------------------
// Idempotency marker + back-link matchers.
// ---------------------------------------------------------------------------

export function buildProjectionMarker(shortId) {
  return `<!-- sentry-projection:v1 ${shortId} -->`;
}

const MARKER_LINE_PATTERN = /^<!-- sentry-projection:v1 (\S+) -->$/;

/**
 * The SHORT-IDs in the body's LEADING marker block: consecutive
 * `<!-- sentry-projection:v1 … -->` lines at the very top of the body (after
 * optional leading blanks) — buildProjectedBody emits exactly one, and the
 * block form tolerates future multi-marker bodies. The first non-blank
 * non-marker line ends the block, so a marker-shaped sequence embedded in a
 * rendered free-text field further down can never register.
 */
export function leadingProjectionMarkers(body) {
  const markers = [];
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      if (markers.length === 0) continue; // leading blanks before the block
      break; // blank after the block ends it (our own format)
    }
    const match = MARKER_LINE_PATTERN.exec(line);
    if (!match || !isValidShortId(match[1])) break;
    markers.push(match[1]);
  }
  return markers;
}

/**
 * True when `body` is a genuine projection back-link for `shortId`. Markers
 * are only accepted at their fixed structural position — the leading marker
 * block — never via a broad substring search: a marker-shaped sequence
 * embedded in a rendered free-text field of an UNRELATED projected issue
 * must not satisfy the idempotency check for a different SHORT-ID (which
 * would close that stub as "reused" without filing anything). Rendered
 * fields additionally defang `<!--` (defangHtmlComments) so such a sequence
 * cannot survive rendering intact in the first place. Coalesced duplicates
 * are matched separately via projector-authored alias COMMENTS
 * (commentBacklinksShortId below).
 */
export function bodyBacklinksShortId(body, shortId) {
  if (!isValidShortId(shortId)) return false;
  return leadingProjectionMarkers(body).includes(shortId);
}

/**
 * Build the duplicate-coalescing ALIAS COMMENT: the marker anchored as the
 * comment's first line (the authoritative alias predicate,
 * commentBacklinksShortId) followed by a visible note carrying the SHORT-ID,
 * the footer phrase, and the queue-stub back-link (so the search pre-filter —
 * which matches visible text — finds the aliased id) — PLUS the new
 * occurrence's full rendered verdict fields. The verdict contract defines
 * `duplicate_of` as a same-culprit/message FAMILY signal, not a confirmed
 * exact duplicate, so coalescing must not discard the new finding's
 * substance: the summary/root cause/proposed action land here (neutralized
 * and bounded exactly like the projected body), and the note invites the team
 * to split the entry into its own issue if it is actually distinct.
 *
 * An alias is a COMMENT, never a body edit, deliberately: comment creation is
 * an atomic APPEND, so two parallel matrix jobs coalescing different
 * SHORT-IDs onto the same issue can never lose each other's alias the way
 * concurrent read-modify-write body edits could (GitHub has no conditional
 * body update to CAS against). It is also the ONLY coalescing side effect, so
 * a partial failure can never strand a half-recorded alias. `shortId` is
 * shape-validated, `verdict`/`confidence` are closed enums, and
 * `queueIssueUrl` is a trusted GitHub-API/self-built URL.
 */
// Fixed lead-in of the alias comment's visible note. Shared with the entry
// module's dedicated alias search (`"<prefix> <shortId>" in:comments`) so the
// searchable phrase and the rendered text can never drift apart.
export const ALIAS_NOTE_PREFIX = "Also tracking Sentry";

export function buildAliasComment({
  shortId,
  queueIssueUrl,
  verdict,
  confidence,
  summary,
  rootCause,
  proposedAction,
}) {
  return [
    buildProjectionMarker(shortId),
    "",
    `${ALIAS_NOTE_PREFIX} \`${shortId}\` — the Mento Sentry triage pipeline ` +
      "marked it a duplicate of this issue's underlying error (same " +
      "culprit/message family; if it is actually distinct, split it into its " +
      "own issue). " +
      `Queue stub: ${queueIssueUrl}`,
    "",
    `**Triage verdict:** \`${verdict}\`${confidence ? ` (confidence: \`${confidence}\`)` : ""}`,
    "",
    "**Summary**",
    "",
    fencedBlock(summary),
    "",
    "**Root cause**",
    "",
    fencedBlock(rootCause),
    "",
    "**Proposed action**",
    "",
    fencedBlock(proposedAction),
  ].join("\n");
}

/** True when a COMMENT is a genuine alias record for `shortId`: the marker
 * must be the comment's first non-empty line (the caller additionally
 * verifies the comment author is the projector identity). */
export function commentBacklinksShortId(commentBody, shortId) {
  if (!isValidShortId(shortId)) return false;
  const first = String(commentBody ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  return first !== undefined && first.trim() === buildProjectionMarker(shortId);
}

// ---------------------------------------------------------------------------
// Projected-issue rendering.
// ---------------------------------------------------------------------------

export function buildProjectedTitle(summary) {
  const clean = neutralizeUntrusted(summary);
  const base = clean || "(no summary provided)";
  return `Sentry: ${truncate(base, 200)}`;
}

// Every free-text field the body/alias renders — summary INCLUDED — goes
// through this fenced, inert treatment: fencing is what stops markdown
// (images, task lists, links, inline HTML) from rendering live in the
// owning-repo issue, and neutralizeBlock bounds it (600 chars / 8 lines) and
// defangs backticks so the fence can't be closed early. Everything else is
// already bounded: title caps at 200, duplicates at 20 shape-validated
// SHORT-IDs, shortId at 120, verdict/confidence are closed enums, and the
// permalink is a Stage-A-bounded validated URL.
function fencedBlock(text) {
  const body = neutralizeBlock(text);
  if (!body) return "_(none provided)_";
  return ["```text", body, "```"].join("\n");
}

/**
 * Build the projected owning-repo issue body. `shortId`, `verdict`,
 * `confidence` are validated/closed-set (safe as inline code); `permalink` is a
 * validated https sentry.io URL; `queueIssueUrl` is a trusted github.com URL
 * built from the workflow's own repo/issue. Every other field is agent-derived
 * and neutralized before it lands here.
 */
export function buildProjectedBody({
  shortId,
  verdict,
  confidence,
  summary,
  rootCause,
  proposedAction,
  duplicateOf,
  permalink,
  queueIssueUrl,
}) {
  const dupIds = sanitizeDuplicateIds(duplicateOf);
  const dupText = dupIds.length
    ? dupIds.map((id) => `\`${id}\``).join(", ")
    : "none";

  const parts = [
    buildProjectionMarker(shortId),
    "",
    "> Filed automatically by the Mento **Sentry triage pipeline** from an agent triage verdict.",
    "> Verdict fields only — no raw Sentry payload is copied here. Confirm in Sentry before acting.",
    "",
    `**Sentry issue:** \`${shortId}\``,
    `**Triage verdict:** \`${verdict}\`${confidence ? ` (confidence: \`${confidence}\`)` : ""}`,
    "",
    "**Summary**",
    "",
    fencedBlock(summary),
    "",
    "**Root cause**",
    "",
    fencedBlock(rootCause),
    "",
    "**Proposed action**",
    "",
    fencedBlock(proposedAction),
    "",
    `**Possible duplicate Sentry issues:** ${dupText}`,
    "",
    "**Links**",
    "",
  ];
  if (permalink) parts.push(`- [View the error in Sentry](${permalink})`);
  parts.push(`- Central triage queue stub: ${queueIssueUrl}`);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push(FOOTER);
  parts.push("");
  return parts.join("\n");
}
