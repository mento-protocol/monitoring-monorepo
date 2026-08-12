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
 *   - FIX SCOPE (issue #1785): only a verdict claiming `fix_scope: mechanical`
 *     starts a fix attempt. `architectural` — the fail-closed value for an
 *     absent or unrecognized field — is skipped and left unmarked, so no
 *     terminal refusal accumulates on a stub a human still has to judge. The
 *     skip is REPORTED (`skipped`), because it writes nothing: an unreported
 *     stand-down renders on the tracker as an idle leg. The skipped stub still
 *     joins the family union below — dropping it would delete its
 *     `duplicate_of` edges and fan its family back out.
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

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO,
  FIX_SCOPE_MECHANICAL,
  isValidShortId,
  parseShortId,
  resolveVerdict,
  selectVerdictComment,
  validateAffectedRepo,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";
import {
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  PROJECTED_LABEL,
} from "./sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";
import {
  collapseDuplicateFamilies,
  DEFER_FAMILY_DUPLICATE,
  DEFER_FAMILY_HANDLED,
  DEFER_FAMILY_RECONCILING,
} from "./sentry-autofix-family.mjs";

// Only `code-fix` verdicts are fixable in code; the select label already
// filters to these, but the re-parse cross-checks the verdict value too.
const AUTOFIX_VERDICT = "code-fix";

// The verdict label the select scans for — re-exported from the ingest's single
// source of truth (`code-fix` maps to this label), so a future rename can't
// desync selection from the finalize marker re-read that shares the constant.
export const AUTOFIX_SELECT_LABEL = CODE_FIX_VERDICT_LABEL;

// The one Sentry project whose source lives in THIS repo (ui-dashboard).
// affected_repo `mento-protocol/monitoring-monorepo` corresponds to this
// project (queue contract / verdict contract). The queue title carries the
// project — `[sentry] <SHORT-ID> (<project>, <level>)` — so the batch list can
// cheaply pre-filter to this project BEFORE the per-candidate verdict read.
// This is the starvation guard: `sentry:verdict-code-fix` is never removed, so
// EXTERNAL-repo code-fix stubs (the majority — most Sentry projects are not the
// dashboard) would otherwise accumulate forever and, oldest-first, fill the
// list window ahead of any local candidate. The verdict's affected_repo stays
// the authority (checked in evaluateCandidate); a stub whose project is this
// one but whose verdict names another repo is a triage error whose fix would
// not live here anyway, so dropping it here is the correct, cheap direction.
export const LOCAL_SENTRY_PROJECT = "analytics-mento-org";

const QUEUE_TITLE_PROJECT_PATTERN = /^\[sentry\]\s+\S+\s+\(([^,)]+)[,)]/;

/** Extract the Sentry project from a queue-stub title, or null when unparsable. */
export function parseProject(title) {
  const match = QUEUE_TITLE_PROJECT_PATTERN.exec(String(title ?? ""));
  return match ? match[1].trim() : null;
}

export const DEFAULT_CAP = 2;

/** Why a candidate was skipped without any queue write. Distinct from the
 * family DEFER_* reasons: a deferral lifts when a sibling's state changes,
 * whereas this one lifts only when a re-triage supplies a new verdict. */
export const SKIP_FIX_SCOPE_ARCHITECTURAL = "fix-scope-architectural";

// Generous list window: with fixed stubs excluded server-side and the project
// pre-filter above, the eligible-and-unfixed local set stays tiny, so this is
// only a safety ceiling — not the throttle. Oldest-first, so genuinely old
// candidates are never starved by newer ones.
const LIST_LIMIT = 200;

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

// ---------------------------------------------------------------------------
// GitHub I/O (via `gh`, mirroring the ingest/digest/project scripts). `runGh`
// is injectable so tests drive the full flow with mocked I/O.
// ---------------------------------------------------------------------------

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

/**
 * Oldest-first list of candidate `sentry:verdict-code-fix` queue stubs. Two
 * server-side narrowings keep the fixed-window from starving out genuinely-old
 * candidates (the verdict label is never removed, so stubs accumulate):
 *   - `-label:sentry:fix-pr-opened -label:sentry:fix-refused` excludes stubs
 *     this leg already handled (opened a PR for, or attempted and refused);
 *   - the LOCAL_SENTRY_PROJECT title pre-filter (applied here, client-side off
 *     the returned title) drops EXTERNAL-repo code-fix stubs before their
 *     verdict is ever read.
 * Oldest-first via `sort:created-asc`, capped at LIST_LIMIT as a safety ceiling.
 */
