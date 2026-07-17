#!/usr/bin/env node
/**
 * Observability leg of the Sentry triage pipeline (ADR 0036,
 * docs/adr/0036-sentry-triage-pipeline.md): a deterministic, no-LLM collector
 * that turns one triage-agent run's batch into a single Slack digest payload.
 * The digest is OUTCOME-oriented (issue #1355): a reader must know in two
 * seconds what was handled and what needs them. Sections render in this order,
 * empty ones omitted, with the counts header kept:
 *
 *   1. ⚠️  Needs human — decisions required   (FIRST + visually distinct: each
 *      item is a decision-ready brief — the exact question, the agent's
 *      hypotheses, what was investigated, why it was escalated, plus links).
 *   2. 🤖 Autofixed                            (renders ONLY when fix-PR data
 *      exists — see the #1278 emission interface below).
 *   3. 📮 Routed to owning repo                (code/config-fix verdicts, each
 *      linking the PROJECTED owning-repo issue; falls back to the queue-issue
 *      verdict when projection was skipped).
 *   4. 🙅 Wontfix / transient                  (upstream-transient verdicts,
 *      each linking the rationale on the queue issue).
 *   5. 🛑 Failed triage                        (batch issues still carrying
 *      sentry:needs-triage — their matrix job died; kept visible, never hidden).
 *
 * This script is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md — it reads each batch issue's labels,
 * body, and latest `<!-- sentry-triage-verdict:v1 -->` comment and never
 * changes the contract, the labels, or Sentry. It builds the Slack payload
 * (including escaping); the workflow's posting step is the only place the Slack
 * token lives and the only thing that POSTs.
 *
 * Single-parser rule: the verdict comment is parsed by the SAME authoritative
 * parser the label/projection steps use (`parseVerdictComment` from
 * sentry-triage-project-core.mjs), so the digest can never disagree with the
 * pipeline about what a verdict says — including the four needs-human brief
 * fields. The digest does NOT re-validate `human_question`; that fail-loud gate
 * lives in the workflow's `--parse-only` label step (`resolveVerdict`), so a
 * needs-human stub that reaches the digest already carries one.
 *
 * Security posture: verdict text is agent-authored from untrusted Sentry data —
 * treated exactly like the queue-issue body text in Stage A. Every free-form
 * value embedded in the payload (summary, the needs-human brief fields, plus
 * the short-id/project lifted from the queue title) is neutralized and
 * Slack-escaped before it reaches a payload field, using the SAME `& < >`
 * escape the main-failure notifier uses (.github/workflows/notify-slack-on-main-failure.yml).
 * That escape neutralizes Slack mention/link control syntax (`<!channel>`,
 * `<@U123>`, `<url|text>`). Closed-set fields (verdict, confidence) are
 * validated against their enums so only known-safe tokens ever render; the URLs
 * we turn into links are shape-validated (queue/projected/fix = https github.com,
 * Sentry permalink = https *.sentry.io) before rendering.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Verdict-comment parsing is delegated to the pipeline's single authoritative
// parser (the same one the label/projection steps run) so the digest can never
// diverge from what the pipeline decided. The permalink extractor + the
// projected-comment prefix are contract constants owned by the same module.
import {
  extractPermalink,
  parseVerdictComment,
  PROJECTED_COMMENT_PREFIX,
  REGRESSION_PREFIX,
} from "./sentry-triage-project-core.mjs";

// Re-export the authoritative parser under the digest's historical name so
// consumers/tests keep one import surface (the digest never owns a second
// verdict parser).
export {
  extractPermalink,
  parseVerdictComment,
  PROJECTED_COMMENT_PREFIX,
} from "./sentry-triage-project-core.mjs";
export { extractYamlBlock as extractVerdictYamlBlock } from "./sentry-triage-project-core.mjs";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";

export const VERDICT_MARKER = "<!-- sentry-triage-verdict:v1 -->";
export const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

// #1278 emission interface (Phase 2b autofix). The Autofixed section renders an
// issue ONLY when the pipeline recorded a fix PR for it. The contract #1278
// must emit: a trusted-bot comment on the queue stub whose body is exactly this
// prefix followed by the fix PR's https github.com URL — e.g.
// `Autofixed by PR: https://github.com/mento-protocol/frontend-monorepo/pull/42`.
// The digest reads the newest such comment (authorship-fenced, URL
// shape-validated) and links it. Until #1278 lands no emitter posts this, so
// the Autofixed section stays empty and is omitted. Mirrors the machine-parseable
// PROJECTED_COMMENT_PREFIX the projection step already posts.
export const AUTOFIX_COMMENT_PREFIX = "Autofixed by PR: ";

// Verdict LABEL -> verdict VALUE. This is the inverse of the ingest's
// value->label map; note the deliberate asymmetry the verdict contract calls
// out: label `sentry:verdict-upstream` <-> value `upstream-transient`.
export const LABEL_TO_VERDICT = {
  "sentry:verdict-code-fix": "code-fix",
  "sentry:verdict-config-fix": "config-fix",
  "sentry:verdict-upstream": "upstream-transient",
  "sentry:verdict-needs-human": "needs-human",
};

// The `failed` bucket is not a verdict — it is batch issues still carrying
// `sentry:needs-triage` (their triage job died before a verdict landed). It
// must stay visible, never hidden.
export const FAILED_BUCKET = "failed";

// Counts header order — matches the verdict contract's parenthetical
// (`code-fix / config-fix / upstream-transient / needs-human`) plus the
// failed-triage bucket. Kept as-is (issue #1355: "keep the counts header
// line"); the per-section headers carry the outcome-oriented counts.
export const COUNTS_ORDER = [
  "code-fix",
  "config-fix",
  "upstream-transient",
  "needs-human",
  FAILED_BUCKET,
];

const BUCKET_LABELS = {
  "code-fix": "code-fix",
  "config-fix": "config-fix",
  "upstream-transient": "upstream-transient",
  "needs-human": "needs-human",
  [FAILED_BUCKET]: "failed triage",
};

// Outcome sections, in RENDER order — needs-human FIRST (decisions required),
// then autofixed, routed, wontfix, and failed last. Empty sections are omitted.
export const NEEDS_HUMAN_SECTION = "needs-human";
export const AUTOFIXED_SECTION = "autofixed";
export const ROUTED_SECTION = "routed";
export const WONTFIX_SECTION = "wontfix";
export const FAILED_SECTION = "failed";

export const SECTION_ORDER = [
  NEEDS_HUMAN_SECTION,
  AUTOFIXED_SECTION,
  ROUTED_SECTION,
  WONTFIX_SECTION,
  FAILED_SECTION,
];

const SECTION_TITLES = {
  [NEEDS_HUMAN_SECTION]: "⚠️ Needs human — decisions required",
  [AUTOFIXED_SECTION]: "🤖 Autofixed",
  [ROUTED_SECTION]: "📮 Routed to owning repo",
  [WONTFIX_SECTION]: "🙅 Wontfix / transient",
  [FAILED_SECTION]: "🛑 Failed triage",
};

// Hard bound on the summary field we embed. "Truncate hard" mirrors the Stage A
// queue-body defense; also keeps every Slack section well under the 3000-char
// block limit (batch is capped at 6 issues upstream).
const MAX_SUMMARY_LEN = 300;

// Hard bound on each needs-human brief field (decision/hypotheses/investigated/
// why-escalated). Bounded BEFORE escaping, so even an all-`<` value expands to
// at most ~4x = 1600 chars — a single brief line stays far under the
// per-section budget (a brief is scannable; full detail lives on the linked
// queue issue).
const MAX_BRIEF_LEN = 400;

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
 * (shorter) brief-field bound. Used for every free-form needs-human field. */
