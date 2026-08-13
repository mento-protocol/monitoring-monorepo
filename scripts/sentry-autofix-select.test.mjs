#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CAP,
  emitVerdict,
  MAX_CANDIDATE_EVALUATIONS,
  MAX_SECOND_LOOK_EVALUATIONS,
  parseArgs,
  SECOND_LOOK_FAMILY_BUDGETS,
  SECOND_LOOK_LIST_ROWS,
  secondLookCeilingWarning,
  selectAutofixCandidates,
  selectAutofixRun,
  SKIP_FIX_SCOPE_ARCHITECTURAL,
  windowCeilingWarning,
  writeReport,
  writeRunReports,
} from "./sentry-autofix-select.mjs";
import {
  AUTOFIX_SELECT_LABEL,
  ghFailureText,
  isOwnHeadPr,
  isRateLimitFailure,
  LIST_LIMIT,
  LOCAL_SENTRY_PROJECT,
  openAutofixPrExists,
} from "./sentry-autofix-queue-io.mjs";
import {
  listHandledShortIds,
  MAX_HANDLED_ID_QUERIES,
} from "./sentry-autofix-family-handled.mjs";
import {
  MAX_REVERSE_PROBE_QUERIES,
  MAX_REVERSE_VERIFY_READS,
  REVERSE_SEARCH_LIMIT,
  reverseVerifyFamilies,
} from "./sentry-autofix-reverse-verify.mjs";
import {
  FIX_SCOPE_ARCHITECTURAL,
  FIX_SCOPE_MECHANICAL,
  isValidShortId,
  MAX_DUPLICATE_LOOKUPS,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
import {
  collapseDuplicateFamilies,
  declaredFamilyIds,
  DEFER_FAMILY_DUPLICATE,
  DEFER_FAMILY_HANDLED,
  MAX_FAMILY_MEMBERS,
} from "./sentry-autofix-family.mjs";
import { resolveFamilies } from "./sentry-autofix-family-resolve.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
} from "./sentry-triage-ingest.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message ?? "mismatch"}: expected ${expected}, got ${actual}`,
    );
  }
}

const BOT = { login: "github-actions" };

/** The `--limit` a window query carried. Both mocks apply it to the rows they
 * return, exactly as the API does — before any client-side filter. */
function windowLimit(args) {
  const i = args.indexOf("--limit");
  return i === -1 ? Infinity : Number(args[i + 1]);
}

/** A `createdAt` for the i-th fixture stub that sorts LEXICOGRAPHICALLY in `i`.
 * The selector sorts the window with `localeCompare`, so the older
 * `00:${i}:00Z` form broke once a fixture passed 60 items (`00:100:00Z` sorts
 * before `00:87:00Z`) — and the window is now MAX_CANDIDATE_EVALUATIONS = 200
 * wide, so every whole-window fixture is past that. Minutes + seconds keep it a
 * real timestamp and correctly ordered up to 3600 stubs. */
function orderedCreatedAt(i, day = "18") {
  const minutes = String(Math.floor(i / 60)).padStart(2, "0");
  const seconds = String(i % 60).padStart(2, "0");
  return `2026-07-${day}T00:${minutes}:${seconds}Z`;
}

/** Build a bot-authored verdict comment for a code-fix stub. `duplicates`
 * renders in the SAME shape the live #1304-family verdicts carry — an inline
 * flow sequence of double-quoted SHORT-IDs.
 *
 * `fixScope` defaults to `mechanical` because after issue #1785 that is the
 * only value the selector acts on, so every fixture a test expects to be
 * SELECTED has to claim it. Pass `null` to omit the line entirely — that is the
 * exact shape of every verdict written before the field existed, including the
 * five real strategy-probe payloads, and it must fail closed to
 * `architectural`. */
function verdictComment({
  affectedRepo = "mento-protocol/monitoring-monorepo",
  verdict = "code-fix",
  createdAt = "2026-07-18T00:00:00Z",
  duplicates = [],
  fixScope = FIX_SCOPE_MECHANICAL,
} = {}) {
  const body = [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict}`,
    "confidence: medium",
    `affected_repo: ${affectedRepo}`,
    "summary: A scoped bug",
    "root_cause: |",
    "  Abstract root cause.",
    "proposed_action: |",
    "  Abstract action.",
    `duplicate_of: [${duplicates.map((id) => `"${id}"`).join(", ")}]`,
    ...(fixScope === null ? [] : [`fix_scope: ${fixScope}`]),
    "```",
    "",
    "Diagnosis prose.",
  ].join("\n");
  return { author: BOT, body, createdAt };
}

/** Stub fixture: title carries the SHORT-ID (queue contract v2). */
function stub({
  number,
  shortId,
  labels = [AUTOFIX_SELECT_LABEL, "sentry-triage"],
  createdAt = "2026-07-18T00:00:00Z",
  comments = [verdictComment()],
} = {}) {
  return {
    number,
    shortId,
    title: `[sentry] ${shortId} (analytics-mento-org, error)`,
    labels,
    createdAt,
    comments,
  };
}

/**
 * Mock `gh`:
 *  - issue list -> the stub summaries (number/title/labels/createdAt)
 *  - issue view -> the full stub (with comments)
 *  - api        -> models `GET repos/<owner>/<repo>/pulls?head=<owner>:<branch>
 *                  &state=open`, the OWNER-QUALIFIED REST head filter the selector
 *                  now uses. A SHORT-ID in `prShortIds` models an OPEN same-repo
 *                  autofix PR (head-repo `fork:false`, owner = repo owner); a
 *                  SHORT-ID in `forkPrShortIds` models a SPOOF fork PR pushed on
 *                  the deterministic `sentry-autofix/<short-id>` branch of this
 *                  public repo (head-repo `fork:true`, owner = "outsider" —
 *                  verified live against cli/cli, where a branch-only `--head`
 *                  match returns a PR with `isCrossRepository: true`). GitHub
 *                  applies the `head=<owner>:<branch>` filter SERVER-SIDE, so the
 *                  handler returns only rows whose head-repo owner equals the
 *                  query owner — a fork (different head owner) is dropped before
 *                  the response, which is the truncation-proof property the fix
 *                  relies on. `isOwnHeadPr` re-checks each returned row as defense
 *                  in depth.
 */
