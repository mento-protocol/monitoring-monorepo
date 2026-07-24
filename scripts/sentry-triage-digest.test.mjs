#!/usr/bin/env node
import {
  AUTOFIX_COMMENT_PREFIX,
  buildDigest,
  chunkBriefs,
  chunkLines,
  classifyIssue,
  collectIssues,
  escapeSlackText,
  extractAutofixUrl,
  extractProjectedUrl,
  extractVerdictYamlBlock,
  findLatestVerdictComment,
  formatBriefList,
  formatBriefText,
  formatSummaryForSlack,
  LABEL_TO_VERDICT,
  MAX_SECTION_TEXT_LEN,
  NEEDS_TRIAGE_LABEL,
  parseArgs,
  parseIssueNumbers,
  parseQueueTitle,
  parseVerdictComment,
  PROJECTED_COMMENT_PREFIX,
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

const SENTRY_PERMALINK = "https://mento-labs.sentry.io/issues/6197137101/";

// Build a verdict comment body the way the triage agent would. The needs-human
// brief fields are appended only when provided (optional-absent otherwise).
function verdictComment({
  verdict = "code-fix",
  confidence = "medium",
  summary = "A short summary",
  humanQuestion = null,
  hypotheses = null,
  investigated = null,
  escalationReason = null,
} = {}) {
  const lines = [
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
  ];
  if (humanQuestion != null)
    lines.push("human_question: |", `  ${humanQuestion}`);
  if (hypotheses != null) {
    lines.push("hypotheses:", ...hypotheses.map((h) => `  - ${h}`));
  }
  if (investigated != null) {
    lines.push("investigated:", ...investigated.map((it) => `  - ${it}`));
  }
  if (escalationReason != null) {
    lines.push("escalation_reason: |", `  ${escalationReason}`);
  }
  lines.push("```", "", "Prose diagnosis goes here.");
  return lines.join("\n");
}

function queueBody(permalink = SENTRY_PERMALINK) {
  return [
    "<!-- sentry-triage:v1 -->",
    "",
    "```yaml",
    `permalink: "${permalink}"`,
    "```",
    "",
    `[View in Sentry](${permalink})`,
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
  const hostile =
    "<!channel> please\n```\nrm -rf\n``` " + "z".repeat(400) + " <@U1>";
  const out = formatSummaryForSlack(hostile);
  assert(!out.includes("\n"), "expected single line");
  assert(!out.includes("<"), "expected < escaped");
  assert(!out.includes(">"), "expected > escaped");
  assert(out.endsWith("…"), "expected hard-truncation ellipsis");
  assert(out.length <= 320, "expected bounded length (<=300 + entities)");
});

await test("formatBriefText sanitizes, bounds, and escapes a brief field", () => {
  const out = formatBriefText("Decide <X> or <Y>\nnow");
  assertEqual(out, "Decide &lt;X&gt; or &lt;Y&gt; now");
  const long = "z".repeat(500);
  const bounded = formatBriefText(long);
  assert(bounded.endsWith("…"), "expected truncation at MAX_BRIEF_LEN");
  assert(bounded.length <= 405, "expected bound (<=400 + ellipsis)");
});

await test("formatBriefList joins items with '; ', escapes, and empties to ''", () => {
  assertEqual(formatBriefList(["a <b>", "c & d"]), "a &lt;b&gt;; c &amp; d");
  assertEqual(formatBriefList([]), "");
  assertEqual(formatBriefList(["", "  "]), "");
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
// Verdict-comment parsing (authoritative parser, re-exported from core)
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
  assertEqual(parsed.verdict, "config-fix");
  assertEqual(parsed.confidence, "high");
  assertEqual(parsed.summary, "CSP allowlist missing a domain");
});

await test("parseVerdictComment rejects out-of-enum verdict/confidence to null", () => {
  const parsed = parseVerdictComment(
    verdictComment({ verdict: "totally-bogus", confidence: "certain" }),
  );
  assertEqual(parsed.verdict, null);
  assertEqual(parsed.confidence, null);
});

await test("parseVerdictComment surfaces the needs-human brief fields", () => {
  const parsed = parseVerdictComment(
    verdictComment({
      verdict: "needs-human",
      humanQuestion: "Decide whether to rotate the key or wait.",
      hypotheses: ["race in connect flow", "upstream RPC flap"],
      investigated: ["read the handler", "searched for duplicates"],
      escalationReason: "Security-sensitive surface.",
    }),
  );
  assertEqual(
    parsed.humanQuestion,
    "Decide whether to rotate the key or wait.",
  );
  assertDeepEqual(parsed.hypotheses, [
    "race in connect flow",
    "upstream RPC flap",
  ]);
  assertDeepEqual(parsed.investigated, [
    "read the handler",
    "searched for duplicates",
  ]);
  assertEqual(parsed.escalationReason, "Security-sensitive surface.");
});

// Pipeline-authored comments resolve to the Actions bot login (see the
// collector's authorship fence). Fixtures default to it; hostile-author tests
// pass an explicit `author`, which wins via spread order.
const BOT_AUTHOR = { login: "github-actions" };

await test("findLatestVerdictComment returns the newest trusted marker-bearing comment", () => {
  const comments = [
    { body: "not a verdict", author: BOT_AUTHOR },
    { body: verdictComment({ summary: "older" }), author: BOT_AUTHOR },
    { body: "another chatter comment", author: BOT_AUTHOR },
    { body: verdictComment({ summary: "newest" }), author: BOT_AUTHOR },
  ];
  const latest = findLatestVerdictComment(comments);
  assert(latest.includes("summary: newest"), "expected newest verdict comment");
});

await test("findLatestVerdictComment ignores marker comments from untrusted authors", () => {
  const comments = [
    { body: verdictComment({ summary: "legit" }), author: BOT_AUTHOR },
    {
      body: verdictComment({ summary: "hostile override" }),
      author: { login: "attacker" },
    },
  ];
  const latest = findLatestVerdictComment(comments);
  assert(latest.includes("summary: legit"), "expected the bot verdict kept");
  assertEqual(
    findLatestVerdictComment([
      {
        body: verdictComment({ summary: "only hostile" }),
        author: { login: "x" },
      },
    ]),
    null,
  );
  assertEqual(
    findLatestVerdictComment([{ body: verdictComment() }]),
    null,
    "expected a missing author to fail closed",
  );
});

await test("findLatestVerdictComment sorts by createdAt — never trusts API array order", () => {
  // Out-of-order API response: the NEWEST verdict comes FIRST in the array.
  const comments = [
    {
      body: verdictComment({ summary: "newest" }),
      author: BOT_AUTHOR,
      createdAt: "2026-07-17T12:00:00Z",
    },
    {
      body: verdictComment({ summary: "older" }),
      author: BOT_AUTHOR,
      createdAt: "2026-07-17T09:00:00Z",
    },
  ];
  const latest = findLatestVerdictComment(comments);
  assert(
    latest.includes("summary: newest"),
    "expected createdAt (not array order) to pick the newest verdict",
  );
});

await test("findLatestVerdictComment applies the regression fence (stale pre-regression verdict -> null)", () => {
  // Same selection path as the label/projection steps (core's
  // selectVerdictComment): a verdict older than the newest regression-reopen
  // comment describes the previous occurrence and must not feed text into the
  // digest.
  const comments = [
    {
      body: verdictComment({ summary: "stale" }),
      author: BOT_AUTHOR,
      createdAt: "2026-07-17T09:00:00Z",
    },
    {
      body: "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      author: BOT_AUTHOR,
      createdAt: "2026-07-17T11:00:00Z",
    },
  ];
  assertEqual(findLatestVerdictComment(comments), null);
});

await test("findLatestVerdictComment returns null when no marker comment exists", () => {
  assertEqual(
    findLatestVerdictComment([
      { body: "hi", author: BOT_AUTHOR },
      { body: "bye", author: BOT_AUTHOR },
    ]),
    null,
  );
  assertEqual(findLatestVerdictComment([]), null);
});

// ---------------------------------------------------------------------------
// Projected / fix-PR pointer comment extraction (authorship + shape fenced)
// ---------------------------------------------------------------------------

const PROJECTED_URL =
  "https://github.com/mento-protocol/frontend-monorepo/issues/42";
const FIX_PR_URL = "https://github.com/mento-protocol/frontend-monorepo/pull/9";

await test("extractProjectedUrl reads a trusted, github-shaped projected-issue pointer", () => {
  const comments = [
    { body: "chatter", author: BOT_AUTHOR },
    { body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}`, author: BOT_AUTHOR },
  ];
  assertEqual(extractProjectedUrl(comments), PROJECTED_URL);
});

await test("extractProjectedUrl rejects untrusted authors and non-github urls", () => {
  assertEqual(
    extractProjectedUrl([
      {
        body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}`,
        author: { login: "attacker" },
      },
    ]),
    null,
  );
  assertEqual(
    extractProjectedUrl([
      {
        body: `${PROJECTED_COMMENT_PREFIX}https://evil.example.com/x`,
        author: BOT_AUTHOR,
      },
    ]),
    null,
  );
  assertEqual(extractProjectedUrl([]), null);
});

