#!/usr/bin/env node
/**
 * Selection leg of the Sentry AUTOFIX pipeline (ADR 0036 Stage C, Phase 2b —
 * docs/notes/sentry-triage-pipeline.md "Autofix PRs (Phase 2b)"). A
 * deterministic, no-LLM step that picks the queue stubs a scoped fix PR should
 * be attempted for, so the fix job's matrix is built from validated,
 * closed-enum inputs only — never from anything an LLM produced.
 *
 * It reads queue issues labeled `sentry:verdict-code-fix` (auto-closed on
 * verdict, so `--state all`), re-parses each stub's verdict through the SAME
 * authoritative parser the triage label step uses
 * (`scripts/sentry-triage-project-core.mjs` `resolveVerdict`), and keeps only
 * the ones whose `affected_repo` is EXACTLY this repo
 * (`mento-protocol/monitoring-monorepo`) — an external or unrecognized owning
 * repo is never fixed here. Selection is bounded and idempotent:
 *
 *   - DEDUP: a stub already carrying `sentry:fix-pr-opened` (a PR was opened) or
 *     `sentry:fix-refused` (an attempt declined to open one), or whose SHORT-ID
 *     is quoted-referenced by an OPEN PR, is skipped — the autofix leg never
 *     opens a second PR for the same Sentry issue, and never re-burns the cap on
 *     an unfixable stub. A merged/closed PR does NOT block: once a fixed issue
 *     regresses (ingest sheds the autofix markers on reopen), the stub is
 *     re-attemptable by design.
 *   - FIX SCOPE (issue #1785/#1812): only a verdict claiming `fix_scope:
 *     mechanical` starts a fix attempt. A local `architectural` verdict — the
 *     fail-closed value for an absent or unrecognized field — settles OPEN under
 *     `sentry:fix-scope-architectural` and is excluded from the candidate window
 *     at query time; a LEGACY or hand-removed straggler that still reaches the
 *     gate is skipped WITHOUT a terminal refusal marker (which would stand its
 *     whole family down). The skip is REPORTED (`skipped`) because it writes
 *     nothing here, and the record-run job backfills the exclusion label onto
 *     the straggler. The skipped stub still joins the family union below —
 *     dropping it would delete its `duplicate_of` edges and fan its family out.
 *   - FAMILY COLLAPSE (issue #1784): stubs whose verdicts place them in one
 *     `duplicate_of` family consume ONE run between them, not one each. The
 *     grouping, the transitive union and the representative rule live in
 *     scripts/sentry-autofix-family.mjs; this module supplies the live state it
 *     decides over. Deferral writes nothing.
 *   - Oldest-first, hard-capped at `--cap` (default 2) per run (quota cap).
 *
 * Pure of the kill switch / secret guards — the workflow's select job runs
 * those in bash and only invokes this script when the pipeline is enabled and
 * provisioned. Prints a JSON array of `{ issue, shortId }` matrix entries to
 * stdout (diagnostics on stderr).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO,
  selectVerdictComment,
} from "./sentry-triage-project-core.mjs";
import {
  DEFER_FAMILY_DUPLICATE,
  DEFER_FAMILY_HANDLED,
  DEFER_FAMILY_RECONCILING,
} from "./sentry-autofix-family.mjs";
import { resolveFamilies } from "./sentry-autofix-family-resolve.mjs";
import {
  defaultRunGh,
  isRateLimitFailure,
  listCodeFixStubsPage,
  LIST_LIMIT,
  readStub,
} from "./sentry-autofix-queue-io.mjs";
// The per-stub eligibility layer, extracted so this module stays under the
// 600-line soft cap: every filter that decides whether ONE stub may start a fix
// attempt lives there, this module owns the window and the family collapse.
import { evaluateCandidate, safeShortId } from "./sentry-autofix-candidate.mjs";

// The queue-scoping label (AUTOFIX_SELECT_LABEL) lives in the I/O layer beside
// the queries that use it; the family-collapse project scope
// (LOCAL_SENTRY_PROJECT) is owned by the extracted resolver
// (sentry-autofix-family-resolve.mjs); the per-stub filters and the skip reason
// are owned by sentry-autofix-candidate.mjs.

/** Re-exported from the candidate layer: the selector is still the module the
 * workflow and the suites import this contract from. */
