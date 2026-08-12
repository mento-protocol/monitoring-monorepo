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

// Authorship marker appended to EVERY comment the triage LLM posts, by the
// only tool that can post one (scripts/sentry-triage-agent-comment.mjs, issue
// #1288). The deterministic pipeline scripts never emit it, and the agent has
// no other write path, so "body contains this marker" is a sound test for
// agent-authored text — which the `github-actions[bot]` identity alone cannot
// give, since the scripts and the agent share it (see TRUSTED_COMMENT_AUTHORS
// below). Defined in this contract module so the emitter and any future
// consumer cannot drift.
export const AGENT_COMMENT_MARKER = "<!-- sentry-triage-agent-authored:v1 -->";

export const PROJECTED_LABEL = "sentry:projected";

// Machine-parseable prefix of the pointer comment the projection step posts on
// the queue stub (`markStubProjected`). It is the CONTRACT the outcome digest's
// "Routed to owning repo" section reads to link the projected owning-repo issue
// (a trusted-bot comment `<prefix><https github.com url>`). Defined here — the
// pure contract module — so the emitter (sentry-triage-project.mjs) and the
// consumer (sentry-triage-digest.mjs) can never drift.
export const PROJECTED_COMMENT_PREFIX = "Projected to owning repo: ";

// First line of the Phase 2a archive leg's audit comment on a queue stub. The
// archive leg emits it (`buildAuditComment`) and treats it as the at-most-once
// key for that post, so a dispatch retry cannot double-audit.
//
// It is NOT a trust fence, and must never be used as one. The triage agent's
// LLM-authored comment is posted with `github.token`, so it passes
// `isTrustedComment` exactly like the deterministic scripts do, and a marker is
// just text any comment author can write. The freshness baseline (issue #1371)
// lives in the queue-stub BODY for that reason — no untrusted step holds a tool
// grant that edits a body. Defined here — the pure contract module — for
// the same reason as PROJECTED_COMMENT_PREFIX above: the emitter
// (sentry-triage-archive.mjs) and any consumer read one definition, so the two
// cannot drift.
export const ARCHIVE_COMMENT_MARKER = "<!-- sentry-triage-archive:v1 -->";

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

// ---------------------------------------------------------------------------
// Lowest layer, re-exported so this module stays the verdict contract's single
// import surface: scripts/sentry-triage-text.mjs — untrusted-text
// neutralization/bounding AND SHORT-ID validation (#1748, extended #1769). It
// imports nothing, so every layer can sit on it without a cycle.
//
// The projected-issue rendering (owning-repo body/title, alias comment,
// idempotency marker + back-link matchers) is a SECOND file-size split,
// scripts/sentry-triage-projection.mjs (#1769) — but it is deliberately NOT
// re-exported here. Only the projection LEG (scripts/sentry-triage-project.mjs)
// needs it, and it imports it directly. Re-exporting it here would pull the
// renderer into the runtime closure of every project-core importer, including
// the untrusted triage agent's write wrapper (sentry-triage-agent-comment.mjs),
// whose staged closure is kept minimal on purpose (a test in
// sentry-triage-agent-comment.test.mjs pins it). sentry-triage-projection.mjs
// sits ON this contract (it imports the SHORT-ID helpers from the text layer),
// and this file does not import it back, so there is no cycle either way.
// ---------------------------------------------------------------------------

export {
  boundBriefList,
  boundBriefText,
  collectBlockScalar,
  defangBackticks,
  defangHtmlComments,
  defangMentions,
  FIX_SCOPE_ARCHITECTURAL,
  FIX_SCOPE_MECHANICAL,
  isValidShortId,
  MAX_BRIEF_TEXT_LEN,
  neutralizeBlock,
  neutralizeUntrusted,
  normalizeFixScope,
  sanitizeDuplicateIds,
  sanitizeFreeText,
  stripTrailingYamlComment,
  stripYamlQuotes,
  truncate,
  VALID_FIX_SCOPES,
} from "./sentry-triage-text.mjs";

