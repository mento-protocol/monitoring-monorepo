/**
 * The BUDGET and INSTRUMENTATION of one Sentry AUTOFIX selection run
 * (scripts/sentry-autofix-select.mjs): what bounds a run's spend, what measures
 * it, what latches it shut when GitHub throttles it, and how it reports itself
 * when it stands down. Extracted so the selector keeps the window, the family
 * orchestration, the decisions and its CLI, and this module owns everything that
 * BOUNDS or OBSERVES a run rather than deciding one.
 *
 * One subject seen from both sides, which is why the read cap sits beside the
 * call counter: `MAX_CANDIDATE_EVALUATIONS` is the PREDICTED per-run spend (the
 * whole 782-invocation arithmetic in the pipeline note's § "Cost bound" starts
 * from `2 ×` it), `state.ghCalls` is the MEASURED one, and
 * `windowCeilingWarning` is the guard that the prediction is real rather than a
 * silent no-op above `LIST_LIMIT`. It also puts the first pass's cap/guard pair
 * in the same shape as the second look's, which already lives outside the
 * selector in sentry-autofix-second-look.mjs; the selector re-exports both.
 *
 * Six pieces, none of which decides whether a stub is selectable:
 *   - `MAX_CANDIDATE_EVALUATIONS` / `windowCeilingWarning` — the per-run read
 *     bound and the run-time check that it is not a no-op;
 *   - `newRunState` — the two counters, defined once beside everything that
 *     touches them;
 *   - `instrumentRunGh` — the counter and the throttle latch, on every `gh` call
 *     the leg makes;
 *   - `emptyWindow` / `noTruncations` — the zero-state record shapes a run
 *     returns when it never got far enough to fill them;
 *   - `degradeReport` / `summarizeRun` — the only two things a run says about
 *     itself on stderr.
 *
 * FAIL CLOSED is the contract this module carries, and it has two halves that
 * are easy to conflate. `instrumentRunGh` RETHROWS — deliberately, so every
 * fail-soft handler downstream runs its normal path unchanged — which means the
 * standing-down is the CALLER's job: it checks `state.rateLimited` and returns
 * `degradeReport(state, …)` rather than selecting on data it knows is
 * unreliable. A read with no fail-soft handler under it must therefore be
 * wrapped by its caller, or the rethrow escapes and kills the select step under
 * `set -euo pipefail` — taking the degradation report with it. The selector
 * wraps all three such reads; see its `selectAutofixRun`.
 */

import {
  ghFailureText,
  isRateLimitFailure,
  LIST_LIMIT,
} from "./sentry-autofix-queue-io.mjs";

// How many window stubs one run may READ. The family union is transitive, so
// selection can no longer stop at the first `cap` stubs — but "evaluate the
// whole window" makes the run's `gh` cost scale with LIST_LIMIT (one `issue
// view` plus one `pr list` each, ~400 sequential subprocesses at the ceiling)
// inside the select job's `timeout-minutes` budget, and family deferral writes
// nothing, so a collapsed family of K leaves K-1 PERMANENT window residents that
// are re-read every run. That is monotonic growth driven from outside: every new
// error fingerprint an unauthenticated dashboard visitor produces can add one.
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
// 200, not 50: 50 left 150 rows of a full window unread every run, which —
// combined with family deferral writing nothing — is the starvation
// sentry-autofix-second-look.mjs exists to break. The cost is bounded and paid
// for: the select job's `timeout-minutes` is 25, and 1 list + 2×200 + 120 = 521
// serial `gh` INVOCATIONS at a pessimistic ~1 s/call is ~9 minutes. (522 API
// REQUESTS — the list invocation paginates at 100 rows. The two units are
// tracked separately; see sentry-autofix-second-look.mjs § COST ARITHMETIC.)
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

/**
 * The per-run counters every function here reads or writes. One factory rather
 * than an object literal at the call site: the shape is shared across this whole
 * module and the selector's stand-down checks, so a key defined in one place and
 * read in five is exactly the drift `emptyWindow` exists to prevent.
 *
 * `ghCalls` counts REAL invocations (it is the drift detector for the timeout
 * arithmetic) and `rateLimited` counts REAL throttle events — never loop
 * iterations after the first latch.
 */
export function newRunState() {
  return { ghCalls: 0, rateLimited: 0 };
}

