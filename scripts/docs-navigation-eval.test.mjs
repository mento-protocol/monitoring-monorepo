#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNavigationEvalIssueSpec,
  buildNavigationPrompt,
  fixtureDigest,
  isNavigationEvalAnswerArtifact,
  isRoutingSensitivePath,
  navigationContextFloor,
  navigationMonthMarker,
  NAVIGATION_EVAL_MAX_EVIDENCE_LINES,
  NAVIGATION_EVAL_MARKER,
  normalizeNavigationEvalIssuePages,
  parseLeadingNavigationEvalMarkers,
  planNavigationEvalIssueSync,
  validateFixtureSuite,
} from "./docs-navigation-eval-helpers.mjs";
import {
  scoreNavigationResult,
  validateNavigationResultShape,
} from "./docs-navigation-eval-result.mjs";
import {
  assertCleanEvaluationCheckout,
  loadEvaluationContext,
  parseArgs,
  runNavigationEvalIssue,
} from "./docs-navigation-eval.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const committedBaseline = JSON.parse(
  readFileSync(
    new URL(
      "../docs/evals/documentation-navigation-baseline.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const repoBaseCommit = committedBaseline.run.repository_base_commit;
const scriptPath = fileURLToPath(
  new URL("./docs-navigation-eval.mjs", import.meta.url),
);
const options = {
  repoRoot,
  fixturesPath: "docs/evals/documentation-navigation-fixtures.json",
  baselinePath: "docs/evals/documentation-navigation-baseline.json",
};
const context = loadEvaluationContext(options);
const records = new Map(
  context.inventory.records.map((record) => [record.path, record]),
);
const sourceContentCache = new Map();

function source(pathname) {
  let content = sourceContentCache.get(pathname);
  if (!content) {
    content = execFileSync("git", ["show", `${repoBaseCommit}:${pathname}`], {
      cwd: repoRoot,
      encoding: null,
    });
    sourceContentCache.set(pathname, content);
  }
  return {
    path: pathname,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function qualification(pathname, overrides = {}) {
  return {
    path: pathname,
    authority: records.get(pathname).authority,
    qualification: "",
    verified_against: [],
    ...overrides,
  };
}

function validResult() {
  return {
    schema_version: 1,
    suite_id: context.suite.suite_id,
    fixture_digest: fixtureDigest(context.suite),
    run: {
      agent: "fixture-agent",
      model: "fixture-model",
      effort: "low",
      executed_at: "2026-07-21T00:00:00.000Z",
      repository_base_commit: repoBaseCommit,
      fresh_context: true,
      read_only: true,
      bootstrap_sources: context.suite.bootstrap_sources.map(source),
    },
    answers: context.suite.questions.map((question) => {
      const route = question.accepted_routes[0];
      return {
        question_id: question.id,
        chosen_documents: [...route],
        answer:
          "The cited canonical documentation supplies the current route and evidence.",
        evidence: route.map((pathname) => ({
          path: pathname,
          line_start: 1,
          line_end: 1,
          supports:
            "The canonical document is the expected authority for this question.",
        })),
        authority_qualifications: route.map((pathname) =>
          qualification(pathname),
        ),
        loaded_sources: route.map(source),
      };
    }),
  };
}

function score(result) {
  return scoreNavigationResult({
    suite: context.suite,
    result,
    inventory: context.inventory,
    repoRoot,
  });
}

function issueFor(month, digest, overrides = {}) {
  return {
    number: 77,
    title: "evaluation",
    body: `${NAVIGATION_EVAL_MARKER}\n${navigationMonthMarker(month, digest)}\n`,
    state: "OPEN",
    labels: ["agent-ready", "source:audit"],
    marker: { month, fixture_digest: digest },
    ...overrides,
  };
}

test("fixtures cover every category with canonical routes", () => {
  assert.deepEqual(validateFixtureSuite(context.suite, context.inventory), []);
  assert.equal(context.suite.questions.length, 18);
  assert.deepEqual(
    [
      ...new Set(context.suite.questions.map((question) => question.category)),
    ].sort(),
    [
      "architecture",
      "commands",
      "deployment",
      "operator-workflows",
      "packages",
      "pr-hazards",
    ],
  );
});

test("fixture validation rejects a non-canonical accepted route", () => {
  const suite = structuredClone(context.suite);
  suite.questions[0].accepted_routes = [["docs/PLAN-ai-review-process.md"]];
  assert.match(
    validateFixtureSuite(suite, context.inventory).join("\n"),
    /route is not canonical/,
  );
});

test("retired historical verification traps need not remain in the corpus", () => {
  const suite = structuredClone(context.suite);
  suite.questions[0].sources_requiring_verification = [
    {
      path: "docs/PLAN-celo-mainnet-indexer.md",
      verify_against: ["shared-config/AGENTS.md"],
    },
  ];
  assert.deepEqual(validateFixtureSuite(suite, context.inventory), []);

  suite.questions[0].sources_requiring_verification[0].path =
    "docs/PLAN-celo-mainnet-indexre.md";
  assert.match(
    validateFixtureSuite(suite, context.inventory).join("\n"),
    /verification source is missing/,
  );

  suite.questions[0].sources_requiring_verification[0].path = "";
  assert.match(
    validateFixtureSuite(suite, context.inventory).join("\n"),
    /verification source has an invalid path/,
  );

  for (const alias of [
    "./shared-config/AGENTS.md",
    "shared-config//AGENTS.md",
    "shared-config/./AGENTS.md",
  ]) {
    suite.questions[0].sources_requiring_verification[0].path = alias;
    assert.match(
      validateFixtureSuite(suite, context.inventory).join("\n"),
      /verification source has an invalid path/,
    );
  }

  suite.questions[0].sources_requiring_verification[0].path =
    "shared-config/AGENTS.md";
  assert.match(
    validateFixtureSuite(suite, context.inventory).join("\n"),
    /verification source is already canonical/,
  );
});

test("fixture validation requires an explicit context-breach target", () => {
  const suite = structuredClone(context.suite);
  delete suite.targets.questions_over_context_budget;
  assert.match(
    validateFixtureSuite(suite, context.inventory).join("\n"),
    /questions_over_context_budget must be a non-negative integer/,
  );
});

test("fixture byte budgets can contain every cheapest accepted route", () => {
  const floor = navigationContextFloor(context.suite, context.inventory);
  assert.ok(
    floor.max_question_route_bytes <
      context.suite.targets.max_question_source_bytes,
  );
  assert.ok(
    floor.total_unique_route_bytes <
      context.suite.targets.max_total_unique_source_bytes,
  );

  const questionTooTight = structuredClone(context.suite);
  questionTooTight.targets.max_question_source_bytes =
    floor.max_question_route_bytes - 1;
  assert.match(
    validateFixtureSuite(questionTooTight, context.inventory).join("\n"),
    /cheapest accepted route needs/,
  );

  const suiteTooTight = structuredClone(context.suite);
  suiteTooTight.targets.max_total_unique_source_bytes =
    floor.total_unique_route_bytes - 1;
  assert.match(
    validateFixtureSuite(suiteTooTight, context.inventory).join("\n"),
    /cheapest accepted route union needs/,
  );
});

test("answer artifacts include future run outputs but exclude contracts", () => {
  assert.equal(
    isNavigationEvalAnswerArtifact(
      "docs/evals/documentation-navigation-baseline.json",
    ),
    true,
  );
  assert.equal(
    isNavigationEvalAnswerArtifact(
      "docs/evals/documentation-navigation-2026-08-post-garden.json",
    ),
    true,
  );
  assert.equal(
    isNavigationEvalAnswerArtifact(
      "docs/evals/documentation-navigation-fixtures.json",
    ),
    false,
  );
  assert.equal(
    isNavigationEvalAnswerArtifact(
      "docs/evals/documentation-navigation-result.schema.json",
    ),
    false,
  );
});

test("prompt is deterministic and never leaks routes or qualification traps", () => {
  const baseCommit = "b".repeat(40);
  const first = buildNavigationPrompt(context.suite, { baseCommit });
  const second = buildNavigationPrompt(context.suite, { baseCommit });
  assert.equal(first, second);
  assert.match(first, /fresh, read-only repository agent/);
  assert.match(first, /Do not use network access/);
  assert.match(first, /at most 21 lines/);
  assert.match(first, /45,000 UTF-8 bytes/);
  assert.match(first, /272,000 UTF-8 bytes/);
  assert.match(first, /documentation-navigation-\*\.json/);
  assert.match(first, /result schema remains allowed/);
  assert.match(first, /do not\s+repeat them in an answer's `loaded_sources`/);
  assert.match(first, /scripts\/docs-navigation-eval-result\.mjs/);
  assert.ok(!first.includes("shared-config/AGENTS.md"));
  assert.ok(!first.includes("docs/PLAN-celo-mainnet-indexer.md"));
  const targeted = buildNavigationPrompt(context.suite, {
    baseCommit,
    questionId: context.suite.questions[0].id,
  });
  assert.match(targeted, new RegExp(context.suite.questions[0].id));
  assert.match(targeted, /Return exactly one answer object/);
  assert.match(targeted, /--validate <result\.json> --question/);
  assert.ok(!targeted.includes(context.suite.questions[1].id));
});

test("one-question escalation is scored independently without weakening full runs", () => {
  const questionId = context.suite.questions[0].id;
  const result = validResult();
  result.answers = result.answers.filter(
    (answer) => answer.question_id === questionId,
  );
  const targeted = scoreNavigationResult({
    suite: context.suite,
    result,
    repoRoot,
    questionId,
  });
  assert.deepEqual(targeted.errors, []);
  assert.equal(targeted.report.question_count, 1);
  assert.equal(targeted.report.passed, true);
  const full = score(result);
  assert.match(full.errors.join("\n"), /must contain 15 to 20 items/);
  assert.equal(full.report.passed, false);
});

test("a complete result passes every deterministic target", () => {
  const scored = score(validResult());
  assert.deepEqual(scored.errors, []);
  assert.equal(scored.report.passed, true);
  assert.equal(scored.report.routing_accuracy_percent, 100);
  assert.equal(scored.report.answer_evidence_percent, 100);
  assert.equal(scored.report.shortest_route_percent, 100);
  assert.equal(
    scored.report.canonical_source_compliance.unqualified_noncanonical_sources,
    0,
  );
});

test("missing evidence and answers fail closed", () => {
  const result = validResult();
  result.answers[0].evidence = [];
  result.answers.pop();
  const scored = score(result);
  assert.match(scored.errors.join("\n"), /must cite evidence/);
  assert.match(scored.errors.join("\n"), /missing answer/);
  assert.equal(scored.report.passed, false);
});

test("evidence line spans are targeted and bounded", () => {
  const result = validResult();
  result.answers[0].evidence[0].line_end = NAVIGATION_EVAL_MAX_EVIDENCE_LINES;
  assert.deepEqual(score(result).errors, []);
  result.answers[0].evidence[0].line_end =
    NAVIGATION_EVAL_MAX_EVIDENCE_LINES + 1;
  const scored = score(result);
  assert.match(scored.errors.join("\n"), /invalid line evidence/);
  assert.equal(scored.report.passed, false);
});

test("wrong source bytes or hashes are rejected", () => {
  const result = validResult();
  result.answers[0].loaded_sources[0].bytes += 1;
  result.answers[1].loaded_sources[0].sha256 = "0".repeat(64);
  const scored = score(result);
  assert.match(scored.errors.join("\n"), /expected/);
  assert.match(scored.errors.join("\n"), /wrong sha256/);
});

test("per-answer loaded sources cannot repeat bootstrap sources", () => {
  const result = validResult();
  const bootstrap = result.run.bootstrap_sources[0];
  result.answers[0].loaded_sources.push({ ...bootstrap });
  result.answers[0].authority_qualifications.push({
    path: bootstrap.path,
    authority: "canonical",
    qualification: "",
    verified_against: [],
  });
  const scored = score(result);
  assert.match(
    scored.errors.join("\n"),
    /repeats bootstrap source AGENTS\.md in loaded_sources/,
  );
  assert.equal(scored.report.passed, false);
});

test("reported future answer artifacts are rejected", () => {
  const result = validResult();
  result.answers[0].loaded_sources.push({
    path: "docs/evals/documentation-navigation-2026-08-post-garden.json",
    bytes: 1,
    sha256: "0".repeat(64),
  });
  const scored = score(result);
  assert.match(
    scored.errors.join("\n"),
    /loaded forbidden navigation evaluation answer artifact/,
  );
  assert.equal(scored.report.passed, false);
});

test("published result schema rejects unexpected and missing properties", () => {
  const result = validResult();
  result.unexpected_top = true;
  result.run.unexpected_run = true;
  result.answers[0].unexpected_answer = true;
  result.answers[0].evidence[0].unexpected_evidence = true;
  delete result.answers[0].authority_qualifications[0].verified_against;
  const errors = validateNavigationResultShape(result).join("\n");
  assert.match(errors, /result has unexpected property unexpected_top/);
  assert.match(errors, /result\.run has unexpected property unexpected_run/);
  assert.match(errors, /unexpected property unexpected_answer/);
  assert.match(errors, /unexpected property unexpected_evidence/);
  assert.match(errors, /is missing verified_against/);
  assert.equal(score(result).report.passed, false);
});

test("historical scoring requires a default-branch ancestor and survives deletion", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "docs-navigation-history-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: temp });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: temp });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], {
      cwd: temp,
    });
    const files = new Set(context.suite.bootstrap_sources);
    for (const question of context.suite.questions) {
      for (const file of question.accepted_routes[0]) files.add(file);
    }
    const content = [
      "---",
      "title: Historical fixture",
      "status: active",
      "owner: eng",
      "canonical: true",
      "last_verified: 2026-07-21",
      "doc_type: reference",
      "scope: repo-wide",
      "review_interval_days: 90",
      "garden_lane: package-readmes-reference",
      "---",
      "",
      "# Historical fixture",
      "",
      "Canonical evidence.",
      "",
    ].join("\n");
    for (const file of files) {
      const absolute = path.join(temp, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    execFileSync("git", ["add", "."], { cwd: temp });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: temp });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", commit], {
      cwd: temp,
    });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "branch-only"], {
      cwd: temp,
    });
    const branchOnlyCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temp,
      encoding: "utf8",
    }).trim();
    const historicalSource = (pathname) => {
      const bytes = execFileSync("git", ["show", `${commit}:${pathname}`], {
        cwd: temp,
        encoding: null,
      });
      return {
        path: pathname,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const result = {
      schema_version: 1,
      suite_id: context.suite.suite_id,
      fixture_digest: fixtureDigest(context.suite),
      run: {
        agent: "historical-fixture",
        model: "fixture",
        effort: "low",
        executed_at: "2026-07-21T00:00:00.000Z",
        repository_base_commit: commit,
        fresh_context: true,
        read_only: true,
        bootstrap_sources:
          context.suite.bootstrap_sources.map(historicalSource),
      },
      answers: context.suite.questions.map((question) => ({
        question_id: question.id,
        chosen_documents: [...question.accepted_routes[0]],
        answer: "The historical canonical route supplies the answer.",
        evidence: question.accepted_routes[0].map((pathname) => ({
          path: pathname,
          line_start: 1,
          line_end: 1,
          supports: "The route was canonical at the evaluated commit.",
        })),
        authority_qualifications: question.accepted_routes[0].map(
          (pathname) => ({
            path: pathname,
            authority: "canonical",
            qualification: "",
            verified_against: [],
          }),
        ),
        loaded_sources: question.accepted_routes[0].map(historicalSource),
      })),
    };
    for (const file of files) rmSync(path.join(temp, file));
    const scored = scoreNavigationResult({
      suite: context.suite,
      result,
      repoRoot: temp,
    });
    assert.deepEqual(scored.errors, []);
    assert.equal(scored.report.passed, true);

    result.run.repository_base_commit = branchOnlyCommit;
    const branchOnlyScored = scoreNavigationResult({
      suite: context.suite,
      result,
      repoRoot: temp,
    });
    assert.match(
      branchOnlyScored.errors.join("\n"),
      /repository_base_commit is not reachable from refs\/remotes\/origin\/main/,
    );
    assert.equal(branchOnlyScored.report.passed, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("an over-budget answer is measured and fails", () => {
  const result = validResult();
  const answer = result.answers[0];
  const large = "docs/notes/sentry-triage-pipeline.md";
  answer.loaded_sources.push(source(large));
  answer.authority_qualifications.push(qualification(large));
  const scored = score(result);
  assert.equal(scored.report.context.questions_over_budget, 1);
  assert.equal(scored.report.passed, false);
});

test("unqualified non-canonical reliance is counted and fails", () => {
  const result = validResult();
  const answer = result.answers[0];
  const historical = "docs/PLAN-ai-review-process.md";
  answer.loaded_sources.push(source(historical));
  answer.authority_qualifications.push(qualification(historical));
  const scored = score(result);
  assert.equal(
    scored.report.canonical_source_compliance.unqualified_noncanonical_sources,
    1,
  );
  assert.equal(scored.report.passed, false);
});

test("a qualified historical source requires loaded canonical verification", () => {
  const result = validResult();
  const answer = result.answers.find(
    (candidate) => candidate.question_id === "commands-pr-readiness",
  );
  const historical = "docs/PLAN-ai-review-process.md";
  answer.loaded_sources.push(source(historical));
  answer.authority_qualifications.push(
    qualification(historical, {
      qualification:
        "Historical planning context only; current readiness comes from the runbook.",
      verified_against: ["docs/notes/pr-ready-state.md"],
    }),
  );
  result.answers = [answer];
  const scored = scoreNavigationResult({
    suite: context.suite,
    result,
    repoRoot,
    questionId: "commands-pr-readiness",
  });
  assert.equal(
    scored.report.canonical_source_compliance.unqualified_noncanonical_sources,
    0,
  );
  assert.equal(scored.report.passed, true);
});

test("route order and shortest useful path are measured independently", () => {
  const result = validResult();
  const answer = result.answers.find(
    (candidate) => candidate.question_id === "package-indexer-add-contract",
  );
  answer.chosen_documents.reverse();
  let scored = score(result);
  const reversedReport = scored.report.questions.find(
    (question) => question.question_id === answer.question_id,
  );
  assert.equal(reversedReport.routing_correct, false);
  assert.equal(reversedReport.evidence_complete, true);
  assert.equal(scored.report.routing_accuracy_percent, 94.4);
  assert.equal(scored.report.answer_evidence_percent, 100);
  assert.equal(scored.report.passed, true);
  answer.chosen_documents.reverse();
  answer.chosen_documents.push("docs/context-standards.md");
  answer.loaded_sources.push(source("docs/context-standards.md"));
  answer.authority_qualifications.push(
    qualification("docs/context-standards.md"),
  );
  scored = score(result);
  assert.equal(
    scored.report.questions.find(
      (question) => question.question_id === answer.question_id,
    ).shortest_route,
    false,
  );
});

test("navigation issue markers are structural and de-duplicate REST pages", () => {
  const digest = fixtureDigest(context.suite);
  const body = `${NAVIGATION_EVAL_MARKER}\n${navigationMonthMarker("2026-07", digest)}\n`;
  assert.deepEqual(parseLeadingNavigationEvalMarkers(body), {
    month: "2026-07",
    fixture_digest: digest,
  });
  assert.equal(parseLeadingNavigationEvalMarkers(`prefix\n${body}`), null);
  assert.throws(
    () => parseLeadingNavigationEvalMarkers(`${NAVIGATION_EVAL_MARKER}\nbad`),
    /malformed/,
  );
  const normalized = normalizeNavigationEvalIssuePages([
    [
      {
        number: 1,
        body,
        state: "open",
        labels: [{ name: "agent-ready" }, { name: "source:audit" }],
      },
      { number: 2, pull_request: {}, body },
    ],
    [{ number: 1, body, state: "open", labels: [{ name: "source:audit" }] }],
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].marker.month, "2026-07");
});

test("untrusted public issue markers cannot suppress navigation scheduling", () => {
  const digest = fixtureDigest(context.suite);
  const body = `${NAVIGATION_EVAL_MARKER}\n${navigationMonthMarker("2026-07", digest)}\n`;
  const normalized = normalizeNavigationEvalIssuePages([
    [
      { number: 70, body, state: "closed", labels: [] },
      {
        number: 71,
        body: `${NAVIGATION_EVAL_MARKER}\nmalformed`,
        state: "open",
        labels: [{ name: "agent-ready" }],
      },
    ],
  ]);
  assert.deepEqual(
    normalized.map((issue) => issue.marker),
    [null, null],
  );
  const spec = buildNavigationEvalIssueSpec({
    month: "2026-07",
    fixtureDigest: digest,
    routingChanges: [],
  });
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-07",
      fixtureDigest: digest,
      issues: normalized,
      spec,
    }).action,
    "create",
  );
});

