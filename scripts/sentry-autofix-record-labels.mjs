#!/usr/bin/env node
/**
 * Record-run backfill labeler for the Sentry AUTOFIX leg (issue #1812). The
 * autofix select step skips every LOCAL code-fix stub whose `fix_scope` parses
 * as `architectural` — the fail-closed value EVERY verdict predating the field
 * normalizes to (issue #1785). Fresh architectural verdicts are labeled
 * `sentry:fix-scope-architectural` at settlement and excluded from the candidate
 * window at query time, but LEGACY stubs (verdicted before the label existed)
 * carry no such label, so they re-enter the window and are skipped-and-reported
 * every run — the one monotonic growth driver #1813 measured. This step backfills
 * the label onto exactly those skipped stubs so the NEXT run excludes them at the
 * source, draining the legacy backlog at up to MAX_BACKFILL_LABELS per run.
 *
 * Extracted from the record-run job's bash into a testable module: the plan is a
 * pure function over the selector's skip report, and every write goes through an
 * injectable `runGh`. It runs in the record-run job, which is main-only and holds
 * `issues:write` — the SAME job that owns the run-record write, and the ONLY
 * autofix job with a write scope besides finalize. The select job stays
 * `issues:read`, so #1813's stated security blocker never materializes.
 *
 * The skip report is a snapshot from the select run, so before labeling each stub
 * the backfill RE-READS its live verdict through the selector's own resolver and
 * only labels a stub the live scope still gates out — an operator who re-triaged
 * #N to mechanical in the interval must not get the now-selectable stub excluded
 * from the window off a stale snapshot. A gone/unreadable verdict fails CLOSED
 * (no label), so the stub stays selectable and self-heals on the next run.
 *
 * Legacy stubs stay CLOSED (operator resolution #1): a local code-fix stub is
 * closed at settlement, and this only adds a window-exclusion label — it never
 * reopens. A regression reopens any that still fire via the normal ingest path
 * (REOPEN_SHED_LABELS sheds the hold on reopen). Idempotent: `gh issue edit
 * --add-label` on a stub that already carries the label is a no-op, so a re-run
 * costs one redundant edit and never errors. Best-effort by construction — the
 * record-run job is `continue-on-error`, so a persistent backfill failure
 * degrades to per-run re-evaluation, visible as a permanently nonzero skipped
 * count, never a silent strand.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  LABEL_DEFINITIONS,
} from "./sentry-triage-ingest.mjs";
// The revalidation + compensation layer, extracted so this module stays under
// the 600-line soft cap: it owns the live-scope re-read that brackets the label
// write and the withdrawal (remove + terminal-guarded re-queue) that runs when
// the post-write check does not re-confirm the hold.
import {
  liveArchitecturalScope,
  withdrawStaleHold,
} from "./sentry-autofix-hold-revalidate.mjs";

// The selector's fix_scope skip reason (scripts/sentry-autofix-select.mjs
// SKIP_FIX_SCOPE_ARCHITECTURAL). Kept as its own literal here so a rename there
// is a visible two-file change rather than a silent divergence; the plan filters
// on it so a future second skip reason cannot accidentally get the architectural
// label.
export const SKIP_FIX_SCOPE_ARCHITECTURAL = "fix-scope-architectural";

// One run may backfill at most this many labels. The skip report can now hold up
// to MAX_CANDIDATE_EVALUATIONS (200) entries plus MAX_SECOND_LOOK_EVALUATIONS
// (100) from a second look, so this is a REAL throttle on the write volume, not
// the belt-and-braces bound it was when the window was 50 — deliberately left at
// 50 because each backfilled stub costs three-to-four `gh` calls (below) and the
// record job runs on a 5-minute timeout. Overflow ids are simply labeled on a
// later run (they re-enter the skip report until labeled), and a full window of
// architectural stubs drains at 50/run. Oldest-first order is preserved from the
// report, so the queue's oldest stragglers are always the ones that drain first.
// Each backfilled stub now costs read + write + read (the pre- and post-write
// halves of the TOCTOU guard below), plus one more write when the post-check
// forces a compensating removal — so this bound governs three-to-four gh calls
// per stub, not one.
export const MAX_BACKFILL_LABELS = 50;

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";

/**
 * The ordered, validated set of issue numbers a skip report backfills. Only
 * entries whose `reason` is the architectural skip AND whose `issue` is a bare
 * `^[0-9]+$` integer are kept (a malformed number is REFUSED, never interpolated
 * into a gh argv — defense in depth even though these are our own outputs);
 * duplicates collapse; the original order (oldest-first from the selector) is
 * preserved; the list is capped at MAX_BACKFILL_LABELS. Pure — both the CLI and
 * the tests call it.
 *
 * Returns `{ numbers, refused, overflow }`: `numbers` the strings to label,
 * `refused` the malformed `issue` values dropped, `overflow` how many valid ids
 * exceeded the cap (labeled on a later run).
 */
