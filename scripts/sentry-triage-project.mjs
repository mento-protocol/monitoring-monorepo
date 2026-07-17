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

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const LOCAL_REPO = DEFAULT_REPO;

export const VERDICT_MARKER = "<!-- sentry-triage-verdict:v1 -->";
// Stage A posts this fixed prefix when a closed stub regresses; the regression
// fence below rejects a verdict comment that is not strictly newer than it.
export const REGRESSION_PREFIX = "Regressed in Sentry (last seen ";

export const PROJECTED_LABEL = "sentry:projected";

// Only ACTIONABLE verdicts project. `needs-human` / `upstream-transient` stay
// in the queue (verdict contract).
export const PROJECTABLE_VERDICTS = ["code-fix", "config-fix"];

// The FIXED projection allowlist — the three external owning repos. Anything
// else (including this repo, whose errors are fixed here, not projected) is a
// no-op. This list is the whole trust boundary for the cross-repo write.
export const ALLOWED_OWNING_REPOS = [
  "mento-protocol/frontend-monorepo",
  "mento-protocol/mento-analytics-api",
  "mento-protocol/minipay-dapp",
];

export const VALID_VERDICTS = [
  "code-fix",
  "config-fix",
  "upstream-transient",
  "needs-human",
];
export const VALID_CONFIDENCE = ["high", "medium", "low"];

// Verdict VALUE -> verdict LABEL (label names are owned by the Stage A ingest
// bootstrap). Note the deliberate asymmetry the verdict contract calls out:
// value `upstream-transient` maps to label `sentry:verdict-upstream`.
export const VERDICT_TO_LABEL = {
  "code-fix": "sentry:verdict-code-fix",
  "config-fix": "sentry:verdict-config-fix",
  "upstream-transient": "sentry:verdict-upstream",
  "needs-human": "sentry:verdict-needs-human",
};

// Sentry SHORT-IDs look like `GOVERNANCE-MENTO-ORG-51`. Validate the shape
// before it goes into an HTML-comment marker or a search query — it is
// Sentry-assigned but still transits an untrusted channel.
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FOOTER =
  "Filed by the Mento Sentry triage pipeline (ADR 0036 / ADR 0038 — verdict " +
  "projection). Machine-filed from a triage verdict; advisory only, so confirm " +
  "the root cause in Sentry before acting. The HTML comment marker at the top " +
  "keys automatic de-duplication — please keep it.";

// ---------------------------------------------------------------------------
// Untrusted-text neutralization (mirrors the ingest's helpers).
// ---------------------------------------------------------------------------

/** Strip control chars/newlines and collapse whitespace to a single line. */
export function sanitizeFreeText(text) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars from untrusted agent text is the whole point here
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Replace every backtick with a look-alike so an attacker-controlled value can
 * never close a markdown code fence / inline-code span early. */
