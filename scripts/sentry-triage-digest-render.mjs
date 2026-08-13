/**
 * Pure Slack-render layer for the Sentry triage digest
 * (scripts/sentry-triage-digest.mjs). Extracted from the digest (checklist
 * split-not-append rule: the digest sat above the 600-line soft cap and the
 * fix_scope architectural grouping adds more) so the digest keeps only the
 * classification / verdict-parse / Slack-payload orchestration / gh-collection /
 * CLI layers.
 *
 * Everything here is a PURE function of an already-classified entry (or of
 * untrusted free text): escaping, formatting, the per-section line renderers, the
 * section taxonomy, and block chunking. No `gh`, no parsing of raw issues, no
 * classification decision — those stay in the digest module. The exported names
 * are stable; the digest and its tests import them directly, no re-export shim.
 *
 * Slack safety lives here (this is the only surface that emits mrkdwn): every
 * free-form value is sanitized, bounded, then Slack-escaped, and `verbatim: true`
 * on each section blocks Slack's auto-linkification of raw `@`/`#` tokens.
 */

import {
  boundBriefList,
  boundBriefText,
  FIX_SCOPE_ARCHITECTURAL,
  selectNeedsHumanBriefFields,
} from "./sentry-triage-project-core.mjs";
import { NEEDS_TRIAGE_LABEL } from "./sentry-triage-ingest.mjs";

// ---------------------------------------------------------------------------
// Section taxonomy. Outcome sections in RENDER order — needs-human FIRST
// (decisions required), then autofixed, routed, the open architectural design
// backlog (#1812), wontfix, and failed last. Empty sections are omitted.
// ---------------------------------------------------------------------------

export const NEEDS_HUMAN_SECTION = "needs-human";
export const AUTOFIXED_SECTION = "autofixed";
export const ROUTED_SECTION = "routed";
export const ARCHITECTURAL_SECTION = "architectural";
export const WONTFIX_SECTION = "wontfix";
export const FAILED_SECTION = "failed";

export const SECTION_ORDER = [
  NEEDS_HUMAN_SECTION,
  AUTOFIXED_SECTION,
  ROUTED_SECTION,
  ARCHITECTURAL_SECTION,
  WONTFIX_SECTION,
  FAILED_SECTION,
];

export const SECTION_TITLES = {
  [NEEDS_HUMAN_SECTION]: "⚠️ Needs human — decisions required",
  [AUTOFIXED_SECTION]: "🤖 Autofixed",
  [ROUTED_SECTION]: "📮 Routed to owning repo",
  [ARCHITECTURAL_SECTION]: "🏗 Open design work — no autofix",
  [WONTFIX_SECTION]: "🙅 Wontfix / transient",
  [FAILED_SECTION]: "🛑 Failed triage",
};

// Hard bound on the summary field we embed. "Truncate hard" mirrors the Stage A
// queue-body defense; also keeps every Slack section well under the 3000-char
// block limit (batch is capped at 10 issues upstream).
const MAX_SUMMARY_LEN = 300;

// The per-field bound for needs-human briefs is NOT defined here: it is
// `MAX_BRIEF_TEXT_LEN` in sentry-triage-project-core.mjs, shared with the queue
// stub's brief COMMENT (#1748) so the two emitters cannot drift. Bounding
// happens BEFORE escaping, so even an all-`<` value expands to at most ~4x =
// 1600 chars — a single brief line stays far under the per-section budget (a
// brief is scannable; full detail lives on the linked queue issue).

// Appended to an OPEN architectural line: this class stays open under
// `sentry:fix-scope-architectural` as human design work, and the autofix leg
// excludes it at query time — the line has to say so, since it renders in its own
// "Open design work" section rather than Routed.
const ARCHITECTURAL_NOTE =
  "_(open under `sentry:fix-scope-architectural` — human design work, no autofix)_";

// A validated URL is later embedded in Slack mrkdwn link syntax (`<url|text>`),
// so `<`, `>`, `|` in the URL would break out of the link. Reject those plus any
// ASCII control char or whitespace.
// eslint-disable-next-line no-control-regex -- rejecting control chars in a link target is the point
export const UNSAFE_URL_CHARS = /[<>|\x00-\x20\x7f]/;

