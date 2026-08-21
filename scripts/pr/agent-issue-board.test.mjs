#!/usr/bin/env node
import {
  buildClaimComment,
  buildBackfillPlan,
  backfill,
  chooseUntriedCandidate,
  githubProjectScopeHint,
  isClaimable,
  isBackfillable,
  isReleasable,
  isRecoverableClaimRaceError,
  isReviewable,
  labelsForState,
  parseArgs,
  parseIssueNumbers,
  projectDateFieldValue,
  projectPrFieldValue,
  parseClaimComment,
  selectNewestTrustedClaim,
  selectStatusOption,
  shouldRollbackFailedTransition,
  stateFromLabels,
  validateOpenPr,
} from "./agent-issue-board.mjs";
import {
  readBackfillProjectFields,
  writeBackfillProjectFields,
} from "./issue-board-projects.mjs";
import { listIssueComments } from "./issue-board-transport.mjs";

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result?.then) {
      pending.push(
        result.then(
          () => {
            process.stdout.write(`ok ${name}\n`);
            passed += 1;
          },
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`not ok ${name}\n  ${message}\n`);
            failed += 1;
          },
        ),
      );
      return;
    }
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

async function assertRejects(fn, pattern) {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected function to reject");
}

test("parses repeated, comma-separated, and URL issue references", () => {
  assertDeepEqual(
    parseIssueNumbers([
      "901,902",
      "#903",
      "https://github.com/mento-protocol/monitoring-monorepo/issues/904",
    ]),
    [901, 902, 903, 904],
  );
});

test("project scope failures name the read-write gh refresh command", () => {
  const hint = githubProjectScopeHint(
    "The 'projectV2' field requires one of the following scopes: ['read:project']",
    {},
  );
  assert(
    hint.includes("gh auth refresh -h github.com -s project"),
    "missing refresh command",
  );
  assert(
    hint.includes("`read:project` alone"),
    "missing read-only scope warning",
  );
});

test("project mutation scope failures receive the same guidance", () => {
  assert(
    githubProjectScopeHint(
      "This mutation requires one of the following scopes: ['project']",
      {},
    ).includes("read/write `project` scope"),
    "missing mutation scope guidance",
  );
});

test("project scope hints ignore scopes that are only granted", () => {
  assertEqual(
    githubProjectScopeHint(
      "The 'repository' field requires one of the following scopes: ['repo']\nThe active token has scopes: ['read:project']",
    ),
    "",
  );
});

test("environment-provided credentials receive replacement guidance", () => {
  const stderr =
    "The 'projectV2' field requires one of the following scopes: ['read:project']";
  for (const env of [{ GH_TOKEN: "token" }, { GITHUB_TOKEN: "token" }]) {
    const hint = githubProjectScopeHint(stderr, env);
    assert(
      hint.includes(
        "Replace the environment-provided GH_TOKEN or GITHUB_TOKEN",
      ),
      "missing environment credential guidance",
    );
    assert(
      !hint.includes("gh auth refresh -h github.com -s project"),
      "stored-credential refresh command should be omitted",
    );
  }
});

test("unrelated gh failures do not receive project scope guidance", () => {
  assertEqual(
    githubProjectScopeHint(
      "error connecting to api.github.com; check your internet connection",
    ),
    "",
  );
});

test("rejects issue URLs from another repository", () => {
  assertThrows(
    () =>
      parseIssueNumbers(
        ["https://github.com/other/repo/issues/904"],
        "mento-protocol/monitoring-monorepo",
      ),
    /does not match selected repo/,
  );
});

test("parses claim options for the monitoring workboard", () => {
  const args = parseArgs([
    "claim",
    "--count",
    "3",
    "--agent",
    "codex",
    "--branch",
    "agent/issues",
    "--dry-run",
  ]);

  assertEqual(args.command, "claim");
  assertEqual(args.count, 3);
  assertEqual(args.agent, "codex");
  assertEqual(args.branch, "agent/issues");
  assertEqual(args.projectOwner, "mento-protocol");
  assertEqual(args.projectNumber, 12);
  assertEqual(args.dryRun, true);
});

