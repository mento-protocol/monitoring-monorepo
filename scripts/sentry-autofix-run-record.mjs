/**
 * Tracker run-record rendering for the Sentry AUTOFIX pipeline. Extracted from
 * scripts/sentry-autofix-finalize.mjs (finalize sat over the 1000-line hard cap)
 * so the finalize module keeps the diff-guard / PR-body / label / marker-check
 * decision layer and its CLI, and this module owns the rolling-comment body the
 * always-run record job upserts.
 *
 * Mirrors the ingest's run record (buildRunRecordBody / RUN_RECORD_MARKER,
 * sentry-triage-ingest.mjs) so the autofix leg also leaves a durable per-run
 * record on the pipeline tracker issue — the ADR 0036 observability invariant
 * (every run leaves a record, so a silently-dead schedule is detectable even when
 * the leg is disabled, unprovisioned, or finds zero candidates). PURE: it BUILDS
 * the body; the finalize CLI's `run-record` subcommand renders it and the
 * always-run record job does the best-effort rolling-comment upsert.
 */

export const AUTOFIX_RUN_RECORD_MARKER =
  "<!-- sentry-autofix:run-record:v1 -->";

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** One-line, control-char-free rendering of a workflow-controlled label
 * (trigger/disposition are not agent/Sentry-derived, but this comment lands on
 * a public issue, so keep it single-line as defense in depth). */
function oneLine(value, fallback) {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return s || fallback;
}

// How many stood-down issue numbers ONE record line names before it stops. The
// list is an operator affordance, not an inventory — the count beside it is the
// signal, and an unbounded list on a public rolling comment is just noise.
const MAX_RECORDED_DEFERRED_ISSUES = 10;

/**
 * ` (#1313, #1316, …)` for a stood-down issue list, or "" when there is none.
 *
 * Whitelist-parsed, not sanitized: the input arrives through the workflow env as
 * a free-form string, so anything that is not a bare positive integer is
 * DROPPED rather than escaped. That is what keeps this line safe on a public
 * tracker comment even though BOTH stand-downs it renders were triggered by
 * agent-authored text — `duplicate_of` for a deferral, `fix_scope` for a skip —
 * the numbers themselves come from GitHub, and nothing else survives the filter.
 */
function renderDeferredIssues(deferredIssues) {
  const numbers = String(deferredIssues ?? "")
    .split(/[\s,]+/)
    .map((token) => token.replace(/^#/, ""))
    .filter((token) => /^[0-9]+$/.test(token) && Number(token) > 0)
    .slice(0, MAX_RECORDED_DEFERRED_ISSUES);
  if (numbers.length === 0) return "";
  return ` (${numbers.map((n) => `#${n}`).join(", ")})`;
}

/**
 * Build the autofix run-record comment body — same shape/family as the ingest
 * run record so the two rolling comments on the tracker read consistently.
 * `trigger` and `disposition` are workflow-controlled; the counters are coerced
 * to non-negative integers.
 *
 * `deferred` is the duplicate_of family collapse's stand-down count (PR
 * #1810). Without it a run that suppressed its entire window rendered
 * identically to one with an empty queue — `Candidates selected: 0` and nothing
 * else — so a permanently family-starved queue looked like a healthy idle leg,
 * which is precisely the failure mode ADR 0036's observability invariant exists
 * to make detectable.
 *
 * `skipped` is the SECOND stand-down class, on the same argument (issue #1785):
 * a `fix_scope: architectural` verdict the selector skips writes nothing to the
 * queue from the select leg. Fresh architectural verdicts settle OPEN under
 * `sentry:fix-scope-architectural` and are excluded from the window at query
 * time (issue #1812), so this counter now tracks the LEGACY stragglers the
 * record-run backfill has not yet labeled — and since every verdict predating
 * the field normalizes to `architectural`, an unreported skip makes "triage is
 * correctly classifying architectural" and "the prompt change never shipped"
 * render the same. Both counters are separate lines because they lift on
 * different events: a deferral lifts when a sibling's marker goes, a skip when
 * the backfill labels it (or a re-triage clears it).
 */
export function buildAutofixRunRecordBody({
  timestampIso,
  trigger,
  disposition,
  candidates,
  opened,
  refused,
  incomplete,
  deferred,
  deferredIssues,
  skipped,
  skippedIssues,
  windowTotal,
  windowEvaluated,
  handledOverflow,
  reverseTruncated,
  reverseNonconvergent,
}) {
  const lines = [
    AUTOFIX_RUN_RECORD_MARKER,
    "",
    `**Sentry autofix — last run:** ${oneLine(timestampIso, "unknown")}`,
    "",
    `- Trigger: ${oneLine(trigger, "unknown")}`,
    `- State: ${oneLine(disposition, "unknown")}`,
    `- Candidates selected: ${nonNegativeInt(candidates)}`,
    `- Fix PRs opened: ${nonNegativeInt(opened)}`,
    `- Refused (no PR): ${nonNegativeInt(refused)}`,
    `- Incomplete / errored: ${nonNegativeInt(incomplete)}`,
    `- Deferred (duplicate_of family): ${nonNegativeInt(deferred)}${renderDeferredIssues(deferredIssues)}`,
    `- Skipped (fix_scope: architectural): ${nonNegativeInt(skipped)}${renderDeferredIssues(skippedIssues)}`,
  ];
  // Window tripwire (PR #1810): rendered ONLY when the list window exceeded the
  // evaluation cap (total > evaluated). The selector bounds the READ at
  // MAX_CANDIDATE_EVALUATIONS, so a growing window would otherwise truncate its
  // newest tail silently; this line surfaces the approach on the tracker weeks
  // ahead of the cap, which is #1813's fallback remedy shipped alongside the
  // fix. When the window fits (the steady state), the line is absent.
  const windowTotalN = nonNegativeInt(windowTotal);
  const windowEvaluatedN = nonNegativeInt(windowEvaluated);
  if (windowTotalN > windowEvaluatedN) {
    lines.push(
      `- Window: ${windowTotalN} stubs, evaluated ${windowEvaluatedN}`,
    );
  }
  // Cost-budget truncations (PR #1810 follow-up): a family-dedupe lookup a per-run
  // budget capped, so a stub that SHOULD have stood down may re-attempt this run.
  // Each fails toward MORE candidates (never a wrong close), but the re-attempt
  // must not be silent — that byte-identical-to-healthy re-attempt is exactly
  // what the Window line was introduced to eliminate. Rendered only when nonzero,
  // so the steady state carries no noise line.
  const handledOverflowN = nonNegativeInt(handledOverflow);
  if (handledOverflowN > 0) {
    lines.push(
      `- Handled-id lookups truncated: ${handledOverflowN} over the MAX_HANDLED_ID_QUERIES budget (treated as not-handled)`,
    );
  }
  if (reverseTruncated === true || reverseTruncated === "true") {
    lines.push(
      "- Reverse family probe truncated: hit the MAX_REVERSE_PROBE_QUERIES budget (some finalists left unverified)",
    );
  }
  if (reverseNonconvergent === true || reverseNonconvergent === "true") {
    lines.push(
      "- Reverse family verification did not converge within MAX_REVERSE_ITERATIONS",
    );
  }
  return lines.join("\n");
}