// ---------------------------------------------------------------------------
// Untrusted-text neutralization + Slack escaping.
// ---------------------------------------------------------------------------

/**
 * Slack mrkdwn escape — identical to the main-failure notifier's
 * `gsub("&";"&amp;") | gsub("<";"&lt;") | gsub(">";"&gt;")`. Order matters:
 * `&` first, or the later substitutions corrupt their own output. Escaping
 * `<`/`>` is what makes Slack mention/link control syntax inert.
 */
export function escapeSlackText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Collapse control chars/newlines/tabs to single spaces so an untrusted
 * value stays on one line. Same intent as the ingest's sanitizeFreeText. */
export function sanitizeSummary(text) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars from untrusted agent text is the whole point here
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Sanitize -> hard-truncate -> Slack-escape, in that order (escape last so
 * the byte bound applies to the human-visible text, not the entity soup). */
export function formatSummaryForSlack(text) {
  const clean = sanitizeSummary(text);
  const bounded =
    clean.length > MAX_SUMMARY_LEN
      ? `${clean.slice(0, MAX_SUMMARY_LEN).trimEnd()}…`
      : clean;
  return escapeSlackText(bounded);
}

/** Same sanitize->bound->escape pipeline as formatSummaryForSlack, at the
 * (shorter) brief-field bound. Sanitize+bound come from the shared core so the
 * Slack brief and the queue-issue brief agree; only the escape is Slack's. */
export function formatBriefText(text) {
  return escapeSlackText(boundBriefText(text));
}

/** Render a free-text brief list (hypotheses / investigated) as one escaped,
 * bounded line — items joined with "; " so the whole line still obeys the
 * brief-field bound. Empty in -> "" (the caller omits the line). */
export function formatBriefList(items) {
  return escapeSlackText(boundBriefList(items));
}

// ---------------------------------------------------------------------------
// Per-issue line rendering.
// ---------------------------------------------------------------------------

/** True when a routed entry is a LOCAL `code-fix` scoped `architectural`
 * (issue #1785) — including every verdict that omits `fix_scope`, which fails
 * closed. This is the one class the digest would otherwise misreport outright:
 * a local verdict never projects, the selector will never attempt it (it holds
 * under sentry:fix-scope-architectural, #1812), and the stub stays OPEN as human
 * design work, so this line is the human's Slack view of that backlog. Scoped to
 * the LOCAL owning repo on purpose — an external code-fix also reads as
 * `architectural` (the field is local-only), and annotating those would mislabel
 * every genuinely routed issue. */
export function isArchitecturalLocalCodeFix(entry) {
  return (
    entry?.bucket === "code-fix" &&
    entry?.owningRepoIsLocal === true &&
    entry?.fixScope === FIX_SCOPE_ARCHITECTURAL
  );
}

function issueCountText(total) {
  return `${total} issue${total === 1 ? "" : "s"} triaged`;
}

export function isHttpsUrl(value) {
  const str = String(value);
  if (UNSAFE_URL_CHARS.test(str)) return false;
  try {
    return new URL(str).protocol === "https:";
  } catch {
    return false;
  }
}

/** `<url|text>` only for a trusted https URL; otherwise the escaped text. */
export function link(url, text) {
  return isHttpsUrl(url) ? `<${url}|${text}>` : text;
}

/** The linked, escaped SHORT-ID + escaped project, shared by every per-issue
 * line. Links to the queue issue by default; needs-human overrides the link
 * target to the Sentry permalink (via `linkUrl`, falling back to the queue
 * issue when no permalink was recorded). */
export function idAndProject(entry, { linkUrl } = {}) {
  const idText = escapeSlackText(entry.shortId);
  const url = linkUrl ?? entry.url;
  const linked = isHttpsUrl(url) ? `<${url}|${idText}>` : idText;
  // A Sentry SHORT-ID is prefixed with the project's short name, which for
  // every current project is the upper-cased slug — `GOVERNANCE-MENTO-ORG-5H`
  // in `governance-mento-org`. Rendering both says it twice. Sentry lets a
  // project's slug and short name diverge (a slug rename does not rewrite
  // existing short-ids), so this drops the repeat only when it IS a repeat and
  // keeps the project whenever it would otherwise be lost.
  const project = escapeSlackText(entry.project);
  const redundant =
    project &&
    String(entry.shortId ?? "")
      .toUpperCase()
      .startsWith(`${project.toUpperCase()}-`);
  // A ready-to-render SUFFIX, not a bare value: every renderer used to wrap
  // this in parentheses unconditionally, so returning "" for the redundant case
  // produced `ID ()` — punctuation where the repeat used to be. Owning the
  // parentheses here makes that shape unrepresentable.
  const shown = redundant ? "" : project;
  return { linked, project: shown, projectSuffix: shown ? ` (${shown})` : "" };
}

