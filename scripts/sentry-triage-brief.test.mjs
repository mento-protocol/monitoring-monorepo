#!/usr/bin/env node
/**
 * Tests for the needs-human brief leg (issue #1748), a dedicated updated-in-place
 * COMMENT on the queue stub (redesigned from a stub-body render in PR #1769).
 *
 * The properties that matter here are not "does it render nice markdown" —
 * they are the ones a refactor could quietly drop while the output still looks
 * right:
 *
 *   - the decision leads and the justification is collapsed, in a FIXED order;
 *   - every rendered field is single-line, neutralized, bounded and escaped, so
 *     no field can emit a line of its own, open a code fence, or RENDER as a
 *     link, image, tag or control comment beside the pipeline's own;
 *   - the comment's lifecycle holds across verdict transitions: created on
 *     needs-human, updated in place on re-triage to needs-human, DELETED on any
 *     other verdict — regardless of any label the stub carries;
 *   - the leg NEVER writes the stub body, so it cannot drop the archive
 *     freshness baseline in any interleaving, including the archive's unlabeled
 *     settlement window (finding 2 of the PR #1769 review);
 *   - a stub re-triaged away from needs-human while still carrying a stale
 *     `sentry:approved-archive` has its brief removed, not left for a later
 *     close to bury (finding 1 of the PR #1769 review);
 *   - the comment cannot be misread by a prefix-anchored consumer;
 *   - the verdict contract, the prompt and the pipeline doc agree about the two
 *     new fields, and the workflow actually invokes this leg.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInertBlock,
  BRIEF_COMMENT_MARKER,
  clearBriefComments,
  escapeGithubMarkdown,
  findBriefComments,
  parseArgs,
  renderBriefComment,
  runBrief,
} from "./sentry-triage-brief.mjs";
import {
  extractPermalink,
  MAX_BRIEF_LIST_ITEMS,
  MAX_BRIEF_TEXT_LEN,
  parseShortId,
  parseVerdictComment,
  parseVerdictYaml,
  REGRESSION_PREFIX,
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
  "<!-- sentry-triage:v1 -->",
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

function verdictCommentObject(
  yaml = VERDICT_YAML,
  createdAt = "2026-08-10T10:00:00Z",
) {
  return {
    author: { login: "github-actions" },
    createdAt,
    body: verdictComment(yaml),
  };
}

function stubIssue(yaml = VERDICT_YAML, body = STUB_BODY) {
  return {
    number: 1731,
    title: TITLE,
    body,
    comments: [verdictCommentObject(yaml)],
  };
}

/** A brief comment as `gh issue view --json comments` renders one: trusted
 * author, and a `url` whose `#issuecomment-<n>` tail is the numeric REST id the
 * edit/delete endpoints key on. */
function briefCommentObject(
  body,
  id = 4242,
  createdAt = "2026-08-10T11:00:00Z",
) {
  return {
    author: { login: "github-actions" },
    createdAt,
    body,
    url: `https://github.com/mento-protocol/monitoring-monorepo/issues/1731#issuecomment-${id}`,
  };
}

function renderFixture(yaml = VERDICT_YAML, body = STUB_BODY) {
  const parsed = parseVerdictComment(verdictComment(yaml));
  return renderBriefComment({
    parsed,
    shortId: parseShortId(TITLE),
    permalink: extractPermalink(body),
  });
}

/**
 * A STATEFUL fake `gh`. `issue view` returns the live state; `issue comment
 * --body-file -` appends a trusted-author comment carrying a fresh
 * `#issuecomment-<n>` url; `api -X PATCH .../comments/<id>` edits that comment
 * in place; `api -X DELETE .../comments/<id>` removes it. The stub BODY is never
 * a write target — that is the invariant these tests exist to hold.
 */
