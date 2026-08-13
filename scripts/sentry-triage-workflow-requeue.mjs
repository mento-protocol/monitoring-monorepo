// ---------------------------------------------------------------------------
// CLI: THE ONE WAY .github/workflows/sentry-triage-agent.yml COMPENSATES.
//
// Every step in that workflow between the verdict label swap and the ledger
// close runs on a stub whose `sentry:needs-triage` has already been removed. So
// every FAILING exit in that window owes the same thing: put the stub back in
// the queue. Nothing downstream would do it promptly — the scheduled selector
// admits only open + `sentry:needs-triage`, the project job skips a stub that is
// not needs-triage, and ingest's regression gate only reopens CLOSED stubs — so
// a bare exit strands an open, verdict-labeled stub.
//
// Ingest's stranded sweep is the BACKSTOP for that shape, not a substitute for
// this CLI (issue #1817): it repairs the stub only after a full day of idleness,
// because the same shape is what a live triage round looks like between its
// verdict label and its close. Compensating here is what keeps the stub out of
// that window in the first place, in seconds rather than a day.
//
// Those exits used to open-code the label swap, one copy each (#1769 round 16
// converted the first of them, and #1782 the rest). Open-coding is how the
// copies drift: each one independently picked a removal list, and none of them
// could see live state, so none could tell a stub that had gone terminal
// underneath it from one still waiting to be re-queued. This entry point is the
// I/O + argv shell over the single re-queue chokepoint
// (scripts/sentry-triage-requeue.mjs); the workflow declares only WHICH exit it
// is, and the sequence, the cause, the shed set and the terminal guard are
// decided here for all of them at once.
//
// The policy, identical for every exit:
//   - BOOKKEEPING cause: nothing in Sentry moved, so the chokepoint posts no
//     verdict-staleness fence and a verdict already computed stays admissible.
//   - a TERMINAL revalidation (see `isTerminalStub`) — the round-18 P2 below.
//   - `verify-end-state` + `fallbackState: "OPEN"`: these stubs are OPEN when the
//     compensation fires, and the end-state check reopens only a CLOSED stub, so
//     an open one is confirmed selectable, never spuriously reopened, and the
//     whole sequence is idempotent (safe to replay on retry).
//
// Split out of scripts/sentry-triage-requeue.mjs (#1769 round 17): the
// chokepoint is pure, dependency-injected logic and this file is its shell. Both
// stay smaller, and the import closure remains third-party-free (node: builtins
// plus relative files), so the workflow can run it after setup-node with no
// install.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ARCHIVED_LABEL } from "./sentry-triage-queue-contract.mjs";
import {
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_ON_FAILURE_VERIFY_END_STATE,
  requeueQueueStub,
} from "./sentry-triage-requeue.mjs";

// ---------------------------------------------------------------------------
// The reasons. One per compensating exit in the workflow.
// ---------------------------------------------------------------------------

/** The brief step: a stub re-triaged AWAY from needs-human whose stale
 * needs-human brief could not be CLEARED (#1769 rounds 10 + 16). */
export const REQUEUE_REASON_BRIEF_CLEAR = "brief-clear-failure";
/** The verdict step: the applied verdict could not be confirmed to be the only
 * one on the stub — the re-read failed, or more than one survived (#1745). */
export const REQUEUE_REASON_VERDICT_UNSETTLED = "verdict-unsettled";
/** Either close step: the ledger close itself failed. */
export const REQUEUE_REASON_CLOSE_FAILURE = "close-failure";
/** The serialized project job: a row's projection failed. */
export const REQUEUE_REASON_PROJECTION_FAILURE = "projection-failure";
/** The serialized project job: the projection credential is not exposed on this
 * ref, so an actionable external verdict cannot be projected at all (#1289). */
export const REQUEUE_REASON_PROJECTION_UNAVAILABLE = "projection-unavailable";

/**
 * The cause clause each reason contributes to the bookkeeping note. Fixed text —
 * no Sentry-derived or otherwise untrusted input reaches this file at all, which
 * is why the workflow passes a REASON rather than a message.
 */
const REQUEUE_REASON_CAUSES = {
  [REQUEUE_REASON_BRIEF_CLEAR]:
    "it was re-triaged off `sentry:needs-triage` toward a settled verdict, but " +
    "the stale needs-human brief could not be cleared, so that terminal " +
    "transition could not complete",
  [REQUEUE_REASON_VERDICT_UNSETTLED]:
    "a verdict label was applied, but the stub could not be confirmed to carry " +
    "exactly one, so nothing downstream can bucket it correctly",
  [REQUEUE_REASON_CLOSE_FAILURE]:
    "its verdict was applied, but closing the ledger entry failed, so the round " +
    "could not settle it",
  [REQUEUE_REASON_PROJECTION_FAILURE]:
    "its actionable external verdict could not be projected to the owning repo, " +
    "so the round could not settle it",
  [REQUEUE_REASON_PROJECTION_UNAVAILABLE]:
    "its actionable external verdict could not be projected because the " +
    "projection credential is not exposed on this ref, so the round could not " +
    "settle it",
};

export const REQUEUE_REASONS = Object.keys(REQUEUE_REASON_CAUSES);

