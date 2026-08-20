import { createHash } from "node:crypto";

const COMMONMARK_ASCII_PUNCTUATION_ESCAPE =
  /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g;
const CLAUDE_TASK_COMPLETION_LINE =
  /^\*\*Claude\s+finished\s+@[A-Za-z0-9_-]+'s\s+task\s+in\s+\d+m\s+\d+s\*\*(?:\s+——\s+\[View\s+job\]\(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+\))?$/i;
const CLAUDE_VERDICT_NAMESPACE = /^(?:\*\*)?(?:Overall\s+)?Verdict\s*:/i;
// Emphasis may wrap the whole declaration (`**Verdict: LGTM**`) or only the
// label (`**Verdict:** LGTM`) — the same statement either way. `tail` captures
// anything after the verdict word; `isCleanTail` decides whether it is a plain
// summarizing sentence or a qualification that keeps the review actionable.
const CLAUDE_CLEAN_VERDICT =
  /^(?:\*\*)?(?:Overall\s+)?Verdict:(?:\*\*)?\s*(?:\*\*)?LGTM(?:\*\*)?\s*(?<tail>[\s\S]*)$/i;
const PROSE_PATTERN_LIBRARY_START = Date.parse("2026-08-13T23:08:10Z");
// One source per heading shape, compiled twice: a global form that harvests
// every occurrence from the body, and a single-line form the per-line scan
// uses. Re-spelling either shape would let the harvest and the scan disagree
// about what a review heading is, which is how a heading would slip past
// validation and still be treated as recognized.
const REVIEW_NUMBER_HEADING_SHAPE = String.raw`^#{1,6}\s+Code Review\s+—\s+PR\s+#(\d+)$`;
const REVIEW_TITLE_HEADING_SHAPE = String.raw`^#{1,6}\s+Review:\s+(.{1,200})$`;
const REVIEW_NUMBER_HEADING = new RegExp(REVIEW_NUMBER_HEADING_SHAPE, "gm");
const REVIEW_TITLE_HEADING = new RegExp(REVIEW_TITLE_HEADING_SHAPE, "gim");
// Per-shape single-line forms, each carrying the SAME flags as its harvest
// counterpart minus `g`/`m`: the number heading stays case-sensitive like its
// `gm` harvest, the title heading keeps `i` like its `gim` harvest. They are
// tested against the RAW line, never a trimmed one.
//
// Both properties are load-bearing. The line scan treats a review heading as
// already-validated because harvest checked its PR number and title, so the
// two must agree on exactly which lines are headings. A single combined
// case-insensitive pattern applied to a trimmed line disagreed twice: a
// `   ### Review: <defect>` indented 1-3 spaces is invisible to harvest (whose
// shape anchors `^#`) yet matched here, and a mis-cased `### code review — PR
// #9999` is likewise unharvested but matched. Either one skipped the title and
// PR-number checks entirely and allowlisted a defect on a fail-closed gate.
const REVIEW_NUMBER_HEADING_LINE = new RegExp(REVIEW_NUMBER_HEADING_SHAPE);
const REVIEW_TITLE_HEADING_LINE = new RegExp(REVIEW_TITLE_HEADING_SHAPE, "i");
// `### Review: <PR title>` is the usual heading, but a clean review may instead
// put the verdict there (`### Review: LGTM ✅`). Only the bare verdict word and
// an optional approval mark are allowed — never free text, which would let a
// heading smuggle a finding past the title check.
// Alternation, not a character class: `✔️` is U+2714 plus a variation selector,
// and a combined character inside a class is a lint error and a silent mismatch.
const CLEAN_REVIEW_TITLE = /^LGTM(?:\s*(?:✅|✔️?|\u{1F44D}️?))*$/iu;
const CLEAN_CONCLUSION_PATTERNS = [
  /^No\s+P1\/P2\/P3\s+findings(?:\s*[.—-]\s*(?:clean review|nothing rose above the bar for an inline comment))?[.!]?$/i,
  /^No\s+P1\/P2\s+findings[.!]?$/i,
  /^No\s+inline\s+(?:comments|findings)(?:\s+(?:filed|posted))?(?:\s*[.—-]\s*nothing rose to a P1\/P2\/P3 flag)?[.!]?$/i,
  /^No\s+changes\s+requested[.!]?$/i,
];
// A numbered roll-up entry that states the absence of findings, with the
// severities optionally bracketed and an optional `None — ` lead-in:
// `1. None — no [P1]/[P2]/[P3] findings.` The trailing `tail` is held to the
// same clean-summary rule as a verdict tail, so a roll-up that starts by
// denying findings and then names one stays actionable.
const CLEAN_CONCLUSION_WITH_TAIL =
  /^(?:None\s*[—–-]\s*)?No\s+\[?P1\]?\/\[?P2\]?(?:\/\[?P3\]?)?\s+findings(?<tail>[\s\S]*)$/i;