function branchToShortId(branch) {
  return String(branch)
    .replace(/^sentry-autofix\//, "")
    .toUpperCase();
}

/**
 * `handled`: stubs that already carry a TERMINAL autofix marker — the
 * `sentry:fix-pr-opened` / `sentry:fix-refused` siblings the candidate window
 * excludes by construction, which the family collapse reads back through its
 * own per-marker query (issue #1784). Each entry is `{ shortId, label }`, or
 * `{ shortId, labels: [...] }` to carry MORE than one marker — e.g. a terminal
 * marker AND the architectural hold together (#1812 Finding 3).
 */
function makeRunGh({
  stubs = [],
  prShortIds = [],
  forkPrShortIds = [],
  diffBasePrShortIds = [],
  handled = [],
  repo = "o/r",
  openPrError = null,
  handledLookupErrorIds = [],
  // What a failing per-id lookup THROWS. The text is load-bearing now: a
  // rate-limit-shaped message must degrade the run (fail closed), while an
  // ordinary transient must keep its fail-soft behaviour untouched.
  handledLookupErrorMessage = "gh issue list failed with exit 1: API rate limit exceeded",
} = {}) {
  const owner = repo.split("/")[0];
  const calls = [];
  // Handled siblings are stubs the candidate window EXCLUDES (they carry a
  // terminal autofix marker), but which the family collapse still reads back —
  // per declared id via `in:title` (bug C) and via the reverse `in:comments`
  // probe (bug B). Model each as a fully view-readable stub so the fence
  // re-parse runs against a real verdict:
  //   - `declares`   ids in its verdict's duplicate_of (a REAL family edge);
  //   - `mentions`   ids that appear only in a bare comment (a mention the
  //                  fence must REJECT — no verdict edge);
  //   - `matchTitleFor` the id whose `in:title` search surfaces it, defaulting
  //                  to its own short-id; set it to a DIFFERENT id to model
  //                  GitHub's tokenized fuzzy match, which the exact-parse fence
  //                  must drop.
  const handledStubs = handled.map((h, i) => ({
    number: h.number ?? 9000 + i,
    shortId: h.shortId,
    project: h.project ?? "analytics-mento-org",
    // A sibling can carry more than one autofix label — e.g. a terminal marker
    // AND the architectural hold (#1812 Finding 3). `labels` (array) models
    // that; `label` (single) stays for the common one-marker fixtures.
    labelNames: h.labels ?? (h.label == null ? [] : [h.label]),
    declares: h.declares ?? [],
    mentions: h.mentions ?? [],
    matchTitleFor: h.matchTitleFor ?? h.shortId,
  }));
  const handledTitle = (h) => `[sentry] ${h.shortId} (${h.project}, error)`;
  const byNumber = new Map(stubs.map((s) => [String(s.number), s]));
  for (const h of handledStubs) {
    // View-readable: labels carry the terminal marker + the queue label, and the
    // verdict comment declares `declares`, so resolveVerdict sees a real edge.
    byNumber.set(String(h.number), {
      number: h.number,
      title: handledTitle(h),
      labels: [...h.labelNames, "sentry-triage"],
      comments: [verdictComment({ duplicates: h.declares })],
    });
  }
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "list") {
      const searchIdx = args.indexOf("--search");
      const search = searchIdx === -1 ? "" : args[searchIdx + 1];
      // Reverse family probe (bug B): `"<ID>" in:comments`. Return handled stubs
      // whose comments reference the probed id — through a real verdict edge
      // (`declares`) OR a bare mention (`mentions`); the selector's fence
      // re-parse is what decides which becomes an admitted edge.
      const commentsProbe = /"([^"]+)"\s+in:comments/.exec(search);
      if (commentsProbe) {
        const qid = commentsProbe[1].toUpperCase();
        const matched = handledStubs.filter((h) =>
          [...h.declares, ...h.mentions]
            .map((x) => String(x).toUpperCase())
            .includes(qid),
        );
        // GitHub returns at most `--limit` rows BEFORE any client-side filter,
        // so a hit past the page boundary is genuinely unread — model that
        // truncation. The #1810 follow-up raised the reverse probe's `--limit`
        // to REVERSE_SEARCH_LIMIT precisely so a terminal sibling on page 2 is
        // not silently dropped; a suite that ignored `--limit` could never
        // reproduce that miss.
        const limitIdx = args.indexOf("--limit");
        const limit = limitIdx === -1 ? Infinity : Number(args[limitIdx + 1]);
        return JSON.stringify(
          matched.slice(0, limit).map((h) => ({
            number: h.number,
            title: handledTitle(h),
            labels: [...h.labelNames, "sentry-triage"].map((name) => ({
              name,
            })),
          })),
        );
      }
      // Per-declared-id handled lookup (bug C): `"<ID>" in:title`. Return handled
      // stubs the tokenized search would surface for this id.
      const titleProbe = /"([^"]+)"\s+in:title/.exec(search);
      if (titleProbe) {
        const qid = titleProbe[1].toUpperCase();
        // Model a transient GitHub/subprocess failure on ONE id's lookup: the
        // per-id read must fail SOFT (that id treated as not-handled) rather than
        // reject the whole call and abort the select job.
        if (
          handledLookupErrorIds
            .map((x) => String(x).toUpperCase())
            .includes(qid)
        ) {
          throw new Error(handledLookupErrorMessage);
        }
        return JSON.stringify(
          handledStubs
            .filter((h) => String(h.matchTitleFor).toUpperCase() === qid)
            .map((h) => ({
              number: h.number,
              title: handledTitle(h),
              labels: [...h.labelNames, "sentry-triage"].map((name) => ({
                name,
              })),
            })),
        );
      }
      // Candidate window (`sort:created-asc … <slug> in:title`). `--limit` caps
      // what the API RETURNS, before any client-side filter — model that, or a
      // suite can never reproduce the truncation LIST_LIMIT actually imposes,
      // nor the "full page, there may be more" signal the second look keys on.
      return JSON.stringify(
        stubs.slice(0, windowLimit(args)).map((s) => ({
          number: s.number,
          title: s.title,
          createdAt: s.createdAt,
          labels: s.labels.map((name) => ({ name })),
        })),
      );
    }
    if (a0 === "issue" && a1 === "view") {
      const s = byNumber.get(String(args[2]));
      return JSON.stringify({
        number: s.number,
        title: s.title,
        body: "",
        labels: s.labels.map((name) => ({ name })),
        comments: s.comments,
      });
    }
    if (a0 === "api") {
      if (openPrError) throw new Error(openPrError);
      // GET repos/<owner>/<repo>/pulls?head=<owner>:<branch>&base=main&state=open
      // — the owner-qualified REST head filter (never a branch-only `pr list
      // --head`), pinned to the base the autofix leg always opens against.
      const endpoint = String(a1);
      const headMatch = /[?&]head=([^&]+)/.exec(endpoint);
      const headQualifier = headMatch ? headMatch[1] : "";
      const colon = headQualifier.indexOf(":");
      const qOwner = colon === -1 ? "" : headQualifier.slice(0, colon);
      const branch = colon === -1 ? "" : headQualifier.slice(colon + 1);
      const baseMatch = /[?&]base=([^&]+)/.exec(endpoint);
      const qBase = baseMatch ? baseMatch[1] : "";
      const shortId = branch ? branchToShortId(branch) : null;
      // Every PR that exists on this branch NAME — same-repo AND fork, and a
      // same-owner PR to a NON-main base. GitHub applies the head=<owner>:<branch>
      // AND base filters server-side, so only rows whose HEAD-REPO owner equals
      // the query owner AND whose base matches survive; the fork (owner
      // "outsider") and the different-base PR are dropped before the response —
      // the two properties the fix relies on. Rows carry the real REST shape so
      // `isOwnHeadPr` runs for real.
      const allRows = [];
      if (shortId && prShortIds.includes(shortId)) {
        allRows.push({
          number: 1,
          html_url: `https://github.com/${repo}/pull/1`,
          head: { repo: { fork: false, owner: { login: owner } } },
          base: { ref: "main" },
        });
      }
      if (shortId && forkPrShortIds.includes(shortId)) {
        allRows.push({
          number: 99,
          html_url: "https://github.com/outsider/monitoring-monorepo/pull/99",
          head: { repo: { fork: true, owner: { login: "outsider" } } },
          base: { ref: "main" },
        });
      }
      if (shortId && diffBasePrShortIds.includes(shortId)) {
        allRows.push({
          number: 77,
          html_url: `https://github.com/${repo}/pull/77`,
          head: { repo: { fork: false, owner: { login: owner } } },
          base: { ref: "release-candidate" },
        });
      }
      const rows = allRows.filter(
        (r) =>
          String(r.head.repo.owner.login).toLowerCase() ===
            qOwner.toLowerCase() &&
          (qBase === "" || String(r.base?.ref ?? "") === qBase),
      );
      return JSON.stringify(rows);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

await test("selects oldest local code-fix stubs, capped", async () => {
  const stubs = [
    stub({
      number: 10,
      shortId: "APP-MENTO-ORG-2S",
      createdAt: "2026-07-10T00:00:00Z",
    }),
    stub({
      number: 11,
      shortId: "APP-MENTO-ORG-3T",
      createdAt: "2026-07-11T00:00:00Z",
    }),
    stub({
      number: 12,
      shortId: "APP-MENTO-ORG-4U",
      createdAt: "2026-07-12T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 10, shortId: "APP-MENTO-ORG-2S" },
    { issue: 11, shortId: "APP-MENTO-ORG-3T" },
  ]);
});

await test("batch list excludes handled AND projected stubs server-side", async () => {
  const stubs = [stub({ number: 30, shortId: "APP-MENTO-ORG-6W" })];
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r", cap: 2 }, { runGh });
  const listCall = calls.find((c) => c[0] === "issue" && c[1] === "list");
  const search = listCall[listCall.indexOf("--search") + 1];
  // The window cap (--limit) applies BEFORE any client-side filter, so every
  // terminal/external state must be excluded in the server-side query or an
  // accumulating backlog would starve newer local candidates out of the window.
  for (const excluded of [
    '-label:"sentry:fix-pr-opened"',
    '-label:"sentry:fix-refused"',
    '-label:"sentry:projected"',
    // An archived Sentry issue was deliberately silenced by the archive loop,
    // so it must not consume an autofix run — and nothing else ever removes it
    // from this window, so it would otherwise cost a full `issue view` on every
    // run forever. A regression sheds `sentry:archived` (REOPEN_SHED_LABELS)
    // along with the verdict label, which is what makes the stub a candidate
    // again.
    '-label:"sentry:archived"',
  ]) {
    assert(search.includes(excluded), `search must contain ${excluded}`);
  }
  // Projected-label exclusion alone is not enough: the projection no-token path
  // closes external stubs while KEEPING the verdict label and WITHOUT adding
  // sentry:projected, so the window must also restrict to this project by title.
  assert(
    search.includes("analytics-mento-org in:title"),
    `search must restrict the window to the local project by title, got: ${search}`,
  );
});

await test("skips a stub already labeled sentry:fix-pr-opened", async () => {
  const stubs = [
    stub({
      number: 20,
      shortId: "APP-MENTO-ORG-5V",
      labels: [AUTOFIX_SELECT_LABEL, FIX_PR_OPENED_LABEL],
    }),
    stub({
      number: 21,
      shortId: "APP-MENTO-ORG-6W",
      createdAt: "2026-07-19T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 21, shortId: "APP-MENTO-ORG-6W" }]);
});

await test("emits a RECONCILE entry when an OPEN autofix PR exists but the stub lacks its marker", async () => {
  // Orphan: the stub reaches the PR check without either terminal marker (they
  // are filtered earlier), so an open PR on its autofix branch means a prior
  // run opened the PR but its queue comment/label write did not land. The
  // selector must route it to no-agent reconciliation, NOT silently drop it
  // (which would leave the queue side-effects permanently unrepaired).
  const stubs = [stub({ number: 30, shortId: "APP-MENTO-ORG-7X" })];
  const { runGh, calls } = makeRunGh({
    stubs,
    prShortIds: ["APP-MENTO-ORG-7X"],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [
    { issue: 30, shortId: "APP-MENTO-ORG-7X", reconcile: true },
  ]);
  // The dedup must query the OWNER-QUALIFIED REST head filter, scoped to OPEN
  // PRs (a merged/closed PR must not strand a regressed stub) on the
  // DETERMINISTIC head branch — never a free-text search an unrelated PR citing
  // the id could satisfy, and never a branch-only `gh pr list` a fork flood
  // could truncate.
  const apiCall = calls.find((c) => c[0] === "api");
  assert(apiCall, "the open-PR dedup was queried via gh api (REST)");
  assert(
    !calls.some((c) => c[0] === "pr" && c[1] === "list"),
    "must NOT use the fork-truncatable `gh pr list --head`",
  );
  const endpoint = apiCall[1];
  assert(
    endpoint.includes("repos/o/r/pulls"),
    `must hit the REST pulls endpoint, got ${endpoint}`,
  );
  assert(
    endpoint.includes("head=o:sentry-autofix/app-mento-org-7x"),
    `must owner-qualify the deterministic head branch, got ${endpoint}`,
  );
  assert(
    endpoint.includes("base=main"),
    `must pin base=main (GitHub PR uniqueness is per head+base), got ${endpoint}`,
  );
  assert(
    endpoint.includes("state=open"),
    `must scope to open PRs, got ${endpoint}`,
  );
});

await test("a FORK PR on the autofix branch name is not ours: no reconcile, the stub stays fixable", async () => {
  // A branch-NAME-only match returns fork PRs (they carry their own head
  // branch) — verified live: `gh pr list -R cli/cli --head feat/uptime-command
  // --state open` returns a PR with `isCrossRepository: true` owned by an
  // unrelated user. This repo is public, queue-stub titles are public, and
  // `sentry-autofix/<short-id-lower>` is deterministic, so anyone can produce
  // this row. Reading it as our prior fix PR hands an outsider the reconcile
  // write path — a comment carrying their PR url onto the queue issue plus the
  // terminal `sentry:fix-pr-opened` marker, until a human clears it — and the
  // family collapse then stands the whole family down behind that marker. The
  // owner-qualified `head=<owner>:<branch>` filter excludes the fork SERVER-SIDE
  // (its head-repo owner differs), so the query returns nothing.
  const stubs = [stub({ number: 40, shortId: "APP-MENTO-ORG-9Z" })];
  const { runGh, calls } = makeRunGh({
    stubs,
    forkPrShortIds: ["APP-MENTO-ORG-9Z"],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 40, shortId: "APP-MENTO-ORG-9Z" }]);
  assert(
    !("reconcile" in selected[0]),
    "a fork PR must not route the stub to the reconcile write path",
  );
  // The query must be owner-qualified — that is what excludes the fork before
  // any row is returned; a branch-only query would surface it.
  const apiCall = calls.find((c) => c[0] === "api");
  assert(apiCall, "the open-PR dedup was queried via gh api");
  assert(
    apiCall[1].includes("head=o:sentry-autofix/app-mento-org-9z"),
    `pr query must owner-qualify the head branch, got ${apiCall[1]}`,
  );
});

await test("a spoofed fork PR cannot hide our real one behind it", async () => {
  // The old query paged `gh pr list --head <branch> --limit N`, capping the rows
  // BEFORE the client-side owner filter — so newer fork PRs sharing the branch
  // name could fill the page, the fence would report "no PR of ours", the leg
  // would open a second PR (or force-push over a live one), and the orphaned
  // stub would never be reconciled. The owner-qualified `head=<owner>:<branch>`
  // filter excludes forks server-side, so however many fork PRs exist, only our
  // same-repo PR enters the result set and is picked out.
  const stubs = [stub({ number: 41, shortId: "APP-MENTO-ORG-1A" })];
  const { runGh, calls } = makeRunGh({
    stubs,
    forkPrShortIds: ["APP-MENTO-ORG-1A"],
    prShortIds: ["APP-MENTO-ORG-1A"],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [
    { issue: 41, shortId: "APP-MENTO-ORG-1A", reconcile: true },
  ]);
  // No client-side row cap can be the safety mechanism: the query must be
  // owner-qualified so forks never enter the result set to begin with.
  const apiCall = calls.find((c) => c[0] === "api");
  assert(
    apiCall && apiCall[1].includes("head=o:sentry-autofix/app-mento-org-1a"),
    "the dedup must owner-qualify the head branch, not page a branch-only list",
  );
});

await test("a same-owner PR from the autofix branch to a DIFFERENT base is not our autofix PR (base=main pins it)", async () => {
  // GitHub's open-PR uniqueness is per head+base, so a same-repo, same-owner PR
  // can share the deterministic autofix branch while targeting a non-main base
  // (a human could open one). Without `base=main` the query would return it and
  // the leg could mis-relink/dedup against it; with `base=main` the server-side
  // base filter drops it, so the stub stays fixable and no reconcile fires.
  const stubs = [stub({ number: 42, shortId: "APP-MENTO-ORG-2B" })];
  const { runGh, calls } = makeRunGh({
    stubs,
    diffBasePrShortIds: ["APP-MENTO-ORG-2B"],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 42, shortId: "APP-MENTO-ORG-2B" }]);
  assert(
    !("reconcile" in selected[0]),
    "a different-base PR must not route the stub to reconcile",
  );
  const apiCall = calls.find((c) => c[0] === "api");
  assert(
    apiCall && apiCall[1].includes("base=main"),
    "the query must pin base=main so a different-base PR is excluded server-side",
  );
});

await test("isOwnHeadPr fails CLOSED on a missing or mismatched head owner (REST shape)", () => {
  // Reads the REST pulls shape (`head.repo.fork` / `head.repo.owner.login`), NOT
  // the `gh pr list --json` `isCrossRepository`/`headRepositoryOwner` shape the
  // REST endpoint does not return.
  const ours = {
    head: { repo: { fork: false, owner: { login: "Mento-Protocol" } } },
  };
  assertEqual(
    isOwnHeadPr(ours, "mento-protocol/monitoring-monorepo"),
    true,
    "owner comparison is case-insensitive",
  );
  for (const [label, pr] of [
    [
      "fork",
      { head: { repo: { fork: true, owner: { login: "mento-protocol" } } } },
    ],
    [
      "owner mismatch",
      { head: { repo: { fork: false, owner: { login: "x" } } } },
    ],
    ["no owner field", { head: { repo: { fork: false } } }],
    [
      "no fork field",
      { head: { repo: { owner: { login: "mento-protocol" } } } },
    ],
    ["no head repo", { head: {} }],
    ["no head", {}],
    ["null row", null],
    // The OLD `gh pr list --json` shape must NOT read as ours under the REST
    // fence — it has no `head.repo`, so both signals are absent (fail closed).
    [
      "legacy pr-list shape",
      {
        isCrossRepository: false,
        headRepositoryOwner: { login: "mento-protocol" },
      },
    ],
  ]) {
    assertEqual(
      isOwnHeadPr(pr, "mento-protocol/monitoring-monorepo"),
      false,
      `${label} must not read as ours`,
    );
  }
  assertEqual(isOwnHeadPr(ours, ""), false, "an unparsable repo is not ours");
});

await test("openAutofixPrExists queries the owner-qualified REST head filter, not a fork-truncatable list", async () => {
  // QUERY SHAPE + NEGATIVE CONTROL, exercising the LIVE function so the args it
  // passes to the runner are the real ones. Reverting it to the branch-only `gh
  // pr list --head <branch> --limit N` (which a flood of fork PRs can truncate)
  // makes no `api` call, so `verb === "api"` fails — the invariant is that a real
  // same-repo PR can never be hidden behind fork rows because forks are excluded
  // SERVER-SIDE at query time, with no client-side page to fill.
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return JSON.stringify([
      { html_url: "x", head: { repo: { fork: false, owner: { login: "o" } } } },
    ]);
  };
  const result = await openAutofixPrExists(runGh, "o/r", "APP-MENTO-ORG-7X");
  assertEqual(result, true, "a same-repo open PR row is ours");
  assertEqual(calls.length, 1, "exactly one lookup call");
  const [verb, endpoint] = calls[0];
  assertEqual(verb, "api", "must use `gh api` (REST), not `gh pr list`");
  assert(
    endpoint.includes("repos/o/r/pulls"),
    `must hit the REST pulls endpoint, got ${endpoint}`,
  );
  assert(
    endpoint.includes("head=o:sentry-autofix/app-mento-org-7x"),
    `must owner-qualify the head branch (head=<owner>:<branch>), got ${endpoint}`,
  );
  assert(
    endpoint.includes("base=main"),
    `must pin base=main (per head+base uniqueness), got ${endpoint}`,
  );
  assert(
    endpoint.includes("state=open"),
    `must scope to open, got ${endpoint}`,
  );
  // The truncation vector is gone: no branch-only list, no client-side row cap.
  assert(
    !calls.some((c) => c[0] === "pr" && c[1] === "list"),
    "must not fall back to `gh pr list`",
  );
  assert(
    !calls[0].includes("--limit"),
    "must not rely on a client-side row cap the fix removed",
  );
});

await test("openAutofixPrExists returns false when the owner-qualified query is empty", async () => {
  const runGh = async () => JSON.stringify([]);
  assertEqual(
    await openAutofixPrExists(runGh, "o/r", "APP-MENTO-ORG-7X"),
    false,
    "no rows -> no open autofix PR of ours",
  );
});

await test("openAutofixPrExists rejects fork / owner-mismatch / malformed rows as defense in depth", async () => {
  // The owner-qualified query already excludes forks server-side, but the
  // client-side fence must still reject anything that slips through — a fork row,
  // an owner mismatch, or a malformed head. Each is "not ours", so the function
  // returns false even though a row came back.
  for (const rows of [
    [{ head: { repo: { fork: true, owner: { login: "o" } } } }],
    [{ head: { repo: { fork: false, owner: { login: "outsider" } } } }],
    [{ head: { repo: { fork: false } } }],
    [{ head: {} }],
    [{}],
  ]) {
    const runGh = async () => JSON.stringify(rows);
    assertEqual(
      await openAutofixPrExists(runGh, "o/r", "APP-MENTO-ORG-7X"),
      false,
      `defense-in-depth must drop ${JSON.stringify(rows)}`,
    );
  }
  // A genuine same-repo, non-fork, owner-matching row IS ours.
  const ok = async () =>
    JSON.stringify([
      { head: { repo: { fork: false, owner: { login: "o" } } } },
    ]);
  assertEqual(
    await openAutofixPrExists(ok, "o/r", "APP-MENTO-ORG-7X"),
    true,
    "a same-repo, non-fork, owner-matching row is ours",
  );
});

await test("a transient open-PR read failure skips ONE stub, never the whole leg", async () => {
  // This read is issued once per surviving stub — a whole-window count now, not
  // a capped one. It sat outside the fail-soft try/catch that covers the stub
  // read, so one `gh` rejection rejected out of the selector, exited nonzero and
  // failed the select step under `set -euo pipefail` — breaking the workflow
  // header's "ALWAYS emits a valid JSON array … never a failure" invariant.
  //
  // The message is deliberately NOT rate-limit shaped: a throttled read is a
  // different failure class that must fail CLOSED for the whole run (see the
  // degraded-run tests below), and this one pins that ordinary transients keep
  // their per-stub fail-soft behaviour.
  const stubs = [stub({ number: 42, shortId: "APP-MENTO-ORG-2B" })];
  const { runGh } = makeRunGh({
    stubs,
    openPrError: "gh api repos/o/r/pulls failed with exit 1: read ECONNRESET",
  });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertEqual(
    truncations.rateLimited,
    0,
    "an ordinary transient must NOT degrade the run",
  );
});

await test("a normal (non-orphan) selection carries no reconcile flag", async () => {
  const stubs = [stub({ number: 31, shortId: "APP-MENTO-ORG-8Y" })];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 31, shortId: "APP-MENTO-ORG-8Y" }]);
  assert(
    !("reconcile" in selected[0]),
    "a real fix entry must not carry a reconcile flag",
  );
});

await test("skips a stub already labeled sentry:fix-refused (retry needs a human)", async () => {
  const stubs = [
    stub({
      number: 32,
      shortId: "APP-MENTO-ORG-7Y",
      labels: [AUTOFIX_SELECT_LABEL, FIX_REFUSED_LABEL],
    }),
    stub({
      number: 33,
      shortId: "APP-MENTO-ORG-7Z",
      createdAt: "2026-07-22T00:00:00Z",
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 33, shortId: "APP-MENTO-ORG-7Z" }]);
  // Deduped by label before any PR query for the refused stub.
  assert(
    !calls.some(
      (c) => c[0] === "issue" && c[1] === "view" && String(c[2]) === "32",
    ),
    "refused stub should never be view-read",
  );
});

await test("skips a stub whose verdict targets an external owning repo", async () => {
  const stubs = [
    stub({
      number: 40,
      shortId: "APP-MENTO-ORG-8Y",
      comments: [
        verdictComment({ affectedRepo: "mento-protocol/frontend-monorepo" }),
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("skips a stub with an unrecognized affected_repo (not confidently local)", async () => {
  const stubs = [
    stub({
      number: 45,
      shortId: "APP-MENTO-ORG-9Z",
      comments: [verdictComment({ affectedRepo: "totally/unknown" })],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("emits the verdict-comment generation token when present (#1506)", async () => {
  const stubs = [
    stub({
      number: 22,
      shortId: "APP-MENTO-ORG-7T",
      comments: [
        {
          ...verdictComment(),
          url: "https://github.com/o/r/issues/22#issuecomment-9012",
        },
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [
    { issue: 22, shortId: "APP-MENTO-ORG-7T", verdictCommentId: "9012" },
  ]);
});

await test("falls back to no token when the verdict comment url is unparsable (#1506)", async () => {
  const stubs = [
    stub({
      number: 23,
      shortId: "APP-MENTO-ORG-7U",
      // url without a #issuecomment anchor → no derivable token
      comments: [
        { ...verdictComment(), url: "https://github.com/o/r/issues/23" },
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 23, shortId: "APP-MENTO-ORG-7U" }]);
});

await test("skips a stub whose verdict comment is missing/invalid (fail-soft, no throw)", async () => {
  const stubs = [
    stub({ number: 50, shortId: "APP-MENTO-ORG-AA", comments: [] }),
    stub({
      number: 51,
      shortId: "APP-MENTO-ORG-BB",
      createdAt: "2026-07-20T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 51, shortId: "APP-MENTO-ORG-BB" }]);
});

await test("skips a stub whose title has no parseable SHORT-ID", async () => {
  const bad = stub({ number: 60, shortId: "IGNORED" });
  bad.title = "not a queue title";
  const { runGh } = makeRunGh({ stubs: [bad] });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("only queries PRs after cheaper checks pass (no wasted open-PR read)", async () => {
  const stubs = [
    stub({
      number: 70,
      shortId: "APP-MENTO-ORG-CC",
      labels: [AUTOFIX_SELECT_LABEL, FIX_PR_OPENED_LABEL],
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assert(
    !calls.some((c) => c[0] === "api") &&
      !calls.some((c) => c[0] === "pr" && c[1] === "list"),
    "should not query the open-PR REST endpoint for a stub already deduped by label",
  );
});

await test("batch list pre-filters out non-local Sentry projects by title", async () => {
  const external = stub({ number: 82, shortId: "APP-MENTO-ORG-GG" });
  external.title = "[sentry] APP-MENTO-ORG-GG (app-mento-org, error)";
  const local = stub({
    number: 83,
    shortId: "ANALYTICS-MENTO-ORG-HH",
    createdAt: "2026-07-21T00:00:00Z",
  });
  const { runGh, calls } = makeRunGh({ stubs: [external, local] });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 83, shortId: "ANALYTICS-MENTO-ORG-HH" }]);
  // The external stub was dropped before any per-candidate verdict read.
  assert(
    !calls.some(
      (c) => c[0] === "issue" && c[1] === "view" && String(c[2]) === "82",
    ),
    "external-project stub should never be view-read",
  );
});

await test("single-issue live run evaluates only that issue through the filters", async () => {
  const stubs = [
    stub({ number: 80, shortId: "APP-MENTO-ORG-DD" }),
    stub({ number: 81, shortId: "APP-MENTO-ORG-EE" }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", issue: 81 },
    { runGh },
  );
  assertDeepEqual(selected, [{ issue: 81, shortId: "APP-MENTO-ORG-EE" }]);
});

await test("single-issue live run rejects an ineligible issue (external repo)", async () => {
  const stubs = [
    stub({
      number: 90,
      shortId: "APP-MENTO-ORG-FF",
      comments: [
        verdictComment({ affectedRepo: "mento-protocol/minipay-dapp" }),
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", issue: 90 },
    { runGh },
  );
  assertDeepEqual(selected, []);
});

await test("emitVerdict returns the trusted fence-selected verdict body", async () => {
  const s = stub({ number: 95, shortId: "APP-MENTO-ORG-KK" });
  const { runGh } = makeRunGh({ stubs: [s] });
  const body = await emitVerdict({ repo: "o/r", issue: 95 }, { runGh });
  assert(
    body.includes("affected_repo: mento-protocol/monitoring-monorepo"),
    "verdict body emitted",
  );
});

await test("emitVerdict throws when no trusted verdict comment exists", async () => {
  const s = stub({ number: 96, shortId: "APP-MENTO-ORG-LL", comments: [] });
  const { runGh } = makeRunGh({ stubs: [s] });
  let threw = false;
  try {
    await emitVerdict({ repo: "o/r", issue: 96 }, { runGh });
  } catch {
    threw = true;
  }
  assert(threw, "no-verdict throws");
});

await test("parseArgs defaults and validation", () => {
  const defaults = parseArgs([]);
  assert(defaults.cap === DEFAULT_CAP, "cap defaults");
  const custom = parseArgs(["--repo", "o/r", "--cap", "5"]);
  assert(custom.repo === "o/r" && custom.cap === 5, "custom args parse");
  let threw = false;
  try {
    parseArgs(["--cap", "0"]);
  } catch {
    threw = true;
  }
  assert(threw, "--cap 0 rejected");
  assertEqual(defaults.deferredOut, null, "no deferral report by default");
  assertEqual(
    parseArgs(["--deferred-out", "/tmp/d.json"]).deferredOut,
    "/tmp/d.json",
  );
  let missingValue = false;
  try {
    parseArgs(["--deferred-out"]);
  } catch {
    missingValue = true;
  }
  assert(missingValue, "--deferred-out requires a path");
  assertEqual(defaults.windowOut, null, "no window report by default");
  assertEqual(
    parseArgs(["--window-out", "/tmp/w.json"]).windowOut,
    "/tmp/w.json",
  );
});

// ---------------------------------------------------------------------------
// duplicate_of FAMILY collapse (issue #1784).
//
// OLD PATH FIRST: every test above drives an EMPTY `duplicate_of`, so the whole
// pre-#1784 contract (ordering, cap, starvation guard, reconcile, dedup,
// generation token, single-issue dispatch) is already pinned through the
// production entry point against the rerouted code. The two tests immediately
// below pin the parts of that contract the collapse could plausibly perturb:
// the gh call profile, and the interaction with the other filters.
// ---------------------------------------------------------------------------

// The REAL #1304 family (analytics-mento-org, 2026-07-16). Directional by
// construction: 2E's verdict lists SIX duplicates, and each of the others lists
// only 2E. Note MAX_DUPLICATE_LOOKUPS (5) truncates 2E's six-entry list, so 2B
// is reachable ONLY through its own back-pointer.
const FAMILY_2E_DUPLICATES = [
  "ANALYTICS-MENTO-ORG-2F",
  "ANALYTICS-MENTO-ORG-29",
  "ANALYTICS-MENTO-ORG-2A",
  "ANALYTICS-MENTO-ORG-2D",
  "ANALYTICS-MENTO-ORG-2C",
  "ANALYTICS-MENTO-ORG-2B",
];

/** One member of the real family: `[sentry] <SHORT-ID>` with the verdict that
 * member actually carried. `fixScope` is threaded so the collapse tests can run
 * on selectable (`mechanical`) members while the #1785 tests below replay the
 * payloads verbatim, `fix_scope` line and all — i.e. absent. */
function familyStub(
  number,
  shortId,
  createdAt,
  duplicates,
  fixScope = FIX_SCOPE_MECHANICAL,
) {
  return stub({
    number,
    shortId,
    createdAt,
    comments: [verdictComment({ createdAt, duplicates, fixScope })],
  });
}

/** The anchor (#1304 / ANALYTICS-MENTO-ORG-2E) plus its five back-pointing
 * siblings, in the order the queue created them. */
function realFamilyStubs(fixScope = FIX_SCOPE_MECHANICAL) {
  return [
    familyStub(
      1304,
      "ANALYTICS-MENTO-ORG-2E",
      "2026-07-16T17:27:24Z",
      FAMILY_2E_DUPLICATES,
      fixScope,
    ),
    familyStub(
      1313,
      "ANALYTICS-MENTO-ORG-2F",
      "2026-07-16T17:27:37Z",
      ["ANALYTICS-MENTO-ORG-2E"],
      fixScope,
    ),
    familyStub(
      1316,
      "ANALYTICS-MENTO-ORG-29",
      "2026-07-16T17:27:41Z",
      ["ANALYTICS-MENTO-ORG-2E"],
      fixScope,
    ),
    familyStub(
      1326,
      "ANALYTICS-MENTO-ORG-2A",
      "2026-07-16T17:27:54Z",
      ["ANALYTICS-MENTO-ORG-2E"],
      fixScope,
    ),
    familyStub(
      1328,
      "ANALYTICS-MENTO-ORG-2D",
      "2026-07-16T17:27:56Z",
      ["ANALYTICS-MENTO-ORG-2E"],
      fixScope,
    ),
  ];
}

/** The four siblings WITHOUT the anchor — the shape the window actually has on
 * the run after 2E was handled: four stubs joined only through an id that is
 * not itself a candidate. */
function orphanedFamilyStubs(fixScope = FIX_SCOPE_MECHANICAL) {
  return realFamilyStubs(fixScope).slice(1);
}

await test("OLD PATH: with no duplicate_of, selection order, cap and the gh call profile are unchanged", async () => {
  const stubs = [
    stub({
      number: 10,
      shortId: "APP-MENTO-ORG-2S",
      createdAt: "2026-07-10T00:00:00Z",
    }),
    stub({
      number: 11,
      shortId: "APP-MENTO-ORG-3T",
      createdAt: "2026-07-11T00:00:00Z",
    }),
    stub({
      number: 12,
      shortId: "APP-MENTO-ORG-4U",
      createdAt: "2026-07-12T00:00:00Z",
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 10, shortId: "APP-MENTO-ORG-2S" },
    { issue: 11, shortId: "APP-MENTO-ORG-3T" },
  ]);
  // No candidate declares a family, so the collapse must not issue its
  // handled-sibling reads at all: exactly the ONE candidate-window list call.
  const lists = calls.filter((c) => c[0] === "issue" && c[1] === "list");
  assertEqual(lists.length, 1, "exactly one issue list call");
  // Count the reads the rerouted loop actually changed. Family collapse needs
  // the WHOLE evaluated window before it can decide, so the per-stub reads are
  // no longer capped at `cap` — assert the exact profile rather than a claim
  // these assertions cannot see. An earlier version of this test checked only
  // `lists.length`, which stays 1 under an arbitrarily large read
  // amplification, so the one regression guard offered for this path was blind
  // to the regression the path took.
  assertDeepEqual(
    calls
      .filter((c) => c[0] === "issue" && c[1] === "view")
      .map((c) => Number(c[2])),
    [10, 11, 12],
  );
  assertEqual(
    calls.filter((c) => c[0] === "api").length,
    3,
    "one open-PR read per surviving stub",
  );
});

await test("the per-run read budget bounds the window, keeping the OLDEST stubs", async () => {
  // Deferral writes nothing, so a collapsed family leaves permanent window
  // residents that are re-read every run; the window only grows, and every
  // evaluation is a sequential `gh` subprocess inside a 5-minute job. Bound the
  // READ, not the selection — and truncate the NEWEST tail, since the oldest
  // candidates are the ones `sort:created-asc` protects.
  const stubs = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS + 12; i += 1) {
    stubs.push(
      stub({
        number: 3000 + i,
        shortId: `APP-MENTO-ORG-${i}`,
        createdAt: orderedCreatedAt(i),
      }),
    );
  }
  const { runGh, calls } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 3000, shortId: "APP-MENTO-ORG-0" },
    { issue: 3001, shortId: "APP-MENTO-ORG-1" },
  ]);
  const views = calls.filter((c) => c[0] === "issue" && c[1] === "view");
  assertEqual(
    views.length,
    MAX_CANDIDATE_EVALUATIONS,
    "reads are capped by the budget, not by the window",
  );
  assertEqual(Number(views[0][2]), 3000, "the budget keeps the oldest stub");
  assertEqual(
    Number(views[views.length - 1][2]),
    3000 + MAX_CANDIDATE_EVALUATIONS - 1,
    "the budget drops the newest tail",
  );
});

await test("OLD PATH: with no duplicate_of, the label dedup and the external-repo gate still filter first", async () => {
  const stubs = [
    stub({
      number: 200,
      shortId: "APP-MENTO-ORG-AA",
      labels: [AUTOFIX_SELECT_LABEL, FIX_REFUSED_LABEL],
      createdAt: "2026-07-10T00:00:00Z",
    }),
    stub({
      number: 201,
      shortId: "APP-MENTO-ORG-BB",
      createdAt: "2026-07-11T00:00:00Z",
      comments: [
        verdictComment({ affectedRepo: "mento-protocol/minipay-dapp" }),
      ],
    }),
    stub({
      number: 202,
      shortId: "APP-MENTO-ORG-CC",
      createdAt: "2026-07-12T00:00:00Z",
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 202, shortId: "APP-MENTO-ORG-CC" }]);
  const lists = calls.filter((c) => c[0] === "issue" && c[1] === "list");
  assertEqual(lists.length, 1, "no family queries without a family signal");
});

await test("the real #1304 family consumes ONE autofix run, on the stub the others point at", async () => {
  const { runGh } = makeRunGh({ stubs: realFamilyStubs() });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // Five stubs, one root cause, one candidate — and the representative is 2E
  // (in-degree 4), not merely the oldest.
  assertDeepEqual(selected, [
    { issue: 1304, shortId: "ANALYTICS-MENTO-ORG-2E" },
  ]);
});

await test("the family graph is collapsed TRANSITIVELY, so one direction cannot split it", async () => {
  // 2B sits past MAX_DUPLICATE_LOOKUPS in 2E's six-entry list, so following 2E's
  // declared duplicates alone never reaches it; its own back-pointer does.
  // Following either direction in isolation yields two candidates, not one.
  const stubs = [
    ...realFamilyStubs(),
    familyStub(1330, "ANALYTICS-MENTO-ORG-2B", "2026-07-16T17:28:10Z", [
      "ANALYTICS-MENTO-ORG-2E",
    ]),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 1304, shortId: "ANALYTICS-MENTO-ORG-2E" },
  ]);
});

await test("siblings joined only through a NON-candidate id are still one family", async () => {
  // The anchor is not in the window (it carries no marker here — it simply is
  // not a candidate). The four siblings share no declared id with each other,
  // only with 2E, so nothing but a transitive union over ids can join them.
  const { runGh } = makeRunGh({ stubs: orphanedFamilyStubs() });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // No member has in-degree from a candidate, so the tie falls back to oldest.
  assertDeepEqual(selected, [
    { issue: 1313, shortId: "ANALYTICS-MENTO-ORG-2F" },
  ]);
});

await test("a REFUSED representative does not hand the family back member-by-member", async () => {
  // The exact path the only real data took: 2E ends sentry:fix-refused, which
  // takes it OUT of the candidate window, leaving its four siblings. Pre-#1784
  // that spent four more runs on one root cause.
  const { runGh } = makeRunGh({
    stubs: orphanedFamilyStubs(),
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-2E", label: FIX_REFUSED_LABEL }],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, []);
});

await test("a fully-deferred run REPORTS its deferrals, so it cannot read as an empty queue", async () => {
  // Deferral writes nothing to the queue, so before this the only trace was a
  // stderr line in a 90-day workflow log: a run that suppressed its whole
  // window rendered on the tracker as `State: active, Candidates selected: 0` —
  // byte-identical to "nothing was queued". That is the ADR 0036 observability
  // invariant inverted, and it left the documented single-issue dispatch
  // override unusable because nobody could tell which issue to name.
  const { runGh } = makeRunGh({
    stubs: orphanedFamilyStubs(),
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-2E", label: FIX_REFUSED_LABEL }],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [
    { issue: 1313, reason: DEFER_FAMILY_HANDLED },
    { issue: 1316, reason: DEFER_FAMILY_HANDLED },
    { issue: 1326, reason: DEFER_FAMILY_HANDLED },
    { issue: 1328, reason: DEFER_FAMILY_HANDLED },
  ]);
  // The reason is a closed enum from the collapse module, never agent text.
  for (const row of deferred) {
    assert(
      Number.isInteger(row.issue) && row.issue > 0,
      "issue numbers come from GitHub, not from duplicate_of",
    );
  }
});

await test("a partially-deferred run reports the members the representative displaced", async () => {
  const { runGh } = makeRunGh({ stubs: realFamilyStubs() });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [
    { issue: 1304, shortId: "ANALYTICS-MENTO-ORG-2E" },
  ]);
  assertDeepEqual(
    deferred.map((d) => d.issue),
    [1313, 1316, 1326, 1328],
  );
  assertEqual(deferred[0].reason, DEFER_FAMILY_DUPLICATE);
});

await test("a run with nothing to collapse reports no deferrals", async () => {
  const { runGh } = makeRunGh({
    stubs: [stub({ number: 50, shortId: "APP-MENTO-ORG-3C" })],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertEqual(entries.length, 1);
  assertDeepEqual(deferred, []);
});

await test("a family whose representative already has a fix PR opens no second one", async () => {
  const { runGh } = makeRunGh({
    stubs: orphanedFamilyStubs(),
    handled: [
      { shortId: "ANALYTICS-MENTO-ORG-2E", label: FIX_PR_OPENED_LABEL },
    ],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("a family-handled deferral lifts exactly when the blocking marker is shed", async () => {
  // Scoped deliberately: this proves the REGRESSION branch, and that is the
  // only branch that lifts a DEFER_FAMILY_HANDLED block. A blocker that was
  // fixed and stayed fixed, or refused and stayed quiet, keeps blocking — which
  // is why the run record now carries the deferred count and issue numbers.
  // Run A: 2E is refused, so the whole family stands down.
  const blocked = makeRunGh({
    stubs: orphanedFamilyStubs(),
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-2E", label: FIX_REFUSED_LABEL }],
  });
  assertDeepEqual(
    await selectAutofixCandidates({ repo: "o/r", cap: 2 }, blocked),
    [],
  );
  // Deferral must persist NOTHING on the deferred stubs — the selector is a
  // read-only step, and a marker written here would be the permanent discard
  // the verdict contract forbids (duplicate_of is a family signal, not a
  // confirmed duplicate). The mock throws on any call it does not model, so
  // this asserts the shape of every call that was made.
  for (const call of blocked.calls) {
    assert(
      (call[0] === "issue" && (call[1] === "list" || call[1] === "view")) ||
        // The open-PR dedup is a GET on the REST pulls endpoint (owner-qualified
        // head filter) — a read, with no mutating method flag.
        (call[0] === "api" &&
          /^repos\/[^ ]+\/pulls\?/.test(String(call[1])) &&
          !call.includes("--method") &&
          !call.includes("-X")),
      `selector must issue reads only, got: ${call.join(" ")}`,
    );
  }
  // Run B: a genuine regression re-queued 2E, which sheds its autofix markers
  // (REOPEN_SHED_LABELS) — the same four stubs are selectable again, with no
  // state to clear anywhere.
  const reopened = makeRunGh({ stubs: orphanedFamilyStubs(), handled: [] });
  assertDeepEqual(
    await selectAutofixCandidates({ repo: "o/r", cap: 2 }, reopened),
    [{ issue: 1313, shortId: "ANALYTICS-MENTO-ORG-2F" }],
  );
});

await test("the representative is the family's OLDEST member, whatever order the list arrives in", async () => {
  // Same family, anchor NOT first in the list `gh` returned. The selector sorts
  // the window by createdAt, so the representative is still 2E — the oldest.
  const [anchor, ...rest] = realFamilyStubs();
  const stubs = [rest[0], rest[1], anchor, rest[2], rest[3]];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 1304, shortId: "ANALYTICS-MENTO-ORG-2E" },
  ]);
});

await test("agent-authored pointer COUNTS cannot move the representative off the oldest stub", async () => {
  // The representative decides which stub's verdict the fix agent reads and
  // which stub consumes the finalize job's App-token push + PR create. Ranking
  // that by in-degree — a raw count of how many verdicts name an id — hands the
  // choice to whoever can create the most Sentry issues: N noise stubs naming
  // each other outrank the real bug, take the run, get refused, and then block
  // the whole family. `createdAt` is the one ordering agent text cannot set.
  const real = familyStub(
    1500,
    "ANALYTICS-MENTO-ORG-R1",
    "2026-07-01T00:00:00Z",
    ["ANALYTICS-MENTO-ORG-N0"],
  );
  const noise = [0, 1, 2, 3, 4].map((i) =>
    familyStub(
      1600 + i,
      `ANALYTICS-MENTO-ORG-N${i}`,
      `2026-07-0${2 + i}T00:00:00Z`,
      ["ANALYTICS-MENTO-ORG-N0", "ANALYTICS-MENTO-ORG-R1"],
    ),
  );
  const { runGh } = makeRunGh({ stubs: [real, ...noise] });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // N0 carries five inbound pointers to R1's one; the oldest stub wins anyway.
  assertDeepEqual(selected, [
    { issue: 1500, shortId: "ANALYTICS-MENTO-ORG-R1" },
  ]);
});

await test("a family takes its OLDEST member's queue slot, so newer independents cannot push it past the cap", async () => {
  // Decisions come back in input order and the cap is applied over that order,
  // so a family represented by a LATE member occupied that member's slot. With
  // >= cap newer independent candidates in between, the family lost the race on
  // every run — and because the window is recomputed identically each time, the
  // queue's OLDEST candidate was never fixed. That is exactly what
  // `sort:created-asc` exists to prevent.
  const P = "ANALYTICS-MENTO-ORG";
  const stubs = [
    familyStub(1, `${P}-A1`, "2026-07-01T00:00:00Z", [`${P}-A9`]),
    familyStub(2, `${P}-B2`, "2026-07-02T00:00:00Z", []),
    familyStub(3, `${P}-B3`, "2026-07-03T00:00:00Z", []),
    familyStub(4, `${P}-A8`, "2026-07-04T00:00:00Z", [`${P}-A9`]),
    // The most-pointed-at member of the family sits LAST in the window.
    familyStub(5, `${P}-A9`, "2026-07-05T00:00:00Z", [`${P}-A1`]),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // The oldest candidate in the queue keeps the first slot; the family's other
  // two members defer behind it.
  assertDeepEqual(selected, [
    { issue: 1, shortId: `${P}-A1` },
    { issue: 2, shortId: `${P}-B2` },
  ]);
});

await test("a RECONCILE member is never collapsed away, and its family opens no second PR", async () => {
  // A reconcile entry runs no agent — it relinks a prior run's open PR — so it
  // must survive the collapse (dropping it strands that stub's queue
  // side-effects forever). Its family already has an open fix PR, so no sibling
  // may open another.
  const { runGh } = makeRunGh({
    stubs: realFamilyStubs(),
    prShortIds: ["ANALYTICS-MENTO-ORG-2F"],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 1313, shortId: "ANALYTICS-MENTO-ORG-2F", reconcile: true },
  ]);
});

await test("two independent families each get their own candidate", async () => {
  const stubs = [
    ...realFamilyStubs().slice(0, 2),
    familyStub(1400, "ANALYTICS-MENTO-ORG-77", "2026-07-17T00:00:00Z", [
      "ANALYTICS-MENTO-ORG-78",
    ]),
    familyStub(1401, "ANALYTICS-MENTO-ORG-78", "2026-07-17T00:01:00Z", [
      "ANALYTICS-MENTO-ORG-77",
    ]),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 5 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 1304, shortId: "ANALYTICS-MENTO-ORG-2E" },
    { issue: 1400, shortId: "ANALYTICS-MENTO-ORG-77" },
  ]);
});

await test("single-issue dispatch overrides the family collapse (explicit human intent)", async () => {
  // An operator who names a family member after reviewing the refusal is
  // overriding a SIGNAL, not a confirmed duplicate — the dispatch path keeps
  // its pre-#1784 behaviour exactly.
  const { runGh, calls } = makeRunGh({
    stubs: orphanedFamilyStubs(),
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-2E", label: FIX_REFUSED_LABEL }],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", issue: 1316 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 1316, shortId: "ANALYTICS-MENTO-ORG-29" },
  ]);
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "list"),
    "dispatch must not run the batch or family queries",
  );
});

// ---------------------------------------------------------------------------
// Reverse family verification (PR #1810 bug B) and per-declared-id handled
// lookups (bug C). Every case drives selectAutofixRun through the production
// entry point with the search-interpreting mock above — never a query-string
// equality assertion.
// ---------------------------------------------------------------------------

/** True when the run issued a reverse `"<id>" in:comments` probe. */
function reverseSearchedFor(calls, shortId) {
  return calls.some(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      String(c[c.indexOf("--search") + 1] ?? "").includes(
        `"${shortId}" in:comments`,
      ),
  );
}

await test("bug B: a finalist that declares NOTHING defers behind a handled sibling found by reverse search", async () => {
  // A declares no duplicate_of at all, so the forward graph never reaches its
  // family. The reverse in:comments probe finds handled B, whose FENCED verdict
  // declares [A] and which carries a terminal marker -> A defers behind B. This
  // is bug B's exact topology: the edge is invisible to the forward graph.
  const A = stub({ number: 700, shortId: "ANALYTICS-MENTO-ORG-AA" });
  const { runGh, calls } = makeRunGh({
    stubs: [A],
    handled: [
      {
        shortId: "ANALYTICS-MENTO-ORG-BB",
        label: FIX_PR_OPENED_LABEL,
        declares: ["ANALYTICS-MENTO-ORG-AA"],
      },
    ],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [{ issue: 700, reason: DEFER_FAMILY_HANDLED }]);
  assert(
    reverseSearchedFor(calls, "ANALYTICS-MENTO-ORG-AA"),
    "the reverse search must run even though A declared zero edges",
  );
});

await test("bug B control: a bare (non-verdict) comment mention does not forge an edge", async () => {
  // B is returned by the reverse search (it mentions A) but its FENCED verdict
  // declares nothing, so the authoritative re-parse rejects the edge and A is
  // selected. The search still ran — the fence, not the search, is the gate.
  const A = stub({ number: 710, shortId: "ANALYTICS-MENTO-ORG-AC" });
  const { runGh, calls } = makeRunGh({
    stubs: [A],
    handled: [
      {
        shortId: "ANALYTICS-MENTO-ORG-BC",
        label: FIX_REFUSED_LABEL,
        declares: [],
        mentions: ["ANALYTICS-MENTO-ORG-AC"],
      },
    ],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 710, shortId: "ANALYTICS-MENTO-ORG-AC" },
  ]);
  assert(
    reverseSearchedFor(calls, "ANALYTICS-MENTO-ORG-AC"),
    "the reverse search still runs in the control arm",
  );
});

await test("bug B control: a hit whose verdict names a DIFFERENT id does not forge an edge", async () => {
  // B carries a real verdict edge, but to ZZ, not to A; A only appears in a
  // mention. The probed id must be IN the parsed duplicate_of, so A is selected.
  const A = stub({ number: 720, shortId: "ANALYTICS-MENTO-ORG-AD" });
  const { runGh, calls } = makeRunGh({
    stubs: [A],
    handled: [
      {
        shortId: "ANALYTICS-MENTO-ORG-BD",
        label: FIX_REFUSED_LABEL,
        declares: ["ANALYTICS-MENTO-ORG-ZZ"],
        mentions: ["ANALYTICS-MENTO-ORG-AD"],
      },
    ],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 720, shortId: "ANALYTICS-MENTO-ORG-AD" },
  ]);
  assert(
    reverseSearchedFor(calls, "ANALYTICS-MENTO-ORG-AD"),
    "the reverse search still runs in the control arm",
  );
});

await test("bug B hub topology: A and a handled sibling joined only through a non-candidate C", async () => {
  // A declares [C]; handled B declares [C]; there is no C stub. The bug-C per-id
  // lookup for C finds nothing (no C stub), so A survives as a finalist; the
  // reverse probe of the FAMILY MEMBER C — not just the finalist id A — finds B,
  // whose terminal marker then stands A down. Probing finalist ids alone would
  // miss this.
  const A = familyStub(730, "ANALYTICS-MENTO-ORG-HA", "2026-07-18T00:00:00Z", [
    "ANALYTICS-MENTO-ORG-HC",
  ]);
  const { runGh, calls } = makeRunGh({
    stubs: [A],
    handled: [
      {
        shortId: "ANALYTICS-MENTO-ORG-HB",
        label: FIX_PR_OPENED_LABEL,
        declares: ["ANALYTICS-MENTO-ORG-HC"],
      },
    ],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [{ issue: 730, reason: DEFER_FAMILY_HANDLED }]);
  assert(
    reverseSearchedFor(calls, "ANALYTICS-MENTO-ORG-HC"),
    "the hub id C must be probed, not just the candidate id A",
  );
});

await test("bug B (#1810 follow-up): the terminal blocker on PAGE 2 of the reverse search still stands the finalist down", async () => {
  // The reverse `in:comments` probe pages the API. Before this fix the per-search
  // `--limit` was 20, so a terminal sibling that landed past the first page went
  // unread and the finalist burned an autofix run — the #1808 truncation class.
  // Topology: A declares nothing, so only the reverse probe can reach its family.
  // The search returns 29 bare mentions of A (fence-rejected: no verdict edge)
  // FIRST, then the single handled sibling B that actually declares [A] and holds
  // a terminal marker — so B is the 30th row, on page 2 of a 20-row page. With
  // --limit REVERSE_SEARCH_LIMIT (100) B is returned and A stands down.
  //
  // NEGATIVE CONTROL (revert the source `--limit` to 20): the mock truncates the
  // returned rows to the passed `--limit`, so a 20-row page drops B (row 30) and
  // A is (wrongly) selected — the family burns a run. That mutation is anchored
  // twice below: the probe must request at least the 30 rows needed to clear the
  // page, AND B must actually be the last row (assert-fail if the fixture drifts
  // so the blocker is not genuinely on page 2).
  const A = stub({ number: 800, shortId: "ANALYTICS-MENTO-ORG-PA" });
  const noise = Array.from({ length: 29 }, (_, i) => ({
    number: 8100 + i,
    shortId: `ANALYTICS-MENTO-ORG-N${i}`,
    label: FIX_REFUSED_LABEL,
    declares: [],
    mentions: ["ANALYTICS-MENTO-ORG-PA"],
  }));
  const blocker = {
    number: 8200,
    shortId: "ANALYTICS-MENTO-ORG-PB",
    label: FIX_PR_OPENED_LABEL,
    declares: ["ANALYTICS-MENTO-ORG-PA"],
  };
  const handled = [...noise, blocker];
  // Fixture anchor: the blocker is genuinely past a 20-row page — the exact
  // condition the old --limit 20 dropped.
  assert(
    handled.indexOf(blocker) >= 20,
    "the terminal blocker must sit past the first page for the control to bite",
  );
  const { runGh, calls } = makeRunGh({ stubs: [A], handled });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [{ issue: 800, reason: DEFER_FAMILY_HANDLED }]);
  // Anchor the fix's value, not just consistency: a probe that asked for 20
  // (the reverted source) could not reach row 30, so require real page-2 reach.
  const probe = calls.find(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      String(c[c.indexOf("--search") + 1] ?? "").includes(
        `"ANALYTICS-MENTO-ORG-PA" in:comments`,
      ),
  );
  assert(probe, "the reverse probe ran");
  const probeLimit = Number(probe[probe.indexOf("--limit") + 1]);
  assertEqual(
    String(probeLimit),
    String(REVERSE_SEARCH_LIMIT),
    "the reverse probe must request REVERSE_SEARCH_LIMIT rows",
  );
  assert(
    probeLimit >= 30,
    `the reverse probe --limit must clear page 2 (>=30), got ${probeLimit}`,
  );
});

await test("bug B (#1810 follow-up): a FULL reverse page flips the truncated flag onto the run record", async () => {
  // A full page means `--limit` capped what the API returned before any filter,
  // so an unread page 2 may hold a sibling. The fix surfaces that on the same
  // run-record line the probe-budget truncation uses (truncations.reverseBudget)
  // rather than paginating. Here A declares nothing and the probe comes back with
  // exactly REVERSE_SEARCH_LIMIT bare mentions (no verdict edge, so A is still
  // selected) — the flag must be set anyway.
  const A = stub({ number: 810, shortId: "ANALYTICS-MENTO-ORG-QA" });
  const fullPage = Array.from({ length: REVERSE_SEARCH_LIMIT }, (_, i) => ({
    number: 8300 + i,
    shortId: `ANALYTICS-MENTO-ORG-Q${i}`,
    label: FIX_REFUSED_LABEL,
    declares: [],
    mentions: ["ANALYTICS-MENTO-ORG-QA"],
  }));
  const { runGh } = makeRunGh({ stubs: [A], handled: fullPage });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [{ issue: 810, shortId: "ANALYTICS-MENTO-ORG-QA" }]);
  assertEqual(
    truncations.reverseBudget,
    true,
    "a full reverse page must surface as a truncation on the run record",
  );
});

await test("bug C: a declared terminal sibling is found by its own id, and no bulk 200-list is issued", async () => {
  // The candidate declares [OLD]; OLD carries a terminal marker but is not in
  // the window. The per-declared-id in:title query keyed on OLD finds it however
  // deep it sits in the ledger; the deleted bulk sort:created-desc marker list
  // is never issued.
  const candidate = familyStub(
    740,
    "ANALYTICS-MENTO-ORG-NEW",
    "2026-07-18T00:00:00Z",
    ["ANALYTICS-MENTO-ORG-OLD"],
  );
  const { runGh, calls } = makeRunGh({
    stubs: [candidate],
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-OLD", label: FIX_REFUSED_LABEL }],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [{ issue: 740, reason: DEFER_FAMILY_HANDLED }]);
  assert(
    calls.some(
      (c) =>
        c[0] === "issue" &&
        c[1] === "list" &&
        String(c[c.indexOf("--search") + 1] ?? "").includes(
          `"ANALYTICS-MENTO-ORG-OLD" in:title`,
        ),
    ),
    "the handled lookup queries the declared id directly",
  );
  assert(
    !calls.some((c) => {
      const i = c.indexOf("--search");
      return i !== -1 && String(c[i + 1] ?? "").includes("sort:created-desc");
    }),
    "the deleted bulk sort:created-desc marker list must not be issued",
  );
});

await test("bug C exact-parse fence: a tokenized near-miss title does not block", async () => {
  // The tokenized search surfaces a stub whose title parses to a DIFFERENT
  // short-id than the queried OLD; the parsed-short-id recheck drops it, so the
  // candidate is NOT blocked.
  const candidate = familyStub(
    750,
    "ANALYTICS-MENTO-ORG-NW",
    "2026-07-18T00:00:00Z",
    ["ANALYTICS-MENTO-ORG-OLD"],
  );
  const { runGh } = makeRunGh({
    stubs: [candidate],
    handled: [
      {
        shortId: "ANALYTICS-MENTO-ORG-DIFF",
        label: FIX_REFUSED_LABEL,
        matchTitleFor: "ANALYTICS-MENTO-ORG-OLD",
      },
    ],
  });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 750, shortId: "ANALYTICS-MENTO-ORG-NW" },
  ]);
});

// The documented per-run gh ceiling (docs/notes/sentry-triage-pipeline.md
// § "Cost bound"): 1 window list + MAX_CANDIDATE_EVALUATIONS (200) × 2 reads +
// MAX_HANDLED_ID_QUERIES (40) + MAX_REVERSE_PROBE_QUERIES (40) +
// MAX_REVERSE_VERIFY_READS (40) cached verify reads = 521, with a little slack.
// Load-bearing: the worst-case tests below drive EVERY leg to its cap, so
// removing a cap breaches this number. The verify-read leg is the one an
// empty-`handled` window leaves at zero — its own saturating pin lives in
// "cost pin: the reverse verify-read fan-out is capped" below.
const DOCUMENTED_GH_CEILING = 525;

// The same ceiling for a run that ALSO takes the bounded second look: + 1 list
// + MAX_SECOND_LOOK_EVALUATIONS (100) × 2 reads + 60 second-look family budget
// = 782. This is the number the 25-minute select timeout is sized against — at
// a pessimistic 1.0 s/call it is ~13 minutes, ~52% of the job budget. A change
// that breaches it has re-opened the timeout arithmetic.
const DOCUMENTED_GH_CEILING_WITH_SECOND_LOOK = 790;

await test("cost pin: an EMPTY-family full window issues no per-id or reverse work", async () => {
  // Baseline only: default stubs declare nothing, so declaredIds is empty (zero
  // in:title lookups) and every family is a singleton (each finalist's members =
  // its own id). This pins the empty-window profile — ~1 window + 200 views +
  // 200 pr lists — but it CANNOT exercise the per-id or reverse loops, so it is
  // not the regression guard for their caps; the worst-case window below is.
  const stubs = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS; i += 1) {
    stubs.push(
      stub({
        number: 4000 + i,
        shortId: `ANALYTICS-MENTO-ORG-C${i}`,
        createdAt: orderedCreatedAt(i),
      }),
    );
  }
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r", cap: 2 }, { runGh });
  assert(
    calls.length <= DOCUMENTED_GH_CEILING,
    `empty-family gh volume must stay under the ceiling, got ${calls.length}`,
  );
});

/**
 * A worst-case window that drives the per-run budgets to their caps: two large
 * LOCAL duplicate families (whose representatives are the cap-2 finalists) with a
 * combined >MAX_REVERSE_PROBE_QUERIES member ids, plus enough distinct declared
 * hub ids across the whole window to exceed MAX_HANDLED_ID_QUERIES. This is the
 * shape finding 4 named as invisible to the old empty-family cost pin.
 */
function worstCaseWindow() {
  const stubs = [];
  let created = 0;
  const at = () => orderedCreatedAt(created++);
  // A big family: `n` candidates each declaring a SHARED common id (so they all
  // union into one family) plus 4 unique hubs — MAX_DUPLICATE_LOOKUPS (5) ids
  // each. Members = n candidates + 1 common + 4n hubs; n=7 -> 36, under
  // MAX_FAMILY_MEMBERS (40).
  const bigFamily = (tag, n) => {
    const common = `ANALYTICS-MENTO-ORG-CM${tag}`;
    for (let i = 0; i < n; i += 1) {
      const hubs = [0, 1, 2, 3].map(
        (j) => `ANALYTICS-MENTO-ORG-H${tag}${i}${j}`,
      );
      stubs.push(
        familyStub(
          9000 + stubs.length,
          `ANALYTICS-MENTO-ORG-F${tag}${i}`,
          at(),
          [common, ...hubs],
        ),
      );
    }
  };
  bigFamily("A", 7); // oldest -> finalist #1, 36 members
  bigFamily("B", 7); // next -> finalist #2, 36 members (72 combined > 40)
  // Singletons: each its own family (5 unique hubs), padding the window to the
  // eval cap and the distinct-declared-id count far past MAX_HANDLED_ID_QUERIES.
  while (stubs.length < MAX_CANDIDATE_EVALUATIONS) {
    const i = stubs.length;
    const hubs = [0, 1, 2, 3, 4].map((j) => `ANALYTICS-MENTO-ORG-S${i}${j}`);
    stubs.push(familyStub(9000 + i, `ANALYTICS-MENTO-ORG-G${i}`, at(), hubs));
  }
  return stubs;
}

/**
 * `n` filler candidates whose declared duplicate_of ids number EXACTLY `n*5`
 * distinct local ids (MAX_DUPLICATE_LOOKUPS each), and which are handled by
 * NOBODY — so the initial declared-id pass spends `n*5` lookups with ZERO
 * overflow of its own. Used to drive the shared handled budget to exactly
 * MAX_HANDLED_ID_QUERIES (remaining 0, overflow 0) before a later recheck, so any
 * overflow the assertion sees comes ONLY from the zero-capacity recheck. Created
 * newer than a fixed anchor so a chosen finalist can still be the oldest stub.
 */
function budgetFillerStubs(n) {
  const stubs = [];
  for (let i = 0; i < n; i += 1) {
    const declares = [0, 1, 2, 3, 4].map(
      (j) => `ANALYTICS-MENTO-ORG-BF${i}${j}`,
    );
    stubs.push(
      familyStub(
        600 + i,
        `ANALYTICS-MENTO-ORG-BC${i}`,
        orderedCreatedAt(i, "05"),
        declares,
      ),
    );
  }
  return stubs;
}

/** Candidate-window list calls only (`sort:created-asc …`), never the per-id
 * family probes, which are also `issue list`. */
function windowListCount(calls) {
  return calls.filter(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      /sort:created-asc/.test(String(c[c.indexOf("--search") + 1] ?? "")),
  ).length;
}

function reverseSearchCount(calls) {
  return calls.filter(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      /"[^"]+"\s+in:comments/.test(String(c[c.indexOf("--search") + 1] ?? "")),
  ).length;
}

function titleSearchCount(calls) {
  return calls.filter(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      /"[^"]+"\s+in:title/.test(String(c[c.indexOf("--search") + 1] ?? "")),
  ).length;
}

// `gh issue view` reads spent verifying reverse `in:comments` HITS: makeRunGh
// numbers handled/hit stubs at 9000+, so a view of one is a reverse verify read.
// (Candidate stubs in these pins carry sub-9000 numbers, so their own evaluation
// reads never count here.)
function reverseVerifyReadCount(calls) {
  return calls.filter(
    (c) => c[0] === "issue" && c[1] === "view" && Number(c[2]) >= 9000,
  ).length;
}

await test("cost pin: a worst-case large-family window drives and bounds every per-run budget", async () => {
  const stubs = worstCaseWindow();
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r", cap: 2 }, { runGh });
  // Load-bearing bounds. Without MAX_REVERSE_PROBE_QUERIES the two 36-member
  // finalist families fan out to 72 in:comments searches; without
  // MAX_HANDLED_ID_QUERIES the ~238 distinct declared ids each fire an in:title
  // search. Either breaches at least one assertion below — the caps are what
  // keep this window inside the ceiling.
  assert(
    reverseSearchCount(calls) <= MAX_REVERSE_PROBE_QUERIES,
    `reverse in:comments searches must be capped at ${MAX_REVERSE_PROBE_QUERIES}, got ${reverseSearchCount(calls)}`,
  );
  assert(
    titleSearchCount(calls) <= MAX_HANDLED_ID_QUERIES,
    `handled in:title searches must be capped at ${MAX_HANDLED_ID_QUERIES}, got ${titleSearchCount(calls)}`,
  );
  assert(
    calls.length <= DOCUMENTED_GH_CEILING,
    `worst-case gh volume must stay under the documented ceiling, got ${calls.length}`,
  );
  // The window must actually EXERCISE both loops, or the bounds prove nothing —
  // the exact defect (finding 4) the empty-family pin had.
  assert(
    reverseSearchCount(calls) === MAX_REVERSE_PROBE_QUERIES,
    `the reverse loop must saturate its budget, got ${reverseSearchCount(calls)}`,
  );
  assert(
    titleSearchCount(calls) === MAX_HANDLED_ID_QUERIES,
    `the handled loop must saturate its budget, got ${titleSearchCount(calls)}`,
  );
});

await test("cost pin: the reverse verify-read fan-out is capped at MAX_REVERSE_VERIFY_READS", async () => {
  // The bound the empty-`handled` worst-case pins above CANNOT reach: with no
  // handled stubs every reverse probe returns [], so ZERO verify reads run and the
  // ceiling's "cached verify reads" term is never exercised. MAX_REVERSE_PROBE_QUERIES
  // caps only the SEARCHES; each search returns up to REVERSE_SEARCH_LIMIT (100)
  // rows, and every unseen row costs one `gh issue view` before the fence can
  // reject it. Without the read cap a single full-page probe fans out to 100
  // subprocesses (and 40 probes to 4000) — the leg this pins.
  //
  // Topology: one finalist A that declares nothing (so only the reverse probe
  // reaches its family), and a FULL REVERSE_SEARCH_LIMIT page of DISTINCT stubs
  // that each merely MENTION A in a comment (no verdict edge, so the fence admits
  // none — A stays selected). Every row is a distinct 9000+ number, so each is a
  // cache-miss read; the cap must stop the fan-out at MAX_REVERSE_VERIFY_READS.
  //
  // NEGATIVE CONTROL (delete the `verifyBudget.remaining` guard in
  // reverseVerifyFamilies): every one of the REVERSE_SEARCH_LIMIT rows is read, so
  // reverseVerifyReadCount jumps to 100 and the `=== MAX_REVERSE_VERIFY_READS`
  // assertion fails — proving the cap is what does the bounding.
  const A = stub({ number: 800, shortId: "ANALYTICS-MENTO-ORG-RA" });
  const fullPage = Array.from({ length: REVERSE_SEARCH_LIMIT }, (_, i) => ({
    number: 9000 + i,
    shortId: `ANALYTICS-MENTO-ORG-R${i}`,
    label: FIX_REFUSED_LABEL,
    declares: [],
    mentions: ["ANALYTICS-MENTO-ORG-RA"],
  }));
  // The page must genuinely exceed the read cap, or it proves nothing.
  assert(
    fullPage.length > MAX_REVERSE_VERIFY_READS,
    "the reverse page must exceed the verify-read budget for the cap to bite",
  );
  const { runGh, calls } = makeRunGh({ stubs: [A], handled: fullPage });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // Bare mentions forge no edge, so A is still selected — the truncation is a
  // benign, self-terminating cost, never a wrong close.
  assertDeepEqual(entries, [{ issue: 800, shortId: "ANALYTICS-MENTO-ORG-RA" }]);
  assertEqual(
    reverseVerifyReadCount(calls),
    MAX_REVERSE_VERIFY_READS,
    `the verify-read fan-out must saturate AND stop at its budget, got ${reverseVerifyReadCount(calls)}`,
  );
  assert(
    truncations.reverseBudget === true,
    "the capped verify-read fan-out must surface as a truncation on the run record",
  );
  assert(
    calls.length <= DOCUMENTED_GH_CEILING,
    `verify-read-saturating gh volume must stay under the ceiling, got ${calls.length}`,
  );
});

await test("bug B follow-up: a terminal sibling reachable only through a read hub's OTHER edge still stands the finalist down", async () => {
  // Finalist P declares NOTHING. A non-candidate hub H (in the ledger, not the
  // window) declares BOTH P and a terminal sibling Q; Q declares nothing and is
  // referenced by nobody but H. Probing P admits H — but H's edge to Q is the one
  // a finalist-only reverse search drops, and Q's fix-refused marker lives on Q's
  // OWN stub, which no reverse hit surfaces. The fix folds the admitted hub's
  // WHOLE declared family in (so Q joins P's family) and re-checks Q's own marker
  // by title, standing P down instead of burning a redundant attempt.
  const P = stub({ number: 800, shortId: "ANALYTICS-MENTO-ORG-PP" });
  const { runGh, calls } = makeRunGh({
    stubs: [P],
    handled: [
      {
        // Non-terminal hub: carries the verdict label, NOT a terminal marker, so
        // it is a CONNECTOR (edges only), never a blocker itself.
        shortId: "ANALYTICS-MENTO-ORG-HH",
        label: AUTOFIX_SELECT_LABEL,
        declares: ["ANALYTICS-MENTO-ORG-PP", "ANALYTICS-MENTO-ORG-QQ"],
      },
      {
        // The real blocker: terminal, declares nothing, referenced by nobody but
        // the hub — so only a title lookup on its own id can find its marker.
        shortId: "ANALYTICS-MENTO-ORG-QQ",
        label: FIX_REFUSED_LABEL,
        declares: [],
      },
    ],
  });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(deferred, [{ issue: 800, reason: DEFER_FAMILY_HANDLED }]);
  assert(
    reverseSearchedFor(calls, "ANALYTICS-MENTO-ORG-PP"),
    "the finalist P must be reverse-probed",
  );
  // The blocker Q is reached ONLY by re-checking its own marker by title after
  // the hub's edge surfaced it — the leg the fix adds.
  assert(
    titleSearchCount(calls) > 0 &&
      calls.some(
        (c) =>
          c[0] === "issue" &&
          c[1] === "list" &&
          String(c[c.indexOf("--search") + 1] ?? "").includes(
            `"ANALYTICS-MENTO-ORG-QQ" in:title`,
          ),
      ),
    "Q's own marker must be re-checked by title",
  );
});

await test("run record surfaces the reverse-probe and handled-id budget truncations (never silent)", async () => {
  // A worst-case window saturates BOTH budgets, so both truncations must reach
  // the run record. Deferral already surfaces on the tracker; these two capped
  // lookups are the OTHER way a family that should stand down is re-attempted —
  // a bounded, self-terminating cost, but it must not be byte-identical to a
  // healthy run.
  const { runGh } = makeRunGh({ stubs: worstCaseWindow() });
  const { truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assert(
    truncations.reverseBudget === true,
    "the reverse-probe budget truncation must surface",
  );
  assert(
    truncations.handledOverflow > 0,
    `the handled-id overflow count must surface, got ${truncations.handledOverflow}`,
  );
  assert(
    truncations.reverseNonconvergent === false,
    "this window converges, so the non-convergence flag stays false",
  );
});

await test("listHandledShortIds fails SOFT per id: one lookup throwing keeps the others resolving (never rejects the call)", async () => {
  // The per-id `in:title` await used to be uncaught, so one transient gh failure
  // rejected the whole call and aborted the select job under `set -euo pipefail`
  // — breaking "select ALWAYS emits a valid JSON array, never fails". Now each id
  // fails soft (like the reverse `in:comments` probe): the failing id is treated
  // as NOT handled and every other id still resolves.
  //
  // NEGATIVE CONTROL: remove the try/catch around the per-id `runGh` in
  // listHandledShortIds and this `await` rejects — the test throws instead of
  // returning, proving the catch is what preserves the never-fails invariant.
  const { runGh } = makeRunGh({
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-3F", label: FIX_REFUSED_LABEL }],
    handledLookupErrorIds: ["ANALYTICS-MENTO-ORG-2E"],
  });
  const handled = await listHandledShortIds(runGh, "o/r", [
    "ANALYTICS-MENTO-ORG-2E", // its in:title lookup throws
    "ANALYTICS-MENTO-ORG-3F", // handled (fix-refused) — resolved AFTER the throw
    "ANALYTICS-MENTO-ORG-4G", // not handled
  ]);
  assert(Array.isArray(handled), "returns a valid array, never rejects");
  assert(
    !handled.includes("ANALYTICS-MENTO-ORG-2E"),
    "the throwing id is treated as not-handled (fails toward MORE candidates)",
  );
  assert(
    handled.includes("ANALYTICS-MENTO-ORG-3F"),
    "a handled sibling after the failing id still resolves",
  );
});

await test("a recheck at an EXHAUSTED handled budget surfaces overflow, never a silent truncation", async () => {
  // Budget-exhausted variant of the hub topology. 40 distinct declared ids spend
  // the whole MAX_HANDLED_ID_QUERIES budget in the initial pass (overflow 0,
  // remaining 0). Then finalist P (oldest, declares nothing) is reverse-probed
  // and admits a NONTERMINAL hub H that declares both P and a terminal sibling Q;
  // Q joins P's family and enters the recheck at ZERO remaining capacity. The
  // recheck cannot look Q up, but it MUST record the overflow so the un-run
  // recheck surfaces on the run record. The pre-fix `&& remaining > 0` guard
  // skipped the recheck entirely — leaving Q's marker unread, redundantly
  // selecting P, and reporting overflow 0: a silent truncation.
  //
  // NEGATIVE CONTROL: restore the `&& handledBudget.remaining > 0` guard in
  // resolveFamilies and handledOverflow drops to 0 while P is still selected —
  // the exact silent truncation this asserts against.
  const P = stub({
    number: 700,
    shortId: "ANALYTICS-MENTO-ORG-PP",
    createdAt: "2026-07-01T00:00:00Z", // OLDEST -> finalist #1, so P is reverse-probed
  });
  const fillers = budgetFillerStubs(MAX_HANDLED_ID_QUERIES / 5); // 8 x 5 = 40 declared
  const { runGh, calls } = makeRunGh({
    stubs: [P, ...fillers],
    handled: [
      {
        // Nonterminal connector hub: carries the verdict label, NOT a terminal
        // marker, so it contributes edges only (never a blocker itself).
        shortId: "ANALYTICS-MENTO-ORG-HH",
        label: AUTOFIX_SELECT_LABEL,
        declares: ["ANALYTICS-MENTO-ORG-PP", "ANALYTICS-MENTO-ORG-QQ"],
      },
      {
        // The terminal blocker, reachable only through the hub's OTHER edge, so
        // only a title recheck on Q's own id could read its marker.
        shortId: "ANALYTICS-MENTO-ORG-QQ",
        label: FIX_REFUSED_LABEL,
        declares: [],
      },
    ],
  });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // The declared pass alone spent the whole handled budget (40 distinct ids), so
  // the Q recheck runs at zero remaining capacity.
  assertEqual(
    titleSearchCount(calls),
    MAX_HANDLED_ID_QUERIES,
    `the declared pass must spend the whole handled budget, got ${titleSearchCount(calls)}`,
  );
  // The surfacing the fix exists for: the un-run recheck is recorded, not silent.
  assert(
    truncations.handledOverflow > 0,
    `a recheck at exhausted budget must surface as overflow, got ${truncations.handledOverflow}`,
  );
  // Q's marker was unreadable at zero budget, so P is still (redundantly)
  // selected — which is why surfacing the truncation matters: a bounded,
  // self-terminating re-attempt must not read as a healthy run.
  assert(
    entries.some((e) => e.shortId === "ANALYTICS-MENTO-ORG-PP"),
    "P is still selected (the redundant attempt), so the truncation must be surfaced",
  );
});

await test("run record truncations are all-clear on an empty-family window and the dispatch path", async () => {
  // The steady state carries no truncation, so the record renders no noise line;
  // and single-issue dispatch skips the collapse entirely, so it never truncates.
  const stubs = [stub({ number: 810, shortId: "ANALYTICS-MENTO-ORG-ZA" })];
  const { runGh } = makeRunGh({ stubs });
  const batch = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(batch.truncations, {
    handledOverflow: 0,
    reverseBudget: false,
    reverseNonconvergent: false,
    rateLimited: 0,
  });
  const dispatch = await selectAutofixRun(
    { repo: "o/r", issue: 810 },
    { runGh },
  );
  assertDeepEqual(dispatch.truncations, {
    handledOverflow: 0,
    reverseBudget: false,
    reverseNonconvergent: false,
    rateLimited: 0,
  });
});

await test("window report: a full, selecting window reports total/evaluated, no second look, and a measured gh count", async () => {
  const stubs = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS + 1; i += 1) {
    stubs.push(
      stub({
        number: 5000 + i,
        shortId: `ANALYTICS-MENTO-ORG-W${i}`,
        createdAt: orderedCreatedAt(i),
      }),
    );
  }
  const { runGh } = makeRunGh({ stubs });
  const { window } = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  // LIST_LIMIT is applied by the API BEFORE the eval slice, so the 201st stub
  // never reaches the client: total == evaluated == the ceiling. This is why
  // MAX_CANDIDATE_EVALUATIONS may not exceed LIST_LIMIT — see the pin below.
  assertEqual(window.total, MAX_CANDIDATE_EVALUATIONS);
  assertEqual(window.evaluated, MAX_CANDIDATE_EVALUATIONS);
  // This run SELECTED, so the second look must not fire — it costs nothing on a
  // healthy run, which is the whole condition on adding it.
  assertEqual(window.secondLook, false, "a selecting run takes no second look");
  assertEqual(window.secondLookTotal, 0);
  assertEqual(window.secondLookEvaluated, 0);
  assert(window.ghCalls > 0, "the run must report a measured gh call count");
});

await test("over-collapse invariant: foreign ids in options.handledEdges stay inert", () => {
  // The reverse-edge input is subject to the same project scope as declared ids
  // (f_new_rules_must_be_tested_against_the_invariant): a foreign-project or
  // bare-slug edge must not union unrelated local candidates.
  const candidates = [
    { shortId: "ANALYTICS-MENTO-ORG-E1", duplicateOf: [], entry: { issue: 1 } },
    { shortId: "ANALYTICS-MENTO-ORG-E2", duplicateOf: [], entry: { issue: 2 } },
  ];
  const foreign = collapseDuplicateFamilies(candidates, {
    project: LOCAL_SENTRY_PROJECT,
    handledEdges: [
      ["APP-MENTO-ORG-7X", "ANALYTICS-MENTO-ORG-E1"], // foreign project
      ["ANALYTICS-MENTO-ORG", "ANALYTICS-MENTO-ORG-E2"], // bare slug
    ],
  });
  assertEqual(
    foreign.filter((d) => d.selected).length,
    2,
    "foreign / bare-slug edges must not join the two candidates",
  );
  // A LOCAL edge between the two DOES join them — proving the inertness above is
  // the scope check doing work, not a dead input.
  const local = collapseDuplicateFamilies(candidates, {
    project: LOCAL_SENTRY_PROJECT,
    handledEdges: [["ANALYTICS-MENTO-ORG-E1", "ANALYTICS-MENTO-ORG-E2"]],
  });
  assertEqual(
    local.filter((d) => d.selected).length,
    1,
    "a local edge joins the two into one family",
  );
});

// --- the pure collapse module's own bounds -------------------------------

await test("collapseDuplicateFamilies: an INELIGIBLE candidate joins the union but is never selected", () => {
  // The module's own contract, driven directly because the selector short-
  // circuits on `eligible` before it ever reads the decision — so a regression
  // here is invisible through the production entry point until some future
  // caller stops short-circuiting, and then it emits the candidate the caller
  // ruled out. Both halves are asserted: the edges land, and the record does
  // not.
  const candidates = [
    { shortId: "APP-1", duplicateOf: ["APP-2"], eligible: false, issue: 1 },
    { shortId: "APP-2", duplicateOf: [], entry: { issue: 2 } },
    { shortId: "APP-3", duplicateOf: [], entry: { issue: 3 } },
  ];
  const decisions = collapseDuplicateFamilies(candidates, { project: "APP" });
  assertEqual(
    decisions[0].selected,
    false,
    "an ineligible candidate must never come back selected",
  );
  assertEqual(
    decisions[0].reason,
    null,
    "the reason belongs to the caller, not to the family collapse",
  );
  // Its edge unioned APP-1 with APP-2, so APP-2 represents that family and
  // APP-3 stays an independent candidate.
  assertEqual(decisions[1].selected, true, "APP-2 represents the family");
  assertEqual(decisions[2].selected, true, "APP-3 is a separate family");
  // And an ineligible candidate does not consume the family's representative
  // slot: dropping APP-2 from the window would leave the family unrepresented.
  const alone = collapseDuplicateFamilies(
    [{ shortId: "APP-1", duplicateOf: ["APP-2"], eligible: false, issue: 1 }],
    { project: "APP" },
  );
  assertEqual(alone[0].selected, false);
});

await test("declaredFamilyIds drops the stub's OWN id before spending the lookup budget", () => {
  const self = "APP-2E";
  const ids = declaredFamilyIds(
    self,
    [self, "APP-1", "APP-2", "APP-3", "APP-4", "APP-5"],
    "APP",
  );
  // Capping before the self-exclusion would push APP-5 past the budget.
  assertDeepEqual(ids, ["APP-1", "APP-2", "APP-3", "APP-4", "APP-5"]);
  assertEqual(ids.length, MAX_DUPLICATE_LOOKUPS, "budget is the fan-out bound");
});

await test("a family that would exceed MAX_FAMILY_MEMBERS refuses the merge rather than growing", () => {
  // Agent-authored lists chained end to end must not be able to union the whole
  // queue into one family and defer everything behind a single representative.
  // Failing toward MORE candidates is the safe direction (the run cap still
  // holds); failing toward fewer would silently starve the queue.
  const candidates = [];
  for (let i = 0; i < MAX_FAMILY_MEMBERS + 10; i += 1) {
    candidates.push({
      shortId: `APP-${i}`,
      duplicateOf: [`APP-${i + 1}`],
      entry: { issue: i },
    });
  }
  const decisions = collapseDuplicateFamilies(candidates, { project: "APP" });
  const selected = decisions.filter((d) => d.selected).length;
  assert(selected > 1, `the chain must not collapse to one, got ${selected}`);
});

await test("a shape-invalid handled SHORT-ID cannot block a family", () => {
  // The handled set drives a DEFERRAL, so a malformed id must be inert rather
  // than standing a family down — and it must never reach a rendered line.
  const candidates = [
    { shortId: "APP-1", duplicateOf: ["APP-2"], entry: { issue: 1 } },
  ];
  const blocked = collapseDuplicateFamilies(candidates, {
    handledShortIds: ["APP-2"],
    project: "APP",
  });
  assertEqual(blocked[0].selected, false, "a valid handled id blocks");
  const inert = collapseDuplicateFamilies(candidates, {
    handledShortIds: ["APP 2\n::error::injected"],
    project: "APP",
  });
  assertEqual(inert[0].selected, true, "a malformed handled id is inert");
});

await test("family ids are PROJECT-SCOPED: a foreign or bare-slug id joins nothing", () => {
  // `isValidShortId` accepts any hyphenated token, including the bare project
  // slug — so without scoping, one degenerate or foreign id in each verdict
  // unions unrelated candidates into a single starved family.
  assert(isValidShortId("ANALYTICS-MENTO-ORG"), "the bare slug does validate");
  assertDeepEqual(
    declaredFamilyIds(
      "ANALYTICS-MENTO-ORG-D1",
      [
        "APP-MENTO-ORG-7X", // another Sentry project
        "ANALYTICS-MENTO-ORG", // the bare project slug
        "ANALYTICS-MENTO-ORG-D2", // a real sibling
      ],
      LOCAL_SENTRY_PROJECT,
    ),
    ["ANALYTICS-MENTO-ORG-D2"],
  );
  // Off-project ids are dropped BEFORE the budget, so a list padded with them
  // cannot starve real siblings out of MAX_DUPLICATE_LOOKUPS.
  const padded = declaredFamilyIds(
    "ANALYTICS-MENTO-ORG-D1",
    [
      "APP-MENTO-ORG-1",
      "APP-MENTO-ORG-2",
      "APP-MENTO-ORG-3",
      "APP-MENTO-ORG-4",
      "APP-MENTO-ORG-5",
      "ANALYTICS-MENTO-ORG-D2",
    ],
    LOCAL_SENTRY_PROJECT,
  );
  assertDeepEqual(padded, ["ANALYTICS-MENTO-ORG-D2"]);
  // Scoping applies to BLOCKERS too, in the same direction.
  const candidates = [
    {
      shortId: "ANALYTICS-MENTO-ORG-D1",
      duplicateOf: ["ANALYTICS-MENTO-ORG-D2"],
      entry: { issue: 1 },
    },
  ];
  assertEqual(
    collapseDuplicateFamilies(candidates, {
      handledShortIds: ["ANALYTICS-MENTO-ORG"],
      project: LOCAL_SENTRY_PROJECT,
    })[0].selected,
    true,
    "the bare slug must not block as a handled id",
  );
  // A missing project fails toward MORE candidates, never fewer.
  assertDeepEqual(
    declaredFamilyIds("ANALYTICS-MENTO-ORG-D1", ["ANALYTICS-MENTO-ORG-D2"], ""),
    [],
  );
});

// ---------------------------------------------------------------------------
// fix_scope: only a MECHANICAL code-fix is selectable (issue #1785).
//
// Every test above drives `fix_scope: mechanical`, so the whole pre-existing
// contract — ordering, cap, dedup, reconcile, generation token, single-issue
// dispatch, and the #1784 family collapse — is already pinned through the
// production entry point against the rerouted code. These pin the new gate.
// ---------------------------------------------------------------------------

/** Capture stderr around one call. An architectural stub is skipped WITHOUT
 * writing anything to the queue, so this note is the run's only trace of it and
 * is worth asserting rather than assuming. */
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = (chunk) => {
    text += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: text };
  } finally {
    process.stderr.write = original;
  }
}

/** Every gh call that is not one of the three READS the selector is allowed to
 * make. Selection is read-only: a fix_scope skip must not label, comment, or
 * edit anything. */
function writeCalls(calls) {
  return calls.filter(
    (c) =>
      !(
        (c[0] === "issue" && (c[1] === "list" || c[1] === "view")) ||
        (c[0] === "pr" && c[1] === "list") ||
        // The owner-qualified open-PR dedup lookup (#1810) is a GET; the select
        // leg is read-only, so this REST read must not count as a write.
        c[0] === "api"
      ),
  );
}

await test("DONE-MEANS: a code-fix verdict without a recognised fix_scope is not selectable", async () => {
  // Absent, empty, the agent's own prose, and a value that merely STARTS with
  // the enum word — all four must fail closed. The last one is why the parser
  // matches the whole value instead of a leading token the way `verdict` does.
  const cases = [
    { label: "absent", fixScope: null },
    { label: "empty", fixScope: "" },
    { label: "prose", fixScope: "Non-urgent: the code already fails open" },
    { label: "prefix", fixScope: "mechanical refactor of the cache layer" },
  ];
  for (const { label, fixScope } of cases) {
    const stubs = [
      stub({
        number: 700,
        shortId: "ANALYTICS-MENTO-ORG-7A",
        comments: [verdictComment({ fixScope })],
      }),
    ];
    const { runGh, calls } = makeRunGh({ stubs });
    const { result, stderr } = await captureStderr(() =>
      selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh }),
    );
    assertDeepEqual(result.entries, []);
    assertDeepEqual(result.deferred, []);
    assert(
      stderr.includes(`skip #700`) &&
        stderr.includes(
          `fix_scope for ANALYTICS-MENTO-ORG-7A is ${FIX_SCOPE_ARCHITECTURAL}`,
        ),
      `expected a fix_scope skip note for the ${label} case, got: ${stderr}`,
    );
    assertDeepEqual(writeCalls(calls), []);
  }
});

await test("DONE-MEANS: the REAL #1304 family payloads carry no fix_scope, so none is selected", async () => {
  // The five strategy-probe verdicts verbatim: `code-fix`, this repo, a real
  // duplicate_of graph, and NO fix_scope line — the shape every verdict written
  // before #1785 has. Each one classifies architectural and drops out before
  // the family collapse ever runs.
  const { runGh, calls } = makeRunGh({ stubs: realFamilyStubs(null) });
  const { result, stderr } = await captureStderr(() =>
    selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh }),
  );
  assertDeepEqual(result.entries, []);
  assertDeepEqual(result.deferred, []);
  for (const number of [1304, 1313, 1316, 1326, 1328]) {
    assert(
      stderr.includes(`skip #${number}: fix_scope`),
      `expected #${number} to be skipped on fix_scope`,
    );
  }
  // No refusal marker, no comment, no label FROM THE SELECT LEG — the whole
  // point of the done-means: an architectural stub must not accumulate
  // sentry:fix-refused, which is terminal and would stand its whole duplicate
  // family down behind it. The select leg is read-only; the record-run job owns
  // the exclusion-label backfill, and the human backlog is the REPORTED skip
  // (fresh architectural stubs settle open under the label, #1812).
  assertDeepEqual(writeCalls(calls), []);
  assert(
    !stderr.includes(FIX_REFUSED_LABEL),
    "an architectural skip must not even mention the refusal marker",
  );
});

await test("DONE-MEANS: a mechanical verdict IS selectable end-to-end", async () => {
  const stubs = [
    stub({
      number: 720,
      shortId: "ANALYTICS-MENTO-ORG-8B",
      comments: [verdictComment({ fixScope: FIX_SCOPE_MECHANICAL })],
    }),
  ];
  const batch = makeRunGh({ stubs });
  assertDeepEqual(
    await selectAutofixCandidates(
      { repo: "o/r", cap: 2 },
      { runGh: batch.runGh },
    ),
    [{ issue: 720, shortId: "ANALYTICS-MENTO-ORG-8B" }],
  );
  // The single-issue workflow_dispatch path runs the SAME filters.
  const single = makeRunGh({ stubs });
  assertDeepEqual(
    await selectAutofixCandidates(
      { repo: "o/r", issue: 720 },
      { runGh: single.runGh },
    ),
    [{ issue: 720, shortId: "ANALYTICS-MENTO-ORG-8B" }],
  );
});

await test("a single-issue dispatch cannot override the fix_scope gate", async () => {
  // Family collapse is deliberately batch-only, so a dispatch overrides THAT.
  // fix_scope is not a heuristic about which member to pick — it is the claim
  // that a scoped fix exists at all, so naming the issue must not bypass it.
  const stubs = [
    stub({
      number: 730,
      shortId: "ANALYTICS-MENTO-ORG-9C",
      comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  assertDeepEqual(
    await selectAutofixCandidates({ repo: "o/r", issue: 730 }, { runGh }),
    [],
  );
  assertDeepEqual(writeCalls(calls), []);
});

// ---------------------------------------------------------------------------
// Query-time exclusion of the architectural class (#1812). Settlement labels a
// held stub sentry:fix-scope-architectural, and listCodeFixStubs excludes it in
// the --search negation so the architectural backlog never enters the candidate
// window. This mock INTERPRETS the -label: negations against a fake store (a
// query-string string-assert is a broken control — it never proves the term
// changes the SELECTION), so removing the architectural term is a real behaviour
// change, reproducing #1813.
// ---------------------------------------------------------------------------

/** A gh mock whose candidate-window query APPLIES the `-label:"…"` negations in
 * the --search string against the fake store. `dropArchitecturalNegation`
 * simulates a selector query that lacks the architectural term (the in-test
 * control): the mock ignores that one negation, so labeled-architectural stubs
 * re-enter the window. Every stub here is a singleton family, so there are no
 * per-id in:title / in:comments probes to model. */
function makeNegationInterpretingRunGh({
  stubs,
  dropArchitecturalNegation = false,
} = {}) {
  const calls = [];
  const byNumber = new Map(stubs.map((s) => [String(s.number), s]));
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "list") {
      const searchIdx = args.indexOf("--search");
      const search = searchIdx === -1 ? "" : args[searchIdx + 1];
      // The per-id family probes (`"<ID>" in:title` / `"<ID>" in:comments`) are
      // NOT the candidate window — every fixture here is a singleton family, so
      // they surface nothing. Return [] before the negation filter so the window
      // interpretation only ever runs on the actual window query.
      if (/"[^"]+"\s+in:(title|comments)/.test(search)) return "[]";
      let negated = [...search.matchAll(/-label:"([^"]+)"/g)].map((m) => m[1]);
      if (dropArchitecturalNegation) {
        negated = negated.filter((n) => n !== FIX_SCOPE_ARCHITECTURAL_LABEL);
      }
      const rows = stubs
        .filter((s) => !negated.some((neg) => s.labels.includes(neg)))
        .slice(0, windowLimit(args));
      return JSON.stringify(
        rows.map((s) => ({
          number: s.number,
          title: s.title,
          createdAt: s.createdAt,
          labels: s.labels.map((name) => ({ name })),
        })),
      );
    }
    if (a0 === "issue" && a1 === "view") {
      const s = byNumber.get(String(args[2]));
      return JSON.stringify({
        number: s.number,
        title: s.title,
        body: "",
        labels: s.labels.map((name) => ({ name })),
        comments: s.comments,
      });
    }
    // Owner-qualified open-PR dedup lookup (#1810 replaced the fork-truncatable
    // `pr list --head` with the REST head filter). No fixture here has a
    // pre-existing autofix PR, so the query is always empty.
    if (a0 === "api") return JSON.stringify([]);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

/** MAX_CANDIDATE_EVALUATIONS OLDER labeled-architectural stubs + 1 NEWER
 * mechanical stub. Oldest-first, the architectural block fills the whole window
 * ahead of the mechanical one — the exact #1813 starvation shape. Sized to the
 * eval cap, not a literal 50, so the shape survives a window raise. */
function starvationStubs() {
  const arch = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS; i += 1) {
    const n = 200 + i;
    arch.push(
      stub({
        number: n,
        shortId: `ANALYTICS-MENTO-ORG-S${i}`,
        // Older than the mechanical stub, and carrying the settlement hold label.
        createdAt: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
        labels: [
          AUTOFIX_SELECT_LABEL,
          "sentry-triage",
          FIX_SCOPE_ARCHITECTURAL_LABEL,
        ],
        comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
      }),
    );
  }
  const mechanical = stub({
    number: 999,
    shortId: "ANALYTICS-MENTO-ORG-M1",
    createdAt: "2026-08-01T00:00:00Z",
    comments: [verdictComment({ fixScope: FIX_SCOPE_MECHANICAL })],
  });
  return { arch, all: [...arch, mechanical] };
}

await test("STARVATION REPRO: the label negation keeps a full window of architectural stubs out; only the mechanical selects, zero views on them (#1812/#1813)", async () => {
  const { arch, all } = starvationStubs();
  const { runGh, calls } = makeNegationInterpretingRunGh({ stubs: all });
  const { entries } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [{ issue: 999, shortId: "ANALYTICS-MENTO-ORG-M1" }]);
  // The architectural block never enters the window, so not one is READ.
  const archNumbers = new Set(arch.map((s) => String(s.number)));
  const viewedArch = calls.filter(
    (c) => c[0] === "issue" && c[1] === "view" && archNumbers.has(String(c[2])),
  );
  assertEqual(
    viewedArch.length,
    0,
    "no architectural stub may be read — they are excluded server-side",
  );
});

await test("CONTROL: dropping the architectural negation refills the window and starves the mechanical out of the FIRST pass; only the second look reaches it (#1813)", async () => {
  const { arch, all } = starvationStubs();
  // The ONLY change: the query no longer excludes the architectural label.
  const { runGh, calls } = makeNegationInterpretingRunGh({
    stubs: all,
    dropArchitecturalNegation: true,
  });
  const { entries, window, skipped } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // Oldest-first, the architectural block fills the WHOLE list ceiling and every
  // member is skipped on scope; the newer mechanical stub is past `--limit`, so
  // the first pass literally cannot see it. Before the bounded second look
  // existed this run selected NOTHING — forever, every run, since deferral and
  // scope skips both write nothing. That is #1813's starvation.
  assertEqual(
    skipped.length,
    MAX_CANDIDATE_EVALUATIONS,
    "the whole window is skipped on scope",
  );
  assertEqual(window.evaluated, MAX_CANDIDATE_EVALUATIONS);
  // What recovers it is the second look, and it says so.
  assertEqual(
    window.secondLook,
    true,
    "a zero-selection FULL window takes a second look",
  );
  assertEqual(window.secondLookEvaluated, 1, "exactly the one further stub");
  assertDeepEqual(entries, [{ issue: 999, shortId: "ANALYTICS-MENTO-ORG-M1" }]);
  // The mechanical stub is read ONLY after the second look's own list call, so
  // the recovery genuinely comes from there and not from a wider first window.
  assertEqual(
    windowListCount(calls),
    2,
    "one first-pass window list + one second-look window list",
  );
  const archNumbers = new Set(arch.map((st) => String(st.number)));
  const viewOrder = calls
    .filter((c) => c[0] === "issue" && c[1] === "view")
    .map((c) => String(c[2]));
  assertEqual(
    viewOrder.indexOf("999"),
    archNumbers.size,
    "the mechanical stub is read only after the whole first-pass window",
  );
});

await test("BACKSTOP: a window stub with the hold label hand-removed but an architectural verdict is still skipped, never selected (#1812)", async () => {
  // The label exclusion is the fast path; the verdict re-parse is the authority.
  // A human who removes the label (thinking that re-enables selection) does not
  // get a selection — evaluateCandidate re-parses fix_scope and skips it, and the
  // record-run re-applies the label. Model it as a stub that PASSES the query
  // (no hold label) but whose verdict is architectural.
  const stubs = [
    stub({
      number: 321,
      shortId: "ANALYTICS-MENTO-ORG-HR",
      // No FIX_SCOPE_ARCHITECTURAL_LABEL — hand-removed — so it passes the query.
      labels: [AUTOFIX_SELECT_LABEL, "sentry-triage"],
      comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
    }),
  ];
  const { runGh, calls } = makeNegationInterpretingRunGh({ stubs });
  const { entries, skipped } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertDeepEqual(skipped, [
    { issue: 321, reason: SKIP_FIX_SCOPE_ARCHITECTURAL },
  ]);
  // Read-only: it is skipped, never labeled/commented from the select leg.
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "edit"),
    "the select leg never writes",
  );
});

await test("CONNECTOR: an architectural-LABELED anchor surfaced via reverse search joins its mechanical siblings but never blocks them (#1812)", async () => {
  // A and C are mechanical candidates that declare NOTHING. B is the
  // architectural anchor that declares [A, C] — but B is now EXCLUDED from the
  // candidate window by its label, so the forward pass never sees its edges. The
  // reverse in:comments probe surfaces B, and because B carries the hold label it
  // is a pure CONNECTOR: its edges union A and C into one family, but it never
  // stands them down. So the family collapses to ONE run (A, oldest); C defers as
  // a family duplicate, not family-handled.
  const anchor = [
    {
      shortId: "ANALYTICS-MENTO-ORG-C0",
      label: FIX_SCOPE_ARCHITECTURAL_LABEL,
      declares: ["ANALYTICS-MENTO-ORG-C1", "ANALYTICS-MENTO-ORG-C2"],
    },
  ];
  const siblings = [
    stub({
      number: 501,
      shortId: "ANALYTICS-MENTO-ORG-C1",
      createdAt: "2026-07-01T00:00:00Z",
    }),
    stub({
      number: 502,
      shortId: "ANALYTICS-MENTO-ORG-C2",
      createdAt: "2026-07-02T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs: siblings, handled: anchor });
  const run = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(
    run.entries.map((e) => e.issue),
    [501],
    "the family collapses to ONE run (oldest sibling), not two",
  );
  assertDeepEqual(run.deferred, [
    { issue: 502, reason: DEFER_FAMILY_DUPLICATE },
  ]);

  // After A (#501) goes terminal, the SAME architectural connector now hands C a
  // handled blocker: C stands down as family-HANDLED (lifts when A regresses).
  const anchorPlusTerminal = [
    { shortId: "ANALYTICS-MENTO-ORG-C1", label: FIX_PR_OPENED_LABEL },
    {
      shortId: "ANALYTICS-MENTO-ORG-C0",
      label: FIX_SCOPE_ARCHITECTURAL_LABEL,
      declares: ["ANALYTICS-MENTO-ORG-C1", "ANALYTICS-MENTO-ORG-C2"],
    },
  ];
  const onlyC = [
    stub({
      number: 502,
      shortId: "ANALYTICS-MENTO-ORG-C2",
      createdAt: "2026-07-02T00:00:00Z",
    }),
  ];
  const terminal = makeRunGh({ stubs: onlyC, handled: anchorPlusTerminal });
  const run2 = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: terminal.runGh },
  );
  assertDeepEqual(run2.entries, []);
  assertDeepEqual(run2.deferred, [
    { issue: 502, reason: DEFER_FAMILY_HANDLED },
  ]);
});

await test("TERMINAL-WINS: a reverse-surfaced sibling carrying BOTH a terminal marker AND the architectural hold BLOCKS the family (#1812 Finding 3)", async () => {
  // Finding 3: a PRESENT terminal marker means a real terminal outcome — here an
  // open fix PR — so the family must stand down regardless of the architectural
  // hold; the hold makes a stub a pure connector ONLY when NEITHER terminal
  // marker is present. B declares finalist A and carries BOTH
  // sentry:fix-pr-opened AND sentry:fix-scope-architectural. A declares nothing,
  // so ONLY the reverse in:comments probe can reach B — the exact leg the dropped
  // `!architecturalLabel` guard lived on.
  //
  // The reverse `in:comments` hit carries B's CURRENT labels inline (read from
  // the same response), so `reverseVerifyFamilies` can and must decide the block
  // from them. The downstream handled-recheck that re-reads a surfaced member's
  // marker is a SEPARATE `in:title` query, subject to GitHub's title-index lag on
  // a freshly-labeled stub — modeled here with `matchTitleFor` pointing away, so
  // an `in:title` search for B's own id returns nothing. That isolates the fix:
  // the reverse blocker is the SOLE catch, and restoring the guard both drops it
  // AND leaves the lagging title-recheck empty, wrongly selecting A.
  const A = stub({ number: 760, shortId: "ANALYTICS-MENTO-ORG-TA" });
  const bothLabels = [
    {
      shortId: "ANALYTICS-MENTO-ORG-TB",
      labels: [FIX_PR_OPENED_LABEL, FIX_SCOPE_ARCHITECTURAL_LABEL],
      declares: ["ANALYTICS-MENTO-ORG-TA"],
      // in:title for TB is a tokenized/index-lag miss, so the title-recheck
      // backstop cannot re-catch it — only the inline reverse labels can.
      matchTitleFor: "ANALYTICS-MENTO-ORG-ZZ",
    },
  ];
  // Fixture anchor: the blocker genuinely carries BOTH markers, so restoring the
  // `!architecturalLabel` guard would treat it as a pure connector and bite this
  // assertion — not a vacuous pass.
  assert(
    bothLabels[0].labels.includes(FIX_PR_OPENED_LABEL) &&
      bothLabels[0].labels.includes(FIX_SCOPE_ARCHITECTURAL_LABEL),
    "the blocker fixture must carry both the terminal marker and the hold",
  );
  const held = makeRunGh({ stubs: [A], handled: bothLabels });
  const run = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: held.runGh },
  );
  assertDeepEqual(run.entries, []);
  assertDeepEqual(run.deferred, [{ issue: 760, reason: DEFER_FAMILY_HANDLED }]);
  assert(
    reverseSearchedFor(held.calls, "ANALYTICS-MENTO-ORG-TA"),
    "the reverse probe must have surfaced the both-labels sibling",
  );

  // Live counter-arm through the same production entry point: strip the terminal
  // marker so B carries ONLY the hold. Now B is a genuine pure connector — edges
  // only — so A is (correctly) SELECTED. The terminal marker is the load-bearing
  // difference between the two arms; the source-revert control below proves the
  // guard, not the fixture, is what turns the block on and off.
  const holdOnly = [
    {
      shortId: "ANALYTICS-MENTO-ORG-TB",
      labels: [FIX_SCOPE_ARCHITECTURAL_LABEL],
      declares: ["ANALYTICS-MENTO-ORG-TA"],
      matchTitleFor: "ANALYTICS-MENTO-ORG-ZZ",
    },
  ];
  const connector = makeRunGh({ stubs: [A], handled: holdOnly });
  const run2 = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: connector.runGh },
  );
  assertDeepEqual(run2.entries, [
    { issue: 760, shortId: "ANALYTICS-MENTO-ORG-TA" },
  ]);
  assertDeepEqual(run2.deferred, []);
  assert(
    reverseSearchedFor(connector.calls, "ANALYTICS-MENTO-ORG-TA"),
    "the reverse probe still runs in the connector-only control arm",
  );
});

await test("a mechanical candidate flows through family dedupe AND the fix_scope gate together", async () => {
  // The gate runs per-candidate, BEFORE the collapse: an architectural
  // representative is not "the family's one run", it is simply not a candidate.
  // Here 2E (the oldest, highest in-degree member) is architectural and the four
  // siblings are mechanical — so the family still collapses to ONE run, and it
  // is the oldest surviving member rather than nothing at all.
  const stubs = realFamilyStubs();
  stubs[0] = familyStub(
    1304,
    "ANALYTICS-MENTO-ORG-2E",
    "2026-07-16T17:27:24Z",
    FAMILY_2E_DUPLICATES,
    FIX_SCOPE_ARCHITECTURAL,
  );
  const { runGh, calls } = makeRunGh({ stubs });
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [
    { issue: 1313, shortId: "ANALYTICS-MENTO-ORG-2F" },
  ]);
  assertDeepEqual(
    deferred.map((d) => d.issue),
    [1316, 1326, 1328],
  );
  assertEqual(deferred[0].reason, DEFER_FAMILY_DUPLICATE);
  assertDeepEqual(writeCalls(calls), []);
});

await test("an architectural skip is not terminal: the same stub selects once re-triaged mechanical", async () => {
  // A refusal marker would be terminal until a human cleared it, and would
  // stand the whole family down behind it. The skip writes nothing, so the next
  // run recomputes from live state — which is what makes `architectural` a
  // backlog item rather than a burned candidate.
  const architectural = makeRunGh({
    stubs: [
      stub({
        number: 740,
        shortId: "ANALYTICS-MENTO-ORG-AD",
        comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
      }),
    ],
  });
  assertDeepEqual(
    await selectAutofixCandidates(
      { repo: "o/r" },
      { runGh: architectural.runGh },
    ),
    [],
  );
  const retriaged = makeRunGh({
    stubs: [
      stub({
        number: 740,
        shortId: "ANALYTICS-MENTO-ORG-AD",
        // Same stub, same labels, a newer verdict comment that names a scope.
        comments: [
          verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL }),
          verdictComment({
            createdAt: "2026-07-19T00:00:00Z",
            fixScope: FIX_SCOPE_MECHANICAL,
          }),
        ],
      }),
    ],
  });
  assertDeepEqual(
    await selectAutofixCandidates({ repo: "o/r" }, { runGh: retriaged.runGh }),
    [{ issue: 740, shortId: "ANALYTICS-MENTO-ORG-AD" }],
  );
});

