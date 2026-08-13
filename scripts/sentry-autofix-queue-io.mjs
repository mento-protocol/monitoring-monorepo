/**
 * GitHub I/O layer for the Sentry AUTOFIX selector
 * (scripts/sentry-autofix-select.mjs). Extracted from the selector (checklist
 * split-not-append rule: the selector sat above the 600-line soft cap and this
 * leg's family-dedupe work adds ~100 more) so the selector keeps only the pure
 * parse / evaluate / collapse-orchestration / report / CLI layers.
 *
 * Every `gh` read the selection leg issues lives here, and `runGh` is injectable
 * so tests drive the full flow with mocked I/O. Nothing here writes: the whole
 * selection step is read-only (the workflow's finalize job owns every write).
 * The exported names are stable — the selector and its tests import them
 * directly, no re-export shim.
 */

import { spawn } from "node:child_process";

import { parseShortId } from "./sentry-triage-project-core.mjs";
import {
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  PROJECTED_LABEL,
} from "./sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";
import { familyKey } from "./sentry-autofix-family.mjs";

// The queue-membership label every triage stub carries (the queue contract's
// `LABEL_DEFINITIONS` self-heals it). Both per-id lookups below narrow their
// search to it so a random issue that merely quotes a SHORT-ID cannot match.
// Exported so the extracted reverse-verify leg
// (sentry-autofix-reverse-verify.mjs) narrows its `in:comments` probe the same
// way.
export const SENTRY_TRIAGE_QUEUE_LABEL = "sentry-triage";

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

