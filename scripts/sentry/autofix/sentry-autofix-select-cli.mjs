/**
 * The CLI SURFACE of the Sentry AUTOFIX selector
 * (scripts/sentry/autofix/sentry-autofix-select.mjs): the option contract the workflow invokes
 * it with, the help text that documents it, the report files it writes for the
 * tracker to read back, and the `--emit-verdict` subcommand. Extracted so the
 * selector keeps the window, the family orchestration and the decisions.
 *
 * One concern: everything here is about the BOUNDARY between the selection run
 * and the workflow around it. Nothing here decides whether a stub is selectable,
 * and nothing here issues a `gh` read except the one `--emit-verdict` snapshot.
 *
 * A LEAF by construction — it imports nothing from the selector, so the
 * selector can import and re-export it without an ESM cycle. `main` stays in the
 * selector for the same reason: it is the one function that needs both halves,
 * and the workflow invokes `scripts/sentry/autofix/sentry-autofix-select.mjs` directly (three
 * call sites in .github/workflows/sentry-autofix.yml), so that file must remain
 * the executable entry point.
 */

import { writeFileSync } from "node:fs";

import {
  DEFAULT_REPO,
  selectVerdictComment,
} from "../triage/sentry-triage-project-core.mjs";
import { defaultRunGh, readStub } from "./sentry-autofix-queue-io.mjs";

/** Max CANDIDATES one run may select. Lives here because the CLI's `--cap`
 * parse and its help text are its two closest readers; the selector imports it
 * for the default and re-exports it as part of the selection contract. */
export const DEFAULT_CAP = 2;

export function usage() {
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
                       "secondLookEvaluated": <n>, "secondLookFull": <bool>,
                       "secondLookFailed": <bool>, "ghCalls": <n> } — to this
                       path, so the run record can surface a list window that
                       exceeded the eval cap, a bounded second look (that it ran,
                       whether MORE rows still sat past even it, and whether its
                       own read failed), and the run's measured \`gh\` invocation
                       count. Stdout is unchanged.
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
 * it always emits a valid array. Returns whether the file was written — one
 * caller (the degraded signal) has to know. Exported because `main` is the only
 * bridge between the selector's return value and the `jq` reads the workflow
 * builds the tracker record from, and a key-name or serialization bug here is
 * invisible to every test that exercises `selectAutofixRun` alone. */
export function writeReport(path, report, label) {
  if (!path) return true;
  try {
    writeFileSync(path, `${JSON.stringify(report ?? [])}\n`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warn: could not write the ${label} report: ${message}\n`,
    );
    return false;
  }
}

/**
 * Write every report file the workflow reads, and answer the one question the
 * caller must act on: was a DEGRADED run's signal lost?
 *
 * `rateLimited` reaches the workflow through exactly one channel — the
 * truncations file — and the workflow flips `disposition` to
 * `degraded-rate-limited` off it. Every OTHER field on these files is a
 * nice-to-have that degrades to "0" or a missing line. This one is the safety
 * signal: lose it and `rate_limited` reads 0, the disposition stays `active`,
 * the tracker renders a suppressed run as a healthy idle one — the #1758
 * misdiagnosis — and the record job's label backfill gate opens on reads the run
 * itself declared unreliable. So a best-effort write is the wrong contract for
 * that one case, and the caller fails the step instead. Exported for the same
 * reason `writeReport` is.
 */
export function writeRunReports(options, run) {
  // Report BEFORE stdout: the workflow captures stdout into a shell variable, so
  // a failed report write must not be able to lose the entries too. All are
  // best-effort — the run record degrades to "0" / no Window line / no
  // truncation line, never to a dead leg.
  writeReport(options.deferredOut, run.deferred, "deferral");
  writeReport(options.skippedOut, run.skipped, "fix_scope skip");
  writeReport(options.windowOut, run.window ?? {}, "window");
  const truncations = run.truncations ?? {};
  const wroteTruncations = writeReport(
    options.truncationsOut,
    truncations,
    "truncations",
  );
  return {
    lostDegradedSignal:
      Number(truncations.rateLimited ?? 0) > 0 && !wroteTruncations,
  };
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