export function formatBriefText(text) {
  const clean = sanitizeSummary(text);
  const bounded =
    clean.length > MAX_BRIEF_LEN
      ? `${clean.slice(0, MAX_BRIEF_LEN).trimEnd()}…`
      : clean;
  return escapeSlackText(bounded);
}

/** Render a free-text brief list (hypotheses / investigated) as one escaped,
 * bounded line — items joined with "; " so the whole line still obeys the
 * brief-field bound. Empty in -> "" (the caller omits the line). */
export function formatBriefList(items) {
  const joined = (Array.isArray(items) ? items : [])
    .map((item) => sanitizeSummary(item))
    .filter(Boolean)
    .join("; ");
  return joined ? formatBriefText(joined) : "";
}

// ---------------------------------------------------------------------------
// Pure parsing: queue title.
// ---------------------------------------------------------------------------

// Queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`.
const QUEUE_TITLE_PATTERN = /^\[sentry\]\s+(\S+)\s+\(([^,()]+),/;

export function parseQueueTitle(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  if (!match) return { shortId: null, project: null };
  return { shortId: match[1], project: match[2].trim() };
}

// Authorship fence (mirrors sentry-triage-project-core.mjs, where the rationale
// lives): only comments the pipeline's own Actions bot posted may supply the
// digest's rendered text — this repo is public, so a drive-by marker-bearing
// comment must not feed text (or a projected/fix URL) into the Slack digest.
// `gh issue view --json comments` (GraphQL) renders the bot author login as
// "github-actions"; the REST shape is "github-actions[bot]" — accept both,
// fail closed on missing/unknown authors.
export const TRUSTED_COMMENT_AUTHORS = [
  "github-actions",
  "github-actions[bot]",
];

function isTrustedComment(comment) {
  const login = comment?.author?.login ?? comment?.user?.login ?? "";
  return TRUSTED_COMMENT_AUTHORS.includes(login);
}

/** Latest trusted verdict-marker comment on the issue. `gh issue view --json
 * comments` returns comments oldest-first, so the last match is the newest. */
export function findLatestVerdictComment(comments) {
  const marked = (comments ?? []).filter(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.startsWith(VERDICT_MARKER) &&
      isTrustedComment(comment),
  );
  return marked.length ? marked[marked.length - 1].body : null;
}

/** True for an https `github.com` URL. The projected-issue and fix-PR pointers
 * are trusted-bot-posted, but shape-validate them anyway before turning them
 * into links (defense in depth on the authorship fence). */
function isGithubUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

/** `createdAt` of the newest trusted regression-reopen comment, or "" when the
 * stub never regressed. Outcome pointers older than this describe the PREVIOUS
 * occurrence and must be ignored (see extractTrustedUrlComment). Mirrors the
 * regression fence in sentry-triage-project-core.mjs `selectVerdictComment`. */
function newestRegressionAt(comments) {
  let newest = "";
  for (const comment of comments ?? []) {
    if (
      typeof comment?.body === "string" &&
      isTrustedComment(comment) &&
      comment.body.startsWith(REGRESSION_PREFIX)
    ) {
      const at = String(comment.createdAt ?? "");
      if (at > newest) newest = at;
    }
  }
  return newest;
}

/** Newest trusted comment whose body is `<prefix><url>`, with `url` a valid
 * https github.com URL. Null when none. Used for the projected-issue pointer
 * (PROJECTED_COMMENT_PREFIX) and the #1278 fix-PR pointer
 * (AUTOFIX_COMMENT_PREFIX).
 *
 * Regression fence: a queue stub is REOPENED and re-triaged when its Sentry
 * issue regresses (Stage A), and its old comment history — including a stale
 * `Projected to owning repo:` / `Autofixed by PR:` pointer from the previous
 * occurrence — survives. Only a pointer strictly newer than the newest
 * regression-reopen comment describes THIS occurrence; older ones are dropped
 * so a re-triaged issue can't inherit a stale projection link or be misplaced
 * into the Autofixed section off a previous run's fix PR. A pointer missing a
 * `createdAt` after a regression fails closed (treated as stale). */
function extractTrustedUrlComment(comments, prefix) {
  const regressionAt = newestRegressionAt(comments);
  const matches = (comments ?? []).filter(
    (comment) =>
      typeof comment?.body === "string" &&
      isTrustedComment(comment) &&
      comment.body.startsWith(prefix) &&
      (regressionAt === "" || String(comment.createdAt ?? "") > regressionAt),
  );
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const url =
      matches[i].body.slice(prefix.length).trim().split(/\s+/)[0] ?? "";
    if (isGithubUrl(url)) return url;
  }
  return null;
}