test("monthly issue planning is immutable and fail-closed", () => {
  const digest = fixtureDigest(context.suite);
  const spec = buildNavigationEvalIssueSpec({
    month: "2026-07",
    fixtureDigest: digest,
    routingChanges: [],
  });
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-07",
      fixtureDigest: digest,
      issues: [],
      spec,
    }).action,
    "create",
  );
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-07",
      fixtureDigest: digest,
      issues: [issueFor("2026-07", digest)],
      spec,
    }).action,
    "keep-current",
  );
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-07",
      fixtureDigest: digest,
      issues: [issueFor("2026-07", "0".repeat(64))],
      spec,
    }).action,
    "skip-scope-drift",
  );
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-08",
      fixtureDigest: digest,
      issues: [issueFor("2026-07", digest)],
      spec,
    }).action,
    "skip-prior-open",
  );
  assert.equal(
    planNavigationEvalIssueSync({
      month: "2026-07",
      fixtureDigest: digest,
      issues: [issueFor("2026-07", digest, { state: "CLOSED" })],
      spec,
    }).action,
    "skip-complete",
  );
  assert.throws(
    () =>
      planNavigationEvalIssueSync({
        month: "2026-07",
        fixtureDigest: digest,
        issues: [
          issueFor("2026-07", digest),
          issueFor("2026-07", digest, { number: 78 }),
        ],
        spec,
      }),
    /found 2 open/,
  );
});

