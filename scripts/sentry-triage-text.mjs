/**
 * Untrusted-text neutralization, bounding, and SHORT-ID validation for the
 * Sentry triage pipeline.
 *
 * Sentry payloads are attacker-reachable and this repo is PUBLIC, so every
 * string derived from one is single-lined, defanged and bounded before it
 * reaches an issue, a comment or a Slack message. Those transforms — plus the
 * SHORT-ID shape check every marker/back-link and header leans on — are the
 * lowest layer of the pipeline: they depend on nothing, and the verdict
 * contract, the queue contract, the projection renderer and both brief emitters
 * all sit on top of them.
 *
 * Split out of `sentry-triage-project-core.mjs` (#1748, extended #1769) as that
 * file kept brushing the 1,000-line hard cap in
 * docs/pr-checklists/recurring-review-patterns.md. It is a MOVE, not a rewrite:
 * `sentry-triage-project-core.mjs` re-exports every name below, so no importer
 * or test changed. Keeping the re-export is deliberate — the verdict contract
 * stays one import surface for its consumers, and this module stays the one
 * place the helpers are defined.
 *
 * NOTHING here may import from another pipeline module. That is what keeps it
 * usable from every layer without a cycle.
 */

// ---------------------------------------------------------------------------
// Neutralization.
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
 * so agent text can never embed a marker-shaped sequence — e.g. a spoofed
 * `<!-- sentry-projection:v1 OTHER-ID -->` inside a rendered verdict field —
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

// ---------------------------------------------------------------------------
// The needs-human brief's shared bound (#1748).
// ---------------------------------------------------------------------------

// Hard bound on each rendered needs-human brief field. Applied BEFORE either
// emitter's surface escape, so the bound governs the human-visible text rather
// than the entity soup an escape expands it into (an all-`<` value grows ~4x in
// Slack and ~1x on GitHub — bounding first makes the two agree).
export const MAX_BRIEF_TEXT_LEN = 400;

/** Single-line, hard-bounded projection of ONE untrusted brief field. Shared
 * pre-escape stage for both emitters (Slack digest, GitHub issue brief) so the
 * two surfaces can never disagree about what a field is or how long it may be;
 * each emitter applies its own escape on top (`escapeSlackText` /
 * `escapeGithubMarkdown`). */
export function boundBriefText(text) {
  return truncate(sanitizeFreeText(text), MAX_BRIEF_TEXT_LEN);
}

/** Single-line, hard-bounded projection of a brief LIST, items joined with
 * "; " so the whole line obeys the same bound. Empty in -> "" (callers omit
 * the line).
 *
 * The bound here is NOT redundant with the per-item bound the selection
 * applies: that one governs each item, this one governs the joined LINE, and
 * five bounded items would otherwise render five times the bound. */
export function boundBriefList(items) {
  const joined = (Array.isArray(items) ? items : [])
    .map((item) => sanitizeFreeText(item))
    .filter(Boolean)
    .join("; ");
  return joined ? boundBriefText(joined) : "";
}

// ---------------------------------------------------------------------------
// SHORT-ID validation. A Sentry SHORT-ID is Sentry-assigned but still transits
// an untrusted channel, and it drives HTML-comment markers, owning-repo search
// queries and brief headers — so its shape is validated at this lowest layer,
// shared by the verdict contract, the projection renderer and the brief.
// ---------------------------------------------------------------------------

// Sentry SHORT-IDs look like `GOVERNANCE-MENTO-ORG-51` — always
// `<PROJECT-SLUG>-<SUFFIX>` where the suffix is Sentry's base-36 issue
// counter (numeric early on, alphanumeric later: `APP-MENTO-ORG-2S`).
// Requiring the trailing `-<alnum>` (not just a safe charset) keeps bare
// common words like "Sentry" from validating, since every accepted value can
// drive an owning-repo search. Do NOT require a decimal-only suffix: that
// would make base-36 short IDs permanently unprojectable.
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9]+$/;

export function isValidShortId(shortId) {
  return (
    typeof shortId === "string" &&
    shortId.length > 0 &&
    shortId.length <= 120 &&
    SHORT_ID_PATTERN.test(shortId)
  );
}

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
