import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _private,
  SCRIPTS_EXEMPTIONS,
  SOURCE_SCOPES,
  countLines,
  exemptionReason,
  formatIssue,
  formatMarkdown,
  parseBaselineRows,
  partitionExempt,
  scanFileList,
  scopeForPath,
  withRawDeltas,
} from "./file-size-watchlist.mjs";
import {
  ISSUE_MARKER,
  actionableFileSizeRows,
  actionableLabels,
  packageLabelsForRows,
  planIssueSync,
  riskLabelForIssue,
  scopePackageLabel,
} from "./file-size-watchlist-issue.mjs";
// The consumer that reports incomplete grooming. Asserting through it, rather
// than restating its rule here, is what pins the label set to the finding.
import { agentReadyRoutingGaps } from "../pr/issue-board-state.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

// `agentReadyRoutingGaps` reads `labels[].name`; the planner returns bare names.
const asIssue = (labels) => ({ labels: labels.map((name) => ({ name })) });

test("scopeForPath excludes generated files, non-Aegis tests, and dashboard types", () => {
  assert.equal(scopeForPath("indexer-envio/.envio/types.d.ts"), null);
  assert.equal(
    scopeForPath("ui-dashboard/src/lib/__generated__/graphql.ts"),
    null,
  );
  assert.equal(scopeForPath("ui-dashboard/src/lib/types.ts"), null);
  assert.equal(
    scopeForPath("ui-dashboard/src/lib/__tests__/foo.test.ts"),
    null,
  );
  assert.equal(scopeForPath("indexer-envio/src/foo.spec.ts"), null);
  assert.equal(scopeForPath("aegis/src/query.service.spec.ts")?.label, "aegis");

  assert.equal(
    scopeForPath("ui-dashboard/src/lib/network-fetcher/fetch.ts")?.label,
    "dashboard",
  );
  assert.equal(
    scopeForPath("indexer-envio/src/handlers/liquity/troveManager.ts")?.label,
    "indexer",
  );
});

test("countLines tracks raw lines and rough non-comment lines", () => {
  const source = [
    "// comment",
    "",
    "const a = 1;",
    "/* block",
    " * body",
    " */",
    "const b = 2;",
  ].join("\n");

  assert.deepEqual(countLines(source), { raw: 7, rough: 2 });
  assert.deepEqual(countLines("const a = 1;\n"), { raw: 1, rough: 1 });
});

test("scanFileList reports package source files at raw or rough threshold", () => {
  const files = [
    "ui-dashboard/src/lib/raw-large.ts",
    "indexer-envio/src/rough-large.ts",
    "indexer-envio/.envio/types.d.ts",
  ];
  const rawLarge = Array.from({ length: 601 }, () => "// comment").join("\n");
  const roughLarge = Array.from({ length: 1000 }, (_, index) => {
    return `const value${index} = ${index};`;
  }).join("\n");
  const rows = scanFileList(files, (path) => {
    if (path.endsWith("raw-large.ts")) return rawLarge;
    if (path.endsWith("rough-large.ts")) return roughLarge;
    return "generated";
  });

  assert.deepEqual(
    rows.map((row) => [row.path, row.status]),
    [
      ["indexer-envio/src/rough-large.ts", "hard"],
      ["ui-dashboard/src/lib/raw-large.ts", "watch"],
    ],
  );
});

test("formatMarkdown and formatIssue point away from BACKLOG.md", () => {
  const rows = [
    {
      path: "ui-dashboard/src/lib/network-fetcher/fetch.ts",
      package: "dashboard",
      raw: 779,
      rough: 607,
      status: "soft",
      rawDelta: -533,
    },
  ];
  const markdown = formatMarkdown(rows, { generatedAt: "2026-07-03" });
  assert.match(
    markdown,
    /docs\/notes\/file-size-watch\.md|file-size-watchlist/,
  );
  assert.match(markdown, /\| 607 \| 779 \| -533 \| soft cap \|/);

  const issue = formatIssue(rows, { generatedAt: "2026-07-03" });
  assert.match(issue, /GitHub Issues or docs notes/);
  assert.doesNotMatch(issue, /Append.*BACKLOG\.md/);
});

