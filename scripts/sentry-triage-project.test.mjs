#!/usr/bin/env node
import {
  ALLOWED_OWNING_REPOS,
  bodyBacklinksShortId,
  buildProjectedBody,
  buildProjectedTitle,
  buildProjectionMarker,
  defangBackticks,
  defangMentions,
  extractPermalink,
  extractYamlBlock,
  isValidShortId,
  neutralizeBlock,
  neutralizeUntrusted,
  parseArgs,
  parseShortId,
  parseVerdictComment,
  PROJECTED_LABEL,
  runProjection,
  sanitizeDuplicateIds,
  sanitizeFreeText,
  selectVerdictComment,
  validateAffectedRepo,
  VERDICT_MARKER,
} from "./sentry-triage-project.mjs";

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

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected function to throw");
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected promise to reject");
}

// Build a verdict comment body the way the triage agent would.
function verdictComment({
  verdict = "code-fix",
  confidence = "medium",
  affectedRepo = "mento-protocol/frontend-monorepo",
  summary = "A short summary",
  rootCause = "  Some abstract root cause.\n  Second line.",
  proposedAction = "  Some abstract action.",
  duplicates = "[]",
} = {}) {
  return [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict} # code-fix | config-fix | upstream-transient | needs-human`,
    `confidence: ${confidence} # high | medium | low`,
    `affected_repo: ${affectedRepo}`,
    `summary: ${summary}`,
    "root_cause: |",
    rootCause,
    "proposed_action: |",
    proposedAction,
    `duplicate_of: ${duplicates}`,
    "```",
    "",
    "Prose diagnosis goes here.",
  ].join("\n");
}

const PERMALINK = "https://mento-labs.sentry.io/issues/6197137101/";

function queueIssue({
  number = 500,
  shortId = "APP-MENTO-ORG-12",
  project = "app-mento-org",
  labels = ["sentry-triage", "sentry:verdict-code-fix"],
  comments,
} = {}) {
  return {
    number,
    title: `[sentry] ${shortId} (${project}, error)`,
    body: [
      "<!-- sentry-triage:v1 -->",
      "",
      "```yaml",
      `short_id: "${shortId}"`,
      `permalink: "${PERMALINK}"`,
      "```",
      "",
      `[View in Sentry](${PERMALINK})`,
    ].join("\n"),
    url: `https://github.com/mento-protocol/monitoring-monorepo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    comments: comments ?? [
      { body: verdictComment(), createdAt: "2026-07-17T10:00:00Z" },
    ],
  };
}

// A mock `gh` runner covering the calls runProjection makes. Records every call
// with the token it was invoked under so token routing is assertable.
function makeRunGh({ issue, existing = [], createdUrl = null } = {}) {
  const calls = [];
  const runGh = async (args, opts = {}) => {
    calls.push({ args, token: opts.token ?? null });
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "view") {
      return JSON.stringify(issue);
    }
    if (a0 === "issue" && a1 === "list") {
      return JSON.stringify(existing);
    }
    if (a0 === "issue" && a1 === "create") {
      if (createdUrl == null)
        throw new Error("gh issue create failed: HTTP 403");
      return `${createdUrl}\n`;
    }
    if (a0 === "issue" && (a1 === "edit" || a1 === "comment")) {
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

const PAT = "ghp_projection_token";
const CREATED_URL =
  "https://github.com/mento-protocol/frontend-monorepo/issues/999";

// ---------------------------------------------------------------------------
// Neutralization
// ---------------------------------------------------------------------------

await test("sanitizeFreeText collapses control chars/newlines to single spaces", () => {
  assertEqual(sanitizeFreeText("a\nb\tc   d"), "a b c d");
});

await test("defangBackticks replaces every backtick with a look-alike", () => {
  const out = defangBackticks("```yaml evil ` fence");
  assert(!out.includes("`"), "expected no real backticks");
});

await test("defangMentions inserts a zero-width space after every @", () => {
  const out = defangMentions("@channel and @org/team");
  assert(
    !/@[a-z]/i.test(out),
    "expected no live mention (@ followed by a letter)",
  );
  assert(out.includes("@​"), "expected zero-width space after @");
});

await test("neutralizeUntrusted defangs mentions + backticks and single-lines", () => {
  const out = neutralizeUntrusted("`x`\n@here <b>");
  assert(!out.includes("`"), "expected backticks defanged");
  assert(!out.includes("\n"), "expected single line");
  assert(out.includes("@​"), "expected mention defanged");
});

