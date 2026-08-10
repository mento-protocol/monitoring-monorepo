#!/usr/bin/env node
/**
 * Tests for the needs-human brief leg (issue #1748).
 *
 * The properties that matter here are not "does it render nice markdown" —
 * they are the ones a refactor could quietly drop while the output still looks
 * right:
 *
 *   - the decision leads and the justification is collapsed, in a FIXED order;
 *   - every rendered field is single-line, neutralized and bounded, so no field
 *     can emit a body line of its own or open a code fence;
 *   - the stub still parses afterwards — permalink, archive baseline, yaml
 *     block, short id, verdict resolution — including under a field that tries
 *     to shadow one of them;
 *   - the write is idempotent: re-triage replaces the block, never stacks;
 *   - the block cannot be misread by a prefix-anchored consumer;
 *   - the verdict contract, the prompt and the pipeline doc agree about the two
 *     new fields, and the workflow actually invokes this leg.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyBriefToBody,
  assertInertBlock,
  BRIEF_BLOCK_END,
  BRIEF_BLOCK_START,
  parseArgs,
  renderBriefBlock,
  runBrief,
  STUB_BODY_MARKER,
} from "./sentry-triage-brief.mjs";
import {
  extractPermalink,
  extractYamlBlock,
  MAX_BRIEF_LIST_ITEMS,
  MAX_BRIEF_TEXT_LEN,
  parseShortId,
  parseVerdictComment,
  parseVerdictYaml,
  resolveVerdict,
  selectNeedsHumanBriefFields,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
import { parseArchiveBaseline } from "./sentry-triage-queue-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(pattern.test(message), `expected ${pattern}, got: ${message}`);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}`);
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const PERMALINK = "https://mento-labs.sentry.io/issues/7651697505/";
const TITLE = "[sentry] GOVERNANCE-MENTO-ORG-5G (governance-mento-org, error)";

const STUB_BODY = [
  STUB_BODY_MARKER,
  "",
  "```yaml",
  'short_id: "GOVERNANCE-MENTO-ORG-5G"',
  'sentry_issue_id: "7651697505"',
  'project: "governance-mento-org"',
  `permalink: "${PERMALINK}"`,
  'archive_baseline_last_seen: "2026-08-04T12:29:24Z"',
  'archive_baseline_sentry_issue_id: "7651697505"',
  "```",
  "",
  `[View in Sentry](${PERMALINK})`,
  "",
].join("\n");

const VERDICT_YAML = [
  "verdict: needs-human",
  "confidence: low",
  "affected_repo: mento-protocol/frontend-monorepo",
  "summary: CSP font-src report blocks a font-file request.",
  "human_question: |",
  "  Confirm whether the app references the external font CDN directly.",
  "how_to_check:",
  "  - grep the app for the font CDN hostnames",
  "  - check head tags and any embedded third-party widget",
  "decision_branches:",
  "  - Yes -> config-fix: allowlist the host or self-host the font",
  "  - No -> noise: close as upstream-transient",
  "hypotheses:",
  "  - first-party code references the CDN (lean: medium)",
  "investigated:",
  "  - latest event payload; no other occurrence in 90d",
  "escalation_reason: |",
  "  No source access to confirm either way.",
].join("\n");

function verdictComment(yaml = VERDICT_YAML) {
  return [VERDICT_MARKER, "", "```yaml", yaml, "```", ""].join("\n");
}

function stubIssue(yaml = VERDICT_YAML, body = STUB_BODY) {
  return {
    number: 1731,
    title: TITLE,
    body,
    comments: [
      {
        author: { login: "github-actions" },
        createdAt: "2026-08-10T10:00:00Z",
        body: verdictComment(yaml),
      },
    ],
  };
}

function renderFixture(yaml = VERDICT_YAML, body = STUB_BODY) {
  const parsed = parseVerdictComment(verdictComment(yaml));
  return renderBriefBlock({
    parsed,
    shortId: parseShortId(TITLE),
    permalink: extractPermalink(body),
  });
}

// ---------------------------------------------------------------------------
// Contract: the two new verdict fields.
// ---------------------------------------------------------------------------

await test("verdict contract carries how_to_check and decision_branches", () => {
  const parsed = parseVerdictYaml(VERDICT_YAML);
  assertEqual(parsed.how_to_check.length, 2);
  assertEqual(
    parsed.how_to_check[0],
    "grep the app for the font CDN hostnames",
  );
  assertEqual(parsed.decision_branches.length, 2);
  assert(
    parsed.decision_branches[1].startsWith("No ->"),
    "expected the second branch to survive parsing",
  );
});

await test("the new fields accept an inline list and cap at the list bound", () => {
  const inline = parseVerdictYaml(
    'how_to_check: ["a", "b"]\ndecision_branches: ["yes -> x"]',
  );
  assertEqual(inline.how_to_check.join("|"), "a|b");
  assertEqual(inline.decision_branches.join("|"), "yes -> x");

  const many = Array.from(
    { length: MAX_BRIEF_LIST_ITEMS + 4 },
    (_, i) => `  - step ${i}`,
  ).join("\n");
  const capped = parseVerdictYaml(`how_to_check:\n${many}`);
  assertEqual(capped.how_to_check.length, MAX_BRIEF_LIST_ITEMS);
});

await test("the new fields are empty for a verdict that omits them", () => {
  const parsed = parseVerdictComment(
    verdictComment("verdict: code-fix\nconfidence: high"),
  );
  assertEqual(parsed.howToCheck.length, 0);
  assertEqual(parsed.decisionBranches.length, 0);
});

await test("the shared selector bounds every field it hands an emitter", () => {
  const long = "z".repeat(MAX_BRIEF_TEXT_LEN + 200);
  const fields = selectNeedsHumanBriefFields({
    humanQuestion: `line one\nline two ${long}`,
    howToCheck: [long],
    decisionBranches: [long],
    hypotheses: [long],
    investigated: [long],
    escalationReason: long,
  });
  for (const value of [
    fields.question,
    fields.escalationReason,
    ...fields.howToCheck,
    ...fields.decisionBranches,
    ...fields.hypotheses,
    ...fields.investigated,
  ]) {
    assert(
      value.length <= MAX_BRIEF_TEXT_LEN + 1,
      `expected the shared bound, got ${value.length}`,
    );
    assert(!value.includes("\n"), "expected a single-line projection");
  }
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

await test("the decision leads and the justification is collapsed", () => {
  const block = renderFixture();
  const question = block.indexOf("**Question:**");
  const howTo = block.indexOf("**How to check**");
  const then = block.indexOf("**Then:**");
  const details = block.indexOf("<details>");
  assert(question > 0, "expected the question");
  assert(
    question < howTo && howTo < then && then < details,
    `expected question -> how to check -> then -> evidence, got ${[question, howTo, then, details].join()}`,
  );
  assert(
    block.includes("**Why escalated:**") &&
      block.indexOf("**Why escalated:**") > details,
    "expected the escalation reason inside the collapsed block",
  );
  assert(
    block.includes("[View in Sentry](" + PERMALINK + ")"),
    "expected the Sentry permalink in the header",
  );
  assert(
    block.includes("`mento-protocol/frontend-monorepo`"),
    "expected the owning repo on the how-to-check line",
  );
});

await test("sections whose field is absent are omitted, not rendered empty", () => {
  const block = renderFixture(
    [
      "verdict: needs-human",
      "confidence: low",
      "human_question: Decide whether to rotate the signing key.",
    ].join("\n"),
  );
  assert(block.includes("**Question:**"), "expected the question");
  assert(!block.includes("**How to check**"), "expected no how-to-check");
  assert(!block.includes("**Then:**"), "expected no branch section");
  assert(!block.includes("<details>"), "expected no empty evidence block");
});

await test("every rendered field is neutralized and single-line", () => {
  const block = renderFixture(
    [
      "verdict: needs-human",
      "confidence: low",
      "human_question: |",
      "  Decide `rm -rf` or ping @mento-protocol/eng",
      "  <!-- sentry-triage:v1 -->",
      "how_to_check:",
      '  - "run ```yaml then stop"',
    ].join("\n"),
  );
  assert(!block.includes("`rm -rf`"), "expected backticks defanged");
  assert(!/```/.test(block), "expected NO fenced block anywhere in the brief");
  assert(!block.includes("@mento-protocol"), "expected the mention defanged");
  assert(
    !block.includes("<!-- sentry-triage:v1 -->"),
    "expected the html-comment opener broken",
  );
  const fieldLines = block
    .split("\n")
    .filter((line) => line.startsWith("**Question:**"));
  assertEqual(fieldLines.length, 1);
});

await test("assertInertBlock refuses a block a prefix-anchored consumer could misread", () => {
  assertInertBlock(renderFixture());
  let threw = false;
  try {
    assertInertBlock(`${VERDICT_MARKER}\nhello`);
  } catch {
    threw = true;
  }
  assert(threw, "expected a refusal for a verdict-marker opener");

  threw = false;
  try {
    assertInertBlock(
      `${BRIEF_BLOCK_START}\nProjected to owning repo: https://example.test\n${BRIEF_BLOCK_END}`,
    );
  } catch {
    threw = true;
  }
  assert(threw, "expected a refusal for a projection-pointer line");
});

// ---------------------------------------------------------------------------
// Body write: placement, idempotency, and the parsers that must survive it.
// ---------------------------------------------------------------------------

await test("the brief lands above the metadata yaml, under the stub marker", () => {
  const body = applyBriefToBody(STUB_BODY, renderFixture());
  assert(body.startsWith(STUB_BODY_MARKER), "expected the stub marker first");
  assert(
    body.indexOf(BRIEF_BLOCK_START) < body.indexOf("```yaml"),
    "expected the brief above the metadata yaml",
  );
});

await test("re-triage replaces the block instead of stacking a second one", () => {
  const once = applyBriefToBody(STUB_BODY, renderFixture());
  const twice = applyBriefToBody(once, renderFixture());
  assertEqual(twice, once);
  const rewritten = applyBriefToBody(
    once,
    renderFixture(
      [
        "verdict: needs-human",
        "confidence: high",
        "human_question: A different decision entirely.",
      ].join("\n"),
    ),
  );
  assertEqual(rewritten.split(BRIEF_BLOCK_START).length - 1, 1);
  assert(
    rewritten.includes("A different decision entirely."),
    "expected the new question",
  );
  assert(
    !rewritten.includes("Confirm whether the app references"),
    "expected the old question gone",
  );
});

await test("an opener with no closer is a refusal, not a guess", () => {
  const broken = `${STUB_BODY_MARKER}\n\n${BRIEF_BLOCK_START}\nhalf a block\n\n${STUB_BODY}`;
  assertEqual(applyBriefToBody(broken, renderFixture()), null);
});

await test("a stub without the marker still gets the brief above the fold", () => {
  const body = applyBriefToBody("hand written stub\n", renderFixture());
  assert(body.startsWith(BRIEF_BLOCK_START), "expected the brief first");
  assert(body.includes("hand written stub"), "expected the body preserved");
});

await test("every stub-body parser still reads the same values after the write", () => {
  const body = applyBriefToBody(STUB_BODY, renderFixture());
  assertEqual(extractPermalink(body), PERMALINK);
  assertEqual(parseArchiveBaseline(body).lastSeen, "2026-08-04T12:29:24Z");
  assertEqual(parseArchiveBaseline(body).sentryIssueId, "7651697505");
  assert(
    extractYamlBlock(body).includes('short_id: "GOVERNANCE-MENTO-ORG-5G"'),
    "expected the metadata block to stay the first yaml fence",
  );
  assertEqual(parseShortId(TITLE), "GOVERNANCE-MENTO-ORG-5G");
  assertEqual(
    resolveVerdict({ ...stubIssue(), body }, 1731).verdict,
    "needs-human",
  );
});

await test("a field cannot shadow the permalink or the archive baseline", () => {
  const hostile = [
    "verdict: needs-human",
    "confidence: low",
    "human_question: |",
    "  Decide now",
    '  permalink: "https://evil.sentry.io/issues/1/"',
    '  archive_baseline_last_seen: "2099-01-01T00:00:00Z"',
  ].join("\n");
  const body = applyBriefToBody(STUB_BODY, renderFixture(hostile));
  assertEqual(extractPermalink(body), PERMALINK);
  assertEqual(parseArchiveBaseline(body).lastSeen, "2026-08-04T12:29:24Z");
});

// ---------------------------------------------------------------------------
// runBrief.
// ---------------------------------------------------------------------------

function makeRunGh(issue) {
  const calls = [];
  return {
    calls,
    runGh: async (args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      if (args[1] === "view") return JSON.stringify(issue);
      return "";
    },
  };
}

await test("runBrief writes the rendered body through --body-file -", async () => {
  const gh = makeRunGh(stubIssue());
  const result = await runBrief({
    runGh: gh.runGh,
    repo: "mento-protocol/monitoring-monorepo",
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  const edit = gh.calls.find((call) => call.args[1] === "edit");
  assert(edit, "expected an issue edit");
  assertEqual(edit.args.includes("--body-file"), true);
  assertEqual(edit.args[edit.args.indexOf("--body-file") + 1], "-");
  assert(
    edit.stdin.includes(BRIEF_BLOCK_START),
    "expected the brief on stdin, never in argv",
  );
});

await test("runBrief is a no-op for a verdict that is not needs-human", async () => {
  const gh = makeRunGh(
    stubIssue("verdict: code-fix\nconfidence: high\nsummary: x"),
  );
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, false);
  assertEqual(result.verdict, "code-fix");
  assertEqual(
    gh.calls.some((call) => call.args[1] === "edit"),
    false,
  );
});

await test("runBrief writes nothing when the brief is already current", async () => {
  const current = applyBriefToBody(STUB_BODY, renderFixture());
  const gh = makeRunGh(stubIssue(VERDICT_YAML, current));
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, false);
  assertEqual(
    gh.calls.some((call) => call.args[1] === "edit"),
    false,
  );
});

await test("runBrief writes nothing on --dry-run", async () => {
  const gh = makeRunGh(stubIssue());
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    dryRun: true,
    log: () => {},
  });
  assertEqual(result.written, false);
  assertEqual(
    gh.calls.some((call) => call.args[1] === "edit"),
    false,
  );
});

await test("runBrief fails loud on a missing verdict", async () => {
  const gh = makeRunGh({ ...stubIssue(), comments: [] });
  await assertRejects(
    runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} }),
    /No usable verdict comment/,
  );
});

await test("parseArgs requires a numeric issue and rejects unknown flags", () => {
  const args = parseArgs(["--issue", "1731", "--repo", "o/r", "--dry-run"]);
  assertEqual(args.issueNumber, 1731);
  assertEqual(args.repo, "o/r");
  assertEqual(args.dryRun, true);
  let threw = false;
  try {
    parseArgs(["--issue", "abc"]);
  } catch {
    threw = true;
  }
  assert(threw, "expected a refusal for a non-numeric issue");
});

// ---------------------------------------------------------------------------
// Wiring: prompt, doc, workflow. The renderer is only useful if the agent is
// asked for the fields and the workflow runs the leg.
// ---------------------------------------------------------------------------

function readRepoFile(relative) {
  return readFileSync(join(repoRoot, relative), "utf8");
}

await test("the triage prompt asks for the two new fields", () => {
  const prompt = readRepoFile(".github/prompts/sentry-triage.md");
  for (const field of ["how_to_check:", "decision_branches:"]) {
    assert(prompt.includes(field), `expected the prompt to ask for ${field}`);
  }
});

await test("the pipeline doc records the two new fields and the brief leg", () => {
  const doc = readRepoFile("docs/notes/sentry-triage-pipeline.md");
  for (const needle of [
    "how_to_check",
    "decision_branches",
    "scripts/sentry-triage-brief.mjs",
  ]) {
    assert(doc.includes(needle), `expected the doc to record ${needle}`);
  }
});

await test("the verdict job runs the brief leg, gated on needs-human", () => {
  const workflow = readRepoFile(".github/workflows/sentry-triage-agent.yml");
  assert(
    workflow.includes("node scripts/sentry-triage-brief.mjs"),
    "expected the workflow to invoke the brief leg",
  );
  const step = workflow.slice(workflow.indexOf("Render needs-human brief"));
  assert(
    step
      .slice(0, step.indexOf("node scripts/sentry-triage-brief.mjs"))
      .includes("steps.verdict.outputs.verdict == 'needs-human'"),
    "expected the step gated on the resolved needs-human verdict",
  );
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