function makeRunGh(issue, { nextCommentId = 9000 } = {}) {
  const state = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    // `state` + `labels` feed the write-side terminal guard's fresh read
    // (`issue view --json state,labels`); an OPEN, unarchived stub is the normal
    // case, so tests that don't say otherwise write as before.
    state: issue.state ?? "OPEN",
    labels: issue.labels ?? [],
    comments: (issue.comments ?? []).map((c) => ({ ...c })),
  };
  const calls = [];
  let idSeq = nextCommentId;
  const idOf = (path) => path.split("/").pop();
  const matches = (comment, id) =>
    String(comment.url ?? "").endsWith(`#issuecomment-${id}`);
  return {
    calls,
    state,
    runGh: async (args, opts) => {
      calls.push({ args, stdin: opts?.stdin });
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify(state);
      }
      if (args[0] === "issue" && args[1] === "comment") {
        idSeq += 1;
        state.comments.push({
          author: { login: "github-actions" },
          createdAt: "2026-08-10T12:00:00Z",
          body: opts?.stdin ?? "",
          url: `https://github.com/mento-protocol/monitoring-monorepo/issues/${state.number}#issuecomment-${idSeq}`,
        });
        return "";
      }
      if (args[0] === "api" && args.includes("PATCH")) {
        const id = idOf(args[args.indexOf("PATCH") + 1]);
        const body = JSON.parse(opts?.stdin ?? "{}").body ?? "";
        const target = state.comments.find((c) => matches(c, id));
        if (target) target.body = body;
        return "";
      }
      if (args[0] === "api" && args.includes("DELETE")) {
        const id = idOf(args[args.indexOf("DELETE") + 1]);
        state.comments = state.comments.filter((c) => !matches(c, id));
        return "";
      }
      return "";
    },
  };
}

const wroteBody = (gh) =>
  gh.calls.some((c) => c.args[0] === "issue" && c.args[1] === "edit");
const created = (gh) =>
  gh.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "comment");
const patched = (gh) =>
  gh.calls.filter((c) => c.args[0] === "api" && c.args.includes("PATCH"));
const deleted = (gh) =>
  gh.calls.filter((c) => c.args[0] === "api" && c.args.includes("DELETE"));

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

