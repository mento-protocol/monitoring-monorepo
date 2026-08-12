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
  isValidShortId,
  parseShortId,
  resolveVerdict,
  selectVerdictComment,
  validateAffectedRepo,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
} from "./sentry-triage-ingest.mjs";
import {
  collapseDuplicateFamilies,
  declaredFamilyIds,
  DEFER_FAMILY_DUPLICATE,
  DEFER_FAMILY_HANDLED,
  DEFER_FAMILY_RECONCILING,
} from "./sentry-autofix-family.mjs";
import {
  AUTOFIX_SELECT_LABEL,
  defaultRunGh,
  listCodeFixStubs,
  listHandledShortIds,
  LOCAL_SENTRY_PROJECT,
  openAutofixPrExists,
  readStub,
  reverseVerifyFamilies,
} from "./sentry-autofix-queue-io.mjs";

// Only `code-fix` verdicts are fixable in code; the select label already
// filters to these, but the re-parse cross-checks the verdict value too.
const AUTOFIX_VERDICT = "code-fix";

// LOCAL_SENTRY_PROJECT and AUTOFIX_SELECT_LABEL are the queue-scoping constants;
// they live in the I/O layer (sentry-autofix-queue-io.mjs) beside the queries
// that use them and are imported above — evaluateCandidate's exact
// owning-project cross-check and the family-collapse project scope share them.

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
export const MAX_CANDIDATE_EVALUATIONS = 50;

/**
 * Evaluate ONE candidate stub against every autofix filter. Returns a CANDIDATE
 * record `{ entry, shortId, duplicateOf, reconcile }` when the stub passes, or
 * `null` (with a stderr note) otherwise. `stub` needs `{ number, title, labels
 * }`; the verdict comments are read here. Never throws — a parse failure is a
 * skip, so the select job always emits a valid array.
 *
 * `entry` is the matrix entry EXACTLY as the workflow consumes it; the sibling
 * fields are selection-time metadata (issue #1784) and never reach stdout. The
 * split keeps the emitted contract byte-identical while giving family collapse
 * the `duplicate_of` the same authoritative parser already produced — no second
 * parser, and no new read.
 */
