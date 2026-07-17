/**
 * Pure core of the Sentry triage verdict-projection helper (ADR 0038) —
 * constants, untrusted-text neutralization, verdict-comment parsing and
 * selection (authorship + regression fences), allowlist validation, and
 * projected-issue rendering. NO I/O lives here: the gh-facing orchestration
 * and CLI are in scripts/sentry-triage-project.mjs, which re-exports this
 * module (split per the repo's <name>-core.mjs convention — see
 * pr-feedback-state-core.mjs). The security posture and contract docs live in
 * the entry module's header and docs/notes/sentry-triage-pipeline.md
 * ("Verdict projection").
 */

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

// Sentry SHORT-IDs look like `GOVERNANCE-MENTO-ORG-51` — always
// `<PROJECT-SLUG>-<SUFFIX>` where the suffix is Sentry's base-36 issue
// counter (numeric early on, alphanumeric later: `APP-MENTO-ORG-2S`).
// Requiring the trailing `-<alnum>` (not just a safe charset) keeps bare
// common words like "Sentry" from validating, since every accepted value can
// drive an owning-repo search — validate the shape before it goes into an
// HTML-comment marker or a search query; it is Sentry-assigned but still
// transits an untrusted channel. Do NOT require a decimal-only suffix: that
// would make base-36 short IDs permanently unprojectable.
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9]+$/;

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

function splitListItems(raw) {
  // Trim BEFORE stripping quotes (then re-trim): `["A", "B"]` splits into
  // ` "B"`, whose leading space would otherwise shield the opening quote from
  // the anchored strip and leave `"B` to fail shape validation.
  return raw
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Strip a trailing yaml comment — but only a `#` that opens one at a valid
 * boundary (preceded by whitespace, or the whole value). A bare `foo#bar` is
 * part of the scalar in yaml, and truncating it would normalize malformed
 * values into valid-looking ones (e.g. `<repo>#garbage` must NOT become an
 * allowlisted repo). */
function stripTrailingYamlComment(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function parseInlineList(rest) {
  const trimmed = String(rest ?? "").trim();
  if (trimmed.startsWith("[")) {
    // Parse the bracketed segment, tolerating ONLY a trailing yaml comment
    // after the closing bracket — the verdict contract's own documented
    // example is `duplicate_of: [] # list of Sentry SHORT-IDs (e.g.
    // GOV…-51), …`, and an end-of-line-anchored match would fail on it,
    // silently dropping the duplicates. Any other trailing garbage rejects
    // the whole list (these IDs drive duplicate coalescing, so malformed
    // agent output must not be normalized into valid-looking values).
    const close = trimmed.indexOf("]");
    if (close === -1) return [];
    const remainder = trimmed.slice(close + 1);
    if (remainder.trim() !== "" && !/^\s+#/.test(remainder)) return [];
    const raw = trimmed.slice(1, close);
    if (!raw.trim()) return [];
    return splitListItems(raw);
  }
  // Bare (bracketless) scalar list: strip a boundary-valid trailing comment
  // so a `# note` never leaks tokens into the ids (ids are shape-validated
  // and can never legitimately contain `#`).
  const withoutComment = stripTrailingYamlComment(trimmed).trim();
  if (!withoutComment) return [];
  return splitListItems(withoutComment);
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

// Hard budget on how many duplicate SHORT-IDs may drive owning-repo lookups.
// The list is agent-produced from untrusted Sentry content, and every entry
// costs cross-repo searches (plus bounded candidate reads) — a real verdict
// names a handful of duplicates, so anything past this cap is noise. Applied
// at the CONSUMPTION point in runProjection, AFTER the stub's own SHORT-ID is
// excluded — capping before the self-exclusion could let a self-reference
// consume budget and push a real duplicate past the cap.
export const MAX_DUPLICATE_LOOKUPS = 5;

/** Only keep unique values that look like Sentry SHORT-IDs, bounded for
 * rendering/memory (the LOOKUP budget is MAX_DUPLICATE_LOOKUPS, applied
 * later); drop everything else so a hostile duplicate list can neither inject
 * markup nor bloat the projected body. */
export function sanitizeDuplicateIds(list) {
  const unique = [
    ...new Set(
      (Array.isArray(list) ? list : []).map((value) =>
        String(value ?? "").trim(),
      ),
    ),
  ];
  return unique.filter(isValidShortId).slice(0, 20);
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
      // EXACT whole-value match (after quote strip and a BOUNDARY-VALID
      // trailing-comment strip — `<repo>#garbage` is one malformed scalar,
      // not a repo plus comment) — never substring extraction: pulling an
      // allowlisted slug out of surrounding text would turn e.g.
      // "not mento-protocol/frontend-monorepo" into a projection target.
      // Anything that isn't a bare owner/name slug parses as empty
      // (-> treated as unrecognized, no projection).
      const value = stripYamlQuotes(stripTrailingYamlComment(rest).trim());
      out.affected_repo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
        ? value
        : "";
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