/**
 * THE COMPENSATION NOTE. Bookkeeping cause (no fence — no Sentry occurrence
 * moved), so a verdict already on the stub stays valid and admissible.
 *
 * Intent-worded, like every other note this chokepoint posts: the label writes it
 * explains may still fail after it is posted, and a stub that keeps failing to
 * re-queue SHOULD accumulate one note per attempt, because that repetition is
 * the honest signal.
 *
 * An unknown reason THROWS, before any I/O — a caller that cannot name which
 * exit it is has not decided anything, and the shed set it would inherit is not
 * something to guess at.
 */
export function buildRequeueNote(reason) {
  const cause = REQUEUE_REASON_CAUSES[reason];
  if (!cause) {
    throw new Error(
      `Unknown re-queue reason ${JSON.stringify(reason)}; a workflow compensation must name one of ${REQUEUE_REASONS.join(", ")}.`,
    );
  }
  return (
    `Sentry triage is re-queuing this queue stub: ${cause}. It is restoring ` +
    "`sentry:needs-triage` and shedding the stale verdict, projection and " +
    "autofix markers, so the next scheduled run re-triages it and reconciles " +
    "whatever the failed step left behind. If any of those writes does not " +
    "land, the run goes red naming what survived. This note can appear more " +
    "than once if the re-queue keeps failing."
  );
}

function defaultRunGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/** The stub's terminal signals, for the revalidation below and the chokepoint's
 * end-state verification. */
async function readStubState(runGh, repo, issueNumber) {
  const stdout = await runGh([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    repo,
    "--json",
    "state,labels",
  ]);
  const data = JSON.parse(stdout);
  const labels = (Array.isArray(data.labels) ? data.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
  return { state: String(data.state ?? "").toUpperCase(), labels };
}

/**
 * TERMINAL means: settled, and not this workflow's to reopen. CLOSED is the
 * ledger's terminal state; `sentry:archived` is the durable terminal marker the
 * Phase 2a archive leg applies once it has archived the underlying SENTRY issue.
 *
 * Mirrors the brief leg's write-side terminal guard (`readStubTerminalState` in
 * scripts/sentry-triage-brief.mjs) and reads the same two signals, because it
 * defends against the same thing.
 */
export function isTerminalStub({ state, labels } = {}) {
  return (
    String(state ?? "").toUpperCase() === "CLOSED" ||
    (Array.isArray(labels) ? labels : []).includes(ARCHIVED_LABEL)
  );
}

/**
 * Re-queue a stub after a compensating exit in the triage workflow, through the
 * chokepoint. Returns `requeueQueueStub`'s result — `{ requeued: false, reason:
 * "revalidated-away" }` when the terminal guard declined.
 *
 * THE TERMINAL GUARD (#1782, deferred from #1769 round 18). The premise of every
 * caller is a SNAPSHOT: the step observed a failure, then decided to compensate.
 * `sentry-triage-archive.yml` holds its own concurrency group, so between those
 * two moments the archive leg can complete — and then this re-queue would re-add
 * `sentry:needs-triage`, shed `sentry:archived` and the verdict labels, and
 * reopen a stub whose Sentry issue is already archived on a human approval it
 * just consumed. It cannot un-archive Sentry, so what it produces is an open
 * retry stub over an archived occurrence. The same shape covers a close whose
 * mutation LANDED and only lost its response: the stub is CLOSED and correctly
 * settled, and re-queuing it would manufacture the closed-plus-needs-triage
 * pairing no pipeline stage can see.
 *
 * So revalidate live state and DECLINE when the stub went terminal. This is the
 * chokepoint's invariant 7 with this path's premise plugged in, so a failed read
 * PROPAGATES: the run goes red and the workflow names the manual repair, rather
 * than mutating a stub it could not observe.
 *
 * It narrows the window rather than closing it — an archive that lands after the
 * revalidating read still races the writes below, exactly as it races the brief
 * leg's write-side guard. Serializing the two workflows is the only thing that
 * would close it, and that is a bigger change than this class needs.
 */
export function runWorkflowRequeue({
  runGh = defaultRunGh,
  repo,
  issueNumber,
  reason,
}) {
  const note = buildRequeueNote(reason);
  return requeueQueueStub(
    {
      writeGh: (args) => runGh(args),
      readStub: (number) => readStubState(runGh, repo, number),
    },
    {
      repo,
      issueNumber,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note,
      revalidate: {
        check: (live) => !isTerminalStub(live),
        declineNote: (live) =>
          `Queue stub #${issueNumber} went terminal before the ${reason} re-queue could run (state=${live.state}, labels=${live.labels.join(",") || "none"}); leaving it settled rather than reopening it over an archived or already-closed occurrence.`,
      },
      onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      fallbackState: "OPEN",
    },
  );
}

export function parseRequeueArgs(argv) {
  const args = { repo: null, issueNumber: null, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--issue") {
      args.issueNumber = argv[++i];
    } else if (arg === "--repo") {
      args.repo = argv[++i];
    } else if (arg === "--reason") {
      args.reason = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!/^\d+$/.test(String(args.issueNumber ?? ""))) {
    throw new Error("--issue <number> is required.");
  }
  if (!args.repo) {
    throw new Error("--repo <owner/name> is required.");
  }
  if (!REQUEUE_REASONS.includes(String(args.reason ?? ""))) {
    throw new Error(
      `--reason <${REQUEUE_REASONS.join("|")}> is required; a compensation must name the exit it is compensating for.`,
    );
  }
  args.issueNumber = Number(args.issueNumber);
  return args;
}

async function main() {
  const args = parseRequeueArgs(process.argv.slice(2));
  await runWorkflowRequeue({
    repo: args.repo,
    issueNumber: args.issueNumber,
    reason: args.reason,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