export { SKIP_FIX_SCOPE_ARCHITECTURAL } from "./sentry-autofix-candidate.mjs";

export const DEFAULT_CAP = 2;

// How many window stubs one run may READ. The family union is transitive, so
// selection can no longer stop at the first `cap` stubs — but "evaluate the
// whole window" makes the run's `gh` cost scale with LIST_LIMIT (one `issue
// view` plus one `pr list` each, ~400 sequential subprocesses at the ceiling)
// inside a `timeout-minutes: 5` job, and family deferral writes nothing, so a
// collapsed family of K leaves K-1 PERMANENT window residents that are re-read
// every run. That is monotonic growth driven from outside: every new error
// fingerprint an unauthenticated dashboard visitor produces can add one.
//
// Bound the READ instead of the selection. The window is oldest-first, so this
// truncates the NEWEST tail — the oldest candidates, the ones `sort:created-asc`
// exists to protect, are always inside the budget. A truncated family is the
// same situation MAX_DUPLICATE_LOOKUPS already creates (a member the run cannot
// see), and it fails toward MORE candidates, never fewer.
//
// `LIST_LIMIT` (sentry-autofix-queue-io.mjs, 200) is the HARD upper bound on
// this constant. `gh issue list --limit` caps what the API RETURNS, and that
// happens BEFORE the slice below runs, so raising this value above LIST_LIMIT is
// a strict NO-OP — the run reads exactly LIST_LIMIT rows either way, the Window
// tripwire reports `total == evaluated`, and nothing anywhere says the raise did
// nothing. THE TWO MUST MOVE TOGETHER. `windowCeilingWarning` re-checks the pair
// at run time and a suite test pins `MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT`,
// because a silent no-op is precisely the failure a "we widened the window"
// change must not ship as.
//
// 200, not 50 (this PR): 50 left 150 rows of a full window unread every run,
// which — combined with family deferral writing nothing — is the starvation the
// second look below exists to break. The cost is bounded and paid for: the
// select job's `timeout-minutes` is 25, and 2 + 2×200 + 120 ≈ 522 serial `gh`
// calls at a pessimistic ~1 s/call is ~9 minutes.
export const MAX_CANDIDATE_EVALUATIONS = 200;

/**
 * A run-time note when the evaluation window is configured above the list
 * ceiling that is applied first — the mismatch that makes a raise a silent
 * no-op. Pure (and exported) so the check is a real, testable behaviour rather
 * than an assertion nobody can exercise: a THROW here would break the select
 * step's "always emits a valid JSON array, never fails" invariant over a static
 * config mistake, so this is loud, not fatal. Returns the note, or null.
 */
export function windowCeilingWarning(
  evaluations = MAX_CANDIDATE_EVALUATIONS,
  listLimit = LIST_LIMIT,
) {
  if (!(evaluations > listLimit)) return null;
  return `warn: MAX_CANDIDATE_EVALUATIONS (${evaluations}) exceeds LIST_LIMIT (${listLimit}), which the API applies FIRST — the window is really ${listLimit} and raising the evaluation cap alone does nothing. Raise LIST_LIMIT too.\n`;
}

// ---------------------------------------------------------------------------
// Bounded second look
// ---------------------------------------------------------------------------
//
// The starvation this exists to break: every stub inside the window is a
// deferred family member, so the run selects NOTHING, writes NOTHING, and the
// next run reads the SAME window and repeats — forever. Deferral is by design
// state-free, so nothing ages out; a selectable stub sitting one row past the
// window is never evaluated, at any point, ever.
//
// The second look fires ONLY on that exact signature: the first pass produced
// zero matrix entries AND the list came back FULL (rawCount >= LIST_LIMIT, so
// rows beyond it may exist). A healthy run — anything selected — never reaches
// it and pays nothing. It is not a retry and not a widening: it reads the NEXT
// rows once, with its own hard ceilings, and reports both that it ran and any
// truncation of its own.
//
// COST ARITHMETIC (the constraint: first pass + second look must stay under
// ~60% of the 25-minute select timeout at a pessimistic 1.0 s/call — every `gh`
// call in this leg is serial, so ~900 calls is the wall):
//   first pass  = 2 list pages + 2 × 200 per-stub reads + 120 family budget
//                 (40 handled-id + 40 reverse probe + 40 verify read) = 522
//   second look = 4 list pages (one `--limit 400` call, 100 rows per page)
//               + 2 × 100 per-stub reads + 60 family budget (20 each) = 264
//   TOTAL       = 786 calls ≈ 13.1 min at 1.0 s/call = 52% of 25 min. Under the
//                 15-minute (≈900-call) wall with ~2 minutes of slack.
// Raising any constant below re-opens this arithmetic; the suite pins the total
// against DOCUMENTED_GH_CEILING.
export const MAX_SECOND_LOOK_EVALUATIONS = 100;