async function evaluateCandidate(runGh, repo, stub) {
  // Dedup by label first (cheapest, no extra API call). Both autofix markers
  // are terminal until a human clears them or a regression sheds them — this
  // also covers the single-issue dispatch path, which bypasses the server-side
  // list filter.
  if (stub.labels.includes(FIX_PR_OPENED_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: already carries ${FIX_PR_OPENED_LABEL}.\n`,
    );
    return null;
  }
  if (stub.labels.includes(FIX_REFUSED_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: already carries ${FIX_REFUSED_LABEL} (remove it to retry).\n`,
    );
    return null;
  }
  if (!stub.labels.includes(AUTOFIX_SELECT_LABEL)) {
    process.stderr.write(
      `skip #${stub.number}: not labeled ${AUTOFIX_SELECT_LABEL}.\n`,
    );
    return null;
  }

  const shortId = parseShortId(stub.title);
  if (!isValidShortId(shortId)) {
    process.stderr.write(
      `skip #${stub.number}: no parseable Sentry SHORT-ID in title.\n`,
    );
    return null;
  }

  let parsed;
  let verdictCommentUrl;
  try {
    const full = await readStub(runGh, repo, stub.number);
    ({ parsed, verdictCommentUrl } = resolveVerdict(full, stub.number));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`skip #${stub.number}: ${message}\n`);
    return null;
  }

  // Cross-check the verdict value and require an EXACTLY-local owning repo.
  // `unrecognized` also resolves to LOCAL_REPO in validateAffectedRepo, but we
  // fix here ONLY when the agent named this repo verbatim — an unrecognized
  // value is not a confident local classification.
  if (parsed.verdict !== AUTOFIX_VERDICT) {
    process.stderr.write(
      `skip #${stub.number}: verdict is ${parsed.verdict}, not ${AUTOFIX_VERDICT}.\n`,
    );
    return null;
  }
  const repoCheck = validateAffectedRepo(parsed.affectedRepo);
  if (repoCheck.reason !== "local-repo") {
    process.stderr.write(
      `skip #${stub.number}: affected_repo is not exactly this repo (${repoCheck.reason}).\n`,
    );
    return null;
  }

  // An OPEN autofix PR already exists on this SHORT-ID's deterministic branch.
  // Because the two terminal markers were filtered above, reaching here means
  // the stub has NEITHER marker yet its fix PR exists — i.e. a prior run's `gh
  // pr create` succeeded but its follow-up queue comment/label write did not
  // land (a transient failure, or a same-tick race with a concurrent run). This
  // is NOT a plain skip: the stub's queue side-effects are unreconciled and
  // would never be repaired if we dropped it (the workflow's reconcile path is
  // only reachable AFTER selection). Emit it as a RECONCILE entry — the fix job
  // routes reconcile entries to a no-agent step that (re-)applies the marker +
  // comment against the existing PR, never opening a duplicate and never
  // re-running the agent (which could otherwise mislabel it `fix-refused`).
  //
  // Fail-SOFT, exactly like the `readStub` read above. This call is issued once
  // per surviving stub — a whole-window count now, not a capped one — so a
  // single transient `gh` rejection anywhere in the window used to reject out of
  // `selectAutofixCandidates`, exit nonzero, and fail the select step under
  // `set -euo pipefail`. That breaks the invariant the workflow's own header
  // asserts ("ALWAYS emits a valid JSON array … never a failure"). Skipping the
  // one stub is the safe direction: no fix is attempted, no reconcile is
  // claimed, and the next run re-reads it from live state.
  let hasOpenAutofixPr;
  try {
    hasOpenAutofixPr = await openAutofixPrExists(runGh, repo, shortId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `skip #${stub.number}: could not read open autofix PRs for ${shortId}: ${message}\n`,
    );
    return null;
  }
  if (hasOpenAutofixPr) {
    process.stderr.write(
      `reconcile #${stub.number}: an open autofix PR exists for ${shortId} but the stub lacks its marker; routing to no-agent reconciliation.\n`,
    );
    return {
      entry: { issue: stub.number, shortId, reconcile: true },
      shortId,
      duplicateOf: parsed.duplicateOf,
      reconcile: true,
    };
  }

  // Generation token (issue #1506): the numeric id of the verdict comment this
  // fix is based on, threaded through the matrix to finalize so it can refuse to
  // mark the stub fixed if a re-triage REPLACED the verdict comment (ABA) during
  // the run — a change label-presence cannot see. Reconcile entries above carry
  // no token: they relink a PRIOR run's PR, whose originating verdict id select
  // never captured. Emit without the token (finalize falls back to the #1389
  // label-presence guard) only if the url is unparsable — which should not
  // happen for a real, fence-selected verdict comment.
  const verdictCommentId = verdictCommentIdFromUrl(verdictCommentUrl);
  if (!verdictCommentId) {
    process.stderr.write(
      `warn #${stub.number}: could not derive a verdict-comment id (url=${verdictCommentUrl}); emitting without a generation token.\n`,
    );
    return {
      entry: { issue: stub.number, shortId },
      shortId,
      duplicateOf: parsed.duplicateOf,
      reconcile: false,
    };
  }
  return {
    entry: { issue: stub.number, shortId, verdictCommentId },
    shortId,
    duplicateOf: parsed.duplicateOf,
    reconcile: false,
  };
}

/** Render a SHORT-ID into a diagnostic line. The value reaches stderr, which
 * GitHub Actions scans for `::workflow commands::` — so a newline inside it
 * would let agent-authored `duplicate_of` text inject one. `isValidShortId`
 * admits no newline (nor anything outside `[A-Za-z0-9._-]`), and this is the
 * one place a family id is interpolated, so the check sits here rather than
 * being assumed of the caller. */