// `export … from` re-exports without binding the names locally, and the parsing
// and validation below use several of them.
import {
  boundBriefText,
  collectBlockScalar,
  normalizeFixScope,
  sanitizeDuplicateIds,
  sanitizeFreeText,
  stripTrailingYamlComment,
  stripYamlQuotes,
  truncate,
} from "./sentry-triage-text.mjs";

// ---------------------------------------------------------------------------
// Pure parsing: queue title, permalink, verdict comment (richer than digest).
// ---------------------------------------------------------------------------

// Queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`.
const QUEUE_TITLE_PATTERN = /^\[sentry\]\s+(\S+)\s+\(/;

export function parseShortId(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  return match ? match[1] : null;
}

// `isValidShortId` now lives in sentry-triage-text.mjs (re-exported above): the
// projection renderer needs it too, and keeping it on the lowest layer lets that
// module sit on the text layer without importing this contract.

// A validated permalink is later embedded in Slack mrkdwn link syntax
// (`<url|text>`, in the digest's `link()`), so `<`, `>`, `|` in the URL would
// break out of the link — spoofing the display text or splitting the Slack
// block. Reject those plus any ASCII control char or whitespace (space, tab,
// newline, …). `new URL()` accepts all of them in the path/query and these
// validators return the RAW input string, so the shape check must run on the
// original — not on the re-encoded `parsed.href`.
// eslint-disable-next-line no-control-regex -- rejecting control chars in a link target is the point
const UNSAFE_URL_CHARS = /[<>|\x00-\x20\x7f]/;

function isSafeSentryPermalink(url) {
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

function parseInlineList(rest) {
  const trimmed = String(rest ?? "").trim();
  if (trimmed.startsWith("[")) {
    // Parse the bracketed segment, tolerating ONLY a trailing yaml comment after
    // `]` (the documented example is `duplicate_of: [] # …`, which an EOL-anchored
    // match would drop); any other trailing garbage rejects the whole list, so
    // malformed agent output is never normalized into valid-looking IDs.
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
      // Decode like a flow item (#1769 round 17), not just strip outer quotes.
      items.push(decodeScalar(dash[1]));
      continue;
    }
    if (/^\s/.test(line)) continue; // other indented content — skip
    break;
  }
  return { items, next: j };
}

// Hard budget on how many duplicate SHORT-IDs may drive owning-repo lookups.
// The list is agent-produced from untrusted Sentry content, and every entry
// costs cross-repo searches (plus bounded candidate reads) — a real verdict
// names a handful of duplicates, so anything past this cap is noise. Applied
// at the CONSUMPTION point in runProjection, AFTER the stub's own SHORT-ID is
// excluded — capping before the self-exclusion could let a self-reference
// consume budget and push a real duplicate past the cap.
export const MAX_DUPLICATE_LOOKUPS = 5;

// Hard bound on how many free-text brief-list items (needs-human
// `how_to_check` / `decision_branches` / `hypotheses` / `investigated`) are
// retained. These are agent-produced from untrusted Sentry content and consumed
// ONLY by the two needs-human brief emitters — the outcome digest and the queue
// stub's brief comment (they never reach an owning-repo issue: needs-human
// never projects) — so a scannable handful is enough; per-item text is
// neutralized+bounded by each emitter at render time.
export const MAX_BRIEF_LIST_ITEMS = 5;

/** Parse a free-text yaml list value (any needs-human brief list): an inline
 * `[a, b]`, a single inline scalar, or a block `- item` list. Unlike
 * sanitizeDuplicateIds these entries are prose, so nothing is shape-validated
 * away — each emitter neutralizes+escapes them at render. Returns `{items,
 * next}` mirroring collectDashList so the caller advances the line cursor. */
// The COMPLETE YAML 1.1/1.2 double-quoted single-char escape set. DECODING (not
// backslash-dropping) is the point (#1769 round 13); hex `\x`/`\u`/`\U` below.
const YAML_DQ_ESCAPES = {
  0: "\0", // null (U+0000)
  a: "\x07", // bell
  b: "\b", // backspace
  t: "\t", // tab
  n: "\n", // line feed
  v: "\v", // vertical tab
  f: "\f", // form feed
  r: "\r", // carriage return
  e: "\x1b", // escape
  " ": " ", // escaped space -> space
  '"': '"', // double quote
  "/": "/", // slash
  "\\": "\\", // backslash
  N: "\x85", // next line (NEL)
  _: "\xa0", // non-breaking space
  L: "\u2028", // line separator
  P: "\u2029", // paragraph separator
};
const YAML_DQ_HEX = { x: 2, u: 4, U: 8 };

/**
 * Decode ONE YAML double-quoted escape at `s[i]` (`s[i]` is the backslash).
 * Returns `{ text, next }` (next = index just past the escape) or null for an
 * unknown/invalid escape — the caller then rejects the whole inline sequence
 * rather than silently corrupting it.
 */
export function decodeDoubleQuoteEscape(s, i) {
  const e = s[i + 1];
  if (e === undefined) return null; // trailing backslash
  if (Object.hasOwn(YAML_DQ_HEX, e)) {
    const len = YAML_DQ_HEX[e];
    const hex = s.slice(i + 2, i + 2 + len);
    if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff) return null;
    return { text: String.fromCodePoint(code), next: i + 2 + len };
  }
  if (Object.hasOwn(YAML_DQ_ESCAPES, e)) {
    return { text: YAML_DQ_ESCAPES[e], next: i + 2 };
  }
  return null; // unknown escape
}

