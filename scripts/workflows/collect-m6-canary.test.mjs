import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";
import { collectM6Canary, readReservation } from "./collect-m6-canary.mjs";

const HEAD = "a".repeat(40),
  BASE = "b".repeat(40);
const REPO = "mento-protocol/monitoring-monorepo";
const HISTORY = 8785 / 60;
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pull = (number = 2400) => ({
  number,
  state: "open",
  draft: false,
  changed_files: 1,
  head: { sha: HEAD, ref: "feature", repo: { full_name: REPO } },
  base: { ref: "main", sha: BASE, repo: { full_name: REPO } },
});
const run = (id = 900) => ({
  id,
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:02:00Z",
  event: "workflow_dispatch",
  path: ".github/workflows/no-skip-audit.yml",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  head_sha: BASE,
  display_title: `No-skip audit PR #2400 at ${HEAD}`,
});
const job = (id = 1, minutes = 2) => ({
  id,
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-06T00:00:00Z",
  completed_at: new Date(
    Date.parse("2026-09-06T00:00:00Z") + minutes * 60000,
  ).toISOString(),
});
const comment = (record = {}) => ({
  id: 44,
  user: { login: "github-actions[bot]" },
  body: `<!-- m6-canary-reservation-v1 -->\n${JSON.stringify({ pr: 2400, head: HEAD, base: BASE, ordinaryRun: 800, ...record })}`,
});

function fixture(options = {}) {
  const calls = [],
    comments = options.comments ?? [];
  let pullReads = 0;
  const methods = {
    listComments: async () => comments,
    listWorkflowRuns: async (args) =>
      args.workflow_id === "no-skip-audit.yml"
        ? (options.runs ?? [])
        : args.event === "push"
          ? (options.mainRuns ?? [])
          : [
              {
                id: 800,
                head_sha: HEAD,
                event: "pull_request",
                path: ".github/workflows/ci.yml",
                repository: { full_name: REPO },
                head_repository: { full_name: REPO },
                head_branch: "feature",
                status: "completed",
                conclusion: "success",
                pull_requests: [{ number: 2400, base: { sha: BASE } }],
              },
            ],
    listJobsForWorkflowRunAttempt: async (args) =>
      options.jobs?.(args) ?? [job()],
    list: async () => options.pulls ?? [pull()],
    listFiles: async () =>
      options.files ?? [{ filename: "ui-dashboard/src/app/page.tsx" }],
    get: async (args) => ({
      data: args.issue_number
        ? { state: options.issueState ?? "open" }
        : options.freshDraft && ++pullReads > 1
          ? { ...pull(), draft: true }
          : (options.pull ?? pull()),
    }),
    getWorkflowRun: async () => ({ data: { ...run(), status: "queued" } }),
    getRef: async () => ({ data: { object: { sha: BASE } } }),
    compareCommits: async () => ({
      data: { merge_base_commit: { sha: options.ancestor ?? BASE } },
    }),
    createComment: async (args) => {
      calls.push(["comment", args]);
      return { data: { id: 45 } };
    },
    updateComment: async (args) => {
      calls.push(["update", args]);
      if (options.updateError) throw new Error("Receipt update failed");
    },
  };
  const github = {
    rest: {
      issues: methods,
      actions: methods,
      pulls: methods,
      git: methods,
      repos: methods,
    },
    paginate: (method, args) => method(args),
    request: async (_route, args) => {
      calls.push(["dispatch", args]);
      if (options.dispatchError) throw new Error("POST response lost");
      return { data: { workflow_run_id: 901 } };
    },
  };
  return {
    calls,
    github,
    context: {
      sha: BASE,
      repo: { owner: "mento-protocol", repo: "monitoring-monorepo" },
      ref: "refs/heads/main",
    },
    core: {
      info: () => {},
      setFailed: (message) => calls.push(["failed", message]),
    },
  };
}

test("reserves immutable selection before exactly one dispatch and saves returned ID", async () => {
  const f = fixture();
  const result = await collectM6Canary(f);
  assert.deepEqual(
    f.calls.map(([kind]) => kind),
    ["comment", "dispatch", "update"],
  );
  assert.equal(result.dispatched, 901);
  assert.deepEqual(f.calls[1][1].inputs, {
    pr_number: "2400",
    source_sha: HEAD,
    base_sha: BASE,
  });
  assert.equal(f.calls[1][1].return_run_details, true);
  assert.match(f.calls[2][1].body, /"auditRun":901/u);
});