export function extractProjectedUrl(comments) {
  return extractTrustedUrlComment(comments, PROJECTED_COMMENT_PREFIX);
}

export function extractAutofixUrl(comments) {
  return extractTrustedUrlComment(comments, AUTOFIX_COMMENT_PREFIX);
}

// ---------------------------------------------------------------------------
// Classification: one collected issue -> one digest entry.
// ---------------------------------------------------------------------------

const EMPTY_PARSED = {
  verdict: null,
  confidence: null,
  summary: "",
  humanQuestion: "",
  hypotheses: [],
  investigated: [],
  escalationReason: "",
};

/** Which outcome section an entry renders in. Bucket is the verdict; a
 * code/config-fix with recorded fix-PR data (#1278) goes to Autofixed, else
 * Routed. */
function sectionForEntry(bucket, autofixUrl) {
  if (bucket === FAILED_BUCKET) return FAILED_SECTION;
  if (bucket === "needs-human") return NEEDS_HUMAN_SECTION;
  if (bucket === "upstream-transient") return WONTFIX_SECTION;
  // code-fix / config-fix.
  return autofixUrl ? AUTOFIXED_SECTION : ROUTED_SECTION;
}

/**
 * The bucket is decided from LABELS (deterministic, validated by the workflow
 * label step), not from the agent's free-text comment:
 *   - still carrying `sentry:needs-triage`  -> failed (triage did not finish);
 *   - carries a `sentry:verdict-*` label    -> that verdict;
 *   - neither (shouldn't happen for a batch issue) -> failed, so it stays
 *     visible rather than silently dropped.
 * The comment supplies only human-readable fields (confidence, summary, and —
 * for needs-human — the decision-ready brief). The projected-issue URL / fix-PR
 * URL come from trusted-bot pointer comments; the Sentry permalink from the
 * queue-issue body.
 */
