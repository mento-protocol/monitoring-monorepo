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
 * (`scripts/sentry/triage/sentry-triage-project-core.mjs` `resolveVerdict`), and keeps only
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
 *     scripts/sentry/autofix/sentry-autofix-family.mjs; this module supplies the live state it
 *     decides over. Deferral writes nothing.
 *   - Oldest-first, hard-capped at `--cap` (default 2) per run (quota cap).
 *
 * Pure of the kill switch / secret guards — the workflow's select job runs
 * those in bash and only invokes this script when the pipeline is enabled and
 * provisioned. Prints a JSON array of `{ issue, shortId }` matrix entries to
 * stdout (diagnostics on stderr).
 */

import { fileURLToPath } from "node:url";

import { DEFAULT_REPO } from "../triage/sentry-triage-project-core.mjs";
// The decision -> report classifier, shared by the first pass and the second
// look so both label a stand-down identically (a deferral and a fix_scope skip
// lift on different events, and send an operator to different remedies).
import { partitionDecisions } from "./sentry-autofix-decisions.mjs";
import { resolveFamilies } from "./sentry-autofix-family-resolve.mjs";
// The bounded second look, extracted so this module stays under the 600-line
// soft cap: it owns the "the first pass found nothing off a FULL page — what is
// past the ceiling?" pass, its own ceilings, and the cost arithmetic behind them.
import {
  resolveSecondLook,
  secondLookCeilingWarning,
  SECOND_LOOK_LIST_ROWS,
} from "./sentry-autofix-second-look.mjs";
import {
  defaultRunGh,
  listCodeFixStubsPage,
  LIST_LIMIT,
  readStub,
} from "./sentry-autofix-queue-io.mjs";
// The run's budget and instrumentation, extracted so this module stays under the
// 600-line soft cap: the per-run read bound and its no-op guard, the `gh`
// counter, the throttle latch, the zero-state record shapes and the two lines a
// run writes about itself. This module owns what a run DECIDES; that one owns
// what bounds it, measures it, and stands it down.
import {
  degradeReport,
  emptyWindow,
  instrumentRunGh,
  MAX_CANDIDATE_EVALUATIONS,
  newRunState,
  noTruncations,
  summarizeRun,
  windowCeilingWarning,
} from "./sentry-autofix-select-instrument.mjs";
// The CLI surface, extracted for the same reason: the option contract, the help
// text, the report files the tracker reads back, and `--emit-verdict`. A leaf —
// it imports nothing from here — so the re-exports below cannot form a cycle.
import {
  DEFAULT_CAP,
  emitVerdict,
  parseArgs,
  usage,
  writeRunReports,
} from "./sentry-autofix-select-cli.mjs";
// The per-stub eligibility layer, extracted so this module stays under the
// 600-line soft cap: every filter that decides whether ONE stub may start a fix
// attempt lives there, this module owns the window and the family collapse.
import { evaluateCandidate } from "./sentry-autofix-candidate.mjs";

// The queue-scoping label (AUTOFIX_SELECT_LABEL) lives in the I/O layer beside
// the queries that use it; the family-collapse project scope
// (LOCAL_SENTRY_PROJECT) is owned by the extracted resolver
// (sentry-autofix-family-resolve.mjs); the per-stub filters and the skip reason
// are owned by sentry-autofix-candidate.mjs; the deferral wording and the
// decision -> report split are owned by sentry-autofix-decisions.mjs.

/** Re-exported from the candidate layer: the selector is still the module the
 * workflow and the suites import this contract from. */
export { SKIP_FIX_SCOPE_ARCHITECTURAL } from "./sentry-autofix-candidate.mjs";

/** Re-exported from the extracted second-look layer, same reason: the bounded
 * second look is part of the SELECTION contract and the suite reads its ceilings
 * from here. Its mechanics live in sentry-autofix-second-look.mjs. */
