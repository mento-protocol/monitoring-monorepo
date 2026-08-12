/**
 * The needs-human ESCALATION contract: when a `needs-human` verdict is
 * decision-ready enough to settle a queue stub with.
 *
 * Split out of scripts/sentry-triage-project-core.mjs, which had reached the
 * repo's 1000-line hard cap. The rules here are a self-contained judgement over
 * ALREADY-parsed, ALREADY-neutralized verdict fields — they need no parser, no
 * label map and no I/O — so they sit below the verdict contract rather than
 * inside it, and `sentry-triage-project-core.mjs` re-exports them so every
 * caller keeps one import surface.
 *
 * It imports only scripts/sentry-triage-text.mjs (which imports nothing), so
 * the verdict contract can sit on this file without a cycle and the workflow
 * runtime closure stays third-party-free.
 */

import { sanitizeFreeText } from "./sentry-triage-text.mjs";

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

// ---------------------------------------------------------------------------
// The INSTRUCTION half: a decision-ready question still needs the steps that
// answer it and the outcomes those answers lead to (#1769 rounds 11 + 15,
// extended here for #1782).
// ---------------------------------------------------------------------------

/** One step is enough to make the question checkable; the prompt asks for 1-3. */
export const MIN_HOW_TO_CHECK_STEPS = 1;

/**
 * TWO branches, because a decision has at least two answers.
 *
 * `.github/prompts/sentry-triage.md` asks for 2-3 `decision_branches`, one per
 * answer — and the gate accepted one, which is the shape that quietly defeats
 * the escalation: a brief that says what happens if the answer is yes, is silent
 * on no, and still SETTLES. The human then either acts on the one covered
 * outcome or has nothing to act on, and no retry follows, because the verdict
 * resolved cleanly. Requiring both is what makes "decision-ready" mean the
 * decision can actually be closed out from the brief.
 *
 * The prompt's upper bound is deliberately NOT enforced: a fourth branch is
 * over-explaining, which costs nothing a human has to recover from.
 */
export const MIN_DECISION_BRANCHES = 2;

/**
 * Why this needs-human escalation is not decision-ready yet, or null.
 *
 * Takes COUNTS of the post-neutralization lists — `sanitizeBriefList` drops
 * items that render empty — so the gate and the renderer judge the same items,
 * and this module needs neither the parser nor the sanitizer to make its call.
 */
export function escalationCompletenessRefusal({
  howToCheckCount = 0,
  decisionBranchCount = 0,
} = {}) {
  if (howToCheckCount < MIN_HOW_TO_CHECK_STEPS) {
    return `it carries no 'how_to_check' step, so nothing in it says how to answer the question`;
  }
  if (decisionBranchCount < MIN_DECISION_BRANCHES) {
    return `it carries ${decisionBranchCount} 'decision_branches' item(s) and the escalation contract requires at least ${MIN_DECISION_BRANCHES}, one per answer, so a human answering the question lands on an outcome the brief does not cover`;
  }
  return null;
}