test("generated monthly issue carries all Agent Task sections and reminders", () => {
  const spec = buildNavigationEvalIssueSpec({
    month: "2026-07",
    fixtureDigest: fixtureDigest(context.suite),
    routingChanges: ["AGENTS.md", "docs/context-standards.md"],
  });
  for (const heading of [
    "Goal",
    "Context and links",
    "Acceptance criteria",
    "Expected files or package area",
    "Verification commands",
    "Risks, non-goals, and do-not-touch",
    "Dependencies or blockers",
    "Done means",
  ]) {
    assert.match(spec.body, new RegExp(`### ${heading}`));
  }
  assert.match(spec.body, /`AGENTS.md`/);
  assert.match(spec.body, /cheapest capable model/);
  assert.ok(!spec.body.includes("@claude"));
});

test("scheduled integration is issue-only and contains no model credential or invocation", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/documentation-garden.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /node scripts\/docs-navigation-eval\.mjs --schedule-issue --json/,
  );
  assert.match(workflow, /if: github\.event_name == 'schedule'/);
  assert.doesNotMatch(
    workflow,
    /codex exec|claude|OPENAI_API_KEY|ANTHROPIC_API_KEY/i,
  );
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write/);
});

test("dry-run issue scheduling reads and plans without mutation", async () => {
  const calls = [];
  const result = await runNavigationEvalIssue(
    {
      ...options,
      repo: "owner/repo",
      date: "2026-07-21",
      dryRun: true,
    },
    context,
    {
      listIssues: async () => {
        calls.push("list");
        return [];
      },
      readBaseline: () => ({ run: { repository_base_commit: "a".repeat(40) } }),
      validateBaseline: () => ({ routing_accuracy_percent: 100 }),
      changesSinceBaseline: () => ["AGENTS.md"],
      authorizeLiveCreation: async () => calls.push("authorize"),
      ensureLabels: async () => calls.push("labels"),
      createIssue: async () => calls.push("create"),
    },
  );
  assert.equal(result.action, "create");
  assert.equal(result.mutated, false);
  assert.deepEqual(calls, ["list"]);
});

