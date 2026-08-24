/**
 * THE ONE WAY TO RE-QUEUE A SENTRY TRIAGE QUEUE STUB.
 *
 * "Re-queue" means: make a stub selectable for a fresh triage round — restore
 * `sentry:needs-triage`, shed every marker describing how the PREVIOUS round was
 * handled (REOPEN_SHED_LABELS), and reopen it. Before this module that sequence
 * was open-coded at each producer, and every producer independently decided
 * whether it also posted the verdict-staleness fence. Seven distinct defects came
 * out of that arrangement in one PR (#1716), each locally plausible, all of them
 * the same shape: a re-queue whose fence, ordering, claim, or admissibility check
 * disagreed with the rule that lived only in prose.
 *
 * So the rule lives here, and the cause is an argument:
 *
 *   `sentry-evidence` — new Sentry events made the previous verdict describe a
 *   dead occurrence. MUST fence: `selectVerdictComment`
 *   (scripts/sentry/triage/sentry-triage-project-core.mjs) accepts the newest verdict only when
 *   it is newer than the newest comment starting with REGRESSION_PREFIX. Without
 *   the fence, a triage round that dies before posting lets the `verdict` job
 *   (which runs under `always()`) accept the stale verdict and close the stub over
 *   a live regression.
 *
 *   `bookkeeping` — a close whose response was lost, a hand-edit, a compensation.
 *   MUST NOT fence: nothing about the Sentry issue changed, so the verdict already
 *   computed for it is still valid. Fencing it discards a good verdict and forces
 *   a pointless re-triage. Over-fencing is exactly as wrong as under-fencing, and
 *   quieter.
 *
 * The invariants this module owns, each paid for by one of those defects:
 *
 *  1. Fence IFF the cause is Sentry evidence — decided from `cause`, never from
 *     what a caller passes as the comment body.
 *  2. The fence text has ONE definition (`buildRegressedComment`) and this module
 *     is its only caller. A caller contributes prose that renders BELOW the fence
 *     line; it can never author the fence line itself.
 *  3. Post the fence BEFORE mutating labels; change state LAST. An interrupted run
 *     must leave a fenced-but-unqueued stub (inert, retried), never a
 *     queued-but-unfenced one (the close-over-a-live-regression setup). Inside
 *     the label step the same rule again: ADD `sentry:needs-triage` in its own
 *     call before SHEDDING the previous round's markers, because one `gh issue
 *     edit` carrying both flags is two concurrent mutations and the losable half
 *     is the one every recovery path reads (`buildRequeueAddLabelArgs`).
 *  4. The exclusion set records ATTEMPTS, not successes: `claim` fires before any
 *     I/O, so a re-queue that throws half-way is never inherited by the
 *     fence-free bookkeeping sweep inside the same run.
 *  5. "Is this stub protected?" is answered by running `selectVerdictComment` over
 *     LIVE comments and requiring that no admissible verdict survives — never by
 *     a fence comment's presence, and never by body equality. Presence is not
 *     admissibility: the consumer selects by RECENCY, so a fence that exists but
 *     predates the newest verdict protects nothing.
 *  6. Every read of a comment body is author-fenced through `selectMarkedComment`.
 *     This repo is PUBLIC; an unfenced body match is satisfiable by anyone.
 *  7. Live state is revalidated immediately before mutating when the caller's
 *     premise is a snapshot, and a failed read aborts rather than proceeding.
 *
 * Callers declare a CAUSE and a small, explicit policy. They never reconstruct
 * the sequence, and they never decide the fence.
 */

import {
  NEEDS_TRIAGE_LABEL,
  neutralizeUntrusted,
  QUEUE_LABEL,
  REOPEN_SHED_LABELS,
  STRAND_SHAPE_CLOSED_NEEDS_TRIAGE,
  STRAND_SHAPE_OPEN_VERDICT,
  truncateTitle,
} from "./sentry-triage-queue-contract.mjs";
import {
  selectMarkedComment,
  selectVerdictComment,
} from "./sentry-triage-project-core.mjs";
import { unwindAfterSettlement } from "./sentry-triage-requeue-sentinel.mjs";

// ---------------------------------------------------------------------------
// Causes.
// ---------------------------------------------------------------------------

/** New Sentry events. Any prior verdict describes a dead occurrence. */
export const REQUEUE_CAUSE_SENTRY_EVIDENCE = "sentry-evidence";
/** A lost close response, a compensation, a hand-edit. Nothing in Sentry moved. */
export const REQUEUE_CAUSE_BOOKKEEPING = "bookkeeping";

const REQUEUE_CAUSES = new Set([
  REQUEUE_CAUSE_SENTRY_EVIDENCE,
  REQUEUE_CAUSE_BOOKKEEPING,
]);

/**
 * THE RULE, as one expression: fence iff the cause is new Sentry evidence.
 *
 * An unknown cause THROWS rather than defaulting. Both defaults are wrong — a
 * silent no-fence buries regressions, a silent fence discards valid verdicts —
 * and a caller that cannot name its cause has not decided anything yet.
 */
export function requeueFences(cause) {
  if (!REQUEUE_CAUSES.has(cause)) {
    throw new Error(
      `Unknown re-queue cause ${JSON.stringify(cause)}; a re-queue must declare ${REQUEUE_CAUSE_SENTRY_EVIDENCE} or ${REQUEUE_CAUSE_BOOKKEEPING} so the verdict-staleness fence is decided rather than inherited.`,
    );
  }
  return cause === REQUEUE_CAUSE_SENTRY_EVIDENCE;
}

