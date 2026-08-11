/**
 * Pure rendering for the needs-human BRIEF (issue #1748): the marked comment
 * body, the two GitHub markdown escapes, and the inert-block assertion. NO I/O —
 * the lifecycle/orchestration and CLI live in scripts/sentry-triage-brief.mjs,
 * which re-exports every name here so no importer or test changed. Split out
 * (#1769 round 9) to keep the brief leg under the 600-line soft cap in
 * docs/pr-checklists/recurring-review-patterns.md.
 *
 * Security posture (this repo is public and the rendered fields are
 * agent-authored from attacker-reachable Sentry payloads):
 *   - Every free-form field goes through the SHARED bound
 *     (`selectNeedsHumanBriefFields`) then `neutralizeUntrusted` then this
 *     emitter's surface escape `escapeGithubMarkdown`, so agent text can only
 *     ever render as text, never as a link/image/tag/entity of its own.
 *   - The Sentry permalink is validated upstream (`isSafeSentryPermalink`) but
 *     that check is Slack-oriented, so its link DESTINATION is additionally run
 *     through `escapeGithubLinkDestination` (#1769 round 8).
 *   - The displayed `affected_repo` is validated against the projection
 *     allowlist (`validateAffectedRepo`) and an unrecognized value is omitted,
 *     never elevated into a "go look here" pointer (#1769 round 9, ADR 0036).
 *   - `assertInertBlock` fails the write CLOSED if the comment would open with
 *     the verdict marker or reproduce a prefix-anchored control comment, so the
 *     display-only brief stays inert to every prefix-anchored pipeline consumer.
 */

// The autofix pointer prefix is owned by the digest module (it defines the
// emission contract #1278 reads); import it rather than restating the literal.
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  isValidShortId,
  neutralizeUntrusted,
  PROJECTED_COMMENT_PREFIX,
  REGRESSION_PREFIX,
  selectNeedsHumanBriefFields,
  validateAffectedRepo,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";

// The brief comment's anchor. The selector (`findBriefComments`) matches a
// comment by trusted author AND `startsWith(BRIEF_COMMENT_MARKER)` — the same
// fence the rolling run-record writers use — so an untrusted commenter cannot
// plant the marker and have the leg PATCH or DELETE their comment. Escaping
// already stops an agent-authored field from reproducing these literal bytes.
export const BRIEF_COMMENT_MARKER = "<!-- sentry-triage-brief:v1 -->";

// Prefix-anchored control comments elsewhere in the pipeline. The brief must
// never reproduce one at the start of a line — see `assertInertBlock`.
const CONTROL_PREFIXES = [
  VERDICT_MARKER,
  REGRESSION_PREFIX,
  PROJECTED_COMMENT_PREFIX,
  AUTOFIX_COMMENT_PREFIX,
];