await test("neutralizeBlock keeps newlines but defangs and bounds", () => {
  const out = neutralizeBlock("line one\n```\n@here\nline four");
  assert(out.includes("\n"), "expected newlines preserved");
  assert(!out.includes("`"), "expected backticks defanged");
  assert(out.includes("@​"), "expected mention defanged");
});

await test("neutralizeBlock hard-bounds line count and length", () => {
  const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  assert(
    neutralizeBlock(manyLines).split("\n").length <= 8,
    "expected <=8 lines",
  );
  const long = "z".repeat(2000);
  assert(
    neutralizeBlock(long).length <= 601,
    "expected length bound + ellipsis",
  );
});

// ---------------------------------------------------------------------------
// Title / short id / permalink parsing
// ---------------------------------------------------------------------------

await test("parseShortId extracts the short id from a v2 queue title", () => {
  assertEqual(
    parseShortId(
      "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
    ),
    "GOVERNANCE-MENTO-ORG-51",
  );
  assertEqual(parseShortId("not a queue title"), null);
});

await test("isValidShortId accepts Sentry short ids and rejects junk", () => {
  assert(isValidShortId("APP-MENTO-ORG-12"), "expected valid");
  assert(!isValidShortId("has space"), "expected space rejected");
  assert(!isValidShortId("with/slash"), "expected slash rejected");
  assert(!isValidShortId(""), "expected empty rejected");
  assert(!isValidShortId("`inject`"), "expected backtick rejected");
});

await test("extractPermalink returns the permalink only for an https sentry.io url", () => {
  assertEqual(
    extractPermalink(`short_id: "X"\npermalink: "${PERMALINK}"`),
    PERMALINK,
  );
  assertEqual(
    extractPermalink('permalink: "https://evil.example.com/x"'),
    null,
  );
  assertEqual(extractPermalink("no permalink here"), null);
});

// ---------------------------------------------------------------------------
// Verdict-comment parsing (richer than digest)
// ---------------------------------------------------------------------------

await test("extractYamlBlock pulls the fenced yaml block only", () => {
  const block = extractYamlBlock(verdictComment());
  assert(block.includes("verdict: code-fix"), "expected verdict line");
  assert(!block.includes("Prose diagnosis"), "expected prose excluded");
});

await test("parseVerdictComment reads all verdict-contract fields", () => {
  const parsed = parseVerdictComment(
    verdictComment({
      verdict: "config-fix",
      confidence: "high",
      affectedRepo: "mento-protocol/minipay-dapp",
      summary: "CSP allowlist missing a domain # not a comment",
      rootCause: "  Missing directive.\n  Blocked a script host.",
      proposedAction: "  Add the host to the CSP allowlist.",
      duplicates: "[MINIPAY-DAPP-3, MINIPAY-DAPP-9]",
    }),
  );
  assertEqual(parsed.verdict, "config-fix");
  assertEqual(parsed.confidence, "high");
  assertEqual(parsed.affectedRepo, "mento-protocol/minipay-dapp");
  assertEqual(parsed.summary, "CSP allowlist missing a domain # not a comment");
  assertEqual(parsed.rootCause, "Missing directive.\nBlocked a script host.");
  assertEqual(parsed.proposedAction, "Add the host to the CSP allowlist.");
  assertDeepEqual(parsed.duplicateOf, ["MINIPAY-DAPP-3", "MINIPAY-DAPP-9"]);
});

await test("parseVerdictComment rejects out-of-enum verdict/confidence to null", () => {
  const parsed = parseVerdictComment(
    verdictComment({ verdict: "totally-bogus", confidence: "certain" }),
  );
  assertEqual(parsed.verdict, null);
  assertEqual(parsed.confidence, null);
});

await test("parseVerdictComment extracts a bare repo slug from affected_repo, else empty", () => {
  assertEqual(
    parseVerdictComment(verdictComment({ affectedRepo: "not-a-repo" }))
      .affectedRepo,
    "",
  );
});

await test("parseVerdictComment reads a block-style duplicate_of list", () => {
  const body = [
    VERDICT_MARKER,
    "```yaml",
    "verdict: code-fix",
    "confidence: low",
    "affected_repo: mento-protocol/frontend-monorepo",
    "summary: x",
    "duplicate_of:",
    "  - APP-MENTO-ORG-1",
    "  - APP-MENTO-ORG-2",
    "```",
  ].join("\n");
  assertDeepEqual(parseVerdictComment(body).duplicateOf, [
    "APP-MENTO-ORG-1",
    "APP-MENTO-ORG-2",
  ]);
});