await test("extractAutofixUrl reads the #1278 fix-PR pointer (trusted + github-shaped)", () => {
  const comments = [
    { body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}`, author: BOT_AUTHOR },
  ];
  assertEqual(extractAutofixUrl(comments), FIX_PR_URL);
  assertEqual(
    extractAutofixUrl([
      {
        body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}`,
        author: { login: "x" },
      },
    ]),
    null,
  );
  assertEqual(extractAutofixUrl([]), null);
});

const REGRESSION_COMMENT =
  "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)";

await test("pointer lookup drops a STALE pre-regression pointer (regression fence)", () => {
  // The stub was projected/autofixed, closed, then regressed + reopened. The
  // old pointers survive but describe the PREVIOUS occurrence — a re-triaged
  // issue must not inherit them.
  const staleProjected = {
    body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T09:00:00Z",
  };
  const staleAutofix = {
    body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T09:30:00Z",
  };
  const regression = {
    body: REGRESSION_COMMENT,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T11:00:00Z",
  };
  assertEqual(extractProjectedUrl([staleProjected, regression]), null);
  assertEqual(extractAutofixUrl([staleAutofix, regression]), null);
});

await test("pointer lookup accepts a FRESH post-regression pointer over a stale one", () => {
  const regression = {
    body: REGRESSION_COMMENT,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T11:00:00Z",
  };
  const freshProjected = {
    body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T12:00:00Z",
  };
  assertEqual(
    extractProjectedUrl([
      {
        body: `${PROJECTED_COMMENT_PREFIX}https://github.com/mento-protocol/frontend-monorepo/issues/1`,
        author: BOT_AUTHOR,
        createdAt: "2026-07-17T09:00:00Z",
      },
      regression,
      freshProjected,
    ]),
    PROJECTED_URL,
  );
});