// One dependency-free, single-pass parser for an inline YAML flow sequence of
// strings (the workflows run with NO install — #1769 round 11 P1). It covers all
// three scalar styles below; the style is set by the item's FIRST character, so a
// quote inside a plain scalar never mis-splits it, and any non-scalar item (a
// nested `[`/`{`, or an `&`/`*`/`!` node property) REJECTS the whole sequence.
// decodeScalar reuses these readers for dash items, so both list forms decode
// identically (#1769 round 17).

/** Read a double-quoted scalar at `s[i]` (the opening quote), or null. */
function parseDoubleQuotedScalar(s, i) {
  let buf = "";
  for (let j = i + 1; j < s.length; ) {
    const c = s[j];
    if (c === "\\") {
      // DECODE (never drop the backslash); an invalid escape rejects the whole.
      const decoded = decodeDoubleQuoteEscape(s, j);
      if (decoded === null) return null;
      buf += decoded.text;
      j = decoded.next;
    } else if (c === '"') {
      return { value: buf, next: j + 1 };
    } else {
      buf += c;
      j += 1;
    }
  }
  return null; // unterminated
}

/** Read a single-quoted scalar at `s[i]` (the opening quote), or null. */
function parseSingleQuotedScalar(s, i) {
  let buf = "";
  for (let j = i + 1; j < s.length; ) {
    const c = s[j];
    if (c === "'") {
      if (s[j + 1] === "'") {
        buf += "'"; // doubled single-quote -> one literal quote
        j += 2;
      } else {
        return { value: buf, next: j + 1 };
      }
    } else {
      buf += c;
      j += 1;
    }
  }
  return null; // unterminated
}

/** Read a plain (unquoted) scalar at `s[i]`: runs to the next top-level `,`/`]`,
 * quotes/apostrophes/backslashes literal; a `[`/`{`/`}` rejects the sequence. */
function parsePlainScalar(s, i) {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === "," || c === "]") break;
    if (c === "[" || c === "{" || c === "}") return null;
    j += 1;
  }
  return { value: s.slice(i, j).trim(), next: j };
}

/** Read ONE flow item at `s[i]` (first non-whitespace char), or null to reject. */
function parseFlowItem(s, i) {
  const ch = s[i];
  if (ch === '"') return parseDoubleQuotedScalar(s, i);
  if (ch === "'") return parseSingleQuotedScalar(s, i);
  // Nested collections and node properties are not string scalars: reject the
  // whole sequence rather than misparse a construct this field can't hold.
  if (ch === "[" || ch === "{" || ch === "&" || ch === "*" || ch === "!") {
    return null;
  }
  return parsePlainScalar(s, i);
}