await test("sanitizeDuplicateIds drops anything that is not a short-id shape", () => {
  assertDeepEqual(
    sanitizeDuplicateIds(["APP-1", "has space", "`inject`", "OK-2"]),
    ["APP-1", "OK-2"],
  );
});

// ---------------------------------------------------------------------------
// Regression fence (mirrors the workflow label step)
// ---------------------------------------------------------------------------

await test("selectVerdictComment returns the newest verdict comment", () => {
  const comments = [
    {
      body: verdictComment({ summary: "older" }),
      createdAt: "2026-07-17T09:00:00Z",
    },
    { body: "chatter", createdAt: "2026-07-17T09:30:00Z" },
    {
      body: verdictComment({ summary: "newest" }),
      createdAt: "2026-07-17T10:00:00Z",
    },
  ];
  const selected = selectVerdictComment(comments);
  assert(selected.body.includes("summary: newest"), "expected newest verdict");
});

await test("selectVerdictComment rejects a stale pre-regression verdict", () => {
  const comments = [
    { body: verdictComment(), createdAt: "2026-07-17T09:00:00Z" },
    {
      body: "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      createdAt: "2026-07-17T10:00:00Z",
    },
  ];
  const selected = selectVerdictComment(comments);
  assertEqual(selected.body, null);
  assertEqual(selected.reason, "stale-verdict");
});

await test("selectVerdictComment accepts a fresh post-regression verdict", () => {
  const comments = [
    {
      body: verdictComment({ summary: "old" }),
      createdAt: "2026-07-17T09:00:00Z",
    },
    {
      body: "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      createdAt: "2026-07-17T10:00:00Z",
    },
    {
      body: verdictComment({ summary: "fresh" }),
      createdAt: "2026-07-17T12:00:00Z",
    },
  ];
  const selected = selectVerdictComment(comments);
  assert(
    selected.body.includes("summary: fresh"),
    "expected fresh verdict accepted",
  );
});

await test("selectVerdictComment reports no-verdict-comment when none present", () => {
  assertDeepEqual(selectVerdictComment([{ body: "hi", createdAt: "x" }]), {
    body: null,
    reason: "no-verdict-comment",
  });
});

// ---------------------------------------------------------------------------
// Allowlist validation
// ---------------------------------------------------------------------------

await test("validateAffectedRepo accepts each allowlisted owning repo", () => {
  for (const repo of ALLOWED_OWNING_REPOS) {
    const check = validateAffectedRepo(repo);
    assert(check.projectable, `expected ${repo} projectable`);
    assertEqual(check.repo, repo);
    assertEqual(check.warning, null);
  }
});

await test("validateAffectedRepo treats this repo as non-projectable, no warning", () => {
  const check = validateAffectedRepo("mento-protocol/monitoring-monorepo");
  assert(!check.projectable, "expected not projectable");
  assertEqual(check.reason, "local-repo");
  assertEqual(check.warning, null);
});

await test("validateAffectedRepo warns and refuses an unrecognized repo", () => {
  const check = validateAffectedRepo("attacker/evil-repo");
  assert(!check.projectable, "expected not projectable");
  assertEqual(check.reason, "unrecognized-repo");
  assert(
    check.warning && check.warning.includes("not in the projection allowlist"),
    "expected warning",
  );
  assertEqual(check.repo, "mento-protocol/monitoring-monorepo");
});

await test("validateAffectedRepo warns on an empty affected_repo", () => {
  const check = validateAffectedRepo("");
  assert(!check.projectable, "expected not projectable");
  assert(check.warning.includes("(empty)"), "expected empty warning");
});

// ---------------------------------------------------------------------------
// Idempotency marker
// ---------------------------------------------------------------------------

await test("buildProjectionMarker + bodyBacklinksShortId round-trip", () => {
  const marker = buildProjectionMarker("APP-MENTO-ORG-12");
  assert(
    marker.includes("sentry-projection:v1 APP-MENTO-ORG-12"),
    "expected marker text",
  );
  assert(
    bodyBacklinksShortId(`prefix\n${marker}\nsuffix`, "APP-MENTO-ORG-12"),
    "expected backlink match",
  );
  assert(
    !bodyBacklinksShortId("no marker", "APP-MENTO-ORG-12"),
    "expected no match",
  );
  assert(
    !bodyBacklinksShortId(marker, "bad id"),
    "expected invalid short id rejected",
  );
});

// ---------------------------------------------------------------------------
// Projected issue rendering
// ---------------------------------------------------------------------------