await test("pointer lookup sorts by createdAt — never trusts API array order", () => {
  // Out-of-order API response: the NEWEST pointer comes FIRST in the array;
  // an older pointer (different URL) comes last. createdAt must win.
  const newest = {
    body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T12:00:00Z",
  };
  const older = {
    body: `${PROJECTED_COMMENT_PREFIX}https://github.com/mento-protocol/frontend-monorepo/issues/1`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T09:00:00Z",
  };
  assertEqual(extractProjectedUrl([newest, older]), PROJECTED_URL);
  // Same for the fix-PR pointer.
  const newestFix = {
    body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T12:00:00Z",
  };
  const olderFix = {
    body: `${AUTOFIX_COMMENT_PREFIX}https://github.com/mento-protocol/frontend-monorepo/pull/1`,
    author: BOT_AUTHOR,
    createdAt: "2026-07-17T09:00:00Z",
  };
  assertEqual(extractAutofixUrl([newestFix, olderFix]), FIX_PR_URL);
});

// ---------------------------------------------------------------------------
// Classification (label-driven bucket + section assignment)
// ---------------------------------------------------------------------------

function issueFixture({
  number = 100,
  shortId = "X-1",
  project = "app-mento-org",
  labels = [],
  comments = [],
  body = queueBody(),
} = {}) {
  return {
    number,
    title: `[sentry] ${shortId} (${project}, error)`,
    url: `https://github.com/mento-protocol/monitoring-monorepo/issues/${number}`,
    body,
    labels: labels.map((name) => ({ name })),
    comments: comments.map((comment) => ({ author: BOT_AUTHOR, ...comment })),
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
  // No projected/fix pointer -> the Routed section.
  assertEqual(entry.section, "routed");
});