/** A needs-human decision-ready brief: a level-1 bullet for the issue, then
 * level-2 sub-bullets for whatever context is present. Decision is always
 * shown (placeholder if somehow absent — the label step requires it);
 * hypotheses / investigated / why-escalated render only when present. The id
 * links straight to the Sentry issue (falling back to the queue issue when no
 * permalink was recorded) — the queue issue stays reachable via the Links
 * sub-bullet.
 *
 * Deliberately NOT rendered here: `how_to_check` and `decision_branches`
 * (#1748). Those are the instruction half of the brief, and the surface a
 * person acts on is the queue issue this line links to — Slack is the nudge.
 * They still flow through the shared selection below, so adding them to this
 * digest later is a render change, not a contract change. */
export function renderNeedsHumanBrief(entry) {
  const { linked } = idAndProject(entry, {
    linkUrl: entry.sentryPermalink || entry.url,
  });
  const confidence = entry.confidence ?? "unknown";
  const lines = [`• *${linked}* · confidence: ${confidence}`];

  // Shared selection + bound (sentry-triage-project-core.mjs); only the Slack
  // escape below is this emitter's own.
  const fields = selectNeedsHumanBriefFields(entry);

  const decision = fields.question
    ? escapeSlackText(fields.question)
    : "_(no decision recorded — re-triage)_";
  lines.push(`    ◦ *Decision needed:* ${decision}`);

  const hypotheses = formatBriefList(fields.hypotheses);
  if (hypotheses) lines.push(`    ◦ *Hypotheses:* ${hypotheses}`);

  const investigated = formatBriefList(fields.investigated);
  if (investigated) lines.push(`    ◦ *Already investigated:* ${investigated}`);

  if (fields.escalationReason) {
    lines.push(
      `    ◦ *Why escalated:* ${escapeSlackText(fields.escalationReason)}`,
    );
  }

  const linkParts = [];
  if (isHttpsUrl(entry.url)) linkParts.push(link(entry.url, "queue issue"));
  if (entry.sentryPermalink) {
    linkParts.push(link(entry.sentryPermalink, "Sentry"));
  }
  if (linkParts.length) lines.push(`    ◦ *Links:* ${linkParts.join(" · ")}`);
  return lines;
}

/** Shared one-liner for Autofixed / Routed: `• <id> (<project>) — <summary> →
 * <arrow>`, where <arrow> is the linked outcome (fix PR / owning-repo issue /
 * queue-verdict fallback). */
export function renderArrowLine(entry, arrowUrl, arrowLabel) {
  const { linked, projectSuffix } = idAndProject(entry);
  const summary = entry.summary
    ? formatSummaryForSlack(entry.summary)
    : "_(no summary)_";
  return `• ${linked}${projectSuffix} — ${summary} → ${link(arrowUrl, arrowLabel)}`;
}

export function renderWontfixLine(entry) {
  const { linked, projectSuffix } = idAndProject(entry);
  const confidence = entry.confidence ?? "unknown";
  const summary = entry.summary
    ? formatSummaryForSlack(entry.summary)
    : "_(no summary)_";
  // The SHORT-ID links the queue issue, which holds the verdict comment (the
  // rationale). Confidence is LABELLED, not a bare parenthetical: on its own
  // `(medium)` reads as part of the summary sentence rather than as the agent's
  // self-assessment of its own verdict.
  return `• ${linked}${projectSuffix} — ${summary} [confidence: ${confidence}]`;
}

export function renderFailedLine(entry) {
  const { linked, projectSuffix } = idAndProject(entry);
  return `• ${linked}${projectSuffix} — triage incomplete (still \`${NEEDS_TRIAGE_LABEL}\`)`;
}