test("backfill requires exactly one explicit issue", () => {
  const options = parseArgs(["board", "backfill", "--issue", "901"]);
  assertEqual(options.issues[0], 901);
  assertEqual(options.backfillIssueFlags, undefined);
  assertEqual(options.positionalIssueValues, undefined);
  for (const argv of [
    ["board", "backfill"],
    ["board", "backfill", "901"],
    ["board", "backfill", "--issue", "901", "--issue", "902"],
    ["board", "backfill", "--issue", "901,902"],
    ["board", "backfill", "--issue", "901,901"],
    ["board", "backfill", "--issue", "0"],
    ["board", "backfill", "--issues", "901"],
  ]) {
    assertThrows(() => parseArgs(argv), /exactly one explicit --issue/);
  }
});

test("parses PR URLs only for the selected repository", () => {
  assertEqual(
    parseArgs([
      "review",
      "--repo",
      "mento-protocol/monitoring-monorepo",
      "--pr",
      "https://github.com/mento-protocol/monitoring-monorepo/pull/984",
    ]).pr,
    984,
  );
  assertEqual(
    parseArgs([
      "review",
      "--pr",
      "https://github.com/other/repo/pull/123",
      "--repo",
      "other/repo",
    ]).pr,
    123,
  );
  assertThrows(
    () =>
      parseArgs([
        "review",
        "--repo",
        "mento-protocol/monitoring-monorepo",
        "--pr",
        "https://github.com/other/repo/pull/123",
      ]),
    /does not match selected repo/,
  );
});

test("review PR guard requires an open PR", () => {
  assertEqual(
    validateOpenPr(
      { id: "PR_123", state: "OPEN" },
      { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
    ).id,
    "PR_123",
  );
  assertThrows(
    () =>
      validateOpenPr(null, {
        pr: 984,
        repo: "mento-protocol/monitoring-monorepo",
      }),
    /was not found/,
  );
  assertThrows(
    () =>
      validateOpenPr(
        { id: "PR_123", state: "CLOSED" },
        { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
      ),
    /requires an open PR/,
  );
});

test("review falls back to In Progress when In Review is absent", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "progress", name: "In Progress" },
      { id: "done", name: "Done" },
    ],
    "review",
  );

  assertEqual(option.id, "progress");
});

test("review prefers In Review when it is available", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "review", name: "In Review" },
      { id: "progress", name: "In Progress" },
    ],
    "review",
  );

  assertEqual(option.id, "review");
});

test("grooming prefers Needs Grooming over Blocked", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "blocked", name: "Blocked" },
      { id: "grooming", name: "Needs Grooming" },
    ],
    "grooming",
  );

  assertEqual(option.id, "grooming");
});

test("claim candidate selector skips already tried issues", () => {
  const option = chooseUntriedCandidate(
    [{ number: 901 }, { number: 902 }],
    new Set([901]),
  );

  assertEqual(option.number, 902);
  assertEqual(chooseUntriedCandidate([{ number: 901 }], new Set([901])), null);
});

test("active label transition claims the issue and removes stale state", () => {
  assertDeepEqual(labelsForState("active"), {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
    statusOptions: ["In Progress"],
  });
});

test("closed in-pr issues sync to done and clear state labels", () => {
  assertEqual(
    stateFromLabels({
      state: "CLOSED",
      labels: [{ name: "in-pr" }],
    }),
    "done",
  );
  assertDeepEqual(labelsForState("done"), {
    addLabels: [],
    removeLabels: ["agent-ready", "agent-active", "in-pr", "needs-grooming"],
    statusOptions: ["Done"],
  });
});

test("claim guard only accepts open agent-ready issues", () => {
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    true,
  );
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }, { name: "agent-active" }],
    }),
    false,
  );
  assertEqual(
    isClaimable({
      state: "CLOSED",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
});

test("review guard only accepts open agent-active issues", () => {
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "needs-grooming" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "CLOSED",
      labels: [{ name: "agent-active" }],
    }),
    false,
  );
});

test("release guard only accepts open active or review queue issues", () => {
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    }),
    true,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "CLOSED",
      labels: [{ name: "in-pr" }],
    }),
    false,
  );
});

test("PR project field formatting clears null releases", () => {
  assertEqual(projectPrFieldValue(984), "#984");
  assertEqual(projectPrFieldValue(null), null);
  assertEqual(projectPrFieldValue(undefined), null);
});

test("Claimed At project field formatting clears null releases", () => {
  assertEqual(projectDateFieldValue("2026-06-17T10:00:00.000Z"), "2026-06-17");
  assertEqual(projectDateFieldValue(null), null);
  assertEqual(projectDateFieldValue(undefined), null);
});