/** How many RAW rows past the first window the second look asks for. The list
 * is issued as ONE `gh issue list --limit LIST_LIMIT + this`, with the first
 * LIST_LIMIT raw rows dropped client-side — `gh issue list` has no offset flag,
 * and a raw-row skip is what lines up with the first pass's own `--limit`
 * (applied server-side, before any client filter). */
export const SECOND_LOOK_LIST_ROWS = 200;

/** The second look's OWN family budgets. The first pass's per-run budgets are
 * spent by the time it runs, so it cannot reuse them; half of each keeps the
 * total inside the arithmetic above while still letting a real family resolve. */
export const SECOND_LOOK_FAMILY_BUDGETS = {
  handled: 20,
  probe: 20,
  verify: 20,
};

/** One note per deferral reason, keyed by the collapse's own constants so a
 * reason added there cannot silently inherit another's wording. An unmapped
 * reason still prints — as itself, not as somebody else's explanation. */
const DEFER_NOTES = {
  [DEFER_FAMILY_DUPLICATE]: (decision) =>
    `same duplicate_of family as ${safeShortId(decision.representative)}, which represents the family this run`,
  [DEFER_FAMILY_HANDLED]: (decision) =>
    `its duplicate_of family already has an autofix attempt on ${safeShortId(decision.representative)} (a regression sheds that marker)`,
  [DEFER_FAMILY_RECONCILING]: () =>
    "its duplicate_of family already has an open autofix PR being reconciled this run",
};

/**
 * Wrap the run's `gh` driver so ONE place sees every invocation the select leg
 * makes. Two jobs, both otherwise unmeasurable:
 *
 * 1. COUNT. The per-run `gh` volume is a documented ceiling that nothing
 *    actually measured — every cost claim in the pipeline note was arithmetic
 *    over caps. `state.ghCalls` makes it an observed number on the run record,
 *    so drift shows up before a timeout does.
 *
 * 2. FAIL CLOSED ON THROTTLING. Nearly every read in this leg fails SOFT toward
 *    MORE candidates — `readStub`, `openAutofixPrExists`, the handled-id
 *    lookups, the reverse probes all treat a rejection as "no blocker found".
 *    But the blockers they look for ARE the dedupe signals, so a rate-limited
 *    read is indistinguishable from a clean one, and a throttled run can open
 *    DUPLICATE autofix PRs while looking perfectly green. Intercepting here
 *    catches EVERY read — including ones added later — without threading a sink
 *    through four modules, and it re-throws so each existing fail-soft path
 *    behaves exactly as before locally; the caller then refuses to SELECT on the
 *    data those paths produced.
 *
 * Non-rate-limit transients keep their existing fail-soft behaviour untouched:
 * only `isRateLimitFailure` text degrades the run.
 */
function instrumentRunGh(baseRunGh, state) {
  return async (args) => {
    state.ghCalls += 1;
    try {
      return await baseRunGh(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isRateLimitFailure(message)) {
        state.rateLimited += 1;
        if (state.rateLimited === 1) {
          process.stderr.write(
            `::error::rate-limit-shaped gh failure during selection: ${message.split("\n")[0]}\n`,
          );
        }
      }
      throw err;
    }
  };
}

/** Split one resolve pass's decisions into the three reported halves. Shared by
 * the first pass and the second look so both classify identically — a second
 * look that reported a family deferral as a fix_scope skip would send an
 * operator to the wrong remedy. */