// A verdict or roll-up may end with a bare sentence terminator, and nothing
// else. Any remaining prose makes the statement actionable.
//
// This is deliberately an allowlist of ONE shape rather than a blacklist of
// finding vocabulary. A tail is unconstrained natural language, so rejecting
// selected terms (priorities, contradiction connectives, action verbs) cannot
// be exhaustive: a defect stated declaratively — `Verdict: LGTM. Anonymous
// callers can delete every stored record.` — carries none of those markers and
// would read as clean. On a fail-closed gate that silently drops real reviewer
// findings before merge, so the only safe rule is that a clean verdict asserts
// cleanliness and says nothing further.
const CLEAN_TAIL_SHAPE = /^[.!]?$/;
// The prefix grammar `reviewLineContent` peels: bullets, numbering, headings,
// and task boxes, in any order and up to three deep. `hasUncheckedTaskBox`
// walks the same pattern and depth — keep them shared, never re-spelled.
const REVIEW_LINE_PREFIX = /^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|\[[ xX-]\]\s+)/;
const REVIEW_LINE_PREFIX_DEPTH = 3;
// An empty (`[ ]`) or negated (`[-]`) task box, once the prefixes before it are
// gone. `[x]`/`[X]` is a completed check and stays eligible.
const UNCHECKED_TASK_BOX = /^\[[ -]\]\s/;
// A horizontal rule carries no assertion, so it is recognized clean evidence.
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;
// Section labels a clean review uses to introduce its findings or roll-up.
// They name a section and assert nothing, so they are recognized clean
// evidence. Emphasis may wrap the label, and the colon is optional. Anything
// else after the label makes the line free prose, which is not recognized.
const CLEAN_SECTION_LABEL =
  /^(?:\*\*)?(?:Numbered\s+findings?\s+roll[- ]?up|Findings|Roll[- ]?up)\s*:?(?:\*\*)?$/i;
// The `#### What I checked` checklist a clean Claude review opens with, and
// the curated topic allowlist that makes it safe evidence. It lives here
// because both Claude-review paths read it: `isExplicitlyCleanClaudeReview` in
// pr-feedback-state-core.mjs validates the checklist inside the preamble that
// precedes paired `Findings`/`Roll-up` headings, and the prose classifier below
// meets the same checklist standing on its own (issue 1968). One definition,
// never two — core imports these, and the claude module never imports core.
//
// The allowlist is what bounds this shape. `- [x] <anything>` is a free
// sentence, so recognizing every ticked box would readmit exactly the
// declarative defect the allowlist scan closed: `- [x] Anonymous callers can
// delete every stored record.` Only a subject built from curated topics counts.
const CLAUDE_CHECKLIST_HEADING = /^#{1,6}\s+What\s+I\s+checked$/i;
const CLAUDE_CHECKLIST_ENTRY = /^-\s+\[([^\]])\]\s+(.{1,200})$/;
const SAFE_CLAUDE_CHECKLIST_TOPICS = new Set([
  "api contract",
  "authentication boundary",
  "checklist routing",
  "ci status",
  "configuration scope",
  "dependency resolution",
  "documentation examples",
  "generated artifacts",
  "operator documentation",
  "parser behavior",
  "parser structure",
  "regression-test coverage",
  "request-path coverage",
  "review title",
  "runtime behavior",
  "schema compatibility",
  "session lifecycle",
  "type safety",
  "unit tests",
  "unit-test coverage",
]);
const LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT =
  /^(?:`pnpm-workspace\.yaml`\s+override\s+syntax\/scope|`pnpm-lock\.yaml`\s+regeneration\s+for\s+unrelated\s+drift|Supply-chain\/lockfile-lint\s+compliance\s+and\s+CI\s+status|Other\s+standalone\s+lockfiles\s+for\s+leftover\s+vulnerable\s+`sharp@0\.34\.5`)$/i;