test("baseline parsing supports docs notes and old backlog tables", () => {
  const baseline = [
    "| Raw | Rough | File | Action |",
    "| --: | ----: | ---- | ------ |",
    "| 759 | 520 | `ui-dashboard/src/lib/network-fetcher/fetch.ts` | Watch |",
    "",
    "| Rough | Raw | Delta | Status | File |",
    "| ----: | --: | ----: | ------ | ---- |",
    "| 721 | 757 | -275 | soft cap | `indexer-envio/src/handlers/liquity/troveManager.ts` |",
    "",
    "| Lines | File | Δ since last report |",
    "| ----: | ---- | ------------------: |",
    "| 978 | integration-probes/src/adapters.ts | (new) |",
  ].join("\n");

  assert.deepEqual(
    [...parseBaselineRows(baseline).entries()],
    [
      ["ui-dashboard/src/lib/network-fetcher/fetch.ts", 759],
      ["indexer-envio/src/handlers/liquity/troveManager.ts", 757],
      ["integration-probes/src/adapters.ts", 978],
    ],
  );
});

test("json output honors --limit", () => {
  const output = execFileSync(
    process.execPath,
    [
      "scripts/repo-health/file-size-watchlist.mjs",
      "--format",
      "json",
      "--limit",
      "1",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).rows.length, 1);
});

test("withRawDeltas marks new and changed files", () => {
  const rows = [
    { path: "existing.ts", raw: 120, rough: 100, status: "ok" },
    { path: "new.ts", raw: 50, rough: 50, status: "ok" },
  ];

  assert.deepEqual(
    withRawDeltas(rows, new Map([["existing.ts", 100]])).map((row) => [
      row.path,
      row.rawDelta,
    ]),
    [
      ["existing.ts", 20],
      ["new.ts", null],
    ],
  );
});

test("fail-on policy only blocks the requested severity", () => {
  assert.equal(_private.shouldFail([{ status: "watch" }], "soft"), false);
  assert.equal(_private.shouldFail([{ status: "soft" }], "soft"), true);
  assert.equal(_private.shouldFail([{ status: "soft" }], "hard"), false);
  assert.equal(_private.shouldFail([{ status: "hard" }], "hard"), true);
});

test("actionable drift keeps cap status separate from raw growth", () => {
  const rows = [
    { path: "hard.ts", status: "hard", rawDelta: 0 },
    { path: "near.ts", status: "near-hard", rawDelta: -20 },
    { path: "new-soft.ts", status: "soft", rawDelta: null },
    { path: "growing-soft.ts", status: "soft", rawDelta: 101 },
    { path: "steady-soft.ts", status: "soft", rawDelta: 100 },
    { path: "raw-only.ts", status: "watch", rawDelta: 500 },
  ];

  assert.deepEqual(
    actionableFileSizeRows(rows).map((row) => row.path),
    ["hard.ts", "near.ts", "new-soft.ts", "growing-soft.ts"],
  );
});

test("issue sync creates, resolves, and force-publishes one marked issue", () => {
  const actionableRows = [
    { path: "near.ts", package: "dashboard", status: "near-hard", rawDelta: 0 },
  ];
  const marked = {
    number: 44,
    state: "open",
    body: ISSUE_MARKER,
    labels: [{ name: "agent-ready" }, { name: "custom" }],
  };

  const created = planIssueSync({
    issues: [],
    rows: actionableRows,
    publishReport: false,
  });
  assert.equal(created.action, "create");
  assert.deepEqual(created.labels, [
    "file-size-watchlist",
    "agent-ready",
    "kind:refactor",
    "priority:p2",
    "pkg:dashboard",
    "risk:medium",
  ]);

  const resolved = planIssueSync({
    issues: [marked],
    rows: [],
    publishReport: false,
  });
  assert.equal(resolved.action, "close-resolved");
  assert.deepEqual(resolved.labels, ["custom", "file-size-watchlist"]);

  assert.equal(
    planIssueSync({ issues: [], rows: [], publishReport: true }).action,
    "create-closed-report",
  );
});