test("the committed baseline satisfies its own month without a duplicate issue", async () => {
  const calls = [];
  const result = await runNavigationEvalIssue(
    {
      ...options,
      repo: "owner/repo",
      date: "2026-07-21",
      dryRun: false,
    },
    context,
    {
      listIssues: async () => {
        calls.push("list");
        return [];
      },
      readBaseline: () => ({
        fixture_digest: fixtureDigest(context.suite),
        run: {
          executed_at: "2026-07-21T09:00:00.000Z",
          repository_base_commit: "a".repeat(40),
        },
      }),
      validateBaseline: () => ({ routing_accuracy_percent: 100 }),
      changesSinceBaseline: () => [],
    },
  );
  assert.equal(result.action, "skip-baseline-complete");
  assert.equal(result.mutated, false);
  assert.deepEqual(calls, ["list"]);
});

test("issue scheduling rejects an invalid committed baseline before discovery", async () => {
  const invalidBaseline = validResult();
  invalidBaseline.answers = [];
  let listed = false;
  await assert.rejects(
    runNavigationEvalIssue(
      {
        ...options,
        repo: "owner/repo",
        date: "2026-07-21",
        dryRun: true,
      },
      context,
      {
        readBaseline: () => invalidBaseline,
        listIssues: async () => {
          listed = true;
          return [];
        },
      },
    ),
    /committed navigation baseline is invalid/,
  );
  assert.equal(listed, false);
});