// The priority marker a finding line opens with, stripped before the rest of
// the line is judged. Shared by the action scan and the P3 evidence check so
// the two cannot disagree about where a finding's text begins.
const PRIORITY_MARKER_PREFIX =
  /^(?:\*\*)?\[?[Pp][0-3]\]?(?:\*\*)?(?:\s*[^A-Za-z0-9\s]\s*|\s+)/;
// The clean-evidence grammar, shared with `isExplicitlyCleanClaudeReview` in
// pr-feedback-state-core.mjs. It lives here because both Claude-review paths
// read it and a second copy drifted from the first within one PR.
//
// A finding line may state the absence of an action, but only when every
// clause that follows is a curated positive observation. `POSITIVE_EVIDENCE`
// is an exact-match allowlist: each entry is one reviewed phrase, never an
// open-ended shape, because anything looser lets a defect ride along behind a
// no-action marker.
// `No action required` is deliberately NOT here, though it reads like a
// sibling of `No action`. The body-level fallback scan in
// `isActionableReviewBotComment` matches `\bAction\s+required\b` through
// REVIEW_CONTRADICTION, so a line carrying it blocks anyway. Advertising it as
// accepted here made the two layers disagree: the grammar called the line
// clean and the gate still blocked it. Narrowing the marker keeps the
// advertised set honest. The alternative — exempting recognized P3 lines from
// the fallback scan — would weaken a fail-closed check to fix a false positive,
// which is the wrong direction on this gate.
const CLEAN_FINDING_MARKER =
  /^(?:None\s+blocking|No[- ]action|Good\s+hygiene|Lockfile\s+diff\s+is\s+fully\s+mechanical)\b[\s:—.,]*(.*)$/i;
const UNSAFE_EVIDENCE_QUALIFIER =
  /\b(?:not|never|cannot|can't|doesn't|does\s+not|fails?\s+to|may|might|could|appears?|seems?|probably|likely|possibly|perhaps|unclear|unknown)\b/i;
const POSITIVE_EVIDENCE =
  /^(?:clean(?:,\s+well\s+scoped)?(?:\s+fix)?|well\s+scoped(?:\s+fix)?|correct|covered|bounded|mechanical|verified|complete|exact\s+removal\s+condition|(?:no|zero|0)\s+(?:errors?|fails?|failed|failures?)(?:\s+(?:and|or)\s+(?:errors?|fails?|failed|failures?))?(?:\s+(?:are|was|were)\s+(?:found|observed|reported))?|no\s+unrelated\s+version\s+bumps?|no\s+vulnerable\s+sharp@0\.34\.5\s+remains?\s+anywhere\s+in\s+(?:the\s+)?repo(?:'s)?\s+lockfiles|parser\s+should\s+continue\s+rejecting\s+malformed\s+input|fallback\s+should\s+stay|fix\s+is\s+correct|override\s+selector\s+is\s+correctly\s+bounded|lockfile\s+churn\s+beyond\s+sharp\s+itself\s+is\s+confirmed\s+mechanical,\s+not\s+scope\s+creep|(?:the\s+)?bounded\s+selector\s+matches\s+the\s+repo(?:'s)?\s+established\s+override\s+pattern|matches\s+repo\s+convention|(?:the\s+)?inline\s+comment\s+documents\s+the\s+advisory|removal\s+condition\s+comment\s+satisfies\s+the\s+temporary\s+override\s+documentation\s+expectation|tests\s+cover\s+the\s+changed\s+paths)$/i;
const EXPLICIT_ACTION_LINE =
  /^(?:\*\*)?(?:Action\s+(?:items?|required)|Changes\s+requested|Needs\s+changes|A\s+fix\s+is\s+required|.{1,160}\s+must\s+be\s+(?:addressed|changed|fixed|implemented|removed|restored|updated|validated)|(?:Please\s+)?(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)|(?:Must|Should|Needs?\s+to)\s+(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate))\b/i;