// ---------------------------------------------------------------------------
// The two comment bodies, each with exactly one definition.
// ---------------------------------------------------------------------------

/**
 * THE FENCE. Its prefix is REGRESSION_PREFIX
 * (scripts/sentry/triage/sentry-triage-project-core.mjs), which is what makes
 * `selectVerdictComment` treat every verdict older than this comment as stale.
 *
 * `buildRequeueFence` is its only caller, so no site can post a fence the
 * chokepoint did not decide on, and none can post a re-queue comment that merely
 * looks like one.
 */
export function buildRegressedComment(lastSeen) {
  // `lastSeen` should be a Sentry-generated ISO timestamp, but it still
  // transits Sentry's API from event data — neutralize + bound it like every
  // other Sentry-derived string (no-op for a legitimate timestamp).
  return `Regressed in Sentry (last seen ${truncateTitle(neutralizeUntrusted(lastSeen), 90)})`;
}

/**
 * THE BOOKKEEPING NOTE. Fixed text — no Sentry-derived or otherwise untrusted
 * input — and deliberately NOT the fence: this repair is not a new Sentry
 * occurrence, so a verdict already posted for the stub stays valid and
 * admissible.
 *
 * Written as INTENT, not outcome, because of where it sits in the sequence: the
 * state change goes last, so this note is posted while the stub is still closed
 * and the reopen may yet fail. Wording it as completed fact ("Reopened…",
 * "Re-queued…") left a closed stub carrying a note about something that had not
 * happened, and every retry added another false entry.
 *
 * The repetition itself is not the bug and must not be suppressed: a stub that
 * keeps failing to reopen SHOULD accumulate a note per attempt, because that
 * repetition is the honest signal. So the text says what this run is doing and
 * what a failure means, and reads correctly either way.
 *
 * One note per stranded SHAPE. They describe different damage — a stub closed
 * while still queued, versus one verdicted and never settled (issue #1817) — and
 * an operator reading the stub has to be able to tell which happened. An unknown
 * shape throws, before any I/O, for the same reason `buildRequeueNote` does: a
 * caller that cannot name the shape has not decided anything.
 */
const STRANDED_RECOVERY_NOTES = {
  [STRAND_SHAPE_CLOSED_NEEDS_TRIAGE]:
    "Sentry triage ingest is recovering this queue stub: it was closed while " +
    "still carrying `sentry:needs-triage`, a pairing no pipeline stage can " +
    "see — the triage selector lists open stubs only. It is shedding the stale " +
    "verdict, projection and autofix markers, and a reopen follows this note. " +
    "If that reopen fails the stub stays closed and the next scheduled run " +
    "retries, so this note can appear more than once.",
  [STRAND_SHAPE_OPEN_VERDICT]:
    "Sentry triage ingest is recovering this queue stub: it has sat open with " +
    "a verdict label and no `sentry:needs-triage` since a triage round applied " +
    "that verdict and never settled it — a shape no pipeline stage can see, " +
    "because the triage selector needs the label and every later step skips a " +
    "stub that is not queued. It is restoring `sentry:needs-triage` and " +
    "shedding the stale verdict, projection and autofix markers, so the next " +
    "scheduled run re-triages it. If any of those writes does not land, the " +
    "run goes red naming what survived, so this note can appear more than once.",
};

export function buildStrandedRecoveryComment(
  shape = STRAND_SHAPE_CLOSED_NEEDS_TRIAGE,
) {
  const note = STRANDED_RECOVERY_NOTES[shape];
  if (!note) {
    throw new Error(
      `Unknown stranded shape ${JSON.stringify(shape)}; a recovery must name one of ${Object.keys(STRANDED_RECOVERY_NOTES).join(", ")}.`,
    );
  }
  return note;
}

/**
 * The comment a re-queue posts BEFORE it touches labels, or null when the cause
 * does not fence.
 *
 * `prose` is the caller's human-facing explanation, rendered as lines BELOW the
 * fence line with one blank line between. The fence line itself is always
 * `buildRegressedComment`, so a caller can explain a refusal without being able
 * to author — or omit — the thing the parser reads.
 */
export function buildRequeueFence(
  cause,
  { lastSeen = null, prose = null } = {},
) {
  if (!requeueFences(cause)) return null;
  const fence = buildRegressedComment(lastSeen);
  return prose?.length ? [fence, "", ...prose].join("\n") : fence;
}

// ---------------------------------------------------------------------------
// Admissibility and selectability.
// ---------------------------------------------------------------------------

/**
 * Would a verdict still be re-appliable to this stub? True means DANGER: the
 * `verdict` job could pick a previous round's verdict off these comments and
 * close the stub with it.
 *
 * PRESENCE IS NOT ADMISSIBILITY, and that distinction is the whole point.
 * An earlier check asked "does a trusted fence exist?" — a different question
 * from the one the consumer asks. `selectVerdictComment` selects by RECENCY: it
 * takes the newest verdict and rejects it only when a newer regression comment
 * exists. A fence that exists but PREDATES the newest verdict therefore protects
 * nothing, and the archive's refusal body is byte-identical across runs for one
 * `lastSeen`, so a stub really can carry an old copy underneath a newer verdict.
 *
 * So ask the consumer's question with the consumer's own primitive: no admissible
 * verdict may survive. Sharing `selectVerdictComment` is what stops the guard and
 * the thing it guards against from drifting apart again.
 */