export function classifyIssue(issue) {
  const labelNames = (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
  const { shortId, project } = parseQueueTitle(issue?.title);
  const verdictCommentBody = findLatestVerdictComment(issue?.comments);
  const parsed = verdictCommentBody
    ? parseVerdictComment(verdictCommentBody)
    : EMPTY_PARSED;

  const stillNeedsTriage = labelNames.includes(NEEDS_TRIAGE_LABEL);
  const verdictLabel = labelNames.find((name) =>
    Object.hasOwn(LABEL_TO_VERDICT, name),
  );
  const verdictFromLabel = verdictLabel ? LABEL_TO_VERDICT[verdictLabel] : null;

  let bucket;
  if (stillNeedsTriage) bucket = FAILED_BUCKET;
  else if (verdictFromLabel) bucket = verdictFromLabel;
  else bucket = FAILED_BUCKET;

  const autofixUrl = extractAutofixUrl(issue?.comments);

  return {
    number: issue?.number,
    shortId: shortId ?? `#${issue?.number}`,
    project: project ?? "unknown",
    url: typeof issue?.url === "string" ? issue.url : "",
    bucket,
    section: sectionForEntry(bucket, autofixUrl),
    verdict: bucket === FAILED_BUCKET ? null : bucket,
    confidence: parsed.confidence,
    summary: parsed.summary,
    // needs-human decision-ready brief.
    humanQuestion: parsed.humanQuestion ?? "",
    hypotheses: parsed.hypotheses ?? [],
    investigated: parsed.investigated ?? [],
    escalationReason: parsed.escalationReason ?? "",
    sentryPermalink: extractPermalink(issue?.body),
    // Routed / Autofixed pointers.
    projectedUrl: extractProjectedUrl(issue?.comments),
    autofixUrl,
  };
}

// ---------------------------------------------------------------------------
// Slack payload assembly.
// ---------------------------------------------------------------------------

function formatUtcTimestamp(date) {
  // 2026-07-17T14:20:33.123Z -> "2026-07-17 14:20 UTC"
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

/** `<url|text>` only for a trusted https URL; otherwise the escaped text. */
function link(url, text) {
  return isHttpsUrl(url) ? `<${url}|${text}>` : text;
}

/** The linked, escaped SHORT-ID (links to the queue issue) + escaped project,
 * shared by every per-issue line. */
function idAndProject(entry) {
  const idText = escapeSlackText(entry.shortId);
  const linked = isHttpsUrl(entry.url) ? `<${entry.url}|${idText}>` : idText;
  return { linked, project: escapeSlackText(entry.project) };
}

/** A needs-human decision-ready brief: multiple indented lines. Decision is
 * always shown (placeholder if somehow absent — the label step requires it);
 * hypotheses / investigated / why-escalated render only when present. */
function renderNeedsHumanBrief(entry) {
  const { linked, project } = idAndProject(entry);
  const confidence = entry.confidence ?? "unknown";
  const lines = [`⚠️ *${linked}* (${project}) · confidence: ${confidence}`];

  const decision = entry.humanQuestion
    ? formatBriefText(entry.humanQuestion)
    : "_(no decision recorded — re-triage)_";
  lines.push(`    *Decision needed:* ${decision}`);

  const hypotheses = formatBriefList(entry.hypotheses);
  if (hypotheses) lines.push(`    *Hypotheses:* ${hypotheses}`);

  const investigated = formatBriefList(entry.investigated);
  if (investigated) lines.push(`    *Already investigated:* ${investigated}`);

  if (entry.escalationReason) {
    lines.push(
      `    *Why escalated:* ${formatBriefText(entry.escalationReason)}`,
    );
  }

  const linkParts = [];
  if (isHttpsUrl(entry.url)) linkParts.push(link(entry.url, "queue issue"));
  if (entry.sentryPermalink) {
    linkParts.push(link(entry.sentryPermalink, "Sentry"));
  }
  if (linkParts.length) lines.push(`    *Links:* ${linkParts.join(" · ")}`);
  return lines;
}

/** Shared one-liner for Autofixed / Routed: `• <id> (<project>) — <summary> →
 * <arrow>`, where <arrow> is the linked outcome (fix PR / owning-repo issue /
 * queue-verdict fallback). */
function renderArrowLine(entry, arrowUrl, arrowLabel) {
  const { linked, project } = idAndProject(entry);
  const summary = entry.summary
    ? formatSummaryForSlack(entry.summary)
    : "_(no summary)_";
  return `• ${linked} (${project}) — ${summary} → ${link(arrowUrl, arrowLabel)}`;
}

function renderWontfixLine(entry) {
  const { linked, project } = idAndProject(entry);
  const confidence = entry.confidence ?? "unknown";
  const summary = entry.summary
    ? formatSummaryForSlack(entry.summary)
    : "_(no summary)_";
  // The SHORT-ID links the queue issue, which holds the verdict comment (the
  // rationale). Confidence rides along.
  return `• ${linked} (${project}) — ${summary} (${confidence})`;
}

function renderFailedLine(entry) {
  const { linked, project } = idAndProject(entry);
  return `• ${linked} (${project}) — triage incomplete (still \`${NEEDS_TRIAGE_LABEL}\`)`;
}

/** The body lines for one section (excluding its header). needs-human returns
 * multi-line briefs separated by a blank line; the rest one line per entry. */
function renderSectionBodyLines(section, entries) {
  switch (section) {
    case NEEDS_HUMAN_SECTION:
      return entries.flatMap((entry, index) =>
        index === 0
          ? renderNeedsHumanBrief(entry)
          : ["", ...renderNeedsHumanBrief(entry)],
      );
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
    case WONTFIX_SECTION:
      return entries.map(renderWontfixLine);
    case FAILED_SECTION:
      return entries.map(renderFailedLine);
    default:
      return [];
  }
}

// Slack caps a text object at 3000 chars; escape expansion (`<` -> `&lt;`,
// `&` -> `&amp;`) means several worst-case summaries/briefs would blow past it
// in one section, and chat.postMessage would reject the whole payload with
// `invalid_blocks`. Budget per section, with headroom under the hard cap.
export const MAX_SECTION_TEXT_LEN = 2800;

function mrkdwnSection(text) {
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
 * Build the deterministic Slack `chat.postMessage` payload for one batch.
 * `channel` is passed in (hardcoded by the workflow); `now` is injectable for
 * tests. Pure — no I/O, no escaping omissions: every free-form value is routed
 * through the escape/format helpers here.
 */
export function buildDigest(issues, { channel, now = new Date() } = {}) {
  const entries = (issues ?? []).map(classifyIssue);

  const counts = Object.fromEntries(COUNTS_ORDER.map((key) => [key, 0]));
  for (const entry of entries) {
    counts[entry.bucket] = (counts[entry.bucket] ?? 0) + 1;
  }

  const total = entries.length;
  const headerText = `*Sentry triage — ${total} issue(s) triaged*\n${formatUtcTimestamp(now)}`;
  const countsText = COUNTS_ORDER.map(
    (key) => `${BUCKET_LABELS[key]}: ${counts[key] ?? 0}`,
  ).join(" · ");

  const blocks = [mrkdwnSection(headerText), mrkdwnSection(countsText)];

  const bySection = new Map(SECTION_ORDER.map((key) => [key, []]));
  for (const entry of entries) bySection.get(entry.section).push(entry);

  for (const section of SECTION_ORDER) {
    const sectionEntries = bySection.get(section);
    if (sectionEntries.length === 0) continue; // omit empty sections
    const headerLine = `*${SECTION_TITLES[section]} (${sectionEntries.length})*`;
    const bodyLines = renderSectionBodyLines(section, sectionEntries);
    // Chunk each section independently (header stays with its first chunk) so
    // escape-expanded briefs can never push a single text object past Slack's
    // 3000-char cap. Batch cap is 6, so this stays well under Slack's
    // 50-blocks-per-message limit.
    for (const chunk of chunkLines([headerLine, ...bodyLines])) {
      blocks.push(mrkdwnSection(chunk));
    }
  }

  return {
    channel,
    // Plain-text fallback for notifications/screen readers (no untrusted text).
    text: `Sentry triage — ${total} issue(s) triaged`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// GitHub collection (via `gh`, mirroring the ingest script's runGh). Read-only
// — `gh issue view` needs only `issues: read`.
// ---------------------------------------------------------------------------

function runGh(args) {
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

async function fetchIssue(repo, number, run) {
  const stdout = await run([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    // `body` is needed for the needs-human brief's Sentry permalink (queue-body
    // yaml). All fields are read-only.
    "number,title,url,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    url: data.url ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? []).map((label) => label?.name),
    comments: data.comments ?? [],
  };
}

/** Fetch each batch issue's title/url/body/labels/comments. `run` is injectable
 * for tests. ≤6 issues per run (upstream batch cap), so a serial loop is fine. */
export async function collectIssues(repo, numbers, deps = {}) {
  const run = deps.runGh ?? runGh;
  const issues = [];
  for (const number of numbers ?? []) {
    issues.push(await fetchIssue(repo, number, run));
  }
  return issues;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse the batch from a JSON array of positive integers (the select job's
 * `issues` output). Empty/absent -> [] (the empty-batch guard). Fails loud on
 * anything that isn't a JSON array of positive integers. */
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

function usage() {
  return `Usage: pnpm sentry:digest --channel <slack-channel> [options]

Collects the current triage batch's verdicts and prints a deterministic Slack
chat.postMessage payload (JSON) to stdout. The workflow's posting step is the
only thing that holds the Slack token and POSTs.

Options:
  --channel <name>     Slack channel to post to (e.g. '#engineering'). Required.
                       Env fallback: SENTRY_TRIAGE_CHANNEL.
  --issues <json>      JSON array of queue-issue numbers (the select job's
                       output). Env fallback: SENTRY_TRIAGE_ISSUES.
  --repo <owner/name>  Repository the queue issues live in (default: ${DEFAULT_REPO}).
  -h, --help           Show this help.
`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    repo: DEFAULT_REPO,
    channel: env.SENTRY_TRIAGE_CHANNEL ?? null,
    help: false,
  };
  let issuesRaw = env.SENTRY_TRIAGE_ISSUES ?? null;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--repo":
        options.repo = readValue();
        break;
      case "--channel":
        options.channel = readValue();
        break;
      case "--issues":
        issuesRaw = readValue();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  options.issues = parseIssueNumbers(issuesRaw);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.channel || !String(options.channel).trim()) {
    throw new Error("--channel is required (or set SENTRY_TRIAGE_CHANNEL)");
  }

  // Empty-batch guard: nothing to report. Emit nothing on stdout so the
  // posting step has no payload to POST (defense in depth — the digest job is
  // already gated on a non-zero select count).
  if (options.issues.length === 0) {
    process.stderr.write(
      "::notice::No issues in the triage batch; nothing to post.\n",
    );
    return;
  }

  const issues = await collectIssues(options.repo, options.issues);
  const payload = buildDigest(issues, {
    channel: options.channel,
    now: new Date(),
  });
  // ONLY the payload goes to stdout (the workflow redirects it to a file for
  // the posting step); all diagnostics go to stderr.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