const INLINE_DIRECT_ACTION =
  /\bplease\s+(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)\b/i;
// `cr-indicator-types` is CodeRabbit's finding marker and the counterpart to
// Cursor's BUGBOT_BUG_ID: a Claude LGTM verdict that quotes or relays one is
// not an explicitly clean review.
const EXPLICIT_SEVERITY =
  /(?:BUGBOT_BUG_ID|<!--\s*cr-indicator-types\s*:|\b(?:Critical|High|Medium|Low)\s+Severity\b|\bSeverity\s*:\s*(?:Critical|High|Medium|Low)\b)/i;
const CLEAN_REVIEW_COMPATIBILITY = new Map([
  [
    "039923882eee9f880165543ef85e1ca251d84b995a78647b41c2b788d02a4885",
    {
      author: "claude[bot]",
      prNumber: "1544",
      commentId: "5060594122",
      headRefOid: "aab83bc74ae0585147a058d92f1f13afac7be109",
    },
  ],
  [
    "5d4832d96803f81363bc0842a4c1aed89e8fb526cb83834d3373aacd30c5be34",
    {
      author: "claude[bot]",
      prNumber: "1595",
      commentId: "5069799124",
      headRefOid: "d4bb77845e635c72b61fa56b375ec3f44b05702e",
    },
  ],
  [
    "e0394033c85a77330e2ee53cab690a2069263c7e792ab3e443c17949bb728db4",
    {
      author: "claude[bot]",
      prNumber: "1600",
      commentId: "5073384440",
      headRefOid: "0ff2700ecbec8d2877caeeaa91bf423cf8fdc2f0",
    },
  ],
  [
    "17628badc56cb6e53b77c559425020b839847e66357614e65a9707f8bf6d7ee9",
    {
      author: "claude[bot]",
      prNumber: "1825",
      commentId: "5278516901",
      headRefOid: "5ce1cad0371551aff0e8b68867a29bb5d2736bf4",
    },
  ],
  [
    "3816022eb21a2e41e0617c719f6daedc8c1c5c282b4b1b2010e4b739b0c3f1c7",
    {
      author: "claude[bot]",
      prNumber: "1837",
      commentId: "5281908631",
      headRefOid: "7d982e05a0256d73d0d7aeafc485dfad338e63ce",
    },
  ],
]);

