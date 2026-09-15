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
  REVIEWED_FAILURE,
  failureReceiptDigest,
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
const FAILED_RUN = {
  id: 34872200578,
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "0d895b23e8bf45f3933698aea3af8f55a7be3920",
  path: ".github/workflows/m6-audit-recovery.yml",
  workflow_id: 358023090,
  display_title: "M6 recovery PR #2399",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  created_at: "2026-09-14T17:01:31Z",
  updated_at: "2026-09-14T17:07:28Z",
  run_started_at: "2026-09-14T17:01:31Z",
  referenced_workflows: [
    {
      path: "mento-protocol/monitoring-monorepo/.github/workflows/ci.yml@0d895b23e8bf45f3933698aea3af8f55a7be3920",
      sha: "0d895b23e8bf45f3933698aea3af8f55a7be3920",
      ref: "refs/heads/main",
    },
  ],
};
const FAILED_JOBS = [
  [
    104070588677,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Admit approved retrospective observation",
    "completed",
    "success",
    "2026-09-14T17:01:34Z",
    "2026-09-14T17:01:56Z",
    209545,
  ],
  [
    104070721822,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Production infrastructure contract",
    "completed",
    "success",
    "2026-09-14T17:01:57Z",
    "2026-09-14T17:04:56Z",
    209552,
  ],
  [
    104070721835,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Guardrail prose pins",
    "completed",
    "success",
    "2026-09-14T17:01:58Z",
    "2026-09-14T17:02:15Z",
    1000117847,
  ],
  [
    104070721897,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Sentry suites",
    "completed",
    "success",
    "2026-09-14T17:01:58Z",
    "2026-09-14T17:03:04Z",
    1000117846,
  ],
  [
    104070721950,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Detect changes",
    "completed",
    "success",
    "2026-09-14T17:01:58Z",
    "2026-09-14T17:02:07Z",
    209556,
  ],
  [
    104070784832,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (alerts Cloud Functions)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:10Z",
    209554,
  ],
  [
    104070784866,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (integration-probes)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:00Z",
    209555,
  ],
  [
    104070784908,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (indexer-envio)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:45Z",
    209549,
  ],
  [
    104070784921,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Documentation corpus checks",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:16Z",
    209544,
  ],
  [
    104070784923,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (shared-config)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:02:54Z",
    209547,
  ],
  [
    104070784927,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (ui-dashboard)",
    "completed",
    "failure",
    "2026-09-14T17:02:33Z",
    "2026-09-14T17:07:21Z",
    209567,
  ],
  [
    104070784967,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (governance-watchdog)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:02:51Z",
    209543,
  ],
  [
    104070784970,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (metrics-bridge)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:08Z",
    209550,
  ],
  [
    104070785038,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Quality Checks (aegis)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:25Z",
    209548,
  ],
  [
    104070785053,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Version skew",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:02:53Z",
    209553,
  ],
  [
    104070785075,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Lint + test root scripts",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:04:55Z",
    209551,
  ],
  [
    104070785110,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Terraform Validate (registry)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:03:08Z",
    209542,
  ],
  [
    104070785145,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / Code Health (cross-package)",
    "completed",
    "success",
    "2026-09-14T17:02:09Z",
    "2026-09-14T17:02:54Z",
    209546,
  ],
  [
    104072584616,
    34872200578,
    1,
    "0d895b23e8bf45f3933698aea3af8f55a7be3920",
    "Supplemental retained deterministic audit / ci",
    "completed",
    "failure",
    "2026-09-14T17:07:23Z",
    "2026-09-14T17:07:27Z",
    1000117859,
  ],
].map((row) =>
  Object.fromEntries(
    [
      "id",
      "run_id",
      "run_attempt",
      "head_sha",
      "name",
      "status",
      "conclusion",
      "started_at",
      "completed_at",
      "runner_id",
    ].map((key, index) => [key, row[index]]),
  ),
);

function harness(pr = "2399") {
  const failedRun = structuredClone(FAILED_RUN);
  const failedJobs = structuredClone(FAILED_JOBS);
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
  runs["m6-audit-recovery.yml"].push(failedRun);
  const actions = {
    getWorkflowRun: async () => ({ data: failedRun }),
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
      method === "runs"
        ? runs[args.workflow_id]
        : args.run_id === REVIEWED_FAILURE
          ? failedJobs
          : [job],
  };
  return { github, context: ctx, git: mockGit, runs, failedRun, failedJobs };
}
test("reserves one full run without changing baseline", async () =>
  assert.equal(
    (await admitRecovery(harness())).secondsBeforeRun,
    BASELINE_SECONDS + 1396,
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
    "965ec5dddd4ac6d944f5295e16f1393bd95e07f80e449f6aaf0801fbdd40196c",
  );
});

test("charges the earlier distinct recovery", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/m6-audit-recovery.yml",
    head_sha: REVISION,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  });
  assert.equal(
    (await admitRecovery(h)).secondsBeforeRun,
    BASELINE_SECONDS + 1396 + 60,
  );
});
test("stops after any prior unclassified failure", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/m6-audit-recovery.yml",
    head_sha: REVISION,
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
  await assert.rejects(admitRecovery(full), /New ordinary audit/u);
});