// Every character GitHub markdown treats as ACTIVE. A backslash before ASCII
// punctuation is a CommonMark escape, so escaping the whole set costs nothing
// visually — the reader sees the original characters, the renderer sees no
// syntax — which is why the set is deliberately wide rather than minimal.
//
// `&` is in the set because GitHub decodes entity references: leaving it live
// would let `&#60;` render as `<` and reintroduce every character escaped here.
// `<` and `>` cover raw HTML and autolinks; `[` `]` `(` `)` `!` cover links and
// images; `#` `+` `-` `.` cover the block constructs a field could start after
// the renderer's own `- ` bullet prefix; `*` `_` `~` cover emphasis; `|` covers
// table cells; the backslash itself must come first, and does, because the
// class is applied in one pass.
const GITHUB_MARKDOWN_ACTIVE = /[\\`*_[\]()<>&#+.!|~-]/g;

/**
 * The GitHub emitter's surface escape — the counterpart of the Slack emitter's
 * `escapeSlackText`, applied on top of the shared bound + neutralization.
 *
 * Neutralization makes a field single-line and kills backticks and mentions; it
 * does NOT stop the field from RENDERING. A question carrying
 * `[View in Sentry](https://evil.example)` or a step carrying
 * `![ok](https://evil.example/x)` renders as a live link or image next to the
 * pipeline's own trusted controls, which is the whole spoof. After this, agent
 * text can only ever render as text.
 */
export function escapeGithubMarkdown(text) {
  return String(text ?? "").replace(GITHUB_MARKDOWN_ACTIVE, "\\$&");
}

// The chars that let a value break OUT of a markdown link destination `(...)`
// or plant an adjacent `[..](..)` link next to the trusted one: the closing
// paren ends the destination, `[`/`]`/`(` open a new link, backtick a code
// span, and the backslash itself must come first. `<>|` and whitespace/control
// chars are already rejected upstream by `isSafeSentryPermalink`. A URL's own
// `.`/`-`/`/`/`:` are NOT escaped, so a legit permalink still renders as a clean
// link while a hostile one is inert.
const GITHUB_LINK_DESTINATION_ACTIVE = /[\\`()[\]]/g;

/**
 * Escape a URL for use as a GitHub markdown link DESTINATION. The Sentry
 * permalink is validated (`isSafeSentryPermalink`: https `*.sentry.io`, no
 * `<>|`/control chars) but that check is Slack-oriented and lets `)([]` through,
 * so a value like `https://sentry.io/x)[evil](https://evil.example` would render
 * a second active link beside the trusted control. Escaping the
 * destination-breaking chars closes that (#1769 round 8).
 */
export function escapeGithubLinkDestination(url) {
  return String(url ?? "").replace(GITHUB_LINK_DESTINATION_ACTIVE, "\\$&");
}

/** Neutralize AND escape one already-selected, already-bounded field for GitHub
 * markdown. Single-line in, single-line inert text out. */
function renderField(text) {
  return escapeGithubMarkdown(neutralizeUntrusted(text));
}

/** `- item` bullets for one neutralized list; empty list -> no lines. */
function renderBullets(items) {
  return items
    .map((item) => `- ${renderField(item)}`)
    .filter((l) => l !== "- ");
}

/** `- **<label>:** <item>` per list entry, so a collapsed evidence bullet says
 * what kind of evidence it is without a nested list. */
function labelledBullets(label, items) {
  return items
    .map((item) => renderField(item))
    .filter(Boolean)
    .map((item) => `- **${label}:** ${item}`);
}

/**
 * Render the decision-ready brief comment for ONE resolved needs-human verdict.
 *
 * Fixed order, so the format cannot drift comment to comment: marker -> decision
 * header -> the question -> how to check -> what each answer leads to ->
 * everything else collapsed. Sections whose field the verdict did not carry are
 * omitted entirely rather than rendered empty; `human_question` is always
 * present because `resolveVerdict` rejects a needs-human verdict without one.
 *
 * @param {object} args
 * @param {object} args.parsed  parsed verdict comment (parseVerdictComment)
 * @param {string} args.shortId Sentry SHORT-ID from the queue title
 * @param {string|null} args.permalink Sentry permalink from the stub body
 */
export function renderBriefComment({ parsed, shortId, permalink }) {
  const fields = selectNeedsHumanBriefFields(parsed);
  const lines = [BRIEF_COMMENT_MARKER, ""];

  // Header: shape-validated / closed-enum values only, never free text.
  const headerParts = ["**Decision needed**"];
  if (isValidShortId(shortId)) headerParts.push(`\`${shortId}\``);
  if (permalink) {
    headerParts.push(
      `[View in Sentry](${escapeGithubLinkDestination(permalink)})`,
    );
  }
  headerParts.push(`confidence: ${parsed?.confidence ?? "unknown"}`);
  lines.push(`> ${headerParts.join(" · ")}`, "");

  lines.push(`**Question:** ${renderField(fields.question)}`, "");

  if (fields.howToCheck.length) {
    // Only name a repo the pipeline RECOGNIZES. `affected_repo` is agent-emitted
    // from untrusted Sentry data, so a prompt-injected `attacker/evil-repo` is
    // syntactically valid; elevating it into a "go look here" instruction would
    // point a human at an attacker-controlled repo (ADR 0036). validateAffectedRepo
    // is the same allowlist projection uses, and returns a value that is always
    // an allowlisted external repo or this repo — never the raw agent string; an
    // unrecognized (or empty) `affected_repo` is omitted entirely (#1769 round 9).
    const check = validateAffectedRepo(parsed?.affectedRepo);
    const repo =
      check.reason === "allowed" || check.reason === "local-repo"
        ? ` — in \`${check.repo}\``
        : "";
    lines.push(
      `**How to check**${repo}:`,
      "",
      ...renderBullets(fields.howToCheck),
      "",
    );
  }

  if (fields.decisionBranches.length) {
    lines.push("**Then:**", "", ...renderBullets(fields.decisionBranches), "");
  }

  // Justification, not instruction — collapsed, per #1748. Rendered as bullets
  // (never a fence: see the module header).
  const evidence = [];
  if (fields.escalationReason) {
    evidence.push(
      `- **Why escalated:** ${renderField(fields.escalationReason)}`,
    );
  }
  evidence.push(...labelledBullets("Hypothesis", fields.hypotheses));
  evidence.push(...labelledBullets("Checked", fields.investigated));
  if (evidence.length) {
    lines.push(
      "<details><summary>Evidence and context</summary>",
      "",
      ...evidence,
      "",
      "</details>",
      "",
    );
  }

  lines.push(
    "_Rendered by the Sentry triage pipeline from this issue's verdict comment; the machine-readable verdict YAML lives there. This comment is overwritten on re-triage and removed once the verdict is no longer needs-human._",
  );
  return lines.join("\n");
}

/**
 * Fail CLOSED if the assembled comment could be misread by a prefix-anchored
 * consumer: it must not START with the verdict marker, and no line may START
 * with a control-comment prefix. Neither is reachable through a rendered field
 * today (every field is single-line and lands after our own literal prefix),
 * which is exactly why this is an assertion rather than a rewrite — if it ever
 * fires, the renderer changed shape and the change needs a human.
 */
export function assertInertBlock(block) {
  const text = String(block ?? "");
  if (text.startsWith(VERDICT_MARKER)) {
    throw new Error(
      "Refusing to write a brief comment that starts with the verdict marker.",
    );
  }
  for (const line of text.split("\n")) {
    for (const prefix of CONTROL_PREFIXES) {
      if (line.startsWith(prefix)) {
        throw new Error(
          `Refusing to write a brief comment whose line reproduces a pipeline control prefix: ${prefix.trim()}`,
        );
      }
    }
  }
  return text;
}