await test("buildProjectedTitle escapes and bounds the summary", () => {
  assertEqual(
    buildProjectedTitle("Null deref in pool page"),
    "Sentry: Null deref in pool page",
  );
  const hostile = buildProjectedTitle("`@channel` " + "z".repeat(400));
  assert(!hostile.includes("`"), "expected backticks defanged");
  assert(hostile.includes("@​"), "expected mention defanged");
  assert(hostile.length <= 210, "expected bounded title");
});

await test("buildProjectedBody renders contract fields, links, footer, and marker", () => {
  const body = buildProjectedBody({
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "medium",
    summary: "Null deref rendering the pool header",
    rootCause: "Guard missing on an undefined pool.",
    proposedAction: "Add an early return when the pool is absent.",
    duplicateOf: ["APP-MENTO-ORG-13"],
    permalink: PERMALINK,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  });
  assert(
    body.includes(buildProjectionMarker("APP-MENTO-ORG-12")),
    "expected marker",
  );
  assert(body.includes("`code-fix`"), "expected verdict");
  assert(body.includes("(confidence: `medium`)"), "expected confidence");
  assert(
    body.includes("Null deref rendering the pool header"),
    "expected summary",
  );
  assert(
    body.includes("```text"),
    "expected fenced blocks for root cause / action",
  );
  assert(body.includes("`APP-MENTO-ORG-13`"), "expected duplicate id");
  assert(
    body.includes(`[View the error in Sentry](${PERMALINK})`),
    "expected sentry link",
  );
  assert(
    body.includes(
      "Central triage queue stub: https://github.com/mento-protocol/monitoring-monorepo/issues/500",
    ),
    "expected back-link",
  );
  assert(body.includes("ADR 0036 / ADR 0038"), "expected footer");
});

await test("buildProjectedBody neutralizes a hostile summary and fenced blocks", () => {
  const body = buildProjectedBody({
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "low",
    summary: "@channel ping ```js\nrm -rf\n```",
    rootCause: "```\n@here breakout\n```",
    proposedAction: "",
    duplicateOf: [],
    permalink: null,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  });
  // No live mention (defang inserts a ZWSP, so the contiguous "@channel" is
  // gone) and no fence breakout (all backticks in agent text defanged).
  assert(!body.includes("@channel"), "expected no live @channel mention");
  assert(!body.includes("```js"), "expected no agent-supplied code fence");
  assert(
    body.includes("**Possible duplicate Sentry issues:** none"),
    "expected none for empty dups",
  );
  assert(
    body.includes("_(none provided)_"),
    "expected placeholder for empty action",
  );
  // permalink omitted when null.
  assert(
    !body.includes("View the error in Sentry"),
    "expected no sentry link when permalink null",
  );
});

// ---------------------------------------------------------------------------
// Orchestration (runProjection with a mocked gh runner)
// ---------------------------------------------------------------------------

await test("runProjection projects a code-fix for an external repo end-to-end", async () => {
  const { runGh, calls } = makeRunGh({
    issue: queueIssue(),
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  assertEqual(result.url, CREATED_URL);

  const create = calls.find((c) => c.args[1] === "create");
  assert(create, "expected an issue create call");
  // Cross-repo create uses the PAT and targets the owning repo.
  assertEqual(create.token, PAT);
  assertEqual(
    create.args[create.args.indexOf("-R") + 1],
    "mento-protocol/frontend-monorepo",
  );

  // The idempotency search also used the PAT + owning repo.
  const list = calls.find((c) => c.args[1] === "list");
  assertEqual(list.token, PAT);

  // Local stub mutations use the ambient token (null), never the PAT.
  const edit = calls.find((c) => c.args[1] === "edit");
  const comment = calls.find((c) => c.args[1] === "comment");
  assertEqual(edit.token, null);
  assertEqual(comment.token, null);
  assertEqual(
    edit.args[edit.args.indexOf("-R") + 1],
    "mento-protocol/monitoring-monorepo",
  );
  assert(
    edit.args.includes(PROJECTED_LABEL),
    "expected sentry:projected label add",
  );
  assert(
    comment.args.some((a) => a.includes(CREATED_URL)),
    "expected stub comment links the projected url",
  );
  // The read used the ambient token too.
  const view = calls.find((c) => c.args[1] === "view");
  assertEqual(view.token, null);
});

await test("runProjection projects config-fix as well", async () => {
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-config-fix"],
    comments: [
      {
        body: verdictComment({
          verdict: "config-fix",
          affectedRepo: "mento-protocol/mento-analytics-api",
        }),
        createdAt: "2026-07-17T10:00:00Z",
      },
    ],
  });
  const { runGh, calls } = makeRunGh({
    issue,
    createdUrl:
      "https://github.com/mento-protocol/mento-analytics-api/issues/7",
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  const create = calls.find((c) => c.args[1] === "create");
  assertEqual(
    create.args[create.args.indexOf("-R") + 1],
    "mento-protocol/mento-analytics-api",
  );
});

await test("runProjection is idempotent: reuses an existing back-linked issue", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: `stuff\n${buildProjectionMarker("APP-MENTO-ORG-12")}\nmore`,
    },
  ];
  // Stub does not yet carry the projected label -> reused path still marks it.
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix"],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assertEqual(
    result.url,
    "https://github.com/mento-protocol/frontend-monorepo/issues/42",
  );
  assert(
    !calls.some((c) => c.args[1] === "create"),
    "expected NO create on the reused path",
  );
  assert(
    calls.some((c) => c.args[1] === "edit"),
    "expected the stub still gets labeled",
  );
});

