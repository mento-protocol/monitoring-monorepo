#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDocsGardenIssueSpec,
  DOCS_GARDEN_MARKER,
  mondayForWeekSerial,
  normalizeGithubIssuePages,
  packetMarker,
  packetScopeDigest,
  parseLeadingDocsGardenMarkers,
  planDocsGardenIssueSync,
  resolveTargetWeekSerial,
  weekSerialForDate,
} from "./docs-garden-issue-helpers.mjs";
import {
  assertAuthorizedGardenWorkflow,
  ensureLabelsExist,
  ghPaginate,
  listGithubIssues,
  parseArgs,
  runDocsGardenIssue,
} from "./docs-garden-issue.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`not ok ${name}\n${message}\n`);
    failed += 1;
  }
}

function packet({
  serial = weekSerialForDate("2026-07-20"),
  lane = "operator-runbooks",
  shard = 1,
  shardCount = 2,
  empty = false,
} = {}) {
  const selectedFor = mondayForWeekSerial(serial);
  const files = empty
    ? []
    : [
        {
          path: "docs/notes/example.md",
          authority: "canonical",
          status: "active",
          doc_type: "runbook",
          scope: "ci/process",
          owner: "eng",
          words: 120,
          inbound_links: 2,
          last_verified: "2026-07-01",
          last_content_change: "2026-07-02",
          orphan: false,
          authority_gap: false,
          metadata_warnings: [],
          broken_links: [],
          version_reference_candidates: [
            { line: 8, text: "Notify @docs-team after Node 24 changes" },
          ],
          proposed_disposition: null,
          evidence: null,
        },
      ];
  return {
    schema_version: 1,
    fingerprint: empty
      ? `docs-garden:${lane}:empty`
      : `docs-garden:${lane}:${shard}-of-${shardCount}`,
    selected_for: selectedFor,
    dry_run: false,
    cycle: {
      cadence: "weekly",
      rule: "fixture",
      week_serial: serial,
      rotation: Math.floor(serial / 6),
    },
    lane,
    shard: empty ? null : shard,
    shard_count: empty ? 0 : shardCount,
    empty_lane: empty,
    document_count: files.length,
    source_words: files.reduce((sum, file) => sum + file.words, 0),
    oversized_singleton: false,
    safety: {
      allowed_dispositions: ["Keep", "Delete"],
      evidence_required: true,
      age_alone_never_justifies_deletion: true,
      verification_dates_change_only_after_verification: true,
      planner_mutates_documentation: false,
    },
    context_budget: { oversized_routes: [], limit_bytes: 40_000 },
    files,
  };
}

function issueForPacket(
  auditPacket,
  { number = 10, state = "OPEN", labels = ["agent-ready"] } = {},
) {
  const body = `${DOCS_GARDEN_MARKER}\n${packetMarker(auditPacket)}\n`;
  return {
    number,
    title: "garden",
    body,
    state,
    labels,
    url: `https://github.test/issues/${number}`,
    marker: parseLeadingDocsGardenMarkers(body),
  };
}

await test("week serial and Monday conversion round-trip", () => {
  const serial = weekSerialForDate("2026-07-23");
  assert.equal(mondayForWeekSerial(serial), "2026-07-20");
});

await test("leading markers round-trip the occurrence identity", () => {
  const auditPacket = packet();
  const marker = parseLeadingDocsGardenMarkers(
    `${DOCS_GARDEN_MARKER}\n${packetMarker(auditPacket)}\nbody`,
  );
  assert.deepEqual(marker, {
    week_serial: auditPacket.cycle.week_serial,
    fingerprint: auditPacket.fingerprint,
    selected_for: auditPacket.selected_for,
    scope_digest: packetScopeDigest(auditPacket),
  });
  assert.equal(
    parseLeadingDocsGardenMarkers(`preface\n${DOCS_GARDEN_MARKER}`),
    null,
  );
  assert.throws(
    () => parseLeadingDocsGardenMarkers(`${DOCS_GARDEN_MARKER}\ninvalid`),
    /malformed packet marker/,
  );
});