await test("classifyIssue routes upstream-transient to the wontfix section", () => {
  const entry = classifyIssue(
    issueFixture({ labels: ["sentry-triage", "sentry:verdict-upstream"] }),
  );
  assertEqual(entry.bucket, "upstream-transient");
  assertEqual(entry.section, "wontfix");
});

await test("classifyIssue routes needs-human to the needs-human section with the brief", () => {
  const entry = classifyIssue(
    issueFixture({
      labels: ["sentry-triage", "sentry:verdict-needs-human"],
      comments: [
        {
          body: verdictComment({
            verdict: "needs-human",
            humanQuestion: "Decide X or Y.",
            hypotheses: ["h1"],
            investigated: ["i1"],
            escalationReason: "ambiguous",
          }),
        },
      ],
    }),
  );
  assertEqual(entry.section, "needs-human");
  assertEqual(entry.humanQuestion, "Decide X or Y.");
  assertDeepEqual(entry.hypotheses, ["h1"]);
  assertDeepEqual(entry.investigated, ["i1"]);
  assertEqual(entry.escalationReason, "ambiguous");
  assertEqual(entry.sentryPermalink, SENTRY_PERMALINK);
});

await test("classifyIssue routes an actionable verdict with fix-PR data to the autofixed section", () => {
  const entry = classifyIssue(
    issueFixture({
      labels: ["sentry-triage", "sentry:verdict-code-fix"],
      comments: [
        { body: verdictComment({ verdict: "code-fix" }) },
        { body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}` },
      ],
    }),
  );
  assertEqual(entry.section, "autofixed");
  assertEqual(entry.autofixUrl, FIX_PR_URL);
});

await test("classifyIssue picks up a projected-issue pointer for the routed link", () => {
  const entry = classifyIssue(
    issueFixture({
      labels: ["sentry-triage", "sentry:verdict-code-fix"],
      comments: [
        { body: verdictComment({ verdict: "code-fix" }) },
        { body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}` },
      ],
    }),
  );
  assertEqual(entry.section, "routed");
  assertEqual(entry.projectedUrl, PROJECTED_URL);
});

await test("classifyIssue puts still-needs-triage issues in the failed bucket/section", () => {
  const entry = classifyIssue(
    issueFixture({ labels: ["sentry-triage", NEEDS_TRIAGE_LABEL] }),
  );
  assertEqual(entry.bucket, "failed");
  assertEqual(entry.section, "failed");
  assertEqual(entry.verdict, null);
});

await test("classifyIssue treats an unlabeled batch issue as failed (visible, not dropped)", () => {
  const entry = classifyIssue(issueFixture({ labels: ["sentry-triage"] }));
  assertEqual(entry.bucket, "failed");
  assertEqual(entry.section, "failed");
});

await test("classifyIssue falls back to #number when the title does not parse", () => {
  const entry = classifyIssue({
    number: 42,
    title: "not a queue title",
    url: "",
    body: "",
    labels: [{ name: "sentry:verdict-needs-human" }],
    comments: [],
  });
  assertEqual(entry.shortId, "#42");
  assertEqual(entry.project, "unknown");
  assertEqual(entry.bucket, "needs-human");
  assertEqual(entry.section, "needs-human");
});

await test("LABEL_TO_VERDICT encodes the upstream label/value asymmetry", () => {
  assertEqual(
    LABEL_TO_VERDICT["sentry:verdict-upstream"],
    "upstream-transient",
  );
  assertEqual(LABEL_TO_VERDICT["sentry:verdict-code-fix"], "code-fix");
});

// ---------------------------------------------------------------------------
// Digest payload assembly (shape, counts, section ordering/omission)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-17T14:20:33.000Z");

/** All block text joined — handy for order/substring assertions. */
function allText(payload) {
  return payload.blocks.map((block) => block.text.text).join("\n");
}

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
  assertEqual(payload.text, "Sentry triage — 1 issue triaged");
  assert(Array.isArray(payload.blocks), "expected blocks array");
  assertEqual(payload.blocks[0].type, "section");
  assertEqual(payload.blocks[0].text.type, "mrkdwn");
  assert(
    payload.blocks[0].text.text.includes("Sentry triage — 1 issue triaged"),
    "expected header text",
  );
  assert(
    payload.blocks[0].text.text.includes("2026-07-17 14:20 UTC"),
    "expected UTC timestamp",
  );
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
  assert(payload.blocks.length >= 2, "expected header + section blocks");
  for (const block of payload.blocks) {
    assertEqual(block.text.verbatim, true);
  }
});