test("ambiguous dispatch leaves reservation and never retries", async () => {
  const f = fixture({ dispatchError: true });
  assert.match((await collectM6Canary(f)).stopped, /ambiguous/u);
  assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1);
  const next = fixture({ comments: [comment()] });
  assert.match((await collectM6Canary(next)).stopped, /unresolved dispatch/u);
  assert(!next.calls.some(([kind]) => kind === "dispatch"));
});

test("in-flight audits wait without failing or writing comments", async () => {
  const f = fixture({ runs: [{ ...run(), status: "in_progress" }] });
  assert.deepEqual(await collectM6Canary(f), { waiting: 900 });
  assert.deepEqual(f.calls, []);
});

test("stale collector revision cannot write or dispatch", async () => {
  const f = fixture();
  f.context.sha = HEAD;
  assert.match((await collectM6Canary(f)).stopped, /no longer main/u);
  assert.deepEqual(f.calls, []);
});

test("historic startup failures do not block new collection", async () => {
  const f = fixture({
    runs: [
      { ...run(), conclusion: "failure", updated_at: "2026-09-04T18:00:00Z" },
    ],
    jobs: () => [],
  });
  assert.equal((await collectM6Canary(f)).dispatched, 901);
});

test("closed M6 issue prevents any comment or dispatch", async () => {
  const f = fixture({ issueState: "closed" });
  assert.match((await collectM6Canary(f)).stopped, /closed/u);
  assert.deepEqual(f.calls, []);
});

test("repeated stop conditions do not create duplicate issue comments", async () => {
  const options = {
    runs: [run()],
    jobs: () => [{ ...job(), conclusion: "failure" }],
  };
  const first = fixture(options);
  await collectM6Canary(first);
  const posted = first.calls.find(([kind]) => kind === "comment")[1].body;
  const second = fixture({
    comments: [{ ...comment(), body: posted }],
  });
  await collectM6Canary(second);
  assert(!second.calls.some(([kind]) => kind === "comment"));
});

test("failure to persist dispatch ID leaves a reservation that blocks retries", async () => {
  const f = fixture({ updateError: true });
  assert.match((await collectM6Canary(f)).stopped, /ambiguous/u);
  assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1);
  const reserved = f.calls.find(([kind]) => kind === "comment")[1].body;
  const next = fixture({ comments: [{ ...comment(), body: reserved }] });
  assert.match((await collectM6Canary(next)).stopped, /unresolved dispatch/u);
  assert(!next.calls.some(([kind]) => kind === "dispatch"));
});

test("unreserved new audit stops further dispatch", async () => {
  const f = fixture({ runs: [run()] });
  assert.match((await collectM6Canary(f)).stopped, /unreserved|reservation/iu);
  assert(!f.calls.some(([kind]) => kind === "dispatch"));
});

test("missing run-list entry waits without a persistent stop", async () => {
  const f = fixture({ comments: [comment({ auditRun: 900 })] });
  assert.deepEqual(await collectM6Canary(f), { waiting: 900 });
  assert.deepEqual(f.calls, []);
});

test("a newly drafted PR cannot reserve or dispatch", async () => {
  const f = fixture({ freshDraft: true });
  await collectM6Canary(f);
  assert(!f.calls.some(([kind]) => kind === "dispatch"));
  assert(!f.calls.some(([, value]) => value.body?.includes("reservation-v1")));
});

test("package changes retain ordinary evidence without dispatching a cold audit", async () => {
  const f = fixture({ files: [{ filename: "ui-dashboard/package.json" }] });
  await collectM6Canary(f);
  assert(!f.calls.some(([kind]) => kind === "dispatch"));
  const record = readReservation({
    ...comment(),
    body: f.calls.find(([kind]) => kind === "comment")[1].body,
  });
  assert.doesNotMatch(
    f.calls.find(([kind]) => kind === "comment")[1].body,
    /unresolved/u,
  );
  assert.equal(record.form, "ordinary-pending");
  assert.equal(record.auditRun, undefined);
  assert.equal(record.head, HEAD);
  assert.equal(record.base, BASE);
  assert.equal(record.ordinaryRun, 800);
  const next = fixture({ comments: [comment(record)], pulls: [] });
  assert.equal((await collectM6Canary(next)).stopped, undefined);
});