await test("the reconcile path survives an architectural verdict", async () => {
  // The gate sits AFTER the reconcile branch on purpose. Reconciliation runs no
  // agent and opens no PR — it repairs the queue bookkeeping for a PR that
  // already exists. Gating it here would strand that PR unlinked forever if a
  // re-triage changed the scope under it.
  const { runGh } = makeRunGh({
    stubs: [
      stub({
        number: 750,
        shortId: "ANALYTICS-MENTO-ORG-BE",
        comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
      }),
    ],
    prShortIds: ["ANALYTICS-MENTO-ORG-BE"],
  });
  assertDeepEqual(await selectAutofixCandidates({ repo: "o/r" }, { runGh }), [
    { issue: 750, shortId: "ANALYTICS-MENTO-ORG-BE", reconcile: true },
  ]);
});

// ---------------------------------------------------------------------------
// A fix_scope skip must not delete the stub's duplicate_of EDGES, and must be
// REPORTED. Both halves are about what a bare `return null` silently did:
// dropping the record dropped its family edges, and dropping the record dropped
// the only evidence the run stood anything down.
// ---------------------------------------------------------------------------

/** An architectural ANCHOR that fans out: #900 names A1 and A2, and neither
 * sibling back-points at it. The edges live ONLY on the architectural stub. */
