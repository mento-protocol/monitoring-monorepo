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

import { isValidShortId, parseShortId } from "./sentry-triage-project-core.mjs";
import {
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  PROJECTED_LABEL,
} from "./sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";

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
export async function listHandledShortIds(runGh, repo) {
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
export const HEAD_OWNERSHIP_FIELDS =
  "number,isCrossRepository,headRepositoryOwner";

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
export async function openAutofixPrExists(runGh, repo, shortId) {
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