/** One OPEN architectural line: the routed arrow shape (owning-repo issue when
 * one exists, else the queue-verdict fallback) plus the architectural note. The
 * whole class renders in its OWN section (operator resolution #3), so the note
 * names the open-under-label state rather than implying it was routed. */
export function renderArchitecturalLine(entry) {
  const line = entry.projectedUrl
    ? renderArrowLine(entry, entry.projectedUrl, "owning-repo issue")
    : renderArrowLine(entry, entry.url, "triage verdict");
  return `${line} ${ARCHITECTURAL_NOTE}`;
}

/** The body lines for one section (excluding its header), one line per entry.
 * needs-human is NOT handled here — its multi-line briefs are atomic groups
 * and go through chunkBriefs (see buildDigest) so a brief never splits across
 * Slack blocks mid-entry. */
export function renderSectionBodyLines(section, entries) {
  switch (section) {
    case AUTOFIXED_SECTION:
      return entries.map((entry) =>
        renderArrowLine(entry, entry.autofixUrl, "fix PR"),
      );
    case ROUTED_SECTION:
      return entries.map((entry) =>
        entry.projectedUrl
          ? renderArrowLine(entry, entry.projectedUrl, "owning-repo issue")
          : // Projection skipped (no token / local / unrecognized repo): fall
            // back to the queue-issue verdict.
            renderArrowLine(entry, entry.url, "triage verdict"),
      );
    case ARCHITECTURAL_SECTION:
      return entries.map(renderArchitecturalLine);
    case WONTFIX_SECTION:
      return entries.map(renderWontfixLine);
    case FAILED_SECTION:
      return entries.map(renderFailedLine);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Slack block chunking.
// ---------------------------------------------------------------------------

// Slack caps a text object at 3000 chars; escape expansion (`<` -> `&lt;`,
// `&` -> `&amp;`) means several worst-case summaries/briefs would blow past it
// in one section, and chat.postMessage would reject the whole payload with
// `invalid_blocks`. Budget per section, with headroom under the hard cap.
export const MAX_SECTION_TEXT_LEN = 2800;

export function mrkdwnSection(text) {
  // verbatim: true disables Slack's automatic parsing of this text object
  // (defense in depth on top of escapeSlackText): raw `@everyone` / `#channel`
  // strings in user-controlled text can otherwise be auto-linkified into live
  // mentions by layout-block parsing. The explicit `<url|label>` links and
  // `*bold*` markup we emit are mrkdwn markup, not auto-parsing, and still render.
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

/** Greedily pack already-escaped lines into newline-joined chunks that each
 * stay within `maxLen` (a single oversized line gets its own chunk — with the
 * bounded summary/brief fields a rendered line stays well under the Slack cap). */
export function chunkLines(lines, maxLen = MAX_SECTION_TEXT_LEN) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    const extra = line.length + (current.length > 0 ? 1 : 0); // +1 for "\n"
    if (current.length > 0 && currentLen + extra > maxLen) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen += extra;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Chunk the needs-human section at ENTRY boundaries: each brief (one entry's
 * line group) is ATOMIC — it never shares a block boundary mid-entry, so a
 * reader can never see half a brief in one Slack block and the rest in the
 * next. The section header leads the first chunk; briefs within a chunk are
 * separated by a blank line (same rendering as before). A single brief longer
 * than the budget gets its own block(s) — split at line granularity via
 * chunkLines, still never interleaved with another entry.
 */
export function chunkBriefs(headerLine, briefs, maxLen = MAX_SECTION_TEXT_LEN) {
  const chunks = [];
  let current = headerLine;
  const flush = () => {
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
  };
  for (const lines of briefs) {
    const text = lines.join("\n");
    if (text.length > maxLen) {
      // Oversized single entry: its own block(s), never packed with others.
      flush();
      chunks.push(...chunkLines(lines, maxLen));
      continue;
    }
    // "\n" between the header and the first brief; a blank line between briefs.
    const sep = current === "" ? "" : current === headerLine ? "\n" : "\n\n";
    if (current !== "" && current.length + sep.length + text.length > maxLen) {
      flush();
    }
    const sepAfterFlush =
      current === "" ? "" : current === headerLine ? "\n" : "\n\n";
    current = `${current}${sepAfterFlush}${text}`;
  }
  flush();
  return chunks;
}

export { issueCountText, ARCHITECTURAL_NOTE };