for (const [name, head, mainRuns, expected] of [
  [
    "same selected head and successful main CI",
    HEAD,
    [
      {
        ...run(850),
        event: "push",
        path: ".github/workflows/ci.yml",
        head_branch: "main",
      },
    ],
    true,
  ],
  ["a later PR head", BASE, [], false],
  [
    "wrong main run commit",
    HEAD,
    [{ id: 850, head_sha: HEAD, head_branch: "main", conclusion: "success" }],
    false,
  ],
])
  test(`merged receipt binds ${name}`, async () => {
    const f = fixture({
      comments: [comment({ auditRun: 900 })],
      runs: [run()],
      pulls: [],
      pull: {
        ...pull(),
        head: { ...pull().head, sha: head },
        merged: true,
        merge_commit_sha: BASE,
      },
      mainRuns,
    });
    await collectM6Canary(f);
    const updated = f.calls.find(([kind]) => kind === "update")[1].body;
    const record = readReservation({ ...comment(), body: updated });
    assert.equal(record.merged, expected);
    assert.equal(record.head, HEAD);
    assert.equal(record.mergeSha, BASE);
    if (expected) assert.equal(record.mainRun, 850);
    const savedPull = (await f.github.rest.pulls.get({})).data;
    const next = fixture({
      comments: [{ ...comment(), body: updated }],
      runs: [run()],
      pulls: [],
      pull: savedPull,
      mainRuns,
    });
    await collectM6Canary(next);
    assert(!next.calls.some(([kind]) => kind === "update"));
  });

for (const [count, day, outcome] of [
  [8, "09", "dispatched"],
  [8, "10", "dispatched"],
  [9, "10", "complete"],
])
  test(`date window: ${count} selections on September ${day}`, async (t) => {
    t.mock.method(Date, "now", () => Date.parse(`2026-09-${day}T12:00:00Z`));
    const records = Array.from({ length: count }, (_, i) =>
      comment({ pr: 2400 + i, auditRun: i + 1 }),
    );
    const runs = records.map((c, i) => ({
      ...run(i + 1),
      created_at: `2026-09-${day}T00:00:00Z`,
      display_title: `No-skip audit PR #${2400 + i} at ${HEAD}`,
    }));
    const f = fixture({
      comments: records,
      runs,
      jobs: ({ run_id }) => [job(run_id)],
      pulls: [pull(2500)],
      pull: { ...pull(2500), merged: true, merge_commit_sha: BASE },
      mainRuns: [
        {
          ...run(850),
          event: "push",
          path: ".github/workflows/ci.yml",
          head_branch: "main",
        },
      ],
    });
    const result = await collectM6Canary(f);
    if (day === "09") assert.equal(result.dispatched, null);
    else assert(result[outcome]);
  });

test("only trusted bot reservation comments control selection", () => {
  assert.equal(
    readReservation({ ...comment(), user: { login: "contributor" } }),
    null,
  );
  assert.throws(() => readReservation(comment({ head: "bad" })), /Malformed/u);
});

for (const [name, options] of [
  [
    "fork",
    {
      pull: {
        ...pull(),
        head: { sha: HEAD, repo: { full_name: "other/repo" } },
      },
    },
  ],
  ["stale base", { pull: { ...pull(), base: { ...pull().base, sha: HEAD } } }],
  ["unintegrated main", { ancestor: HEAD }],
  ["incomplete files", { files: [] }],
  ["execution input", { files: [{ filename: "ui-dashboard/package.json" }] }],
  [
    "renamed execution input",
    {
      files: [{ filename: "ordinary.txt", previous_filename: "nested/.npmrc" }],
    },
  ],
  [
    "instrument input",
    { files: [{ filename: "scripts/workflows/collect-m6-canary.mjs" }] },
  ],
])
  test(`does not dispatch ${name}`, async () => {
    const f = fixture(options);
    assert.equal(Boolean((await collectM6Canary(f)).dispatched), false);
    assert(!f.calls.some(([kind]) => kind === "dispatch"));
  });

