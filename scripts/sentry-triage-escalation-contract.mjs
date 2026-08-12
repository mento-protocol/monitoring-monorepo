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