test("generated result artifacts do not create routing-change reminders", () => {
  assert.equal(
    isRoutingSensitivePath("docs/evals/documentation-navigation-baseline.json"),
    false,
  );
  assert.equal(
    isRoutingSensitivePath(
      "docs/evals/documentation-navigation-post-garden-2026-09.json",
    ),
    false,
  );
  assert.equal(
    isRoutingSensitivePath(
      "docs/evals/documentation-navigation-2026-08-post-garden.json",
    ),
    false,
  );
  for (const pathname of [
    "AGENTS.md",
    "README.md",
    "docs/evals/documentation-navigation-fixtures.json",
    "docs/evals/documentation-navigation-result.schema.json",
    "docs/evals/documentation-navigation.md",
    ".github/workflows/documentation-garden.yml",
  ]) {
    assert.equal(isRoutingSensitivePath(pathname), true, pathname);
  }
});

test("CLI parsing enforces one explicit mode", () => {
  assert.equal(parseArgs(["--prompt"]).mode, "prompt");
  assert.equal(
    parseArgs(["--prompt", "--question", "commands-pr-readiness"]).questionId,
    "commands-pr-readiness",
  );
  assert.equal(
    parseArgs(["--prompt", "--base-commit", "a".repeat(40)]).baseCommit,
    "a".repeat(40),
  );
  assert.equal(
    parseArgs([
      "--validate",
      "result.json",
      "--question",
      "commands-pr-readiness",
    ]).questionId,
    "commands-pr-readiness",
  );
  assert.throws(() => parseArgs([]), /choose one/);
  assert.throws(
    () => parseArgs(["--prompt", "--check-fixtures"]),
    /choose exactly one mode/,
  );
  assert.throws(
    () => parseArgs(["--check-fixtures", "--question", "x"]),
    /valid only with --prompt or --validate/,
  );
  assert.throws(
    () =>
      parseArgs(["--validate", "result.json", "--base-commit", "a".repeat(40)]),
    /valid only with --prompt/,
  );
  assert.throws(
    () => parseArgs(["--prompt", "--base-commit", "abc"]),
    /40-character lowercase commit/,
  );
});

