import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  admitRecovery,
  ANCHOR,
  BASE,
  BASELINE_SECONDS,
  jobSeconds,
  REPOSITORY,
  TUPLES,
  validateIdentity,
  verifyGit,
} from "./m6-audit-recovery.mjs";
const REVISION = "a".repeat(40);
function context(pr = "2399") {
  return {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    repo: { owner: "mento-protocol", repo: "monitoring-monorepo" },
    sha: REVISION,
    runAttempt: 1,
    runId: 99999999999,
    payload: { inputs: { pr_number: pr } },
  };
}
function pull(pr = "2399") {
  return {
    number: Number(pr),
    state: "closed",
    merged: true,
    head: { sha: TUPLES[pr].source, repo: { full_name: REPOSITORY } },
    base: { ref: "main", repo: { full_name: REPOSITORY } },
    merge_commit_sha: TUPLES[pr].merge,
  };
}
for (const pr of Object.keys(TUPLES))
  test(`admits exact ${pr} identity`, () =>
    assert.equal(
      validateIdentity(context(pr), pull(pr), REVISION),
      TUPLES[pr],
    ));
for (const [name, mutate] of [
  [
    "branch dispatch",
    (c) => {
      c.ref = "refs/heads/topic";
    },
  ],
  [
    "event",
    (c) => {
      c.eventName = "push";
    },
  ],
  [
    "repository",
    (c) => {
      c.repo.owner = "fork";
    },
  ],
  [
    "head",
    (_c, p) => {
      p.head.sha = REVISION;
    },
  ],
  [
    "merge",
    (_c, p) => {
      p.merge_commit_sha = REVISION;
    },
  ],
  [
    "open",
    (_c, p) => {
      p.state = "open";
    },
  ],
  [
    "unmerged",
    (_c, p) => {
      p.merged = false;
    },
  ],
  [
    "base branch",
    (_c, p) => {
      p.base.ref = "topic";
    },
  ],
  [
    "head repo",
    (_c, p) => {
      p.head.repo.full_name = "fork/repo";
    },
  ],
  [
    "base repo",
    (_c, p) => {
      p.base.repo.full_name = "fork/repo";
    },
  ],
  [
    "rerun",
    (c) => {
      c.runAttempt = 2;
    },
  ],
  [
    "unknown tuple",
    (c) => {
      c.payload.inputs.pr_number = "2128";
    },
  ],
  [
    "PR number",
    (_c, p) => {
      p.number = 2408;
    },
  ],
  [
    "stale main",
    (c) => {
      c.sha = BASE;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const c = context(),
      p = pull();
    mutate(c, p);
    assert.throws(() => validateIdentity(c, p, REVISION));
  });
function mockGit(...args) {
  if (args[0] === "show")
    return "          protected_paths=(\n            package.json\n            .github/workflows/ci.yml\n            scripts/workflows/check-no-skip-audit.mjs\n          )";
  if (args[0] === "merge-base") return args[1] === "--is-ancestor" ? "" : BASE;
  if (args[0] === "merge-tree" || args[1]?.endsWith("^{tree}")) return "tree";
  if (args[0] === "diff") return "";
  if (args[1] === "HEAD") return REVISION;
  if (args[1]?.endsWith("^1")) return "parent";
  return args[1].replace("^{commit}", "");
}
test("checks full protected paths on source and retained runtime on revision", () => {
  const calls = [];
  verifyGit(TUPLES[2399], REVISION, (...args) => {
    calls.push(args);
    return mockGit(...args);
  });
  assert(
    calls.some(
      (a) =>
        a[0] === "diff" &&
        a[3] === TUPLES[2399].source &&
        a.includes("scripts/workflows/check-no-skip-audit.mjs"),
    ),
  );
  assert(
    calls.some(
      (a) =>
        a[0] === "diff" &&
        a[3] === REVISION &&
        a.includes(".github/workflows/ci.yml") &&
        !a.includes("scripts/workflows/check-no-skip-audit.mjs"),
    ),
  );
});
for (const [name, predicate] of [
  ["source drift", (a) => a[0] === "diff" && a[3] === TUPLES[2399].source],
  ["runtime drift", (a) => a[0] === "diff" && a[3] === REVISION],
  ["missing ancestry", (a) => a[1] === "--is-ancestor"],
])
  test(`rejects ${name}`, () =>
    assert.throws(() =>
      verifyGit(TUPLES[2399], REVISION, (...args) => {
        if (predicate(args)) throw new Error(name);
        return mockGit(...args);
      }),
    ));
test("rejects changed merge tree and historical base", () => {
  for (const command of ["merge-tree", "merge-base"])
    assert.throws(() =>
      verifyGit(TUPLES[2399], REVISION, (...args) =>
        args[0] === command ? "wrong" : mockGit(...args),
      ),
    );
});
const job = {
  name: "test",
  started_at: "2026-09-14T12:00:00Z",
  completed_at: "2026-09-14T12:01:00Z",
  runner_id: 3,
  steps: [],
  conclusion: "success",
};
test("deduplicates copied jobs with new IDs and retains real retries", () =>
  assert.equal(
    jobSeconds([
      [{ ...job, id: 1 }],
      [
        { ...job, id: 2 },
        {
          ...job,
          started_at: "2026-09-14T12:02:00Z",
          completed_at: "2026-09-14T12:03:00Z",
        },
      ],
    ]),
    120,
  ));
test("rejects missing timestamps", () =>
  assert.throws(() => jobSeconds([[{ ...job, completed_at: null }]])));
function harness(pr = "2399") {
  const ctx = context(pr);
  const runs = {
    "no-skip-audit.yml": [
      {
        id: ANCHOR,
        run_attempt: 1,
        status: "completed",
        updated_at: "2026-09-14T11:14:19Z",
      },
    ],
    "m6-canary.yml": [],
    "m6-audit-recovery.yml": [
      {
        id: ctx.runId,
        run_attempt: 1,
        head_sha: REVISION,
        display_title: `M6 recovery PR #${pr}`,
      },
    ],
  };
  const actions = {
    getWorkflow: async () => ({ data: { state: "disabled_manually" } }),
    listWorkflowRuns: "runs",
    listJobsForWorkflowRunAttempt: "jobs",
  };
  const github = {
    rest: {
      actions,
      git: { getRef: async () => ({ data: { object: { sha: REVISION } } }) },
      pulls: { get: async () => ({ data: pull(pr) }) },
    },
    paginate: async (method, args) =>
      method === "runs" ? runs[args.workflow_id] : [job],
  };
  return { github, context: ctx, git: mockGit, runs };
}
test("reserves one full run without changing baseline", async () =>
  assert.equal(
    (await admitRecovery(harness())).secondsBeforeRun,
    BASELINE_SECONDS,
  ));
for (const [name, mutate] of [
  [
    "active collector",
    (h) => {
      h.runs["m6-canary.yml"].push({ status: "in_progress" });
    },
  ],
  [
    "enabled collector",
    (h) => {
      h.github.rest.actions.getWorkflow = async () => ({
        data: { state: "active" },
      });
    },
  ],
  [
    "active audit",
    (h) => {
      h.runs["no-skip-audit.yml"][0].status = "in_progress";
    },
  ],
  [
    "historical rerun",
    (h) => {
      h.runs["no-skip-audit.yml"][0].updated_at = "2026-09-15T11:14:19Z";
    },
  ],
  [
    "duplicate tuple",
    (h) => {
      h.runs["m6-audit-recovery.yml"].push({
        id: 1,
        display_title: "M6 recovery PR #2399",
        status: "completed",
      });
    },
  ],
  [
    "stale run binding",
    (h) => {
      h.runs["m6-audit-recovery.yml"][0].head_sha = BASE;
    },
  ],
  [
    "overrun",
    (h) => {
      h.runs["no-skip-audit.yml"].push({
        id: ANCHOR + 1,
        status: "completed",
        run_attempt: 1,
      });
      h.github.paginate = async (method, args) =>
        method === "runs"
          ? h.runs[args.workflow_id]
          : [{ ...job, completed_at: "2026-09-14T13:00:00Z" }];
    },
  ],
])
  test(`admission rejects ${name}`, async () => {
    const h = harness();
    mutate(h);
    await assert.rejects(admitRecovery(h));
  });
test("recovery workflow remains the reviewed read-only adapter", () => {
  const raw = readFileSync(
    new URL("../../.github/workflows/m6-audit-recovery.yml", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    "de969a479e15e7951217965e0b0fc0a047b267362eb340d449963064c354dff0",
  );
});

test("charges the earlier distinct recovery", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  });
  assert.equal(
    (await admitRecovery(h)).secondsBeforeRun,
    BASELINE_SECONDS + 60,
  );
});
test("stops after any prior unclassified failure", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
  });
  await assert.rejects(admitRecovery(h), /failure requires classification/u);
});
test("fails closed on missing historical timestamp and exhausted selections", async () => {
  const missing = harness();
  delete missing.runs["no-skip-audit.yml"][0].updated_at;
  await assert.rejects(admitRecovery(missing));
  const full = harness();
  for (let n = 1; n <= 6; n++)
    full.runs["no-skip-audit.yml"].push({
      id: ANCHOR + n,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    });
  await assert.rejects(admitRecovery(full), /selection limit/u);
});

test("blocks a partial recovery rerun even if admission was reused", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  });
  await assert.rejects(admitRecovery(h), /rerun requires separate review/u);
});

test("fetches only the admitted immutable source before object proof", async () => {
  const h = harness(),
    calls = [];
  h.git = (...args) => {
    calls.push(args);
    return mockGit(...args);
  };
  await admitRecovery(h);
  assert.deepEqual(calls[0], [
    "fetch",
    "--no-tags",
    `https://github.com/${REPOSITORY}.git`,
    TUPLES[2399].source,
  ]);
  const invalid = harness();
  invalid.context.payload.inputs.pr_number = "2128";
  invalid.git = () => {
    throw new Error("fetch must not execute");
  };
  await assert.rejects(admitRecovery(invalid), /Unapproved PR number/u);
});