await test("runProjection reused path skips the stub comment when already projected", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: buildProjectionMarker("APP-MENTO-ORG-12"),
    },
  ];
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix", PROJECTED_LABEL],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assert(
    !calls.some((c) => c.args[1] === "comment"),
    "expected no duplicate stub comment",
  );
});

await test("runProjection skips a non-actionable verdict (needs-human)", async () => {
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-needs-human"],
    comments: [
      {
        body: verdictComment({ verdict: "needs-human" }),
        createdAt: "2026-07-17T10:00:00Z",
      },
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-verdict");
  assert(!calls.some((c) => c.args[1] === "create"), "expected no create");
});

await test("runProjection skips when affected_repo is this repo", async () => {
  const issue = queueIssue({
    comments: [
      {
        body: verdictComment({
          affectedRepo: "mento-protocol/monitoring-monorepo",
        }),
        createdAt: "2026-07-17T10:00:00Z",
      },
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-repo");
  assertEqual(result.reason, "local-repo");
  assert(!calls.some((c) => c.args[1] === "create"), "expected no create");
});

await test("runProjection skips an unrecognized affected_repo (no cross-repo write)", async () => {
  const issue = queueIssue({
    comments: [
      {
        body: verdictComment({ affectedRepo: "attacker/evil-repo" }),
        createdAt: "2026-07-17T10:00:00Z",
      },
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-repo");
  assertEqual(result.reason, "unrecognized-repo");
  assert(
    !calls.some((c) => c.args[1] === "create" || c.args[1] === "list"),
    "expected no owning-repo calls",
  );
});

await test("runProjection no-ops gracefully without the projection token", async () => {
  const { runGh, calls } = makeRunGh({ issue: queueIssue() });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: "",
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-no-token");
  assert(
    !calls.some((c) => c.args[1] === "create"),
    "expected no create without a token",
  );
});

await test("runProjection fails loud when there is no usable verdict comment", async () => {
  const issue = queueIssue({ comments: [{ body: "chatter", createdAt: "x" }] });
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /No usable verdict comment/,
  );
});

await test("runProjection fails loud on a stale pre-regression verdict", async () => {
  const issue = queueIssue({
    comments: [
      { body: verdictComment(), createdAt: "2026-07-17T09:00:00Z" },
      {
        body: "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
        createdAt: "2026-07-17T10:00:00Z",
      },
    ],
  });
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /stale-verdict/,
  );
});

await test("runProjection fails loud when the queue title has no short id", async () => {
  const issue = queueIssue();
  issue.title = "totally unrelated title";
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /no parseable Sentry short-ID/,
  );
});

await test("runProjection propagates a cross-repo create failure (fail loud)", async () => {
  const { runGh } = makeRunGh({ issue: queueIssue(), createdUrl: null });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /HTTP 403/,
  );
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

await test("parseArgs reads --issue/--repo and the token from env", () => {
  const options = parseArgs(["--issue", "500", "--repo", "o/r"], {
    SENTRY_PROJECTION_TOKEN: "tok",
  });
  assertEqual(options.queueIssue, 500);
  assertEqual(options.localRepo, "o/r");
  assertEqual(options.projectionToken, "tok");
});

await test("parseArgs defaults repo and empties an absent token", () => {
  const options = parseArgs(["--issue", "1"], {});
  assertEqual(options.localRepo, "mento-protocol/monitoring-monorepo");
  assertEqual(options.projectionToken, "");
});

await test("parseArgs rejects a non-integer issue and unknown options", () => {
  assertThrows(() => parseArgs(["--issue", "x"], {}), /positive integer/);
  assertThrows(() => parseArgs(["--issue", "0"], {}), /positive integer/);
  assertThrows(() => parseArgs(["--nope"], {}), /Unknown option/);
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
