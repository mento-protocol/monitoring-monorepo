#!/usr/bin/env node
import {
  AUTOFIX_SELECT_LABEL,
  DEFAULT_CAP,
  emitVerdict,
  isOwnHeadPr,
  LOCAL_SENTRY_PROJECT,
  MAX_CANDIDATE_EVALUATIONS,
  parseArgs,
  selectAutofixCandidates,
  selectAutofixRun,
  SKIP_FIX_SCOPE_ARCHITECTURAL,
} from "./sentry-autofix-select.mjs";
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
  const byNumber = new Map(stubs.map((s) => [String(s.number), s]));
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "list") {
      const searchIdx = args.indexOf("--search");
      const search = searchIdx === -1 ? "" : args[searchIdx + 1];
      // The handled-sibling query asks for a POSITIVE autofix marker label; the
      // candidate window asks for its NEGATION. Route on that difference.
      const marker = /(?:^|\s)label:"(sentry:fix-[a-z-]+)"/.exec(search);
      if (marker) {
        return JSON.stringify(
          handled
            .filter((h) => h.label === marker[1])
            .map((h, i) => ({
              number: 9000 + i,
              title: `[sentry] ${h.shortId} (analytics-mento-org, error)`,
            })),
        );
      }
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
        (c[0] === "pr" && c[1] === "list")
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
  // No refusal marker, no comment, no label — the whole point of the done-means:
  // an architectural stub must not accumulate sentry:fix-refused, which is
  // terminal and would stand its whole duplicate family down behind it. It does
  // NOT stay "in the queue" — a local code-fix stub is closed when its verdict
  // lands; the human backlog is the REPORTED skip, pinned further below.
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

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