await test("buildDigest renders sections in order (needs-human first) and omits empty ones", () => {
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
        comments: [
          {
            body: verdictComment({
              verdict: "needs-human",
              humanQuestion: "Decide it.",
            }),
          },
        ],
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
  const text = allText(payload);
  const nh = text.indexOf("Needs human — decisions required");
  const routed = text.indexOf("Routed to owning repo");
  const wontfix = text.indexOf("Wontfix / transient");
  const failedTriage = text.indexOf("🛑 Failed triage");
  assert(nh !== -1, "expected needs-human section");
  assert(nh < routed, "expected needs-human before routed");
  assert(routed < wontfix, "expected routed before wontfix");
  assert(wontfix < failedTriage, "expected wontfix before failed");
  // Autofixed section has no members here -> omitted entirely.
  assert(!text.includes("🤖 Autofixed"), "expected empty autofixed omitted");
  // needs-human renders as a decision-ready brief, not a one-liner.
  assert(text.includes("*Decision needed:*"), "expected the needs-human brief");
});

await test("buildDigest renders a routed line linking the projected owning-repo issue", () => {
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
              summary: "unhandled <null> & missing guard",
            }),
          },
          { body: `${PROJECTED_COMMENT_PREFIX}${PROJECTED_URL}` },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    text.includes(
      "<https://github.com/mento-protocol/monitoring-monorepo/issues/7|APP-7>",
    ),
    "expected linked short id (queue issue)",
  );
  assert(text.includes("(app-mento-org)"), "expected project");
  assert(
    text.includes(`→ <${PROJECTED_URL}|owning-repo issue>`),
    "expected the arrow to link the projected issue",
  );
  // The summary's < > & must be escaped, not raw.
  assert(
    text.includes("unhandled &lt;null&gt; &amp; missing guard"),
    "expected escaped summary",
  );
  assert(!/unhandled <null>/.test(text), "expected no raw angle brackets");
});

await test("routed section falls back to the queue-issue verdict when projection was skipped", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 8,
        shortId: "CF-8",
        labels: ["sentry:verdict-code-fix"],
        comments: [{ body: verdictComment({ verdict: "code-fix" }) }],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    text.includes(
      "→ <https://github.com/mento-protocol/monitoring-monorepo/issues/8|triage verdict>",
    ),
    "expected the fallback arrow to link the queue issue",
  );
});

