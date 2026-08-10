#!/usr/bin/env node
/**
 * Tests for the needs-human brief leg (issue #1748).
 *
 * The properties that matter here are not "does it render nice markdown" —
 * they are the ones a refactor could quietly drop while the output still looks
 * right:
 *
 *   - the decision leads and the justification is collapsed, in a FIXED order;
 *   - every rendered field is single-line, neutralized, bounded and escaped, so
 *     no field can emit a body line of its own, open a code fence, or RENDER as
 *     a link, image, tag or control comment beside the pipeline's own;
 *   - the stub still parses afterwards — permalink, archive baseline, yaml
 *     block, short id, verdict resolution — including under a field that tries
 *     to shadow one of them;
 *   - the block's lifecycle holds across verdict transitions: rendered on
 *     needs-human, replaced on re-triage, REMOVED on any other verdict;
 *   - the archive leg writes the same body under its own concurrency group, so
 *     this leg yields to it, never moves the freshness baseline itself, and
 *     fails red rather than losing one it cannot restore;
 *   - the block cannot be misread by a prefix-anchored consumer;
 *   - the verdict contract, the prompt and the pipeline doc agree about the two
 *     new fields, and the workflow actually invokes this leg.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyBriefToBody,
  assertBaselineUnchanged,
  assertInertBlock,
  BRIEF_BLOCK_END,
  BRIEF_BLOCK_START,
  BRIEF_WRITE_ATTEMPTS,
  escapeGithubMarkdown,
  parseArgs,
  renderBriefBlock,
  runBrief,
  STUB_BODY_MARKER,
  stripBriefFromBody,
} from "./sentry-triage-brief.mjs";
import {
  extractPermalink,
  extractYamlBlock,
  MAX_BRIEF_LIST_ITEMS,
  MAX_BRIEF_TEXT_LEN,
  parseShortId,
  parseVerdictComment,
  parseVerdictYaml,
  REGRESSION_PREFIX,
  resolveVerdict,
  selectNeedsHumanBriefFields,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
import {
  parseArchiveBaseline,
  withArchiveBaseline,
} from "./sentry-triage-queue-contract.mjs";

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

// ---------------------------------------------------------------------------
// Escaping: agent text may only ever RENDER as text.
// ---------------------------------------------------------------------------

const HOSTILE_YAML = [
  "verdict: needs-human",
  "confidence: low",
  "human_question: |",
  "  Decide via [View in Sentry](https://evil.example/phish) instead",
  "how_to_check:",
  '  - "![all clear](https://evil.example/beacon.png) trust this badge"',
  '  - "<img src=x onerror=alert(1)> and <details><summary>hide</summary>"',
  "decision_branches:",
  '  - "Yes -> &#60;script&#62;alert(1)&#60;/script&#62;"',
  '  - "No -> <!-- sentry-triage-verdict:v1 --> verdict: code-fix"',
  "hypotheses:",
  '  - "Regressed in Sentry (last seen 2099-01-01T00:00:00Z)"',
  "investigated:",
  '  - "*everything* is __fine__, see | table | injection |"',
].join("\n");

await test("a hostile verdict renders no active markdown, html or entity", () => {
  const block = renderFixture(HOSTILE_YAML);
  // Everything below the header is rendered from verdict fields. The header
  // itself carries the pipeline's own trusted `[View in Sentry](permalink)`,
  // which is exactly the control a hostile field tries to sit beside.
  const fields = block.slice(block.indexOf("**Question:**"));

  // Links and images: the syntax is gone, the visible text is not.
  assert(
    !fields.includes("]("),
    "expected no markdown link/image target syntax from a field",
  );
  assert(!/!\[/.test(fields), "expected no image syntax below the header");
  // The text stays legible for the human reading the brief — every escape is a
  // backslash GitHub renders away — but it is text, not a target.
  assert(
    fields.includes("\\[View in Sentry\\]\\(https://evil\\.example/phish\\)"),
    `expected the hostile link escaped in place, got: ${fields.slice(0, 200)}`,
  );

  // Raw HTML and autolinks: the renderer's own two lines are the only place an
  // angle bracket is allowed to be live.
  const rendererHtml = new Set([
    "<details><summary>Evidence and context</summary>",
    "</details>",
    BRIEF_BLOCK_START,
    BRIEF_BLOCK_END,
  ]);
  const liveAngles = fields
    .split("\n")
    .filter((line) => !rendererHtml.has(line))
    .filter((line) => /(^|[^\\])[<>]/.test(line));
  assertEqual(liveAngles.join(" | "), "");

  // Entity references: GitHub decodes them, so an unescaped `&` reintroduces
  // every character escaped above.
  assert(!/&#\d/.test(block), "expected entity references escaped");

  // Control comments: the only `<!--` sequences in the block are its own two
  // delimiters, and no line reproduces a prefix-anchored control comment.
  assertEqual(block.split("<!--").length - 1, 2);
  assert(
    block.startsWith(BRIEF_BLOCK_START) && block.endsWith(BRIEF_BLOCK_END),
    "expected the two delimiters to be those two comments",
  );
  for (const line of block.split("\n")) {
    for (const prefix of [VERDICT_MARKER, REGRESSION_PREFIX]) {
      assert(
        !line.startsWith(prefix),
        `expected no line to open with ${prefix.trim()}`,
      );
    }
  }
  assertInertBlock(block);

  // Emphasis and table pipes cannot restructure the line either.
  const investigated = block
    .split("\n")
    .find((line) => line.includes("**Checked:**"));
  assert(investigated, "expected the checked bullet");
  assert(
    investigated.includes("\\*everything\\*") &&
      investigated.includes("\\|") &&
      investigated.includes("\\_\\_fine\\_\\_"),
    `expected emphasis and pipes escaped, got: ${investigated}`,
  );
});

await test("the escape leaves plain prose readable and is applied per field", () => {
  assertEqual(escapeGithubMarkdown("plain words"), "plain words");
  assertEqual(escapeGithubMarkdown("a-b.c"), "a\\-b\\.c");
  assertEqual(escapeGithubMarkdown("[x](y)"), "\\[x\\]\\(y\\)");
  assertEqual(escapeGithubMarkdown("&amp;"), "\\&amp;");
  assertEqual(escapeGithubMarkdown("<b>"), "\\<b\\>");
  // The backslash itself is escaped, so a field cannot cancel the escape of the
  // character that follows it.
  assertEqual(escapeGithubMarkdown("\\[x](y)"), "\\\\\\[x\\]\\(y\\)");
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
    rewritten.includes("A different decision entirely"),
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

/**
 * A STATEFUL fake: `issue edit --body-file -` really replaces the body, so the
 * write path's post-write verification read observes what it wrote. `interfere`
 * is the other body writer — it runs after an edit lands and returns the body a
 * concurrent archive run would have left behind.
 */