async function listCodeFixStubs(runGh, repo) {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    AUTOFIX_SELECT_LABEL,
    "--state",
    "all",
    // Exclude everything that does not belong in the window AT THE SOURCE:
    // `--limit` caps what the API RETURNS before any client-side filter runs,
    // so an accumulating backlog of not-for-us stubs that sort BEFORE newer
    // local candidates would silently starve them out of the window. Two axes:
    //   - Handled/external markers: `fix-pr-opened` (a PR was opened) and
    //     `fix-refused` (an attempt declined) are terminal until a human clears
    //     them or a regression sheds them; `sentry:projected` marks external
    //     code-fix stubs whose verdict was projected into the owning repo;
    //     `sentry:archived` marks a stub whose Sentry issue is archived
    //     (archived_until_escalating) — spending an autofix run on an issue the
    //     archive loop deliberately silenced is wrong on its own, and because
    //     nothing else ever removes it from this window (a regression sheds it
    //     via REOPEN_SHED_LABELS along with the verdict label, which then makes
    //     the stub a fresh candidate), an archived stub would otherwise cost a
    //     full `issue view` on every run forever.
    //   - Owning PROJECT, by title: the `sentry:projected` exclusion alone is
    //     not enough — the projection workflow's documented `skipped-no-token`
    //     path CLOSES external code-fix stubs while KEEPING the verdict label
    //     and WITHOUT adding `sentry:projected`, so those would slip past the
    //     label filter and fill the window. `<slug> in:title` restricts to
    //     titles containing this repo's Sentry project slug; GitHub tokenizes
    //     the hyphenated slug and ANDs the tokens (`analytics` AND `mento` AND
    //     `org`), which — across the org's `*-mento-org` / `*-api` / `-dapp`
    //     projects — matches only this project's stubs. The exact client-side
    //     `parseProject === LOCAL_SENTRY_PROJECT` check below stays as the
    //     precise gate (this server filter only needs to keep the WINDOW local).
    "--search",
    `sort:created-asc -label:"${FIX_PR_OPENED_LABEL}" -label:"${FIX_REFUSED_LABEL}" -label:"${PROJECTED_LABEL}" -label:"${ARCHIVED_LABEL}" ${LOCAL_SENTRY_PROJECT} in:title`,
    "--json",
    "number,title,labels,createdAt",
    "--limit",
    String(LIST_LIMIT),
  ]);
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [];
  return (
    list
      .map((issue) => ({
        number: issue.number,
        title: issue.title ?? "",
        createdAt: issue.createdAt ?? "",
        labels: (issue.labels ?? [])
          .map((label) => (typeof label === "string" ? label : label?.name))
          .filter(Boolean),
      }))
      // Exact owning-project gate — the server-side `<slug> in:title` filter
      // keeps the WINDOW local (tokenized, so approximate); this parses the
      // exact project out of the title and drops any tokenized false-positive.
      .filter((issue) => parseProject(issue.title) === LOCAL_SENTRY_PROJECT)
      // `--search sort:created-asc` returns oldest-first, but keep the client-side
      // sort as defense-in-depth (same pattern as the triage select job).
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  );
}

/**
 * SHORT-IDs of local stubs that already carry a TERMINAL autofix marker
 * (`sentry:fix-pr-opened` / `sentry:fix-refused`) — the family-collapse input
 * that `listCodeFixStubs` structurally cannot provide, because it excludes
 * exactly these stubs from the candidate window.
 *
 * Without it, a refused representative strands its family: on the run after
 * `ANALYTICS-MENTO-ORG-2E` (#1304) was refused, its four siblings are the only
 * family members left in the window, each pointing back at a stub the selector
 * can no longer see — so they come back one per run and re-burn the cap on a
 * root cause the leg already declined. That is the exact 5-runs-for-1-cause
 * failure this reads live state to close.
 *
 * One query per marker (never the `label:"a","b"` OR syntax): if that syntax
 * were ever mis-parsed the query would return nothing, and this input fails
 * OPEN — an empty handled set means no family is blocked, i.e. straight back to
 * the bug. Two unambiguous queries cost one extra call on runs that have a
 * family at all, and the selector only issues them then.
 *
 * Titles only — the SHORT-ID is parsed out of the queue title (contract v2) and
 * shape-validated, so nothing here is trusted beyond its shape.
 */
