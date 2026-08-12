#!/usr/bin/env node
import {
  DEFAULT_CAP,
  emitVerdict,
  MAX_CANDIDATE_EVALUATIONS,
  parseArgs,
  selectAutofixCandidates,
  selectAutofixRun,
} from "./sentry-autofix-select.mjs";
import {
  AUTOFIX_SELECT_LABEL,
  isOwnHeadPr,
  LOCAL_SENTRY_PROJECT,
  MAX_HANDLED_ID_QUERIES,
  MAX_REVERSE_PROBE_QUERIES,
  REVERSE_SEARCH_LIMIT,
} from "./sentry-autofix-queue-io.mjs";
import {
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
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
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

/** Build a bot-authored verdict comment for a code-fix stub. `duplicates`
 * renders in the SAME shape the live #1304-family verdicts carry — an inline
 * flow sequence of double-quoted SHORT-IDs. */
function verdictComment({
  affectedRepo = "mento-protocol/monitoring-monorepo",
  verdict = "code-fix",
  createdAt = "2026-07-18T00:00:00Z",
  duplicates = [],
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
 *  - pr list    -> [] unless the queried --head branch corresponds to a
 *                  SHORT-ID in `prShortIds` (the fixture models an OPEN autofix
 *                  PR; the selector matches by the deterministic head branch
 *                  `sentry-autofix/<short-id-lower>`, NOT by a text search, so a
 *                  human/unrelated PR that merely cites the id cannot match)
 *                  or `forkPrShortIds` (a SPOOF: `--head` matches by branch
 *                  NAME, and fork PRs carry their own, so anyone can push
 *                  `sentry-autofix/<short-id>` on a fork of this public repo
 *                  and open a PR at main — verified live against cli/cli, where
 *                  `--head feat/uptime-command` returns a PR with
 *                  `isCrossRepository: true`). Rows carry the real response
 *                  shape so the ownership fence is exercised, and a spoof is
 *                  emitted FIRST so a fence that only read row 0 would fail.
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
 * own per-marker query (issue #1784). Each entry is `{ shortId, label }`.
 */
function makeRunGh({
  stubs = [],
  prShortIds = [],
  forkPrShortIds = [],
  handled = [],
  repo = "o/r",
  prListError = null,
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
    label: h.label,
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
      labels: [h.label, "sentry-triage"],
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
            labels: [h.label, "sentry-triage"].map((name) => ({ name })),
          })),
        );
      }
      // Per-declared-id handled lookup (bug C): `"<ID>" in:title`. Return handled
      // stubs the tokenized search would surface for this id.
      const titleProbe = /"([^"]+)"\s+in:title/.exec(search);
      if (titleProbe) {
        const qid = titleProbe[1].toUpperCase();
        return JSON.stringify(
          handledStubs
            .filter((h) => String(h.matchTitleFor).toUpperCase() === qid)
            .map((h) => ({
              number: h.number,
              title: handledTitle(h),
              labels: [h.label, "sentry-triage"].map((name) => ({ name })),
            })),
        );
      }
      // Candidate window (`sort:created-asc … <slug> in:title`).
      return JSON.stringify(
        stubs.map((s) => ({
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
    if (a0 === "pr" && a1 === "list") {
      if (prListError) throw new Error(prListError);
      // The selector matches the deterministic head branch (never --search).
      const headIdx = args.indexOf("--head");
      const shortId =
        headIdx === -1 ? null : branchToShortId(args[headIdx + 1]);
      const rows = [];
      // Spoof first: a fence that trusted `.[0]` (or asked for `--limit 1`)
      // would both accept this row AND hide a real PR behind it.
      if (shortId && forkPrShortIds.includes(shortId)) {
        rows.push({
          number: 99,
          isCrossRepository: true,
          headRepositoryOwner: { login: "outsider" },
        });
      }
      if (shortId && prShortIds.includes(shortId)) {
        rows.push({
          number: 1,
          isCrossRepository: false,
          headRepositoryOwner: { login: owner },
        });
      }
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
  // The dedup must be scoped to OPEN PRs (a merged/closed PR must not strand a
  // regressed stub) and must match the DETERMINISTIC head branch — never a text
  // search, which an unrelated PR citing the id could satisfy.
  const prCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
  assert(prCall, "pr list was queried");
  const state = prCall[prCall.indexOf("--state") + 1];
  assert(state === "open", `pr query must be open-only, got ${state}`);
  assert(
    prCall.indexOf("--search") === -1,
    "must NOT use a text search (--search)",
  );
  const head = prCall[prCall.indexOf("--head") + 1];
  assert(
    head === "sentry-autofix/app-mento-org-7x",
    `pr query must match the deterministic head branch, got ${head}`,
  );
});

await test("a FORK PR on the autofix branch name is not ours: no reconcile, the stub stays fixable", async () => {
  // `gh pr list --head` matches by branch NAME, and fork PRs carry their own —
  // verified live: `gh pr list -R cli/cli --head feat/uptime-command --state
  // open` returns a PR with `isCrossRepository: true` owned by an unrelated
  // user. This repo is public, queue-stub titles are public, and
  // `sentry-autofix/<short-id-lower>` is deterministic, so anyone can produce
  // this row. Reading it as our prior fix PR hands an outsider the reconcile
  // write path — a comment carrying their PR url onto the queue issue plus the
  // terminal `sentry:fix-pr-opened` marker, which is terminal until a human
  // clears it — and the family collapse then stands the whole family down
  // behind that marker.
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
  // Ownership has to be READ, so the query must ask for the fields that decide
  // it — a fence that never requested them could not fail closed.
  const prCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
  const json = prCall[prCall.indexOf("--json") + 1];
  for (const field of ["isCrossRepository", "headRepositoryOwner"]) {
    assert(json.includes(field), `pr query must request ${field}, got ${json}`);
  }
});

await test("a spoofed fork PR cannot hide our real one behind it", async () => {
  // The pre-fence query took `--limit 1`. Since forks share the branch-name
  // namespace, a spoof row can fill that single slot — the fence would then
  // report "no PR of ours", the leg would try to open a second one, and the
  // orphaned stub would never be reconciled. Take a page and pick ours out.
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
  const prCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
  assert(
    Number(prCall[prCall.indexOf("--limit") + 1]) > 1,
    "a single-row window can be filled by a spoof",
  );
});

await test("isOwnHeadPr fails CLOSED on a missing or mismatched head owner", () => {
  const ours = {
    isCrossRepository: false,
    headRepositoryOwner: { login: "Mento-Protocol" },
  };
  assertEqual(
    isOwnHeadPr(ours, "mento-protocol/monitoring-monorepo"),
    true,
    "owner comparison is case-insensitive",
  );
  for (const [label, pr] of [
    ["fork", { isCrossRepository: true, headRepositoryOwner: { login: "x" } }],
    [
      "owner mismatch",
      { isCrossRepository: false, headRepositoryOwner: { login: "x" } },
    ],
    ["no owner field", { isCrossRepository: false }],
    [
      "no cross-repo field",
      { headRepositoryOwner: { login: "mento-protocol" } },
    ],
    ["empty row", {}],
    ["null row", null],
  ]) {
    assertEqual(
      isOwnHeadPr(pr, "mento-protocol/monitoring-monorepo"),
      false,
      `${label} must not read as ours`,
    );
  }
  assertEqual(isOwnHeadPr(ours, ""), false, "an unparsable repo is not ours");
});

await test("a transient open-PR read failure skips ONE stub, never the whole leg", async () => {
  // This read is issued once per surviving stub — a whole-window count now, not
  // a capped one. It sat outside the fail-soft try/catch that covers the stub
  // read, so one `gh` rejection rejected out of the selector, exited nonzero and
  // failed the select step under `set -euo pipefail` — breaking the workflow
  // header's "ALWAYS emits a valid JSON array … never a failure" invariant.
  const stubs = [stub({ number: 42, shortId: "APP-MENTO-ORG-2B" })];
  const { runGh } = makeRunGh({
    stubs,
    prListError: "gh pr list failed with exit 1: API rate limit exceeded",
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
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

await test("only queries PRs after cheaper checks pass (no wasted pr list)", async () => {
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
    !calls.some((c) => c[0] === "pr" && c[1] === "list"),
    "should not query PRs for a stub already deduped by label",
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
 * member actually carried. */
function familyStub(number, shortId, createdAt, duplicates) {
  return stub({
    number,
    shortId,
    createdAt,
    comments: [verdictComment({ createdAt, duplicates })],
  });
}

/** The anchor (#1304 / ANALYTICS-MENTO-ORG-2E) plus its five back-pointing
 * siblings, in the order the queue created them. */
function realFamilyStubs() {
  return [
    familyStub(
      1304,
      "ANALYTICS-MENTO-ORG-2E",
      "2026-07-16T17:27:24Z",
      FAMILY_2E_DUPLICATES,
    ),
    familyStub(1313, "ANALYTICS-MENTO-ORG-2F", "2026-07-16T17:27:37Z", [
      "ANALYTICS-MENTO-ORG-2E",
    ]),
    familyStub(1316, "ANALYTICS-MENTO-ORG-29", "2026-07-16T17:27:41Z", [
      "ANALYTICS-MENTO-ORG-2E",
    ]),
    familyStub(1326, "ANALYTICS-MENTO-ORG-2A", "2026-07-16T17:27:54Z", [
      "ANALYTICS-MENTO-ORG-2E",
    ]),
    familyStub(1328, "ANALYTICS-MENTO-ORG-2D", "2026-07-16T17:27:56Z", [
      "ANALYTICS-MENTO-ORG-2E",
    ]),
  ];
}

/** The four siblings WITHOUT the anchor — the shape the window actually has on
 * the run after 2E was handled: four stubs joined only through an id that is
 * not itself a candidate. */
function orphanedFamilyStubs() {
  return realFamilyStubs().slice(1);
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
    calls.filter((c) => c[0] === "pr" && c[1] === "list").length,
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
        createdAt: `2026-07-18T00:${String(i).padStart(2, "0")}:00Z`,
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
        (call[0] === "pr" && call[1] === "list"),
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
// § "Cost bound"): 1 window list + MAX_CANDIDATE_EVALUATIONS × 2 reads +
// MAX_HANDLED_ID_QUERIES + MAX_REVERSE_PROBE_QUERIES + ~40 cached verify reads
// ≈ 220. Load-bearing: the worst-case test below drives EVERY leg to its cap, so
// removing a cap breaches this number.
const DOCUMENTED_GH_CEILING = 225;

await test("cost pin: an EMPTY-family 50-stub window issues no per-id or reverse work", async () => {
  // Baseline only: default stubs declare nothing, so declaredIds is empty (zero
  // in:title lookups) and every family is a singleton (each finalist's members =
  // its own id). This pins the empty-window profile — ~1 window + 50 views + 50
  // pr lists — but it CANNOT exercise the per-id or reverse loops, so it is not
  // the regression guard for their caps; the worst-case window below is.
  const stubs = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS; i += 1) {
    stubs.push(
      stub({
        number: 4000 + i,
        shortId: `ANALYTICS-MENTO-ORG-C${i}`,
        createdAt: `2026-07-18T00:${String(i).padStart(2, "0")}:00Z`,
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
  const at = () => `2026-07-18T00:${String(created++).padStart(2, "0")}:00Z`;
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
  });
  const dispatch = await selectAutofixRun(
    { repo: "o/r", issue: 810 },
    { runGh },
  );
  assertDeepEqual(dispatch.truncations, {
    handledOverflow: 0,
    reverseBudget: false,
    reverseNonconvergent: false,
  });
});

await test("window report: a run surfaces total and evaluated when the window exceeds the eval cap", async () => {
  const stubs = [];
  for (let i = 0; i < MAX_CANDIDATE_EVALUATIONS + 1; i += 1) {
    stubs.push(
      stub({
        number: 5000 + i,
        shortId: `ANALYTICS-MENTO-ORG-W${i}`,
        createdAt: `2026-07-18T00:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
  }
  const { runGh } = makeRunGh({ stubs });
  const { window } = await selectAutofixRun({ repo: "o/r", cap: 2 }, { runGh });
  assertDeepEqual(window, {
    total: MAX_CANDIDATE_EVALUATIONS + 1,
    evaluated: MAX_CANDIDATE_EVALUATIONS,
  });
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

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