// Decode ONE complete YAML scalar TOKEN (a `- item` dash value or a same-line
// scalar) through the SAME readers the flow parser uses, so a quoted dash item
// decodes IDENTICALLY to a quoted flow item (#1769 round 17). Plain = literal; a
// malformed quoted token keeps its content (outer quotes stripped), uncorrupted.
export function decodeScalar(raw) {
  const s = String(raw ?? "").trim();
  const read = { '"': parseDoubleQuotedScalar, "'": parseSingleQuotedScalar }[
    s[0]
  ];
  if (!read) return s; // plain scalar -> literal
  const parsed = read(s, 0);
  return parsed && parsed.next === s.length ? parsed.value : stripYamlQuotes(s);
}

function parseInlineFlowSequence(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("[")) return null;
  const items = [];
  let i = 1; // past the opening `[`
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i += 1; // inter-item whitespace
    if (i >= s.length) return null; // no closing `]` -> unterminated
    if (s[i] === "]") {
      i += 1;
      break;
    }
    if (s[i] === ",") {
      i += 1; // leading/consecutive/trailing comma -> empty item, dropped below
      continue;
    }
    const item = parseFlowItem(s, i);
    if (item === null) return null;
    items.push(item.value);
    i = item.next;
    while (i < s.length && /\s/.test(s[i])) i += 1; // whitespace after the scalar
    if (i >= s.length) return null; // unterminated
    if (s[i] === ",") {
      i += 1;
      continue;
    }
    if (s[i] === "]") {
      i += 1;
      break;
    }
    return null; // junk after a scalar (e.g. `"a" b`) -> not a clean sequence
  }
  // After the matching `]`, tolerate only trailing whitespace or a comment.
  while (i < s.length) {
    if (s[i] === "#") break;
    if (!/\s/.test(s[i])) return null;
    i += 1;
  }
  return items.map((item) => item.trim()).filter(Boolean);
}

function parseFreeTextList(lines, i, rest) {
  const trimmed = String(rest ?? "").trim();
  // A comment-only remainder (`how_to_check: # …`) is a documented-but-empty key:
  // YAML drops the comment and the real list is the dash block below; recording
  // the sample comment as the sole item would bury the real items (#1769 round 5).
  const isCommentOnly =
    trimmed !== "" && stripTrailingYamlComment(trimmed).trim() === "";
  if (trimmed !== "" && !isCommentOnly) {
    if (trimmed.startsWith("[")) {
      // A valid flow sequence IS the list; a malformed one becomes a single
      // item, never silently truncated at a bracket/comma inside a quote.
      const items = parseInlineFlowSequence(trimmed);
      return { items: items ?? [stripYamlQuotes(trimmed)], next: i + 1 };
    }
    // A same-line scalar (`how_to_check: "Yes → fix"`) decodes like a flow item.
    return { items: [decodeScalar(trimmed)], next: i + 1 };
  }
  return collectDashList(lines, i);
}

// Trim, cap, and drop items empty AFTER neutralization (not a bare `Boolean`):
// the escape decoder yields control-only items (`["\a"]`, `["\0"]`) that strip to
// "" at render, which would settle a needs-human verdict then show an empty
// section. Every brief list field routes through this one helper (#1769 r15).
export function sanitizeBriefList(list) {
  return (Array.isArray(list) ? list : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => sanitizeFreeText(value) !== "")
    .slice(0, MAX_BRIEF_LIST_ITEMS);
}

// `sanitizeDuplicateIds` now lives in sentry-triage-text.mjs (re-exported
// above), beside `isValidShortId` it depends on; parseVerdictYaml below still
// calls it through the local import.