test("prompt generation refuses a dirty checkout", () => {
  assert.doesNotThrow(() => assertCleanEvaluationCheckout(repoRoot, () => ""));
  assert.throws(
    () =>
      assertCleanEvaluationCheckout(
        repoRoot,
        () => " M docs/evals/documentation-navigation.md\n",
      ),
    /requires a clean checkout/,
  );
});

test("CLI checks fixtures and validates a structured result", () => {
  const check = spawnSync(
    process.execPath,
    [scriptPath, "--check-fixtures", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(check.status, 0, check.stderr);
  const checked = JSON.parse(check.stdout);
  assert.equal(checked.question_count, 18);
  assert.ok(checked.context_floor.max_question_headroom_bytes > 0);
  assert.ok(checked.context_floor.total_unique_headroom_bytes > 0);

  const temp = mkdtempSync(path.join(tmpdir(), "docs-navigation-eval-"));
  try {
    const resultPath = path.join(temp, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(validResult())}\n`);
    const validate = spawnSync(
      process.execPath,
      [scriptPath, "--validate", resultPath],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).report.passed, true);

    const targetedResult = validResult();
    const targetedQuestion = context.suite.questions[0].id;
    targetedResult.answers = targetedResult.answers.filter(
      (answer) => answer.question_id === targetedQuestion,
    );
    writeFileSync(resultPath, `${JSON.stringify(targetedResult)}\n`);
    const targetedValidate = spawnSync(
      process.execPath,
      [scriptPath, "--validate", resultPath, "--question", targetedQuestion],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(targetedValidate.status, 0, targetedValidate.stderr);
    assert.equal(JSON.parse(targetedValidate.stdout).report.question_count, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fixture digest changes with routing scope", () => {
  const changed = structuredClone(context.suite);
  changed.questions[0].question += " Updated.";
  assert.notEqual(fixtureDigest(changed), fixtureDigest(context.suite));
});