export function defangBackticks(text) {
  return String(text ?? "").replace(/`/g, "ˋ");
}

/** Insert a zero-width space after every `@` so `@user` / `@org/team` in
 * agent-reachable text can never become a live GitHub mention once embedded in
 * an issue body. Visual fidelity is preserved for review. */
export function defangMentions(text) {
  return String(text ?? "").replace(/@/g, "@\u200B");
}

/** Break every HTML-comment opener (`<!--` -> `<!` + zero-width space + `--`)
 * so agent text can never embed a marker-shaped sequence \u2014 e.g. a spoofed
 * `<!-- sentry-projection:v1 OTHER-ID -->` inside a rendered verdict field \u2014
 * into a projected issue body. The idempotency back-link marker must only
 * ever exist where buildProjectedBody itself emits it (the first body line);
 * this is defense in depth behind the first-line anchoring of
 * bodyBacklinksShortId. */
export function defangHtmlComments(text) {
  return String(text ?? "").replace(/<!--/g, "<!\u200B--");
}

/** Single-line neutralization for titles and inline fields. */
export function neutralizeUntrusted(text) {
  return defangMentions(
    defangBackticks(defangHtmlComments(sanitizeFreeText(text))),
  );
}

/** Multi-line neutralization for block fields (root cause / proposed action):
 * strip control chars but KEEP newlines, defang backticks + mentions + HTML
 * comments, and hard bound both line count and length. Rendered inside a
 * fenced block by the caller so any surviving markdown is inert. */
export function neutralizeBlock(text, { maxLen = 600, maxLines = 8 } = {}) {
  let s = String(text ?? "")
    // eslint-disable-next-line no-control-regex -- keep \n (0x0a) + \t (0x09); strip the rest
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "");
  s = defangMentions(defangBackticks(defangHtmlComments(s)));
  s = s.split("\n").slice(0, maxLines).join("\n");
  if (s.length > maxLen) s = `${s.slice(0, maxLen).trimEnd()}…`;
  return s.trim();
}

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

// ---------------------------------------------------------------------------
// Pure parsing: queue title, permalink, verdict comment (richer than digest).
// ---------------------------------------------------------------------------

// Queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`.
const QUEUE_TITLE_PATTERN = /^\[sentry\]\s+(\S+)\s+\(/;

export function parseShortId(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  return match ? match[1] : null;
}

export function isValidShortId(shortId) {
  return (
    typeof shortId === "string" &&
    shortId.length > 0 &&
    shortId.length <= 120 &&
    SHORT_ID_PATTERN.test(shortId)
  );
}

function isSafeSentryPermalink(url) {
  try {
    const parsed = new URL(String(url));
    return (
      parsed.protocol === "https:" && /(^|\.)sentry\.io$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Pull the Sentry permalink out of the queue stub's yaml body. Only returned
 * when it parses as an https `*.sentry.io` URL — otherwise null (omitted). */
export function extractPermalink(body) {
  const match = /^permalink:\s*(.+)$/m.exec(String(body ?? ""));
  if (!match) return null;
  const value = stripYamlQuotes(match[1]);
  return isSafeSentryPermalink(value) ? value : null;
}

export function extractYamlBlock(commentBody) {
  const match = /```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(
    String(commentBody ?? ""),
  );
  return match ? match[1] : "";
}

function parseInlineList(rest) {
  const trimmed = String(rest ?? "").trim();
  const inner = /^\[(.*)\]$/.exec(trimmed);
  const raw = inner ? inner[1] : trimmed;
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

function collectDashList(lines, start) {
  const items = [];
  let j = start + 1;
  for (; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === "") continue;
    const dash = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (dash) {
      items.push(dash[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (/^\s/.test(line)) continue; // other indented content — skip
    break;
  }
  return { items, next: j };
}

function collectBlockScalar(lines, start, rest) {
  const trimmed = rest.trim();
  if (!/^[|>][+-]?$/.test(trimmed)) {
    // Inline scalar on the same line, not a block indicator.
    return { text: stripYamlQuotes(trimmed), next: start + 1 };
  }
  const collected = [];
  let j = start + 1;
  for (; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === "") {
      collected.push("");
      continue;
    }
    if (/^\s/.test(line)) {
      collected.push(line.replace(/^[ \t]+/, ""));
      continue;
    }
    break;
  }
  while (collected.length && collected[collected.length - 1] === "") {
    collected.pop();
  }
  return { text: collected.join("\n"), next: j };
}

/** Only keep values that look like Sentry SHORT-IDs; drop everything else so a
 * hostile duplicate list can't inject markup. */
export function sanitizeDuplicateIds(list) {
  return (Array.isArray(list) ? list : [])
    .map((value) => String(value ?? "").trim())
    .filter(isValidShortId)
    .slice(0, 20);
}

/**
 * Line-oriented, tolerant parse of the verdict yaml — deliberately NOT a real
 * yaml loader (the block is untrusted agent text). Reads verdict/confidence as
 * their leading enum token, affected_repo as the first `owner/name` slug,
 * summary as its full line value, root_cause/proposed_action as block scalars,
 * and duplicate_of as an inline `[...]` or a `- item` list.
 */
export function parseVerdictYaml(block) {
  const lines = String(block ?? "").split(/\r?\n/);
  const out = {
    verdict: null,
    confidence: null,
    affected_repo: "",
    summary: "",
    root_cause: "",
    proposed_action: "",
    duplicate_of: [],
  };
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([a-z_]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const key = match[1];
    const rest = match[2];

    if (key === "verdict") {
      const token = /^([a-z-]+)/.exec(rest);
      out.verdict = token ? token[1] : null;
    } else if (key === "confidence") {
      const token = /^([a-z]+)/.exec(rest);
      out.confidence = token ? token[1] : null;
    } else if (key === "affected_repo") {
      const token = /([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.exec(rest);
      out.affected_repo = token ? token[1] : "";
    } else if (key === "summary") {
      out.summary = stripYamlQuotes(rest);
    } else if (key === "root_cause" || key === "proposed_action") {
      const { text, next } = collectBlockScalar(lines, i, rest);
      out[key] = text;
      i = next - 1;
    } else if (key === "duplicate_of") {
      if (rest.trim() !== "") {
        out.duplicate_of = parseInlineList(rest);
      } else {
        const { items, next } = collectDashList(lines, i);
        out.duplicate_of = items;
        i = next - 1;
      }
    }
  }
  out.duplicate_of = sanitizeDuplicateIds(out.duplicate_of);
  return out;
}

/** Parse a verdict comment body into validated fields. Enums are constrained to
 * their closed sets (null otherwise); free-form fields are returned raw for
 * later neutralize+render. */
export function parseVerdictComment(commentBody) {
  const block = extractYamlBlock(commentBody) || String(commentBody ?? "");
  const parsed = parseVerdictYaml(block);
  return {
    verdict: VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : null,
    confidence: VALID_CONFIDENCE.includes(parsed.confidence)
      ? parsed.confidence
      : null,
    affectedRepo: parsed.affected_repo,
    summary: parsed.summary,
    rootCause: parsed.root_cause,
    proposedAction: parsed.proposed_action,
    duplicateOf: parsed.duplicate_of,
  };
}

function compareCreatedAt(a, b) {
  return String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""));
}

// Authorship trust boundary for pipeline-driving comments. The verdict comment
// is posted by the triage job's `gh issue comment` (github.token) and the
// regression-reopen comment by the ingest workflow — both resolve to the
// GitHub Actions bot. `gh issue view --json comments` (GraphQL) renders that
// author login as "github-actions" (verified empirically on live queue issues,
// e.g. monitoring-monorepo#1318); the REST shape is "github-actions[bot]" —
// accept both. This repo is public, so WITHOUT this filter any drive-by
// commenter could paste a marker-bearing comment and drive labeling, closing,
// and (once the PAT exists) cross-repo issue creation. Comments with a
// missing/unknown author are untrusted (fail closed).
export const TRUSTED_COMMENT_AUTHORS = [
  "github-actions",
  "github-actions[bot]",
];

export function isTrustedComment(comment) {
  const login = comment?.author?.login ?? comment?.user?.login ?? "";
  return TRUSTED_COMMENT_AUTHORS.includes(login);
}

/**
 * Pick the verdict comment to act on. This is the SINGLE selection path for
 * both the workflow's label step (--parse-only) and projection, and it applies
 * two fences:
 *
 *   1. Authorship: only comments authored by the pipeline's own Actions bot
 *      count — both for verdict comments (a hostile commenter must not drive
 *      labels/closes/projection) and for regression-reopen comments (a hostile
 *      commenter must not be able to stale-out a legitimate verdict).
 *   2. Regression fence: a reopened regression still carries the previous
 *      round's verdict comment (Stage A's reopen path only sheds labels), so
 *      only accept the newest verdict comment when it is strictly newer than
 *      the newest regression-reopen comment.
 *
 * Returns `{ body, reason }` — body null when there is no trusted verdict
 * comment (`no-verdict-comment`) or the newest one is stale (`stale-verdict`).
 */
export function selectVerdictComment(comments) {
  const list = (comments ?? []).filter(
    (comment) => typeof comment?.body === "string" && isTrustedComment(comment),
  );
  const verdicts = list
    .filter((comment) => comment.body.startsWith(VERDICT_MARKER))
    .sort(compareCreatedAt);
  if (verdicts.length === 0)
    return { body: null, reason: "no-verdict-comment" };
  const newestVerdict = verdicts[verdicts.length - 1];

  const regressions = list
    .filter((comment) => comment.body.startsWith(REGRESSION_PREFIX))
    .sort(compareCreatedAt);
  if (regressions.length > 0) {
    const newestRegression = regressions[regressions.length - 1];
    if (
      !(String(newestVerdict.createdAt) > String(newestRegression.createdAt))
    ) {
      return { body: null, reason: "stale-verdict" };
    }
  }
  return { body: newestVerdict.body, reason: null };
}

/**
 * The SINGLE authoritative verdict resolution, shared by the workflow's label
 * step (`--parse-only`) and the projection flow: newest marker comment,
 * regression fence, closed-enum validation, label mapping. THROWS (fail loud)
 * on a missing, stale, or invalid verdict — never a silent skip. Two parsers
 * disagreeing here (the label step's old sed vs this parser) could label a
 * stub and then silently skip its projection while the stub closes as if
 * handled; funneling both steps through this one function removes that
 * divergence by construction (PR #1356 review).
 */
export function resolveVerdict(issue, queueIssueNumber) {
  const selected = selectVerdictComment(issue.comments);
  if (!selected.body) {
    throw new Error(
      `No usable verdict comment on issue #${queueIssueNumber} (${selected.reason}).`,
    );
  }
  const parsed = parseVerdictComment(selected.body);
  if (!parsed.verdict) {
    throw new Error(
      `Verdict comment on issue #${queueIssueNumber} has a missing/invalid verdict value.`,
    );
  }
  return {
    parsed,
    verdict: parsed.verdict,
    label: VERDICT_TO_LABEL[parsed.verdict],
  };
}

// ---------------------------------------------------------------------------
// Allowlist validation + idempotency marker.
// ---------------------------------------------------------------------------

/**
 * Validate the untrusted `affected_repo`. Returns `{ projectable, repo,
 * warning, reason }`:
 *   - an allowlisted external repo -> projectable, repo = that repo;
 *   - this repo -> not projectable (its errors are fixed here), no warning;
 *   - anything else -> not projectable, treated as this repo, with a warning.
 */
export function validateAffectedRepo(repo) {
  const value = String(repo ?? "").trim();
  if (ALLOWED_OWNING_REPOS.includes(value)) {
    return { projectable: true, repo: value, warning: null, reason: "allowed" };
  }
  if (value === LOCAL_REPO) {
    return {
      projectable: false,
      repo: LOCAL_REPO,
      warning: null,
      reason: "local-repo",
    };
  }
  return {
    projectable: false,
    repo: LOCAL_REPO,
    warning: `affected_repo ${value ? `'${truncate(value, 80)}'` : "(empty)"} is not in the projection allowlist; treating as ${LOCAL_REPO} and not projecting.`,
    reason: "unrecognized-repo",
  };
}

export function buildProjectionMarker(shortId) {
  return `<!-- sentry-projection:v1 ${shortId} -->`;
}

/**
 * True when `body` is a genuine projection back-link for `shortId`. The
 * marker is only accepted at its fixed structural position — the FIRST
 * non-empty line of the body, which is exactly where buildProjectedBody
 * emits it — never via a broad substring search: a marker-shaped sequence
 * embedded in a rendered free-text field of an UNRELATED projected issue
 * must not satisfy the idempotency check for a different SHORT-ID (which
 * would close that stub as "reused" without filing anything). Rendered
 * fields additionally defang `<!--` (defangHtmlComments) so such a sequence
 * cannot survive rendering intact in the first place.
 */
export function bodyBacklinksShortId(body, shortId) {
  if (!isValidShortId(shortId)) return false;
  const firstNonEmptyLine = String(body ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  return (
    firstNonEmptyLine !== undefined &&
    firstNonEmptyLine.trim() === buildProjectionMarker(shortId)
  );
}

// ---------------------------------------------------------------------------
// Projected-issue rendering.
// ---------------------------------------------------------------------------

export function buildProjectedTitle(summary) {
  const clean = neutralizeUntrusted(summary);
  const base = clean || "(no summary provided)";
  return `Sentry: ${truncate(base, 200)}`;
}

function fencedBlock(text) {
  const body = neutralizeBlock(text);
  if (!body) return "_(none provided)_";
  return ["```text", body, "```"].join("\n");
}

// Hard bound for the one inline free-text field the body renders outside a
// fence. Every other body field is already bounded: the title caps at 200,
// block fields at 600 (neutralizeBlock), duplicates at 20 shape-validated
// SHORT-IDs, shortId at 120, verdict/confidence are closed enums, and the
// permalink is a Stage-A-bounded validated URL. Without this cap a
// hostile/long single-line summary could blow the `gh issue create` request
// and loop the retry compensation.
const MAX_BODY_SUMMARY_LEN = 500;

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
  const safeSummary =
    truncate(neutralizeUntrusted(summary), MAX_BODY_SUMMARY_LEN) ||
    "_(no summary provided)_";
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
    safeSummary,
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
    "number,title,body,url,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    url: data.url ?? "",
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

async function findExistingProjection(owningRun, owningRepo, shortId) {
  const stdout = await owningRun([
    "issue",
    "list",
    "-R",
    owningRepo,
    "--state",
    "all",
    "--search",
    `"${shortId}" "${FOOTER_SEARCH_PHRASE}" in:body`,
    "--json",
    "number,url,body,state",
    "--limit",
    "200",
  ]);
  const items = stdout && stdout.trim() ? JSON.parse(stdout) : [];
  // Search is a coarse pre-filter (GitHub search may not index HTML-comment
  // text, so the marker itself can't be the search term); the footer-phrase
  // AND keeps it sharp and the 200 cap (matching the duplicate search) keeps
  // it deep. The authoritative check is the hidden marker in a candidate's
  // body — search only narrows, never decides.
  const match = (Array.isArray(items) ? items : []).find((item) =>
    bodyBacklinksShortId(item.body, shortId),
  );
  return match
    ? {
        number: match.number,
        url: match.url,
        state: String(match.state ?? "").toUpperCase(),
      }
    : null;
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
 * the exact same parser (see resolveVerdict). Read-only — one `gh issue view`
 * with the ambient token; the projection PAT is never needed here. Throws on
 * missing/stale/invalid verdicts so the label step fails loudly and leaves
 * `sentry:needs-triage` in place for retry.
 */
export async function runParseOnly(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const localRun = (args) => runGh(args, {});
  const issue = await readQueueIssue(
    localRun,
    options.localRepo,
    options.queueIssue,
  );
  const { verdict, label } = resolveVerdict(issue, options.queueIssue);
  return { verdict, label };
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

  // Idempotency: reuse an existing projected issue (any state) that back-links
  // this SHORT-ID rather than filing a duplicate. A CLOSED one is reopened
  // first so the regression resurfaces for the product team.
  const existing = await findExistingProjection(owningRun, owningRepo, shortId);
  if (existing) {
    if (existing.state === "CLOSED") {
      await reopenProjectedIssue(owningRun, owningRepo, existing);
    }
    await markStubProjected(localRun, options.localRepo, issue, existing.url);
    return { status: "reused", url: existing.url };
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
    queueIssueUrl:
      issue.url ||
      `https://github.com/${options.localRepo}/issues/${options.queueIssue}`,
  });

  const url = await createProjectedIssue(owningRun, owningRepo, title, body);
  await markStubProjected(localRun, options.localRepo, issue, url);
  return { status: "projected", url };
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

Options:
  --issue <number>     Queue issue number to project (required, positive int).
  --repo <owner/name>  Repo the queue stub lives in (default: ${DEFAULT_REPO}).
  --parse-only         Resolve and print the validated verdict + mapped label
                       ({"verdict","label"} JSON) without projecting. Used by
                       the workflow's label step so labeling and projection
                       share ONE parser. Fails (exit 1) on a missing, stale
                       pre-regression, or invalid verdict comment.
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

export function parseArgs(argv, env = process.env) {
  const options = {
    localRepo: DEFAULT_REPO,
    queueIssue: null,
    parseOnly: false,
    expectedVerdict: null,
    help: false,
  };
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
    if (!Number.isInteger(options.queueIssue) || options.queueIssue <= 0) {
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
  const result = options.parseOnly
    ? await runParseOnly(options)
    : await runProjection(options);
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