async function listHandledShortIds(runGh, repo) {
  const shortIds = new Set();
  for (const marker of [FIX_PR_OPENED_LABEL, FIX_REFUSED_LABEL]) {
    const stdout = await runGh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      `sort:created-desc label:"${marker}" ${LOCAL_SENTRY_PROJECT} in:title`,
      "--json",
      "number,title",
      "--limit",
      String(LIST_LIMIT),
    ]);
    const parsed = JSON.parse(stdout);
    for (const issue of Array.isArray(parsed) ? parsed : []) {
      if (parseProject(issue.title ?? "") !== LOCAL_SENTRY_PROJECT) continue;
      const shortId = parseShortId(issue.title ?? "");
      if (isValidShortId(shortId)) shortIds.add(shortId);
    }
  }
  return [...shortIds];
}

/** Read a queue stub's title/labels/comments so it can be evaluated in full. */
async function readStub(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
    comments: data.comments ?? [],
  };
}

// `gh pr list --head <branch>` matches by branch NAME, and a pull request opened
// from a FORK carries its own head branch name — so `--head` returns fork PRs
// too. Verified live against a public repo: `gh pr list -R cli/cli --head
// feat/uptime-command --state open --json isCrossRepository,headRepositoryOwner`
// returns `{"isCrossRepository":true,"headRepositoryOwner":{"login":
// "seanturner83"}}`. This repo is public, queue-stub titles are public, and
// `autofixBranchName` is deterministic, so ANY GitHub user can fork it, push
// `sentry-autofix/<short-id-lower>`, and open a PR at main. Without this fence
// that PR is read as OUR prior fix PR: the stub routes to the reconcile path,
// which comments the attacker's PR url onto the queue issue and applies
// `sentry:fix-pr-opened` — terminal until a human clears it — and the family
// collapse then stands the whole duplicate family down behind it.
//
// The head branch is one-to-one with the SHORT-ID only WITHIN this repo, so
// ownership has to be asserted, not assumed. Both signals must affirm it.
const HEAD_OWNERSHIP_FIELDS = "number,isCrossRepository,headRepositoryOwner";

/** True when `pr` is a same-repo PR of `repo` — i.e. one this pipeline could
 * have opened. Fails CLOSED: a missing or unexpected field is "not ours", which
 * costs at most a re-attempt on a branch that already has our PR (`gh pr create`
 * refuses a second one) and never hands an outsider the reconcile write path. */
export function isOwnHeadPr(pr, repo) {
  const owner = String(repo ?? "")
    .split("/")[0]
    .toLowerCase();
  if (!owner) return false;
  return (
    pr?.isCrossRepository === false &&
    String(pr?.headRepositoryOwner?.login ?? "").toLowerCase() === owner
  );
}

/** True when an OPEN autofix PR already exists for this SHORT-ID — the autofix
 * leg must never open a second fix PR for a Sentry issue that already has one.
 * Matched by the DETERMINISTIC head branch (`sentry-autofix/<short-id-lower>`),
 * NOT by a text search: a free-text `--search "<SHORT-ID>"` matches any open PR
 * whose body/title merely mentions the id (a human PR, a dependency bump, an
 * unrelated fix that cites the Sentry issue), which would both falsely dedup an
 * eligible stub out of selection AND — via the reconcile path — mislabel the
 * stub `sentry:fix-pr-opened` pointing at that unrelated PR. `--state open`
 * only: a merged/closed PR is not a live dedup (a regressed, re-triaged issue
 * must be re-attemptable). The branch name is derived from the shape-validated
 * SHORT-ID and transits `gh` as an argv element, so it can't inject.
 *
 * NOT `--limit 1`: fork PRs share the branch-name namespace (see above), so a
 * single-row window can be filled by a spoof and hide our own PR behind it —
 * which would make the leg try to open a second one. Take a small page and let
 * `isOwnHeadPr` pick ours out of it. */