function partitionDecisions(decisions, cap) {
  const entries = [];
  const deferred = [];
  const skipped = [];
  for (const decision of decisions) {
    const number = decision.candidate.issue;
    // Ruled out before the collapse ran (fix_scope). It joined the union so its
    // family edges survived, but it is not a family deferral and must not be
    // reported as one: the two lift on different events.
    if (decision.candidate.eligible === false) {
      skipped.push({ issue: number, reason: decision.candidate.skipReason });
      continue;
    }
    if (!decision.selected) {
      // Deferral writes NOTHING to the queue — no label, no comment, no marker.
      // The member stays exactly as selectable as its live state makes it on the
      // next run, which is what lets a genuine regression (ingest sheds the
      // sibling's autofix marker) bring the family straight back. It IS reported
      // out, though: the run record carries the count and the issue numbers so
      // "everything suppressed" never reads as "nothing queued".
      process.stderr.write(
        `defer #${number}: ${DEFER_NOTES[decision.reason]?.(decision) ?? `deferred (${decision.reason})`}; not marked, re-evaluated next run.\n`,
      );
      deferred.push({ issue: number, reason: decision.reason });
      continue;
    }
    if (entries.length >= cap) continue;
    entries.push(decision.candidate.entry);
  }
  return { entries, deferred, skipped };
}

/**
 * Run the selection and report EVERY half of its outcome: the matrix entries,
 * every candidate the family collapse stood down, and every stub the `fix_scope`
 * gate skipped.
 *
 * The deferred half exists because deferral writes nothing — no label, no
 * comment, no marker — so before this the only trace was a stderr line inside a
 * workflow log. A run that deferred its entire window (the exact state a refused
 * sibling produces) rendered on the tracker as `State: active, Candidates
 * selected: 0`, byte-identical to "the queue is empty". That defeats the ADR
 * 0036 observability invariant the record job serves — a permanently
 * family-starved queue read as a healthy idle leg, which is the #1758
 * misdiagnosis this whole leg exists to make impossible — and it left the
 * documented remedy (single-issue `workflow_dispatch`) unusable, because nobody
 * could tell which issue to name. All three fields go into the run record.
 *
 * `skipped` exists for the same reason, one stand-down class later (issue
 * #1785): a `fix_scope: architectural` verdict writes nothing either — no
 * marker, deliberately, because a refusal marker is terminal and would stand its
 * whole family down — and `architectural` is what EVERY verdict predating the
 * field normalizes to. Unreported, the steady state after this ships is
 * `Candidates selected: 0, Deferred: 0`, which is byte-identical to an idle
 * queue and cannot be told apart from "the prompt change never landed" or "the
 * parse broke" without opening Actions logs. That is the #1758 misdiagnosis
 * exactly.
 *
 * Batch mode (default): up to `cap` oldest `sentry:verdict-code-fix` stubs owned
 * by this repo, ONE per `duplicate_of` family (issue #1784). Single mode
 * (`options.issue`): evaluate only that issue (the single-issue
 * `workflow_dispatch` live run) through the SAME filters — so a dispatch can
 * never fix an ineligible issue, but an eligible one opens a real PR.
 *
 * Family collapse is deliberately BATCH-ONLY. A dispatch names one issue
 * explicitly, and an operator who names a family member after reviewing the
 * refusal is overriding the heuristic on purpose — a `duplicate_of` entry is a
 * family SIGNAL, not a confirmed duplicate, so the explicit request wins.
 */