export function hasAdmissibleVerdict(comments) {
  return selectVerdictComment(comments ?? []).body !== null;
}

/**
 * Everything Stage B's selector matches, and it takes THREE things, not two:
 * `--label sentry-triage --label sentry:needs-triage --state open`
 * (.github/workflows/sentry-triage-agent.yml). A stub missing any of them is
 * invisible to triage, and — if its `closedAt` postdates the regression — to
 * ingest as well.
 *
 * `sentry-triage` was missing here while the docstring claimed this was the
 * selector, which made it a predicate that could report a stub selectable when
 * Stage B would never see it (issue #1817). It is the END-STATE test every
 * `verify-end-state` re-queue is judged by, so the omission let a re-queue shed a
 * stub's verdict, leave it unselectable, and still report success — the exact
 * outcome the verification exists to catch. Every caller wanted the real
 * selector; none wanted the pair.
 *
 * The verifier CORRECTS the other two — it reopens a closed stub and re-adds
 * `sentry:needs-triage` — and deliberately does NOT correct this one. Removing
 * `sentry-triage` is how a human retires a stub for good, so putting it back
 * would overrule the withdrawal. Its absence is reported, never repaired.
 *
 * The state test demands OPEN rather than not-CLOSED. Every `readStub` feeding
 * this normalizes a missing or unexpected `state` to `""` — a truncated `gh`
 * payload, a JSON shape change, a field the reader forgot to request — and `""`
 * is not `"CLOSED"`, so the loose test called such a stub selectable without any
 * read ever having confirmed it open. That is the one thing this predicate must
 * never do: it is the END-STATE test, so a wrong true is a re-queue reporting
 * success over a stub Stage B cannot see. Stage B's selector says `--state open`;
 * ask for exactly that and an unreadable state fails closed into the loud
 * stranded path instead of passing verification by default.
 */
export function isSelectableForTriage({ state, labels } = {}) {
  const names = Array.isArray(labels) ? labels : [];
  return (
    String(state ?? "").toUpperCase() === "OPEN" &&
    names.includes(QUEUE_LABEL) &&
    names.includes(NEEDS_TRIAGE_LABEL)
  );
}

/**
 * The label edit every re-queue makes, as TWO ordered calls: restore
 * `sentry:needs-triage` first, then shed every marker describing the previous
 * round (REOPEN_SHED_LABELS). Removing an absent label is a no-op for
 * `gh issue edit` (the labels themselves always exist because the ingest label
 * bootstrap runs first). Exported for tests.
 *
 * ONE `gh issue edit --add-label … --remove-label …` is NOT one write (issue
 * #1693). The CLI fires `addLabels` and `removeLabels` as discrete, concurrent
 * GraphQL mutations (cli/cli, `pkg/cmd/pr/shared/editable_http.go`: "Labels are
 * updated through discrete mutations"), so a partial failure can land the remove
 * without the add. On the regression-reopen path that produced a CLOSED stub
 * with `sentry:archived` shed and `sentry:needs-triage` never applied — a state
 * NEITHER recovery path can see. `decideDedupAction` gates its baseline branch
 * on `sentry:archived`, so it falls back to `closedAt`, which postdates the very
 * regression the baseline exists to catch; the stranded sweep gates on
 * `sentry:needs-triage`, which is absent. The run goes red once and the stub
 * never self-heals after that.
 *
 * Ordering the two calls removes the state rather than narrowing it. Add first
 * and every interruption lands on a pairing something still sees: nothing
 * written yet (the markers survive, ingest keeps its baseline branch, next run
 * retries), or `sentry:needs-triage` written and the shed not (the stranded
 * pairing, which the sweep reopens — and on a fencing cause the fence is already
 * on the stub, because the fence goes first). The reverse order is what today's
 * single call can degrade to, so the cost is one API call per re-queue.
 *
 * It does briefly leave `sentry:needs-triage` beside a stale verdict marker.
 * That window is not new — the concurrent mutations can already produce it — and
 * the state change goes last, so the stub is still CLOSED and invisible to Stage
 * B's `--state open` selector for the whole of it on the ingest path.
 */
export function buildRequeueAddLabelArgs(issueNumber, repo) {
  return [
    "issue",
    "edit",
    String(issueNumber),
    "-R",
    repo,
    "--add-label",
    NEEDS_TRIAGE_LABEL,
  ];
}

/**
 * `except` withholds a marker from the blind shed. Exactly one caller uses it —
 * a re-queue that declares a settlement SENTINEL (see `requeueQueueStub`) — and
 * withholding is what makes the sentinel work: a marker this call erases is a
 * marker no later read can testify about.
 */
export function buildRequeueShedLabelArgs(issueNumber, repo, { except } = {}) {
  const withheld = new Set(except ?? []);
  return [
    "issue",
    "edit",
    String(issueNumber),
    "-R",
    repo,
    "--remove-label",
    REOPEN_SHED_LABELS.filter((name) => !withheld.has(name)).join(","),
  ];
}

/**
 * Fails CLOSED: a read that throws returns true, so an unverifiable stub counts
 * as unsafe.
 */