await test("autofixed section renders only when fix-PR data exists, linking the PR", () => {
  const withFix = buildDigest(
    [
      issueFixture({
        number: 9,
        shortId: "CF-9",
        labels: ["sentry:verdict-code-fix"],
        comments: [
          {
            body: verdictComment({ verdict: "code-fix", summary: "fixed it" }),
          },
          { body: `${AUTOFIX_COMMENT_PREFIX}${FIX_PR_URL}` },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(withFix);
  assert(text.includes("🤖 Autofixed (1)"), "expected the autofixed section");
  assert(text.includes(`→ <${FIX_PR_URL}|fix PR>`), "expected the fix-PR link");
  assert(!text.includes("📮 Routed"), "expected it not to also route");
});

await test("section header count reflects multiple entries in the same bucket", () => {
  // Regression coverage for the counts-header removal: each section header's
  // "(N)" is now the ONLY place a bucket's count renders, so it must still
  // count correctly across more than one entry in the same bucket.
  const payload = buildDigest(
    [
      issueFixture({
        number: 20,
        shortId: "CF-20",
        labels: ["sentry:verdict-code-fix"],
      }),
      issueFixture({
        number: 21,
        shortId: "CF-21",
        labels: ["sentry:verdict-code-fix"],
      }),
      issueFixture({
        number: 22,
        shortId: "UP-22",
        labels: ["sentry:verdict-upstream"],
      }),
      issueFixture({
        number: 23,
        shortId: "UP-23",
        labels: ["sentry:verdict-upstream"],
      }),
      issueFixture({
        number: 24,
        shortId: "UP-24",
        labels: ["sentry:verdict-upstream"],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    text.includes("📮 Routed to owning repo (2)"),
    "expected the routed header to count both code-fix entries",
  );
  assert(
    text.includes("🙅 Wontfix / transient (3)"),
    "expected the wontfix header to count all three upstream entries",
  );
});

await test("buildDigest renders a decision-ready needs-human brief with all fields + links", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 11,
        shortId: "NH-11",
        project: "app-mento-org",
        labels: ["sentry:verdict-needs-human"],
        comments: [
          {
            body: verdictComment({
              verdict: "needs-human",
              confidence: "low",
              humanQuestion:
                "Decide whether to rotate the signing key or wait.",
              hypotheses: ["wallet-connect race", "upstream RPC flap"],
              investigated: ["read the connect handler", "no dup in the queue"],
              escalationReason:
                "Security-sensitive surface + conflicting evidence.",
            }),
          },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    text.includes(`• *<${SENTRY_PERMALINK}|NH-11>* · confidence: low`),
    "expected a level-1 bullet whose id links straight to the Sentry issue, with no repeated project",
  );
  assert(
    !text.includes("(app-mento-org)"),
    "expected the project not repeated in parens on the needs-human line",
  );
  assert(
    text.includes(
      "*Decision needed:* Decide whether to rotate the signing key or wait.",
    ),
    "expected the decision line",
  );
  assert(
    text.includes("*Hypotheses:* wallet-connect race; upstream RPC flap"),
    "expected the hypotheses line",
  );
  assert(
    text.includes(
      "*Already investigated:* read the connect handler; no dup in the queue",
    ),
    "expected the investigated line",
  );
  assert(
    text.includes(
      "*Why escalated:* Security-sensitive surface + conflicting evidence.",
    ),
    "expected the escalation-reason line",
  );
  assert(
    text.includes(
      "*Links:* <https://github.com/mento-protocol/monitoring-monorepo/issues/11|queue issue> · " +
        `<${SENTRY_PERMALINK}|Sentry>`,
    ),
    "expected queue + Sentry links",
  );
});

await test("needs-human brief shows a placeholder when human_question is somehow absent", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 12,
        shortId: "NH-12",
        labels: ["sentry:verdict-needs-human"],
        comments: [{ body: verdictComment({ verdict: "needs-human" }) }],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  assert(
    allText(payload).includes("_(no decision recorded — re-triage)_"),
    "expected the missing-decision placeholder",
  );
});

await test("needs-human brief escapes every agent-derived field", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 13,
        shortId: "NH-13",
        labels: ["sentry:verdict-needs-human"],
        comments: [
          {
            body: verdictComment({
              verdict: "needs-human",
              humanQuestion: "Decide <A> or <B>",
              hypotheses: ["<script>alert(1)</script>", "a & b"],
              investigated: ["checked <thing>"],
              escalationReason: "conflicting <evidence>",
            }),
          },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    !/Decide <A>/.test(text),
    "expected no raw angle brackets in decision",
  );
  assert(
    text.includes("Decide &lt;A&gt; or &lt;B&gt;"),
    "expected escaped decision",
  );
  assert(
    text.includes("&lt;script&gt;alert(1)&lt;/script&gt;; a &amp; b"),
    "expected escaped hypotheses",
  );
  assert(
    text.includes("checked &lt;thing&gt;"),
    "expected escaped investigated",
  );
  assert(
    text.includes("conflicting &lt;evidence&gt;"),
    "expected escaped escalation reason",
  );
  assert(!text.includes("<script>"), "expected no raw script tag");
});

await test("wontfix line links the queue-issue rationale with confidence", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 14,
        shortId: "UP-14",
        labels: ["sentry:verdict-upstream"],
        comments: [
          {
            body: verdictComment({
              verdict: "upstream-transient",
              confidence: "high",
              summary: "third-party outage",
            }),
          },
        ],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(
    text.includes(
      "• <https://github.com/mento-protocol/monitoring-monorepo/issues/14|UP-14> (app-mento-org) — third-party outage (high)",
    ),
    "expected the wontfix line linking the queue issue",
  );
  assert(
    text.includes(
      "    ◦ To archive in Sentry: add `sentry:approved-archive` to the queue issue above.",
    ),
    "expected a sub-bullet nudging the existing human-gated archive label",
  );
});

await test("buildDigest renders a distinct failed-triage line with no verdict", () => {
  const payload = buildDigest(
    [
      issueFixture({
        number: 15,
        shortId: "F-15",
        labels: [NEEDS_TRIAGE_LABEL],
      }),
    ],
    { channel: "#engineering", now: NOW },
  );
  const text = allText(payload);
  assert(text.includes("🛑 Failed triage (1)"), "expected the failed section");
  assert(text.includes("triage incomplete"), "expected failed-triage phrasing");
  assert(
    text.includes(NEEDS_TRIAGE_LABEL),
    "expected needs-triage label named",
  );
});

await test("routed line shows a placeholder when a verdict issue has no parseable summary", () => {
  const payload = buildDigest(
    [issueFixture({ number: 3, labels: ["sentry:verdict-code-fix"] })],
    { channel: "#engineering", now: NOW },
  );
  assert(
    allText(payload).includes("_(no summary)_"),
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
  assertEqual(payload.text, "Sentry triage — 0 issues triaged");
  // No section blocks when nothing was triaged — just the header.
  assertEqual(payload.blocks.length, 1);
});

// ---------------------------------------------------------------------------
// Slack 3000-char text-object cap (escape expansion / long briefs must never
// overflow one section)
// ---------------------------------------------------------------------------

await test("chunkLines packs greedily and respects the per-chunk budget", () => {
  assertDeepEqual(chunkLines([], 10), []);
  assertDeepEqual(chunkLines(["aa", "bb", "cc"], 5), ["aa\nbb", "cc"]);
  assertDeepEqual(chunkLines(["aa", "bb"], 5), ["aa\nbb"]);
  assertDeepEqual(chunkLines(["aa", "bb"], 4), ["aa", "bb"]);
  assertDeepEqual(chunkLines(["xxxxxxxxxx", "y"], 5), ["xxxxxxxxxx", "y"]);
});

await test("buildDigest splits a worst-case 6-issue routed batch across sections under the Slack cap", () => {
  // Six 300-char all-`<` summaries escape-expand to 1200 chars each — the
  // exact invalid_blocks scenario if packed into one section.
  const issues = Array.from({ length: 6 }, (_, i) =>
    issueFixture({
      number: 100 + i,
      shortId: `WC-${i}`,
      labels: ["sentry:verdict-code-fix"],
      comments: [{ body: verdictComment({ summary: "<".repeat(300) }) }],
    }),
  );
  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });

  const sectionBlocks = payload.blocks.slice(1);
  assert(
    sectionBlocks.length >= 2,
    "expected the routed lines split across sections",
  );
  for (const block of payload.blocks) {
    assert(
      block.text.text.length <= MAX_SECTION_TEXT_LEN,
      `expected every section under the ${MAX_SECTION_TEXT_LEN}-char budget, got ${block.text.text.length}`,
    );
  }
  // No line lost and order preserved across the chunk boundaries.
  const lineIds = sectionBlocks
    .flatMap((block) => block.text.text.split("\n"))
    .map((line) => /^• <[^|]+\|(WC-\d+)>/.exec(line)?.[1])
    .filter(Boolean);
  assertDeepEqual(lineIds, ["WC-0", "WC-1", "WC-2", "WC-3", "WC-4", "WC-5"]);
});

await test("buildDigest keeps long needs-human briefs under the per-section cap", () => {
  // Six needs-human briefs whose every field is a long all-`<` string — the
  // brief renderer must keep each section text object under the Slack cap.
  const big = "<".repeat(500);
  const issues = Array.from({ length: 6 }, (_, i) =>
    issueFixture({
      number: 200 + i,
      shortId: `NH-${i}`,
      labels: ["sentry:verdict-needs-human"],
      comments: [
        {
          body: verdictComment({
            verdict: "needs-human",
            humanQuestion: big,
            hypotheses: [big, big],
            investigated: [big, big],
            escalationReason: big,
          }),
        },
      ],
    }),
  );
  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });
  for (const block of payload.blocks) {
    assert(
      block.text.text.length <= MAX_SECTION_TEXT_LEN,
      `expected every section under the cap, got ${block.text.text.length}`,
    );
  }
  // Every brief's decision line survived (6 briefs, order preserved).
  const decisions = allText(payload).match(/\*Decision needed:\*/g) ?? [];
  assertEqual(decisions.length, 6);
});

await test("chunkBriefs packs whole briefs and splits only oversized single entries", () => {
  // Whole-group packing under the budget.
  assertDeepEqual(chunkBriefs("*H*", [["a"], ["b"]], 100), ["*H*\na\n\nb"]);
  // Second brief would overflow -> new chunk at the ENTRY boundary.
  assertDeepEqual(
    chunkBriefs(
      "*H*",
      [
        ["aaaa", "bbbb"],
        ["cccc", "dddd"],
      ],
      16,
    ),
    ["*H*\naaaa\nbbbb", "cccc\ndddd"],
  );
  // A single oversized brief gets its own block(s), line-split, never packed
  // with a neighbor.
  assertDeepEqual(
    chunkBriefs("*H*", [["x"], ["y".repeat(30), "z".repeat(30)], ["w"]], 40),
    ["*H*\nx", "y".repeat(30), "z".repeat(30), "w"],
  );
  // No briefs -> just the header.
  assertDeepEqual(chunkBriefs("*H*", [], 100), ["*H*"]);
});

await test("needs-human briefs never split across Slack blocks mid-entry", () => {
  // Two ~1.8k-char briefs (no escape expansion — plain chars) against the
  // 2800-char budget: greedy LINE packing would put the section header + brief
  // 1 + the first lines of brief 2 into block one, splitting brief 2 mid-entry.
  // Entry-boundary chunking must instead emit whole briefs per block.
  const filler = "z".repeat(350);
  const issues = Array.from({ length: 2 }, (_, i) =>
    issueFixture({
      number: 300 + i,
      shortId: `NH-${i}`,
      labels: ["sentry:verdict-needs-human"],
      comments: [
        {
          body: verdictComment({
            verdict: "needs-human",
            humanQuestion: filler,
            hypotheses: [filler],
            investigated: [filler],
            escalationReason: filler,
          }),
        },
      ],
    }),
  );
  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });
  const briefBlocks = payload.blocks
    .slice(1)
    .map((block) => block.text.text)
    .filter((text) => text.includes("*Decision needed:*"));
  assert(briefBlocks.length >= 2, "expected the two briefs split into blocks");
  for (const text of briefBlocks) {
    assert(text.length <= MAX_SECTION_TEXT_LEN, "expected under the budget");
    // A block contains only WHOLE briefs: every brief header line ("• *<…")
    // is matched by its closing links line — a mid-entry split would strand a
    // header without links (or links without a header) in some block.
    const headers = text.match(/^• \*/gm) ?? [];
    const linksLines = text.match(/\*Links:\*/g) ?? [];
    assertEqual(headers.length, linksLines.length);
    assert(headers.length >= 1, "expected at least one whole brief per block");
  }
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
      body: queueBody(),
      labels: [{ name: "sentry:verdict-code-fix" }],
      comments: [{ body: verdictComment({ summary: `sum ${number}` }) }],
    });
  };

  const issues = await collectIssues("o/r", [11, 22], { runGh });
  assertEqual(issues.length, 2);
  assertEqual(issues[0].number, 11);
  assertDeepEqual(issues[0].labels, ["sentry:verdict-code-fix"]);
  assertEqual(calls[0][0], "issue");
  assertEqual(calls[0][1], "view");
  // The digest now reads `body` too (needs-human Sentry permalink).
  assert(
    calls[0].includes("number,title,url,body,labels,comments"),
    "json fields include body",
  );
  const repoFlagIndex = calls[0].indexOf("--repo");
  assert(repoFlagIndex !== -1, "expected --repo flag in gh args");
  assertEqual(calls[0][repoFlagIndex + 1], "o/r");
  assertEqual(calls[1][calls[1].indexOf("--repo") + 1], "o/r");

  const payload = buildDigest(issues, { channel: "#engineering", now: NOW });
  assertEqual(payload.text, "Sentry triage — 2 issues triaged");
});

await test("collectIssues propagates a single fetch failure (fail loud, no silent drop)", async () => {
  const runGh = async (args) => {
    if (args[2] === "22") throw new Error("gh issue view failed: HTTP 502");
    return JSON.stringify({
      number: Number(args[2]),
      title: `[sentry] X-${args[2]} (app-mento-org, error)`,
      url: `https://github.com/o/r/issues/${args[2]}`,
      body: "",
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