await test("generated issue follows the Agent Task body and label contract", () => {
  const spec = buildDocsGardenIssueSpec(packet());
  const headings = [
    "Goal",
    "Context and links",
    "Acceptance criteria",
    "Expected files or package area",
    "Verification commands",
    "Risks, non-goals, and do-not-touch",
    "Dependencies or blockers",
    "Done means",
  ];
  assert.ok(spec.title.startsWith("[Agent task] "));
  for (const heading of headings) {
    assert.ok(spec.body.includes(`### ${heading}`), `missing ${heading}`);
  }
  assert.ok(spec.body.includes("#1341"));
  assert.ok(spec.body.includes("## Generated audit packet"));
  assert.ok(spec.body.includes("docs-garden:operator-runbooks:1-of-2"));
  assert.ok(!spec.body.includes("@docs-team"));
  assert.ok(spec.body.includes("@\u200Bdocs-team"));
  assert.deepEqual(spec.labels, [
    "agent-ready",
    "documentation",
    "pkg:tooling",
    "kind:refactor",
    "source:audit",
    "priority:p2",
    "risk:medium",
  ]);
  assert.equal(
    spec.labels.filter((label) =>
      ["needs-grooming", "agent-ready", "agent-active", "in-pr"].includes(
        label,
      ),
    ).length,
    1,
  );
});

await test("package README lane receives the documented low-risk label", () => {
  const spec = buildDocsGardenIssueSpec(
    packet({ lane: "package-readmes-reference" }),
  );
  assert.ok(spec.labels.includes("risk:low"));
  assert.ok(!spec.labels.includes("risk:medium"));
});

await test("REST normalization deduplicates pages, filters PRs, and parses markers", () => {
  const auditPacket = packet();
  const pages = [
    [
      {
        number: 1,
        state: "open",
        body: `${DOCS_GARDEN_MARKER}\n${packetMarker(auditPacket)}\n`,
        labels: [{ name: "agent-ready" }],
      },
      { number: 2, state: "open", pull_request: {}, body: "" },
    ],
    [
      {
        number: 1,
        state: "open",
        body: `${DOCS_GARDEN_MARKER}\n${packetMarker(auditPacket)}\n`,
        labels: [{ name: "agent-ready" }],
      },
    ],
  ];
  const normalized = normalizeGithubIssuePages(pages);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].marker.week_serial, auditPacket.cycle.week_serial);
  assert.deepEqual(normalized[0].labels, ["agent-ready"]);
});