function normalizedReviewTitle(value) {
  return String(value ?? "")
    .replace(COMMONMARK_ASCII_PUNCTUATION_ESCAPE, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isClaudeAuthor(value) {
  return /^claude(?:\[bot\])?$/i.test(String(value ?? ""));
}

// Guards whatever trails a clean verdict or roll-up entry: only a bare sentence
// terminator passes. See CLEAN_TAIL_SHAPE for why this is an allowlist.
function isCleanTail(tail) {
  return CLEAN_TAIL_SHAPE.test(String(tail ?? "").trim());
}

function matchesCleanVerdict(line) {
  const tail = CLAUDE_CLEAN_VERDICT.exec(line)?.groups?.tail;
  return tail !== undefined && isCleanTail(tail);
}

// True when an unchecked or negated task box sits anywhere in the line's prefix
// run. Mirrors `reviewLineContent`'s peel loop step for step — same pattern,
// same depth — so the two cannot drift into disagreeing about what a prefix is.
function hasUncheckedTaskBox(line) {
  let value = String(line ?? "").trim();
  for (let index = 0; index < REVIEW_LINE_PREFIX_DEPTH; index += 1) {
    if (UNCHECKED_TASK_BOX.test(value)) return true;
    const stripped = value.replace(REVIEW_LINE_PREFIX, "");
    if (stripped === value) break;
    value = stripped;
  }
  return UNCHECKED_TASK_BOX.test(value);
}

function isCleanConclusion(line) {
  // An UNCHECKED task box states an intention, not a result: `- [ ] No P1/P2
  // findings.` is a box the reviewer never ticked. `reviewLineContent` peels
  // `[ ]` along with bullets, numbering, and headings, so the box must be
  // caught before it is peeled — otherwise the line reads as a completed clean
  // assertion and `withoutCleanReviewConclusionLines` also deletes it from the
  // actionable scan.
  //
  // Walk the SAME prefix grammar `reviewLineContent` uses rather than matching
  // one hand-written shape. A single pattern only covered `- [ ]` and missed
  // every other order the peeler accepts — `1. [ ]`, `1) [ ]`, `### [ ]`,
  // `- 1. [ ]` — so the check must follow the peeler step for step.
  if (hasUncheckedTaskBox(line)) return false;
  // Strip list/heading markers so a numbered roll-up entry is judged on its
  // text, not its `1. ` prefix.
  const value = reviewLineContent(line);
  if (CLEAN_CONCLUSION_PATTERNS.some((pattern) => pattern.test(value)))
    return true;
  const tail = CLEAN_CONCLUSION_WITH_TAIL.exec(value)?.groups?.tail;
  return tail !== undefined && isCleanTail(tail);
}

export function withoutCleanReviewConclusionLines(value) {
  return String(value ?? "")
    .split("\n")
    .filter((line) => !isCleanConclusion(line))
    .join("\n");
}

function reviewLineContent(line) {
  let value = String(line ?? "").trim();
  for (let index = 0; index < REVIEW_LINE_PREFIX_DEPTH; index += 1) {
    const stripped = value.replace(REVIEW_LINE_PREFIX, "");
    if (stripped === value) break;
    value = stripped;
  }
  return value;
}

function verdictDeclaration(line) {
  return CLAUDE_VERDICT_NAMESPACE.test(reviewLineContent(line));
}

function priorityAtLineStart(line) {
  return reviewLineContent(line).match(
    /^(?:\*\*)?\[?[Pp]([0-3])\]?(?:\*\*)?(?=[^A-Za-z0-9]|$)/,
  )?.[1];
}

// A finding line's text with its list/heading prefixes and priority marker
// removed, so the evidence check judges the claim rather than the numbering.
function priorityLineContent(line) {
  return reviewLineContent(line).replace(PRIORITY_MARKER_PREFIX, "");
}

// True when a no-action marker is followed only by curated positive
// observations. Every clause after the marker must clear the hedge filter and
// match POSITIVE_EVIDENCE exactly, so a defect appended to a no-action lead-in
// is never read as clean.
// One clause (or a whole tail) counts as clean evidence when it carries no
// hedge and matches the curated allowlist exactly. Shared by both the
// full-tail attempt and the per-clause fallback so the two cannot diverge.
function isCuratedEvidenceClause(evidence) {
  const withoutSafeNegation = evidence.replace(/,\s+not\s+scope\s+creep$/i, "");
  return (
    !UNSAFE_EVIDENCE_QUALIFIER.test(withoutSafeNegation) &&
    POSITIVE_EVIDENCE.test(evidence)
  );
}

export function hasPositiveCleanEvidence(value) {
  const tail = String(value ?? "")
    .trim()
    .match(CLEAN_FINDING_MARKER)?.[1];
  if (tail === undefined) return false;
  // Try the WHOLE tail against the allowlist before splitting it. Several
  // curated entries span a conjunction — `no errors and failures were found` is
  // one exact `POSITIVE_EVIDENCE` phrase — and splitting on `and` first tore it
  // into `no errors` plus `failures were found`, whose second half is not an
  // entry, so a curated phrase failed its own allowlist.
  //
  // This cannot smuggle anything: `POSITIVE_EVIDENCE` is anchored `^...$`, so a
  // full-tail match means the entire tail is one reviewed phrase. Splitting
  // stays as the fallback for genuinely multi-clause evidence.
  // Strip a trailing sentence terminator first: `POSITIVE_EVIDENCE` is anchored
  // `^...$` and its entries carry no punctuation, so `...were found.` would
  // miss. The per-clause path never saw this because its split consumes the
  // terminator.
  if (isCuratedEvidenceClause(tail.replace(/[.!?;]+$/, "").trim())) return true;
  const evidenceClauses = tail
    .split(/(?:[!?;]+|\.(?=\s|$)|\b(?:and|but|however|although|yet)\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return (
    evidenceClauses.length > 0 && evidenceClauses.every(isCuratedEvidenceClause)
  );
}

function hasExplicitAction(line) {
  const content = priorityLineContent(line);
  return (
    EXPLICIT_ACTION_LINE.test(content) || INLINE_DIRECT_ACTION.test(content)
  );
}

// The allowlist half of the prose classifier: a line stays eligible only when
// it is one of the shapes a clean review is made of. Everything else — any
// free sentence — makes the review actionable.
//
// This inverts the rule the scan used to apply. Rejecting lines that carry
// finding vocabulary cannot bound natural language: `Anonymous callers can
// delete every stored record.` names no priority, no severity, and no action
// verb, so it read as clean on a fail-closed merge gate and the finding was
// dropped before merge (issue 1966). The same reasoning #1960 applied to
// verdict and roll-up tails applies to every other line in the body.
//
// Headings are recognized because the caller already validated them: the
// review-number heading must name this PR and the review-title heading must
// carry this PR's title or a bare LGTM. The verdict line is recognized for the
// same reason — the caller proved there is exactly one and that it declares a
// clean verdict with no tail.
function isRecognizedCleanReviewLine(line) {
  const source = String(line ?? "");
  const raw = source.trim();
  if (!raw) return true;
  // An unticked box means the reviewer never completed the assertion, whatever
  // the assertion is. This guards EVERY recognized shape rather than repeating
  // the check per shape: `priorityAtLineStart` and `priorityLineContent` peel
  // the box exactly as the verdict and conclusion paths do, so without this a
  // `- [ ] [P3] Good hygiene: tests cover the changed paths.` cleared on
  // evidence its author had not confirmed.
  if (hasUncheckedTaskBox(source)) return false;
  if (isClaudeTaskCompletionLine(raw)) return true;
  if (THEMATIC_BREAK.test(raw)) return true;
  // Headings are matched on the UNTRIMMED line so this scan recognizes exactly
  // the set harvest validated — see the note on REVIEW_NUMBER_HEADING_LINE.
  if (
    REVIEW_NUMBER_HEADING_LINE.test(source) ||
    REVIEW_TITLE_HEADING_LINE.test(source)
  )
    return true;
  if (verdictDeclaration(raw)) return true;
  if (CLEAN_SECTION_LABEL.test(reviewLineContent(raw))) return true;
  // A `#### What I checked` checklist is legitimate on its own, not only inside
  // the preamble that precedes paired `Findings`/`Roll-up` headings, which is
  // the whole of issue 1968. It is recognized through the same two functions
  // that validate it there, so the standalone and paired paths cannot disagree
  // about which checklist is safe.
  if (isClaudeChecklistHeading(raw) || isBenignChecklistEntry(raw)) return true;
  const priority = priorityAtLineStart(raw);
  if (priority !== undefined)
    return (
      priority === "3" && hasPositiveCleanEvidence(priorityLineContent(raw))
    );
  return false;
}

// True for the checklist's own heading. The heading names a section and
// asserts nothing, so it is recognized clean evidence on its own — the entries
// under it are what carry claims, and each is checked separately.
export function isClaudeChecklistHeading(line) {
  return CLAUDE_CHECKLIST_HEADING.test(String(line ?? "").trim());
}

function isBenignChecklistSubject(value) {
  const subject = String(value ?? "").trim();
  if (
    !subject ||
    subject.length > 200 ||
    hasControlCharacter(subject) ||
    (subject.match(/`/g)?.length ?? 0) % 2 !== 0
  )
    return false;
  if (LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT.test(subject)) return true;
  const topics = subject.toLowerCase().split(/\s+and\s+/);
  return (
    topics.length <= 3 &&
    topics.every((topic) => SAFE_CLAUDE_CHECKLIST_TOPICS.has(topic))
  );
}

// True for a single checklist entry that is both TICKED and built only from
// curated topics. Both callers ask this one question, so the entry grammar, the
// ticked-box rule, and the subject allowlist are spelled once. An unticked
// (`[ ]`) or negated (`[-]`) box states an intention rather than a result and
// fails here, the same way `hasUncheckedTaskBox` rejects it for every other
// recognized shape.
export function isBenignChecklistEntry(line) {
  const entry = String(line ?? "")
    .trim()
    .match(CLAUDE_CHECKLIST_ENTRY);
  return (
    entry !== null &&
    entry[1].toLowerCase() === "x" &&
    isBenignChecklistSubject(entry[2])
  );
}

export function hasControlCharacter(value) {
  return Array.from(String(value ?? "")).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

export function isOrdinaryReviewTitle(value, expectedTitle) {
  const title = String(value ?? "").trim();
  if (
    !title ||
    title.length > 200 ||
    hasControlCharacter(title) ||
    /<!--|-->/.test(title)
  )
    return false;
  const normalized = normalizedReviewTitle(title);
  return (
    normalized.length > 0 && normalized === normalizedReviewTitle(expectedTitle)
  );
}

export function hasMarkdownCodeBlockIndentation(lines) {
  return lines.some((line) => line.trim() && /^(?: {4}| {0,3}\t)/.test(line));
}

export function isClaudeTaskCompletionLine(value) {
  return CLAUDE_TASK_COMPLETION_LINE.test(String(value ?? ""));
}

export function isClaudeLgtmReview(comment) {
  return (
    isClaudeAuthor(comment?.author) &&
    /^\s*(?:#{1,6}\s+)?(?:\*\*)?Verdict:\s*LGTM(?:\*\*)?\s*$/im.test(
      comment?.body ?? "",
    )
  );
}

export function matchesCleanReviewCompatibilityRegistry(comment, pr, rawBody) {
  const digest = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const registered = CLEAN_REVIEW_COMPATIBILITY.get(digest);
  return (
    registered !== undefined &&
    String(comment?.author ?? "").toLowerCase() === registered.author &&
    String(pr?.number ?? "") === registered.prNumber &&
    String(comment?.id ?? "") === registered.commentId &&
    String(pr?.headRefOid ?? "") === registered.headRefOid
  );
}

// Returns null for non-Claude or non-verdict comments, false for an explicitly
// clean review, and true for an actionable or unsupported verdict comment.
export function classifyClaudeReviewProse(comment, pr) {
  if (!isClaudeAuthor(comment?.author)) return null;
  const body = String(comment?.body ?? "");
  const lines = body.split("\n");
  const verdictLines = lines.filter(verdictDeclaration);
  if (verdictLines.length === 0) return null;
  const createdAt = Date.parse(comment?.createdAt ?? comment?.created_at ?? "");
  if (!Number.isFinite(createdAt) || createdAt < PROSE_PATTERN_LIBRARY_START)
    return true;

  if (
    verdictLines.length !== 1 ||
    // Symmetric with isCleanConclusion: an unticked box in front of the
    // verdict means the reviewer never completed it, and reviewLineContent
    // peels the box away before the verdict pattern ever sees it.
    hasUncheckedTaskBox(verdictLines[0]) ||
    !matchesCleanVerdict(reviewLineContent(verdictLines[0])) ||
    body.includes("\r") ||
    body.includes("\0") ||
    body.length > 65_536 ||
    hasMarkdownCodeBlockIndentation(lines) ||
    /(?:^|\s)(?:```|~~~)|<!--|-->|^\s*(?:>|\|.*\|\s*$)/m.test(body)
  )
    return true;

  const reviewNumbers = Array.from(
    body.matchAll(REVIEW_NUMBER_HEADING),
    ([, number]) => number,
  );
  if (
    reviewNumbers.length > 1 ||
    (reviewNumbers.length === 1 &&
      reviewNumbers[0] !== String(pr?.number ?? ""))
  )
    return true;

  const reviewTitles = Array.from(
    body.matchAll(REVIEW_TITLE_HEADING),
    ([, title]) => title,
  );
  if (
    reviewTitles.length > 1 ||
    (reviewTitles.length === 1 &&
      !isOrdinaryReviewTitle(reviewTitles[0], pr?.title) &&
      !CLEAN_REVIEW_TITLE.test(String(reviewTitles[0]).trim()))
  )
    return true;

  if (!lines.some(isCleanConclusion)) return true;

  for (const line of lines) {
    if (isCleanConclusion(line)) continue;
    // The explicit-action and severity rules stay in front of the allowlist.
    // They no longer carry the classification on their own, but they still
    // guard the recognized shapes themselves — a review-title heading repeats
    // the PR title, and a title can name a required change.
    if (hasExplicitAction(line) || EXPLICIT_SEVERITY.test(line)) return true;
    if (!isRecognizedCleanReviewLine(line)) return true;
  }

  return false;
}