export {
  MAX_SECOND_LOOK_EVALUATIONS,
  secondLookCeilingWarning,
  SECOND_LOOK_FAMILY_BUDGETS,
  SECOND_LOOK_LIST_ROWS,
} from "./sentry-autofix-second-look.mjs";

/** Re-exported from the extracted CLI layer, same reason again: the workflow
 * runs this file and the suites import these names from it, so the module
 * boundary is an internal detail and must stay one. */
export {
  DEFAULT_CAP,
  emitVerdict,
  parseArgs,
  writeReport,
  writeRunReports,
} from "./sentry-autofix-select-cli.mjs";

/** Re-exported from the extracted budget/instrumentation layer. The window's
 * read cap and its no-op guard are part of the SELECTION contract — the select
 * suite pins `MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT` and the finalize suite
 * derives the timeout arithmetic from it — so both keep reading them here. */
export {
  MAX_CANDIDATE_EVALUATIONS,
  windowCeilingWarning,
} from "./sentry-autofix-select-instrument.mjs";

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
  const state = newRunState();
  const runGh = instrumentRunGh(deps.runGh ?? defaultRunGh, state);
  const repo = options.repo ?? DEFAULT_REPO;

  const ceilingWarning = windowCeilingWarning();
  if (ceilingWarning) process.stderr.write(ceilingWarning);
  const secondLookWarning = secondLookCeilingWarning();
  if (secondLookWarning) process.stderr.write(secondLookWarning);

  // Fail CLOSED: zero matrix entries plus a loud report, never a throw. Bound to
  // this run's `state` so the call sites below read as the decision they are.
  const degraded = (report) => degradeReport(state, report);

  // Single-issue live run: evaluate exactly the requested issue. A dispatch
  // cannot override the fix_scope gate (that is the point of the gate), so the
  // skip is reported here too — otherwise the documented remedy for a stalled
  // leg is itself silent, and an operator who dispatches an architectural stub
  // sees the same empty array as for an ineligible one.
  if (options.issue != null) {
    let stub;
    try {
      stub = await readStub(runGh, repo, options.issue);
    } catch (err) {
      // THROTTLE ONLY, and this is the distinction the scope turns on.
      //
      // A RATE-LIMIT-shaped failure must DEGRADE. `instrumentRunGh` records the
      // throttle and RETHROWS by design — so every fail-soft handler downstream
      // keeps behaving exactly as it did — but this read has no handler under
      // it, so the rejection would leave `selectAutofixRun`, reach `main`, set
      // exit 1, and kill the step under `set -euo pipefail`. That destroys the
      // `::error::` line, the `rateLimited` truncation and the disposition flip
      // that ARE the fail-closed contract, on precisely the run they exist for.
      // Degrade instead: zero entries, the loud report, exit 0.
      //
      // Any OTHER failure still rejects, unchanged. A missing issue, malformed
      // JSON or a broken `gh` is not the hazard this leg fails closed against —
      // nothing was read, so nothing can be wrongly SELECTED — and a dispatch
      // that names an unreadable issue is an operator error whose loudest,
      // most useful signal is a failed step. That is the behaviour on `main`
      // and this round deliberately leaves it alone.
      if (state.rateLimited === 0) throw err;
      return degraded({
        entries: [],
        deferred: [],
        skipped: [],
        window: {
          ...emptyWindow(),
          // One issue was named, none was evaluated. Never `evaluated: 1`: the
          // read that would have evaluated it is exactly what failed.
          total: 1,
          ghCalls: state.ghCalls,
        },
        truncations: noTruncations(),
      });
    }
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
        ...emptyWindow(),
        total: 1,
        evaluated: 1,
        ghCalls: state.ghCalls,
      },
      truncations: noTruncations(),
    };
    // A dispatch dedupes on the SAME open-PR read the batch path does, so a
    // throttled one can open a duplicate just as easily.
    return state.rateLimited > 0 ? degraded(report) : report;
  }

  const cap =
    Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : DEFAULT_CAP;
  // The Window tripwire (PR #1810 cost bound): the record job renders "Window: N
  // stubs, evaluated M" when N>M, so any approach toward the eval cap is
  // reported on the tracker weeks ahead — never a silent truncation. Built
  // BEFORE the window list, so a list read that never answers still has a report
  // to degrade onto instead of taking the whole run record down with it.
  const window = emptyWindow();

  // The run's one greppable operator line. Takes the count actually EMITTED, so
  // a degraded run cannot report the entries it computed before standing down.
  const summarize = (emitted) => summarizeRun(state, window, emitted);

  // The FIRST window list, and — like the dispatch `readStub` above and the
  // second look's own list below — a `gh` call with no fail-soft handler under
  // it. Same split, for the same reason:
  //
  //   THROTTLE -> DEGRADE. `instrumentRunGh` rethrows, so an uncaught rejection
  //   here exits 1 and kills the step under `set -euo pipefail` — losing the
  //   `::error::` line, `truncations.rateLimited` and the `degraded-rate-limited`
  //   disposition on the one run that needs them. A throttled window read also
  //   answers NOTHING about the queue, so `[]` is the only honest emission.
  //
  //   ANYTHING ELSE -> THROW, unchanged. A malformed JSON body, a dead token, a
  //   missing `gh`: the run cannot see its queue at all, there is no window to
  //   report on, and a failed step is the louder and more actionable signal than
  //   a green run rendering as an idle one. That is `main`'s behaviour today and
  //   the harden round leaves it exactly as it is.
  let page;
  try {
    page = await listCodeFixStubsPage(runGh, repo);
  } catch (err) {
    if (state.rateLimited === 0) throw err;
    window.ghCalls = state.ghCalls;
    const report = degraded({
      entries: [],
      deferred: [],
      skipped: [],
      window,
      truncations: noTruncations(),
    });
    summarize(report.entries.length);
    return report;
  }
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
  window.total = stubs.length;
  window.evaluated = evaluable.length;

  const candidates = [];
  for (const stub of evaluable) {
    // Stop the moment the run is throttled. `instrumentRunGh` already latches
    // every later read into an immediate rejection, so this is not what makes
    // the spend stop — but the evaluation loop would still grind through the
    // remaining ~200 stubs printing a skip line each, and the run has already
    // decided it will emit nothing. Leave loudly instead.
    if (state.rateLimited > 0) {
      process.stderr.write(
        `note: stopping the window evaluation at ${candidates.length} candidate(s) — the run is rate limited and will emit zero entries.\n`,
      );
      break;
    }
    const candidate = await evaluateCandidate(runGh, repo, stub);
    if (candidate) candidates.push(candidate);
  }

  const { decisions, truncations, resolved } = await resolveFamilies(
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
    return { entries, deferred, skipped, window, truncations: runTruncations };
  };
  const finishDegraded = () => {
    const report = degraded(finish());
    summarize(report.entries.length);
    return report;
  };

  // Bail before spending anything more: the first pass's dedupe reads are
  // already untrustworthy, so a second look would only widen the blast radius.
  if (state.rateLimited > 0) return finishDegraded();

  // The bounded SECOND LOOK. Fires only on the starvation signature — nothing
  // selectable in the whole window AND a FULL list page, so selectable rows may
  // sit just past it that no run will ever otherwise reach. A run that selected
  // anything skips this entirely and pays zero extra calls.
  if (entries.length === 0 && page.full) {
    window.secondLook = true;
    process.stderr.write(
      `note: first pass selected nothing from a FULL list page (${page.rawCount} rows); taking ONE bounded second look at the next ${SECOND_LOOK_LIST_ROWS} rows.\n`,
    );
    let second = null;
    try {
      second = await resolveSecondLook(runGh, repo, cap, {
        // The RAW offset the first pass consumed, NOT LIST_LIMIT: the two are
        // equal only while MAX_CANDIDATE_EVALUATIONS === LIST_LIMIT, and a
        // LIST_LIMIT skip under a LOWER eval cap would leave the rows between
        // them read by neither pass — a permanent hole in the middle of the
        // window. `min` because the API applies LIST_LIMIT first, so the first
        // pass can never have consumed more raw rows than that; and because N
        // filtered stubs span at least N raw rows, this can only overlap the
        // first pass, never jump past it.
        skipRawRows: Math.min(MAX_CANDIDATE_EVALUATIONS, LIST_LIMIT),
        // Start from what the first pass PROVED rather than re-deriving it on
        // half the budget — see resolveFamilies' `options.seed`. Without this
        // the second look can select a stub whose family this same run already
        // stood down, which is a duplicate autofix PR with no rate limit
        // anywhere in the story.
        seed: resolved,
      });
    } catch (err) {
      // The second look's list read is the ONE `gh` call in this leg with no
      // fail-soft handler under it, and this PR put it on the frequent path:
      // once the queue is >= LIST_LIMIT rows, EVERY no-selection run depends on
      // it. Unhandled, a rejection propagates to `main`, sets exit 1, and kills
      // the step under `set -euo pipefail` — taking the whole run record with
      // it, including the DEGRADED line a throttled run needs most. So it is
      // caught: the FIRST pass completed and its report is valid and complete
      // (it selected nothing by precondition, so no entry is lost), and the
      // only thing missing is the look past the ceiling. Say so, and let the
      // rate-limit check below degrade the run if that is why it failed.
      const message = err instanceof Error ? err.message : String(err);
      window.secondLookFailed = true;
      process.stderr.write(
        `::warning::the bounded second look could not read past the list ceiling: ${message.split("\n")[0]}; the first pass's result stands.\n`,
      );
    }
    if (second) {
      window.secondLookTotal = second.total;
      window.secondLookEvaluated = second.evaluated;
      // The honest "there is MORE past even this" signal, taken off the raw row
      // count. `total` saturates at SECOND_LOOK_LIST_ROWS by construction, so on
      // its own it reads the same at 100 further stubs and at 5,000 — and the
      // pipeline note names this line the standing tripwire for queue regrowth.
      window.secondLookFull = second.full === true;
      // Partitioned through the SAME classifier the first pass used, so a
      // second-look family deferral is never reported as a fix_scope skip.
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
    }

    if (state.rateLimited > 0) return finishDegraded();
  }

  const report = finish();
  summarize(report.entries.length);
  return report;
}

