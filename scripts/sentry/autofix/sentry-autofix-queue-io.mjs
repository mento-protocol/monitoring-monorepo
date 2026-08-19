/**
 * GitHub I/O layer for the Sentry AUTOFIX selector
 * (scripts/sentry/autofix/sentry-autofix-select.mjs). Extracted from the selector (checklist
 * split-not-append rule: the selector sat above the 600-line soft cap and this
 * leg's family-dedupe work adds ~100 more) so the selector keeps only the pure
 * parse / evaluate / collapse-orchestration / report / CLI layers.
 *
 * `runGh` is injectable so tests drive the full flow with mocked I/O. Nothing
 * here writes: the whole selection step is read-only (the workflow's finalize
 * job owns every write). The exported names are stable — the selector and its
 * tests import them directly, no re-export shim.
 *
 * The handled-FAMILY lookup (`listHandledShortIds` and the per-run budget that
 * bounds it) moved to scripts/sentry/autofix/sentry-autofix-family-handled.mjs when this file
 * reached 583 of the 600-line soft cap. That module imports the queue-stub
 * vocabulary below (`SENTRY_TRIAGE_QUEUE_LABEL`, `LOCAL_SENTRY_PROJECT`,
 * `parseProject`); this one imports nothing from it, so the direction stays
 * one-way and no re-export shim exists to close into a cycle.
 */

import { spawn } from "node:child_process";

import {
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  PROJECTED_LABEL,
} from "../triage/sentry-triage-ingest.mjs";
import { autofixBranchName } from "./sentry-autofix-finalize.mjs";

// The queue-membership label every triage stub carries (the queue contract's
// `LABEL_DEFINITIONS` self-heals it). Both per-id lookups narrow their search to
// it so a random issue that merely quotes a SHORT-ID cannot match. Exported so
// the extracted handled-family lookup (sentry-autofix-family-handled.mjs) and
// the reverse-verify leg (sentry-autofix-reverse-verify.mjs) narrow their
// `in:title` / `in:comments` searches the same way.
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
//
// It is also the HARD upper bound on the selector's evaluation window. `--limit`
// caps what the API RETURNS, and that happens BEFORE
// `MAX_CANDIDATE_EVALUATIONS` (sentry-autofix-select.mjs) slices the returned
// rows — so raising that constant above this one is a strict NO-OP, and the two
// must move together. The invariant is pinned by a test
// (`MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT` in sentry-autofix-select.test.mjs)
// and re-checked at run time by `windowCeilingWarning`, because a silent no-op
// is exactly the failure a "we raised the window" change must not ship as.
// Exported for both.
export const LIST_LIMIT = 200;

// Rate-limit-shaped `gh` failure text. EVERY read the select leg issues is a
// dedupe/blocker signal (a prior fix PR, a terminal sibling's marker, a verdict),
// and every one of them fails SOFT toward MORE candidates — so a rejection the
// caller cannot tell apart from "no blocker found" makes a throttled run open
// DUPLICATE autofix PRs and still look green. These patterns are what `gh`
// actually prints on the wire:
//   - `gh api` surfaces the HTTP status verbatim: `HTTP 403: API rate limit
//     exceeded for user ID 1234. (https://api.github.com/…)`, and
//     `HTTP 403: You have exceeded a secondary rate limit and have been
//     temporarily blocked from content creation.` GitHub also serves plain
//     `HTTP 429 Too Many Requests` on some abuse paths.
//   - `gh issue list --search` routes to GraphQL, whose throttle body reads
//     `GraphQL: API rate limit exceeded for user ID 1234. (rateLimitExceeded)`.
//   - Older/abuse-detection responses read `You have triggered an abuse
//     detection mechanism`.
// Match these against gh's STDERR only, never the rejection message as a whole —
// see `ghFailureText`.
//
// A bare `HTTP 403` that is really a PERMISSIONS failure matches too. That is
// deliberate: both mean "this read did not answer the dedupe question", and the
// only action either warrants is the same one — stop selecting on unreliable
// data. Fail closed, not clever.
const RATE_LIMIT_PATTERNS = [
  /\bHTTP 403\b/,
  /\bHTTP 429\b/,
  /rate limit/i,
  /rateLimitExceeded/i,
  /abuse detection/i,
  /too many requests/i,
];

/** True when a `gh` failure message is rate-limit / throttle shaped — i.e. the
 * read did NOT answer the dedupe question it was issued for, as opposed to
 * answering "no blocker". Pure and exported so the selector can classify a
 * rejection from ANY read without each call site re-implementing the match. */