await test("full GitHub pagination stops only after a short page", async () => {
  const calls = [];
  const pages = [[{ number: 1 }, { number: 2 }], [{ number: 3 }]];
  const result = await ghPaginate("repos/o/r/issues?state=all", {
    perPage: 2,
    runner: async (args) => {
      calls.push(args);
      return JSON.stringify(pages[calls.length - 1]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.flat().length, 3);
});

await test("queue discovery scans all issues instead of trusting routing labels", async () => {
  const auditPacket = packet();
  const calls = [];
  const issues = await listGithubIssues(
    { repo: "owner/repo" },
    {
      runner: async (args) => {
        calls.push(args);
        return JSON.stringify([
          {
            number: 11,
            state: "open",
            body: `${DOCS_GARDEN_MARKER}\n${packetMarker(auditPacket)}\n`,
            labels: [{ name: "agent-ready" }],
          },
          { number: 12, state: "open", pull_request: {}, body: "" },
        ]);
      },
    },
  );
  assert.deepEqual(calls, [
    ["api", "repos/owner/repo/issues?state=all&per_page=100&page=1"],
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].marker.week_serial, auditPacket.cycle.week_serial);
});

await test("label setup creates only missing labels and never force-edits shared labels", async () => {
  const calls = [];
  await ensureLabelsExist(
    { repo: "owner/repo" },
    {
      runner: async (args) => {
        calls.push(args);
        if (args[0] === "api") {
          return JSON.stringify([{ name: "agent-ready" }]);
        }
        return "";
      },
    },
  );
  const creates = calls.filter(
    (args) => args[0] === "label" && args[1] === "create",
  );
  assert.ok(creates.length > 0);
  assert.ok(!creates.some((args) => args.includes("agent-ready")));
  assert.ok(!creates.some((args) => args.includes("--force")));
});

await test("an open occurrence remains the target even after the calendar advances", () => {
  const openPacket = packet();
  const issue = issueForPacket(openPacket);
  assert.equal(
    resolveTargetWeekSerial(openPacket.cycle.week_serial + 5, [issue]),
    openPacket.cycle.week_serial,
  );
});

await test("a closed occurrence advances to the next week serial", () => {
  const closedPacket = packet();
  const issue = issueForPacket(closedPacket, { state: "CLOSED" });
  assert.equal(
    resolveTargetWeekSerial(closedPacket.cycle.week_serial, [issue]),
    closedPacket.cycle.week_serial + 1,
  );
});

await test("same unclaimed occurrence remains immutable instead of duplicating", () => {
  const auditPacket = packet();
  const decision = planDocsGardenIssueSync({
    packet: auditPacket,
    issues: [issueForPacket(auditPacket)],
  });
  assert.equal(decision.action, "keep-current");
});

await test("an unclaimed occurrence with changed file scope is never overwritten", () => {
  const original = packet();
  const changed = packet();
  changed.files = [
    ...changed.files,
    { ...changed.files[0], path: "docs/notes/new-scope.md" },
  ];
  const decision = planDocsGardenIssueSync({
    packet: changed,
    issues: [issueForPacket(original)],
  });
  assert.equal(decision.action, "skip-scope-drift");
});

await test("claimed and in-PR occurrences preserve their scope", () => {
  const auditPacket = packet();
  for (const stateLabel of ["agent-active", "in-pr"]) {
    const decision = planDocsGardenIssueSync({
      packet: auditPacket,
      issues: [issueForPacket(auditPacket, { labels: [stateLabel] })],
    });
    assert.equal(decision.action, "skip-busy");
  }
});

await test("a needs-grooming occurrence remains the live blocked packet", () => {
  const auditPacket = packet();
  const decision = planDocsGardenIssueSync({
    packet: auditPacket,
    issues: [issueForPacket(auditPacket, { labels: ["needs-grooming"] })],
  });
  assert.equal(decision.action, "skip-blocked");
  assert.match(decision.reason, /human clarification/);
});

await test("a different live occurrence blocks a new packet", () => {
  const current = packet();
  const prior = packet({ serial: current.cycle.week_serial - 1 });
  const decision = planDocsGardenIssueSync({
    packet: current,
    issues: [issueForPacket(prior)],
  });
  assert.equal(decision.action, "skip-prior-open");
});

await test("multiple live garden issues and conflicting states fail loud", () => {
  const auditPacket = packet();
  assert.throws(
    () =>
      planDocsGardenIssueSync({
        packet: auditPacket,
        issues: [
          issueForPacket(auditPacket, { number: 1 }),
          issueForPacket(auditPacket, { number: 2 }),
        ],
      }),
    /found 2 open/,
  );
  assert.throws(
    () =>
      planDocsGardenIssueSync({
        packet: auditPacket,
        issues: [
          issueForPacket(auditPacket, {
            labels: ["agent-ready", "agent-active"],
          }),
        ],
      }),
    /2 queue state labels/,
  );
});

await test("an empty lane is a no-op", () => {
  const decision = planDocsGardenIssueSync({
    packet: packet({ empty: true }),
    issues: [],
  });
  assert.equal(decision.action, "noop-empty");
});

function options(auditPacket, overrides = {}) {
  return {
    repo: "owner/repo",
    repoRoot: process.cwd(),
    date: auditPacket.selected_for,
    lane: undefined,
    shard: undefined,
    dryRun: false,
    json: true,
    help: false,
    ...overrides,
  };
}

await test("dry-run reads and plans but performs zero mutations", async () => {
  const auditPacket = packet();
  const calls = { list: 0, ensure: 0, create: 0 };
  const result = await runDocsGardenIssue(
    options(auditPacket, { dryRun: true }),
    {
      listIssues: async () => {
        calls.list += 1;
        return [];
      },
      packetForWeekSerial: async () => auditPacket,
      ensureLabels: async () => {
        calls.ensure += 1;
      },
      createIssue: async () => {
        calls.create += 1;
      },
    },
  );
  assert.equal(result.action, "create");
  assert.equal(result.mutated, false);
  assert.deepEqual(calls, { list: 1, ensure: 0, create: 0 });
});

await test("live creation is rejected outside the serialized workflow", async () => {
  const auditPacket = packet();
  let mutations = 0;
  await assert.rejects(
    runDocsGardenIssue(options(auditPacket), {
      listIssues: async () => [],
      packetForWeekSerial: async () => auditPacket,
      authorizeLiveCreation: async () => {
        throw new Error(
          "live issue creation is restricted to the Documentation Garden workflow",
        );
      },
      ensureLabels: async () => {
        mutations += 1;
      },
      createIssue: async () => {
        mutations += 1;
      },
    }),
    /restricted to the Documentation Garden workflow/,
  );
  assert.equal(mutations, 0);
});

await test("two runs create at most one live issue", async () => {
  const auditPacket = packet();
  const store = [];
  let created = 0;
  const deps = {
    listIssues: async () => store,
    packetForWeekSerial: async () => auditPacket,
    authorizeLiveCreation: async () => {},
    ensureLabels: async () => {},
    createIssue: async (_options, spec) => {
      created += 1;
      store.push(
        issueForPacket(auditPacket, {
          number: 77,
          labels: spec.labels,
        }),
      );
    },
  };
  const first = await runDocsGardenIssue(options(auditPacket), deps);
  const second = await runDocsGardenIssue(options(auditPacket), deps);
  assert.equal(first.action, "create");
  assert.equal(second.action, "keep-current");
  assert.equal(created, 1);
  assert.equal(store.filter((issue) => issue.state === "OPEN").length, 1);
});

await test("closing the live issue lets the next occurrence advance", async () => {
  const prior = packet();
  const store = [issueForPacket(prior, { state: "CLOSED" })];
  let requestedSerial = null;
  const result = await runDocsGardenIssue(options(prior), {
    listIssues: async () => store,
    packetForWeekSerial: async (serial) => {
      requestedSerial = serial;
      return packet({ serial });
    },
    authorizeLiveCreation: async () => {},
    ensureLabels: async () => {},
    createIssue: async () => {},
  });
  assert.equal(requestedSerial, prior.cycle.week_serial + 1);
  assert.equal(result.action, "create");
});

await test("empty-lane orchestration never calls a mutation", async () => {
  const auditPacket = packet({ empty: true });
  let mutations = 0;
  const result = await runDocsGardenIssue(options(auditPacket), {
    listIssues: async () => [],
    packetForWeekSerial: async () => auditPacket,
    ensureLabels: async () => {
      mutations += 1;
    },
    createIssue: async () => {
      mutations += 1;
    },
  });
  assert.equal(result.action, "noop-empty");
  assert.equal(mutations, 0);
});

await test("CLI parsing validates shard and workflow dry-run controls", () => {
  const parsed = parseArgs([], {
    GITHUB_REPOSITORY: "owner/repo",
    DOCS_GARDEN_LANE: "auto",
    DOCS_GARDEN_SHARD: "2",
    DOCS_GARDEN_DRY_RUN: "true",
  });
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.lane, undefined);
  assert.equal(parsed.shard, 2);
  assert.equal(parsed.dryRun, true);
  assert.equal(
    parseArgs(["--", "--dry-run"], {
      GITHUB_REPOSITORY: "owner/repo",
    }).dryRun,
    true,
  );
  assert.throws(
    () =>
      parseArgs(["--shard", "0"], {
        GITHUB_REPOSITORY: "owner/repo",
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      parseArgs([], {
        GITHUB_REPOSITORY: "owner/repo",
        DOCS_GARDEN_DRY_RUN: "maybe",
      }),
    /must be true or false/,
  );
});

function oidcToken(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function workflowOidcFixture(nowSeconds = 1_800_000_000) {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abc123",
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKFLOW_REF:
      "owner/repo/.github/workflows/documentation-garden.yml@refs/heads/main",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/example/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bound-token",
  };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "mento-docs-garden",
    repository: "owner/repo",
    workflow: "Documentation Garden",
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    workflow_sha: env.GITHUB_SHA,
    event_name: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    nbf: nowSeconds - 10,
    iat: nowSeconds - 10,
    exp: nowSeconds + 60,
  };
  return { claims, env, nowSeconds };
}

await test("OIDC authorization binds creation to the exact workflow run", async () => {
  const { claims, env, nowSeconds } = workflowOidcFixture();
  let request;
  const result = await assertAuthorizedGardenWorkflow(
    { repo: "owner/repo" },
    {
      env,
      now: () => nowSeconds * 1000,
      fetchImpl: async (url, init) => {
        request = { url: String(url), init };
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: oidcToken(claims) }),
        };
      },
    },
  );
  assert.equal(result.run_id, "77");
  assert.match(request.url, /audience=mento-docs-garden/);
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, "bearer runner-bound-token");
});

await test("OIDC authorization rejects env spoofing and claim drift", async () => {
  const { claims, env, nowSeconds } = workflowOidcFixture();
  let fetched = false;
  await assert.rejects(
    assertAuthorizedGardenWorkflow(
      { repo: "owner/repo" },
      {
        env: {
          ...env,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
        },
        fetchImpl: async () => {
          fetched = true;
        },
      },
    ),
    /runner credentials are unavailable/,
  );
  assert.equal(fetched, false);
  await assert.rejects(
    assertAuthorizedGardenWorkflow(
      { repo: "owner/repo" },
      {
        env,
        now: () => nowSeconds * 1000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            value: oidcToken({ ...claims, workflow: "CI" }),
          }),
        }),
      },
    ),
    /does not match the active Documentation Garden workflow run/,
  );
});

await test("scheduled workflow fetches the history required by packet evidence", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/documentation-garden.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /actions\/checkout@[a-f0-9]+[^\n]*\n\s+with:\n(?:\s+#[^\n]*\n)*\s+#[^\n]*\n\s+fetch-depth: 0/,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(
    workflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.doesNotMatch(workflow, /github\.ref_name ==/);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