/**
 * Line-oriented, tolerant parse of the verdict yaml — deliberately NOT a real
 * yaml loader (the block is untrusted agent text). Reads verdict/confidence as
 * their leading enum token, affected_repo as the first `owner/name` slug,
 * summary as its full line value, root_cause/proposed_action as block scalars,
 * duplicate_of as an inline `[...]` or a `- item` list, and fix_scope as a
 * whole-value token normalized onto its closed enum (fail-closed).
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
    // Set for `code-fix` verdicts; normalized (fail-closed) below, so an absent
    // key leaves the raw empty string and resolves to `architectural`.
    fix_scope: "",
    // needs-human decision-ready brief fields (optional-absent for other
    // verdicts; resolveVerdict requires human_question for needs-human).
    human_question: "",
    how_to_check: [],
    decision_branches: [],
    hypotheses: [],
    investigated: [],
    escalation_reason: "",
  };
  // How many `fix_scope:` key lines the block carried. More than one FAILS
  // CLOSED (issue #1785). A last-wins assignment is the default a line-oriented
  // parse falls into, and here it is exploitable: `collectBlockScalar` ends a
  // block scalar at the first column-0 line, so agent-transcribed Sentry text
  // inside `root_cause`/`proposed_action` — which an unauthenticated dashboard
  // visitor supplies — can escape as a `fix_scope: mechanical` key line and
  // override the honest value. Two occurrences in EITHER order normalize to
  // `architectural`, so position in the template stops being load-bearing.
  let fixScopeKeyLines = 0;
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
      // EXACT whole-value match (after quote + boundary-valid trailing-comment
      // strip), never substring extraction: pulling an allowlisted slug out of
      // surrounding text would turn e.g. "not mento-protocol/frontend-monorepo"
      // into a projection target. A non-slug value parses as empty (unrecognized).
      const value = stripYamlQuotes(stripTrailingYamlComment(rest).trim());
      out.affected_repo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
        ? value
        : "";
    } else if (key === "summary") {
      out.summary = stripYamlQuotes(rest);
    } else if (
      key === "root_cause" ||
      key === "proposed_action" ||
      key === "human_question" ||
      key === "escalation_reason"
    ) {
      const { text, next } = collectBlockScalar(lines, i, rest);
      out[key] = text;
      i = next - 1;
    } else if (key === "fix_scope") {
      fixScopeKeyLines += 1;
      // EXACT whole-value match (after quote + boundary-valid trailing-comment
      // strip), never the leading-token extraction `verdict`/`confidence` use:
      // the observed architectural verdicts opened their prose with
      // "Non-urgent: …", and a prefix parse would let `mechanical refactor of
      // the cache layer` read as `mechanical`. Anything that is not exactly one
      // enum word normalizes to `architectural` below.
      out.fix_scope = stripYamlQuotes(stripTrailingYamlComment(rest).trim());
    } else if (key === "duplicate_of") {
      if (rest.trim() !== "") {
        out.duplicate_of = parseInlineList(rest);
      } else {
        const { items, next } = collectDashList(lines, i);
        out.duplicate_of = items;
        i = next - 1;
      }
    } else if (
      key === "hypotheses" ||
      key === "investigated" ||
      key === "how_to_check" ||
      key === "decision_branches"
    ) {
      const { items, next } = parseFreeTextList(lines, i, rest);
      out[key] = items;
      i = next - 1;
    }
  }
  out.duplicate_of = sanitizeDuplicateIds(out.duplicate_of);
  out.fix_scope = normalizeFixScope(fixScopeKeyLines > 1 ? "" : out.fix_scope);
  out.how_to_check = sanitizeBriefList(out.how_to_check);
  out.decision_branches = sanitizeBriefList(out.decision_branches);
  out.hypotheses = sanitizeBriefList(out.hypotheses);
  out.investigated = sanitizeBriefList(out.investigated);
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
    // Already on the closed enum (parseVerdictYaml normalized it once); this is
    // a rename only, so the fail-closed default has a single owner.
    fixScope: parsed.fix_scope,
    // needs-human decision-ready brief fields (empty for other verdicts).
    humanQuestion: parsed.human_question,
    howToCheck: parsed.how_to_check,
    decisionBranches: parsed.decision_branches,
    hypotheses: parsed.hypotheses,
    investigated: parsed.investigated,
    escalationReason: parsed.escalation_reason,
  };
}

/**
 * The SINGLE field selection behind every needs-human brief: which parsed
 * verdict fields a brief may render, in which shape, under which bound.
 * Returns sanitized single-line strings plus the raw-but-capped item lists the
 * GitHub emitter renders as bullets (each item still bounded individually).
 *
 * Sharing this is the point (#1748): the Slack digest and the queue-issue brief
 * are two emitters over ONE selection, so a field added to the verdict contract
 * cannot land on one surface and silently miss the other, and a bound cannot
 * drift between them. Escaping stays per-surface — Slack mrkdwn and GitHub
 * markdown neutralize different characters.
 */