test("issue sync never overwrites a claimed packet and fails on duplicates", () => {
  const active = {
    number: 45,
    state: "open",
    body: ISSUE_MARKER,
    labels: [{ name: "agent-active" }],
  };
  assert.equal(
    planIssueSync({ issues: [active], rows: [], publishReport: true }).action,
    "retain",
  );

  assert.throws(
    () =>
      planIssueSync({
        issues: [active, { ...active, number: 46 }],
        rows: [],
        publishReport: false,
      }),
    /expected at most one/,
  );
});

test("every watchlist scope maps to a pkg:* label", () => {
  for (const scope of SOURCE_SCOPES) {
    assert.match(scopePackageLabel(scope.label), /^pkg:/);
  }
  assert.throws(() => scopePackageLabel("terraform"), /has no pkg:\* label/);
});

test("actionable labels span every package the rows touch", () => {
  const rows = [
    {
      path: "scripts/sentry/triage/sentry-triage-project.mjs",
      package: "scripts",
    },
    { path: "ui-dashboard/src/app/page.tsx", package: "dashboard" },
    { path: "aegis/src/server.ts", package: "aegis" },
  ];
  assert.deepEqual(packageLabelsForRows(rows), [
    "pkg:aegis",
    "pkg:dashboard",
    "pkg:tooling",
  ]);
  assert.deepEqual(actionableLabels(rows), [
    "file-size-watchlist",
    "agent-ready",
    "kind:refactor",
    "priority:p2",
    "pkg:aegis",
    "pkg:dashboard",
    "pkg:tooling",
    "risk:medium",
  ]);
});

test("the live scan never produces a sweep-claimable label set", () => {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/repo-health/file-size-watchlist.mjs", "--format", "json"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
    ),
  );
  const actionable = actionableFileSizeRows(report.rows);
  if (actionable.length === 0) {
    // Drift cleared, which is the state the automation exists to reach. The
    // filer opens nothing, so there is no label set to check; assert that
    // instead of failing the suite for the healthy tree.
    const plan = planIssueSync({
      issues: [],
      rows: report.rows,
      publishReport: false,
    });
    assert.equal(plan.action, "noop");
    return;
  }
  const labels = actionableLabels(actionable);
  // The sweep predicate is `agent-ready` plus exactly one `risk:*` equal to
  // `risk:low` plus exactly one `pkg:*` (`hasSweepRouting`,
  // scripts/pr/issue-board-state.mjs). This job writes `agent-ready`, so the
  // risk label is the only thing keeping its own issue out of the unattended
  // sweep. docs/notes/backlog-sweep.md reserves that `risk:low` for a human.
  assert.ok(labels.includes("agent-ready"));
  assert.deepEqual(
    labels.filter((label) => label.startsWith("risk:")),
    ["risk:medium"],
  );
  assert.deepEqual(agentReadyRoutingGaps(asIssue(labels)), []);
});

test("a lone production-data writer still files at the risk floor", () => {
  // sentry-triage-archive.mjs is a live actionable row and it archives the
  // underlying Sentry issue under a write-scoped token. Any per-row risk rule
  // that misses the low-risk rule's production-data clause reads this single
  // scripts/ row as `risk:low` and hands the issue to the unattended sweep.
  const rows = [
    {
      path: "scripts/sentry/triage/sentry-triage-archive.mjs",
      package: "scripts",
    },
  ];
  const labels = actionableLabels(rows);
  assert.deepEqual(packageLabelsForRows(rows), ["pkg:tooling"]);
  assert.equal(riskLabelForIssue([]), "risk:medium");
  // The fixture, not the live scan, is what pins the contract: one package, one
  // risk label, and never the `risk:low` that would complete the sweep
  // predicate. This holds whether or not the tree has drift today.
  assert.ok(labels.includes("agent-ready"));
  assert.deepEqual(
    labels.filter((label) => label.startsWith("risk:")),
    ["risk:medium"],
  );
  assert.deepEqual(agentReadyRoutingGaps(asIssue(labels)), []);
});