async function admissibleVerdictSurvives(readStub, issueNumber) {
  try {
    const live = await readStub(issueNumber);
    return hasAdmissibleVerdict(live.comments);
  } catch (err) {
    process.stderr.write(
      `::notice::Could not re-read #${issueNumber} to check whether a previous verdict is still admissible (${
        err instanceof Error ? err.message : String(err)
      }); treating it as unsafe.\n`,
    );
    return true;
  }
}

/**
 * Drive a stub to the selectable pair and VERIFY it got there, or fail loudly.
 *
 * This exists because checking each write's return value kept missing a layer:
 * the reopen was absent, then a failed read aborted it, then the reopen write
 * itself could fail — three rounds, one location, each fix covering only the
 * failure mode in front of it. Asserting the END STATE covers all of them and
 * whatever comes next, because it observes the thing that actually matters
 * rather than the success of the steps meant to produce it.
 *
 * Observe, correct what is wrong, observe again. Both corrections are idempotent
 * so a retry is safe and cheap, and it runs before failing. When the final
 * observation still disagrees — or could never be taken — the stub is stranded
 * and only a human can free it, so this throws and the run goes RED with an
 * `::error::` naming what was actually seen.
 *
 * `fallbackState` is the caller's pre-run observation, used only to decide
 * whether to attempt a reopen when a read fails; it never satisfies the
 * invariant, which requires a real confirming read.
 *
 * Returns the confirming read, so the caller can judge the rest of the stub's
 * state from what was actually observed rather than from what its own writes
 * reported — the same ambiguous-response discipline the archive reconciler uses.
 */
/**
 * The revalidating read of invariant 7, with the SAME bounded retry
 * `ensureSelectableForTriage` gives its own reads (#1782). The asymmetry was the
 * defect: the verdict step's first compensating exit fires precisely BECAUSE a
 * `gh` read on that stub just failed, so the compensation's opening read is
 * correlated with a failure that is usually transient — and one unretried
 * attempt turned that blip into an abort.
 *
 * Bounded, and it changes nothing about the direction of failure: a read that
 * fails every attempt still THROWS, before any write, so a premise that could
 * not be revalidated is never assumed. It narrows the window; it does not open
 * a door to a blind re-queue.
 */
async function readForRevalidation(readStub, issueNumber, attempts = 2) {
  let lastError = null;
  for (let round = 1; round <= attempts; round += 1) {
    try {
      return await readStub(issueNumber);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(
        `::notice::Could not read #${issueNumber} to revalidate the re-queue premise (${lastError.message}); attempt ${round} of ${attempts}.\n`,
      );
    }
  }
  throw lastError;
}

export async function ensureSelectableForTriage(
  { writeGh, readStub },
  { repo, issueNumber, fallbackState = "CLOSED", attempts = 2 },
) {
  let observed = null;
  let readError = null;

  const observe = async () => {
    try {
      const live = await readStub(issueNumber);
      observed = live;
      readError = null;
      return live;
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `::notice::Could not read #${issueNumber} while re-queuing it for triage (${readError}); correcting from its pre-run state (${fallbackState}) and re-checking.\n`,
      );
      return null;
    }
  };

  for (let round = 1; round <= attempts; round += 1) {
    const live = await observe();
    if (live && isSelectableForTriage(live)) return live;

    // WITHDRAWN: stop, and write nothing more. `sentry-triage` gone from a read
    // we actually took means a human retired this stub while the re-queue was
    // in flight. Neither correction below can make it selectable again — only
    // re-adding the label would, and doing that would overrule the withdrawal —
    // so continuing would just be more writes on an issue somebody removed from
    // the queue. Fall through to the failure below, which says what was seen.
    // A FAILED read is different and keeps the old behaviour: `live` is null, we
    // know nothing about membership, and correcting from `fallbackState` is
    // still the right guess.
    if (live && !(live.labels ?? []).includes(QUEUE_LABEL)) break;

    // Correct whatever is — or, with no read, may be — wrong. Both writes are
    // idempotent, so a repeat costs nothing and a lost response is harmless.
    const looksClosed = live
      ? live.state === "CLOSED"
      : String(fallbackState ?? "").toUpperCase() === "CLOSED";
    const missingLabel = live
      ? !live.labels.includes(NEEDS_TRIAGE_LABEL)
      : false;
    if (looksClosed) {
      try {
        process.stderr.write(
          `::notice::Reopening #${issueNumber} so the live regression is visible to triage (round ${round}).\n`,
        );
        await writeGh(["issue", "reopen", String(issueNumber), "-R", repo]);
      } catch (err) {
        process.stderr.write(
          `::notice::Reopen of #${issueNumber} reported a failure (${
            err instanceof Error ? err.message : String(err)
          }); the verification read decides.\n`,
        );
      }
    }
    if (missingLabel) {
      try {
        await writeGh([
          "issue",
          "edit",
          String(issueNumber),
          "-R",
          repo,
          "--add-label",
          NEEDS_TRIAGE_LABEL,
        ]);
      } catch (err) {
        process.stderr.write(
          `::notice::Re-adding ${NEEDS_TRIAGE_LABEL} to #${issueNumber} reported a failure (${
            err instanceof Error ? err.message : String(err)
          }); the verification read decides.\n`,
        );
      }
    }
  }

  // The mandatory final verification, on the main path — never skippable, and
  // never reached by a correction whose result nobody looked at.
  const finalLive = await observe();
  if (finalLive && isSelectableForTriage(finalLive)) return finalLive;

  const seen = observed
    ? `state=${observed.state}, labels=${observed.labels.join("|")}`
    : `unreadable (${readError})`;

  // Membership gone is a DIFFERENT operator story from the rest, and telling
  // them apart is the whole value of the message: nothing here is broken, a
  // human retired the stub mid-re-queue and this run had already shed its
  // previous-round markers by then. Say that, and do not ask anyone to undo the
  // withdrawal by re-adding the label.
  const withdrawn =
    observed !== null && !(observed.labels ?? []).includes(QUEUE_LABEL);
  if (withdrawn) {
    process.stderr.write(
      `::error::Queue stub #${issueNumber} lost ${QUEUE_LABEL} while it was being re-queued for triage (${seen}), so it is no longer in the queue and Stage B will never select it. This run had already shed its previous-round markers (${REOPEN_SHED_LABELS.join(", ")}). Nothing is re-adding ${QUEUE_LABEL} — removing it is how a stub is retired. If the removal was a mistake, re-add ${QUEUE_LABEL} and ${NEEDS_TRIAGE_LABEL} by hand.\n`,
    );
    throw new Error(
      `Queue stub #${issueNumber} left the queue (${QUEUE_LABEL} removed) during a re-queue for triage (${seen}).`,
    );
  }

  process.stderr.write(
    `::error::Queue stub #${issueNumber} could not be confirmed open and carrying ${NEEDS_TRIAGE_LABEL} while being re-queued for triage (${seen}). It is STRANDED — restore it by hand: reopen it if it is closed, add ${NEEDS_TRIAGE_LABEL}, and remove any stale marker from the previous round (${REOPEN_SHED_LABELS.join(", ")}).\n`,
  );
  throw new Error(
    `Queue stub #${issueNumber} is not selectable for triage after a re-queue (${seen}).`,
  );
}