function safeShortId(shortId) {
  return isValidShortId(shortId) ? shortId : "(unprintable short-id)";
}

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

// Reverse-verify fixpoint ceiling (PR #1810 bug B). A newly discovered blocker
// defers a finalist, which promotes the next candidate, which has its own family
// to probe — so the collapse must re-run until the finalist set is stable. The
// `alreadyProbed` set makes each id cost one search at most, so this ceiling is
// only a backstop; on hit it emits a stderr note and proceeds with the current
// candidates (fails OPEN — toward MORE candidates, the family module's safe
// direction).
const MAX_REVERSE_ITERATIONS = 4;

/**
 * Collapse the candidate window to per-family decisions, closing the two family
 * edges the forward `duplicate_of` graph cannot see on its own:
 *   - bug C: a TERMINAL sibling that the candidate window excludes, found by
 *     querying each DECLARED family id directly (no bounded recent list, so a
 *     blocker deep in the ledger is still found);
 *   - bug B: a REVERSE edge — a handled sibling or hub id that names a finalist
 *     — found by probing each finalist's family member ids via `in:comments`,
 *     then folding the verified edges/blockers back in and re-collapsing.
 * Returns the collapse decisions (see `collapseDuplicateFamilies`).
 */
async function resolveFamilies(runGh, repo, candidates, cap) {
  const project = LOCAL_SENTRY_PROJECT;

  // bug C handled set, keyed per DECLARED family id (the distinct, project-scoped
  // and MAX_DUPLICATE_LOOKUPS-bounded union of every candidate's duplicate_of).
  // Gated on "any declared id exists": a window that declares nothing issues
  // zero handled queries, preserving the empty-window cost profile.
  const declaredIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        declaredFamilyIds(candidate.shortId, candidate.duplicateOf, project),
      ),
    ),
  ];
  let handledShortIds = declaredIds.length
    ? await listHandledShortIds(runGh, repo, declaredIds)
    : [];
  const handledEdges = [];
  const stubCache = new Map();
  const alreadyProbed = new Set();

  // Family ids are agent-authored free text. Scoping every joiner AND every
  // blocker to this project is what stops a foreign-project id — or the bare
  // project slug, which `isValidShortId` accepts — from unioning unrelated local
  // candidates into one starved family.
  const collapse = () =>
    collapseDuplicateFamilies(candidates, {
      handledShortIds,
      handledEdges,
      project,
    });

  let decisions = collapse();

  for (let iteration = 1; candidates.length > 0; iteration += 1) {
    // The would-be matrix entries this collapse produced: selected,
    // non-reconcile, within the cap — precisely the finalists whose families the
    // reverse check must verify. bug B's topology is a finalist that declares
    // nothing yet is named by a handled sibling, so the check runs whenever a
    // finalist exists, not only when a candidate declared an edge.
    const finalists = [];
    for (const decision of decisions) {
      if (finalists.length >= cap) break;
      if (decision.selected && !decision.candidate.reconcile) {
        finalists.push(decision);
      }
    }
    const probeIds = [
      ...new Set(finalists.flatMap((decision) => decision.members ?? [])),
    ].filter((id) => !alreadyProbed.has(id));
    if (probeIds.length === 0) break;

    const { edges, blockers } = await reverseVerifyFamilies(
      runGh,
      repo,
      probeIds,
      { project, stubCache, alreadyProbed },
    );
    const newBlockers = blockers.filter((id) => !handledShortIds.includes(id));
    // Nothing new to fold -> the finalist set is stable.
    if (edges.length === 0 && newBlockers.length === 0) break;

    handledShortIds = [...new Set([...handledShortIds, ...blockers])];
    handledEdges.push(...edges);
    decisions = collapse();

    if (iteration >= MAX_REVERSE_ITERATIONS) {
      process.stderr.write(
        `note: reverse family verification did not reach a fixpoint in ${MAX_REVERSE_ITERATIONS} iterations; proceeding with the current candidates (fails open).\n`,
      );
      break;
    }
  }
  return decisions;
}