// Generous list window: with fixed stubs excluded server-side and the project
// pre-filter above, the eligible-and-unfixed local set stays tiny, so this is
// only a safety ceiling — not the throttle. Oldest-first, so genuinely old
// candidates are never starved by newer ones.
const LIST_LIMIT = 200;

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
export async function listCodeFixStubs(runGh, repo) {
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
    //   - fix_scope architectural (#1812): a local code-fix verdict whose scope
    //     is architectural is open human design work the autofix leg never
    //     selects. Settlement labels it `sentry:fix-scope-architectural` and the
    //     record-run backfill labels the legacy stubs, so this fifth `-label:`
    //     term excludes the whole architectural class — the fail-closed value
    //     every pre-#1785 verdict normalizes to — at the SOURCE. Without it that
    //     class is the only monotonic growth driver left in the window (#1813):
    //     it is skipped on scope every run and never gets a terminal marker, so
    //     it would accumulate forever and, oldest-first, starve fresh candidates.
    //     evaluateCandidate's fix_scope re-parse stays the authority, so a stale
    //     or missing label costs one reported skip, never a wrong selection.
    "--search",
    `sort:created-asc -label:"${FIX_PR_OPENED_LABEL}" -label:"${FIX_REFUSED_LABEL}" -label:"${PROJECTED_LABEL}" -label:"${ARCHIVED_LABEL}" -label:"${FIX_SCOPE_ARCHITECTURAL_LABEL}" ${LOCAL_SENTRY_PROJECT} in:title`,
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
 * How many distinct declared family ids one run may look up — a per-RUN budget,
 * shared across the initial declared-id pass AND the fixpoint's re-checks of
 * reverse-surfaced hub ids (see `resolveFamilies`). Each candidate's fan-out is
 * already MAX_DUPLICATE_LOOKUPS-bounded, but the distinct union across a full
 * window (plus the ids the reverse probe surfaces) could still be large; overflow
 * ids are treated as NOT-handled — failing toward MORE candidates, the family
 * module's documented safe direction — with a stderr note AND a run-record line
 * (the overflow count is threaded out through the shared `budget`).
 */
export const MAX_HANDLED_ID_QUERIES = 40;

/**
 * Family keys that already carry a TERMINAL autofix marker
 * (`sentry:fix-pr-opened` / `sentry:fix-refused`) — the family-collapse input
 * `listCodeFixStubs` structurally cannot provide, because it excludes exactly
 * these stubs from the candidate window. Without it, a refused representative
 * strands its family: after `ANALYTICS-MENTO-ORG-2E` (#1304) was refused, its
 * four siblings are the only members left in the window, each pointing back at a
 * stub the selector can no longer see, so they return one per run and re-burn
 * the cap on a root cause the leg already declined.
 *
 * Keyed on the DECLARED id, not a position in a recent window (PR #1810 bug C).
 * The prior design listed both terminal-marker sets in bulk
 * (`sort:created-desc --limit 200`) and read a candidate's siblings out of that
 * recent slice — so a blocker sitting past row 200 (a terminal sibling deep in
 * the ledger) was invisible and its family re-attempted forever. Here each
 * declared id `<ID>` runs ONE query `"<ID>" in:title label:"sentry-triage"`,
 * then the exactly-matching stub's labels decide it: keyed on the referenced id,
 * a terminal sibling 500 stubs deep is still found, and truncation is
 * structurally impossible at any ledger size.
 *
 * ONE query covers BOTH markers with no OR-label syntax: the search narrows to
 * queue stubs of this family, and the marker check is client-side off the
 * returned labels. The parsed-short-id + project recheck fences GitHub's
 * tokenized search, so a fuzzy near-miss (a different suffix that tokenizes the
 * same) is dropped.
 */
export async function listHandledShortIds(
  runGh,
  repo,
  declaredIds,
  options = {},
) {
  // `queried` (already-looked-up ids) and `budget` (remaining allowance +
  // accumulated overflow) are shared across the run's calls, so a second pass on
  // reverse-surfaced ids neither re-queries an id nor exceeds the per-run cap.
  // Absent (a standalone call), each defaults fresh, preserving the single-call
  // cap-at-40 behaviour exactly.
  const queried = options.queried instanceof Set ? options.queried : new Set();
  const budget = options.budget ?? {
    remaining: MAX_HANDLED_ID_QUERIES,
    overflow: 0,
  };
  const ids = [
    ...new Set(
      (Array.isArray(declaredIds) ? declaredIds : [])
        .map((id) => familyKey(id))
        .filter((id) => id.length > 0),
    ),
  ].filter((id) => !queried.has(id));
  const capacity = Math.max(0, budget.remaining ?? 0);
  const queryIds = ids.slice(0, capacity);
  const droppedIds = ids.slice(queryIds.length);
  if (droppedIds.length > 0) {
    budget.overflow = (budget.overflow ?? 0) + droppedIds.length;
    // Mark the un-run ids as queried too. The budget is shared across the run's
    // calls — the declared-id pass AND the fixpoint's rechecks — and a recheck
    // re-surfaces the same member ids every iteration; without this, one
    // un-runnable id would be re-counted into overflow once per iteration. The
    // per-run overflow must reflect each DISTINCT un-runnable id once. It is also
    // correct on its face: the budget is spent, so a later pass must not
    // re-attempt these ids either.
    for (const droppedId of droppedIds) queried.add(droppedId);
    process.stderr.write(
      `note: ${ids.length} distinct declared family ids exceed the per-run MAX_HANDLED_ID_QUERIES budget (${MAX_HANDLED_ID_QUERIES}); ${droppedIds.length} are treated as not-handled this run (fails toward MORE candidates).\n`,
    );
  }
  budget.remaining = capacity - queryIds.length;
  const handled = new Set();
  for (const id of queryIds) {
    queried.add(id);
    let stdout;
    try {
      stdout = await runGh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--search",
        `"${id}" in:title label:"${SENTRY_TRIAGE_QUEUE_LABEL}"`,
        "--json",
        "number,title,labels",
        "--limit",
        "20",
      ]);
    } catch (err) {
      // Fail-SOFT per id, matching the reverse `in:comments` probe: a transient
      // GitHub/subprocess failure on ONE lookup must not reject the whole call
      // and abort the select job under `set -euo pipefail` — that breaks the
      // "select ALWAYS emits a valid JSON array … never a failure" invariant the
      // workflow header asserts. Treat THIS id as not-handled this run (it stays
      // a candidate — fails toward MORE candidates) and continue so the other ids
      // still resolve. The id is already marked `queried` and budget-spent above,
      // so it is not re-attempted.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `skip handled-id lookup for ${id}: ${message}; treated as not-handled this run (fails toward MORE candidates).\n`,
      );
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = [];
    }
    for (const issue of Array.isArray(parsed) ? parsed : []) {
      const title = issue.title ?? "";
      // Exact-parse fence over GitHub's tokenized search: the parsed short-id
      // AND the parsed project must match this id exactly.
      if (familyKey(parseShortId(title)) !== id) continue;
      if (parseProject(title) !== LOCAL_SENTRY_PROJECT) continue;
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean);
      if (
        labels.includes(FIX_PR_OPENED_LABEL) ||
        labels.includes(FIX_REFUSED_LABEL)
      ) {
        handled.add(id);
        break;
      }
    }
  }
  return [...handled];
}