await test("a comment on the key line does not swallow the dash items (#1769 round 5)", () => {
  // An agent copying a `how_to_check: # note` example verbatim must still get
  // the indented dash items, not the sample comment as the sole item — or the
  // public brief shows the doc's placeholder text instead of the real content.
  const parsed = parseVerdictYaml(
    [
      "how_to_check: # the concrete steps that answer it",
      "  - grep the app for the font CDN hostnames",
      "  - check head tags",
      "decision_branches: # what each answer leads to",
      "  - Yes -> config-fix",
      "hypotheses: # candidate root causes",
      "  - first-party code references the CDN",
      "investigated: # what was already checked",
      "  - latest event payload",
    ].join("\n"),
  );
  assertEqual(
    parsed.how_to_check.join("|"),
    "grep the app for the font CDN hostnames|check head tags",
  );
  assert(
    !parsed.how_to_check.some((item) => item.includes("#")),
    "the key-line comment must not appear as an item",
  );
  assertEqual(parsed.decision_branches.join("|"), "Yes -> config-fix");
  assertEqual(
    parsed.hypotheses.join("|"),
    "first-party code references the CDN",
  );
  assertEqual(parsed.investigated.join("|"), "latest event payload");
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
  assert(block.startsWith(BRIEF_COMMENT_MARKER), "expected the marker first");
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
  assert(
    fields.includes("\\[View in Sentry\\]\\(https://evil\\.example/phish\\)"),
    `expected the hostile link escaped in place, got: ${fields.slice(0, 200)}`,
  );

  // Raw HTML and autolinks: the renderer's own lines are the only place an
  // angle bracket is allowed to be live.
  const rendererHtml = new Set([
    "<details><summary>Evidence and context</summary>",
    "</details>",
    BRIEF_COMMENT_MARKER,
  ]);
  const liveAngles = fields
    .split("\n")
    .filter((line) => !rendererHtml.has(line))
    .filter((line) => /(^|[^\\])[<>]/.test(line));
  assertEqual(liveAngles.join(" | "), "");

  // Entity references: GitHub decodes them, so an unescaped `&` reintroduces
  // every character escaped above.
  assert(!/&#\d/.test(block), "expected entity references escaped");

  // Control comments: the only `<!--` sequence in the comment is its own marker.
  assertEqual(block.split("<!--").length - 1, 1);
  assert(
    block.startsWith(BRIEF_COMMENT_MARKER),
    "expected the marker to be that one comment",
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

await test("assertInertBlock refuses a comment a prefix-anchored consumer could misread", () => {
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
      `${BRIEF_COMMENT_MARKER}\nProjected to owning repo: https://example.test`,
    );
  } catch {
    threw = true;
  }
  assert(threw, "expected a refusal for a projection-pointer line");
});

// ---------------------------------------------------------------------------
// runBrief: the comment write path.
// ---------------------------------------------------------------------------

await test("runBrief creates the brief comment through --body-file -, never argv", async () => {
  const gh = makeRunGh(stubIssue());
  const result = await runBrief({
    runGh: gh.runGh,
    repo: "mento-protocol/monitoring-monorepo",
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  const create = created(gh)[0];
  assert(create, "expected an issue comment create");
  assertEqual(create.args.includes("--body-file"), true);
  assertEqual(create.args[create.args.indexOf("--body-file") + 1], "-");
  assert(
    create.stdin.includes(BRIEF_COMMENT_MARKER),
    "expected the brief on stdin, never in argv",
  );
  // The stub body is never a write target.
  assertEqual(wroteBody(gh), false);
  assertEqual(findBriefComments(gh.state.comments).length, 1);
});

await test("a second needs-human round updates the comment in place via PATCH", async () => {
  const yaml = [
    "verdict: needs-human",
    "confidence: high",
    "human_question: A second round asks something else",
  ].join("\n");
  const gh = makeRunGh({
    ...stubIssue(yaml),
    comments: [
      briefCommentObject(renderFixture(), 6001),
      verdictCommentObject(yaml, "2026-08-12T10:00:00Z"),
    ],
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  assertEqual(patched(gh).length, 1);
  assertEqual(created(gh).length, 0);
  const briefs = findBriefComments(gh.state.comments);
  assertEqual(briefs.length, 1);
  assert(
    briefs[0].body.includes("A second round asks something else"),
    "expected the comment updated to the new question",
  );
});

await test("runBrief writes nothing when the brief comment is already current", async () => {
  const gh = makeRunGh({
    ...stubIssue(),
    comments: [
      briefCommentObject(renderFixture(), 7001),
      verdictCommentObject(),
    ],
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, false);
  assertEqual(patched(gh).length, 0);
  assertEqual(created(gh).length, 0);
  assertEqual(deleted(gh).length, 0);
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
    gh.calls.some((c) => !(c.args[0] === "issue" && c.args[1] === "view")),
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
    gh.calls.some((c) => !(c.args[0] === "issue" && c.args[1] === "view")),
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
// The comment's lifecycle: it exists IFF a live needs-human verdict describes
// the stub. These are the tests the gated-on-needs-human version could not pass.
// ---------------------------------------------------------------------------

await test("a re-triage away from needs-human deletes the brief comment", async () => {
  const gh = makeRunGh({
    ...stubIssue("verdict: code-fix\nconfidence: high\nsummary: x"),
    comments: [
      briefCommentObject(renderFixture(), 8001),
      verdictCommentObject(
        "verdict: code-fix\nconfidence: high\nsummary: x",
        "2026-08-11T10:00:00Z",
      ),
    ],
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  assertEqual(result.verdict, "code-fix");
  assertEqual(deleted(gh).length, 1);
  assertEqual(findBriefComments(gh.state.comments).length, 0);
  assertEqual(wroteBody(gh), false);
  // The stub body and its archive baseline are untouched.
  assertEqual(gh.state.body, STUB_BODY);
});

// FINDING 1 (comment 3753275021): approval label alone must NOT suppress the
// required stale-brief removal.
await test("a re-triage deletes the brief even under a stale sentry:approved-archive (finding 1)", async () => {
  const gh = makeRunGh({
    ...stubIssue("verdict: code-fix\nconfidence: high\nsummary: x"),
    // The stub still carries a human archive approval from the previous round.
    // The old body version YIELDED on this label and left the stale brief for a
    // later close to bury; the comment version removes it regardless of labels.
    labels: [{ name: "sentry:approved-archive" }],
    comments: [
      briefCommentObject(renderFixture(), 8101),
      verdictCommentObject(
        "verdict: code-fix\nconfidence: high\nsummary: x",
        "2026-08-11T10:00:00Z",
      ),
    ],
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  // The brief was DELETED, not yielded on — no yield path exists any more.
  assertEqual(deleted(gh).length, 1);
  assertEqual(findBriefComments(gh.state.comments).length, 0);
  // And the body — the archive's surface — was never touched.
  assertEqual(wroteBody(gh), false);
  assertEqual(gh.state.body, STUB_BODY);
});

await test("the comment survives one full verdict transition cycle", async () => {
  const gh = makeRunGh(stubIssue());
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(findBriefComments(gh.state.comments).length, 1);

  // Re-triage to a fresh needs-human: updated in place, still exactly one.
  gh.state.comments.push(
    verdictCommentObject(
      [
        "verdict: needs-human",
        "confidence: high",
        "human_question: A second round asks something else",
      ].join("\n"),
      "2026-08-11T10:00:00Z",
    ),
  );
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  const briefs = findBriefComments(gh.state.comments);
  assertEqual(briefs.length, 1);
  assert(
    briefs[0].body.includes("A second round asks something else"),
    "expected the comment updated, not stacked",
  );

  // Re-triage to a non-needs-human verdict: the comment is gone.
  gh.state.comments.push(
    verdictCommentObject(
      "verdict: upstream-transient\nconfidence: high",
      "2026-08-12T10:00:00Z",
    ),
  );
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(findBriefComments(gh.state.comments).length, 0);
});

await test("a duplicate brief comment is reduced to one, then cleared on removal", async () => {
  const gh = makeRunGh({
    ...stubIssue(),
    comments: [
      briefCommentObject(renderFixture(), 8201),
      briefCommentObject(renderFixture(), 8202),
      verdictCommentObject(),
    ],
  });
  await runBrief({ runGh: gh.runGh, issueNumber: 1731, log: () => {} });
  assertEqual(findBriefComments(gh.state.comments).length, 1);
  assertEqual(deleted(gh).length, 1);
});

await test("clearBriefComments deletes marked comments and no-ops when absent (#1769 round 5)", async () => {
  // The CLASS fix: a terminal transition that does NOT run the verdict path (the
  // archive leg settling a needs-human stub) calls this to clear the brief.
  const gh = makeRunGh(stubIssue());
  const removed = await clearBriefComments({
    runGh: gh.runGh,
    repo: "mento-protocol/monitoring-monorepo",
    issueNumber: 1731,
    comments: [
      briefCommentObject(renderFixture(), 9101),
      verdictCommentObject(),
    ],
    log: () => {},
  });
  assertEqual(removed, 1);
  assertEqual(deleted(gh).length, 1);
  // Deleting a comment is never a body write.
  assertEqual(wroteBody(gh), false);

  // Idempotent: no marked comment -> no call at all.
  const gh2 = makeRunGh(stubIssue());
  const removed2 = await clearBriefComments({
    runGh: gh2.runGh,
    issueNumber: 1731,
    comments: [verdictCommentObject()],
    log: () => {},
  });
  assertEqual(removed2, 0);
  assertEqual(gh2.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The other writer: the archive leg rewrites the stub BODY under a different
// concurrency group. This leg touches only comments, so it can never race it.
// ---------------------------------------------------------------------------

// FINDING 2 (comment 3753275028): the archive's settlement window is unlabeled
// (approval deleted before the baseline write, `sentry:archived` added only
// after the close), so a body writer could clobber the baseline in a window no
// label check sees. A comment writer never touches the body, so there is no
// window to serialize.
await test("the brief never writes the body, so a baseline in the archive's unlabeled window is safe (finding 2)", async () => {
  const gh = makeRunGh({
    ...stubIssue(), // needs-human; STUB_BODY already carries the archive baseline
    labels: [], // the unlabeled settlement window: neither approved-archive nor archived
  });
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  // The body is byte-for-byte unchanged and still carries the archive baseline.
  assertEqual(gh.state.body, STUB_BODY);
  assertEqual(
    parseArchiveBaseline(gh.state.body).lastSeen,
    "2026-08-04T12:29:24Z",
  );
  assertEqual(parseArchiveBaseline(gh.state.body).sentryIssueId, "7651697505");
  // Structurally: the leg issued ZERO stub-body writes, whatever the labels say.
  assertEqual(wroteBody(gh), false);
  assertEqual(findBriefComments(gh.state.comments).length, 1);
});

// FINDING (#1769 round 6): the MIRROR ordering. Round 5 made the archive CLEAR
// the brief on settlement; if the archive's cleanup runs BEFORE this write, a
// create here would strand a brief on a closed/archived stub. The write-side
// guard re-reads the terminal signals and refuses.
await test("the write refuses when the stub is closed or archived (#1769 round 6)", async () => {
  for (const terminal of [
    { state: "CLOSED", labels: [{ name: "sentry:verdict-needs-human" }] },
    {
      state: "OPEN",
      labels: [
        { name: "sentry:verdict-needs-human" },
        { name: "sentry:archived" },
      ],
    },
  ]) {
    const gh = makeRunGh({ ...stubIssue(), ...terminal });
    const result = await runBrief({
      runGh: gh.runGh,
      issueNumber: 1731,
      log: () => {},
    });
    assertEqual(result.written, false);
    assertEqual(result.refused, true);
    // Nothing was created / updated / deleted, and no body write either.
    assertEqual(created(gh).length, 0);
    assertEqual(patched(gh).length, 0);
    assertEqual(deleted(gh).length, 0);
    assertEqual(wroteBody(gh), false);
    assertEqual(findBriefComments(gh.state.comments).length, 0);
  }
});

await test("the normal open needs-human stub still writes past the guard", async () => {
  // The guard must not block the happy path: an OPEN, unarchived stub writes.
  const gh = makeRunGh(stubIssue());
  const result = await runBrief({
    runGh: gh.runGh,
    issueNumber: 1731,
    log: () => {},
  });
  assertEqual(result.written, true);
  assertEqual(result.refused, undefined);
  assertEqual(created(gh).length, 1);
  assertEqual(findBriefComments(gh.state.comments).length, 1);
});

// ---------------------------------------------------------------------------
// Wiring: prompt, doc, workflow, and the single-body-writer invariant.
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
  assert(
    step.includes("sentry:approved-archive"),
    "expected the stale archive approval shed with the rest",
  );
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

await test("the brief leg is not a stub-body writer, and owns its marker alone", () => {
  // The stub body has exactly ONE authorized writer (the trust boundary in
  // sentry-triage-queue-contract.mjs): the archive leg's baseline write. The
  // brief renders a COMMENT, so no other script carries its marker or the old
  // body-strip helper, and the leg itself never runs `gh issue edit`.
  const scriptsDir = join(repoRoot, "scripts");
  const offenders = [];
  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue;
    if (file === "sentry-triage-brief.mjs") continue;
    const src = readFileSync(join(scriptsDir, file), "utf8");
    if (
      /BRIEF_COMMENT_MARKER|sentry-triage-brief:v1|stripBriefFromBody/.test(src)
    ) {
      offenders.push(file);
    }
  }
  assertEqual(offenders.join(", "), "");
  const brief = readFileSync(
    join(scriptsDir, "sentry-triage-brief.mjs"),
    "utf8",
  );
  assert(
    !/"issue",\s*"edit"/.test(brief),
    "the brief leg must not run `gh issue edit` — it writes comments only",
  );
});

await test("the pipeline's shared modules stay under the file-size hard cap", () => {
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

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