function fanOutFamilyStubs(anchorScope) {
  return [
    stub({
      number: 900,
      shortId: "ANALYTICS-MENTO-ORG-A0",
      createdAt: "2026-07-01T00:00:00Z",
      comments: [
        verdictComment({
          createdAt: "2026-07-01T00:00:00Z",
          duplicates: ["ANALYTICS-MENTO-ORG-A1", "ANALYTICS-MENTO-ORG-A2"],
          fixScope: anchorScope,
        }),
      ],
    }),
    stub({
      number: 901,
      shortId: "ANALYTICS-MENTO-ORG-A1",
      createdAt: "2026-07-02T00:00:00Z",
    }),
    stub({
      number: 902,
      shortId: "ANALYTICS-MENTO-ORG-A2",
      createdAt: "2026-07-03T00:00:00Z",
    }),
  ];
}

await test("DONE-MEANS: an architectural stub still carries its family's edges", async () => {
  // The load-bearing direction of the graph, and the one a bare skip broke: the
  // ONLY stub naming the siblings is the one the gate rules out. Drop its record
  // and the family has no edges left — three independent candidates, so two
  // agent runs and two PRs for one root cause, which is #1784's guarantee
  // silently reopened. It must collapse exactly as if the anchor were
  // mechanical: one candidate, the rest deferred.
  const architectural = makeRunGh({
    stubs: fanOutFamilyStubs(FIX_SCOPE_ARCHITECTURAL),
  });
  const run = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: architectural.runGh },
  );
  assertDeepEqual(
    run.entries.map((entry) => entry.issue),
    [901],
  );
  assertDeepEqual(run.deferred, [
    { issue: 902, reason: DEFER_FAMILY_DUPLICATE },
  ]);
  // The ruled-out anchor is reported as a SKIP, never as a family deferral: the
  // two lift on different events (a sibling's marker vs. a re-triage).
  assertDeepEqual(run.skipped, [
    { issue: 900, reason: SKIP_FIX_SCOPE_ARCHITECTURAL },
  ]);
  // ... and it is never emitted, however the collapse decided about it.
  assert(
    !run.entries.some((entry) => entry.issue === 900),
    "the architectural anchor must never reach the matrix",
  );

  // Control on the same window: with a MECHANICAL anchor the family is
  // identical, so any difference beyond "who represents it" is edge loss.
  const mechanical = makeRunGh({
    stubs: fanOutFamilyStubs(FIX_SCOPE_MECHANICAL),
  });
  const baseline = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: mechanical.runGh },
  );
  assertEqual(
    baseline.entries.length,
    run.entries.length,
    "the family must consume one candidate slot either way",
  );
});

