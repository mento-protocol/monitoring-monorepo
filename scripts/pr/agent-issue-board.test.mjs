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
  IssueBoardSyncError,
  ISSUE_STATE_LABELS,
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
  sync,
  validateOpenPr,
} from "./agent-issue-board.mjs";
import {
  readBackfillProjectFields,
  writeBackfillProjectFields,
} from "./issue-board-projects.mjs";
import {
  listIssueComments,
  listIssuesByLabels,
} from "./issue-board-transport.mjs";

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    // The message is what says WHICH property was being asserted; call sites
    // already pass one, and dropping it left a bare value mismatch to read.
    throw new Error(
      `${message ? `${message}: ` : ""}expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
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

test("assertEqual reports the message its call site passed", () => {
  let thrown = null;
  try {
    assertEqual(3, 10, "the count is the signal; the list is an affordance");
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert(thrown !== null, "a mismatch must throw");
  assert(
    thrown.includes("the count is the signal; the list is an affordance"),
    `the failure output must name what was asserted; got: ${thrown}`,
  );
  assert(thrown.includes("expected 10, got 3"), `values kept: ${thrown}`);
});

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

test("queue-label issue lists use one all-state OR query", async () => {
  const calls = [];
  await listIssuesByLabels(
    { repo: "mento-protocol/monitoring-monorepo" },
    ISSUE_STATE_LABELS,
    {
      state: "all",
      json: async (args) => {
        calls.push(args);
        return [];
      },
    },
  );

  assertDeepEqual(calls, [
    [
      "issue",
      "list",
      "-R",
      "mento-protocol/monitoring-monorepo",
      "--state",
      "all",
      "--search",
      `is:issue label:${ISSUE_STATE_LABELS.join(",")}`,
      "--limit",
      "1000",
      "--json",
      "id,number,title,url,labels,state,projectItems",
    ],
  ]);
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

test("closed issues with any queue label sync to done", () => {
  for (const label of ISSUE_STATE_LABELS) {
    assertEqual(
      stateFromLabels({
        state: "CLOSED",
        labels: [{ name: label }],
      }),
      "done",
      label,
    );
  }
  assertDeepEqual(labelsForState("done"), {
    addLabels: [],
    removeLabels: ISSUE_STATE_LABELS,
    statusOptions: ["Done"],
  });
});

test("sync clears every closed queue label without requiring a Project item", async () => {
  const queries = [];
  const edits = [];
  const reads = new Map();
  const closedIssues = new Map(
    ISSUE_STATE_LABELS.map((label, index) => [
      label,
      {
        number: 900 + index,
        title: `closed ${label}`,
        state: "CLOSED",
        labels: [{ name: label }],
      },
    ]),
  );

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) => {
        queries.push(`${state}:${labels.join(",")}`);
        return state === "all" ? [...closedIssues.values()] : [];
      },
      findIssueProjectItem: async () => null,
      updateProjectFields: async () => {
        throw new Error("closed issues without Project items must still sync");
      },
      editIssueLabels: async (_options, issue, state) => {
        edits.push({ number: issue.number, state });
      },
      getIssue: async (_options, number) => {
        const issue = [...closedIssues.values()].find(
          (candidate) => candidate.number === number,
        );
        const read = (reads.get(number) ?? 0) + 1;
        reads.set(number, read);
        return read <= 2 ? issue : { ...issue, labels: [] };
      },
      sleep: async () => {
        throw new Error("an immediately satisfied postcondition must not wait");
      },
    },
  );

  assertDeepEqual(queries, [`all:${ISSUE_STATE_LABELS.join(",")}`]);
  assertDeepEqual(
    results.map(({ number, state }) => ({ number, state })),
    ISSUE_STATE_LABELS.map((_label, index) => ({
      number: 900 + index,
      state: "done",
    })),
  );
  assertDeepEqual(
    edits,
    ISSUE_STATE_LABELS.map((_label, index) => ({
      number: 900 + index,
      state: "done",
    })),
  );
  assertDeepEqual(
    [...reads.values()],
    ISSUE_STATE_LABELS.map(() => 3),
  );
});

test("sync uses refreshed Project visibility before closed-item cleanup", async () => {
  const listedIssue = {
    number: 920,
    title: "closed review item",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
    projectItems: [],
  };
  const refreshedIssue = {
    ...listedIssue,
    projectItems: [{ id: "item-920", project: { id: "project" } }],
  };
  const events = [];
  let reads = 0;

  await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      findIssueProjectItem: async (_options, issue) => {
        events.push(issue.projectItems[0] ? "find:visible" : "find:missing");
        return issue.projectItems[0]?.id ?? null;
      },
      updateProjectFields: async () => events.push("project"),
      editIssueLabels: async () => events.push("labels"),
      getIssue: async () => {
        reads += 1;
        events.push(
          reads === 1 ? "refresh" : reads === 2 ? "pre-cleanup" : "verify",
        );
        if (reads === 1) return listedIssue;
        return reads === 2 ? refreshedIssue : { ...refreshedIssue, labels: [] };
      },
      sleep: async () => events.push("sleep"),
    },
  );

  assertDeepEqual(events, [
    "refresh",
    "find:missing",
    "pre-cleanup",
    "find:visible",
    "project",
    "labels",
    "verify",
    "find:visible",
    "project",
    "verify",
  ]);
});

test("sync reapplies Done to the same Project item before label cleanup", async () => {
  const issue = {
    number: 921,
    title: "closed item with a concurrent Project write",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
    projectItems: [{ id: "item-921", project: { id: "project" } }],
  };
  const events = [];
  let reads = 0;

  await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [issue] : [],
      findIssueProjectItem: async () => {
        events.push("find");
        return "item-921";
      },
      updateProjectFields: async () => events.push("project"),
      editIssueLabels: async () => events.push("labels"),
      getIssue: async () => {
        reads += 1;
        events.push(`read:${reads}`);
        return reads < 3 ? issue : { ...issue, labels: [] };
      },
      sleep: async () => {
        throw new Error("an immediately satisfied postcondition must not wait");
      },
    },
  );

  assertDeepEqual(events, [
    "read:1",
    "find",
    "project",
    "read:2",
    "find",
    "project",
    "labels",
    "read:3",
    "find",
    "project",
    "read:4",
  ]);
});

test("sync projects a Project item that appears after label cleanup", async () => {
  const listedIssue = {
    number: 922,
    title: "closed item with late Project visibility",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
    projectItems: [],
  };
  const verifiedIssue = {
    ...listedIssue,
    labels: [],
    projectItems: [{ id: "item-922", project: { id: "project" } }],
  };
  const reads = [listedIssue, listedIssue, verifiedIssue, verifiedIssue];
  const events = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      findIssueProjectItem: async (_options, issue) => {
        events.push(issue.projectItems[0] ? "find:visible" : "find:missing");
        return issue.projectItems[0]?.id ?? null;
      },
      updateProjectFields: async () => events.push("project"),
      editIssueLabels: async () => events.push("labels"),
      getIssue: async () => {
        events.push("read");
        return reads.shift();
      },
      sleep: async () => {
        throw new Error("an immediately satisfied postcondition must not wait");
      },
    },
  );

  assertDeepEqual(events, [
    "read",
    "find:missing",
    "read",
    "find:missing",
    "labels",
    "read",
    "find:visible",
    "project",
    "read",
  ]);
  assertDeepEqual(results, [
    {
      number: 922,
      title: "closed item with late Project visibility",
      state: "done",
    },
  ]);
});

test("sync reprojects a reopen during the late Project write", async () => {
  const listedIssue = {
    number: 923,
    title: "reopen during late Project projection",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
    projectItems: [],
  };
  const clearedIssue = {
    ...listedIssue,
    labels: [],
    projectItems: [{ id: "item-923", project: { id: "project" } }],
  };
  const activeIssue = {
    ...listedIssue,
    state: "OPEN",
    labels: [{ name: "agent-active" }],
    projectItems: clearedIssue.projectItems,
  };
  let currentIssue = listedIssue;
  let reads = 0;
  const updates = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      getIssue: async () => {
        reads += 1;
        return currentIssue;
      },
      findIssueProjectItem: async (_options, issue) =>
        issue.projectItems[0]?.id ?? null,
      ensureProjectItem: async () => "item-923",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
        if (state === "done") currentIssue = activeIssue;
      },
      editIssueLabels: async (_options, _issue, state) => {
        if (state === "done") currentIssue = clearedIssue;
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(updates, ["done", "active"]);
  assertEqual(reads, 5, "closed verification and reopened projection reads");
  assertDeepEqual(results, [
    {
      number: 923,
      title: "reopen during late Project projection",
      state: "active",
    },
  ]);
});

test("sync reclassifies an issue that reopened after enumeration", async () => {
  const listedIssue = {
    number: 925,
    title: "reopened review item",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  const reopenedIssue = {
    ...listedIssue,
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const updates = [];
  let edits = 0;

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      getIssue: async () => reopenedIssue,
      findIssueProjectItem: async () => {
        throw new Error("a reopened issue must not take the Done path");
      },
      ensureProjectItem: async () => "item-925",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      editIssueLabels: async () => {
        edits += 1;
      },
    },
  );

  assertDeepEqual(results, [
    { number: 925, title: "reopened review item", state: "active" },
  ]);
  assertDeepEqual(updates, ["active"]);
  assertEqual(edits, 0, "reopened issue label edits");
});

test("sync reclassifies a reopen before the Done label edit", async () => {
  const closedIssue = {
    number: 924,
    title: "reopen before cleanup",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  const activeIssue = {
    ...closedIssue,
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const reads = [closedIssue, activeIssue, activeIssue];
  const updates = [];
  let edits = 0;

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [closedIssue] : [],
      getIssue: async () => reads.shift(),
      findIssueProjectItem: async () => null,
      ensureProjectItem: async () => "item-924",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      editIssueLabels: async () => {
        edits += 1;
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(updates, ["active"]);
  assertEqual(edits, 0, "stale Done label edits");
  assertDeepEqual(results, [
    { number: 924, title: "reopen before cleanup", state: "active" },
  ]);
});

test("sync reprojects a concurrent claim after an open Project write", async () => {
  const readyIssue = {
    number: 926,
    title: "concurrent claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const activeIssue = {
    ...readyIssue,
    labels: [{ name: "agent-active" }],
  };
  const reads = [readyIssue, activeIssue, activeIssue];
  const updates = [];
  let waits = 0;

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("agent-ready") && state === "all" ? [readyIssue] : [],
      getIssue: async () => reads.shift(),
      ensureProjectItem: async () => "item-926",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      sleep: async () => {
        waits += 1;
      },
    },
  );

  assertDeepEqual(updates, ["ready", "active"]);
  assertEqual(waits, 1, "claim drift wait");
  assertDeepEqual(results, [
    { number: 926, title: "concurrent claim", state: "active" },
  ]);
});

test("sync bounds repeated open-state projection drift", async () => {
  const readyIssue = {
    number: 929,
    title: "oscillating claim",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const activeIssue = {
    ...readyIssue,
    labels: [{ name: "agent-active" }],
  };
  const reads = [readyIssue, activeIssue, readyIssue, activeIssue];
  const updates = [];
  let waits = 0;

  await assertRejects(
    () =>
      sync(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ({ id: "project" }),
          listIssuesByLabels: async (_options, labels, { state }) =>
            labels.includes("agent-ready") && state === "all"
              ? [readyIssue]
              : [],
          getIssue: async () => reads.shift(),
          ensureProjectItem: async () => "item-929",
          updateProjectFields: async (_options, _project, _item, state) => {
            updates.push(state);
          },
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /Issue #929 did not stabilize during sync after 3 attempts; last projection drift was ready -> active/,
  );

  assertDeepEqual(updates, ["ready", "active", "ready"]);
  assertEqual(waits, 2, "bounded open-state drift waits");
});

test("sync attempts later issues and reports partial results after a failure", async () => {
  const failingIssue = {
    number: 931,
    title: "failed projection",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const successfulIssue = {
    number: 932,
    title: "successful projection",
    state: "OPEN",
    labels: [{ name: "agent-ready" }],
  };
  const updates = [];
  let observed;

  try {
    await sync(
      { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
      {
        getProject: async () => ({ id: "project" }),
        listIssuesByLabels: async (_options, labels, { state }) =>
          labels.includes("agent-ready") && state === "all"
            ? [failingIssue, successfulIssue]
            : [],
        getIssue: async (_options, number) =>
          number === failingIssue.number ? failingIssue : successfulIssue,
        ensureProjectItem: async (_options, _project, issue) =>
          `item-${issue.number}`,
        updateProjectFields: async (_options, _project, item) => {
          updates.push(item);
          if (item === "item-931") throw new Error("Project write failed");
        },
      },
    );
  } catch (error) {
    observed = error;
  }

  assert(observed instanceof IssueBoardSyncError, "aggregate sync error type");
  assertDeepEqual(updates, ["item-931", "item-932"]);
  assertDeepEqual(observed.results, [
    { number: 932, title: "successful projection", state: "ready" },
  ]);
  assertDeepEqual(observed.failures, [
    {
      number: 931,
      title: "failed projection",
      message: "Project write failed",
    },
  ]);
  assert(
    observed.message.includes("Succeeded: #932."),
    "success summary in aggregate error",
  );
  assert(
    observed.message.includes("Failed: #931: Project write failed."),
    "failure summary in aggregate error",
  );
});

test("sync reprojects Done when an issue closes after an open Project write", async () => {
  const reviewIssue = {
    number: 928,
    title: "concurrent close",
    state: "OPEN",
    labels: [{ name: "in-pr" }],
  };
  const closedIssue = {
    ...reviewIssue,
    state: "CLOSED",
    labels: [],
  };
  const reads = [
    reviewIssue,
    closedIssue,
    closedIssue,
    closedIssue,
    closedIssue,
  ];
  const updates = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [reviewIssue] : [],
      getIssue: async () => reads.shift(),
      ensureProjectItem: async () => "item-928",
      findIssueProjectItem: async () => "item-928",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      editIssueLabels: async () => {},
      sleep: async () => {},
    },
  );

  assertDeepEqual(updates, ["review", "done", "done", "done"]);
  assertDeepEqual(results, [
    { number: 928, title: "concurrent close", state: "done" },
  ]);
});

test("sync compensates for a concurrent queue transition after the restore read", async () => {
  const listedIssue = {
    number: 927,
    title: "concurrent reopen",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  let currentIssue = listedIssue;
  let reads = 0;
  const edits = [];
  const updates = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      getIssue: async () => {
        reads += 1;
        return currentIssue;
      },
      findIssueProjectItem: async () => null,
      ensureProjectItem: async () => "item-927",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      editIssueLabels: async (_options, issue, state) => {
        edits.push(state);
        if (state === "done") {
          currentIssue = { ...listedIssue, state: "OPEN", labels: [] };
        } else if (state === "review") {
          assertDeepEqual(
            issue.labels,
            [],
            "fresh label-less restore snapshot",
          );
          currentIssue = {
            ...listedIssue,
            state: "OPEN",
            labels: [{ name: "in-pr" }, { name: "agent-active" }],
          };
        } else {
          currentIssue = {
            ...listedIssue,
            state: "OPEN",
            labels: [{ name: "agent-active" }],
          };
        }
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(edits, ["done", "review", "active"]);
  assertDeepEqual(updates, ["active"]);
  assertEqual(reads, 7, "restore, compensation, and projection reads");
  assertDeepEqual(results, [
    { number: 927, title: "concurrent reopen", state: "active" },
  ]);
});

test("sync carries restore compensation through Project verification", async () => {
  const listedIssue = {
    number: 935,
    title: "transition after restored projection",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  let currentIssue = listedIssue;
  let reads = 0;
  let waits = 0;
  const edits = [];
  const updates = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      getIssue: async () => {
        reads += 1;
        return currentIssue;
      },
      findIssueProjectItem: async () => null,
      ensureProjectItem: async () => "item-935",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
        if (state === "review") {
          currentIssue = {
            ...listedIssue,
            state: "OPEN",
            labels: [{ name: "in-pr" }, { name: "agent-active" }],
          };
        }
      },
      editIssueLabels: async (_options, _issue, state) => {
        edits.push(state);
        currentIssue = {
          ...listedIssue,
          state: "OPEN",
          labels:
            state === "done"
              ? []
              : [{ name: state === "review" ? "in-pr" : "agent-active" }],
        };
      },
      sleep: async () => {
        waits += 1;
      },
    },
  );

  assertDeepEqual(edits, ["done", "review", "active"]);
  assertDeepEqual(updates, ["review", "active"]);
  assertEqual(reads, 8, "restore and later Project verification reads");
  assertEqual(waits, 2, "bounded projection retries");
  assertDeepEqual(results, [
    {
      number: 935,
      title: "transition after restored projection",
      state: "active",
    },
  ]);
});

test("sync fails closed for ambiguous labels after reopen restore", async () => {
  const listedIssue = {
    number: 936,
    title: "ambiguous transition after restore",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  let currentIssue = listedIssue;
  let reads = 0;
  let waits = 0;
  const edits = [];

  await assertRejects(
    () =>
      sync(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ({ id: "project" }),
          listIssuesByLabels: async (_options, labels, { state }) =>
            labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
          getIssue: async () => {
            reads += 1;
            return currentIssue;
          },
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => {
            throw new Error("sync must not project an ambiguous state");
          },
          editIssueLabels: async (_options, _issue, state) => {
            edits.push(state);
            currentIssue = {
              ...listedIssue,
              state: "OPEN",
              labels:
                state === "done"
                  ? []
                  : [
                      { name: "in-pr" },
                      { name: "agent-active" },
                      { name: "agent-ready" },
                    ],
            };
          },
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /Issue #936 retained conflicting queue labels after 3 attempts: agent-ready, agent-active, in-pr/,
  );

  assertDeepEqual(edits, ["done", "review"]);
  assertEqual(reads, 6, "bounded ambiguous-state reads");
  assertEqual(waits, 2, "bounded ambiguous-state waits");
});

test("sync does not restore an ambiguous closed queue state", async () => {
  const listedIssue = {
    number: 937,
    title: "ambiguous closed state",
    state: "CLOSED",
    labels: [{ name: "in-pr" }, { name: "agent-active" }],
  };
  let currentIssue = listedIssue;
  let reads = 0;
  let waits = 0;
  const edits = [];

  await assertRejects(
    () =>
      sync(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ({ id: "project" }),
          listIssuesByLabels: async (_options, labels, { state }) =>
            labels.includes("in-pr") &&
            labels.includes("agent-active") &&
            state === "all"
              ? [listedIssue]
              : [],
          getIssue: async () => {
            reads += 1;
            return currentIssue;
          },
          findIssueProjectItem: async () => null,
          ensureProjectItem: async () => {
            throw new Error("sync must not project an unknown restored state");
          },
          editIssueLabels: async (_options, _issue, state) => {
            edits.push(state);
            if (state === "done") {
              currentIssue = { ...listedIssue, state: "OPEN", labels: [] };
            }
          },
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /Issue #937 lost its queue state during sync after 3 attempt\(s\); last projection drift was done -> no queue state/,
  );

  assertDeepEqual(edits, ["done"]);
  assertEqual(reads, 4, "bounded ambiguous-source reads");
  assertEqual(waits, 2, "bounded ambiguous-source waits");
});

test("sync preserves a concurrent queue transition before reopen restore", async () => {
  const listedIssue = {
    number: 933,
    title: "transition during restore",
    state: "CLOSED",
    labels: [{ name: "in-pr" }],
  };
  const labelLessIssue = { ...listedIssue, state: "OPEN", labels: [] };
  const activeIssue = {
    ...listedIssue,
    state: "OPEN",
    labels: [{ name: "agent-active" }],
  };
  const reads = [
    listedIssue,
    listedIssue,
    labelLessIssue,
    activeIssue,
    activeIssue,
  ];
  const edits = [];
  const updates = [];

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("in-pr") && state === "all" ? [listedIssue] : [],
      getIssue: async () => reads.shift(),
      findIssueProjectItem: async () => null,
      ensureProjectItem: async () => "item-933",
      updateProjectFields: async (_options, _project, _item, state) => {
        updates.push(state);
      },
      editIssueLabels: async (_options, _issue, state) => {
        edits.push(state);
      },
      sleep: async () => {},
    },
  );

  assertDeepEqual(edits, ["done"]);
  assertDeepEqual(updates, ["active"]);
  assertDeepEqual(results, [
    { number: 933, title: "transition during restore", state: "active" },
  ]);
});

test("sync fails closed while an open queue-label conflict persists", async () => {
  const issue = {
    number: 934,
    title: "release in progress",
    state: "OPEN",
    labels: [{ name: "in-pr" }, { name: "agent-ready" }],
  };
  let reads = 0;
  let waits = 0;

  await assertRejects(
    () =>
      sync(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ({ id: "project" }),
          listIssuesByLabels: async (_options, labels, { state }) =>
            labels.includes("in-pr") &&
            labels.includes("agent-ready") &&
            state === "all"
              ? [issue]
              : [],
          getIssue: async () => {
            reads += 1;
            return issue;
          },
          editIssueLabels: async () => {
            throw new Error("sync must not select one conflicting label");
          },
          ensureProjectItem: async () => {
            throw new Error("sync must not project an ambiguous state");
          },
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /Issue #934 retained conflicting queue labels after 3 attempts: agent-ready, in-pr/,
  );

  assertEqual(reads, 3, "bounded conflict reads");
  assertEqual(waits, 2, "bounded conflict waits");
});

test("sync fails when a closed issue retains a queue label", async () => {
  const issue = {
    number: 930,
    title: "stale closed claim",
    state: "CLOSED",
    labels: [{ name: "agent-active" }],
  };
  let waits = 0;

  await assertRejects(
    () =>
      sync(
        { repo: "mento-protocol/monitoring-monorepo", dryRun: false },
        {
          getProject: async () => ({ id: "project" }),
          listIssuesByLabels: async (_options, labels, { state }) =>
            labels.includes("agent-active") && state === "all" ? [issue] : [],
          findIssueProjectItem: async () => null,
          editIssueLabels: async () => {},
          getIssue: async () => issue,
          sleep: async () => {
            waits += 1;
          },
        },
      ),
    /Issue #930 retained queue label\(s\) after sync: agent-active/,
  );
  assertEqual(waits, 2, "bounded verification waits");
});

test("sync dry-run refreshes once and skips the unapplied postcondition", async () => {
  const issue = {
    number: 940,
    title: "dry-run closed item",
    state: "CLOSED",
    labels: [{ name: "needs-grooming" }],
  };
  let edits = 0;
  let reads = 0;

  const results = await sync(
    { repo: "mento-protocol/monitoring-monorepo", dryRun: true },
    {
      getProject: async () => ({ id: "project" }),
      listIssuesByLabels: async (_options, labels, { state }) =>
        labels.includes("needs-grooming") && state === "all" ? [issue] : [],
      findIssueProjectItem: async () => null,
      editIssueLabels: async () => {
        edits += 1;
      },
      getIssue: async () => {
        reads += 1;
        return issue;
      },
    },
  );

  assertEqual(edits, 1, "dry-run label plan");
  assertEqual(reads, 1, "dry-run refresh reads");
  assertEqual(results[0].state, "done", "dry-run result state");
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

test("claim comment records agent, issue, claim id, and an optional branch", () => {
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

  const branchless = buildClaimComment(
    {
      agent: "codex",
      claimId: "codex-20260617T100000",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );
  assert(!branchless.includes("Branch:"), "unexpected branch");
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
  const lines = [
    `Agent claim: ${agent} claimed #${issue} for implementation.`,
    "",
    `Claim ID: ${claimId}`,
  ];
  if (branch !== null) lines.push(`Branch: ${branch}`);
  lines.push(`Claimed at: ${claimedAt}`);
  return {
    id,
    createdAt,
    authorAssociation: association,
    body: lines.join("\n"),
  };
}