export function isRateLimitFailure(message) {
  const text = String(message ?? "");
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The text a `gh` rejection should be CLASSIFIED on: gh's own stderr when the
 * rejection carries it, the whole message otherwise.
 *
 * `defaultRunGh` builds its message as `gh <argv> failed with exit N:\n<stderr>`,
 * so classifying the message directly matches the ARGV too — and argv carries
 * agent-authored text. Family ids come from an LLM's `duplicate_of` (charset
 * `[A-Za-z0-9._-]`, so `RATELIMITEXCEEDED` is a legal id) and are interpolated
 * into the `in:title` / `in:comments` searches. A stub declaring such an id would
 * turn ANY unrelated failure of its own probe — 404, 502, ECONNRESET — into a
 * whole-run stand-down. Scoping the match to the stderr half closes that: the
 * rejection carries the raw stderr on `ghStderr`, and only that is classified.
 * Rejections without the property (a spawn error, or a test double throwing a
 * plain Error) fall back to the message, so existing behaviour is unchanged
 * wherever there is no argv to confuse it with.
 */
export function ghFailureText(err) {
  const stderr = err?.ghStderr;
  if (typeof stderr === "string") return stderr;
  return err instanceof Error ? err.message : String(err ?? "");
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
        const err = new Error(
          `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
        );
        // The message keeps the argv (an operator reading the log needs to know
        // WHICH read failed); `ghStderr` carries gh's half alone, because that
        // is the only half `isRateLimitFailure` may be run against. See
        // `ghFailureText`.
        err.ghStderr = stderr;
        reject(err);
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
 *
 * `options.limit` widens that ceiling and `options.skip` drops the oldest N RAW
 * rows before the client-side project filter — the pair the selector's bounded
 * SECOND LOOK uses to reach rows past the first window when the first window
 * selected nothing (see MAX_SECOND_LOOK_EVALUATIONS). `skip` counts RAW rows on
 * purpose: it must line up with the first pass's own `--limit`, which the API
 * applies before any client-side filter, so counting filtered rows would
 * re-read or skip stubs depending on how many the project filter dropped.
 *
 * Returns `{ stubs, rawCount, full }` — `full` is the "is there anything past
 * this page?" signal, taken off the RAW row count. The filtered `stubs` length
 * cannot carry it: the project filter can drop rows, so a genuinely full page
 * can come back short and a second look that keyed on it would never fire.
 *
 * `full` has TWO strengths, and the caller picks by what it does with the answer.
 * By default it is `rawCount >= limit` — "the page came back full, so rows MAY
 * sit past it". That is right for a TRIGGER (being wrong costs one extra list
 * call) and wrong for a CLAIM: at EXACTLY `limit` rows it asserts more remain
 * when nothing does.
 *
 * `options.sentinel` buys the definite answer. The query asks for ONE row past
 * the ceiling, that row is dropped before anything reads or counts it, and
 * `full` becomes "a row beyond the ceiling really did come back". Cost: ONE
 * extra API REQUEST on the calls that opt in, and zero extra `gh` invocations
 * and zero extra per-stub reads — `gh issue list` paginates at 100 rows per
 * request, so a 300-row ask (3 requests) becomes a 301-row ask (4, the last
 * holding just the sentinel). Opt-in for exactly that reason: the second look
 * PUBLISHES its `full` on the operator-facing tracker as the standing regrowth
 * tripwire, so it pays; the first pass only uses `full` to decide whether to
 * take a second look at all, and being conservative there costs one extra list
 * call on a run that already selected nothing — cheaper than the extra request
 * on EVERY run.
 */
export async function listCodeFixStubsPage(runGh, repo, options = {}) {
  const limit =
    Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : LIST_LIMIT;
  const skip =
    Number.isInteger(options.skip) && options.skip > 0 ? options.skip : 0;
  const sentinel = options.sentinel === true;
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
    String(sentinel ? limit + 1 : limit),
  ]);
  const parsed = JSON.parse(stdout);
  const returned = Array.isArray(parsed) ? parsed : [];
  // The sentinel is COUNTED, never used. Trimming it here — before the skip, the
  // project filter and the sort — is what keeps `limit` an honest ceiling: the
  // page still delivers at most `limit` raw rows, so `rawCount`, the evaluable
  // stubs and every per-stub read budget downstream are byte-identical to the
  // same call without it.
  const list = sentinel ? returned.slice(0, limit) : returned;
  const stubs = list
    .slice(skip)
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
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return {
    stubs,
    rawCount: list.length,
    // With the sentinel, `full` is a fact: a row past the ceiling came back.
    // Without it, it is the weaker "the page filled up, so more MAY exist".
    full: sentinel ? returned.length > limit : list.length >= limit,
  };
}

/** The filtered window only — the shape every caller but the second look wants.
 * Thin wrapper over `listCodeFixStubsPage`, kept because it is the name the
 * selector and the suites have always imported. */
export async function listCodeFixStubs(runGh, repo, options = {}) {
  const { stubs } = await listCodeFixStubsPage(runGh, repo, options);
  return stubs;
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