test("an operator risk escalation survives the next upsert as the only risk label", () => {
  const marked = {
    number: 44,
    state: "open",
    body: ISSUE_MARKER,
    labels: [
      { name: "agent-ready" },
      { name: "risk:high" },
      { name: "pkg:alerts" },
      { name: "file-size-watchlist" },
    ],
  };
  const plan = planIssueSync({
    issues: [marked],
    rows: [
      {
        path: "ui-dashboard/src/app/page.tsx",
        package: "dashboard",
        status: "hard",
        rawDelta: 0,
      },
    ],
    publishReport: false,
  });
  assert.equal(plan.action, "upsert-open");
  assert.deepEqual(
    plan.labels.filter((label) => label.startsWith("risk:")),
    ["risk:high"],
    "the write must never leave two risk labels, and must never lower one",
  );
  // A package area this job did not apply only narrows eligibility, so it stays.
  assert.ok(plan.labels.includes("pkg:alerts"));
  assert.ok(plan.labels.includes("pkg:dashboard"));
  assert.deepEqual(agentReadyRoutingGaps(asIssue(plan.labels)), []);
});

test("the risk floor holds and an unrankable risk label is repaired", () => {
  assert.equal(riskLabelForIssue(["risk:low"]), "risk:medium");
  assert.equal(riskLabelForIssue(["risk:medium"]), "risk:medium");
  assert.equal(riskLabelForIssue(["risk:high"]), "risk:high");
  assert.equal(riskLabelForIssue(["risk:unknown"]), "risk:medium");
  assert.equal(riskLabelForIssue(["risk:low", "risk:high"]), "risk:high");
});

test("the resolved label set keeps managed routing labels off a closed report", () => {
  const marked = {
    number: 47,
    state: "open",
    body: ISSUE_MARKER,
    labels: [
      { name: "pkg:tooling" },
      { name: "risk:medium" },
      { name: "custom" },
    ],
  };
  const resolved = planIssueSync({
    issues: [marked],
    rows: [],
    publishReport: false,
  });
  assert.deepEqual(resolved.labels, ["custom", "file-size-watchlist"]);
});

const BIG_SOURCE = Array.from(
  { length: 1200 },
  (_, index) => `const value${index} = ${index};`,
).join("\n");

test("the scripts scope covers executable and native sources at every depth", () => {
  assert.equal(scopeForPath("scripts/tf-stacks.mjs")?.label, "scripts");
  assert.equal(
    scopeForPath("scripts/alerts/check-peg-registry-integrity.mjs")?.label,
    "scripts",
  );
  assert.equal(scopeForPath("scripts/agent-quality-gate.sh")?.label, "scripts");
  assert.equal(
    scopeForPath("scripts/gate/darwin-process-identity.c")?.label,
    "scripts",
  );
  assert.equal(
    scopeForPath("scripts/gate/darwin-process-identity-runtime.inc.c")?.label,
    "scripts",
  );
  // Tests follow the rule every scope but Aegis uses.
  assert.equal(scopeForPath("scripts/alerts/alert-rules-lint.test.mjs"), null);
  assert.equal(scopeForPath("scripts/agent-quality-gate.test.sh"), null);
  assert.equal(scopeForPath("scripts/gate/native-helper.test.c"), null);
  // Only executable sources. The manifest, the schema stub, and AGENTS.md are
  // data or prose, and a line cap says nothing useful about them.
  assert.equal(
    scopeForPath("scripts/sentry/gate/sentry-suite-manifest.json"),
    null,
  );
  assert.equal(scopeForPath("scripts/envio-schema-stubs.graphql"), null);
  assert.equal(scopeForPath("scripts/AGENTS.md"), null);
});