function commentWithHandoff(lines, options) {
  const comment = trustedComment(options);
  comment.body += `\n${lines.join("\n")}`;
  return comment;
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

test("claim parser ignores untrusted, wrong-issue, and malformed comments", () => {
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
  ]) {
    assertEqual(parseClaimComment(comment, 901), null);
  }
  const handoff = trustedComment();
  handoff.body += "\nProject #12 fields were not set from this session.";
  assertEqual(parseClaimComment(handoff, 901).metadata.Branch, "agent/901");

  const branchless = parseClaimComment(trustedComment({ branch: null }), 901);
  assertEqual(branchless.branch, null);
  assertEqual(Object.hasOwn(branchless.metadata, "Branch"), false);
});

test("claim parser accepts bounded cloud handoffs with trailing newlines", () => {
  for (const trailingLines of [1, 2]) {
    assert(
      parseClaimComment(
        commentWithHandoff([
          "Project #12 fields were not set from this session.",
          ...Array(trailingLines).fill(""),
        ]),
        901,
      ),
      "expected trailing newlines to be accepted",
    );
  }
  assert(
    parseClaimComment(
      commentWithHandoff(["one", "two", "three", "four", "", ""]),
      901,
    ),
    "expected four handoff lines plus trailing newlines to be accepted",
  );
  assert(
    parseClaimComment(commentWithHandoff(["x".repeat(1000), "", ""]), 901),
    "expected exactly 1000 handoff characters plus trailing newlines to be accepted",
  );
  const branchless = parseClaimComment(
    commentWithHandoff(
      ["Project #12 fields were not set from this session.", ""],
      { branch: null },
    ),
    901,
  );
  assertEqual(branchless.branch, null);
  assertEqual(Object.hasOwn(branchless.metadata, "Branch"), false);
});