await test("DONE-MEANS: a handled sibling reachable only through an architectural hop still stands the family down", async () => {
  // Worse than fan-out. `ANALYTICS-MENTO-ORG-B0` already carries
  // `sentry:fix-refused`, so it is outside the candidate window and reachable
  // ONLY through listHandledShortIds — and the only stub naming it is
  // architectural. Drop that stub's edges and #912 unions with nobody: a fresh
  // agent run on a family the leg already refused, which is the exact path the
  // only real data took.
  const handled = [
    { shortId: "ANALYTICS-MENTO-ORG-B0", label: FIX_REFUSED_LABEL },
  ];
  const hopStubs = (hopScope) => [
    stub({
      number: 911,
      shortId: "ANALYTICS-MENTO-ORG-B1",
      createdAt: "2026-07-01T00:00:00Z",
      comments: [
        verdictComment({
          createdAt: "2026-07-01T00:00:00Z",
          duplicates: ["ANALYTICS-MENTO-ORG-B0"],
          fixScope: hopScope,
        }),
      ],
    }),
    stub({
      number: 912,
      shortId: "ANALYTICS-MENTO-ORG-B2",
      createdAt: "2026-07-02T00:00:00Z",
      comments: [
        verdictComment({
          createdAt: "2026-07-02T00:00:00Z",
          duplicates: ["ANALYTICS-MENTO-ORG-B1"],
          fixScope: FIX_SCOPE_MECHANICAL,
        }),
      ],
    }),
  ];

  const { runGh } = makeRunGh({
    stubs: hopStubs(FIX_SCOPE_ARCHITECTURAL),
    handled,
  });
  const run = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(run.entries, []);
  assertDeepEqual(run.deferred, [{ issue: 912, reason: DEFER_FAMILY_HANDLED }]);
  assertDeepEqual(run.skipped, [
    { issue: 911, reason: SKIP_FIX_SCOPE_ARCHITECTURAL },
  ]);

  // Control: with a mechanical hop the whole family stands down the same way.
  const control = makeRunGh({
    stubs: hopStubs(FIX_SCOPE_MECHANICAL),
    handled,
  });
  const baseline = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: control.runGh },
  );
  assertDeepEqual(baseline.entries, []);
});

await test("DONE-MEANS: a window standing entirely down on fix_scope is reported, not silent", async () => {
  // The steady state this gate ships: every verdict predating the field reads
  // as architectural. Unreported, the run record renders `Candidates selected:
  // 0, Deferred: 0` — byte-identical to an empty queue, and to "the prompt
  // change never landed". That is the #1758 misdiagnosis.
  const { runGh, calls } = makeRunGh({ stubs: realFamilyStubs(null) });
  const run = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(run.entries, []);
  assertDeepEqual(run.deferred, []);
  assertDeepEqual(
    run.skipped,
    [1304, 1313, 1316, 1326, 1328].map((issue) => ({
      issue,
      reason: SKIP_FIX_SCOPE_ARCHITECTURAL,
    })),
  );
  // Reporting is not a write: the skip still touches nothing on the queue.
  assertDeepEqual(writeCalls(calls), []);
});