/**
 * Wrap the run's `gh` driver so ONE place sees every invocation the select leg
 * makes. Three jobs, all otherwise unmeasurable:
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
 * 3. STOP SPENDING ONCE THROTTLED. The decision in (2) is taken at pass
 *    boundaries, but the loops that reach them are long: the per-stub loop alone
 *    is 2 × MAX_CANDIDATE_EVALUATIONS calls. Without this, one 403 at the head
 *    of the window is followed by ~400 more requests fired into an ACTIVE
 *    throttle before the run stands down — and GitHub's secondary limits EXTEND
 *    on continued requests and escalate to abuse detection, on a repo-shared
 *    free-plan `GITHUB_TOKEN` every other workflow draws from. "Fail closed"
 *    that spends 400 more requests is not closed at the token level. So the
 *    first rate-limit-shaped failure latches, and every later call rejects
 *    IMMEDIATELY without spawning `gh`. The same one place, for the same reason
 *    it is one place: it covers reads added later, for free.
 *
 *    It is a rejection, not a silent empty result, precisely so every existing
 *    fail-soft handler runs its normal path — and the run stands down anyway,
 *    because `state.rateLimited` is already nonzero by then. Latched calls are
 *    NOT counted: `ghCalls` must stay a count of real invocations (it is the
 *    drift detector for the timeout arithmetic), and `rateLimited` must stay a
 *    count of real throttle events, not of loop iterations after the first.
 *
 * Non-rate-limit transients keep their existing fail-soft behaviour untouched:
 * only `isRateLimitFailure` text degrades the run.
 */
export function instrumentRunGh(baseRunGh, state) {
  return async (args) => {
    if (state.rateLimited > 0) {
      // Deliberately argv-free and rate-limit-shape-free: this text reaches
      // `ghFailureText`, and a message that matched `isRateLimitFailure` would
      // inflate the throttle count with one entry per latched call.
      throw new Error(
        "selection stood down: an earlier gh read failed rate-limit-shaped, so this read was not issued",
      );
    }
    state.ghCalls += 1;
    try {
      return await baseRunGh(args);
    } catch (err) {
      // Classify gh's STDERR, not the whole rejection message: the message
      // carries the argv, and argv carries agent-authored family ids.
      const text = ghFailureText(err);
      if (isRateLimitFailure(text)) {
        state.rateLimited += 1;
        if (state.rateLimited === 1) {
          process.stderr.write(
            `::error::rate-limit-shaped gh failure during selection: ${text.split("\n")[0]}; no further gh reads will be issued this run.\n`,
          );
        }
      }
      throw err;
    }
  };
}

/** The Window tripwire record at its zero state — every field the workflow's
 * `jq` reads, before anything has been counted. One source rather than a literal
 * per return path: the workflow reads these key names, so a typo in one copy
 * silently zeroes a line of the run record and no test that asserts the returned
 * OBJECT would see it. */
export const emptyWindow = () => ({
  total: 0,
  evaluated: 0,
  secondLook: false,
  secondLookTotal: 0,
  secondLookEvaluated: 0,
  secondLookFull: false,
  secondLookFailed: false,
  ghCalls: 0,
});

/** The truncation record with nothing cut — the baseline the paths that never
 * reach the family resolver return. Same reason as `emptyWindow`: `rateLimited`
 * in particular is the one key the degraded disposition rides on. */
export const noTruncations = () => ({
  handledOverflow: 0,
  reverseBudget: false,
  reverseNonconvergent: false,
  rateLimited: 0,
});

/**
 * Fail CLOSED on throttling. Every read this leg issues answers a dedupe or
 * blocker question, and every one of them fails SOFT toward MORE candidates, so
 * a rate-limited run cannot tell "no prior PR" from "GitHub refused to tell me"
 * — and would open a DUPLICATE autofix PR looking green. So the run does not
 * SELECT on data it knows is unreliable.
 *
 * "Fail closed" here means ZERO matrix entries plus a loud report, NOT a throw:
 * the workflow's select step asserts it always emits a valid JSON array and
 * never fails (the leg runs under `set -euo pipefail`), so throwing would break
 * the contract this whole job is built around. The stand-down reports are still
 * returned — they cost nothing and an operator reading the tracker needs the
 * whole picture — but the degraded line dominates them.
 */
export function degradeReport(state, report) {
  process.stderr.write(
    `::error::selection DEGRADED: ${state.rateLimited} rate-limit-shaped gh read failure(s); emitting ZERO entries rather than selecting on unreliable dedupe data.\n`,
  );
  return {
    ...report,
    entries: [],
    truncations: { ...report.truncations, rateLimited: state.rateLimited },
  };
}

/**
 * The single greppable operator line for the run. It takes the emitted count as
 * an ARGUMENT rather than reading it off a report, because `degradeReport`
 * replaces `entries` with `[]` only when it runs: a line built from the
 * pre-degradation report said `entries=2` on runs that emitted zero — on exactly
 * the fail-closed path, the one an operator greps this line to understand.
 */
export function summarizeRun(state, window, emitted) {
  const secondLook = window.secondLook
    ? `${window.secondLookEvaluated}/${window.secondLookTotal}${window.secondLookFull ? "+" : ""}${window.secondLookFailed ? " (failed)" : ""}`
    : "no";
  process.stderr.write(
    `gh-calls=${state.ghCalls} window=${window.evaluated}/${window.total} second-look=${secondLook} entries=${emitted}\n`,
  );
}