/** Matrix entries only — the emitted contract, unchanged. `selectAutofixRun`
 * carries the deferral and fix_scope-skip reports the run record needs
 * alongside it. */
export async function selectAutofixCandidates(options, deps = {}) {
  const { entries } = await selectAutofixRun(options, deps);
  return entries;
}

// ---------------------------------------------------------------------------
// CLI ENTRY. The option contract, the help text, the report writers and
// `--emit-verdict` live in sentry-autofix-select-cli.mjs; `main` stays here
// because it is the one function that needs both halves, and because the
// workflow invokes THIS file (three call sites in .github/workflows/
// sentry-autofix.yml) — the executable entry point must not move.
// ---------------------------------------------------------------------------

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
  const run = await selectAutofixRun(options);
  const { lostDegradedSignal } = writeRunReports(options, run);
  process.stdout.write(`${JSON.stringify(run.entries)}\n`);
  if (lostDegradedSignal) {
    // The array contract still held — it was written above, and it is `[]`, so
    // no PR can be opened from this run either way. What cannot hold is silence:
    // failing the step is the only remaining way to say "this run stood down"
    // once the file that says it is gone. Loud beats a green tracker line that
    // is not true.
    process.stderr.write(
      "::error::selection was DEGRADED but the truncations report could not be written, so the run would render as a healthy idle one; failing the step instead.\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