test("claim parser rejects unsafe or oversized cloud handoffs", () => {
  for (const lines of [
    ["first line", "", "third line"],
    ["first line", "Claim ID: second"],
    ["first line", "Branch: second"],
    ["first line", "Claimed at: 2026-08-20T10:00:00.000Z"],
    ["handoff\u0000text"],
    ["handoff\ttext"],
    [" handoff"],
    ["handoff "],
    ["   "],
    ["one", "two", "three", "four", "five"],
    ["x".repeat(500), "x".repeat(500)],
  ]) {
    assertEqual(parseClaimComment(commentWithHandoff(lines), 901), null);
  }
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
  const branchless = { ...metadata };
  delete branchless.Branch;
  assertDeepEqual(
    buildBackfillPlan(
      {
        Agent: null,
        "Claim ID": null,
        Branch: "preserved-branch",
        "Claimed At": null,
      },
      branchless,
    ),
    [
      { field: "Claim ID", value: "claim-1" },
      { field: "Agent", value: "codex" },
      { field: "Claimed At", value: "2026-08-20" },
    ],
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
    comments,
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
    project,
    writes: [],
  };
  const expectedFieldTypes = {
    Agent: "TEXT",
    "Claim ID": "TEXT",
    Branch: "TEXT",
    "Claimed At": "DATE",
  };
  return {
    state,
    getProject: async () => state.project,
    getIssue: async () => ({ ...state.issue, labels: [...state.issue.labels] }),
    findIssueProjectItem: async () => "item",
    listIssueComments: async () => state.comments,
    requireBackfillFields: (candidateProject) => {
      const fields = {};
      for (const [name, dataType] of Object.entries(expectedFieldTypes)) {
        const field = candidateProject.fields.find(
          (candidate) => candidate.name === name,
        );
        if (field?.dataType !== dataType) {
          throw new Error(`Project must have a ${dataType} ${name} field`);
        }
        fields[name] = field;
      }
      return fields;
    },
    readBackfillProjectFields: async () => ({ ...state.values }),
    writeBackfillProjectFields: async (_options, _project, _item, writes) => {
      state.writes.push(...writes);
      for (const write of writes) state.values[write.field] = write.value;
      mutate?.(state, writes);
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

test("backfill preserves Branch when the trusted claim omits it", async () => {
  const fakes = backfillFakes({
    comments: [trustedComment({ branch: null })],
    values: {
      Agent: null,
      "Claim ID": null,
      Branch: "preserved-branch",
      "Claimed At": null,
    },
  });
  const [result] = await backfill({ issues: [901], dryRun: false }, fakes);
  assertDeepEqual(
    result.writes.map((write) => write.field),
    ["Claim ID", "Agent", "Claimed At"],
  );
  assertEqual(fakes.state.values.Branch, "preserved-branch");
  assertEqual(
    fakes.state.writes.some((write) => write.field === "Branch"),
    false,
  );
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
      if (state.writes.length === 4) state.values.Branch = "other";
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

test("backfill fingerprints an absent Branch before writing", async () => {
  const fakes = backfillFakes({ comments: [trustedComment({ branch: null })] });
  let commentReads = 0;
  fakes.listIssueComments = async () => [
    trustedComment({
      branch: commentReads++ === 0 ? null : "agent/901",
    }),
  ];
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertEqual(fakes.state.writes.length, 0);
});

test("backfill stops before later writes when a newer claim arrives", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) {
        state.comments = [
          trustedComment({
            id: "comment-2",
            claimId: "claim-2",
            createdAt: "2026-08-20T11:00:00.000Z",
          }),
        ];
      }
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when a target field drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) state.values.Agent = "other";
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /changed before backfill write/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when the lifecycle drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length === 1) {
        state.issue.labels = [{ name: "agent-ready" }];
      }
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /is not backfillable/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
});

test("backfill stops before later writes when an ownership field type drifts", async () => {
  const fakes = backfillFakes({
    mutate: (state) => {
      if (state.writes.length !== 1) return;
      state.project = {
        ...state.project,
        fields: state.project.fields.map((field) =>
          field.name === "Agent" ? { ...field, dataType: "DATE" } : field,
        ),
      };
    },
  });
  await assertRejects(
    () => backfill({ issues: [901], dryRun: false }, fakes),
    /Project must have a TEXT Agent field/,
  );
  assertDeepEqual(
    fakes.state.writes.map((write) => write.field),
    ["Claim ID"],
  );
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
