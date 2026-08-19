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
 * Split out of `sentry-triage-project-core.mjs` (#1748, extended #1769 and
 * #1785 — which moved the two yaml-scalar strip helpers and added the
 * `fix_scope` enum) as that file kept brushing the 1,000-line hard cap in
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

/** Strip one layer of matching yaml quotes from a scalar value. */
export function stripYamlQuotes(value) {
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

/** Strip a trailing yaml comment — but only a `#` that opens one at a valid
 * boundary (preceded by whitespace, or the whole value). A bare `foo#bar` is
 * part of the scalar in yaml, and truncating it would normalize malformed
 * values into valid-looking ones (e.g. `<repo>#garbage` must NOT become an
 * allowlisted repo). */
export function stripTrailingYamlComment(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/**
 * Collect a yaml BLOCK SCALAR (`key: |` / `key: >`), returning `{ text, next }`
 * where `next` is the index of the first line that is NOT part of it. A value on
 * the same line is not a block indicator and comes back as a plain,
 * quote-stripped scalar.
 *
 * It terminates at the first line that does not start with whitespace — plain
 * yaml, and the reason a caller must treat a REPEATED key as hostile rather than
 * as an overwrite: the block content here is agent-transcribed Sentry text, so a
 * column-0 line inside it ends the scalar and is handed straight back to the
 * caller's key loop (`parseVerdictYaml` fails `fix_scope` closed on a repeat for
 * exactly this reason).
 */
export function collectBlockScalar(lines, start, rest) {
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

// `fix_scope` splits what `code-fix` used to conflate (issue #1785): the
// verdict answers "is the cause in OUR code?", this field answers "does a
// SCOPED fix exist?". They diverged on the only real data we have — all five
// refused candidates were `code-fix` whose proposed action was "move the
// strategy-probe cache/dedup to a shared/server-side layer", an architecture
// change handed to an agent capped at a scoped diff.
export const FIX_SCOPE_MECHANICAL = "mechanical";
export const FIX_SCOPE_ARCHITECTURAL = "architectural";
export const VALID_FIX_SCOPES = [FIX_SCOPE_MECHANICAL, FIX_SCOPE_ARCHITECTURAL];

/**
 * Normalize the untrusted, agent-authored `fix_scope` onto the closed enum.
 *
 * FAILS CLOSED to `architectural` — absent, empty, or anything outside the two
 * words. The asymmetry is deliberate: a missed `mechanical` costs one
 * un-attempted fix, while a wrong `mechanical` spends an agent run on a
 * refactor it must then refuse, which is the failure already observed. Every
 * verdict written before the field existed therefore lands on `architectural`,
 * which is the intended behaviour — autofix selects nothing until the prompt
 * starts producing the field.
 *
 * This is the ONE place the default lives; `parseVerdictYaml` calls it once, so
 * no consumer can re-derive a different fallback — including for the REPEATED
 * key, which that caller routes here as `""` rather than resolving itself.
 */
export function normalizeFixScope(value) {
  // Strings only, deliberately no `String(value)` coercion: `["mechanical"]`
  // stringifies to `mechanical`, so a list-shaped value would read as a scalar
  // claim. A non-string is a shape the contract never promised — fail closed.
  if (typeof value !== "string") return FIX_SCOPE_ARCHITECTURAL;
  const token = value.trim().toLowerCase();
  return VALID_FIX_SCOPES.includes(token) ? token : FIX_SCOPE_ARCHITECTURAL;
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