await test("DONE-MEANS: a single-issue dispatch reports its fix_scope skip", async () => {
  // The dispatch is the documented remedy for a stalled leg, and it cannot
  // override this gate — so if it also reported nothing, the remedy for a silent
  // stall would itself be silent.
  const { runGh } = makeRunGh({
    stubs: [
      stub({
        number: 930,
        shortId: "ANALYTICS-MENTO-ORG-D1",
        comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
      }),
    ],
  });
  const run = await selectAutofixRun({ repo: "o/r", issue: 930 }, { runGh });
  assertDeepEqual(run.entries, []);
  assertDeepEqual(run.skipped, [
    { issue: 930, reason: SKIP_FIX_SCOPE_ARCHITECTURAL },
  ]);
});

await test("an INELIGIBLE stub reports a skip, never a family deferral", async () => {
  // One architectural stub with no family at all. It must land in `skipped`,
  // and `deferred` must stay empty — the run record renders them as separate
  // lines because an operator acts on them differently.
  const { runGh } = makeRunGh({
    stubs: [
      stub({
        number: 940,
        shortId: "ANALYTICS-MENTO-ORG-E1",
        comments: [verdictComment({ fixScope: FIX_SCOPE_ARCHITECTURAL })],
      }),
    ],
  });
  const run = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(run.deferred, []);
  assertDeepEqual(run.skipped, [
    { issue: 940, reason: SKIP_FIX_SCOPE_ARCHITECTURAL },
  ]);
});

await test("parseArgs accepts --skipped-out beside --deferred-out", async () => {
  const options = parseArgs([
    "--deferred-out",
    "/tmp/d.json",
    "--skipped-out",
    "/tmp/s.json",
  ]);
  assertEqual(options.deferredOut, "/tmp/d.json");
  assertEqual(options.skippedOut, "/tmp/s.json");
  // Absent by default: a caller that does not ask for the report gets no file.
  assertEqual(parseArgs([]).skippedOut, null);
});

// ---------------------------------------------------------------------------
// The window ceiling, the bounded second look, the gh-call instrumentation, and
// failing CLOSED on throttling.
// ---------------------------------------------------------------------------

await test("PIN: MAX_CANDIDATE_EVALUATIONS may never exceed LIST_LIMIT (a raise above it is a strict no-op)", () => {
  // `gh issue list --limit LIST_LIMIT` caps what the API RETURNS, and that
  // happens BEFORE the eval slice. So a window raised above the list ceiling
  // reads exactly LIST_LIMIT rows, reports `total == evaluated`, and NOTHING
  // says the raise did nothing — the silent no-op this pin exists to prevent.
  // The two constants must move together.
  assert(
    MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT,
    `MAX_CANDIDATE_EVALUATIONS (${MAX_CANDIDATE_EVALUATIONS}) must not exceed LIST_LIMIT (${LIST_LIMIT}) — raise LIST_LIMIT too or the window raise is a no-op`,
  );
});

await test("windowCeilingWarning is silent at the shipped pair and LOUD on a mismatch", () => {
  // The run-time half of the pin above. It warns rather than throws: the select
  // step's contract is that it always emits a valid JSON array and never fails,
  // so a static config mistake must not be able to break the leg.
  assertEqual(windowCeilingWarning(), null, "the shipped pair is consistent");
  assertEqual(windowCeilingWarning(200, 200), null, "equal is fine");
  const warning = windowCeilingWarning(400, 200);
  assert(warning != null, "a window above the list ceiling must warn");
  assert(
    warning.includes("400") && warning.includes("200"),
    `the warning must name BOTH numbers, got: ${warning}`,
  );
});

/**
 * A FULL first window in which NOTHING is selectable (every stub is skipped on
 * fix_scope), plus `further` selectable stubs sitting PAST the list ceiling.
 * This is the starvation signature exactly: the run selects nothing, writes
 * nothing, and the next run reads the same window — so without a second look the
 * further stubs are never evaluated, at any point, ever.
 *
 * `hubsPerWindowStub` gives the blocked window stubs declared family ids, which
 * is what drives the first pass's handled-id budget (an architectural stub still
 * contributes its family edges).
 */