export function selectNeedsHumanBriefFields(parsed) {
  return {
    question: boundBriefText(parsed?.humanQuestion),
    howToCheck: sanitizeBriefList(parsed?.howToCheck).map(boundBriefText),
    decisionBranches: sanitizeBriefList(parsed?.decisionBranches).map(
      boundBriefText,
    ),
    hypotheses: sanitizeBriefList(parsed?.hypotheses).map(boundBriefText),
    investigated: sanitizeBriefList(parsed?.investigated).map(boundBriefText),
    escalationReason: boundBriefText(parsed?.escalationReason),
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
//
// KNOWN LIMIT of this fence: the triage LLM posts under the same bot identity,
// so authorship alone cannot separate agent text from deterministic-script
// text. The agent's write wrapper (issue #1288) closes that by construction for
// every prefix-anchored consumer — it requires an agent body to START with
// VERDICT_MARKER, so no agent comment can impersonate REGRESSION_PREFIX,
// PROJECTED_COMMENT_PREFIX, or AUTOFIX_COMMENT_PREFIX — and it stamps
// AGENT_COMMENT_MARKER so a consumer that wants to reject agent text outright
// has a positive test to use. The verdict comment is agent text BY DESIGN and
// stays trusted-as-data: it is enum-validated and never interpolated.
export const TRUSTED_COMMENT_AUTHORS = [
  "github-actions",
  "github-actions[bot]",
];

export function isTrustedComment(comment) {
  const login = comment?.author?.login ?? comment?.user?.login ?? "";
  return TRUSTED_COMMENT_AUTHORS.includes(login);
}

/**
 * Pick the first comment that is BOTH author-trusted (`isTrustedComment`) AND
 * anchored at the start of its body by `marker` (`startsWith`, not
 * `includes`) — the shared fence primitive behind every rolling run-record
 * writer (the ingest's `RUN_RECORD_MARKER` and the autofix leg's
 * `AUTOFIX_RUN_RECORD_MARKER`), so the writers share one implementation
 * instead of two hand-kept copies that could drift apart. This repo is
 * public and #1282 is open, so without both fences an untrusted commenter
 * could plant the marker anywhere in a comment body and have the next run's
 * PATCH land in their comment instead of the pipeline's own record. Null-safe
 * on a missing/undefined `comments` list.
 */
export function selectMarkedComment(comments, marker) {
  return (
    (comments ?? []).find(
      (comment) =>
        typeof comment?.body === "string" &&
        isTrustedComment(comment) &&
        comment.body.startsWith(marker),
    ) ?? null
  );
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
    return { body: null, reason: "no-verdict-comment", url: null };
  const newestVerdict = verdicts[verdicts.length - 1];

  const regressions = list
    .filter((comment) => comment.body.startsWith(REGRESSION_PREFIX))
    .sort(compareCreatedAt);
  if (regressions.length > 0) {
    const newestRegression = regressions[regressions.length - 1];
    if (
      !(String(newestVerdict.createdAt) > String(newestRegression.createdAt))
    ) {
      return { body: null, reason: "stale-verdict", url: null };
    }
  }
  // `url` identifies which verdict comment was selected — its numeric
  // #issuecomment-<n> id is the autofix generation token (issue #1506): a
  // re-triage APPENDS a fresh verdict comment (Stage A reopen sheds the label,
  // triage re-posts), so a shed-then-re-added verdict changes this url even when
  // the label is present again, which is what label-presence alone cannot see.
  return {
    body: newestVerdict.body,
    reason: null,
    url: typeof newestVerdict.url === "string" ? newestVerdict.url : null,
  };
}

// Parse the numeric REST id from a GitHub issue-comment url
// (`…#issuecomment-<n>`). gh's comment `.id` is an opaque GraphQL node id; the
// numeric id from the url is stable, log-safe, and trivially validated
// (`^[0-9]+$`) — the shape the autofix matrix threads as its generation token.
// Returns the numeric string, or null if the url is missing/unparsable.
export function verdictCommentIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/#issuecomment-(\d+)\s*$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Round binding (issue #1717): which verdict comment was already on the stub
// BEFORE this triage round ran.
// ---------------------------------------------------------------------------

/** No trusted, admissible verdict comment existed before the round. */
export const PRIOR_VERDICT_NONE = "none";
/** The pre-round read failed, or produced a comment with no parseable id.
 * Distinct from `none` on purpose: `none` is a fact ("nothing was there"),
 * `unknown` is an absence of evidence, and only one of them may pass. */
export const PRIOR_VERDICT_UNKNOWN = "unknown";

/** True for the three shapes a prior-verdict token may take: a bare numeric
 * comment id, `none`, or `unknown`. Everything else is a wiring bug. */
export function isPriorVerdictToken(value) {
  return (
    value === PRIOR_VERDICT_NONE ||
    value === PRIOR_VERDICT_UNKNOWN ||
    (typeof value === "string" && /^[0-9]+$/.test(value))
  );
}

/**
 * The round binding itself: given the verdict comment `selectVerdictComment`
 * picked NOW and the token recorded BEFORE the round, decide whether this
 * resolution may settle the stub. Returns null to allow, or a refusal reason.
 *
 * Accept only a comment strictly NEWER than the one the round started from.
 * GitHub issue-comment ids come from one monotonically increasing sequence, so
 * "newer" is a numeric comparison — and comparing rather than merely testing
 * equality also covers the case where the recorded comment was deleted between
 * the two reads, which equality would wave through onto an even older verdict.
 * `unknown` never passes: without a baseline nothing can be proven newer than
 * it, and settling a stub on an unprovable verdict is the failure this closes.
 */
export function priorVerdictRefusal(priorToken, selectedUrl) {
  if (priorToken == null) return null; // no binding requested (projection path)
  if (!isPriorVerdictToken(priorToken)) {
    return `prior-verdict token ${JSON.stringify(priorToken)} is not a comment id, '${PRIOR_VERDICT_NONE}' or '${PRIOR_VERDICT_UNKNOWN}'`;
  }
  if (priorToken === PRIOR_VERDICT_UNKNOWN) {
    return "the verdict comment present before this triage round could not be read, so no verdict can be shown to postdate it";
  }
  if (priorToken === PRIOR_VERDICT_NONE) return null;
  const selectedId = verdictCommentIdFromUrl(selectedUrl);
  if (selectedId === null) {
    return `the selected verdict comment carries no parseable comment id (url=${selectedUrl}), so it cannot be shown to postdate comment ${priorToken}`;
  }
  if (BigInt(selectedId) > BigInt(priorToken)) return null;
  return selectedId === priorToken
    ? `the newest usable verdict comment (${selectedId}) is the one that was already on the stub before this triage round — the round posted no verdict of its own`
    : `the newest usable verdict comment (${selectedId}) predates the one recorded before this triage round (${priorToken})`;
}

// Blatant non-decision placeholders that defeat the point of a needs-human
// escalation — "please look" is not a decision. This is a DETERMINISTIC
// BACKSTOP against the laziest bypasses, not a full decision-quality judge (a
// parser can't reliably assess that — the prompt makes decision quality the
// agent's responsibility). Matched EXACTLY against the normalized question
// (lowercased, trailing punctuation stripped) so a real "decide X or Y" that
// merely CONTAINS one of these words is never falsely rejected.
const NON_DECISION_QUESTIONS = new Set([
  "",
  "?",
  "look",
  "look into this",
  "take a look",
  "please look",
  "please look into this",
  "please investigate",
  "investigate",
  "investigate this",
  "needs investigation",
  "needs looking into",
  "needs human",
  "needs human review",
  "needs review",
  "review",
  "review this",
  "check this",
  "tbd",
  "todo",
  "n/a",
  "na",
  "none",
  "unknown",
  "unsure",
]);

/** Normalize a human_question for the placeholder check: single-line, lowered,
 * trailing sentence punctuation stripped. */
function normalizeHumanQuestion(text) {
  return sanitizeFreeText(text)
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .trim();
}

/** True when a needs-human `human_question` is a real decision request (present
 * and not a blatant non-decision placeholder). */
export function isDecisionReadyQuestion(text) {
  return !NON_DECISION_QUESTIONS.has(normalizeHumanQuestion(text));
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
 *
 * `options.priorVerdictCommentId` binds the resolution to the ROUND that is
 * settling the stub (issue #1717). The regression fence above only catches a
 * verdict older than a fence comment somebody posted; a stub re-queued for
 * bookkeeping reasons carries no fence by design, so without this binding a
 * triage round that dies before posting lets the `verdict` job label and close
 * on the PREVIOUS round's verdict — laundering a regression that landed after
 * ingest's Sentry query into a settled, closed stub. Callers that are already
 * downstream of a settled verdict (projection, autofix select) pass nothing and
 * keep the pre-#1717 behaviour.
 */
export function resolveVerdict(issue, queueIssueNumber, options = {}) {
  const selected = selectVerdictComment(issue.comments);
  if (!selected.body) {
    throw new Error(
      `No usable verdict comment on issue #${queueIssueNumber} (${selected.reason}).`,
    );
  }
  const refusal = priorVerdictRefusal(
    options.priorVerdictCommentId ?? null,
    selected.url,
  );
  if (refusal) {
    throw new Error(
      `Refusing to settle issue #${queueIssueNumber} on a verdict this triage round did not produce: ${refusal}. Leaving sentry:needs-triage in place for re-triage.`,
    );
  }
  const parsed = parseVerdictComment(selected.body);
  if (!parsed.verdict) {
    throw new Error(
      `Verdict comment on issue #${queueIssueNumber} has a missing/invalid verdict value.`,
    );
  }
  // A needs-human verdict is a DECISION request, not "please look": it is only
  // valid when it states the exact question a human must answer. Enforce it in
  // the single authoritative resolver so the workflow's --parse-only label step
  // fails loud (exit 1, sentry:needs-triage kept) on a lazy escalation — an
  // absent `human_question` OR a blatant non-decision placeholder — and the
  // next scheduled run re-triages it, the same fail-loud contract as a
  // missing/invalid verdict above.
  if (parsed.verdict === "needs-human") {
    if (!isDecisionReadyQuestion(parsed.humanQuestion)) {
      throw new Error(
        `needs-human verdict on issue #${queueIssueNumber} has no decision-ready 'human_question' (missing or a non-decision placeholder like "please look"); a needs-human escalation must name the exact question/decision a human must answer. Leaving sentry:needs-triage in place for re-triage.`,
      );
    }
    // A decision-ready escalation also needs the INSTRUCTION half: at least one
    // how_to_check step AND one decision_branch that SURVIVE neutralization —
    // sanitizeBriefList drops control-only items that would render empty, so a
    // question with no real checks/dispositions is rejected (#1769 rounds 11, 15).
    if (
      sanitizeBriefList(parsed.howToCheck).length === 0 ||
      sanitizeBriefList(parsed.decisionBranches).length === 0
    ) {
      throw new Error(
        `needs-human verdict on issue #${queueIssueNumber} is an incomplete brief: it must carry at least one 'how_to_check' step AND at least one 'decision_branch' (a question with no checks or dispositions is not decision-ready). Leaving sentry:needs-triage in place for re-triage.`,
      );
    }
  }
  return {
    parsed,
    verdict: parsed.verdict,
    label: VERDICT_TO_LABEL[parsed.verdict],
    // The url of the verdict comment this resolution is based on — the autofix
    // generation token source (issue #1506).
    verdictCommentUrl: selected.url,
  };
}

// ---------------------------------------------------------------------------
// Allowlist validation. The projected-issue rendering, the alias comment, and
// the idempotency marker/back-link matchers moved to
// sentry-triage-projection.mjs (#1769) and are re-exported at the top of this
// file, so callers still reach them through the verdict contract unchanged.
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