/**
 * Run the selection and report BOTH halves of its outcome: the matrix entries,
 * and every candidate the family collapse stood down.
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
 * could tell which issue to name. Both fields go into the run record.
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
  const runGh = deps.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_REPO;

  // Single-issue live run: evaluate exactly the requested issue.
  if (options.issue != null) {
    const stub = await readStub(runGh, repo, options.issue);
    const candidate = await evaluateCandidate(runGh, repo, {
      number: stub.number,
      title: stub.title,
      labels: stub.labels,
    });
    // No list window in single-issue mode: one stub considered, one evaluated,
    // so the Window tripwire never fires (total == evaluated).
    return {
      entries: candidate ? [candidate.entry] : [],
      deferred: [],
      window: { total: 1, evaluated: 1 },
    };
  }

  const cap =
    Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : DEFAULT_CAP;
  const stubs = await listCodeFixStubs(runGh, repo);

  // Evaluate the window before choosing, not just the first `cap`: the family
  // union is transitive, so a stub further down the window can join two earlier
  // ones (or attach to a family through an id that is not itself a candidate),
  // and a decision taken before that stub is read can be wrong. Bounded by
  // MAX_CANDIDATE_EVALUATIONS (oldest-first, so the budget only ever drops the
  // newest tail) rather than by LIST_LIMIT, so the run's `gh` cost cannot grow
  // with a window that has no mechanism to shrink.
  const evaluable = stubs.slice(0, MAX_CANDIDATE_EVALUATIONS);
  if (stubs.length > evaluable.length) {
    process.stderr.write(
      `note: window has ${stubs.length} stubs; evaluating the oldest ${evaluable.length} (MAX_CANDIDATE_EVALUATIONS).\n`,
    );
  }
  // The Window tripwire (PR #1810 cost bound): the record job renders "Window: N
  // stubs, evaluated M" when N>M, so any approach toward the eval cap is
  // reported on the tracker weeks ahead — never a silent truncation.
  const window = { total: stubs.length, evaluated: evaluable.length };

  const candidates = [];
  for (const stub of evaluable) {
    const candidate = await evaluateCandidate(runGh, repo, stub);
    if (candidate) candidates.push(candidate);
  }

  const decisions = await resolveFamilies(runGh, repo, candidates, cap);
  const entries = [];
  const deferred = [];
  for (const decision of decisions) {
    const number = decision.candidate.entry.issue;
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
  return { entries, deferred, window };
}

/** Matrix entries only — the emitted contract, unchanged. `selectAutofixRun`
 * carries the deferral report the run record needs alongside it. */
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
that do not yet have a fix PR, collapsed to ONE candidate per \`duplicate_of\`
family. Diagnostics go to stderr.

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
  --window-out <p>     Write the Window tripwire — { "total": <n>, "evaluated":
                       <n> } — to this path, so the run record can surface a list
                       window that exceeded the eval cap. Stdout is unchanged.
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
    windowOut: null,
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
      case "--window-out":
        options.windowOut = readValue();
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
  const { entries, deferred, window } = await selectAutofixRun(options);
  // Report BEFORE stdout: the workflow captures stdout into a shell variable, so
  // a failed report write must not be able to lose the entries too. Both are
  // best-effort — the run record degrades to "0 deferred" / no Window line,
  // never to a dead leg.
  if (options.deferredOut) {
    try {
      writeFileSync(options.deferredOut, `${JSON.stringify(deferred)}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warn: could not write the deferral report: ${message}\n`,
      );
    }
  }
  if (options.windowOut) {
    try {
      writeFileSync(options.windowOut, `${JSON.stringify(window ?? {})}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warn: could not write the window report: ${message}\n`,
      );
    }
  }
  process.stdout.write(`${JSON.stringify(entries)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