function starvedWindowStubs({
  further = 1,
  hubsPerWindowStub = 0,
  hubsPerFurtherStub = 0,
} = {}) {
  const stubs = [];
  for (let i = 0; i < LIST_LIMIT; i += 1) {
    const hubs = Array.from(
      { length: hubsPerWindowStub },
      (_, j) => `ANALYTICS-MENTO-ORG-WH${i}X${j}`,
    );
    stubs.push(
      familyStub(
        7000 + i,
        `ANALYTICS-MENTO-ORG-Z${i}`,
        orderedCreatedAt(i),
        hubs,
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  for (let i = 0; i < further; i += 1) {
    const hubs = Array.from(
      { length: hubsPerFurtherStub },
      (_, j) => `ANALYTICS-MENTO-ORG-FH${i}X${j}`,
    );
    stubs.push(
      familyStub(
        7500 + i,
        `ANALYTICS-MENTO-ORG-Y${i}`,
        orderedCreatedAt(LIST_LIMIT + i),
        hubs,
      ),
    );
  }
  return stubs;
}

await test("SECOND LOOK: a zero-selection FULL window reaches past the list ceiling and selects", async () => {
  // NEGATIVE CONTROL: change the fire condition in selectAutofixRun from
  // `entries.length === 0 && page.full` to `false` (or drop `page.full`'s
  // `rawCount >= limit` in listCodeFixStubsPage) and this returns [] — the
  // permanent starvation the second look exists to break.
  const stubs = starvedWindowStubs({ further: 3 });
  const { runGh, calls } = makeRunGh({ stubs });
  const { entries, window, skipped } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertEqual(
    skipped.length,
    LIST_LIMIT,
    "the whole first window stands down on scope",
  );
  assertEqual(window.secondLook, true, "the second look must have run");
  assertEqual(window.secondLookTotal, 3);
  assertEqual(window.secondLookEvaluated, 3);
  assertDeepEqual(entries, [
    { issue: 7500, shortId: "ANALYTICS-MENTO-ORG-Y0" },
    { issue: 7501, shortId: "ANALYTICS-MENTO-ORG-Y1" },
  ]);
  assertEqual(
    windowListCount(calls),
    2,
    "exactly ONE extra window list — the second look is not a retry loop",
  );
});

await test("SECOND LOOK: the FULL-page signal is taken off RAW rows, not the project-filtered ones", async () => {
  // `--limit` is applied server-side, BEFORE the client-side
  // `parseProject === LOCAL_SENTRY_PROJECT` gate. So a genuinely full page can
  // come back short once foreign-project rows are dropped, and a `full` signal
  // keyed on the filtered length would read "there is nothing more" on exactly
  // the window that has the most hidden behind it.
  //
  // NEGATIVE CONTROL: change `full` in listCodeFixStubsPage from
  // `list.length >= limit` to `stubs.length >= limit` and this returns [] — the
  // starvation survives untouched, and NO other test notices.
  const stubs = [];
  for (let i = 0; i < LIST_LIMIT - 5; i += 1) {
    stubs.push(
      familyStub(
        8300 + i,
        `ANALYTICS-MENTO-ORG-P${i}`,
        orderedCreatedAt(i),
        [],
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  // Five rows the server returns (they match the tokenized `<slug> in:title`
  // filter) but the exact project gate drops.
  for (let i = 0; i < 5; i += 1) {
    stubs.push({
      number: 8000 + i,
      shortId: `APP-MENTO-ORG-X${i}`,
      title: `[sentry] APP-MENTO-ORG-X${i} (app-mento-org, error)`,
      labels: [AUTOFIX_SELECT_LABEL, "sentry-triage"],
      createdAt: orderedCreatedAt(LIST_LIMIT - 5 + i),
      comments: [verdictComment()],
    });
  }
  stubs.push(
    stub({
      number: 8999,
      shortId: "ANALYTICS-MENTO-ORG-PZ",
      createdAt: orderedCreatedAt(LIST_LIMIT + 1),
    }),
  );
  const { runGh } = makeRunGh({ stubs });
  const { entries, window } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertEqual(
    window.total,
    LIST_LIMIT - 5,
    "the project gate really did shorten the page",
  );
  assertEqual(
    window.secondLook,
    true,
    "a RAW-full page still takes a second look",
  );
  assertDeepEqual(entries, [
    { issue: 8999, shortId: "ANALYTICS-MENTO-ORG-PZ" },
  ]);
});

await test("SECOND LOOK: a healthy run that selected anything never fires it (it must cost nothing)", async () => {
  // The whole licence for adding a second pass is that a normal run pays zero
  // for it. One selectable stub at the head of the window is enough.
  const stubs = starvedWindowStubs({ further: 3 });
  stubs.unshift(
    stub({
      number: 6999,
      shortId: "ANALYTICS-MENTO-ORG-OK",
      createdAt: "2026-07-01T00:00:00Z",
    }),
  );
  const { runGh, calls } = makeRunGh({ stubs });
  const { entries, window } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [
    { issue: 6999, shortId: "ANALYTICS-MENTO-ORG-OK" },
  ]);
  assertEqual(window.secondLook, false, "a selecting run takes no second look");
  assertEqual(
    windowListCount(calls),
    1,
    "no second window list is issued on a healthy run",
  );
});

await test("SECOND LOOK: a window that is NOT full never fires it (there is nothing past the ceiling)", async () => {
  // Zero selections alone is not the signature — a SHORT page means the run
  // already saw every stub there is, so a second look could only re-read them.
  const stubs = [];
  for (let i = 0; i < 5; i += 1) {
    stubs.push(
      familyStub(
        7800 + i,
        `ANALYTICS-MENTO-ORG-N${i}`,
        orderedCreatedAt(i),
        [],
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  const { runGh, calls } = makeRunGh({ stubs });
  const { entries, window } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertEqual(
    window.secondLook,
    false,
    "a short page cannot hide further stubs",
  );
  assertEqual(windowListCount(calls), 1);
});

await test("SECOND LOOK: its OWN shortfall is reported through `full`, which does NOT saturate", async () => {
  // The second look stops at its own row ceiling, so it can leave stubs unread
  // exactly like the first window — and must say so on the same surface. The
  // counts CANNOT carry that: `secondLookTotal` is clamped by
  // SECOND_LOOK_LIST_ROWS by construction, so it reads identically whether 5 or
  // 5,000 further stubs sit past the ceiling. `full` (raw rows >= the row cap)
  // is the signal that distinguishes them, and the run record's regrowth
  // tripwire is built on it.
  //
  // NEGATIVE CONTROL: stop returning `full` from resolveSecondLook (or drop
  // `window.secondLookFull = second.full === true`) and the first assertion goes
  // false — the tracker then reads "reached the end of the queue" on the run
  // with the most hidden behind it.
  const many = starvedWindowStubs({ further: SECOND_LOOK_LIST_ROWS + 5 });
  const { window: deep } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: makeRunGh({ stubs: many }).runGh },
  );
  assertEqual(deep.secondLook, true);
  assertEqual(
    deep.secondLookTotal,
    SECOND_LOOK_LIST_ROWS,
    "the second look reads at most its own row cap",
  );
  assertEqual(
    deep.secondLookFull,
    true,
    "more rows sit past even the second look",
  );

  // The contrast that makes the flag mean something: a second look that reached
  // the actual end of the queue must NOT raise it.
  const few = starvedWindowStubs({ further: 3 });
  const { window: shallow } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh: makeRunGh({ stubs: few }).runGh },
  );
  assertEqual(shallow.secondLook, true);
  assertEqual(
    shallow.secondLookFull,
    false,
    "a short second-look page means the run really did reach the end",
  );
});

await test("SECOND LOOK: `full` is a SENTINEL fact — a queue EXACTLY at the ceiling is not 'more remains'", async () => {
  // The boundary the plain `rawCount >= limit` form gets wrong, and the whole
  // reason this pass reads ONE row past its own ceiling. `full` is published on
  // the tracker as `— and MORE rows sit past even that`, the standing regrowth
  // tripwire: a definite claim that the queue is outgrowing one run's reach.
  // At EXACTLY `skip + SECOND_LOOK_LIST_ROWS` raw rows nothing sits past the
  // second look, so the claim is false — and false PERMANENTLY, because that
  // state is stable: the operator is told to act on growth that is not there.
  //
  // NEGATIVE CONTROL: drop `sentinel: true` from resolveSecondLook's list call,
  // or revert `full` in listCodeFixStubsPage to `list.length >= limit`, and the
  // exactly-at-the-ceiling assertion below flips to true while the one-row-past
  // assertion stays true — the flag stops distinguishing the two states at all.
  const skip = Math.min(MAX_CANDIDATE_EVALUATIONS, LIST_LIMIT);
  assertEqual(
    skip,
    LIST_LIMIT,
    "starvedWindowStubs fills exactly LIST_LIMIT window rows, so the offset must be that",
  );

  // Exactly at the ceiling: skip + SECOND_LOOK_LIST_ROWS raw rows, none beyond.
  const { window: exact } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    {
      runGh: makeRunGh({
        stubs: starvedWindowStubs({ further: SECOND_LOOK_LIST_ROWS }),
      }).runGh,
    },
  );
  assertEqual(exact.secondLook, true, "the second look must have run");
  assertEqual(
    exact.secondLookTotal,
    SECOND_LOOK_LIST_ROWS,
    "and it must have read its whole row cap, or the boundary is not exercised",
  );
  assertEqual(
    exact.secondLookFull,
    false,
    "a queue that ENDS at the ceiling must not be reported as having more past it",
  );

  // One row beyond: the sentinel comes back, and the claim becomes true.
  const { window: past } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    {
      runGh: makeRunGh({
        stubs: starvedWindowStubs({ further: SECOND_LOOK_LIST_ROWS + 1 }),
      }).runGh,
    },
  );
  assertEqual(
    past.secondLookTotal,
    SECOND_LOOK_LIST_ROWS,
    "the counts are identical either side of the boundary — only `full` moves",
  );
  assertEqual(
    past.secondLookFull,
    true,
    "ONE row past the ceiling must be reported as more remaining",
  );
});

await test("PIN: MAX_SECOND_LOOK_EVALUATIONS may never exceed SECOND_LOOK_LIST_ROWS (the same no-op trap, on the pass this leg added)", () => {
  // The invariant that `MAX_CANDIDATE_EVALUATIONS <= LIST_LIMIT` pins is
  // GENERIC — the row cap is applied server-side BEFORE the evaluation slice —
  // but the guard for it was not: the second look shipped its own row cap with
  // no pin and no run-time check, so raising its evaluation cap to 300 would
  // silently read the same rows. That is precisely the failure mode this whole
  // change exists to make impossible, reintroduced in the module it added.
  assert(
    MAX_SECOND_LOOK_EVALUATIONS <= SECOND_LOOK_LIST_ROWS,
    `MAX_SECOND_LOOK_EVALUATIONS (${MAX_SECOND_LOOK_EVALUATIONS}) must not exceed SECOND_LOOK_LIST_ROWS (${SECOND_LOOK_LIST_ROWS}) — raise the row cap too or the raise is a no-op`,
  );
  assertEqual(
    secondLookCeilingWarning(),
    null,
    "the shipped pair is consistent",
  );
  assertEqual(secondLookCeilingWarning(100, 100), null, "equal is fine");
  const warning = secondLookCeilingWarning(300, 100);
  assert(
    typeof warning === "string" &&
      warning.includes("300") &&
      warning.includes("100"),
    `a raise above the row cap must warn and name both numbers, got: ${warning}`,
  );
});

await test("SECOND LOOK: the list it issues asks for exactly the rows past what the FIRST pass consumed", async () => {
  // Two things no assertion on `calls.length` can see, because the mock returns
  // a whole array from one call and `calls.length` is structurally invariant to
  // `--limit`:
  //   1. the `--limit` is the only term that makes gh INVOCATIONS and API
  //      REQUESTS differ, so the cost pin below is blind to it;
  //   2. the offset must derive from what the first pass actually consumed, not
  //      from LIST_LIMIT. They are equal today, but under a LOWER eval cap a
  //      LIST_LIMIT skip would jump the rows between the two — read by neither
  //      pass, a permanent hole in the middle of the window.
  //   3. the trailing `+ 1` is the SENTINEL row that makes `full` a fact rather
  //      than a guess, and it is the entire API-request delta the cost bound
  //      documents (301 rows = 4 pages, not 3).
  //
  // NEGATIVE CONTROL: change `skipRawRows` back to `LIST_LIMIT` while lowering
  // MAX_CANDIDATE_EVALUATIONS, or drop `skipRawRows` so the second look re-reads
  // from row 0, and the offset assertion below fails; drop `sentinel: true` and
  // the same assertion fails on the `+ 1`.
  const stubs = starvedWindowStubs({ further: 3 });
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  const windowLists = calls.filter(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      /sort:created-asc/.test(String(c[c.indexOf("--search") + 1] ?? "")),
  );
  assertEqual(windowLists.length, 2, "one first-pass list, one second look");
  const expectedSkip = Math.min(MAX_CANDIDATE_EVALUATIONS, LIST_LIMIT);
  assertEqual(
    windowLimit(windowLists[0]),
    LIST_LIMIT,
    "the first pass asks for the list ceiling",
  );
  assertEqual(
    windowLimit(windowLists[1]),
    expectedSkip + SECOND_LOOK_LIST_ROWS + 1,
    "the second look asks for the first pass's offset PLUS its own row cap PLUS the sentinel row",
  );
});

await test("SECOND LOOK: it runs on its OWN family budgets, not the first pass's", async () => {
  // The first pass has SPENT the per-run budgets by the time this runs, so
  // reusing them would silently double the run's worst-case gh volume — the
  // exact thing the timeout arithmetic is sized against.
  //
  // NEGATIVE CONTROL: drop the `budgets: SECOND_LOOK_FAMILY_BUDGETS` argument in
  // selectAutofixRun's second-look `resolveFamilies` call and the handled
  // in:title count jumps from 20 to MAX_HANDLED_ID_QUERIES (40), failing the
  // assertion below.
  const stubs = starvedWindowStubs({
    further: MAX_SECOND_LOOK_EVALUATIONS,
    hubsPerFurtherStub: 5,
  });
  const { runGh, calls } = makeRunGh({ stubs });
  const { window } = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertEqual(window.secondLook, true);
  // The window stubs declare nothing, so every in:title search below belongs to
  // the second look.
  assertEqual(
    titleSearchCount(calls),
    SECOND_LOOK_FAMILY_BUDGETS.handled,
    `the second look must saturate AND stop at its own handled budget (${SECOND_LOOK_FAMILY_BUDGETS.handled}), got ${titleSearchCount(calls)}`,
  );
  assert(
    SECOND_LOOK_FAMILY_BUDGETS.handled < MAX_HANDLED_ID_QUERIES,
    "the second-look budget must be strictly smaller, or this proves nothing",
  );
});

await test("cost pin: a full first pass PLUS a second look stays under the 25-minute timeout arithmetic", async () => {
  // The constraint the second look was sized against: first pass + second look
  // worst case must fit well inside `timeout-minutes: 25` at a pessimistic
  // ~1 s/call, every call being serial. The first pass here saturates its
  // handled-id budget (each blocked window stub declares 5 hubs) and the second
  // look saturates its own.
  const stubs = starvedWindowStubs({
    further: MAX_SECOND_LOOK_EVALUATIONS,
    hubsPerWindowStub: 5,
    hubsPerFurtherStub: 5,
  });
  const { runGh, calls } = makeRunGh({ stubs });
  const { window } = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertEqual(
    window.secondLook,
    true,
    "this pin must actually take a second look",
  );
  assert(
    calls.length > DOCUMENTED_GH_CEILING,
    `the second look must genuinely add spend, or the pin is vacuous (got ${calls.length})`,
  );
  assert(
    calls.length <= DOCUMENTED_GH_CEILING_WITH_SECOND_LOOK,
    `first pass + second look must stay under ${DOCUMENTED_GH_CEILING_WITH_SECOND_LOOK} serial gh calls, got ${calls.length}`,
  );
});

await test("INSTRUMENTATION: the run reports the gh invocation count it actually made", async () => {
  // The per-run gh ceiling was arithmetic over caps that nothing measured. This
  // makes it an observed number on the run record, so drift shows up before a
  // timeout does.
  //
  // NEGATIVE CONTROL: drop `state.ghCalls += 1` from instrumentRunGh and this
  // reports 0 against a nonzero real count.
  const stubs = [
    stub({ number: 8100, shortId: "ANALYTICS-MENTO-ORG-I1" }),
    stub({ number: 8101, shortId: "ANALYTICS-MENTO-ORG-I2" }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  const { window } = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assert(calls.length > 0, "the fixture must issue real calls");
  assertEqual(
    window.ghCalls,
    calls.length,
    "the reported count must equal the invocations actually made",
  );
});

await test("isRateLimitFailure matches what gh actually prints, and nothing else", () => {
  // gh puts the whole HTTP/GraphQL error body into its stderr, which
  // defaultRunGh folds into the rejection message.
  for (const message of [
    "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234. (https://api.github.com/rate_limit)",
    "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.",
    "gh issue list failed with exit 1:\nHTTP 429 Too Many Requests",
    "gh issue list failed with exit 1:\nGraphQL: API rate limit exceeded for user ID 1234. (rateLimitExceeded)",
    "gh api failed with exit 1:\nYou have triggered an abuse detection mechanism.",
  ]) {
    assert(isRateLimitFailure(message), `must match: ${message}`);
  }
  for (const message of [
    "gh api repos/o/r/pulls failed with exit 1: read ECONNRESET",
    "gh issue view 5 failed with exit 1:\nHTTP 404: Not Found",
    "gh issue list failed with exit 1:\nHTTP 502 Bad Gateway",
    "gh: command not found",
    "",
  ]) {
    assert(
      !isRateLimitFailure(message),
      `must NOT match (it would degrade ordinary transients): ${message}`,
    );
  }
});

/** A candidate whose family sibling already carries a TERMINAL marker — so the
 * ONLY thing standing between this run and a duplicate autofix PR is the
 * handled-id lookup that finds the sibling. */
function dedupeBlockedFixture(handledLookupErrorMessage) {
  const candidate = familyStub(
    8200,
    "ANALYTICS-MENTO-ORG-DL",
    "2026-07-10T00:00:00Z",
    ["ANALYTICS-MENTO-ORG-DS"],
  );
  return makeRunGh({
    stubs: [candidate],
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-DS", label: FIX_REFUSED_LABEL }],
    handledLookupErrorIds: ["ANALYTICS-MENTO-ORG-DS"],
    handledLookupErrorMessage,
  });
}

await test("DANGER CONTROL: a fail-soft dedupe read that returns nothing SELECTS the stub (this is the duplicate-PR path)", async () => {
  // Establishes the hazard the fail-closed change exists for: every dedupe read
  // fails soft toward MORE candidates, so a read that does not answer looks
  // exactly like "no blocker". With an ordinary transient that is the right
  // trade (one self-terminating extra attempt) and stays unchanged.
  const { runGh } = dedupeBlockedFixture(
    "gh issue list failed with exit 1: read ECONNRESET",
  );
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [
    { issue: 8200, shortId: "ANALYTICS-MENTO-ORG-DL" },
  ]);
  assertEqual(
    truncations.rateLimited,
    0,
    "an ordinary transient is not a degradation",
  );
});

await test("FAIL CLOSED: the SAME read failing with a rate limit emits ZERO entries and reports the degradation", async () => {
  // Identical topology, identical fail-soft plumbing — only the failure TEXT
  // differs. A throttled run cannot tell "no prior PR / no terminal sibling"
  // from "GitHub refused to answer", so it must not select at all; otherwise it
  // opens a duplicate autofix PR and still looks green.
  //
  // NEGATIVE CONTROL: drop the `isRateLimitFailure` branch in instrumentRunGh
  // (or the `state.rateLimited > 0` bail in selectAutofixRun) and this returns
  // the SAME entry the control above does — the duplicate.
  const { runGh } = dedupeBlockedFixture(
    "gh issue list failed with exit 1:\nHTTP 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.",
  );
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  // The invariant the workflow header asserts: ALWAYS a valid array, NEVER a
  // throw. "Fail closed" here is an empty array plus a loud report.
  assert(Array.isArray(entries), "the leg must still emit a valid array");
  assertDeepEqual(entries, []);
  assert(
    truncations.rateLimited > 0,
    "the degradation must be reported, not silent",
  );
});

await test("FAIL CLOSED: a rate-limited single-issue dispatch emits ZERO entries too", async () => {
  // The dispatch path dedupes on the SAME open-PR read, so a throttled one can
  // open a duplicate just as easily. The documented remedy for a stalled leg
  // must not become the way a duplicate gets in.
  const stubs = [stub({ number: 8300, shortId: "ANALYTICS-MENTO-ORG-DP" })];
  const { runGh } = makeRunGh({
    stubs,
    openPrError:
      "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234.",
  });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", issue: 8300 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assert(truncations.rateLimited > 0, "the dispatch degradation is reported");
});

await test("FAIL CLOSED: a degraded first pass never spends a second look", async () => {
  // The first pass's dedupe reads are already untrustworthy; a second look could
  // only widen the blast radius while burning the budget that made the raise
  // affordable.
  const stubs = starvedWindowStubs({ further: 3 });
  const { runGh, calls } = makeRunGh({
    stubs,
    openPrError:
      "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234.",
  });
  const { entries, window } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertEqual(window.secondLook, false, "a degraded run takes no second look");
  assertEqual(
    windowListCount(calls),
    1,
    "no second window list is issued once the run is degraded",
  );
});

// ---------------------------------------------------------------------------
// Hardening round: the second look's throw site, the throttle latch, the
// knowledge it inherits, and the CLI layer that carries the degraded signal.
// ---------------------------------------------------------------------------

function isWindowListArgs(args) {
  return (
    args[0] === "issue" &&
    args[1] === "list" &&
    /sort:created-asc/.test(String(args[args.indexOf("--search") + 1] ?? ""))
  );
}

/**
 * A FULL, entirely-unselectable first window whose head stub declares BLK (a
 * sibling that already carries a TERMINAL marker), plus five selectable stubs
 * past the ceiling. The LAST of those five also declares BLK — so it is a member
 * of a family this same run has already proven is handled.
 *
 * The four before it exist to spend the second look's whole handled-id budget
 * (MAX_DUPLICATE_LOOKUPS = 5 declared ids each × 4 = 20 =
 * SECOND_LOOK_FAMILY_BUDGETS.handled), which is what makes BLK unreachable to a
 * second look that has to re-derive it from scratch.
 */
function inheritedBlockerFixture() {
  const stubs = [];
  for (let i = 0; i < LIST_LIMIT; i += 1) {
    stubs.push(
      familyStub(
        7100 + i,
        `ANALYTICS-MENTO-ORG-B${i}`,
        orderedCreatedAt(i),
        i === 0 ? ["ANALYTICS-MENTO-ORG-BLK"] : [],
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  for (let i = 0; i < 4; i += 1) {
    stubs.push(
      familyStub(
        7600 + i,
        `ANALYTICS-MENTO-ORG-G${i}`,
        orderedCreatedAt(LIST_LIMIT + i),
        Array.from(
          { length: MAX_DUPLICATE_LOOKUPS },
          (_, j) => `ANALYTICS-MENTO-ORG-GH${i}X${j}`,
        ),
      ),
    );
  }
  stubs.push(
    familyStub(
      7699,
      "ANALYTICS-MENTO-ORG-GZ",
      orderedCreatedAt(LIST_LIMIT + 4),
      ["ANALYTICS-MENTO-ORG-BLK"],
    ),
  );
  return makeRunGh({
    stubs,
    handled: [{ shortId: "ANALYTICS-MENTO-ORG-BLK", label: FIX_REFUSED_LABEL }],
  });
}

await test("SECOND LOOK: it inherits the first pass's proven blockers instead of re-deriving them on half the budget", async () => {
  // The precondition for a second look is that the first pass found a blocker
  // for EVERYTHING — so the run has already PROVEN those blockers exist. Handing
  // a smaller budget the same work from scratch is strictly weaker, and every
  // budget in the family resolver fails OPEN toward MORE candidates: a blocker it
  // cannot afford to look up is reported as "not handled". Here BLK is the 21st
  // declared id the second look would have to query on a budget of 20, so without
  // the seed #7699 is selected — a second autofix PR for a family whose sibling
  // this same run just read a REFUSED marker off. No rate limit, no transient,
  // and no way to see it afterwards except a truncation flag on the run record,
  // rendered after the PR is already open.
  //
  // NEGATIVE CONTROL: drop `seed: resolved` from the resolveSecondLook call in
  // selectAutofixRun (or stop returning `resolved` from resolveFamilies) and
  // #7699 appears in `entries` — the duplicate.
  const { runGh } = inheritedBlockerFixture();
  const { entries, deferred } = await selectAutofixRun(
    { repo: "o/r", cap: 6 },
    { runGh },
  );
  const selectedIssues = entries.map((e) => e.issue);
  assertDeepEqual(
    selectedIssues,
    [7600, 7601, 7602, 7603],
    "the four unblocked further stubs are selected",
  );
  assert(
    !selectedIssues.includes(7699),
    "a stub whose family the FIRST pass proved handled must never be selected by the second look",
  );
  assert(
    deferred.some((d) => d.issue === 7699),
    `the inherited blocker must be reported as a deferral, got: ${JSON.stringify(deferred)}`,
  );
});

/**
 * The starvation shape that ALSO exercises the reverse leg: a first pass with
 * real finalists whose families the reverse `in:comments` probe then stands
 * ENTIRELY down, so the run selects nothing off a page that is full of RAW rows
 * (mostly foreign-project ones the client filter drops). That is the only way to
 * reach a second look with a populated `alreadyProbed` set — which is exactly
 * the state the seed creates.
 */
function reverseStoodDownFixture({ locals = 6, further = 5 } = {}) {
  const stubs = [];
  const handled = [];
  for (let i = 0; i < locals; i += 1) {
    stubs.push(
      familyStub(
        7200 + i,
        `ANALYTICS-MENTO-ORG-R${i}`,
        orderedCreatedAt(i),
        Array.from(
          { length: MAX_DUPLICATE_LOOKUPS },
          (_, j) => `ANALYTICS-MENTO-ORG-RH${i}X${j}`,
        ),
      ),
    );
    // A TERMINAL sibling reachable only through the reverse probe: it names the
    // family's first hub in its own verdict, so the probe admits the edge and
    // its refusal marker stands the whole family down.
    handled.push({
      shortId: `ANALYTICS-MENTO-ORG-RT${i}`,
      label: FIX_REFUSED_LABEL,
      declares: [`ANALYTICS-MENTO-ORG-RH${i}X0`],
    });
  }
  // Foreign-project rows: the server returns them (they match the tokenized
  // `<slug> in:title` filter), the exact project gate drops them. They are what
  // makes the page RAW-full without adding candidates.
  for (let i = 0; stubs.length < LIST_LIMIT; i += 1) {
    stubs.push({
      number: 7300 + i,
      shortId: `APP-MENTO-ORG-R${i}`,
      title: `[sentry] APP-MENTO-ORG-R${i} (app-mento-org, error)`,
      labels: [AUTOFIX_SELECT_LABEL, "sentry-triage"],
      createdAt: orderedCreatedAt(locals + i),
      comments: [verdictComment()],
    });
  }
  for (let i = 0; i < further; i += 1) {
    stubs.push(
      familyStub(
        7400 + i,
        `ANALYTICS-MENTO-ORG-S${i}`,
        orderedCreatedAt(LIST_LIMIT + i),
        Array.from(
          { length: MAX_DUPLICATE_LOOKUPS },
          (_, j) => `ANALYTICS-MENTO-ORG-SH${i}X${j}`,
        ),
      ),
    );
  }
  return makeRunGh({ stubs, handled });
}

/** `in:title` handled lookups issued for ONE specific family id. The bare
 * `titleSearchCount` cannot tell which id a search was for, and the seed bugs
 * below are entirely about WHICH ids get re-asked across a budget boundary. */
function titleSearchCountFor(calls, id) {
  return calls.filter(
    (c) =>
      c[0] === "issue" &&
      c[1] === "list" &&
      String(c[c.indexOf("--search") + 1] ?? "").includes(`"${id}" in:title`),
  ).length;
}

/** The index of the SECOND candidate-window list — i.e. where the second look
 * begins. Everything before it is the first pass. */
function secondLookStartsAt(calls) {
  return calls.findIndex(
    (c, i) => isWindowListArgs(c) && calls.slice(0, i).some(isWindowListArgs),
  );
}

// The id the first pass drops for budget. Window stub 150's first hub: the
// declared-id order is window order, so the 40-lookup budget is spent long
// before this one, and it is never read by the first pass.
const DROPPED_HUB_ID = "ANALYTICS-MENTO-ORG-DH150X0";

/**
 * A FULL, entirely-unselectable window whose stubs declare FAR more distinct
 * family ids than MAX_HANDLED_ID_QUERIES (200 × 5 = 1000 against a budget of
 * 40), so 960 of them are dropped unread. Past the ceiling sits one selectable
 * stub declaring one of those DROPPED ids — and that id's sibling carries a
 * TERMINAL marker, so the only thing standing between this run and a second
 * autofix PR for an already-refused family is a lookup the first pass could not
 * afford and the second look must therefore still make.
 */
function droppedIdBlockerFixture() {
  const stubs = [];
  for (let i = 0; i < LIST_LIMIT; i += 1) {
    stubs.push(
      familyStub(
        7100 + i,
        `ANALYTICS-MENTO-ORG-D${i}`,
        orderedCreatedAt(i),
        Array.from(
          { length: MAX_DUPLICATE_LOOKUPS },
          (_, j) => `ANALYTICS-MENTO-ORG-DH${i}X${j}`,
        ),
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  stubs.push(
    familyStub(7699, "ANALYTICS-MENTO-ORG-DZ", orderedCreatedAt(LIST_LIMIT), [
      DROPPED_HUB_ID,
    ]),
  );
  return makeRunGh({
    stubs,
    handled: [{ shortId: DROPPED_HUB_ID, label: FIX_REFUSED_LABEL }],
  });
}

await test("SEED: an id the first pass DROPPED for budget is re-lookable by the second look, so no duplicate slips through", async () => {
  // The interaction bug between two individually-correct changes. To keep the
  // per-run overflow counting each distinct un-runnable id ONCE rather than once
  // per fixpoint iteration, `listHandledShortIds` folds every DROPPED id into its
  // re-attempt guard — correct while a budget only shrinks within one pass. The
  // second look then began SEEDING that guard while running on FRESH budgets, so
  // never-read ids arrived labelled "already resolved": the pass spent none of
  // its new allowance on them and selected a stub whose sibling holds a terminal
  // refusal. A duplicate autofix PR, with no rate limit anywhere in the story —
  // the exact hazard the fail-closed work exists to prevent, reached from the
  // other side.
  //
  // NEGATIVE CONTROL: seed the wider set again — `new Set(seed.handledQueried)`
  // in resolveFamilies, i.e. carry dropped ids across the pass boundary — and
  // #7699 appears in `entries` with zero second-look lookups for its hub.
  const { runGh, calls } = droppedIdBlockerFixture();
  const { entries, deferred, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 6 },
    { runGh },
  );

  // The fixture must actually starve the first pass, or this proves nothing.
  assert(
    truncations.handledOverflow > 0,
    "the first pass must overflow its handled budget for this to be the dropped-id path",
  );
  const secondListAt = secondLookStartsAt(calls);
  assert(secondListAt > 0, "the second look must have run");
  assertEqual(
    titleSearchCountFor(calls.slice(0, secondListAt), DROPPED_HUB_ID),
    0,
    "the first pass must never have read this id — it was dropped for budget",
  );

  // The fix: a fresh budget retries exactly the work the first pass could not
  // afford, so the terminal sibling is found.
  assertEqual(
    titleSearchCountFor(calls.slice(secondListAt), DROPPED_HUB_ID),
    1,
    "the second look must spend its OWN budget looking up the id nobody read",
  );
  assert(
    !entries.some((e) => e.issue === 7699),
    `a stub whose family carries a terminal refusal must never be selected, got: ${JSON.stringify(entries)}`,
  );
  assert(
    deferred.some((d) => d.issue === 7699),
    `and the stand-down must be reported, got: ${JSON.stringify(deferred)}`,
  );
});

await test("SEED REGRESSION: a dropped id is counted into overflow ONCE per run, however many passes re-surface it", async () => {
  // The invariant the seeded set was introduced to protect, pinned directly on
  // the helper so it cannot regress behind a fixture. The fixpoint re-surfaces
  // the same recheck ids every iteration; without the dropped ids in the
  // re-attempt guard, each one is counted into `overflow` once per pass and the
  // run record reports a multiple of the real number. Splitting `answered` out
  // must NOT weaken this: the guard still absorbs dropped ids, only the SEED is
  // narrowed.
  //
  // NEGATIVE CONTROL: drop the `for (const droppedId of droppedIds)
  // queried.add(droppedId);` loop in listHandledShortIds and overflow doubles to
  // 4 — or make the re-attempt filter read `answered` instead of `queried`, the
  // plausible wrong shape of this round's fix, and it doubles the same way.
  const ids = ["ANALYTICS-MENTO-ORG-OA", "ANALYTICS-MENTO-ORG-OB"];
  const { runGh, calls } = makeRunGh({ stubs: [] });
  const queried = new Set();
  const answered = new Set();
  const budget = { remaining: 0, overflow: 0 };
  for (let pass = 0; pass < 2; pass += 1) {
    await listHandledShortIds(runGh, "o/r", ids, {
      queried,
      answered,
      budget,
    });
  }
  assertEqual(
    budget.overflow,
    ids.length,
    "each DISTINCT un-runnable id must count exactly once per run",
  );
  assertEqual(calls.length, 0, "and no lookup may be issued at zero capacity");
  assertEqual(
    answered.size,
    0,
    "nothing was answered — a dropped id is spend, never knowledge",
  );
});

await test("SEED: an id the first pass ANSWERED is NOT re-read by the second look (seeding still pays)", async () => {
  // The other half of the same boundary, and the reason the fix narrows the seed
  // instead of deleting it. An id whose lookup actually came back is real
  // knowledge: re-asking costs the second look budget it needs for the ids
  // nobody has read yet. Here the whole window shares ONE declared hub, so the
  // first pass answers it well inside its budget, and the stub past the ceiling
  // declares the same hub.
  //
  // NEGATIVE CONTROL: stop seeding the answered set — `const handledQueried =
  // new Set()` in resolveFamilies — and the count below goes to 2.
  const SEEDED_HUB_ID = "ANALYTICS-MENTO-ORG-SEEDEDHUB";
  const stubs = [];
  for (let i = 0; i < LIST_LIMIT; i += 1) {
    stubs.push(
      familyStub(
        7800 + i,
        `ANALYTICS-MENTO-ORG-E${i}`,
        orderedCreatedAt(i),
        [SEEDED_HUB_ID],
        FIX_SCOPE_ARCHITECTURAL,
      ),
    );
  }
  stubs.push(
    familyStub(8399, "ANALYTICS-MENTO-ORG-EZ", orderedCreatedAt(LIST_LIMIT), [
      SEEDED_HUB_ID,
    ]),
  );
  // No `handled` entry: the hub exists and answers "no terminal marker".
  const { runGh, calls } = makeRunGh({ stubs });
  const { entries } = await selectAutofixRun(
    { repo: "o/r", cap: 6 },
    { runGh },
  );
  assert(secondLookStartsAt(calls) > 0, "the second look must have run");
  assertEqual(
    titleSearchCountFor(calls, SEEDED_HUB_ID),
    1,
    "an answered id must be looked up ONCE per run, not once per pass",
  );
  assert(
    entries.some((e) => e.issue === 8399),
    "and nothing blocks it, so the stub past the ceiling is still selected",
  );
});

await test("SEED: a probe that FAILED or was left half-read is guarded but never seeded (the same bug, other hats)", async () => {
  // The reverse leg carries the identical hazard on two more structures. A
  // probe id enters `alreadyProbed` BEFORE its search runs, and a hit's stub
  // read is negative-cached as `null` on failure — both right as within-pass
  // re-attempt guards, both spend rather than knowledge. Seeded into a pass with
  // fresh budgets they say "already resolved" about work nobody completed, and a
  // terminal sibling behind an unread hit lets a duplicate fix PR through
  // exactly as the handled-id case does.
  //
  // (The PROBE budget is already safe: its ceiling check breaks BEFORE the add,
  // so a probe it refuses never enters the guard at all. Pinned below.)
  //
  // NEGATIVE CONTROL: seed the wide sets — `answeredProbes` fed from `probed`,
  // or `resolved.stubCache` unfiltered — and the assertions below flip: the
  // failed, starved and unread-hit probes all read as answered.
  const hub = (n, shortId) => ({
    number: n,
    title: `[sentry] ${shortId} (analytics-mento-org, error)`,
    labels: [],
  });
  const runGh = async (args) => {
    const search = String(args[args.indexOf("--search") + 1] ?? "");
    if (args[1] === "view") {
      // The hit surfaced by STARVE2 cannot be read.
      if (String(args[2]) === "9200") {
        throw new Error("gh issue view 9200 failed with exit 1:\nHTTP 502");
      }
      return JSON.stringify({
        number: Number(args[2]),
        title: "[sentry] ANALYTICS-MENTO-ORG-HUBX (analytics-mento-org, error)",
        body: "",
        labels: [],
        comments: [verdictComment({ duplicates: [] })],
      });
    }
    if (/PROBEBAD/.test(search)) {
      throw new Error("gh issue list failed with exit 1:\nread ECONNRESET");
    }
    if (/PROBESTARVE/.test(search)) {
      return JSON.stringify([hub(9100, "ANALYTICS-MENTO-ORG-HUB1")]);
    }
    if (/PROBEREAD/.test(search)) {
      return JSON.stringify([hub(9200, "ANALYTICS-MENTO-ORG-HUB2")]);
    }
    return JSON.stringify([]);
  };

  const ids = [
    "ANALYTICS-MENTO-ORG-PROBEOK",
    "ANALYTICS-MENTO-ORG-PROBEBAD",
    "ANALYTICS-MENTO-ORG-PROBEREAD",
  ];
  const probed = new Set();
  const answeredProbes = new Set();
  const failedStubReads = new Set();
  await reverseVerifyFamilies(runGh, "o/r", ids, {
    project: LOCAL_SENTRY_PROJECT,
    alreadyProbed: probed,
    answeredProbes,
    failedStubReads,
    probeBudget: { remaining: 10 },
    verifyBudget: { remaining: 10 },
  });
  assertEqual(probed.size, 3, "all three are guarded against re-attempt");
  assertDeepEqual(
    [...answeredProbes],
    ["ANALYTICS-MENTO-ORG-PROBEOK"],
    "only the probe that searched AND resolved every hit is seed-worthy",
  );
  assert(
    failedStubReads.has("9200"),
    "the thrown hit read is recorded so its null cache entry is not seeded",
  );

  // Verify-budget starvation, on its own: the search returns a hit the pass
  // cannot afford to read.
  const starvedProbed = new Set();
  const starvedAnswered = new Set();
  await reverseVerifyFamilies(
    runGh,
    "o/r",
    ["ANALYTICS-MENTO-ORG-PROBESTARVE"],
    {
      project: LOCAL_SENTRY_PROJECT,
      alreadyProbed: starvedProbed,
      answeredProbes: starvedAnswered,
      probeBudget: { remaining: 10 },
      verifyBudget: { remaining: 0 },
    },
  );
  assertEqual(starvedProbed.size, 1, "still guarded within the pass");
  assertEqual(
    starvedAnswered.size,
    0,
    "a probe whose hit went unread for want of budget is not an answer",
  );

  // And the PROBE ceiling, which was already correct: a probe it refuses never
  // enters the guard, so nothing has to un-record it.
  const cappedProbed = new Set();
  const cappedAnswered = new Set();
  await reverseVerifyFamilies(runGh, "o/r", ids, {
    project: LOCAL_SENTRY_PROJECT,
    alreadyProbed: cappedProbed,
    answeredProbes: cappedAnswered,
    probeBudget: { remaining: 0 },
    verifyBudget: { remaining: 10 },
  });
  assertEqual(
    cappedProbed.size,
    0,
    "a probe refused by the ceiling is never recorded as probed at all",
  );
});

await test("SEED: a stub read that THREW is not carried into the next pass's cache", async () => {
  // The last hat, and the one that makes the probe fix worth anything. Re-probing
  // an unresolved id on a fresh budget only helps if the hit it could not read is
  // actually re-readable — and `readVerdictCached` negative-caches a THROWN read
  // as `null`, indistinguishable from the legitimate "read fine, no fenced
  // verdict". Seed that null and the second look re-probes, finds the same hit,
  // pays no verify budget for it (the cache claims a hit), and re-derives
  // "not admitted" from a read that never happened.
  //
  // NEGATIVE CONTROL: return `stubCache` unfiltered from resolveFamilies and the
  // first assertion below flips.
  const runGh = async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (String(args[2]) === "9200") {
        throw new Error("gh issue view 9200 failed with exit 1:\nHTTP 502");
      }
      return JSON.stringify({
        number: Number(args[2]),
        title:
          "[sentry] ANALYTICS-MENTO-ORG-HUBOK (analytics-mento-org, error)",
        body: "",
        labels: [],
        comments: [verdictComment({ duplicates: ["ANALYTICS-MENTO-ORG-CA"] })],
      });
    }
    const search = String(args[args.indexOf("--search") + 1] ?? "");
    if (/in:comments/.test(search)) {
      return JSON.stringify([
        {
          number: 9200,
          title:
            "[sentry] ANALYTICS-MENTO-ORG-HUBBAD (analytics-mento-org, error)",
          labels: [],
        },
        {
          number: 9300,
          title:
            "[sentry] ANALYTICS-MENTO-ORG-HUBOK (analytics-mento-org, error)",
          labels: [],
        },
      ]);
    }
    return JSON.stringify([]);
  };
  const candidates = [
    {
      entry: { issue: 500, shortId: "ANALYTICS-MENTO-ORG-CA" },
      issue: 500,
      shortId: "ANALYTICS-MENTO-ORG-CA",
      duplicateOf: [],
      reconcile: false,
    },
  ];
  const { resolved } = await resolveFamilies(runGh, "o/r", candidates, 2);
  assert(
    !resolved.stubCache.has("9200"),
    "a read that threw is spend, not knowledge — it must not reach the seed",
  );
  assert(
    resolved.stubCache.has("9300"),
    "a read that succeeded IS knowledge and must still be carried",
  );
  assertEqual(
    resolved.probesAnswered.size,
    0,
    "and the probe that surfaced the unread hit is not answered either",
  );
});

await test("SECOND LOOK: the ids the first pass PROBED are skipped, but its probe SPEND is not charged to the second look", async () => {
  // The seed carries knowledge, never spend. `alreadyProbed` is a dedupe set —
  // seeding it is what stops the second look re-issuing searches the run already
  // paid for — but the probe budget used to be metered as `alreadyProbed.size`,
  // so a seeded set larger than the second look's cap reads as "budget already
  // spent" and the pass probes NOTHING while reporting itself truncated. That
  // turns the seed, whose whole purpose is to make this pass stronger, into the
  // thing that blinds it.
  //
  // NEGATIVE CONTROL: change the budget check in reverseVerifyFamilies back to
  // `probed.size >= maxProbes` and the second look's probe count below drops to
  // 0 while the first pass's stays exactly the same.
  const { runGh, calls } = reverseStoodDownFixture();
  const { entries, window } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertEqual(window.secondLook, true, "this pin must take a second look");
  const secondListAt = calls.findIndex(
    (c, i) => isWindowListArgs(c) && calls.slice(0, i).some(isWindowListArgs),
  );
  assert(secondListAt > 0, "the second look's own list must be locatable");
  const firstPassProbes = reverseSearchCount(calls.slice(0, secondListAt));
  const secondLookProbes = reverseSearchCount(calls.slice(secondListAt));
  assert(
    firstPassProbes > SECOND_LOOK_FAMILY_BUDGETS.probe,
    `the first pass must probe MORE ids than the second look's whole budget, or this proves nothing (got ${firstPassProbes})`,
  );
  assert(
    secondLookProbes > 0,
    "the second look must get its own probe allowance despite the seeded set",
  );
  assertDeepEqual(
    entries.map((e) => e.issue),
    [7400, 7401],
    "and it still reaches the selectable stubs past the ceiling",
  );
});

await test("SECOND LOOK: a failing list read does NOT fail the step — the first pass's result stands", async () => {
  // The second look's list is the ONE gh call in this leg with no fail-soft
  // handler under it, and this leg put it on the FREQUENT path: once the queue
  // is >= LIST_LIMIT rows, every no-selection run depends on it. Unhandled, its
  // rejection reaches main(), sets exit 1, and kills the select step under
  // `set -euo pipefail` — destroying the whole run record, the deferral and skip
  // reports, and the DEGRADED line, on a run that before this change exited 0
  // with a clean `[]`.
  //
  // NEGATIVE CONTROL: remove the try/catch around resolveSecondLook in
  // selectAutofixRun and this test throws instead of returning.
  const { runGh: base } = makeRunGh({
    stubs: starvedWindowStubs({ further: 3 }),
  });
  let windowLists = 0;
  const runGh = async (args) => {
    if (isWindowListArgs(args)) {
      windowLists += 1;
      if (windowLists === 2) {
        throw new Error("gh issue list failed with exit 1:\nread ECONNRESET");
      }
    }
    return base(args);
  };
  const { entries, skipped, window, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [], "nothing was selectable, and nothing throws");
  assertEqual(
    skipped.length,
    LIST_LIMIT,
    "the first pass's report survives the second look's failure intact",
  );
  assertEqual(window.secondLook, true, "the attempt is still recorded");
  assertEqual(
    window.secondLookFailed,
    true,
    "and so is the fact that it could not read — never a silent zero",
  );
  assertEqual(
    truncations.rateLimited,
    0,
    "an ordinary transient here is not a throttle",
  );
});

await test("SECOND LOOK: a RATE-LIMITED list read degrades the run instead of failing the step", async () => {
  // The worse half of the same throw site: a 403 there propagated out of
  // selectAutofixRun before `degraded()` could ever run, so the step died and
  // `rate_limited` / the DEGRADED run-record line never rendered — the run went
  // out as a select failure with no record of WHY.
  const { runGh: base } = makeRunGh({
    stubs: starvedWindowStubs({ further: 3 }),
  });
  let windowLists = 0;
  const runGh = async (args) => {
    if (isWindowListArgs(args)) {
      windowLists += 1;
      if (windowLists === 2) {
        const err = new Error("gh issue list failed with exit 1");
        err.ghStderr = "HTTP 403: API rate limit exceeded for user ID 1234.";
        throw err;
      }
    }
    return base(args);
  };
  const { entries, window, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assert(Array.isArray(entries), "the always-emits-an-array contract holds");
  assertDeepEqual(entries, []);
  assertEqual(window.secondLookFailed, true);
  assert(
    truncations.rateLimited > 0,
    "the throttle must reach the disposition flip, not die with the step",
  );
});

/** A rejection shaped like the one `defaultRunGh` builds for a throttled call:
 * the argv-carrying message plus gh's own stderr on `ghStderr`, which is the
 * only half `isRateLimitFailure` may be run against. */
function throttleError(argv = "gh issue list --repo o/r") {
  const err = new Error(`${argv} failed with exit 1`);
  err.ghStderr = "HTTP 403: API rate limit exceeded for user ID 1234.";
  return err;
}

/** Round-trip a run through the report writer the CLI uses, so a fail-closed
 * assertion covers the channel the disposition flip ACTUALLY rides — the
 * truncations file — instead of only the returned object. Returns the parsed
 * file plus whether the degraded signal survived. */
function writeAndReadTruncations(run) {
  const dir = mkdtempSync(join(tmpdir(), "autofix-select-failclosed-"));
  try {
    const truncationsOut = join(dir, "truncations.json");
    const { lostDegradedSignal } = writeRunReports({ truncationsOut }, run);
    return {
      lostDegradedSignal,
      written: JSON.parse(readFileSync(truncationsOut, "utf8")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("FAIL CLOSED: a THROTTLED FIRST window list degrades the run instead of failing the step", async () => {
  // The third and last unhandled throw site, and the one on the most common
  // path: the batch run's very FIRST read. `instrumentRunGh` counts the throttle
  // and RETHROWS by design (so every fail-soft handler downstream keeps its
  // exact behaviour), so the rejection left `selectAutofixRun` untouched, `main`
  // set exit 1, and the step died under `set -euo pipefail` — taking the JSON
  // array, the `::error::` line, `truncations.rateLimited` and the
  // `degraded-rate-limited` disposition with it. The run went out as a select
  // FAILURE with no record of why, which is the exact inverse of the contract
  // this leg is built on. The second look's list was already wrapped for this
  // reason; this one and the dispatch read were missed.
  //
  // NEGATIVE CONTROL: remove the try/catch around `listCodeFixStubsPage` in
  // selectAutofixRun and this test throws instead of returning.
  const { runGh: base } = makeRunGh({
    stubs: starvedWindowStubs({ further: 3 }),
  });
  const runGh = async (args) => {
    if (isWindowListArgs(args)) throw throttleError();
    return base(args);
  };
  const { result, stderr } = await captureStderr(() =>
    selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh }),
  );
  // The invariant the workflow header asserts: ALWAYS a valid array, NEVER a
  // throw. Reaching this line at all is half the assertion.
  assert(
    Array.isArray(result.entries),
    "the leg must still emit a valid array",
  );
  assertDeepEqual(result.entries, []);
  assert(
    result.truncations.rateLimited > 0,
    "the degradation must be reported, not silent",
  );
  assertEqual(
    result.window.total,
    0,
    "a window that was never read must not claim stubs it did not see",
  );
  assertEqual(result.window.evaluated, 0);
  assertEqual(result.window.ghCalls, 1, "and the one issued read is counted");
  assert(
    stderr.includes("::error::selection DEGRADED"),
    `the loud report must still be written, got: ${stderr}`,
  );
  // exit 0: `main` fails the step only when the degraded signal is LOST, so the
  // report has to survive the file layer too — that is the channel the
  // disposition flip rides.
  const { lostDegradedSignal, written } = writeAndReadTruncations(result);
  assertEqual(lostDegradedSignal, false, "the degraded run still exits 0");
  assert(
    written.rateLimited > 0,
    `the truncations file must carry the throttle, got: ${JSON.stringify(written)}`,
  );
});

await test("FAIL CLOSED: a THROTTLED dispatch readStub degrades the run instead of failing the step", async () => {
  // The dispatch path's first read, same shape and the same stakes: the
  // documented remedy for a stalled leg must not be the one path that turns a
  // throttle into a dead step with no run record.
  //
  // NEGATIVE CONTROL: remove the try/catch around `readStub` in the
  // `options.issue != null` branch and this test throws instead of returning.
  const { runGh: base } = makeRunGh({
    stubs: [stub({ number: 8400, shortId: "ANALYTICS-MENTO-ORG-DR" })],
  });
  const runGh = async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      throw throttleError("gh issue view 8400 --repo o/r");
    }
    return base(args);
  };
  const { result, stderr } = await captureStderr(() =>
    selectAutofixRun({ repo: "o/r", issue: 8400 }, { runGh }),
  );
  assert(
    Array.isArray(result.entries),
    "the leg must still emit a valid array",
  );
  assertDeepEqual(result.entries, []);
  assert(result.truncations.rateLimited > 0, "the degradation is reported");
  assertEqual(
    result.window.evaluated,
    0,
    "the stub was never read, so it was never evaluated",
  );
  assert(
    stderr.includes("::error::selection DEGRADED"),
    `the loud report must still be written, got: ${stderr}`,
  );
  const { lostDegradedSignal, written } = writeAndReadTruncations(result);
  assertEqual(lostDegradedSignal, false, "the degraded run still exits 0");
  assert(written.rateLimited > 0, "the truncations file carries the throttle");
});

await test("FAIL CLOSED: a NON-throttle failure on those same reads still FAILS the step, unchanged", async () => {
  // The scoping half, and the reason the two catches above test
  // `state.rateLimited` rather than swallowing everything. A rate limit is the
  // dedupe hazard this leg fails closed against — the read did not answer, and
  // selecting on that opens duplicate PRs — so it degrades and reports. A
  // TOTAL failure of the same read (transport gone, malformed body, dead token)
  // is a different thing: nothing was read, so nothing can be wrongly selected,
  // there is no window to report on, and a dead step is the louder and more
  // actionable signal than a green run rendering as an idle queue. That is the
  // behaviour on main and this round deliberately preserves it.
  //
  // NEGATIVE CONTROL: change either new catch to swallow unconditionally (drop
  // its `if (state.rateLimited === 0) throw err;`) and every assertion below
  // flips — each call resolves to a clean `[]` and the failure goes silent.
  const stubs = starvedWindowStubs({ further: 3 });
  const rejects = async (runGh, options, what) => {
    let threw = false;
    try {
      await selectAutofixRun(options, { runGh });
    } catch {
      threw = true;
    }
    assert(threw, `${what} must still reject`);
  };

  // Transport failure on the first window list.
  const { runGh: listBase } = makeRunGh({ stubs });
  await rejects(
    async (args) => {
      if (isWindowListArgs(args)) {
        throw new Error("gh issue list failed with exit 1:\nread ECONNRESET");
      }
      return listBase(args);
    },
    { repo: "o/r", cap: 2 },
    "a transport failure on the window list",
  );

  // Malformed body on the same read: never a `gh` rejection at all, so the
  // throttle latch cannot have fired and the JSON.parse throw must propagate.
  const { runGh: jsonBase } = makeRunGh({ stubs });
  await rejects(
    async (args) => (isWindowListArgs(args) ? "not json" : jsonBase(args)),
    { repo: "o/r", cap: 2 },
    "a malformed window list body",
  );

  // And the dispatch read.
  const { runGh: dispatchBase } = makeRunGh({
    stubs: [stub({ number: 8401, shortId: "ANALYTICS-MENTO-ORG-DQ" })],
  });
  await rejects(
    async (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        throw new Error("gh issue view 8401 failed with exit 1:\nHTTP 404");
      }
      return dispatchBase(args);
    },
    { repo: "o/r", issue: 8401 },
    "a 404 on the dispatch stub read",
  );
});

await test("FAIL CLOSED: a throttled run stops ISSUING reads, it does not spend the rest of the window into an active limit", async () => {
  // Fail-closed at the token level, not only at the selection. GitHub's
  // secondary limits EXTEND on continued requests and escalate to abuse
  // detection, and this is the repo-shared free-plan GITHUB_TOKEN. Before the
  // latch, one 403 at the head of a 200-wide window was followed by ~400 more
  // subprocesses before the run stood down.
  //
  // NEGATIVE CONTROL: remove the `state.rateLimited > 0` short-circuit at the
  // top of instrumentRunGh (and the matching break in the evaluation loop) and
  // the call count jumps to the full window's ~400.
  const { runGh, calls } = makeRunGh({
    stubs: starvedWindowStubs({ further: 3 }),
    openPrError:
      "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234.",
  });
  const { entries, window, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, []);
  assertEqual(truncations.rateLimited, 1, "exactly ONE real throttle event");
  assert(
    calls.length <= 5,
    `a throttled run must stop issuing reads, got ${calls.length} (unlatched it made 2 x ${MAX_CANDIDATE_EVALUATIONS} + more)`,
  );
  assertEqual(
    window.ghCalls,
    calls.length,
    "latched (never issued) reads must not inflate the measured invocation count",
  );
});

await test("FAIL CLOSED: the latch holds where the loop break cannot — a throttle DURING family resolution", async () => {
  // The two mechanisms are not interchangeable, and this is the half only the
  // latch covers. The evaluation loop has already finished here; what remains is
  // the family budget, up to MAX_HANDLED_ID_QUERIES in:title searches plus the
  // reverse probes and verify reads on top. Breaking a loop the run has left
  // does nothing for that, and every one of those reads is separately
  // try/caught, so without the latch each simply fails soft and the next one
  // fires into the same active limit.
  //
  // NEGATIVE CONTROL: remove the `state.rateLimited > 0` short-circuit at the
  // top of instrumentRunGh and the in:title count below jumps from 1 to
  // MAX_HANDLED_ID_QUERIES.
  const stubs = [];
  const hubIds = [];
  for (let i = 0; i < 30; i += 1) {
    const hubs = Array.from(
      { length: MAX_DUPLICATE_LOOKUPS },
      (_, j) => `ANALYTICS-MENTO-ORG-LH${i}X${j}`,
    );
    hubIds.push(...hubs);
    stubs.push(
      familyStub(
        7900 + i,
        `ANALYTICS-MENTO-ORG-L${i}`,
        orderedCreatedAt(i),
        hubs,
      ),
    );
  }
  const { runGh, calls } = makeRunGh({
    stubs,
    handledLookupErrorIds: hubIds,
    handledLookupErrorMessage:
      "gh issue list failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234.",
  });
  const { entries, truncations } = await selectAutofixRun(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(entries, [], "the run still fails closed");
  assertEqual(truncations.rateLimited, 1, "exactly ONE real throttle event");
  assertEqual(
    titleSearchCount(calls),
    1,
    `the throttled family pass must issue no further lookups, got ${titleSearchCount(calls)} of a ${MAX_HANDLED_ID_QUERIES} budget`,
  );
  assertEqual(
    reverseSearchCount(calls),
    0,
    "and no reverse probe may fire after the limit is known",
  );
});

await test("FAIL CLOSED: the throttled window evaluation LEAVES, it does not grind out a skip line per remaining stub", async () => {
  // The latch makes the remaining reads free, so this is legibility rather than
  // spend — but 200 `skip #N` lines burying the one `::error::` that explains
  // the run is its own failure to communicate, on the surface an operator reads
  // when the tracker says DEGRADED.
  //
  // NEGATIVE CONTROL: remove the `state.rateLimited > 0` break from the window
  // evaluation loop in selectAutofixRun and the skip-line count below goes to
  // the whole window's ${LIST_LIMIT}.
  const { runGh } = makeRunGh({
    stubs: starvedWindowStubs({ further: 3 }),
    openPrError:
      "gh api repos/o/r/pulls failed with exit 1:\nHTTP 403: API rate limit exceeded for user ID 1234.",
  });
  const { stderr } = await captureStderr(() =>
    selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh }),
  );
  const skipLines = stderr
    .split("\n")
    .filter((line) => line.startsWith("skip #")).length;
  assert(
    skipLines <= 2,
    `a throttled run must leave the window loop, got ${skipLines} skip lines`,
  );
  assert(
    stderr.includes("stopping the window evaluation"),
    "and it must say why it left",
  );
});

await test("INSTRUMENTATION: the operator summary line reports the count actually EMITTED, not the pre-degradation one", async () => {
  // `finish()` is passed AS THE ARGUMENT to `degraded()`, which only then
  // replaces `entries` with []. A summary built inside `finish()` therefore said
  // `entries=2` on a run that emitted zero — on exactly the fail-closed path,
  // the one an operator greps this line to understand.
  //
  // NEGATIVE CONTROL: move the `summarize(...)` call back inside `finish()` (so
  // it reads `entries.length` before degradation) and the assertion below sees
  // a nonzero count.
  const { runGh } = dedupeBlockedFixture(
    "gh issue list failed with exit 1:\nHTTP 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation.",
  );
  const { result, stderr } = await captureStderr(() =>
    selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh }),
  );
  assertDeepEqual(result.entries, []);
  const summary = stderr
    .split("\n")
    .filter((line) => line.startsWith("gh-calls="));
  assertEqual(summary.length, 1, `exactly one summary line, got: ${summary}`);
  assert(
    /\bentries=0$/.test(summary[0]),
    `the summary must report the emitted count, got: ${summary[0]}`,
  );
});

await test("isRateLimitFailure: the bare HTTP 403 permissions branch is load-bearing on its own", async () => {
  // Every other positive case in this suite that contains "HTTP 403" ALSO
  // contains "rate limit" wording, so deleting the `/\bHTTP 403\b/` pattern left
  // the whole suite green — while a real `HTTP 403: Bad credentials` (an App
  // token that lost its installation, the shape this leg is most likely to meet)
  // would stop degrading the run. Matching it is a deliberate trade: a
  // permissions failure and a throttle both mean "this read did not answer the
  // dedupe question", and the only safe action for either is the same one.
  //
  // NEGATIVE CONTROL: delete `/\bHTTP 403\b/` from RATE_LIMIT_PATTERNS and this
  // test reds while every other test in the suite stays green.
  assert(
    isRateLimitFailure("HTTP 403: Bad credentials"),
    "a bare 403 with no throttle wording must still stand the run down",
  );
  assert(
    isRateLimitFailure("HTTP 403: Resource not accessible by integration"),
    "the App-permissions shape must too",
  );
  assert(
    !isRateLimitFailure("HTTP 401: Bad credentials"),
    "and it must be the 403 specifically, not any auth-shaped error",
  );
});

await test("isRateLimitFailure is classified on gh's STDERR, never on the argv the message also carries", async () => {
  // `defaultRunGh` builds `gh <argv> failed with exit N:\n<stderr>`, and argv
  // carries AGENT-authored text: family ids come from an LLM's `duplicate_of`
  // and are interpolated into the `in:title` / `in:comments` searches, with a
  // charset (`[A-Za-z0-9._-]`) that admits `RATELIMITEXCEEDED` as a legal id.
  // Classified against the whole message, any unrelated failure of that one
  // probe — 404, 502, ECONNRESET — would stand the entire run down.
  //
  // NEGATIVE CONTROL: make ghFailureText return `err.message` and the first
  // assertion below flips.
  const err = new Error(
    'gh issue list --repo o/r --search "ANALYTICS-MENTO-ORG-RATELIMITEXCEEDED" in:title failed with exit 1:\nHTTP 404: Not Found',
  );
  err.ghStderr = "HTTP 404: Not Found";
  assert(
    !isRateLimitFailure(ghFailureText(err)),
    "an unrelated 404 on a probe for an awkwardly-named family id is not a throttle",
  );
  assert(
    isRateLimitFailure(err.message),
    "the hazard is real: the same message classified WHOLE does match",
  );
  // Rejections with no captured stderr (a spawn error, or a test double) keep
  // the old behaviour exactly.
  const plain = new Error(
    "gh api failed with exit 1:\nHTTP 429 Too Many Requests",
  );
  assert(
    isRateLimitFailure(ghFailureText(plain)),
    "a rejection without ghStderr still classifies on its message",
  );
});

await test("CLI: --truncations-out round-trips, and the files it writes carry the exact keys the workflow's jq reads", async () => {
  // The file layer is the ACTUAL bridge between the selector's return value and
  // the tracker: the workflow reads `.rateLimited`, `.secondLookFull` and the
  // rest with jq. Every other test here asserts the returned OBJECT, so a
  // key-name or serialization bug in this layer would pass all of them and
  // silently zero the whole run record. `--truncations-out` in particular had no
  // test presence at all, and it is the flag the degraded disposition rides on.
  const parsed = parseArgs([
    "--repo",
    "o/r",
    "--truncations-out",
    "/tmp/t.json",
    "--window-out",
    "/tmp/w.json",
  ]);
  assertEqual(parsed.truncationsOut, "/tmp/t.json");
  assertEqual(parsed.windowOut, "/tmp/w.json");

  const dir = mkdtempSync(join(tmpdir(), "autofix-select-"));
  try {
    const windowOut = join(dir, "window.json");
    const truncationsOut = join(dir, "truncations.json");
    const deferredOut = join(dir, "deferred.json");
    const { lostDegradedSignal } = writeRunReports(
      {
        deferredOut,
        skippedOut: join(dir, "skipped.json"),
        windowOut,
        truncationsOut,
      },
      {
        entries: [],
        deferred: [{ issue: 12, reason: DEFER_FAMILY_HANDLED }],
        skipped: [],
        window: {
          total: 200,
          evaluated: 200,
          secondLook: true,
          secondLookTotal: 100,
          secondLookEvaluated: 100,
          secondLookFull: true,
          secondLookFailed: false,
          ghCalls: 782,
        },
        truncations: {
          handledOverflow: 0,
          reverseBudget: false,
          reverseNonconvergent: false,
          rateLimited: 0,
        },
      },
    );
    assertEqual(lostDegradedSignal, false, "a clean write loses nothing");
    const written = JSON.parse(readFileSync(windowOut, "utf8"));
    assertEqual(written.secondLookFull, true);
    assertEqual(written.secondLookFailed, false);
    assertEqual(written.ghCalls, 782);
    assertEqual(
      JSON.parse(readFileSync(truncationsOut, "utf8")).rateLimited,
      0,
    );
    assertDeepEqual(JSON.parse(readFileSync(deferredOut, "utf8")), [
      { issue: 12, reason: DEFER_FAMILY_HANDLED },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("CLI: a DEGRADED run whose truncations report cannot be written fails LOUD rather than rendering as idle", async () => {
  // `rateLimited` reaches the workflow through exactly one channel — this file —
  // and the disposition flip to `degraded-rate-limited` rides on it. Every other
  // field degrades to "0" or a missing line; this one is the safety signal. Lose
  // it and the tracker says `State: active, Candidates selected: 0`, the #1758
  // misreading, AND the record job's label backfill gate opens on reads the run
  // itself declared unreliable. So this one write is not best-effort: the step
  // fails instead. The array contract still held — it is written, and it is `[]`,
  // so no PR can come out of the run either way.
  //
  // NEGATIVE CONTROL: make writeRunReports always report
  // `lostDegradedSignal: false` and the first assertion below flips.
  const unwritable = join(tmpdir(), "autofix-select-missing-dir", "t.json");
  const degradedRun = {
    entries: [],
    deferred: [],
    skipped: [],
    window: {},
    truncations: { rateLimited: 3 },
  };
  const { result, stderr } = await captureStderr(() =>
    writeRunReports({ truncationsOut: unwritable }, degradedRun),
  );
  assertEqual(
    result.lostDegradedSignal,
    true,
    "a lost degraded signal must be reported to the caller",
  );
  assert(
    /could not write the truncations report/.test(stderr),
    `the write failure must still be logged, got: ${stderr}`,
  );
  // A HEALTHY run losing the same file is NOT fatal: there is no signal to lose,
  // and the always-emits-an-array-and-exit-0 contract stays absolute everywhere
  // else.
  const healthy = await captureStderr(() =>
    writeRunReports(
      { truncationsOut: unwritable },
      { ...degradedRun, truncations: { rateLimited: 0 } },
    ),
  );
  assertEqual(
    healthy.result.lostDegradedSignal,
    false,
    "a healthy run's lost report must never fail the step",
  );
  assertEqual(
    writeReport(unwritable, {}, "truncations"),
    false,
    "writeReport reports its own failure",
  );
});

await test("the selection leg's modules stay under the 600-line soft cap", () => {
  // scripts/ has no max-lines lint and sits outside the file-size watchlist's
  // package scopes (scripts/file-size-watchlist.mjs), so the 600-line soft cap in
  // docs/pr-checklists/recurring-review-patterns.md is only enforced where a
  // suite pins it. The triage legs pin their own in sentry-triage-brief.test.mjs;
  // this leg had NO pin, which is how sentry-autofix-queue-io.mjs reached 583 —
  // 17 lines of headroom — before anyone looked. Pinned HERE rather than added to
  // that list because the gate routes every module below to THIS suite: a pin in
  // a suite an autofix change never runs would not fire on the change that
  // breaks it.
  //
  // Every module the select leg owns belongs on this list — an omission is how
  // the next one drifts. sentry-autofix-finalize.mjs is deliberately absent: it
  // belongs to the finalize leg, is already past this cap (the 1,000-line hard
  // cap governs it), and appears in this suite's import closure only because
  // queue-io reads `autofixBranchName` from it.
  const paths = [
    "sentry-autofix-candidate.mjs",
    "sentry-autofix-decisions.mjs",
    "sentry-autofix-family-handled.mjs",
    "sentry-autofix-family-resolve.mjs",
    "sentry-autofix-family.mjs",
    "sentry-autofix-queue-io.mjs",
    "sentry-autofix-reverse-verify.mjs",
    "sentry-autofix-second-look.mjs",
    "sentry-autofix-select-cli.mjs",
    "sentry-autofix-select-instrument.mjs",
    "sentry-autofix-select.mjs",
  ];
  // Resolved against THIS file rather than a repo root: the Sentry-suite gate
  // runs each suite from its own snapshot of the derived import set, and every
  // module above is in that closure, so a sibling-relative read works there and
  // needs no `reads` declaration in scripts/sentry-suite-manifest.json.
  const oversized = paths
    .map((path) => [
      path,
      readFileSync(new URL(`./${path}`, import.meta.url), "utf8").split("\n")
        .length,
    ])
    .filter(([, lines]) => lines > 600)
    .map(([path, lines]) => `${path}:${lines}`);
  assertEqual(
    oversized.join(", "),
    "",
    "these selection-leg modules crossed the 600-line soft cap; split them",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