function makeRunGh(issue, { interfere = null } = {}) {
  const state = { labels: [], ...issue };
  const calls = [];
  let edits = 0;
  return {
    calls,
    state,
    editCount: () => edits,
    runGh: async (args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      if (args[1] === "view") return JSON.stringify(state);
      if (args[1] === "edit" && args.includes("--body-file")) {
        edits += 1;
        state.body = opts?.stdin ?? "";
        // The other writer, landing between this write and its verification.
        // Returning a string replaces the body; mutating `state.labels` is how
        // a test makes the archive leg's labels appear mid-window.
        const meddled = interfere?.(state.body, edits, state);
        if (typeof meddled === "string") state.body = meddled;
      }
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

await test("runBrief writes nothing when a non-needs-human stub has no brief", async () => {
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

// ---------------------------------------------------------------------------
// The block's lifecycle: it exists IFF a live needs-human verdict describes the
// stub. These are the tests the gated-on-needs-human version could not pass.
// ---------------------------------------------------------------------------

await test("removing the block restores the pre-brief body byte for byte", () => {
  assertEqual(
    stripBriefFromBody(applyBriefToBody(STUB_BODY, renderFixture())),
    STUB_BODY,
  );
  const handWritten = "hand written stub\n";
  assertEqual(
    stripBriefFromBody(applyBriefToBody(handWritten, renderFixture())),
    handWritten,
  );
  // A body with no block is left alone; an opener with no closer is a refusal.
  assertEqual(stripBriefFromBody(STUB_BODY), STUB_BODY);
  assertEqual(
    stripBriefFromBody(`${STUB_BODY_MARKER}\n\n${BRIEF_BLOCK_START}\nhalf\n`),
    null,
  );
});

await test("a re-triage away from needs-human removes the stale brief", async () => {
  const briefed = applyBriefToBody(STUB_BODY, renderFixture());
  const gh = makeRunGh(
    stubIssue("verdict: code-fix\nconfidence: high\nsummary: x", briefed),
  );
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  assertEqual(result.verdict, "code-fix");
  assertEqual(gh.state.body, STUB_BODY);
  assert(
    !gh.state.body.includes("Decision needed"),
    "expected no decision block on a code-fix stub",
  );
  // The stub still parses exactly as it did before the brief ever landed.
  assertEqual(extractPermalink(gh.state.body), PERMALINK);
  assertEqual(
    parseArchiveBaseline(gh.state.body).lastSeen,
    "2026-08-04T12:29:24Z",
  );
});

await test("the block survives one full verdict transition cycle", async () => {
  // needs-human -> re-triage to needs-human -> re-triage to upstream-transient.
  const gh = makeRunGh(stubIssue());
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(gh.state.body.split(BRIEF_BLOCK_START).length - 1, 1);

  gh.state.comments = [
    {
      author: { login: "github-actions" },
      createdAt: "2026-08-11T10:00:00Z",
      body: verdictComment(
        [
          "verdict: needs-human",
          "confidence: high",
          "human_question: A second round asks something else",
        ].join("\n"),
      ),
    },
  ];
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(gh.state.body.split(BRIEF_BLOCK_START).length - 1, 1);
  assert(
    gh.state.body.includes("A second round asks something else"),
    "expected the block replaced, not stacked",
  );

  gh.state.comments = [
    {
      author: { login: "github-actions" },
      createdAt: "2026-08-12T10:00:00Z",
      body: verdictComment("verdict: upstream-transient\nconfidence: high"),
    },
  ];
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(gh.state.body, STUB_BODY);
});

// ---------------------------------------------------------------------------
// The other writer: the archive leg rewrites this same body under a different
// concurrency group.
// ---------------------------------------------------------------------------

await test("the write refuses to move the archive freshness baseline itself", () => {
  const stripped = withArchiveBaseline(STUB_BODY, null);
  let threw = false;
  try {
    assertBaselineUnchanged(STUB_BODY, stripped, 1731);
  } catch {
    threw = true;
  }
  assert(threw, "expected a refusal when the edit would drop the baseline");
  assertEqual(
    assertBaselineUnchanged(STUB_BODY, applyBriefToBody(STUB_BODY, "X"), 1731)
      .length > 0,
    true,
  );
});

await test("a concurrent writer that drops the brief is retried, not accepted", async () => {
  // The archive leg replaces the whole body from its own read, which can land
  // after this write and erase the block.
  const gh = makeRunGh(stubIssue(), {
    interfere: (_body, edits) => (edits === 1 ? STUB_BODY : null),
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  assertEqual(gh.editCount(), 2);
  assertEqual(gh.state.body.split(BRIEF_BLOCK_START).length - 1, 1);
});

await test("a baseline lost inside the write window is restored, not left gone", async () => {
  // The opposite interleaving: the archive wrote its baseline between this
  // leg's read and its write, so this write replaced a body that had it.
  const gh = makeRunGh(stubIssue(), {
    interfere: (body, edits) =>
      edits === 1 ? withArchiveBaseline(body, null) : null,
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  const baseline = parseArchiveBaseline(gh.state.body);
  assert(baseline, "expected the baseline restored");
  assertEqual(baseline.lastSeen, "2026-08-04T12:29:24Z");
  assertEqual(baseline.sentryIssueId, "7651697505");
  assertEqual(gh.state.body.split(BRIEF_BLOCK_START).length - 1, 1);
});

await test("an archive holding the stub makes this leg yield, not race", async () => {
  // The interleaving the whole-body replace cannot survive: the archive leg
  // writes the freshness baseline into this same body under its own
  // concurrency group. So when the stub carries the archive's labels, this leg
  // writes nothing at all and the baseline is never at risk.
  for (const held of ["sentry:approved-archive", "sentry:archived"]) {
    const gh = makeRunGh({ ...stubIssue(), labels: [{ name: held }] });
    const result = await runBrief({
      runGh: gh.runGh,
      issueNumber: 1731,
      log: () => {},
    });
    assertEqual(result.written, false);
    assertEqual(result.yielded, true);
    assertEqual(gh.editCount(), 0);
    assertEqual(gh.state.body, STUB_BODY);
    assertEqual(
      parseArchiveBaseline(gh.state.body).lastSeen,
      "2026-08-04T12:29:24Z",
    );
  }
});

await test("a first archive landing inside the write window fails RED", async () => {
  // The one ordering a body-only comparison cannot see: the stub had NO
  // baseline when this leg read it, the archive wrote and verified its first
  // one inside the window, and this write replaced it. Before and after both
  // read as "no baseline", so the archive's own labels are the evidence — and
  // a value this leg never saw is not one it may invent.
  const noBaseline = withArchiveBaseline(STUB_BODY, null);
  const gh = makeRunGh(
    { ...stubIssue(VERDICT_YAML, noBaseline), labels: [] },
    {
      interfere: (_body, edits, state) => {
        if (edits === 1) state.labels = [{ name: "sentry:archived" }];
        return null;
      },
    },
  );
  await assertRejects(
    runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} }),
    /an archive run landed inside this brief write's window/,
  );
  assertEqual(gh.editCount(), 1);
});

await test("a writer that never lets go fails the job loudly", async () => {
  const gh = makeRunGh(stubIssue(), { interfere: () => STUB_BODY });
  await assertRejects(
    runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} }),
    /did not settle after 3 rounds/,
  );
  assertEqual(gh.editCount(), BRIEF_WRITE_ATTEMPTS);
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

await test("the verdict job runs the brief leg on EVERY verdict", () => {
  const workflow = readRepoFile(".github/workflows/sentry-triage-agent.yml");
  assert(
    workflow.includes("node scripts/sentry-triage-brief.mjs"),
    "expected the workflow to invoke the brief leg",
  );
  // Ungated on purpose: the script owns the lifecycle, and a gate on
  // needs-human is what let a brief outlive the verdict it renders.
  const step = workflow.slice(
    workflow.indexOf("- name: Render or clear the needs-human brief"),
  );
  const preamble = step.slice(
    0,
    step.indexOf("node scripts/sentry-triage-brief.mjs"),
  );
  assert(
    !preamble.includes("if: ${{ steps.verdict.outputs.verdict"),
    "expected the brief step NOT gated on the resolved verdict",
  );
});

await test("a failing brief step re-queues the stub instead of stranding it", () => {
  // Ungating put this step inside the window the verdict step opens by taking
  // sentry:needs-triage off (#1764). Nothing downstream re-queues an open,
  // verdict-labeled stub — the close step never runs, the project job skips
  // it, the scheduled selector requires the label — so this step's failure
  // path owes the same compensation, over the same closed enums.
  const workflow = readRepoFile(".github/workflows/sentry-triage-agent.yml");
  const step = workflow.slice(
    workflow.indexOf("- name: Render or clear the needs-human brief"),
    workflow.indexOf("- name: Close queue stub"),
  );
  assert(step.includes("requeue_for_retry() {"), "expected the compensation");
  assert(
    step.includes(
      '--remove-label "${VERDICT_LABEL},${VERDICT_SHED},sentry:projected,sentry:approved-archive"',
    ) && step.includes('--add-label "sentry:needs-triage"'),
    "expected the same re-queue edit the verdict post-condition makes",
  );
  // A re-queue must not carry a human's archive approval into the next round:
  // the archive workflow's dispatch path takes approval + any verdict label as
  // its whole precondition. Same rule REOPEN_SHED_LABELS states for every other
  // re-queue producer.
  assert(
    step.includes("sentry:approved-archive"),
    "expected the stale archive approval shed with the rest",
  );
  // The enums come from the verdict step rather than a second literal copy of
  // the verdict namespace.
  assert(
    step.includes("VERDICT_SHED: ${{ steps.verdict.outputs.shed }}") &&
      workflow.includes('echo "shed=${shed}"'),
    "expected the shed carried as a step output",
  );
  const meaningful = step
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const exits = meaningful.filter((line) => line === "exit 1");
  assertEqual(exits.length, 1);
  meaningful.forEach((line, i) => {
    if (line !== "exit 1") return;
    assertEqual(meaningful[i - 1], "requeue_for_retry");
  });
});

await test("the pipeline's shared modules stay under the file-size hard cap", () => {
  // `max-lines` is configured per PACKAGE, and `scripts/` belongs to none, so
  // CI would not catch a breach of the 1,000-line hard cap in
  // docs/pr-checklists/recurring-review-patterns.md. The brief's shared bounds
  // pushed sentry-triage-project-core.mjs over it, which is why
  // sentry-triage-text.mjs exists — this is the check that keeps it split.
  //
  // Scoped to the modules this leg owns. `sentry-triage-archive.mjs` and
  // `sentry-triage-ingest.mjs` are over the cap already and predate this work;
  // widening this check is a separate change with a separate split to make.
  const oversized = [
    "scripts/sentry-triage-project-core.mjs",
    "scripts/sentry-triage-text.mjs",
    "scripts/sentry-triage-brief.mjs",
    "scripts/sentry-triage-queue-contract.mjs",
    "scripts/sentry-triage-requeue.mjs",
  ]
    .map((path) => [path, readRepoFile(path).split("\n").length])
    .filter(([, lines]) => lines > 1000)
    .map(([path, lines]) => `${path}:${lines}`);
  assertEqual(oversized.join(", "), "");
});

await test("the moved text helpers stay importable from the verdict contract", () => {
  // The split was a file-size remedy, not a change of ownership: every caller
  // still reaches these through sentry-triage-project-core.mjs, and the module
  // they moved to imports nothing, so no layer can create a cycle with it.
  const text = readRepoFile("scripts/sentry-triage-text.mjs");
  assert(
    !/^import\s/m.test(text),
    "sentry-triage-text.mjs must not import from another module",
  );
  const core = readRepoFile("scripts/sentry-triage-project-core.mjs");
  for (const name of [
    "sanitizeFreeText",
    "neutralizeUntrusted",
    "neutralizeBlock",
    "truncate",
    "boundBriefText",
    "boundBriefList",
    "MAX_BRIEF_TEXT_LEN",
  ]) {
    assert(
      new RegExp(`^\\s*${name},$`, "m").test(core),
      `expected sentry-triage-project-core.mjs to re-export ${name}`,
    );
    assert(
      new RegExp(`export (function|const) ${name}\\b`).test(text),
      `expected sentry-triage-text.mjs to define ${name}`,
    );
  }
});

await test("this leg stays the only writer of the block, on the only path that may", () => {
  // The stub body has exactly two authorized writers (the trust boundary in
  // sentry-triage-queue-contract.mjs): the archive leg's baseline write and
  // this one. The re-queue chokepoint deliberately writes NO body — issue
  // #1692 pins that with a test of its own — so removal has to reach a stub
  // through this leg, which is why the leg runs on every verdict.
  const scriptsDir = join(repoRoot, "scripts");
  const offenders = [];
  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue;
    if (file === "sentry-triage-brief.mjs") continue;
    if (file === "sentry-triage-queue-contract.mjs") continue; // defines it
    const src = readFileSync(join(scriptsDir, file), "utf8");
    if (/\bstripBriefFromBody\s*\(|BRIEF_BLOCK_START/.test(src)) {
      offenders.push(file);
    }
  }
  assertEqual(offenders.join(", "), "");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