test("countLines treats # as a comment only when asked", () => {
  const shell = ["#!/usr/bin/env bash", "# note", "set -euo pipefail"].join(
    "\n",
  );
  assert.deepEqual(countLines(shell, { hashComments: true }), {
    raw: 3,
    rough: 1,
  });
  assert.deepEqual(countLines(shell), { raw: 3, rough: 3 });
});

// Spelled out rather than derived from SCRIPTS_EXEMPTIONS: an expectation read
// from the thing under test shrinks with it, and every deletion still passes.
const EXPECTED_EXEMPT_PATHS = [];

const ADR_PATH = "docs/adr/0065-scripts-file-size-watchlist-scope.md";

test("the exemption list is empty and its record says so", () => {
  const declared = SCRIPTS_EXEMPTIONS.flatMap((entry) => entry.paths);
  assert.deepEqual(
    [...declared].sort(),
    [...EXPECTED_EXEMPT_PATHS].sort(),
    `adding or dropping an exemption is an ${ADR_PATH} decision; update that ADR and this list together`,
  );

  // The ADR is the record; make that claim true rather than assumed.
  const adr = readFileSync(resolve(repoRoot, ADR_PATH), "utf8");
  assert.match(
    adr,
    /no exemptions/iu,
    `${ADR_PATH} does not record that the exemption list is empty`,
  );

  // Files whose split is merely expensive, or already owned by an issue, are
  // not exempt. agent-quality-gate.sh is issue 1498's whole subject; the two
  // test paths never reach the report at all, and are here as pure
  // exemptionReason controls.
  for (const path of [
    "scripts/agent-quality-gate.sh",
    "scripts/pr/pr-ready-state-core.mjs",
    "scripts/deploy-staging-contract.mjs",
    "scripts/sentry/autofix/sentry-autofix-select.test.mjs",
    "scripts/tf-stacks.test.mjs",
  ]) {
    assert.equal(exemptionReason(path), null, `${path} must not be exempt`);
  }
});

test("the live report never routes an exempt file into the issue queue", () => {
  // The producer/consumer boundary end to end: the CLI's own JSON, through the
  // filter the monthly workflow applies.
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/repo-health/file-size-watchlist.mjs", "--format", "json"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
    ),
  );
  const exemptPaths = new Set(report.exempt.map((row) => row.path));
  assert.deepEqual([...exemptPaths].sort(), [...EXPECTED_EXEMPT_PATHS].sort());

  const actionable = actionableFileSizeRows(report.rows);
  assert.deepEqual(
    actionable.filter((row) => exemptPaths.has(row.path)),
    [],
  );
  assert.deepEqual(
    report.rows.filter((row) => row.status === "exempt"),
    [],
    "an exempt row leaked into the tracked list the consumer reads",
  );
  assert.ok(
    report.rows.some((row) => row.path.startsWith("scripts/")),
    "the scripts scope reported nothing; the scope or the reader is broken",
  );
});

test("an exemption is what suppresses the row, not the scope", () => {
  // The live list is empty (ADR 0087), so this drives the real mechanism with a
  // temporary entry rather than a stub: same content, two paths, one listed.
  // Without the entry the identical file reports as a hard-cap row.
  const files = ["scripts/exempted-helper.mjs", "scripts/plain-helper.mjs"];
  assert.deepEqual(
    scanFileList(files, () => BIG_SOURCE).map((row) => [row.path, row.status]),
    [
      ["scripts/exempted-helper.mjs", "hard"],
      ["scripts/plain-helper.mjs", "hard"],
    ],
    "an unlisted scripts file must report as a plain hard-cap row",
  );

  SCRIPTS_EXEMPTIONS.push({
    reason: "trust root: fixture entry for this test only",
    paths: ["scripts/exempted-helper.mjs"],
  });
  try {
    const rows = scanFileList(files, () => BIG_SOURCE);
    assert.deepEqual(
      rows.map((row) => [row.path, row.status]),
      [
        ["scripts/exempted-helper.mjs", "exempt"],
        ["scripts/plain-helper.mjs", "hard"],
      ],
    );
    assert.equal(rows[0].capStatus, "hard");

    const { tracked, exempt } = partitionExempt(rows);
    assert.deepEqual(
      tracked.map((row) => row.path),
      ["scripts/plain-helper.mjs"],
    );
    assert.equal(exempt.length, 1);
    // An exempt row can never open an issue or fail a run.
    assert.deepEqual(actionableFileSizeRows(exempt), []);
    assert.equal(_private.shouldFail(exempt, "hard"), false);
  } finally {
    SCRIPTS_EXEMPTIONS.length = 0;
  }
});