// ---------------------------------------------------------------------------
// The chokepoint.
// ---------------------------------------------------------------------------

/** ABORT: any write failure propagates, leaving the sequence incomplete at a
 * point the ordering guarantees is safe (ingest's two paths — the run retries).
 * VERIFY_END_STATE: reported failures are provisional; the sequence completes and
 * the END STATE is read and judged (the archive's refusal — it is past the point
 * where its caller's reconciler can help, so the stub must be driven to
 * selectable and anything still wrong surfaced loudly afterwards). */
export const REQUEUE_ON_FAILURE_ABORT = "abort";
export const REQUEUE_ON_FAILURE_VERIFY_END_STATE = "verify-end-state";

/**
 * Re-queue a queue stub for a fresh triage round.
 *
 * deps:
 *   `writeGh(args)`      — perform a mutating `gh` call. The caller binds its own
 *                          dry-run / token policy into this.
 *   `readStub(number)`   — live `{ state, labels, comments? }`. Required whenever
 *                          the declared policy reads live state.
 *   `readComments(n)`    — live comment objects (author included). Required only
 *                          for `dedupeFence`.
 *   `claim()`            — optional; record this ATTEMPT in the caller's
 *                          exclusion set. Invoked before any I/O (invariant 4).
 *
 * options:
 *   `cause`              — REQUEUE_CAUSE_*; decides the fence and nothing else may.
 *   `lastSeen`           — the occurrence the fence names (sentry-evidence).
 *   `fenceProse`         — extra lines rendered under the fence line.
 *   `note`               — the bookkeeping note body (bookkeeping causes only).
 *   `dedupeFence`        — skip the post when an author-trusted, byte-identical
 *                          fence is already on the stub. Sound ONLY where the
 *                          gate that produced this re-queue cannot fire twice for
 *                          one `lastSeen` with a verdict in between; see below.
 *   `revalidate`         — `{ check(live), declineNote(live), sentinel? }`. When the
 *                          caller's premise is a snapshot, re-read and stop unless
 *                          it still holds. A failed read PROPAGATES. `sentinel`
 *                          extends that premise across the WRITE window; see below.
 *   `onFailure`          — REQUEUE_ON_FAILURE_*.
 *   `fallbackState`      — pre-run state, for the verify-end-state reopen.
 *
 * Returns `{ requeued, reason, verified, labelError }`.
 */
