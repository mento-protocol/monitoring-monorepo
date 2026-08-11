// ---------------------------------------------------------------------------
// CLI: restore queue selectability after a needs-human brief CLEAR failure
// (#1769 rounds 16-17).
//
// The verdict step removes sentry:needs-triage and applies the verdict label;
// the brief step then CLEARS the stale needs-human brief and, on failure, blocks
// the close so a settled stub never shows an obsolete decision (#1769 round 10).
// That block used to bare-exit, stranding the open, verdict-labeled stub with no
// automated retry path. This entry restores selectability through the ONE
// re-queue chokepoint (bookkeeping cause: nothing in Sentry moved), never an
// open-coded label swap. `verify-end-state` + `fallbackState: "OPEN"` is what
// makes it correct on an already-open stub: the end-state check reopens only a
// CLOSED stub, so an open one is confirmed selectable, never spuriously
// reopened, and the whole sequence is idempotent (safe to replay on retry).
//
// Split out of scripts/sentry-triage-requeue.mjs (#1769 round 17): the chokepoint
// is pure, dependency-injected logic, and this file is its I/O + argv shell. Both
// stay smaller, and the import closure remains third-party-free (node: builtins
// plus the relative chokepoint), so the workflow can run it after setup-node with
// no install.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_ON_FAILURE_VERIFY_END_STATE,
  requeueQueueStub,
} from "./sentry-triage-requeue.mjs";

/**
 * THE BRIEF-CLEAR RECOVERY NOTE. Bookkeeping cause (no fence — no Sentry
 * occurrence moved). Posted when a stub re-triaged AWAY from needs-human could
 * not have its stale needs-human brief cleared: the verdict step already removed
 * `sentry:needs-triage` and applied the new verdict label, and the brief step
 * blocks the close on that clear failure (#1769 round 10) — which, on its own,
 * would strand an open, verdict-labeled stub that the scheduled selector (open +
 * `sentry:needs-triage` only) and ingest's regression gate (closed stubs only)
 * both miss (#1769 round 16). Intent-worded because the label writes it explains
 * may still fail after it is posted.
 */
export function buildBriefClearRecoveryComment() {
  return (
    "Sentry triage is re-queuing this queue stub: it was re-triaged off " +
    "`sentry:needs-triage` toward a settled verdict, but the stale needs-human " +
    "brief could not be cleared, so that terminal transition could not " +
    "complete. Its stale verdict, projection and autofix markers have been shed " +
    "and `sentry:needs-triage` restored, so the next scheduled run re-triages " +
    "it and reconciles the brief. This note can appear more than once if the " +
    "re-queue keeps failing."
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

/** The stub's terminal signals, for the chokepoint's end-state verification. */
async function readClearFailureStub(runGh, repo, issueNumber) {
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
 * Re-queue an OPEN stub whose needs-human brief clear failed, through the
 * chokepoint. Bookkeeping cause, verify-end-state, OPEN fallback. Returns
 * `requeueQueueStub`'s result.
 */
export function runClearFailureRequeue({
  runGh = defaultRunGh,
  repo,
  issueNumber,
}) {
  return requeueQueueStub(
    {
      writeGh: (args) => runGh(args),
      readStub: (number) => readClearFailureStub(runGh, repo, number),
    },
    {
      repo,
      issueNumber,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildBriefClearRecoveryComment(),
      onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      fallbackState: "OPEN",
    },
  );
}

export function parseRequeueArgs(argv) {
  const args = { repo: null, issueNumber: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--issue") {
      args.issueNumber = argv[++i];
    } else if (arg === "--repo") {
      args.repo = argv[++i];
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
  args.issueNumber = Number(args.issueNumber);
  return args;
}

async function main() {
  const args = parseRequeueArgs(process.argv.slice(2));
  await runClearFailureRequeue({
    repo: args.repo,
    issueNumber: args.issueNumber,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