export async function selectAutofixRun(options, deps = {}) {
  const state = { ghCalls: 0, rateLimited: 0 };
  const runGh = instrumentRunGh(deps.runGh ?? defaultRunGh, state);
  const repo = options.repo ?? DEFAULT_REPO;

  const ceilingWarning = windowCeilingWarning();
  if (ceilingWarning) process.stderr.write(ceilingWarning);

  /**
   * Fail CLOSED on throttling. Every read this leg issues answers a dedupe or
   * blocker question, and every one of them fails SOFT toward MORE candidates,
   * so a rate-limited run cannot tell "no prior PR" from "GitHub refused to
   * tell me" — and would open a DUPLICATE autofix PR looking green. So the run
   * does not SELECT on data it knows is unreliable.
   *
   * "Fail closed" here means ZERO matrix entries plus a loud report, NOT a
   * throw: the workflow's select step asserts it always emits a valid JSON
   * array and never fails (the leg runs under `set -euo pipefail`), so throwing
   * would break the contract this whole job is built around. The stand-down
   * reports are still returned — they cost nothing and an operator reading the
   * tracker needs the whole picture — but the degraded line dominates them.
   */
  const degraded = (report) => {
    process.stderr.write(
      `::error::selection DEGRADED: ${state.rateLimited} rate-limit-shaped gh read failure(s); emitting ZERO entries rather than selecting on unreliable dedupe data.\n`,
    );
    return {
      ...report,
      entries: [],
      truncations: { ...report.truncations, rateLimited: state.rateLimited },
    };
  };

  // Single-issue live run: evaluate exactly the requested issue. A dispatch
  // cannot override the fix_scope gate (that is the point of the gate), so the
  // skip is reported here too — otherwise the documented remedy for a stalled
  // leg is itself silent, and an operator who dispatches an architectural stub
  // sees the same empty array as for an ineligible one.
  if (options.issue != null) {
    const stub = await readStub(runGh, repo, options.issue);
    const candidate = await evaluateCandidate(runGh, repo, {
      number: stub.number,
      title: stub.title,
      labels: stub.labels,
    });
    // No list window in single-issue mode: one stub considered, one evaluated,
    // so the Window tripwire never fires (total == evaluated), the second look
    // never applies (there is no list to be full), and the family collapse is
    // skipped entirely, so no cost budget can truncate. A dispatch cannot
    // override the fix_scope gate, so an architectural stub is reported through
    // `skipped` here too (the documented remedy for a stalled leg must not
    // itself be silent).
    const selectable = candidate != null && candidate.eligible !== false;
    const report = {
      entries: selectable ? [candidate.entry] : [],
      deferred: [],
      skipped: selectable
        ? []
        : candidate == null
          ? []
          : [{ issue: candidate.issue, reason: candidate.skipReason }],
      window: {
        total: 1,
        evaluated: 1,
        secondLook: false,
        secondLookTotal: 0,
        secondLookEvaluated: 0,
        ghCalls: state.ghCalls,
      },
      truncations: {
        handledOverflow: 0,
        reverseBudget: false,
        reverseNonconvergent: false,
        rateLimited: 0,
      },
    };
    // A dispatch dedupes on the SAME open-PR read the batch path does, so a
    // throttled one can open a duplicate just as easily.
    return state.rateLimited > 0 ? degraded(report) : report;
  }

  const cap =
    Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : DEFAULT_CAP;
  const page = await listCodeFixStubsPage(runGh, repo);
  const stubs = page.stubs;

  // Evaluate the window before choosing, not just the first `cap`: the family
  // union is transitive, so a stub further down the window can join two earlier
  // ones (or attach to a family through an id that is not itself a candidate),
  // and a decision taken before that stub is read can be wrong. Bounded by
  // MAX_CANDIDATE_EVALUATIONS (oldest-first, so the budget only ever drops the
  // newest tail), which now equals LIST_LIMIT — see the constant's note: the
  // list ceiling is applied first, so it is the real bound either way.
  const evaluable = stubs.slice(0, MAX_CANDIDATE_EVALUATIONS);
  if (stubs.length > evaluable.length) {
    process.stderr.write(
      `note: window has ${stubs.length} stubs; evaluating the oldest ${evaluable.length} (MAX_CANDIDATE_EVALUATIONS).\n`,
    );
  }
  // The Window tripwire (PR #1810 cost bound): the record job renders "Window: N
  // stubs, evaluated M" when N>M, so any approach toward the eval cap is
  // reported on the tracker weeks ahead — never a silent truncation.
  const window = {
    total: stubs.length,
    evaluated: evaluable.length,
    secondLook: false,
    secondLookTotal: 0,
    secondLookEvaluated: 0,
    ghCalls: 0,
  };

  const candidates = [];
  for (const stub of evaluable) {
    const candidate = await evaluateCandidate(runGh, repo, stub);
    if (candidate) candidates.push(candidate);
  }

  const { decisions, truncations } = await resolveFamilies(
    runGh,
    repo,
    candidates,
    cap,
  );
  const first = partitionDecisions(decisions, cap);
  const entries = first.entries;
  const deferred = first.deferred;
  const skipped = first.skipped;
  const runTruncations = { ...truncations, rateLimited: 0 };

  const finish = () => {
    window.ghCalls = state.ghCalls;
    process.stderr.write(
      `gh-calls=${state.ghCalls} window=${window.evaluated}/${window.total} second-look=${window.secondLook ? `${window.secondLookEvaluated}/${window.secondLookTotal}` : "no"} entries=${entries.length}\n`,
    );
    return { entries, deferred, skipped, window, truncations: runTruncations };
  };

  // Bail before spending anything more: the first pass's dedupe reads are
  // already untrustworthy, so a second look would only widen the blast radius.
  if (state.rateLimited > 0) return degraded(finish());

  // The bounded SECOND LOOK. Fires only on the starvation signature — nothing
  // selectable in the whole window AND a FULL list page, so selectable rows may
  // sit just past it that no run will ever otherwise reach. A run that selected
  // anything skips this entirely and pays zero extra calls.
  if (entries.length === 0 && page.full) {
    window.secondLook = true;
    process.stderr.write(
      `note: first pass selected nothing from a FULL list page (${page.rawCount} rows); taking ONE bounded second look at the next ${SECOND_LOOK_LIST_ROWS} rows.\n`,
    );
    const beyond = await listCodeFixStubsPage(runGh, repo, {
      limit: LIST_LIMIT + SECOND_LOOK_LIST_ROWS,
      skip: LIST_LIMIT,
    });
    const furtherEvaluable = beyond.stubs.slice(0, MAX_SECOND_LOOK_EVALUATIONS);
    window.secondLookTotal = beyond.stubs.length;
    window.secondLookEvaluated = furtherEvaluable.length;
    if (beyond.stubs.length > furtherEvaluable.length) {
      // The second look's OWN truncation, surfaced exactly like the Window
      // tripwire: it must never silently stop short either.
      process.stderr.write(
        `note: second look saw ${beyond.stubs.length} further stubs; evaluating the oldest ${furtherEvaluable.length} (MAX_SECOND_LOOK_EVALUATIONS).\n`,
      );
    }

    const furtherCandidates = [];
    for (const stub of furtherEvaluable) {
      const candidate = await evaluateCandidate(runGh, repo, stub);
      if (candidate) furtherCandidates.push(candidate);
    }
    // Its OWN family budgets: the first pass spent the per-run ones, so reusing
    // them would silently double the run's worst-case volume.
    const second = await resolveFamilies(runGh, repo, furtherCandidates, cap, {
      budgets: SECOND_LOOK_FAMILY_BUDGETS,
    });
    const secondParts = partitionDecisions(second.decisions, cap);
    entries.push(...secondParts.entries);
    deferred.push(...secondParts.deferred);
    skipped.push(...secondParts.skipped);
    runTruncations.handledOverflow += second.truncations.handledOverflow ?? 0;
    runTruncations.reverseBudget =
      runTruncations.reverseBudget || second.truncations.reverseBudget;
    runTruncations.reverseNonconvergent =
      runTruncations.reverseNonconvergent ||
      second.truncations.reverseNonconvergent;

    if (state.rateLimited > 0) return degraded(finish());
  }

  return finish();
}