test("charges every attempt and deduplicates copied successful jobs", async () => {
  const f = fixture({
    comments: [comment({ auditRun: 900 })],
    runs: [{ ...run(), run_attempt: 2 }],
    jobs: ({ attempt_number }) =>
      attempt_number === 1 ? [job()] : [job(), job(2, 3)],
    pulls: [],
  });
  assert.equal((await collectM6Canary(f)).minutes, HISTORY + 5);
});

test("charges later attempts of historical run IDs without recounting old jobs", async () => {
  const old = {
    ...job(),
    started_at: "2026-09-04T18:00:00Z",
    completed_at: "2026-09-04T18:02:00Z",
  };
  const f = fixture({
    comments: [comment({ auditRun: 1 })],
    runs: [{ ...run(1), run_attempt: 2 }],
    jobs: ({ attempt_number }) =>
      attempt_number === 1 ? [old] : [old, job(2, 3)],
    pulls: [],
  });
  assert.equal((await collectM6Canary(f)).minutes, HISTORY + 3);
});

for (const [name, options, reason] of [
  [
    "failed job",
    { runs: [run()], jobs: () => [{ ...job(), conclusion: "failure" }] },
    /ended failure/u,
  ],
  [
    "skipped job",
    { runs: [run()], jobs: () => [{ ...job(), conclusion: "skipped" }] },
    /Skipped/u,
  ],
  ["missing jobs", { runs: [run()], jobs: () => [] }, /Missing job/u],
  [
    "unknown duration",
    { runs: [run()], jobs: () => [{ ...job(), completed_at: null }] },
    /Unknown duration/u,
  ],
  [
    "per-run overspend",
    { runs: [run()], jobs: () => [job(1, 46)] },
    /exceeded 45/u,
  ],
  [
    "cumulative budget",
    {
      comments: Array.from({ length: 6 }, (_, i) =>
        comment({ pr: 2400 + i, auditRun: i + 1 }),
      ),
      runs: Array.from({ length: 6 }, (_, i) => ({
        ...run(i + 1),
        display_title: `No-skip audit PR #${2400 + i} at ${HEAD}`,
      })),
      jobs: ({ run_id }) => [job(run_id, 44)],
      pull: pull(2500),
      pulls: [pull(2500)],
    },
    /cannot reserve/u,
  ],
])
  test(`stops before dispatch on ${name}`, async () => {
    const f = fixture(options);
    assert.match((await collectM6Canary(f)).stopped, reason);
    assert(!f.calls.some(([kind]) => kind === "dispatch"));
  });

test("rejects mutable or cross-repository collector execution", async () => {
  const f = fixture();
  f.context.ref = "refs/heads/candidate";
  await assert.rejects(collectM6Canary(f), /protected main/u);
  assert.deepEqual(f.calls, []);
});

test("workflow keeps trusted checkout, one writer, no candidate execution and zero retries", () => {
  const workflow = yaml.load(read("../../.github/workflows/m6-canary.yml"));
  assert.deepEqual(workflow.on, {
    workflow_run: { workflows: ["CI", "No-skip audit"], types: ["completed"] },
    workflow_dispatch: null,
  });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: "m6-canary-collection",
    "cancel-in-progress": false,
  });
  const job = workflow.jobs.collect;
  assert.equal(
    job.if,
    "github.repository == 'mento-protocol/monitoring-monorepo' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(job.permissions, {
    contents: "read",
    "pull-requests": "read",
    actions: "write",
    issues: "write",
  });
  assert.equal(job.steps.length, 2);
  assert.deepEqual(job.steps[0].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  assert.equal(job.steps[1].with.retries, 0);
  assert.match(
    job.steps[1].with.script,
    /await collectM6Canary\(\{ github, context, core \}\)/u,
  );
  assert(!job.steps.some((step) => step.run));
});

test("collector stays below the source and test size budgets", () => {
  const lines = (path) => read(path).trimEnd().split("\n").length;
  const source = lines("./collect-m6-canary.mjs");
  const tests = lines("./collect-m6-canary.test.mjs");
  assert.ok(source < 300, `${source} source lines`);
  assert(tests < source * 2, "Tests must stay below twice the source size");
});