test("an exempt row reports its reason instead of vanishing", () => {
  const rows = [
    {
      path: "scripts/exempted-helper.sh",
      package: "scripts",
      raw: 6872,
      rough: 6479,
      status: "exempt",
      capStatus: "hard",
      reason: "trust root: hashes its own blob against frozen HEAD",
      rawDelta: 0,
    },
  ];
  const markdown = formatMarkdown(rows, { generatedAt: "2026-08-18" });
  assert.match(markdown, /No files above the watch threshold/);
  assert.match(markdown, /Exempt \(1\)/);
  assert.match(markdown, /hashes its own blob against frozen HEAD/);
  assert.match(formatIssue(rows), /hashes its own blob against frozen HEAD/);
});

test("the CLI reports the scripts scope and never truncates the exempt table", () => {
  const output = execFileSync(
    process.execPath,
    [
      "scripts/repo-health/file-size-watchlist.mjs",
      "--format",
      "json",
      "--limit",
      "1",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
  );
  const report = JSON.parse(output);
  assert.equal(report.rows.length, 1);
  assert.deepEqual(
    report.exempt.map((row) => row.path).sort(),
    [...EXPECTED_EXEMPT_PATHS].sort(),
    "--limit trimmed the exemption table; a truncated exemption reads as a dropped file",
  );
  assert.ok(
    report.exempt.every((row) => row.status === "exempt" && row.reason),
    "an exempt row shipped without its reason",
  );
});

test("a scratch checkout flags an unexempted scripts file at the hard cap", () => {
  const root = mkdtempSync(join(tmpdir(), "file-size-watchlist-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, "scripts"));
    // Nothing is exempt any more (ADR 0087), so every over-cap scripts file
    // below must reach the report as a tracked hard-cap row.
    writeFileSync(join(root, "scripts/other-helper.mjs"), BIG_SOURCE);
    writeFileSync(join(root, "scripts/plain-helper.mjs"), BIG_SOURCE);
    // A newline in the name forces git to C-quote it in line-delimited output,
    // whatever `core.quotePath` says, and a quoted path matches no scope
    // prefix. Read without `-z`, this over-cap file vanishes from the report.
    writeFileSync(join(root, `scripts/odd${"\n"}helper.mjs`), BIG_SOURCE);

    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve(repoRoot, "scripts/repo-health/file-size-watchlist.mjs"),
          "--root",
          root,
          "--format",
          "json",
          "--no-baseline",
        ],
        { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
      ),
    );

    assert.deepEqual(
      report.rows.map((row) => [row.path, row.status]).sort(),
      [
        ["scripts/other-helper.mjs", "hard"],
        ["scripts/plain-helper.mjs", "hard"],
        [`scripts/odd${"\n"}helper.mjs`, "hard"],
      ].sort(),
    );
    assert.deepEqual(report.exempt, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow owns the monthly current-main issue route", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/file-size-watchlist.yml"),
    "utf8",
  );

  assert.match(workflow, /cron: 13 7 1 \* \*$/m);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(workflow, /FILE_SIZE_WATCHLIST_ROOT:/);
  assert.match(workflow, /gh label create "file-size-watchlist"/);
  assert.match(
    workflow,
    /node scripts\/repo-health\/file-size-watchlist-issue\.mjs --json/,
  );
  assert.doesNotMatch(workflow, /BACKLOG\.md/);
});