/** Matrix entries only — the emitted contract, unchanged. `selectAutofixRun`
 * carries the deferral and fix_scope-skip reports the run record needs
 * alongside it. */
export async function selectAutofixCandidates(options, deps = {}) {
  const { entries } = await selectAutofixRun(options, deps);
  return entries;
}

/**
 * Emit the trusted, fence-selected verdict comment body for one issue, so the
 * workflow can snapshot it to a file the fix agent reads — instead of giving the
 * agent a `gh` tool + GitHub token (which a prompt-injected agent could try to
 * exfiltrate from its process env). Uses the SAME authorship/regression fence
 * as the label + projection steps. Throws if there is no usable verdict.
 */
export async function emitVerdict(options, deps = {}) {
  const runGh = deps.runGh ?? defaultRunGh;
  const stub = await readStub(
    runGh,
    options.repo ?? DEFAULT_REPO,
    options.issue,
  );
  const selected = selectVerdictComment(stub.comments);
  if (!selected.body) {
    throw new Error(
      `No usable verdict comment on issue #${options.issue} (${selected.reason}).`,
    );
  }
  return selected.body;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:autofix:select [--repo <owner/name>] [--cap <n>]

Prints a JSON array of { "issue": <number>, "shortId": "<SHORT-ID>" } matrix
entries — the oldest capped batch of code-fix queue stubs owned by this repo
that claim \`fix_scope: mechanical\` and do not yet have a fix PR, collapsed to
ONE candidate per \`duplicate_of\` family. Diagnostics go to stderr.

Options:
  --repo <owner/name>  Repo the queue stubs live in (default: ${DEFAULT_REPO}).
  --cap <n>            Max CANDIDATES to select per run — one duplicate_of family
                       counts once, however many stubs it spans (positive int;
                       default ${DEFAULT_CAP}).
  --issue <n>          Single-issue live run: evaluate ONLY this issue through the
                       same filters (the workflow_dispatch path). Opens a real
                       fix PR if the issue is eligible. Overrides --cap.
  --deferred-out <p>   Write the duplicate_of DEFERRAL report — a JSON array of
                       { "issue": <number>, "reason": "<enum>" } — to this path,
                       so the run record can distinguish an empty queue from one
                       whose candidates were all stood down. Stdout is unchanged.
  --skipped-out <p>    Write the fix_scope SKIP report, same shape, to this path.
                       An architectural verdict writes nothing to the queue, so
                       without it a window standing entirely down on scope is
                       indistinguishable from an empty one. Stdout is unchanged.
  --window-out <p>     Write the Window tripwire — { "total": <n>, "evaluated":
                       <n>, "secondLook": <bool>, "secondLookTotal": <n>,
                       "secondLookEvaluated": <n>, "ghCalls": <n> } — to this
                       path, so the run record can surface a list window that
                       exceeded the eval cap, a bounded second look (that it ran
                       AND whether it truncated), and the run's measured \`gh\`
                       volume. Stdout is unchanged.
  --truncations-out <p> Write the cost-budget truncations — { "handledOverflow":
                       <n>, "reverseBudget": <bool>, "reverseNonconvergent":
                       <bool>, "rateLimited": <n> } — to this path, so the run
                       record can surface a bounded re-attempt (a family that
                       should have stood down but a budget capped its lookup) and
                       a DEGRADED run (rate-limit-shaped gh failures, which force
                       zero entries). Stdout is unchanged.
  --emit-verdict       With --issue: print the trusted (fence-selected) verdict
                       comment body for that issue and exit (the workflow
                       snapshots it to a file the fix agent reads, so the agent
                       needs no gh tool or token).
  -h, --help           Show this help.
`;
}

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    cap: DEFAULT_CAP,
    issue: null,
    emitVerdict: false,
    deferredOut: null,
    skippedOut: null,
    windowOut: null,
    truncationsOut: null,
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
      case "--repo":
        options.repo = readValue();
        break;
      case "--cap": {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--cap must be a positive integer");
        }
        options.cap = value;
        break;
      }
      case "--issue": {
        const value = Number(readValue());
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--issue must be a positive integer");
        }
        options.issue = value;
        break;
      }
      case "--emit-verdict":
        options.emitVerdict = true;
        break;
      case "--deferred-out":
        options.deferredOut = readValue();
        break;
      case "--skipped-out":
        options.skippedOut = readValue();
        break;
      case "--window-out":
        options.windowOut = readValue();
        break;
      case "--truncations-out":
        options.truncationsOut = readValue();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

/** Best-effort JSON report write. A failed write degrades ONE counter on the
 * run record; it must never fail the select step, whose whole contract is that
 * it always emits a valid array. */
function writeReport(path, report, label) {
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify(report ?? [])}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warn: could not write the ${label} report: ${message}\n`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.emitVerdict) {
    if (options.issue == null) {
      throw new Error("--emit-verdict requires --issue <n>");
    }
    process.stdout.write(await emitVerdict(options));
    return;
  }
  const { entries, deferred, skipped, window, truncations } =
    await selectAutofixRun(options);
  // Report BEFORE stdout: the workflow captures stdout into a shell variable, so
  // a failed report write must not be able to lose the entries too. All are
  // best-effort — the run record degrades to "0" / no Window line / no
  // truncation line, never to a dead leg.
  writeReport(options.deferredOut, deferred, "deferral");
  writeReport(options.skippedOut, skipped, "fix_scope skip");
  writeReport(options.windowOut, window ?? {}, "window");
  writeReport(options.truncationsOut, truncations ?? {}, "truncations");
  process.stdout.write(`${JSON.stringify(entries)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
