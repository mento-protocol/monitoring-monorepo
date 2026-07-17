#!/usr/bin/env node
import {
  buildDigest,
  chunkLines,
  classifyIssue,
  collectIssues,
  escapeSlackText,
  extractVerdictYamlBlock,
  findLatestVerdictComment,
  formatSummaryForSlack,
  LABEL_TO_VERDICT,
  MAX_SECTION_TEXT_LEN,
  NEEDS_TRIAGE_LABEL,
  parseArgs,
  parseIssueNumbers,
  parseQueueTitle,
  parseVerdictComment,
  sanitizeSummary,
  VERDICT_MARKER,
} from "./sentry-triage-digest.mjs";

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

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
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

// Build a verdict comment body the way the triage agent would.
function verdictComment({
  verdict = "code-fix",
  confidence = "medium",
  summary = "A short summary",
} = {}) {
  return [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict} # code-fix | config-fix | upstream-transient | needs-human`,
    `confidence: ${confidence} # high | medium | low`,
    "affected_repo: mento-protocol/monitoring-monorepo",
    `summary: ${summary}`,
    "root_cause: |",
    "  Some abstract root cause.",
    "proposed_action: |",
    "  Some abstract action.",
    "duplicate_of: []",
    "```",
    "",
    "Prose diagnosis goes here.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Slack escaping (reused notifier pattern)
// ---------------------------------------------------------------------------

await test("escapeSlackText escapes & < > with & first", () => {
  assertEqual(escapeSlackText("a & b"), "a &amp; b");
  assertEqual(escapeSlackText("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

await test("escapeSlackText neutralizes Slack mention/link control syntax", () => {
  // <!channel>, <@U123>, <url|text> all require < and >, which we escape.
  const injected = "<!channel> ping <@U999999> click <https://evil|here>";
  const escaped = escapeSlackText(injected);
  assert(!escaped.includes("<"), "expected all < escaped");
  assert(!escaped.includes(">"), "expected all > escaped");
  assert(
    escaped.includes("&lt;!channel&gt;"),
    "expected channel mention inert",
  );
});

await test("sanitizeSummary collapses newlines/control chars to single spaces", () => {
  assertEqual(
    sanitizeSummary("line one\nline two\tthree   four"),
    "line one line two three four",
  );
});

await test("formatSummaryForSlack sanitizes, hard-bounds, then escapes", () => {
  // A hostile multi-line summary with mention syntax and a fence-breakout try.
  const hostile =
    "<!channel> please\n```\nrm -rf\n``` " + "z".repeat(400) + " <@U1>";
  const out = formatSummaryForSlack(hostile);
  assert(!out.includes("\n"), "expected single line");
  assert(!out.includes("<"), "expected < escaped");
  assert(!out.includes(">"), "expected > escaped");
  assert(out.endsWith("…"), "expected hard-truncation ellipsis");
  assert(out.length <= 320, "expected bounded length (<=300 + entities)");
});

// ---------------------------------------------------------------------------
// Queue-title parsing (short id + project)
// ---------------------------------------------------------------------------

await test("parseQueueTitle extracts short id and project from a v2 title", () => {
  assertDeepEqual(
    parseQueueTitle(
      "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
    ),
    { shortId: "GOVERNANCE-MENTO-ORG-51", project: "governance-mento-org" },
  );
});

await test("parseQueueTitle returns nulls for a non-queue title", () => {
  assertDeepEqual(parseQueueTitle("random issue title"), {
    shortId: null,
    project: null,
  });
});

// ---------------------------------------------------------------------------
// Verdict-comment parsing (marker + yaml)
// ---------------------------------------------------------------------------

await test("extractVerdictYamlBlock pulls the fenced yaml block only", () => {
  const block = extractVerdictYamlBlock(verdictComment());
  assert(block.includes("verdict: code-fix"), "expected verdict line in block");
  assert(!block.includes("Prose diagnosis"), "expected prose excluded");
});

await test("parseVerdictComment reads verdict/confidence/summary, ignoring inline comments", () => {
  const parsed = parseVerdictComment(
    verdictComment({
      verdict: "config-fix",
      confidence: "high",
      summary: "CSP allowlist missing a domain",
    }),
  );
  assertDeepEqual(parsed, {
    verdict: "config-fix",
    confidence: "high",
    summary: "CSP allowlist missing a domain",
  });
});

await test("parseVerdictComment strips one layer of surrounding quotes from summary", () => {
  const parsed = parseVerdictComment(
    verdictComment({ summary: '"quoted summary with # hash kept"' }),
  );
  assertEqual(parsed.summary, "quoted summary with # hash kept");
});

await test("parseVerdictComment rejects out-of-enum verdict/confidence to null", () => {
  const parsed = parseVerdictComment(
    verdictComment({ verdict: "totally-bogus", confidence: "certain" }),
  );
  assertEqual(parsed.verdict, null);
  assertEqual(parsed.confidence, null);
});

await test("findLatestVerdictComment returns the newest marker-bearing comment", () => {
  const comments = [
    { body: "not a verdict" },
    { body: verdictComment({ summary: "older" }) },
    { body: "another chatter comment" },
    { body: verdictComment({ summary: "newest" }) },
  ];
  const latest = findLatestVerdictComment(comments);
  assert(latest.includes("summary: newest"), "expected newest verdict comment");
});

await test("findLatestVerdictComment returns null when no marker comment exists", () => {
  assertEqual(
    findLatestVerdictComment([{ body: "hi" }, { body: "bye" }]),
    null,
  );
  assertEqual(findLatestVerdictComment([]), null);
});

// ---------------------------------------------------------------------------
// Classification (label-driven bucket + failed-triage bucket)
// ---------------------------------------------------------------------------

function issueFixture({
  number = 100,
  shortId = "X-1",
  project = "app-mento-org",
  labels = [],
  comments = [],
} = {}) {
  return {
    number,
    title: `[sentry] ${shortId} (${project}, error)`,
    url: `https://github.com/mento-protocol/monitoring-monorepo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    comments,
  };
}

await test("classifyIssue buckets by the verdict label, not the comment text", () => {
  const entry = classifyIssue(
    issueFixture({
      labels: ["sentry-triage", "sentry:verdict-config-fix"],
      // Comment says code-fix, but the deterministic LABEL wins.
      comments: [
        { body: verdictComment({ verdict: "code-fix", summary: "sum" }) },
      ],
    }),
  );
  assertEqual(entry.bucket, "config-fix");
  assertEqual(entry.verdict, "config-fix");
  assertEqual(entry.confidence, "medium");
  assertEqual(entry.summary, "sum");
});

await test("classifyIssue maps the upstream label to the upstream-transient verdict", () => {
  const entry = classifyIssue(
    issueFixture({ labels: ["sentry-triage", "sentry:verdict-upstream"] }),
  );
  assertEqual(entry.bucket, "upstream-transient");
});

await test("classifyIssue puts still-needs-triage issues in the failed bucket", () => {
  const entry = classifyIssue(
    issueFixture({ labels: ["sentry-triage", NEEDS_TRIAGE_LABEL] }),
  );
  assertEqual(entry.bucket, "failed");
  assertEqual(entry.verdict, null);
});

await test("classifyIssue treats an unlabeled batch issue as failed (visible, not dropped)", () => {
  const entry = classifyIssue(issueFixture({ labels: ["sentry-triage"] }));
  assertEqual(entry.bucket, "failed");
});

await test("classifyIssue falls back to #number when the title does not parse", () => {
  const entry = classifyIssue({
    number: 42,
    title: "not a queue title",
    url: "",
    labels: [{ name: "sentry:verdict-needs-human" }],
    comments: [],
  });
  assertEqual(entry.shortId, "#42");
  assertEqual(entry.project, "unknown");
  assertEqual(entry.bucket, "needs-human");
});

// LABEL_TO_VERDICT preserves the contract's upstream asymmetry.
await test("LABEL_TO_VERDICT encodes the upstream label/value asymmetry", () => {
  assertEqual(
    LABEL_TO_VERDICT["sentry:verdict-upstream"],
    "upstream-transient",
  );
  assertEqual(LABEL_TO_VERDICT["sentry:verdict-code-fix"], "code-fix");
});

// ---------------------------------------------------------------------------
// Digest payload assembly (shape, counts, ordering, escaping)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-17T14:20:33.000Z");

await test("buildDigest produces a valid chat.postMessage payload shape", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 1,
        shortId: "A-1",
        labels: ["sentry:verdict-code-fix"],
        comments: [{ body: verdictComment({ summary: "null deref" }) }],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  assertEqual(payload.channel, "#engineering");
  assertEqual(payload.text, "Sentry triage — 1 issue(s) triaged");
  assert(Array.isArray(payload.blocks), "expected blocks array");
  assertEqual(payload.blocks[0].type, "section");
  assertEqual(payload.blocks[0].text.type, "mrkdwn");
  assert(
    payload.blocks[0].text.text.includes("Sentry triage — 1 issue(s) triaged"),
    "expected header text",
  );
  assert(
    payload.blocks[0].text.text.includes("2026-07-17 14:20 UTC"),
    "expected UTC timestamp",
  );
  // Payload must be JSON-serializable (the workflow curls it verbatim).
  JSON.parse(JSON.stringify(payload));
});

await test("every mrkdwn text object sets verbatim: true (no Slack auto-parsing)", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 1,
        labels: ["sentry:verdict-code-fix"],
        comments: [{ body: verdictComment({ summary: "@everyone #general" }) }],
      }),
      issueFixture({ number: 2, labels: [NEEDS_TRIAGE_LABEL] }),
    ],
    { channel: "#engineering", now: NOW },
  );
  assert(payload.blocks.length >= 3, "expected header/counts/lines blocks");
  for (const block of payload.blocks) {
    assertEqual(block.text.verbatim, true);
  }
});

await test("buildDigest renders the counts line in contract order incl. failed triage", () => {
  const payload = buildDigest(
    [
      issueFixture({ number: 1, labels: ["sentry:verdict-code-fix"] }),
      issueFixture({ number: 2, labels: ["sentry:verdict-code-fix"] }),
      issueFixture({ number: 3, labels: ["sentry:verdict-config-fix"] }),
      issueFixture({ number: 4, labels: ["sentry:verdict-needs-human"] }),
      issueFixture({ number: 5, labels: [NEEDS_TRIAGE_LABEL] }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const countsText = payload.blocks[1].text.text;
  assertEqual(
    countsText,
    "code-fix: 2 · config-fix: 1 · upstream-transient: 0 · needs-human: 1 · failed triage: 1",
  );
});

await test("buildDigest orders issue lines: code/config, needs-human, upstream, failed last", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 1,
        shortId: "UP-1",
        labels: ["sentry:verdict-upstream"],
        comments: [{ body: verdictComment({ verdict: "upstream-transient" }) }],
      }),
      issueFixture({
        number: 2,
        shortId: "FAIL-1",
        labels: [NEEDS_TRIAGE_LABEL],
      }),
      issueFixture({
        number: 3,
        shortId: "NH-1",
        labels: ["sentry:verdict-needs-human"],
        comments: [{ body: verdictComment({ verdict: "needs-human" }) }],
      }),
      issueFixture({
        number: 4,
        shortId: "CF-1",
        labels: ["sentry:verdict-code-fix"],
        comments: [{ body: verdictComment({ verdict: "code-fix" }) }],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const lines = payload.blocks[2].text.text.split("\n");
  const order = lines.map((line) => /\|(\S+)>/.exec(line)?.[1]);
  assertDeepEqual(order, ["CF-1", "NH-1", "UP-1", "FAIL-1"]);
});

await test("buildDigest renders a linked, escaped per-issue line for a verdict", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 7,
        shortId: "APP-7",
        project: "app-mento-org",
        labels: ["sentry:verdict-code-fix"],
        comments: [
          {
            body: verdictComment({
              verdict: "code-fix",
              confidence: "high",
              summary: "unhandled <null> & missing guard",
            }),
          },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const line = payload.blocks[2].text.text;
  assert(
    line.includes(
      "<https://github.com/mento-protocol/monitoring-monorepo/issues/7|APP-7>",
    ),
    "expected linked short id",
  );
  assert(line.includes("(app-mento-org)"), "expected project");
  assert(line.includes("code-fix (high):"), "expected verdict + confidence");
  // The summary's < > & must be escaped, not raw.
  assert(
    line.includes("unhandled &lt;null&gt; &amp; missing guard"),
    "expected escaped summary",
  );
  assert(!/unhandled <null>/.test(line), "expected no raw angle brackets");
});

await test("buildDigest renders a distinct failed-triage line with no verdict", () => {
  const payload = buildDigest(
    [issueFixture({ number: 9, shortId: "F-9", labels: [NEEDS_TRIAGE_LABEL] })],
    { channel: "#engineering", now: NOW },
  );
  const line = payload.blocks[2].text.text;
  assert(line.includes("triage incomplete"), "expected failed-triage phrasing");
  assert(
    line.includes(NEEDS_TRIAGE_LABEL),
    "expected needs-triage label named",
  );
});

await test("buildDigest shows a placeholder when a verdict issue has no parseable summary", () => {
  const payload = buildDigest(
    [issueFixture({ number: 3, labels: ["sentry:verdict-code-fix"] })],
    { channel: "#engineering", now: NOW },
  );
  assert(
    payload.blocks[2].text.text.includes("_(no summary)_"),
    "expected no-summary placeholder",
  );
});

// ---------------------------------------------------------------------------
// Empty-batch guard + issue-number parsing
// ---------------------------------------------------------------------------

await test("parseIssueNumbers returns [] for empty/absent input (empty-batch guard)", () => {
  assertDeepEqual(parseIssueNumbers(undefined), []);
  assertDeepEqual(parseIssueNumbers(null), []);
  assertDeepEqual(parseIssueNumbers(""), []);
  assertDeepEqual(parseIssueNumbers("   "), []);
  assertDeepEqual(parseIssueNumbers("[]"), []);
});

await test("parseIssueNumbers parses a JSON array of positive integers", () => {
  assertDeepEqual(parseIssueNumbers("[123, 456]"), [123, 456]);
});

await test("parseIssueNumbers fails loud on non-arrays and bad members", () => {
  assertThrows(() => parseIssueNumbers("not json"), /JSON array/);
  assertThrows(() => parseIssueNumbers('{"a":1}'), /JSON array/);
  assertThrows(() => parseIssueNumbers("[0]"), /Invalid issue number/);
  assertThrows(() => parseIssueNumbers("[-1]"), /Invalid issue number/);
  assertThrows(() => parseIssueNumbers('["7"]'), /Invalid issue number/);
  assertThrows(() => parseIssueNumbers("[1.5]"), /Invalid issue number/);
});

await test("buildDigest tolerates an empty batch (defensive; job is gated upstream)", () => {
  const payload = buildDigest([], { channel: "#engineering", now: NOW });
  assertEqual(payload.text, "Sentry triage — 0 issue(s) triaged");
  assertEqual(
    payload.blocks[1].text.text,
    "code-fix: 0 · config-fix: 0 · upstream-transient: 0 · needs-human: 0 · failed triage: 0",
  );
});

// ---------------------------------------------------------------------------
// Slack 3000-char text-object cap (escape expansion must never overflow one
// section)
// ---------------------------------------------------------------------------

await test("chunkLines packs greedily and respects the per-chunk budget", () => {
  assertDeepEqual(chunkLines([], 10), []);
  assertDeepEqual(chunkLines(["aa", "bb", "cc"], 5), ["aa\nbb", "cc"]);
  // Exact fit including the joining newline: "aa\nbb" is 5 chars.
  assertDeepEqual(chunkLines(["aa", "bb"], 5), ["aa\nbb"]);
  assertDeepEqual(chunkLines(["aa", "bb"], 4), ["aa", "bb"]);
  // A single line longer than the budget still lands in its own chunk.
  assertDeepEqual(chunkLines(["xxxxxxxxxx", "y"], 5), ["xxxxxxxxxx", "y"]);
});

await test("buildDigest splits a worst-case 6-issue batch across sections under the Slack cap", () => {
  // Six 300-char all-`<` summaries escape-expand to 1200 chars each — the
  // exact invalid_blocks scenario: one section would be ~7.9k chars.
  const issues = Array.from({ length: 6 }, (_, i) =>
    issueFixture({
      number: 100 + i,
      shortId: `WC-${i}`,
      labels: ["sentry:verdict-code-fix"],
      comments: [{ body: verdictComment({ summary: "<".repeat(300) }) }],
    }),
  );
  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });

  const lineBlocks = payload.blocks.slice(2);
  assert(lineBlocks.length >= 2, "expected the lines split across sections");
  for (const block of payload.blocks) {
    assert(
      block.text.text.length <= MAX_SECTION_TEXT_LEN,
      `expected every section under the ${MAX_SECTION_TEXT_LEN}-char budget, got ${block.text.text.length}`,
    );
  }
  // No line lost and order preserved across the chunk boundaries.
  const allLines = lineBlocks.flatMap((block) => block.text.text.split("\n"));
  assertEqual(allLines.length, 6);
  assertDeepEqual(
    allLines.map((line) => /\|(\S+)>/.exec(line)?.[1]),
    ["WC-0", "WC-1", "WC-2", "WC-3", "WC-4", "WC-5"],
  );
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

await test("parseArgs reads channel/issues from flags", () => {
  const options = parseArgs(
    ["--channel", "#engineering", "--issues", "[1,2]"],
    {},
  );
  assertEqual(options.channel, "#engineering");
  assertDeepEqual(options.issues, [1, 2]);
  assertEqual(options.repo, "mento-protocol/monitoring-monorepo");
});

await test("parseArgs falls back to env, flag wins", () => {
  const options = parseArgs(["--channel", "#flag"], {
    SENTRY_TRIAGE_CHANNEL: "#env",
    SENTRY_TRIAGE_ISSUES: "[9]",
  });
  assertEqual(options.channel, "#flag");
  assertDeepEqual(options.issues, [9]);
});

await test("parseArgs rejects unknown options", () => {
  assertThrows(() => parseArgs(["--nope"], {}), /Unknown option/);
});

// ---------------------------------------------------------------------------
// Collection layer (injected gh runner)
// ---------------------------------------------------------------------------

await test("collectIssues fetches each issue via the injected gh runner", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    const number = args[2];
    return JSON.stringify({
      number: Number(number),
      title: `[sentry] X-${number} (app-mento-org, error)`,
      url: `https://github.com/o/r/issues/${number}`,
      labels: [{ name: "sentry:verdict-code-fix" }],
      comments: [{ body: verdictComment({ summary: `sum ${number}` }) }],
    });
  };

  const issues = await collectIssues("o/r", [11, 22], { runGh });
  assertEqual(issues.length, 2);
  assertEqual(issues[0].number, 11);
  assertDeepEqual(issues[0].labels, ["sentry:verdict-code-fix"]);
  // Each call is a read-only `gh issue view ... --json ...`.
  assertEqual(calls[0][0], "issue");
  assertEqual(calls[0][1], "view");
  assert(calls[0].includes("number,title,url,labels,comments"), "json fields");
  // The caller's repo (the workflow passes --repo "$GITHUB_REPOSITORY")
  // propagates into every gh call — never the script's baked-in default.
  const repoFlagIndex = calls[0].indexOf("--repo");
  assert(repoFlagIndex !== -1, "expected --repo flag in gh args");
  assertEqual(calls[0][repoFlagIndex + 1], "o/r");
  assertEqual(calls[1][calls[1].indexOf("--repo") + 1], "o/r");

  // End-to-end: collected issues feed straight into a valid payload.
  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });
  assertEqual(payload.text, "Sentry triage — 2 issue(s) triaged");
});

await test("collectIssues propagates a single fetch failure (fail loud, no silent drop)", async () => {
  // One bad `gh issue view` must fail the whole digest (and so the job/run),
  // never silently omit that issue from the posted digest.
  const runGh = async (args) => {
    if (args[2] === "22") throw new Error("gh issue view failed: HTTP 502");
    return JSON.stringify({
      number: Number(args[2]),
      title: `[sentry] X-${args[2]} (app-mento-org, error)`,
      url: `https://github.com/o/r/issues/${args[2]}`,
      labels: [],
      comments: [],
    });
  };
  let threw = null;
  try {
    await collectIssues("o/r", [11, 22, 33], { runGh });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected a single fetch failure to reject collectIssues");
  assert(/HTTP 502/.test(threw.message), "expected the gh error to propagate");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
