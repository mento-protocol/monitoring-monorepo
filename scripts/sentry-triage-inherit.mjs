#!/usr/bin/env node
/**
 * Family-verdict inheritance lookups (#1614 part 2).
 *
 * The DECISION is pure and lives in `sentry-triage-queue-contract.mjs`
 * (`selectInheritableSibling`, `mentionsSecuritySensitiveSurface`). This module
 * holds only the GitHub reads that feed it, kept out of
 * `sentry-triage-project.mjs` because that entrypoint is already well past the
 * repo's file-size budget and appending to it is what the recurring-review
 * checklist tells us not to do.
 *
 * Both functions fail toward the agent's own verdict: inheritance is an
 * optimisation over escalating, so every error here degrades to the behaviour
 * that existed before the feature — one extra human read, never a wrong
 * settlement.
 */

import {
  MAX_DUPLICATE_LOOKUPS,
  parseShortId,
} from "./sentry-triage-project-core.mjs";
import { selectInheritableSibling } from "./sentry-triage-queue-contract.mjs";
import { sanitizeDuplicateIds } from "./sentry-triage-text.mjs";

/**
 * Read the queue stubs for a family's declared duplicates (#1614 part 2).
 *
 * One SEARCH per declared sibling, not one broad listing. A `gh issue list
 * --limit 200` is newest-first, so once the queue passes 200 stubs an older
 * judged family silently falls outside the window and its siblings escalate
 * again — the exact failure this feature exists to prevent, arriving quietly
 * as the repo grows. `duplicate_of` is already capped at MAX_DUPLICATE_LOOKUPS,
 * so this is a bounded handful of calls, and only on a needs-human verdict
 * that declares duplicates at all.
 *
 * Failure is NOT fatal: inheritance is an optimisation over escalating, so any
 * error falls back to the agent's own `needs-human`. The stub still gets a
 * decision-ready brief; it just does not get collapsed into its family.
 */
export async function readSiblingVerdicts(
  localRun,
  repo,
  duplicateOf,
  selfShortId,
) {
  const wanted = sanitizeDuplicateIds(duplicateOf)
    .filter((id) => id !== selfShortId)
    .slice(0, MAX_DUPLICATE_LOOKUPS);
  const out = [];
  for (const shortId of wanted) {
    let stdout;
    try {
      stdout = await localRun([
        "issue",
        "list",
        "-R",
        repo,
        "--label",
        // THIS REPO IS PUBLIC. Without this filter any user can open an issue
        // titled `[sentry] <SHORT-ID> (...)` and either shadow the genuine
        // sibling or, carrying the upstream label, become the judgment source
        // for someone else's escalation. The label is applied only by the
        // ingest, so it is the fence between a queue stub and a lookalike.
        "sentry-triage",
        "--search",
        // The queue title is `[sentry] <SHORT-ID> (...)`, so an in:title search
        // for the id finds the stub at any age. `--state all` because the
        // inheritable sibling is by definition CLOSED.
        `${shortId} in:title`,
        "--state",
        "all",
        "--limit",
        // GitHub title search is token-based, so `GOV-5` also matches `GOV-50`
        // and `GOV-500` — real shapes, since Sentry short-ids grow in length.
        // 100 gives 5x headroom over the observed queue and stays ONE bounded
        // call; paginating until found would put an unbounded loop inside the
        // label step, whose failure mode is worse than the miss it prevents.
        "100",
        "--json",
        "number,title,state,labels",
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `::warning::Could not search for family sibling ${shortId} (${message}); keeping the agent's own verdict.\n`,
      );
      return [];
    }
    let rows;
    try {
      rows = JSON.parse(stdout);
    } catch (err) {
      // Same visibility as a search failure. A `gh` output-format change would
      // otherwise disable inheritance permanently and silently, with nothing in
      // the logs to explain why families stopped collapsing.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `::warning::Could not parse the sibling search for ${shortId} (${message}); keeping the agent's own verdict.\n`,
      );
      return [];
    }
    let found = false;
    for (const row of Array.isArray(rows) ? rows : []) {
      // Token search is not exact, so re-check the parsed SHORT-ID rather than
      // trusting the match: `GOV-5` must never resolve to `GOV-57`.
      if (parseShortId(row?.title) !== shortId) continue;
      out.push({
        shortId,
        number: row?.number,
        state: row?.state,
        labels: row?.labels ?? [],
      });
      found = true;
      break;
    }
    // Say so when a declared sibling is not resolved. The consequence is only
    // that this stub escalates — the pre-inheritance behaviour — but a silent
    // miss and a genuinely absent sibling look identical in the log, and this
    // is the line that tells them apart if families stop collapsing.
    if (!found) {
      process.stderr.write(
        `::notice::Family sibling ${shortId} not found among queue stubs (returned ${Array.isArray(rows) ? rows.length : 0} rows); not inheriting from it.\n`,
      );
    }
  }
  return out;
}

/**
 * Confirm a selected sibling is STILL closed with exactly the inheritable
 * verdict (#1614). This narrows the window between selection and settlement; it
 * does not close it, and cannot — the sibling can change state after any read.
 *
 * The residual is deliberately bounded rather than eliminated: if a regression
 * reopens the sibling just after this check, THIS stub closes as
 * `upstream-transient`, and ingest reopens it on the next event for its own
 * Sentry issue (the closed-match regression rule). The escalation is deferred
 * until the error recurs, not destroyed — and an error that never recurs is the
 * one `upstream-transient` describes.
 */
export async function siblingStillSettled(localRun, repo, sibling) {
  if (!Number.isInteger(sibling?.number)) return false;
  try {
    const stdout = await localRun([
      "issue",
      "view",
      String(sibling.number),
      "-R",
      repo,
      "--json",
      "state,labels",
    ]);
    const data = JSON.parse(stdout);
    return Boolean(
      selectInheritableSibling(
        [sibling.shortId],
        [
          {
            shortId: sibling.shortId,
            state: data?.state,
            labels: data?.labels ?? [],
          },
        ],
        null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `::warning::Could not re-confirm family sibling ${sibling.shortId} before inheriting (${message}); keeping the agent's own verdict.\n`,
    );
    return false;
  }
}