test("blocks a partial recovery rerun even if admission was reused", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push({
    id: 1,
    display_title: "M6 recovery PR #2399",
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/m6-audit-recovery.yml",
    head_sha: REVISION,
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

for (const pr of ["2399", "2408"]) {
  test(`admits only the reviewed failed receipt before fresh ${pr}`, async () => {
    const h = harness(pr);
    const proof = await admitRecovery(h);
    assert.equal(proof.secondsBeforeRun, 28983);
    assert.equal(proof.reviewedFailure, REVIEWED_FAILURE);
    assert.equal(proof.reservedSeconds, 2700);
  });
}
test("failed receipt digest is order independent but binds every job", () => {
  assert.equal(
    failureReceiptDigest(FAILED_RUN, FAILED_JOBS),
    failureReceiptDigest(FAILED_RUN, [...FAILED_JOBS].reverse()),
  );
  assert.equal(FAILED_JOBS.length, 19);
  assert.equal(
    FAILED_JOBS.filter((entry) => entry.conclusion === "failure").length,
    2,
  );
  assert.equal(jobSeconds([FAILED_JOBS]), 1396);
});
for (const field of [
  "event",
  "head_branch",
  "head_sha",
  "path",
  "workflow_id",
  "display_title",
  "status",
  "conclusion",
  "updated_at",
  "created_at",
  "referenced_workflows",
]) {
  test(`rejects reviewed failure changed ${field}`, async () => {
    const h = harness();
    h.failedRun[field] = "changed";
    await assert.rejects(admitRecovery(h));
  });
}
for (const field of [
  "id",
  "run_id",
  "run_attempt",
  "head_sha",
  "name",
  "status",
  "conclusion",
  "started_at",
  "completed_at",
  "runner_id",
]) {
  test(`rejects reviewed failed job changed ${field}`, async () => {
    const h = harness();
    h.failedJobs[0][field] = "changed";
    await assert.rejects(admitRecovery(h));
  });
}
for (const [label, mutate] of [
  ["missing failed run", (h) => h.runs["m6-audit-recovery.yml"].pop()],
  ["rerun failed run", (h) => (h.failedRun.run_attempt = 2)],
  ["missing failed job", (h) => h.failedJobs.pop()],
  ["extra failed job", (h) => h.failedJobs.push({ ...h.failedJobs[0], id: 4 })],
  [
    "new ordinary audit",
    (h) =>
      h.runs["no-skip-audit.yml"].push({ id: ANCHOR + 1, status: "completed" }),
  ],
  [
    "two extra runs",
    (h) => h.runs["m6-audit-recovery.yml"].push({ id: 1 }, { id: 2 }),
  ],
])
  test(`finite amendment rejects ${label}`, async () => {
    const h = harness();
    mutate(h);
    await assert.rejects(admitRecovery(h));
  });

test("failed receipt ignores reference key and array order", () => {
  const references = [
    { path: "z", sha: "z", ref: "z" },
    ...FAILED_RUN.referenced_workflows,
  ];
  const reordered = references
    .toReversed()
    .map(({ path, sha, ref }) => ({ ref, sha, path }));
  assert.equal(
    failureReceiptDigest(
      { ...FAILED_RUN, referenced_workflows: references },
      FAILED_JOBS,
    ),
    failureReceiptDigest(
      { ...FAILED_RUN, referenced_workflows: reordered },
      FAILED_JOBS,
    ),
  );
});

function earlierFreshRun(pr) {
  return {
    id: 1,
    display_title: `M6 recovery PR #${pr}`,
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/m6-audit-recovery.yml",
    head_sha: REVISION,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
}
for (const pr of ["2399", "2408"])
  test(`permits ${pr} second only after the other fresh tuple succeeds`, async () => {
    const h = harness(pr);
    h.runs["m6-audit-recovery.yml"].push(
      earlierFreshRun(pr === "2399" ? "2408" : "2399"),
    );
    assert.equal((await admitRecovery(h)).secondsBeforeRun, 29043);
  });
for (const field of [
  "display_title",
  "event",
  "head_branch",
  "path",
  "head_sha",
  "conclusion",
])
  test(`rejects fresh predecessor changed ${field}`, async () => {
    const h = harness("2408"),
      previous = earlierFreshRun("2399");
    previous[field] = "changed";
    h.runs["m6-audit-recovery.yml"].push(previous);
    await assert.rejects(admitRecovery(h));
  });
test("retains the per-run stop for a successful fresh predecessor", async () => {
  const h = harness("2408");
  h.runs["m6-audit-recovery.yml"].push(earlierFreshRun("2399"));
  const paginate = h.github.paginate;
  h.github.paginate = (method, args) =>
    method === "jobs" && args.run_id === 1
      ? [{ ...job, completed_at: "2026-09-14T13:00:00Z" }]
      : paginate(method, args);
  await assert.rejects(admitRecovery(h), /per-run stop/u);
});
