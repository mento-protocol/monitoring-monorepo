#!/usr/bin/env node
/**
 * Per-candidate eligibility evaluation for the Sentry AUTOFIX selector.
 * Extracted from scripts/sentry/autofix/sentry-autofix-select.mjs (which sat over the 600-line
 * soft cap) so that module keeps window listing, family orchestration and its
 * CLI, and this one owns the question "may THIS stub start a fix attempt?".
 *
 * Every filter the selector applies to a single stub lives here — the terminal
 * autofix markers, the queue label, the SHORT-ID parse, the authoritative
 * verdict re-parse and its exactly-local repo check, the open-PR reconcile
 * branch, and the fix_scope gate (#1785/#1812). PURE decision layer over an
 * injected `runGh`: it reads, it never writes.
 */

import {
  FIX_SCOPE_MECHANICAL,
  isValidShortId,
  parseShortId,
  resolveVerdict,
  validateAffectedRepo,
  verdictCommentIdFromUrl,
} from "../triage/sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
} from "../triage/sentry-triage-ingest.mjs";
import {
  AUTOFIX_SELECT_LABEL,
  openAutofixPrExists,
  readStub,
} from "./sentry-autofix-queue-io.mjs";

// Only `code-fix` verdicts are fixable in code; the select label already
// filters to these, but the re-parse cross-checks the verdict value too.
const AUTOFIX_VERDICT = "code-fix";

/** Why a candidate was skipped without any queue write. Distinct from the
 * family DEFER_* reasons: a deferral lifts when a sibling's state changes,
 * whereas this one lifts only when a re-triage supplies a new verdict. */
export const SKIP_FIX_SCOPE_ARCHITECTURAL = "fix-scope-architectural";

/**
 * Evaluate ONE candidate stub against every autofix filter. Returns a CANDIDATE
 * record `{ entry, issue, shortId, duplicateOf, reconcile }` when the stub
 * passes, an INELIGIBLE record `{ issue, shortId, duplicateOf, eligible: false,
 * skipReason }` when only the `fix_scope` gate refused it (no `entry` — it
 * contributes family edges and a report line, never a matrix row), or `null`
 * (with a stderr note) otherwise. `stub` needs `{ number, title, labels
 * }`; the verdict comments are read here. Never throws — a parse failure is a
 * skip, so the select job always emits a valid array.
 *
 * `entry` is the matrix entry EXACTLY as the workflow consumes it; the sibling
 * fields are selection-time metadata (issue #1784) and never reach stdout. The
 * split keeps the emitted contract byte-identical while giving family collapse
 * the `duplicate_of` the same authoritative parser already produced — no second
 * parser, and no new read.
 */
export async function evaluateCandidate(runGh, repo, stub) {
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
      issue: stub.number,
      shortId,
      duplicateOf: parsed.duplicateOf,
      reconcile: true,
    };
  }

  // fix_scope gate (issue #1785). `code-fix` says the cause is in our code; it
  // does NOT say a scoped fix exists. Only a verdict that claims `mechanical`
  // starts a fix attempt — `architectural`, which is also what an absent,
  // empty, or unrecognized value normalizes to (`normalizeFixScope` fails
  // closed), is a human backlog item. Fresh architectural verdicts settle OPEN
  // under `sentry:fix-scope-architectural` and are excluded from the candidate
  // window at query time (issue #1812), so the stubs that reach THIS gate are
  // the legacy/hand-removed stragglers the label does not yet cover. They are
  // SKIPPED, deliberately WITHOUT FIX_REFUSED_LABEL: a refusal marker is terminal
  // until a human clears it and would stand the stub's whole duplicate family
  // down behind it, which is how five real stubs burned five agent runs on one
  // architecture change. The skip writes nothing here; the record-run job
  // backfills the exclusion label onto these stragglers so the next run excludes
  // them at the source, and this returns a reportable record so the count is
  // never silent.
  //
  // Placed AFTER the reconcile branch on purpose: reconciliation runs no agent
  // and opens no PR, it repairs the queue bookkeeping for a PR that ALREADY
  // exists. Gating it here would strand such a PR unlinked forever if a
  // re-triage flipped its verdict's scope between the two runs.
  //
  // `parsed.fixScope` is closed-enum by construction, and the SHORT-ID goes
  // through `safeShortId` — stderr is scanned for `::workflow commands::`, and
  // this line is agent-derived text reaching it.
  //
  // Returns an INELIGIBLE record rather than `null`, for two reasons that a bare
  // drop got wrong. (1) Its `duplicate_of` edges stay in the family graph: an
  // architectural stub is often the anchor its siblings hang off, and deleting
  // it fans one root cause back out into one agent run per sibling — or lets a
  // family whose refused member is only reachable THROUGH it come back for a
  // fresh run. (2) The skip is reportable, so a window standing entirely down on
  // scope stops rendering as `Candidates selected: 0` — indistinguishable from
  // an empty queue, the #1758 misdiagnosis. It carries no `entry`: there is
  // nothing here the matrix may ever consume.
  if (parsed.fixScope !== FIX_SCOPE_MECHANICAL) {
    process.stderr.write(
      `skip #${stub.number}: fix_scope for ${safeShortId(shortId)} is ${parsed.fixScope}, not ${FIX_SCOPE_MECHANICAL}; no refusal marker, reported as a fix_scope skip.\n`,
    );
    return {
      issue: stub.number,
      shortId,
      duplicateOf: parsed.duplicateOf,
      reconcile: false,
      eligible: false,
      skipReason: SKIP_FIX_SCOPE_ARCHITECTURAL,
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
      issue: stub.number,
      shortId,
      duplicateOf: parsed.duplicateOf,
      reconcile: false,
    };
  }
  return {
    entry: { issue: stub.number, shortId, verdictCommentId },
    issue: stub.number,
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
export function safeShortId(shortId) {
  return isValidShortId(shortId) ? shortId : "(unprintable short-id)";
}