export function planArchitecturalBackfill(skipped, options = {}) {
  const cap =
    Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : MAX_BACKFILL_LABELS;
  const seen = new Set();
  const numbers = [];
  const refused = [];
  for (const entry of Array.isArray(skipped) ? skipped : []) {
    if (entry?.reason !== SKIP_FIX_SCOPE_ARCHITECTURAL) continue;
    const raw = String(entry.issue ?? "");
    if (!/^[0-9]+$/.test(raw)) {
      refused.push(raw);
      continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    numbers.push(raw);
  }
  return {
    numbers: numbers.slice(0, cap),
    refused,
    overflow: Math.max(0, numbers.length - cap),
  };
}

export function defaultRunGh(args) {
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

/**
 * Backfill `sentry:fix-scope-architectural` onto every architectural stub in a
 * skip report. Self-heal-creates the label FIRST (from LABEL_DEFINITIONS, the
 * single source of truth for its color/description) so a record run that lands
 * before any post-deploy ingest bootstrapped the label still labels cleanly, then
 * REVALIDATES each stub's live scope (`liveArchitecturalScope`) and issues ONE
 * `gh issue edit --add-label` per number the live verdict still gates out on
 * scope. A stub re-triaged to mechanical since the skip report, or whose verdict
 * is now gone/unreadable, is left UNLABELED (and so stays selectable) — the label
 * is a snapshot-driven write and must not outlive the snapshot's truth.
 *
 * The label write is bracketed by the SAME live check on both sides — the #1389
 * stale-verdict guard's shape. The post-write half compensates for the TOCTOU the
 * pre-write half alone cannot close: triage runs on its own concurrency group, so
 * a re-triage landing between the read and the edit would have settlement remove
 * the hold and this write re-add it, stranding an external code-fix (projection
 * reads the re-added hold as skipped-state and files nothing, and the stub keeps
 * no retry label). When the post-write check does not re-confirm architectural —
 * including a read/parse failure, same fail-closed stance as the pre-write half —
 * the label just added is REMOVED again.
 *
 * Every gh call is fail-SOFT and independent: a failed label-create is logged and
 * the per-issue edits still run (they self-heal on a later run if the label truly
 * does not exist); a failed re-read or edit skips that one issue (it re-enters the
 * skip report next run). Never throws — the record-run job is best-effort. Returns
 * `{ labeled, failed, revalidated, withdrawn, withdrawFailed, requeued,
 * requeueFailed, refused, overflow }`: `revalidated` holds the numbers dropped
 * before the write because the live verdict no longer confirmed architectural,
 * `withdrawn` the numbers whose label was added and then removed by the
 * post-write guard, `withdrawFailed` the numbers whose compensating removal
 * itself failed (loud — a stuck hold is the strand this guard exists to
 * prevent), `requeued` the withdrawn numbers put back through triage,
 * `requeueDeclined` the withdrawn numbers whose stub had already gone TERMINAL
 * (closed, or `sentry:archived`) so no compensation was owed, and
 * `requeueFailed` the withdrawn numbers whose re-queue did not land (also loud:
 * projection may already have skipped them on the stale hold).
 */
export async function backfillArchitecturalLabels(
  skipped,
  options = {},
  deps = {},
) {
  const runGh = deps.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_REPO;
  const plan = planArchitecturalBackfill(skipped, options);

  for (const raw of plan.refused) {
    process.stderr.write(
      `warn: skip report carried a non-integer issue '${raw}'; refusing to label it.\n`,
    );
  }
  if (plan.overflow > 0) {
    process.stderr.write(
      `note: ${plan.overflow} architectural stub(s) exceed the per-run MAX_BACKFILL_LABELS budget (${MAX_BACKFILL_LABELS}); they will be labeled on a later run.\n`,
    );
  }

  // Self-heal create FIRST — before any --add-label edit — so the edits never
  // fail on a repo-nonexistent label. Best-effort: if the create itself fails,
  // the edits still try (and self-heal on a later run).
  const def = LABEL_DEFINITIONS.find(
    (d) => d.name === FIX_SCOPE_ARCHITECTURAL_LABEL,
  );
  if (def) {
    try {
      await runGh([
        "label",
        "create",
        def.name,
        "--repo",
        repo,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warn: could not ensure label ${FIX_SCOPE_ARCHITECTURAL_LABEL}: ${message}\n`,
      );
    }
  }

  const labeled = [];
  const failed = [];
  const revalidated = [];
  const withdrawn = [];
  const withdrawFailed = [];
  const requeued = [];
  const requeueDeclined = [];
  const requeueFailed = [];
  for (const number of plan.numbers) {
    // PRE-write check: revalidate against LIVE state before writing the
    // snapshot-driven label.
    const live = await liveArchitecturalScope(runGh, repo, number);
    if (live.state !== "architectural") {
      if (live.state === "selectable") {
        process.stderr.write(
          `note: #${number} was reported architectural but its live verdict no longer resolves to a local architectural code-fix (re-triaged scope, verdict, or owning repo); leaving it unlabeled.\n`,
        );
      } else {
        process.stderr.write(
          `note: could not confirm a live architectural fix_scope for #${number} (${live.message}); failing closed, leaving it unlabeled and selectable.\n`,
        );
      }
      revalidated.push(number);
      continue;
    }
    try {
      await runGh([
        "issue",
        "edit",
        number,
        "--repo",
        repo,
        "--add-label",
        FIX_SCOPE_ARCHITECTURAL_LABEL,
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warn: could not backfill ${FIX_SCOPE_ARCHITECTURAL_LABEL} onto #${number}: ${message}\n`,
      );
      failed.push(number);
      continue;
    }

    // POST-write compensating verification — the #1389 stale-verdict guard's
    // shape, applied to this write. GitHub labels have no atomic
    // compare-and-set, and triage runs on its own concurrency group, so an
    // operator re-triage between the pre-write read and the edit above can have
    // triage settlement REMOVE the hold and this stale write ADD IT BACK. For an
    // external code-fix that is a permanent strand: the triage close step leaves
    // the stub open for projection, but runProjectionBatch sees the re-added hold
    // and returns skipped-state, so the owning-repo issue is never created and
    // the stub carries neither sentry:needs-triage nor any other retry path. So
    // re-read the same authoritative state AFTER the write and compensate.
    //
    // `unconfirmed` (read/parse failure on the post-check) removes the label too:
    // that matches the PRE-write fail-closed stance — unconfirmed means do NOT
    // hold — and it self-heals, because the selector re-parses fix_scope next
    // run, reports the skip, and this backfill re-adds the label. Leaving an
    // unverifiable hold in place risks the permanent strand above; removing it
    // costs at most one wasted evaluate-and-relabel cycle.
    const after = await liveArchitecturalScope(runGh, repo, number);
    if (after.state === "architectural") {
      labeled.push(number);
      continue;
    }
    process.stderr.write(
      after.state === "selectable"
        ? `note: #${number} stopped resolving to a local architectural code-fix between the pre-write check and the label write (concurrent re-triage); removing the ${FIX_SCOPE_ARCHITECTURAL_LABEL} label we just added.\n`
        : `note: could not re-confirm a live architectural fix_scope for #${number} after the write (${after.message}); failing closed and removing the ${FIX_SCOPE_ARCHITECTURAL_LABEL} label we just added.\n`,
    );
    const outcome = await withdrawStaleHold(runGh, repo, number);
    if (!outcome.withdrawn) {
      withdrawFailed.push(number);
      continue;
    }
    withdrawn.push(number);
    if (outcome.requeue === "requeued") requeued.push(number);
    else if (outcome.requeue === "declined") requeueDeclined.push(number);
    else if (outcome.requeue === "failed") requeueFailed.push(number);
  }
  return {
    labeled,
    failed,
    revalidated,
    withdrawn,
    withdrawFailed,
    requeued,
    requeueDeclined,
    requeueFailed,
    refused: plan.refused,
    overflow: plan.overflow,
  };
}

// ---------------------------------------------------------------------------
// CLI. The record-run job feeds the selector's skipped issue numbers (a
// space-separated integer list from the `skipped_issues` output) and the repo;
// every reported skip is a fix_scope architectural skip (the selector's only skip
// reason), so the numbers alone reconstruct the skip report the plan consumes.
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:autofix:record-labels --repo <owner/name> --issues "<n n n>"

Backfill sentry:fix-scope-architectural onto the legacy local code-fix stubs the
autofix select step skipped as fix_scope: architectural this run, so the next run
excludes them from the candidate window at query time. Self-heal-creates the
label first, then adds it (idempotently) to each validated issue number.

Options:
  --repo <owner/name>  Repo the queue stubs live in (default: ${DEFAULT_REPO}).
  --issues "<n n n>"   Space-separated skipped issue numbers (the select job's
                       skipped_issues output). Empty is a no-op.
  --skipped-file <p>   Alternatively, read the selector's JSON skip report
                       ([{"issue","reason"}]) from this file. --issues wins.
  -h, --help           Show this help.
`;
}

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    issues: null,
    skippedFile: null,
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
      case "--issues":
        options.issues = readValue();
        break;
      case "--skipped-file":
        options.skippedFile = readValue();
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

/** Reconstruct the skip report from a space-separated integer list: every
 * reported skip is architectural, so the numbers alone rebuild it. */
export function skipReportFromIssueList(issues) {
  return String(issues ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((issue) => ({ issue, reason: SKIP_FIX_SCOPE_ARCHITECTURAL }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let skipped;
  if (options.issues != null) {
    skipped = skipReportFromIssueList(options.issues);
  } else if (options.skippedFile) {
    try {
      const parsed = JSON.parse(readFileSync(options.skippedFile, "utf8"));
      skipped = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warn: could not read the skip report ${options.skippedFile}: ${message}; nothing to backfill.\n`,
      );
      skipped = [];
    }
  } else {
    skipped = [];
  }
  const result = await backfillArchitecturalLabels(skipped, {
    repo: options.repo,
  });
  process.stderr.write(
    `Backfilled ${FIX_SCOPE_ARCHITECTURAL_LABEL} onto ${result.labeled.length} stub(s)` +
      `${result.failed.length ? `, ${result.failed.length} failed` : ""}` +
      `${result.revalidated.length ? `, ${result.revalidated.length} left unlabeled (live scope no longer architectural)` : ""}` +
      `${result.withdrawn.length ? `, ${result.withdrawn.length} withdrawn after the post-write check` : ""}` +
      `${result.withdrawFailed.length ? `, ${result.withdrawFailed.length} STUCK (withdrawal failed)` : ""}` +
      `${result.requeued.length ? `, ${result.requeued.length} re-queued for triage` : ""}` +
      `${result.requeueDeclined.length ? `, ${result.requeueDeclined.length} re-queue declined (already settled)` : ""}` +
      `${result.requeueFailed.length ? `, ${result.requeueFailed.length} NOT re-queued (re-queue failed)` : ""}` +
      `${result.refused.length ? `, ${result.refused.length} refused` : ""}.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