test("failed claim setup rolls back unless another claim is observed", () => {
  assertEqual(shouldRollbackFailedTransition("active", "ready"), true);
  assertEqual(shouldRollbackFailedTransition("active", "ready", true), false);
  assertEqual(shouldRollbackFailedTransition("review", "active"), true);
  assertEqual(shouldRollbackFailedTransition("ready", null), false);
});

test("claim queue treats stale claim races as recoverable", () => {
  assertEqual(
    isRecoverableClaimRaceError(
      new Error("Issue #901 claim was overwritten; project Claim ID is other"),
    ),
    true,
  );
  assertEqual(
    isRecoverableClaimRaceError(new Error("gh api graphql failed")),
    false,
  );
});

test("claim comment records agent, issue, claim id, and branch", () => {
  const comment = buildClaimComment(
    {
      agent: "codex",
      branch: "agent/issue-901",
      claimId: "codex-20260617T100000",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );

  assert(comment.includes("codex claimed #901"), "missing agent claim line");
  assert(comment.includes("Claim ID: codex-20260617T100000"), "missing claim");
  assert(comment.includes("Branch: agent/issue-901"), "missing branch");
});

function trustedComment({
  id = "comment-1",
  createdAt = "2026-08-20T10:00:00.000Z",
  association = "MEMBER",
  issue = 901,
  agent = "codex",
  claimId = "claim-1",
  branch = "agent/901",
  claimedAt = "2026-08-20T09:00:00.000Z",
} = {}) {
  return {
    id,
    createdAt,
    authorAssociation: association,
    body: [
      `Agent claim: ${agent} claimed #${issue} for implementation.`,
      "",
      `Claim ID: ${claimId}`,
      `Branch: ${branch}`,
      `Claimed at: ${claimedAt}`,
    ].join("\n"),
  };
}

test("claim parser rejects conflicting newest-time claims and collapses identical ties", () => {
  assertThrows(
    () =>
      selectNewestTrustedClaim(
        [
          trustedComment({ id: "a", claimId: "first" }),
          trustedComment({ id: "b", claimId: "second" }),
        ],
        901,
      ),
    /ambiguous trusted claims/,
  );
  const newest = selectNewestTrustedClaim(
    [
      trustedComment({
        id: "b",
        claimId: "same",
        createdAt: "2026-08-21T10:00:00.000Z",
      }),
      trustedComment({
        id: "a",
        claimId: "same",
        createdAt: "2026-08-21T10:00:00.000Z",
      }),
    ],
    901,
  );
  assertEqual(newest.id, "a");
  assertEqual(newest.metadata["Claim ID"], "same");
});

test("claim parser ignores untrusted, wrong-issue, malformed, and missing-field comments", () => {
  const missing = trustedComment();
  missing.body = missing.body.replace("Branch: agent/901\n", "");
  const missingId = trustedComment();
  delete missingId.id;
  for (const comment of [
    trustedComment({ association: "CONTRIBUTOR", claimId: "untrusted" }),
    trustedComment({ issue: 902, claimId: "wrong" }),
    trustedComment({ createdAt: "not-a-timestamp" }),
    missingId,
    {
      ...trustedComment({ claimId: "bad" }),
      body: "Agent claim: codex claimed #901.",
    },
    missing,
  ]) {
    assertEqual(parseClaimComment(comment, 901), null);
  }
  const handoff = trustedComment();
  handoff.body += "\nProject #12 fields were not set from this session.";
  assertEqual(parseClaimComment(handoff, 901).metadata.Branch, "agent/901");
});

test("claim parser rejects unsafe text and invalid calendar dates", () => {
  for (const comment of [
    trustedComment({ agent: `a${"x".repeat(120)}` }),
    trustedComment({ claimId: `claim-${"x".repeat(160)}` }),
    trustedComment({ branch: `branch-${"x".repeat(250)}` }),
    trustedComment({ claimId: "claim\u0000id" }),
    trustedComment({ agent: " codex " }),
    trustedComment({ claimId: " claim-1 " }),
    trustedComment({ branch: " agent/901 " }),
    trustedComment({ claimedAt: "2026-02-30T09:00:00.000Z" }),
    trustedComment({ claimedAt: "2026-13-01T09:00:00.000Z" }),
  ]) {
    assertEqual(parseClaimComment(comment, 901), null);
  }
});

test("backfill state matrix accepts only open active or in-pr issues", () => {
  assertEqual(
    isBackfillable({ state: "OPEN", labels: [{ name: "agent-active" }] }),
    true,
  );
  assertEqual(
    isBackfillable({ state: "OPEN", labels: [{ name: "in-pr" }] }),
    true,
  );
  for (const issue of [
    { state: "CLOSED", labels: [{ name: "agent-active" }] },
    { state: "OPEN", labels: [{ name: "agent-ready" }] },
    { state: "OPEN", labels: [{ name: "agent-active" }, { name: "in-pr" }] },
    { state: "OPEN", labels: [{ name: "in-pr" }, { name: "needs-grooming" }] },
  ]) {
    assertEqual(isBackfillable(issue), false);
  }
});

test("backfill plan normalizes dates, fills only empties, and rejects conflicts", () => {
  const metadata = {
    Agent: "codex",
    "Claim ID": "claim-1",
    Branch: "agent/901",
    "Claimed At": projectDateFieldValue("2026-08-20T09:00:00.000Z"),
  };
  assertDeepEqual(
    buildBackfillPlan(
      { Agent: "codex", "Claim ID": "", Branch: null, "Claimed At": null },
      metadata,
    ),
    [
      { field: "Claim ID", value: "claim-1" },
      { field: "Branch", value: "agent/901" },
      { field: "Claimed At", value: "2026-08-20" },
    ],
  );
  assertDeepEqual(buildBackfillPlan(metadata, metadata), []);
  assertThrows(
    () => buildBackfillPlan({ ...metadata, Branch: "other" }, metadata),
    /conflicts/,
  );
});

function backfillFakes({
  values,
  comments = [trustedComment()],
  issue,
  mutate,
} = {}) {
  const project = {
    id: "project",
    title: "Workboard",
    fields: [
      { id: "agent", name: "Agent", dataType: "TEXT" },
      { id: "claim", name: "Claim ID", dataType: "TEXT" },
      { id: "branch", name: "Branch", dataType: "TEXT" },
      { id: "date", name: "Claimed At", dataType: "DATE" },
    ],
  };
  const state = {
    issue: issue ?? {
      number: 901,
      title: "Backfill",
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    },
    values: values ?? {
      Agent: null,
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
    },
    writes: [],
  };
  return {
    state,
    getProject: async () => project,
    getIssue: async () => ({ ...state.issue, labels: [...state.issue.labels] }),
    findIssueProjectItem: async () => "item",
    listIssueComments: async () => comments,
    requireBackfillFields: () => project.fields,
    readBackfillProjectFields: async () => ({ ...state.values }),
    writeBackfillProjectFields: async (_options, _project, _item, writes) => {
      state.writes.push(...writes);
      for (const write of writes) state.values[write.field] = write.value;
      mutate?.(state);
    },
  };
}

test("backfill dry-run has no writes and returns exact writes", async () => {
  const fakes = backfillFakes();
  const [result] = await backfill({ issues: [901], dryRun: true }, fakes);
  assertEqual(fakes.state.writes.length, 0);
  assertDeepEqual(
    result.writes.map((write) => write.field),
    ["Claim ID", "Agent", "Branch", "Claimed At"],
  );
});

test("backfill writes claim ID first, fills partial matches, and is idempotent", async () => {
  const fakes = backfillFakes({
    values: {
      Agent: "codex",
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
    },
  });
  const options = { issues: [901], dryRun: false };
  const [result] = await backfill(options, fakes);
  assertEqual(result.state, "backfilled");
  assertEqual(fakes.state.writes[0].field, "Claim ID");
  const [again] = await backfill(options, fakes);
  assertEqual(again.state, "backfill already matched");
  assertEqual(fakes.state.writes.length, 3);
});

test("backfill aborts conflicts before writes and detects post-write verification failure", async () => {
  const conflict = backfillFakes({
    values: {
      Agent: "other",
      "Claim ID": null,
      Branch: null,
      "Claimed At": null,
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, conflict),
    /conflicts/,
  );
  assertEqual(conflict.state.writes.length, 0);

  const broken = backfillFakes({
    mutate: (state) => {
      state.values.Branch = "other";
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, broken),
    /verification failed/,
  );
});

test("backfill re-reads and aborts when project values drift before writing", async () => {
  const fakes = backfillFakes();
  const read = fakes.readBackfillProjectFields;
  let reads = 0;
  fakes.readBackfillProjectFields = async (...args) => {
    reads += 1;
    if (reads === 2) fakes.state.values.Agent = "other";
    return read(...args);
  };
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

test("backfill aborts when one trusted comment ID changes metadata before write", async () => {
  const fakes = backfillFakes();
  let commentReads = 0;
  fakes.listIssueComments = async () => [
    trustedComment({
      claimedAt:
        commentReads++ === 0
          ? "2026-08-20T09:00:00.000Z"
          : "2026-08-20T10:00:00.000Z",
    }),
  ];
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

function backfillProject() {
  return {
    id: "project",
    fields: [
      { id: "agent", name: "Agent", dataType: "TEXT" },
      { id: "claim", name: "Claim ID", dataType: "TEXT" },
      { id: "branch", name: "Branch", dataType: "TEXT" },
      { id: "date", name: "Claimed At", dataType: "DATE" },
    ],
  };
}

function commentPage(
  nodes,
  pageInfo = { hasNextPage: false, endCursor: null },
) {
  return { data: { repository: { issue: { comments: { nodes, pageInfo } } } } };
}

test("comment adapter reads every page and rejects bad cursor progress or caps", async () => {
  const calls = [];
  const comments = await listIssueComments(
    { repo: "mento-protocol/monitoring-monorepo" },
    901,
    {
      graphql: async (_query, variables) => {
        calls.push(variables.cursor ?? null);
        return variables.cursor
          ? commentPage([trustedComment({ id: "two" })])
          : commentPage([trustedComment({ id: "one" })], {
              hasNextPage: true,
              endCursor: "next",
            });
      },
    },
  );
  assertDeepEqual(calls, [null, "next"]);
  assertEqual(comments.length, 2);
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: null }),
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: "same" }),
        maxPages: 3,
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      listIssueComments({ repo: "mento-protocol/monitoring-monorepo" }, 901, {
        graphql: async () =>
          commentPage([], { hasNextPage: true, endCursor: "next" }),
        maxPages: 1,
      }),
    /exceeded 1 pages/,
  );
});

test("project adapters paginate, decode values, order mutations, and reject bad cursors", async () => {
  const project = backfillProject();
  const readCalls = [];
  const values = await readBackfillProjectFields({}, project, "item", {
    graphql: async (_query, variables) => {
      readCalls.push(variables.cursor ?? null);
      return variables.cursor
        ? {
            data: {
              node: {
                fieldValues: {
                  nodes: [
                    { date: "2026-08-20", field: { id: "date" } },
                    { text: "agent/901", field: { id: "branch" } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }
        : {
            data: {
              node: {
                fieldValues: {
                  nodes: [
                    { text: "codex", field: { id: "agent" } },
                    { text: "claim-1", field: { id: "claim" } },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            },
          };
    },
  });
  assertDeepEqual(readCalls, [null, "next"]);
  assertDeepEqual(values, {
    Agent: "codex",
    "Claim ID": "claim-1",
    Branch: "agent/901",
    "Claimed At": "2026-08-20",
  });
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "same" },
              },
            },
          },
        }),
        maxPages: 3,
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: null },
              },
            },
          },
        }),
      }),
    /did not advance cursor/,
  );
  await assertRejects(
    () =>
      readBackfillProjectFields({}, project, "item", {
        graphql: async () => ({
          data: {
            node: {
              fieldValues: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
            },
          },
        }),
        maxPages: 1,
      }),
    /exceeded 1 pages/,
  );
  const writes = [];
  await writeBackfillProjectFields(
    { dryRun: false },
    project,
    "item",
    [
      { field: "Claim ID", value: "claim-1" },
      { field: "Agent", value: "codex" },
      { field: "Branch", value: "agent/901" },
      { field: "Claimed At", value: "2026-08-20" },
    ],
    {
      graphql: async (query, variables) => {
        writes.push({ query, variables });
        return { data: {} };
      },
    },
  );
  assertDeepEqual(
    writes.map((write) => write.variables.field),
    ["claim", "agent", "branch", "date"],
  );
  assertEqual(writes[0].variables.text, "claim-1");
  assertEqual(writes[3].variables.date, "2026-08-20");
  assert(writes[0].query.includes("text: $text"), "missing text mutation");
  assert(writes[3].query.includes("date: $date"), "missing date mutation");
});

await Promise.all(pending);

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