async function openAutofixPrExists(runGh, repo, shortId) {
  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    autofixBranchName(shortId),
    "--state",
    "open",
    "--json",
    HEAD_OWNERSHIP_FIELDS,
    "--limit",
    "20",
  ]);
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : []).some((pr) =>
    isOwnHeadPr(pr, repo),
  );
}

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
  // closed), is a human backlog item. It is SKIPPED, deliberately WITHOUT
  // FIX_REFUSED_LABEL: a refusal marker is terminal until a human clears it and
  // would stand the stub's whole duplicate family down behind it, which is how
  // five real stubs burned five agent runs on one architecture change. Leaving
  // the stub unmarked keeps it re-selectable the moment a re-triage supplies
  // `fix_scope: mechanical`. It does NOT leave it waiting in the queue: a local
  // code-fix stub is CLOSED when its verdict lands, so the human backlog is the
  // run record's skip line plus the digest's routed-section note — which is why
  // this returns a reportable record instead of dropping the stub.
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
  const runGh = deps.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_REPO;

  // Single-issue live run: evaluate exactly the requested issue. A dispatch
  // cannot override the fix_scope gate (that is the point of the gate), so the
  // skip is reported here too — otherwise the documented remedy for a stalled
  // leg is itself silent, and an operator who dispatches an architectural stub
  // sees the same empty array as for an ineligible one.
  if (options.issue != null) {
    const stub = await readStub(runGh, repo, options.issue);
    const candidate = await evaluateCandidate(runGh, repo, {
      number: stub.number,
      title: stub.title,
      labels: stub.labels,
    });
    const selectable = candidate != null && candidate.eligible !== false;
    return {
      entries: selectable ? [candidate.entry] : [],
      deferred: [],
      skipped: selectable
        ? []
        : candidate == null
          ? []
          : [{ issue: candidate.issue, reason: candidate.skipReason }],
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
  const candidates = [];
  for (const stub of evaluable) {
    const candidate = await evaluateCandidate(runGh, repo, stub);
    if (candidate) candidates.push(candidate);
  }

  // No candidate declares a family -> nothing to collapse, and the extra
  // handled-sibling reads are not worth issuing. This is also what keeps the
  // no-duplicates path's `gh` call profile identical to the pre-#1784 one.
  const hasFamilySignal = candidates.some(
    (candidate) => (candidate.duplicateOf ?? []).length > 0,
  );
  const handledShortIds = hasFamilySignal
    ? await listHandledShortIds(runGh, repo)
    : [];

  const decisions = collapseDuplicateFamilies(candidates, {
    handledShortIds,
    // Family ids are agent-authored free text. Scoping every joiner AND every
    // blocker to this project is what stops a foreign-project id — or the bare
    // project slug, which `isValidShortId` accepts — from unioning unrelated
    // local candidates into one starved family.
    project: LOCAL_SENTRY_PROJECT,
  });
  const entries = [];
  const deferred = [];
  const skipped = [];
  for (const decision of decisions) {
    const number = decision.candidate.issue;
    // Ruled out before the collapse ran (fix_scope). It joined the union so its
    // family edges survived, but it is not a family deferral and must not be
    // reported as one: the two lift on different events.
    if (decision.candidate.eligible === false) {
      skipped.push({ issue: number, reason: decision.candidate.skipReason });
      continue;
    }
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
  return { entries, deferred, skipped };
}

/** Matrix entries only — the emitted contract, unchanged. `selectAutofixRun`
 * carries the deferral and fix_scope-skip reports the run record needs
 * alongside it. */
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
 * it always emits a valid array. */
function writeReport(path, report, label) {
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify(report ?? [])}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warn: could not write the ${label} report: ${message}\n`,
    );
  }
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
  const { entries, deferred, skipped } = await selectAutofixRun(options);
  // Report BEFORE stdout: the workflow captures stdout into a shell variable, so
  // a failed report write must not be able to lose the entries too. Both are
  // best-effort — the run record degrades to "0", never to a dead leg.
  writeReport(options.deferredOut, deferred, "deferral");
  writeReport(options.skippedOut, skipped, "fix_scope skip");
  process.stdout.write(`${JSON.stringify(entries)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