export async function requeueQueueStub(
  { writeGh, readStub = null, readComments = null, claim = null },
  {
    repo,
    issueNumber,
    cause,
    lastSeen = null,
    fenceProse = null,
    note = null,
    dedupeFence = false,
    revalidate = null,
    onFailure = REQUEUE_ON_FAILURE_ABORT,
    fallbackState = "CLOSED",
  },
) {
  // Decide the fence FIRST, from the cause alone. An unknown cause throws here,
  // before any claim and before any write.
  const fences = requeueFences(cause);
  const verifyEndState = onFailure === REQUEUE_ON_FAILURE_VERIFY_END_STATE;

  // INVARIANT 7, SECOND HALF — the premise re-checked across the WRITE window
  // (issue #1929, ADR 0070). `revalidate` alone re-reads and then writes blind:
  // between those two moments the archive leg — its own per-issue concurrency
  // group — can settle the stub, and the shed then erases the very marker that
  // would have said so. The sentinel names that marker. It is withheld from the
  // shed, so it survives to be READ at the end; observing it on the confirming
  // read means the settlement landed inside this window, and the re-queue
  // unwinds instead of reporting success over a settled occurrence.
  //
  // Only meaningful with the end-state verification, which is what produces the
  // confirming read; declared without it, the sentinel would be a promise
  // nothing checks, so it throws here rather than degrading quietly.
  // The declaration is validated BEFORE any I/O, shape included. A sentinel
  // missing its `declineNote` would throw at the detection site instead — after
  // the add, the shed and the reopen, and before any correction — leaving
  // exactly the open, queued, still-marked stub this mechanism exists to
  // prevent. A malformed declaration must cost nothing, so it costs a throw here.
  const sentinel = revalidate?.sentinel ?? null;
  if (sentinel && !verifyEndState) {
    throw new Error(
      `A re-queue sentinel (${sentinel.label}) needs ${REQUEUE_ON_FAILURE_VERIFY_END_STATE}: without the end-state verification nothing ever reads it back.`,
    );
  }
  if (
    sentinel &&
    !(typeof sentinel.label === "string" && sentinel.label.length > 0)
  ) {
    throw new Error(
      "A re-queue sentinel must name the label it watches for as a non-empty string.",
    );
  }
  if (sentinel && typeof sentinel.declineNote !== "function") {
    throw new Error(
      `A re-queue sentinel (${sentinel.label}) must supply declineNote(live): the detection site reports before it unwinds, and a missing note would throw there — after the writes and before any correction.`,
    );
  }
  // The sentinel must be a label this call would otherwise SHED. Withholding is
  // the whole mechanism, and there is nothing to withhold a label from unless the
  // shed set contains it. A label outside that set inverts the check instead of
  // weakening it: `sentry:needs-triage` passes every check above, survives the
  // filter below trivially, and is then re-ADDED by this very re-queue — so the
  // confirming read finds it every time and unwinds a re-queue nothing settled,
  // closing a stub that should be selectable. That is worse than the fail-open
  // this mechanism replaces, so a declaration that could produce it costs a throw
  // here, before any I/O, like the three above.
  if (sentinel && !REOPEN_SHED_LABELS.includes(sentinel.label)) {
    throw new Error(
      `A re-queue sentinel (${sentinel.label}) must name a label this re-queue sheds (${REOPEN_SHED_LABELS.join(", ")}): the sentinel is a marker withheld from the shed, and a label outside that set is either never removed or re-added by this run, so the confirming read would report a settlement that never happened.`,
    );
  }
  const shedLabels = REOPEN_SHED_LABELS.filter(
    (name) => name !== sentinel?.label,
  );

  // INVARIANT 4 — the exclusion set records ATTEMPTS, not successes, and the
  // record is written before the first thing that can fail. A Sentry-evidence
  // re-queue that throws half-way must not be inherited by the same run's
  // fence-free bookkeeping sweep: that laundering is how a regression re-queue
  // silently loses its fence. `claim` is synchronous, so it survives a throw from
  // anything below.
  claim?.();

  // INVARIANT 7 — revalidate a snapshot-derived premise against live state.
  // A failed read is NOT permission to proceed: it propagates, the stub stays as
  // it is and visible to the next run, and the run goes nonzero. Recovering blind
  // is how a snapshot-driven mutation becomes a snapshot-driven mistake. The read
  // retries within a bound first (see `readForRevalidation`) — a caller reaching
  // here often does so because a read just failed.
  let premise = null;
  if (revalidate) {
    const live = await readForRevalidation(readStub, issueNumber);
    premise = live;
    if (!revalidate.check(live)) {
      process.stderr.write(`::notice::${revalidate.declineNote(live)}\n`);
      return {
        requeued: false,
        reason: "revalidated-away",
        verified: null,
        labelError: null,
      };
    }
  }

  // INVARIANT 1 + 2 + 3 — fence iff Sentry evidence, one definition, posted
  // BEFORE the labels.
  //
  // The ordering is not stylistic. The fence is a PRECONDITION of re-queuing: a
  // selectable stub with no fence is the close-over-a-live-regression setup, and
  // the archive, ingest and agent workflows hold separate concurrency groups, so
  // a triage run can select such a stub inside the window. Post the fence, or do
  // not re-queue at all. Every interruption point then lands on a safe state:
  // fence only (inert, retried), or fence + labels while still closed (the
  // stranded pairing, but FENCED, which the sweep reopens without loss).
  const fence = buildRequeueFence(cause, { lastSeen, prose: fenceProse });
  if (fence) {
    // Posting first widens the window in which a retry could re-post the fence,
    // so the post can be guarded by an identity check — but ONLY when `lastSeen`
    // parses, because that is the sole thing making the body identify a specific
    // occurrence. A missing or unparsable `lastSeen` renders a CONSTANT body, and
    // ingest's gate deliberately fails open there and re-queues on every closed
    // observation: round two would then find round one's comment and skip its own
    // fence, leaving round one's VERDICT (posted after that fence)
    // newest-admissible over a fresh occurrence. Whenever the timestamp cannot
    // establish belonging, always post — a duplicate fence is noise, a missing one
    // buries a regression.
    //
    // INVARIANT 6 — the dedup read is AUTHOR-FENCED through `selectMarkedComment`.
    // This repo is public: without the author check, anyone who guesses the
    // regression's exact `lastSeen` — the stub body publishes a near-miss of it —
    // can pre-post the matching body and have this check suppress the bot's real
    // fence, while `selectVerdictComment` (which does fence on authorship) ignores
    // theirs. `selectMarkedComment` anchors with startsWith rather than equality,
    // which is what we want: a trusted refusal that opens with this exact fence
    // line and then adds prose correctly counts as the fence being in place.
    const identifiesOccurrence = !Number.isNaN(Date.parse(lastSeen ?? ""));
    const alreadyFenced =
      dedupeFence &&
      identifiesOccurrence &&
      selectMarkedComment(await readComments(issueNumber), fence) !== null;
    if (alreadyFenced) {
      process.stderr.write(
        `::notice::Regression fence for ${lastSeen} already present on #${issueNumber}; not re-posting.\n`,
      );
    } else {
      try {
        await writeGh([
          "issue",
          "comment",
          String(issueNumber),
          "-R",
          repo,
          "--body",
          fence,
        ]);
      } catch (err) {
        if (!verifyEndState) throw err;
        // A reported failure is not proof. The post can land and lose its
        // response, so the report is checked against a READ before anything is
        // decided — and the question asked is the CONSUMER's (invariant 5), not
        // "is a fence present". Only a stub where a verdict is still admissible
        // aborts.
        const reported = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `::notice::Posting the regression fence on #${issueNumber} reported a failure (${reported}); re-reading the stub to check whether a previous verdict is still admissible.\n`,
        );
        if (await admissibleVerdictSurvives(readStub, issueNumber)) {
          // Abort BEFORE the re-queue. The stub is left exactly as it was, so
          // nothing selects it, the fence-free bookkeeping sweep cannot claim it
          // (it has no `sentry:needs-triage`), and the documented
          // workflow_dispatch retry re-runs the whole refusal, fence included.
          // Leaving a known-live regression closed until someone retries is the
          // cost, and it is the right one — this state needs a human to linger,
          // while the alternative needs only a second failure to bury the
          // regression silently.
          throw new Error(
            `Refusing to re-queue #${issueNumber} for triage: the regression fence comment could not be posted (${reported}) and a previous verdict is still admissible, so a failing triage round would close that verdict over this live regression. The stub is unchanged — approval and verdict labels intact — so re-dispatch this workflow to retry the whole refusal.`,
            { cause: err },
          );
        }
        process.stderr.write(
          `::notice::No admissible verdict survives on #${issueNumber} despite the reported failure; continuing.\n`,
        );
      }
    }
  }

  // Labels: restore `sentry:needs-triage`, THEN shed the previous round's
  // markers — two ordered calls, never one edit carrying both flags. See
  // `buildRequeueAddLabelArgs`: the single edit is two concurrent GraphQL
  // mutations, and the half that can be lost is the one both recovery paths
  // depend on (issue #1693).
  let labelError = null;
  try {
    await writeGh(buildRequeueAddLabelArgs(issueNumber, repo));
    await writeGh(
      buildRequeueShedLabelArgs(issueNumber, repo, {
        except: sentinel ? [sentinel.label] : [],
      }),
    );
  } catch (err) {
    if (!verifyEndState) throw err;
    // Must NOT propagate past the end-state verification below — that is exactly
    // what let a throw skip the guard. Record it and keep going; the verifier
    // re-adds `sentry:needs-triage` itself, so the stub still becomes selectable.
    //
    // NOTE the sequencing hazard this creates, handled after the verification
    // below: the two writes share one try, so an ADD that reports failure jumps
    // past the SHED entirely — it is never attempted, not merely failed.
    labelError = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `::notice::Re-queue label edit on #${issueNumber} reported a failure (${labelError}); the end-state verification below still runs.\n`,
    );
  }

  // The bookkeeping note describes the repair rather than gating it, so it rides
  // with the label write it explains. (A fencing cause has no note: its comment
  // IS the fence, which must precede the labels.) The note is ADVISORY — the
  // label restoration is load-bearing — so under `verify-end-state` a failed post
  // is a NOTICE, never a throw: throwing here would skip the end-state
  // verification below and leave a possibly-stranded stub reported as success
  // (#1769 round 17 — the clear-failure CLI is the caller the note-below-comment
  // anticipated). On `abort` it still propagates, so the sweep retries next run.
  if (note) {
    try {
      await writeGh([
        "issue",
        "comment",
        String(issueNumber),
        "-R",
        repo,
        "--body",
        note,
      ]);
    } catch (err) {
      if (!verifyEndState) throw err;
      process.stderr.write(
        `::notice::Re-queue bookkeeping note on #${issueNumber} reported a failure (${
          err instanceof Error ? err.message : String(err)
        }); it is advisory, so the end-state verification below still runs.\n`,
      );
    }
  }

  // INVARIANT 3, second half — the STATE CHANGE GOES LAST. The closed->open
  // transition is what flips the next ingest run onto the open-match skip path,
  // so an early reopen followed by a failure would leave the issue open without
  // `sentry:needs-triage` — reopened but invisible to triage.
  let verified = null;
  if (verifyEndState) {
    verified = await ensureSelectableForTriage(
      { writeGh, readStub },
      { repo, issueNumber, fallbackState },
    );
  } else {
    await writeGh(["issue", "reopen", String(issueNumber), "-R", repo]);
  }

  if (verifyEndState) {
    // THE SENTINEL, read back — after the LAST write, and after EVERY read that
    // follows one. An earlier-only check leaves the window between it and the
    // reopen uncovered; a first-read-only check leaves the shed retry below
    // uncovered, where a second read is taken and a settlement first visible
    // there would be judged as a successful re-queue. So this runs against
    // whatever `verified` currently holds, at each point that value can change.
    //
    // Both orderings are covered between the two runs: a settlement whose marker
    // is on the stub at any of these reads is caught here, and one whose marker
    // lands after the last of them has its own post-settlement verification
    // looking at a stub this run has already reopened and stripped of its
    // verdict, which fails it and rolls it back.
    //
    // The stub is momentarily selectable, between the reopen above and the
    // unwind. Nothing can act on it there: the triage workflow holds one
    // repo-wide concurrency group and this compensation runs inside its run, and
    // ingest's dedup skips an open stub.
    const settledUnderneath = () =>
      sentinel && verified.labels.includes(sentinel.label);
    const unwind = async () => {
      process.stderr.write(`::warning::${sentinel.declineNote(verified)}\n`);
      return unwindAfterSettlement(
        { writeGh, readStub },
        { repo, issueNumber, sentinel, premise },
      );
    };
    if (settledUnderneath()) return await unwind();

    // RE-ATTEMPT THE SHED against observed state, once, before judging.
    //
    // The add and the shed share one try, so an add that REPORTS failure jumps
    // past the shed: it is never attempted, not merely failed. The verification
    // above then restores selectability by re-adding the label — right for the
    // queue, and the wrong place to stop, because it turns the failure into the
    // worst of the available end states. Stranded-and-loud is inert: nothing
    // selects the stub, so nothing acts on its stale markers. Selectable-and-loud
    // is RUNNABLE: the next round picks up a stub still wearing
    // `sentry:approved-archive` — a human approval this re-queue was supposed to
    // consume, which a later archive dispatch would spend again — plus autofix
    // markers that suppress the next fix attempt and verdict labels that
    // misclassify it downstream.
    //
    // So shed from what was actually OBSERVED, then re-observe and judge that.
    // Bounded at one extra attempt, like every other retry here, and the check
    // below still THROWS on anything that survives — the transient case
    // self-heals, the persistent one stays loud.
    const staleAfterVerify = shedLabels.filter((name) =>
      verified.labels.includes(name),
    );
    if (staleAfterVerify.length) {
      try {
        process.stderr.write(
          `::notice::Stale markers still on #${issueNumber} after selectability was restored (${staleAfterVerify.join(", ")}); re-attempting the shed.\n`,
        );
        await writeGh(
          buildRequeueShedLabelArgs(issueNumber, repo, {
            except: sentinel ? [sentinel.label] : [],
          }),
        );
        // Re-read rather than assume: this write can lose its response too. Merge
        // so a reader that serves no comments cannot erase the ones the fence
        // check below judges.
        verified = { ...verified, ...(await readStub(issueNumber)) };
      } catch (err) {
        // Keep going to the check below — it is the thing that decides, and it
        // must run even when this retry fails.
        const retryError = err instanceof Error ? err.message : String(err);
        labelError = labelError
          ? `${labelError}; shed retry: ${retryError}`
          : `shed retry: ${retryError}`;
        process.stderr.write(
          `::notice::Shed retry on #${issueNumber} reported a failure (${retryError}); the end-state verification below still decides.\n`,
        );
      }
      // The retry's read is a second observation, so it gets the same sentinel
      // decision as the first. A settlement first visible HERE is the case a
      // failed initial shed produces: the verdict it left behind is what lets
      // the archive's verification hold, so the archive really did settle, and
      // the retry has just removed that verdict.
      if (settledUnderneath()) return await unwind();
    }

    // Judge the fence and the shed from the SAME verification read, for the same
    // reason: a write can land and lose its response, so its return proves
    // nothing in either direction. The stub is selectable by now — the invariant
    // this path owes — so this is loud AFTER it is safe, never instead of making
    // it safe.
    //
    // The fence question is the consumer's again (invariant 5), not "is a fence
    // present". A fence deleted between the post and this read, and one that was
    // always older than the newest verdict, both leave a verdict the `verdict`
    // job would pick up and close the stub with. Presence would miss the second
    // case entirely.
    const problems = [];
    if (fences && hasAdmissibleVerdict(verified.comments)) {
      problems.push(
        "a previous verdict is still admissible — no regression fence newer than it survives on the stub — so a failing triage round could close that verdict over this live regression; post the fence by hand, or re-run this workflow, before the next triage run",
      );
    }
    const survivingMarkers = shedLabels.filter((name) =>
      verified.labels.includes(name),
    );
    if (survivingMarkers.length) {
      problems.push(
        `these stale markers survived: ${survivingMarkers.join(", ")}${
          labelError ? ` (label edit reported: ${labelError})` : ""
        }`,
      );
    }
    // One throw carrying both, so a doubly-broken run cannot report only half.
    if (problems.length) {
      throw new Error(
        `Queue stub #${issueNumber} was made selectable for triage, but ${problems.join("; and ")}.`,
      );
    }
    if (labelError) {
      process.stderr.write(
        `::notice::The re-queue label edit on #${issueNumber} reported a failure (${labelError}) that the verification read disproves; the stale markers are gone.\n`,
      );
    }
  }

  return { requeued: true, reason: null, verified, labelError };
}