/** Read a queue stub's title/labels/comments so it can be evaluated in full. */
export async function readStub(runGh, repo, number) {
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

// Ownership fence for the "does our prior autofix PR already exist?" lookup. A
// branch-NAME-only match (`gh pr list --head <branch>`, or a REST `head=<branch>`
// filter WITHOUT the owner qualifier) also returns PRs opened from a FORK, which
// carry their own head branch name. Verified live against a public repo: `gh pr
// list -R cli/cli --head feat/uptime-command --state open --json
// isCrossRepository,headRepositoryOwner` returns
// `{"isCrossRepository":true,"headRepositoryOwner":{"login":"seanturner83"}}`.
// This repo is public, queue-stub titles are public, and `autofixBranchName` is
// deterministic, so ANY GitHub user can fork it, push
// `sentry-autofix/<short-id-lower>`, and open a PR at main. Read as OUR prior fix
// PR, that stub routes to the reconcile path — which comments the attacker's PR
// url onto the queue issue and applies `sentry:fix-pr-opened` (terminal until a
// human clears it) — and the family collapse then stands the whole duplicate
// family down behind it.
//
// `openAutofixPrExists` shuts this at QUERY time with the owner-qualified REST
// head filter `head=<owner>:<branch>`: a fork's head-repo owner differs, so
// GitHub excludes it SERVER-SIDE and there is no page a flood of fork PRs could
// truncate our own row off of. `isOwnHeadPr` re-checks each returned row as
// defense in depth — the head branch is one-to-one with the SHORT-ID only WITHIN
// this repo, so ownership is asserted, not assumed. Both signals must affirm it.

/** True when `pr` is a same-repo PR of `repo` — i.e. one this pipeline could
 * have opened. Reads the REST `GET /repos/{o}/{r}/pulls` shape
 * (`head.repo.fork` / `head.repo.owner.login`), NOT the `gh pr list --json`
 * shape (`isCrossRepository` / `headRepositoryOwner.login`) — the REST endpoint
 * returns neither of those. Fails CLOSED: a missing or unexpected field is "not
 * ours", which costs at most a re-attempt on a branch that already has our PR
 * (`gh pr create` refuses a second one) and never hands an outsider the
 * reconcile write path. */
export function isOwnHeadPr(pr, repo) {
  const owner = String(repo ?? "")
    .split("/")[0]
    .toLowerCase();
  if (!owner) return false;
  const headRepo = pr?.head?.repo;
  return (
    headRepo?.fork === false &&
    String(headRepo?.owner?.login ?? "").toLowerCase() === owner
  );
}

/** True when an OPEN autofix PR already exists for this SHORT-ID — the autofix
 * leg must never open a second fix PR for a Sentry issue that already has one.
 * Matched by the DETERMINISTIC head branch (`sentry-autofix/<short-id-lower>`),
 * NOT by a text search: a free-text `--search "<SHORT-ID>"` matches any open PR
 * whose body/title merely mentions the id (a human PR, a dependency bump, an
 * unrelated fix that cites the Sentry issue), which would both falsely dedup an
 * eligible stub out of selection AND — via the reconcile path — mislabel the
 * stub `sentry:fix-pr-opened` pointing at that unrelated PR. `state=open` only:
 * a merged/closed PR is not a live dedup (a regressed, re-triaged issue must be
 * re-attemptable). The branch name is derived from the shape-validated SHORT-ID
 * and transits `gh` as a query value, so it can't inject.
 *
 * Uses the REST pulls endpoint with the OWNER-QUALIFIED head filter
 * `head=<owner>:<branch>&base=main`, NOT `gh pr list --head <branch>`. Forks
 * share the branch-name namespace (see the note above `isOwnHeadPr`), and `gh pr
 * list --limit N` caps the rows the API returns BEFORE the client-side owner
 * filter runs — so ≥N newer fork PRs on the branch name could push our real,
 * older, same-repo PR off the page and hide it, making the leg open a second PR
 * (or, on the workflow force-push path, clobber a PR already under review). The
 * `head=<owner>:...` qualifier excludes forks SERVER-SIDE, so no page exists to
 * truncate. `&base=main` pins the base the autofix leg always opens against:
 * GitHub's open-PR uniqueness is per head+BASE pair (not head alone), so without
 * it a same-owner PR from this branch to a different base could also return and
 * be mis-picked; with it exactly our autofix PR (if any) comes back — at most one
 * row. `isOwnHeadPr` re-checks each returned row's owner/fork as defense in
 * depth. */
export async function openAutofixPrExists(runGh, repo, shortId) {
  const owner = String(repo ?? "").split("/")[0];
  const branch = autofixBranchName(shortId);
  const stdout = await runGh([
    "api",
    `repos/${repo}/pulls?head=${owner}:${branch}&base=main&state=open`,
  ]);
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : []).some((pr) =>
    isOwnHeadPr(pr, repo),
  );
}
