#!/usr/bin/env node
import {
  ALLOWED_OWNING_REPOS,
  bodyBacklinksShortId,
  buildAliasComment,
  buildProjectedBody,
  buildProjectedTitle,
  buildProjectionMarker,
  commentBacklinksShortId,
  defangBackticks,
  defangHtmlComments,
  defangMentions,
  extractPermalink,
  extractYamlBlock,
  isTrustedComment,
  isValidShortId,
  leadingProjectionMarkers,
  neutralizeBlock,
  neutralizeUntrusted,
  parseArgs,
  parseShortId,
  parseVerdictComment,
  PROJECTED_LABEL,
  runParseOnly,
  runProjection,
  runProjectionBatch,
  sanitizeDuplicateIds,
  sanitizeFreeText,
  selectVerdictComment,
  validateAffectedRepo,
  VERDICT_MARKER,
  VERDICT_TO_LABEL,
} from "./sentry-triage-project.mjs";

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

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected promise to reject");
}

// Build a verdict comment body the way the triage agent would.
function verdictComment({
  verdict = "code-fix",
  confidence = "medium",
  affectedRepo = "mento-protocol/frontend-monorepo",
  summary = "A short summary",
  rootCause = "  Some abstract root cause.\n  Second line.",
  proposedAction = "  Some abstract action.",
  duplicates = "[]",
} = {}) {
  return [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict} # code-fix | config-fix | upstream-transient | needs-human`,
    `confidence: ${confidence} # high | medium | low`,
    `affected_repo: ${affectedRepo}`,
    `summary: ${summary}`,
    "root_cause: |",
    rootCause,
    "proposed_action: |",
    proposedAction,
    `duplicate_of: ${duplicates}`,
    "```",
    "",
    "Prose diagnosis goes here.",
  ].join("\n");
}

const PERMALINK = "https://mento-labs.sentry.io/issues/6197137101/";

// Comments as `gh issue view --json comments` (GraphQL) returns them:
// pipeline-authored comments resolve to the Actions bot login "github-actions"
// (verified empirically on live queue issues, e.g. monitoring-monorepo#1318).
const BOT_AUTHOR = { login: "github-actions" };
function botComment(body, createdAt) {
  return { body, createdAt, author: BOT_AUTHOR };
}

function queueIssue({
  number = 500,
  shortId = "APP-MENTO-ORG-12",
  project = "app-mento-org",
  labels = ["sentry-triage", "sentry:verdict-code-fix"],
  state = "OPEN",
  comments,
} = {}) {
  return {
    number,
    state,
    title: `[sentry] ${shortId} (${project}, error)`,
    body: [
      "<!-- sentry-triage:v1 -->",
      "",
      "```yaml",
      `short_id: "${shortId}"`,
      `permalink: "${PERMALINK}"`,
      "```",
      "",
      `[View in Sentry](${PERMALINK})`,
    ].join("\n"),
    url: `https://github.com/mento-protocol/monitoring-monorepo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    comments: comments ?? [
      botComment(verdictComment(), "2026-07-17T10:00:00Z"),
    ],
  };
}

// The login `gh api user` resolves for the projection PAT in tests — genuine
// projected-issue fixtures carry it as their author.
const PROJECTOR_LOGIN = "sentry-projector-bot";
const PROJECTOR_AUTHOR = { login: PROJECTOR_LOGIN };

// A mock `gh` runner covering the calls runProjection makes. Records every call
// with the token it was invoked under so token routing is assertable. `stubs`
// (number -> queue issue) serves batch mode's per-issue ambient views.
function makeRunGh({
  issue,
  stubs = null,
  existing = [],
  createdUrl = null,
  projectorLogin = PROJECTOR_LOGIN,
} = {}) {
  const calls = [];
  const runGh = async (args, opts = {}) => {
    calls.push({ args, token: opts.token ?? null });
    const [a0, a1] = args;
    if (a0 === "api" && a1 === "user") {
      return `${projectorLogin}\n`;
    }
    if (a0 === "issue" && a1 === "view") {
      // A token means an OWNING-repo view (hasAliasComment's `--json
      // comments` read); resolve it from the `existing` fixtures by issue
      // number (each fixture may carry a `comments` array). Ambient views
      // read the queue stub.
      if (opts.token) {
        const found = existing.find(
          (e) => String(e.number) === String(args[2]),
        );
        return JSON.stringify({ comments: found?.comments ?? [] });
      }
      return JSON.stringify(stubs?.[String(args[2])] ?? issue);
    }
    if (a0 === "issue" && a1 === "list") {
      // Model GitHub search: the dedicated alias-phrase query only matches
      // issues that actually have a comment containing the phrase; the
      // body-oriented query returns every fixture.
      const query = String(args[args.indexOf("--search") + 1] ?? "");
      if (query.includes("Also tracking Sentry")) {
        const withAliasComments = existing.filter((e) =>
          (e.comments ?? []).some((c) =>
            String(c?.body ?? "").includes("Also tracking Sentry"),
          ),
        );
        return JSON.stringify(
          withAliasComments.map(({ comments: _comments, ...rest }) => rest),
        );
      }
      return JSON.stringify(existing);
    }
    if (a0 === "issue" && a1 === "create") {
      if (createdUrl == null)
        throw new Error("gh issue create failed: HTTP 403");
      return `${createdUrl}\n`;
    }
    if (
      a0 === "issue" &&
      (a1 === "edit" || a1 === "comment" || a1 === "reopen")
    ) {
      return "";
    }
    if (a0 === "label" && a1 === "create") {
      // runProjectionBatch's idempotent self-heal of sentry:projected.
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

const PAT = "ghp_projection_token";
const CREATED_URL =
  "https://github.com/mento-protocol/frontend-monorepo/issues/999";

// ---------------------------------------------------------------------------
// Neutralization
// ---------------------------------------------------------------------------

await test("sanitizeFreeText collapses control chars/newlines to single spaces", () => {
  assertEqual(sanitizeFreeText("a\nb\tc   d"), "a b c d");
});

await test("defangBackticks replaces every backtick with a look-alike", () => {
  const out = defangBackticks("```yaml evil ` fence");
  assert(!out.includes("`"), "expected no real backticks");
});

await test("defangMentions inserts a zero-width space after every @", () => {
  const out = defangMentions("@channel and @org/team");
  assert(
    !/@[a-z]/i.test(out),
    "expected no live mention (@ followed by a letter)",
  );
  assert(out.includes("@​"), "expected zero-width space after @");
});

await test("neutralizeUntrusted defangs mentions + backticks and single-lines", () => {
  const out = neutralizeUntrusted("`x`\n@here <b>");
  assert(!out.includes("`"), "expected backticks defanged");
  assert(!out.includes("\n"), "expected single line");
  assert(out.includes("@​"), "expected mention defanged");
});

await test("neutralizeBlock keeps newlines but defangs and bounds", () => {
  const out = neutralizeBlock("line one\n```\n@here\nline four");
  assert(out.includes("\n"), "expected newlines preserved");
  assert(!out.includes("`"), "expected backticks defanged");
  assert(out.includes("@​"), "expected mention defanged");
});

await test("neutralizeBlock hard-bounds line count and length", () => {
  const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  assert(
    neutralizeBlock(manyLines).split("\n").length <= 8,
    "expected <=8 lines",
  );
  const long = "z".repeat(2000);
  assert(
    neutralizeBlock(long).length <= 601,
    "expected length bound + ellipsis",
  );
});

// ---------------------------------------------------------------------------
// Title / short id / permalink parsing
// ---------------------------------------------------------------------------

await test("parseShortId extracts the short id from a v2 queue title", () => {
  assertEqual(
    parseShortId(
      "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
    ),
    "GOVERNANCE-MENTO-ORG-51",
  );
  assertEqual(parseShortId("not a queue title"), null);
});

await test("isValidShortId accepts Sentry short ids and rejects junk", () => {
  assert(isValidShortId("APP-MENTO-ORG-12"), "expected valid");
  assert(!isValidShortId("has space"), "expected space rejected");
  assert(!isValidShortId("with/slash"), "expected slash rejected");
  assert(!isValidShortId(""), "expected empty rejected");
  assert(!isValidShortId("`inject`"), "expected backtick rejected");
  // Sentry short ids are always <PROJECT-SLUG>-<SUFFIX> with a base-36
  // suffix, so alphanumeric suffixes must validate while a bare common word
  // must not (every accepted value can drive an owning-repo search).
  assert(isValidShortId("APP-MENTO-ORG-2S"), "expected base-36 suffix valid");
  assert(!isValidShortId("Sentry"), "expected a bare word rejected");
});

await test("extractPermalink returns the permalink only for an https sentry.io url", () => {
  assertEqual(
    extractPermalink(`short_id: "X"\npermalink: "${PERMALINK}"`),
    PERMALINK,
  );
  assertEqual(
    extractPermalink('permalink: "https://evil.example.com/x"'),
    null,
  );
  assertEqual(extractPermalink("no permalink here"), null);
});

// ---------------------------------------------------------------------------
// Verdict-comment parsing (richer than digest)
// ---------------------------------------------------------------------------

await test("extractYamlBlock pulls the fenced yaml block only", () => {
  const block = extractYamlBlock(verdictComment());
  assert(block.includes("verdict: code-fix"), "expected verdict line");
  assert(!block.includes("Prose diagnosis"), "expected prose excluded");
});

await test("parseVerdictComment reads all verdict-contract fields", () => {
  const parsed = parseVerdictComment(
    verdictComment({
      verdict: "config-fix",
      confidence: "high",
      affectedRepo: "mento-protocol/minipay-dapp",
      summary: "CSP allowlist missing a domain # not a comment",
      rootCause: "  Missing directive.\n  Blocked a script host.",
      proposedAction: "  Add the host to the CSP allowlist.",
      duplicates: "[MINIPAY-DAPP-3, MINIPAY-DAPP-9]",
    }),
  );
  assertEqual(parsed.verdict, "config-fix");
  assertEqual(parsed.confidence, "high");
  assertEqual(parsed.affectedRepo, "mento-protocol/minipay-dapp");
  assertEqual(parsed.summary, "CSP allowlist missing a domain # not a comment");
  assertEqual(parsed.rootCause, "Missing directive.\nBlocked a script host.");
  assertEqual(parsed.proposedAction, "Add the host to the CSP allowlist.");
  assertDeepEqual(parsed.duplicateOf, ["MINIPAY-DAPP-3", "MINIPAY-DAPP-9"]);
});

await test("parseVerdictComment rejects out-of-enum verdict/confidence to null", () => {
  const parsed = parseVerdictComment(
    verdictComment({ verdict: "totally-bogus", confidence: "certain" }),
  );
  assertEqual(parsed.verdict, null);
  assertEqual(parsed.confidence, null);
});

await test("parseVerdictComment extracts a bare repo slug from affected_repo, else empty", () => {
  assertEqual(
    parseVerdictComment(verdictComment({ affectedRepo: "not-a-repo" }))
      .affectedRepo,
    "",
  );
});

await test("parseVerdictComment reads a block-style duplicate_of list", () => {
  const body = [
    VERDICT_MARKER,
    "```yaml",
    "verdict: code-fix",
    "confidence: low",
    "affected_repo: mento-protocol/frontend-monorepo",
    "summary: x",
    "duplicate_of:",
    "  - APP-MENTO-ORG-1",
    "  - APP-MENTO-ORG-2",
    "```",
  ].join("\n");
  assertDeepEqual(parseVerdictComment(body).duplicateOf, [
    "APP-MENTO-ORG-1",
    "APP-MENTO-ORG-2",
  ]);
});

await test("parseVerdictComment tolerates trailing yaml comments on duplicate_of (documented example shape)", () => {
  // The verdict contract's own documented example carries a trailing comment
  // that itself contains an ID-like token — the bracketed segment must parse
  // and the comment must be ignored, not leak into the list.
  const docExample = [
    VERDICT_MARKER,
    "```yaml",
    "verdict: code-fix",
    "confidence: low",
    "affected_repo: mento-protocol/frontend-monorepo",
    "summary: x",
    "duplicate_of: [] # list of Sentry SHORT-IDs (e.g. GOVERNANCE-MENTO-ORG-51), possibly empty",
    "```",
  ].join("\n");
  assertDeepEqual(parseVerdictComment(docExample).duplicateOf, []);

  const withIds = docExample.replace(
    "duplicate_of: [] #",
    "duplicate_of: [MINIPAY-DAPP-3, MINIPAY-DAPP-9] #",
  );
  assertDeepEqual(parseVerdictComment(withIds).duplicateOf, [
    "MINIPAY-DAPP-3",
    "MINIPAY-DAPP-9",
  ]);

  // Only a boundary-valid comment is tolerated after the bracket — any other
  // trailing garbage rejects the list rather than normalizing malformed yaml
  // into valid-looking duplicate ids.
  const garbage = docExample.replace(
    "duplicate_of: [] # list of Sentry SHORT-IDs (e.g. GOVERNANCE-MENTO-ORG-51), possibly empty",
    "duplicate_of: [APP-1] this is not valid YAML",
  );
  assertDeepEqual(parseVerdictComment(garbage).duplicateOf, []);
});

await test("affected_repo must be the exact whole value — no substring extraction", () => {
  // "not <repo>" must NOT extract the allowlisted slug and project.
  assertEqual(
    parseVerdictComment(
      verdictComment({
        affectedRepo: "not mento-protocol/frontend-monorepo",
      }),
    ).affectedRepo,
    "",
  );
  // A trailing yaml comment and surrounding quotes are tolerated.
  assertEqual(
    parseVerdictComment(
      verdictComment({
        affectedRepo: "mento-protocol/frontend-monorepo # main app",
      }),
    ).affectedRepo,
    "mento-protocol/frontend-monorepo",
  );
  assertEqual(
    parseVerdictComment(
      verdictComment({ affectedRepo: '"mento-protocol/minipay-dapp"' }),
    ).affectedRepo,
    "mento-protocol/minipay-dapp",
  );
  // A `#` without a whitespace boundary is part of the scalar (malformed),
  // not a comment — it must not be normalized into an allowlisted repo.
  assertEqual(
    parseVerdictComment(
      verdictComment({
        affectedRepo: "mento-protocol/frontend-monorepo#garbage",
      }),
    ).affectedRepo,
    "",
  );
});

await test("sanitizeDuplicateIds drops junk, deduplicates, and bounds rendering", () => {
  assertDeepEqual(
    sanitizeDuplicateIds(["APP-1", "has space", "`inject`", "OK-2", "APP-1"]),
    ["APP-1", "OK-2"],
  );
  // Rendering/memory bound; the tighter LOOKUP budget (MAX_DUPLICATE_LOOKUPS)
  // is applied in runProjection AFTER self-exclusion.
  const many = Array.from({ length: 30 }, (_, i) => `DUP-${i}`);
  assertEqual(sanitizeDuplicateIds(many).length, 20);
});

// ---------------------------------------------------------------------------
// Comment selection: authorship trust boundary + regression fence (the single
// authoritative path shared by the workflow label step and projection)
// ---------------------------------------------------------------------------

await test("isTrustedComment accepts both bot login shapes, rejects others and missing", () => {
  assert(
    isTrustedComment({ author: { login: "github-actions" } }),
    "expected GraphQL bot login trusted",
  );
  assert(
    isTrustedComment({ user: { login: "github-actions[bot]" } }),
    "expected REST bot login trusted",
  );
  assert(
    !isTrustedComment({ author: { login: "drive-by-user" } }),
    "expected other author untrusted",
  );
  assert(!isTrustedComment({}), "expected missing author to fail closed");
});

await test("selectVerdictComment returns the newest verdict comment", () => {
  const comments = [
    botComment(verdictComment({ summary: "older" }), "2026-07-17T09:00:00Z"),
    botComment("chatter", "2026-07-17T09:30:00Z"),
    botComment(verdictComment({ summary: "newest" }), "2026-07-17T10:00:00Z"),
  ];
  const selected = selectVerdictComment(comments);
  assert(selected.body.includes("summary: newest"), "expected newest verdict");
});

await test("selectVerdictComment ignores marker comments from untrusted authors", () => {
  // A drive-by public commenter pasting a marker-bearing comment must not be
  // able to drive labeling/closing/projection.
  const comments = [
    {
      body: verdictComment({ summary: "hostile" }),
      createdAt: "2026-07-17T10:00:00Z",
      author: { login: "drive-by-user" },
    },
  ];
  assertDeepEqual(selectVerdictComment(comments), {
    body: null,
    reason: "no-verdict-comment",
  });
});

await test("selectVerdictComment keeps the bot verdict over a NEWER hostile marker comment", () => {
  const comments = [
    botComment(verdictComment({ summary: "legit" }), "2026-07-17T09:00:00Z"),
    {
      body: verdictComment({ summary: "hostile override" }),
      createdAt: "2026-07-17T10:00:00Z",
      author: { login: "attacker" },
    },
  ];
  const selected = selectVerdictComment(comments);
  assert(
    selected.body.includes("summary: legit"),
    "expected the bot verdict, not the hostile override",
  );
});

await test("a hostile regression comment cannot stale-out a bot verdict", () => {
  // The regression fence only honors regression comments the ingest bot
  // posted — an attacker must not be able to DoS labeling by pasting one.
  const comments = [
    botComment(verdictComment({ summary: "legit" }), "2026-07-17T09:00:00Z"),
    {
      body: "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      createdAt: "2026-07-17T10:00:00Z",
      author: { login: "attacker" },
    },
  ];
  const selected = selectVerdictComment(comments);
  assert(
    selected.body !== null && selected.body.includes("summary: legit"),
    "expected the bot verdict still selected",
  );
});

await test("selectVerdictComment rejects a stale pre-regression verdict", () => {
  const comments = [
    botComment(verdictComment(), "2026-07-17T09:00:00Z"),
    botComment(
      "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      "2026-07-17T10:00:00Z",
    ),
  ];
  const selected = selectVerdictComment(comments);
  assertEqual(selected.body, null);
  assertEqual(selected.reason, "stale-verdict");
});

await test("selectVerdictComment accepts a fresh post-regression verdict", () => {
  const comments = [
    botComment(verdictComment({ summary: "old" }), "2026-07-17T09:00:00Z"),
    botComment(
      "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
      "2026-07-17T10:00:00Z",
    ),
    botComment(verdictComment({ summary: "fresh" }), "2026-07-17T12:00:00Z"),
  ];
  const selected = selectVerdictComment(comments);
  assert(
    selected.body.includes("summary: fresh"),
    "expected fresh verdict accepted",
  );
});

await test("selectVerdictComment reports no-verdict-comment when none present", () => {
  assertDeepEqual(selectVerdictComment([botComment("hi", "x")]), {
    body: null,
    reason: "no-verdict-comment",
  });
});

// ---------------------------------------------------------------------------
// Allowlist validation
// ---------------------------------------------------------------------------

await test("validateAffectedRepo accepts each allowlisted owning repo", () => {
  for (const repo of ALLOWED_OWNING_REPOS) {
    const check = validateAffectedRepo(repo);
    assert(check.projectable, `expected ${repo} projectable`);
    assertEqual(check.repo, repo);
    assertEqual(check.warning, null);
  }
});

await test("validateAffectedRepo treats this repo as non-projectable, no warning", () => {
  const check = validateAffectedRepo("mento-protocol/monitoring-monorepo");
  assert(!check.projectable, "expected not projectable");
  assertEqual(check.reason, "local-repo");
  assertEqual(check.warning, null);
});

await test("validateAffectedRepo warns and refuses an unrecognized repo", () => {
  const check = validateAffectedRepo("attacker/evil-repo");
  assert(!check.projectable, "expected not projectable");
  assertEqual(check.reason, "unrecognized-repo");
  assert(
    check.warning && check.warning.includes("not in the projection allowlist"),
    "expected warning",
  );
  assertEqual(check.repo, "mento-protocol/monitoring-monorepo");
});

await test("validateAffectedRepo warns on an empty affected_repo", () => {
  const check = validateAffectedRepo("");
  assert(!check.projectable, "expected not projectable");
  assert(check.warning.includes("(empty)"), "expected empty warning");
});

// ---------------------------------------------------------------------------
// Idempotency marker
// ---------------------------------------------------------------------------

await test("bodyBacklinksShortId matches only a first-line-anchored marker", () => {
  const marker = buildProjectionMarker("APP-MENTO-ORG-12");
  assert(
    marker.includes("sentry-projection:v1 APP-MENTO-ORG-12"),
    "expected marker text",
  );
  // Genuine header-anchored marker (buildProjectedBody's shape) matches,
  // including with leading blank lines/whitespace.
  assert(
    bodyBacklinksShortId(`${marker}\nrest of body`, "APP-MENTO-ORG-12"),
    "expected first-line marker match",
  );
  assert(
    bodyBacklinksShortId(`\n\n  ${marker}\nrest`, "APP-MENTO-ORG-12"),
    "expected match past leading blank lines",
  );
  assert(
    !bodyBacklinksShortId("no marker", "APP-MENTO-ORG-12"),
    "expected no match",
  );
  assert(
    !bodyBacklinksShortId(marker, "bad id"),
    "expected invalid short id rejected",
  );
});

await test("bodyBacklinksShortId ignores a marker-shaped sequence embedded mid-body", () => {
  // A spoofed marker inside an UNRELATED issue's rendered text must not
  // satisfy the idempotency check — that would close the spoofed SHORT-ID's
  // stub as "reused" without ever filing an issue for it.
  const spoofed = buildProjectionMarker("SPOOFED-ID-1");
  const unrelatedBody = [
    buildProjectionMarker("APP-MENTO-ORG-12"),
    "",
    `**Summary**: attacker text ${spoofed} more text`,
  ].join("\n");
  assert(
    !bodyBacklinksShortId(unrelatedBody, "SPOOFED-ID-1"),
    "expected mid-body spoofed marker ignored",
  );
  assert(
    bodyBacklinksShortId(unrelatedBody, "APP-MENTO-ORG-12"),
    "expected the genuine first-line marker still matched",
  );
});

await test("leadingProjectionMarkers reads the contiguous leading block only", () => {
  const body = [
    buildProjectionMarker("MAIN-1"),
    buildProjectionMarker("ALIAS-2"),
    "",
    `content ${buildProjectionMarker("SPOOF-3")} more`,
  ].join("\n");
  assertDeepEqual(leadingProjectionMarkers(body), ["MAIN-1", "ALIAS-2"]);
  assertDeepEqual(leadingProjectionMarkers("no markers"), []);
});

await test("buildAliasComment anchors the marker first-line with a visible searchable note", () => {
  const stubUrl =
    "https://github.com/mento-protocol/monitoring-monorepo/issues/500";
  const alias = buildAliasComment({
    shortId: "ALIAS-2",
    queueIssueUrl: stubUrl,
    verdict: "code-fix",
    confidence: "medium",
    summary: "New occurrence summary",
    rootCause: "Its own root cause.",
    proposedAction: "Its own proposed action.",
  });
  assertEqual(alias.split("\n")[0], buildProjectionMarker("ALIAS-2"));
  // The visible note carries the SHORT-ID + footer phrase (so the
  // in:body,comments search pre-filter matches on visible text) + stub link.
  assert(
    alias.includes("Also tracking Sentry `ALIAS-2`"),
    "expected the visible alias note",
  );
  assert(
    alias.includes("Sentry triage pipeline"),
    "expected the footer search phrase",
  );
  assert(alias.includes(stubUrl), "expected the queue-stub back-link");
  // duplicate_of is a FAMILY signal, not a confirmed exact duplicate — the
  // new occurrence's rendered verdict fields must not be discarded, and the
  // note invites splitting a genuinely distinct finding into its own issue.
  assert(
    alias.includes("New occurrence summary"),
    "expected the new occurrence's summary",
  );
  assert(alias.includes("Its own root cause."), "expected the root cause");
  assert(
    alias.includes("Its own proposed action."),
    "expected the proposed action",
  );
  assert(alias.includes("`code-fix`"), "expected the verdict");
  assert(
    alias.includes("split it into its own issue"),
    "expected the split-out invitation",
  );
  // Round-trip through the alias predicate.
  assert(
    commentBacklinksShortId(alias, "ALIAS-2"),
    "expected the alias comment to match its own id",
  );
  assert(
    !commentBacklinksShortId(alias, "OTHER-9"),
    "expected an unrelated id rejected",
  );
  // Agent-derived fields are neutralized like the projected body.
  const hostile = buildAliasComment({
    shortId: "ALIAS-2",
    queueIssueUrl: stubUrl,
    verdict: "code-fix",
    confidence: "low",
    summary: "@channel ```js breakout",
    rootCause: "```\n@here\n```",
    proposedAction: "",
  });
  assert(!hostile.includes("@channel"), "expected mention defanged");
  assert(!hostile.includes("```js"), "expected agent fence defanged");
});

await test("commentBacklinksShortId requires the first-line anchor", () => {
  const spoofMidComment = `chatter\n${buildProjectionMarker("EVIL-1")}`;
  assert(
    !commentBacklinksShortId(spoofMidComment, "EVIL-1"),
    "expected a mid-comment marker rejected",
  );
  assert(
    commentBacklinksShortId(`\n${buildProjectionMarker("OK-1")}\ntext`, "OK-1"),
    "expected leading blanks tolerated",
  );
});

await test("defangHtmlComments breaks HTML-comment openers", () => {
  const out = defangHtmlComments("<!-- sentry-projection:v1 EVIL-1 -->");
  assert(!out.includes("<!--"), "expected opener broken");
  assert(
    out.includes("sentry-projection:v1 EVIL-1"),
    "expected text kept visible",
  );
});

await test("buildProjectedBody anchors its own marker first-line and defangs spoofed ones", () => {
  const spoofed = buildProjectionMarker("EVIL-1");
  const body = buildProjectedBody({
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "medium",
    summary: `legit summary ${spoofed}`,
    rootCause: `line\n${spoofed}`,
    proposedAction: "pa",
    duplicateOf: [],
    permalink: null,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  });
  // Structural invariant the anchored predicate relies on: the genuine marker
  // is the FIRST body line, and the whole body round-trips through the check.
  assertEqual(body.split("\n")[0], buildProjectionMarker("APP-MENTO-ORG-12"));
  assert(
    bodyBacklinksShortId(body, "APP-MENTO-ORG-12"),
    "expected built body to satisfy its own back-link check",
  );
  // The spoofed marker is defanged in every rendered field (no intact opener
  // anywhere past the genuine first-line marker) and can never match.
  assert(
    !body.slice(body.indexOf("\n")).includes("<!--"),
    "expected no intact HTML-comment opener beyond the first line",
  );
  assert(
    !bodyBacklinksShortId(body, "EVIL-1"),
    "expected spoofed short id not to match",
  );
});

// ---------------------------------------------------------------------------
// Projected issue rendering
// ---------------------------------------------------------------------------

await test("buildProjectedTitle escapes and bounds the summary", () => {
  assertEqual(
    buildProjectedTitle("Null deref in pool page"),
    "Sentry: Null deref in pool page",
  );
  const hostile = buildProjectedTitle("`@channel` " + "z".repeat(400));
  assert(!hostile.includes("`"), "expected backticks defanged");
  assert(hostile.includes("@​"), "expected mention defanged");
  assert(hostile.length <= 210, "expected bounded title");
});

await test("buildProjectedBody renders contract fields, links, footer, and marker", () => {
  const body = buildProjectedBody({
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "medium",
    summary: "Null deref rendering the pool header",
    rootCause: "Guard missing on an undefined pool.",
    proposedAction: "Add an early return when the pool is absent.",
    duplicateOf: ["APP-MENTO-ORG-13"],
    permalink: PERMALINK,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  });
  assert(
    body.includes(buildProjectionMarker("APP-MENTO-ORG-12")),
    "expected marker",
  );
  assert(body.includes("`code-fix`"), "expected verdict");
  assert(body.includes("(confidence: `medium`)"), "expected confidence");
  assert(
    body.includes("Null deref rendering the pool header"),
    "expected summary",
  );
  assert(
    body.includes("```text"),
    "expected fenced blocks for root cause / action",
  );
  assert(body.includes("`APP-MENTO-ORG-13`"), "expected duplicate id");
  assert(
    body.includes(`[View the error in Sentry](${PERMALINK})`),
    "expected sentry link",
  );
  assert(
    body.includes(
      "Central triage queue stub: https://github.com/mento-protocol/monitoring-monorepo/issues/500",
    ),
    "expected back-link",
  );
  assert(body.includes("ADR 0036 / ADR 0038"), "expected footer");
});

await test("buildProjectedBody renders the summary fenced (inert markdown) and bounded", () => {
  const base = {
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "medium",
    rootCause: "rc",
    proposedAction: "pa",
    duplicateOf: [],
    permalink: null,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  };
  // A markdown-image payload must land INSIDE a fenced block — never as live
  // markdown that would render (and fire the image request) in the owning
  // repo issue. Same inert treatment as root cause / proposed action.
  const img = "![exfil](https://evil.example/x.png)";
  const bodyImg = buildProjectedBody({ ...base, summary: img });
  assert(
    bodyImg.includes(`**Summary**\n\n\`\`\`text\n${img}`),
    "expected the summary rendered inside a text fence",
  );
  // Bounded like the other fenced fields: 600 chars via neutralizeBlock.
  const atLimit = "s".repeat(600);
  const bodyAt = buildProjectedBody({ ...base, summary: atLimit });
  assert(bodyAt.includes(atLimit), "expected 600-char summary intact");
  assert(
    !bodyAt.includes(`${atLimit}…`),
    "expected no ellipsis at the boundary",
  );
  const over = "x".repeat(800);
  const bodyOver = buildProjectedBody({ ...base, summary: over });
  assert(!bodyOver.includes(over), "expected over-limit summary truncated");
  assert(
    bodyOver.includes(`${"x".repeat(600)}…`),
    "expected 600-char prefix + ellipsis",
  );
  assert(!bodyOver.includes("x".repeat(601)), "expected nothing past the cap");
  // The alias comment fences its summary identically.
  const alias = buildAliasComment({
    shortId: "APP-MENTO-ORG-12",
    queueIssueUrl: base.queueIssueUrl,
    verdict: "code-fix",
    confidence: "low",
    summary: img,
    rootCause: "rc",
    proposedAction: "pa",
  });
  assert(
    alias.includes(`**Summary**\n\n\`\`\`text\n${img}`),
    "expected the alias summary fenced too",
  );
});

await test("buildProjectedBody neutralizes a hostile summary and fenced blocks", () => {
  const body = buildProjectedBody({
    shortId: "APP-MENTO-ORG-12",
    verdict: "code-fix",
    confidence: "low",
    summary: "@channel ping ```js\nrm -rf\n```",
    rootCause: "```\n@here breakout\n```",
    proposedAction: "",
    duplicateOf: [],
    permalink: null,
    queueIssueUrl:
      "https://github.com/mento-protocol/monitoring-monorepo/issues/500",
  });
  // No live mention (defang inserts a ZWSP, so the contiguous "@channel" is
  // gone) and no fence breakout (all backticks in agent text defanged).
  assert(!body.includes("@channel"), "expected no live @channel mention");
  assert(!body.includes("```js"), "expected no agent-supplied code fence");
  assert(
    body.includes("**Possible duplicate Sentry issues:** none"),
    "expected none for empty dups",
  );
  assert(
    body.includes("_(none provided)_"),
    "expected placeholder for empty action",
  );
  // permalink omitted when null.
  assert(
    !body.includes("View the error in Sentry"),
    "expected no sentry link when permalink null",
  );
});

// ---------------------------------------------------------------------------
// Orchestration (runProjection with a mocked gh runner)
// ---------------------------------------------------------------------------

await test("runProjection projects a code-fix for an external repo end-to-end", async () => {
  const { runGh, calls } = makeRunGh({
    issue: queueIssue(),
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
      // Mirrors the workflow: the label step's validated verdict comes back in.
      expectedVerdict: "code-fix",
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  assertEqual(result.url, CREATED_URL);

  const create = calls.find(
    (c) => c.args[0] === "issue" && c.args[1] === "create",
  );
  assert(create, "expected an issue create call");
  // Cross-repo create uses the PAT and targets the owning repo.
  assertEqual(create.token, PAT);
  assertEqual(
    create.args[create.args.indexOf("-R") + 1],
    "mento-protocol/frontend-monorepo",
  );

  // The idempotency search also used the PAT + owning repo, ANDs the quoted
  // SHORT-ID with the fixed footer phrase (sharp pre-filter), and pages deep
  // (200) so the real projected issue can't fall off the cap.
  const list = calls.find((c) => c.args[1] === "list");
  assertEqual(list.token, PAT);
  const searchQuery = list.args[list.args.indexOf("--search") + 1];
  assert(
    searchQuery.includes('"APP-MENTO-ORG-12"'),
    "expected quoted short id in search",
  );
  assert(
    searchQuery.includes('"Sentry triage pipeline"'),
    "expected footer phrase ANDed into search",
  );
  assertEqual(list.args[list.args.indexOf("--limit") + 1], "200");

  // Local stub mutations use the ambient token (null), never the PAT.
  const edit = calls.find((c) => c.args[1] === "edit");
  const comment = calls.find((c) => c.args[1] === "comment");
  assertEqual(edit.token, null);
  assertEqual(comment.token, null);
  assertEqual(
    edit.args[edit.args.indexOf("-R") + 1],
    "mento-protocol/monitoring-monorepo",
  );
  assert(
    edit.args.includes(PROJECTED_LABEL),
    "expected sentry:projected label add",
  );
  assert(
    comment.args.some((a) => a.includes(CREATED_URL)),
    "expected stub comment links the projected url",
  );
  // The read used the ambient token too.
  const view = calls.find((c) => c.args[1] === "view");
  assertEqual(view.token, null);
});

await test("runProjection projects config-fix as well", async () => {
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-config-fix"],
    comments: [
      botComment(
        verdictComment({
          verdict: "config-fix",
          affectedRepo: "mento-protocol/mento-analytics-api",
        }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({
    issue,
    createdUrl:
      "https://github.com/mento-protocol/mento-analytics-api/issues/7",
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  const create = calls.find(
    (c) => c.args[0] === "issue" && c.args[1] === "create",
  );
  assertEqual(
    create.args[create.args.indexOf("-R") + 1],
    "mento-protocol/mento-analytics-api",
  );
});

await test("runProjection is idempotent: reuses an existing OPEN back-linked issue without reopening", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: `${buildProjectionMarker("APP-MENTO-ORG-12")}\nrest of body`,
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
    },
  ];
  // Stub does not yet carry the projected label -> reused path still marks it.
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix"],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assertEqual(
    result.url,
    "https://github.com/mento-protocol/frontend-monorepo/issues/42",
  );
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected NO create on the reused path",
  );
  assert(
    !calls.some((c) => c.args[1] === "reopen"),
    "expected NO reopen for an already-open projection",
  );
  assert(
    calls.some((c) => c.args[1] === "edit"),
    "expected the stub still gets labeled",
  );
});

await test("runProjection reopens a CLOSED existing projection so the regression resurfaces", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: buildProjectionMarker("APP-MENTO-ORG-12"),
      state: "CLOSED",
      author: PROJECTOR_AUTHOR,
    },
  ];
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix"],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  // Reopen + fixed comment on the OWNING-repo issue, both under the PAT.
  const reopen = calls.find((c) => c.args[1] === "reopen");
  assert(reopen, "expected the closed projected issue to be reopened");
  assertEqual(reopen.token, PAT);
  assertEqual(reopen.args[2], "42");
  assertEqual(
    reopen.args[reopen.args.indexOf("-R") + 1],
    "mento-protocol/frontend-monorepo",
  );
  const owningComment = calls.find(
    (c) => c.args[1] === "comment" && c.token === PAT,
  );
  assert(owningComment, "expected a reopen comment on the owning-repo issue");
  assert(
    owningComment.args.some((a) => String(a).includes("regressed")),
    "expected the fixed regression-reopen text",
  );
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected NO create on the reused path",
  );
});

await test("runProjection propagates a failed reopen of a closed projection (fail loud)", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: buildProjectionMarker("APP-MENTO-ORG-12"),
      state: "CLOSED",
      author: PROJECTOR_AUTHOR,
    },
  ];
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix"],
  });
  const base = makeRunGh({ issue, existing });
  const runGh = async (args, opts) => {
    if (args[1] === "reopen")
      throw new Error("gh issue reopen failed: HTTP 403");
    return base.runGh(args, opts);
  };
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /reopen failed: HTTP 403/,
  );
});

await test("runProjection reused path skips the stub comment when already projected", async () => {
  const existing = [
    {
      number: 42,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/42",
      body: buildProjectionMarker("APP-MENTO-ORG-12"),
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
    },
  ];
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-code-fix", PROJECTED_LABEL],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assert(
    !calls.some((c) => c.args[1] === "comment"),
    "expected no duplicate stub comment",
  );
});

await test("runProjection resolves the projector identity under the PAT", async () => {
  const { runGh, calls } = makeRunGh({
    issue: queueIssue(),
    createdUrl: CREATED_URL,
  });
  await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  const apiUser = calls.find(
    (c) => c.args[0] === "api" && c.args[1] === "user",
  );
  assert(apiUser, "expected a gh api user identity call");
  assertEqual(apiUser.token, PAT);
});

await test("runProjection fails loud when the projector identity cannot be resolved", async () => {
  const { runGh } = makeRunGh({
    issue: queueIssue(),
    createdUrl: CREATED_URL,
    projectorLogin: "",
  });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /Could not resolve the projection token's own user login/,
  );
});

await test("runProjection ignores a hostile pre-created marker issue (wrong author) and files its own", async () => {
  // An attacker with Issues access in the owning repo pre-creates a
  // marker-shaped issue for this SHORT-ID. It must NOT steal the projection
  // slot: only issues authored by the projector identity count.
  const existing = [
    {
      number: 66,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/66",
      body: `${buildProjectionMarker("APP-MENTO-ORG-12")}\nattacker content`,
      state: "OPEN",
      author: { login: "attacker" },
    },
  ];
  const { runGh, calls } = makeRunGh({
    issue: queueIssue(),
    existing,
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  assertEqual(result.url, CREATED_URL);
  assert(
    !calls.some((c) => c.args[1] === "reopen"),
    "expected the hostile issue untouched",
  );
});

await test("runProjection coalesces onto an existing duplicate projection instead of filing twice", async () => {
  // Own SHORT-ID has no projection, but the verdict marks it a duplicate of
  // DUP-1 which DOES have a genuine one -> reuse it, comment the new
  // SHORT-ID onto it, and never create a second issue for the same bug.
  const dupUrl =
    "https://github.com/mento-protocol/frontend-monorepo/issues/77";
  const existing = [
    {
      number: 77,
      url: dupUrl,
      body: `${buildProjectionMarker("DUP-1")}\nrest`,
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
    },
  ];
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ duplicates: "[DUP-1]" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assertEqual(result.url, dupUrl);
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected NO second issue",
  );
  // The alias is ONE atomic comment append: first line is the marker (the
  // durable idempotency record — future regressions of the new SHORT-ID find
  // this issue even when their fresh verdict omits duplicate_of), followed by
  // the visible note with the SHORT-ID + stub back-link (so the
  // in:body,comments search pre-filter matches on visible text).
  const aliasComment = calls.find(
    (c) => c.args[1] === "comment" && c.token === PAT && c.args[2] === "77",
  );
  assert(aliasComment, "expected an alias comment on the reused issue");
  const aliasBody = aliasComment.args[aliasComment.args.indexOf("--body") + 1];
  assert(
    commentBacklinksShortId(aliasBody, "APP-MENTO-ORG-12"),
    "expected the marker-anchored alias comment",
  );
  assert(
    aliasBody.includes("Also tracking Sentry `APP-MENTO-ORG-12`"),
    "expected the visible alias note",
  );
  assert(
    aliasBody.includes("issues/500"),
    "expected the queue-stub back-link in the alias note",
  );
  // duplicate_of is a family signal, not a confirmed exact duplicate — the
  // new occurrence's rendered verdict fields ride along, nothing discarded.
  assert(
    aliasBody.includes("**Summary**") && aliasBody.includes("A short summary"),
    "expected the new occurrence's summary in the alias comment",
  );
  // No owning-repo BODY edit — comment appends are atomic, so parallel matrix
  // jobs coalescing different SHORT-IDs onto this issue cannot lose each
  // other's alias the way concurrent read-modify-write body edits could.
  assert(
    !calls.some((c) => c.args[1] === "edit" && c.token === PAT),
    "expected no owning-repo body edit",
  );
  // The stub still gets marked + linked locally.
  assert(
    calls.some((c) => c.args[1] === "edit" && c.token === null),
    "expected the stub labeled sentry:projected",
  );
});

await test("a persisted alias comment makes later lookups reuse directly, with no repeat comment", async () => {
  // The dup issue already carries the alias COMMENT from an earlier
  // coalescing run. The PRIMARY lookup for this SHORT-ID now matches it (via
  // the projector-authored alias-comment check), so the plain reused path
  // runs: no new comment — retries and regressions with changed/absent
  // duplicate_of never duplicate anything.
  const stubUrl =
    "https://github.com/mento-protocol/monitoring-monorepo/issues/500";
  const existing = [
    {
      number: 77,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/77",
      body: `${buildProjectionMarker("DUP-1")}\nrest`,
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
      comments: [
        {
          body: buildAliasComment({
            shortId: "APP-MENTO-ORG-12",
            queueIssueUrl: stubUrl,
            verdict: "code-fix",
            confidence: "medium",
            summary: "earlier occurrence",
            rootCause: "rc",
            proposedAction: "pa",
          }),
          author: PROJECTOR_AUTHOR,
        },
      ],
    },
  ];
  // Fresh verdict omits duplicate_of entirely — the alias alone must resolve.
  const issue = queueIssue({
    comments: [
      botComment(verdictComment({ duplicates: "[]" }), "2026-07-17T10:00:00Z"),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no create",
  );
  assert(
    !calls.some((c) => c.args[1] === "comment" && c.token === PAT),
    "expected no repeat coalescing comment",
  );
});

await test("a hostile alias comment (wrong author) cannot capture the lookup", async () => {
  // Same marker-anchored alias comment, but authored by an attacker with
  // Issues access — the alias check requires the projector identity, so the
  // lookup ignores it and a genuine projection is filed.
  const stubUrl =
    "https://github.com/mento-protocol/monitoring-monorepo/issues/500";
  const existing = [
    {
      number: 78,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/78",
      body: `${buildProjectionMarker("DUP-1")}\nrest`,
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
      comments: [
        {
          body: buildAliasComment({
            shortId: "APP-MENTO-ORG-12",
            queueIssueUrl: stubUrl,
            verdict: "code-fix",
            confidence: "medium",
            summary: "earlier occurrence",
            rootCause: "rc",
            proposedAction: "pa",
          }),
          author: { login: "attacker" },
        },
      ],
    },
  ];
  const issue = queueIssue({
    comments: [
      botComment(verdictComment({ duplicates: "[]" }), "2026-07-17T10:00:00Z"),
    ],
  });
  const { runGh, calls } = makeRunGh({
    issue,
    existing,
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  assert(
    calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected a genuine projection to be filed",
  );
});

await test("a genuine body-marker projection is found even when ranked last (cap only limits comment reads)", async () => {
  // Eleven projector-authored issues merely MENTION this SHORT-ID (rendered
  // "Possible duplicates" lists) and rank ahead of the genuine projection.
  // The cheap body-marker scan runs across ALL candidates before the capped
  // alias-comment reads, so the real projection is still found — no
  // duplicate filing.
  const decoys = Array.from({ length: 11 }, (_, i) => ({
    number: 400 + i,
    url: `https://github.com/mento-protocol/frontend-monorepo/issues/${400 + i}`,
    body: `${buildProjectionMarker(`OTHER-${i}`)}\n**Possible duplicate Sentry issues:** \`APP-MENTO-ORG-12\``,
    state: "OPEN",
    author: PROJECTOR_AUTHOR,
    comments: [],
  }));
  const genuine = {
    number: 499,
    url: "https://github.com/mento-protocol/frontend-monorepo/issues/499",
    body: `${buildProjectionMarker("APP-MENTO-ORG-12")}\nrest`,
    state: "OPEN",
    author: PROJECTOR_AUTHOR,
    comments: [],
  };
  const { runGh, calls } = makeRunGh({
    issue: queueIssue(),
    existing: [...decoys, genuine],
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assertEqual(result.url, genuine.url);
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no duplicate",
  );
  assert(
    !calls.some((c) => c.args[1] === "view" && c.token === PAT),
    "expected zero comment reads (body scan resolved it)",
  );
});

await test("duplicate lookups are bounded: capped dup list, self-excluded, capped candidate reads", async () => {
  // A hostile/verbose verdict names 30 duplicates (with repeats + the stub's
  // own id) and the pre-filter returns 12 projector-authored candidates that
  // never match. The total owning-repo traffic must stay bounded: 1 own +
  // ≤5 dup searches, and ≤10 comment reads per search.
  const dupList = `[${[
    "APP-MENTO-ORG-12", // own id — excluded
    ...Array.from({ length: 28 }, (_, i) => `DUP-${i % 14}`), // repeats
  ].join(", ")}]`;
  const existing = Array.from({ length: 12 }, (_, i) => ({
    number: 300 + i,
    url: `https://github.com/mento-protocol/frontend-monorepo/issues/${300 + i}`,
    body: "no marker here",
    state: "OPEN",
    author: PROJECTOR_AUTHOR,
    comments: [],
  }));
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ duplicates: dupList }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({
    issue,
    existing,
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  // Each lookup runs at most 2 searches (body-oriented + dedicated alias
  // phrase): 1 own + 5 dup lookups = 12 searches max, and here the alias
  // searches return nothing so zero per-candidate comment reads happen.
  const searches = calls.filter((c) => c.args[1] === "list" && c.token === PAT);
  assert(
    searches.length <= 12,
    `expected at most (1 own + 5 dups) x 2 searches, got ${searches.length}`,
  );
  const commentReads = calls.filter(
    (c) => c.args[1] === "view" && c.token === PAT,
  );
  assertEqual(commentReads.length, 0);
});

await test("a self-reference in duplicate_of cannot consume the lookup budget", async () => {
  // Reviewer scenario: duplicate_of = [SELF, DUP-1..DUP-5] and only DUP-5 has
  // an existing projection. The self id is excluded BEFORE the cap, so DUP-5
  // stays within budget and the projection is reused, not duplicated.
  const dupUrl =
    "https://github.com/mento-protocol/frontend-monorepo/issues/95";
  const existing = [
    {
      number: 95,
      url: dupUrl,
      body: `${buildProjectionMarker("DUP-5")}\nrest`,
      state: "OPEN",
      author: PROJECTOR_AUTHOR,
      comments: [],
    },
  ];
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({
          duplicates: "[APP-MENTO-ORG-12, DUP-1, DUP-2, DUP-3, DUP-4, DUP-5]",
        }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue, existing });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "reused");
  assertEqual(result.url, dupUrl);
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no duplicate",
  );
});

await test("an implausible alias-candidate count fails loud instead of truncating", async () => {
  // Eleven projector-authored issues all carry alias-phrase comments for this
  // SHORT-ID (hostile mimicry or pathological state). Truncating could skip
  // the genuine alias, so the lookup aborts into the compensation path.
  const stubUrl =
    "https://github.com/mento-protocol/monitoring-monorepo/issues/500";
  const existing = Array.from({ length: 11 }, (_, i) => ({
    number: 600 + i,
    url: `https://github.com/mento-protocol/frontend-monorepo/issues/${600 + i}`,
    body: `${buildProjectionMarker(`OTHER-${i}`)}\nrest`,
    state: "OPEN",
    author: PROJECTOR_AUTHOR,
    comments: [
      {
        body: buildAliasComment({
          shortId: "APP-MENTO-ORG-12",
          queueIssueUrl: stubUrl,
          verdict: "code-fix",
          confidence: "low",
          summary: "s",
          rootCause: "r",
          proposedAction: "p",
        }),
        author: { login: "attacker" },
      },
    ],
  }));
  const { runGh } = makeRunGh({ issue: queueIssue(), existing });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /refusing to risk missing the genuine alias/,
  );
});

await test("runProjection ignores a hostile duplicate projection (wrong author) and creates", async () => {
  const existing = [
    {
      number: 88,
      url: "https://github.com/mento-protocol/frontend-monorepo/issues/88",
      body: `${buildProjectionMarker("DUP-1")}\nattacker`,
      state: "OPEN",
      author: { login: "attacker" },
    },
  ];
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ duplicates: "[DUP-1]" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({
    issue,
    existing,
    createdUrl: CREATED_URL,
  });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "projected");
  assert(
    !calls.some((c) => c.args[1] === "comment" && c.token === PAT),
    "expected no comment on the hostile issue",
  );
});

await test("runProjection skips a non-actionable verdict (needs-human)", async () => {
  const issue = queueIssue({
    labels: ["sentry-triage", "sentry:verdict-needs-human"],
    comments: [
      botComment(
        verdictComment({ verdict: "needs-human" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-verdict");
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no create",
  );
});

await test("runProjection skips when affected_repo is this repo", async () => {
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ affectedRepo: "mento-protocol/monitoring-monorepo" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-repo");
  assertEqual(result.reason, "local-repo");
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no create",
  );
});

await test("runProjection skips an unrecognized affected_repo (no cross-repo write)", async () => {
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ affectedRepo: "attacker/evil-repo" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-repo");
  assertEqual(result.reason, "unrecognized-repo");
  assert(
    !calls.some(
      (c) =>
        (c.args[0] === "issue" && c.args[1] === "create") ||
        c.args[1] === "list",
    ),
    "expected no owning-repo calls",
  );
});

await test("runProjection no-ops gracefully without the projection token", async () => {
  const { runGh, calls } = makeRunGh({ issue: queueIssue() });
  const result = await runProjection(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssue: 500,
      projectionToken: "",
    },
    { runGh },
  );
  assertEqual(result.status, "skipped-no-token");
  assert(
    !calls.some((c) => c.args[0] === "issue" && c.args[1] === "create"),
    "expected no create without a token",
  );
});

await test("runProjection fails loud when there is no usable verdict comment", async () => {
  const issue = queueIssue({ comments: [{ body: "chatter", createdAt: "x" }] });
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /No usable verdict comment/,
  );
});

await test("runProjection fails loud on a stale pre-regression verdict", async () => {
  const issue = queueIssue({
    comments: [
      botComment(verdictComment(), "2026-07-17T09:00:00Z"),
      botComment(
        "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /stale-verdict/,
  );
});

await test("runProjection ignores a hostile-author verdict comment (fails loud, no writes)", async () => {
  const issue = queueIssue({
    comments: [
      {
        body: verdictComment(),
        createdAt: "2026-07-17T10:00:00Z",
        author: { login: "attacker" },
      },
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /No usable verdict comment/,
  );
  assert(
    !calls.some(
      (c) =>
        (c.args[0] === "issue" && c.args[1] === "create") ||
        c.args[1] === "list",
    ),
    "expected no owning-repo calls off a hostile comment",
  );
});

await test("runProjection fails loud on an out-of-enum verdict value (no silent skip)", async () => {
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ verdict: "totally-bogus" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /missing\/invalid verdict value/,
  );
});

await test("runProjection fails loud when its parse disagrees with the label step's verdict", async () => {
  // Pins the divergent-verdict case: the label step validated code-fix, but by
  // projection time the newest trusted comment parses as config-fix (e.g. a
  // fresh verdict landed between steps). Must FAIL (workflow compensation
  // path), never silently skip or project the wrong verdict.
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ verdict: "config-fix" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh, calls } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
        expectedVerdict: "code-fix",
      },
      { runGh },
    ),
    /Verdict mismatch/,
  );
  assert(
    !calls.some(
      (c) =>
        (c.args[0] === "issue" && c.args[1] === "create") ||
        c.args[1] === "list",
    ),
    "expected no cross-repo calls on a verdict mismatch",
  );
});

await test("runProjection fails loud when the queue title has no short id", async () => {
  const issue = queueIssue();
  issue.title = "totally unrelated title";
  const { runGh } = makeRunGh({ issue });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /no parseable Sentry short-ID/,
  );
});

await test("runProjection propagates a cross-repo create failure (fail loud)", async () => {
  const { runGh } = makeRunGh({ issue: queueIssue(), createdUrl: null });
  await assertRejects(
    runProjection(
      {
        localRepo: "mento-protocol/monitoring-monorepo",
        queueIssue: 500,
        projectionToken: PAT,
      },
      { runGh },
    ),
    /HTTP 403/,
  );
});

// ---------------------------------------------------------------------------
// --parse-only (the workflow label step's single authoritative parser)
// ---------------------------------------------------------------------------

await test("VERDICT_TO_LABEL encodes the upstream label/value asymmetry", () => {
  assertEqual(
    VERDICT_TO_LABEL["upstream-transient"],
    "sentry:verdict-upstream",
  );
  assertEqual(VERDICT_TO_LABEL["code-fix"], "sentry:verdict-code-fix");
  assertEqual(VERDICT_TO_LABEL["config-fix"], "sentry:verdict-config-fix");
  assertEqual(VERDICT_TO_LABEL["needs-human"], "sentry:verdict-needs-human");
});

await test("runParseOnly returns the validated verdict + mapped label + projectability", async () => {
  const { runGh, calls } = makeRunGh({ issue: queueIssue() });
  const result = await runParseOnly(
    { localRepo: "mento-protocol/monitoring-monorepo", queueIssue: 500 },
    { runGh },
  );
  assertDeepEqual(result, {
    verdict: "code-fix",
    label: "sentry:verdict-code-fix",
    projectable: true,
  });
  // Read-only: exactly one `gh issue view` with the ambient token.
  assertEqual(calls.length, 1);
  assertEqual(calls[0].args[1], "view");
  assertEqual(calls[0].token, null);
});

await test("runParseOnly reports an actionable-but-local verdict as not projectable", async () => {
  const local = queueIssue({
    comments: [
      botComment(
        verdictComment({ affectedRepo: "mento-protocol/monitoring-monorepo" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const result = await runParseOnly(
    { localRepo: "mento-protocol/monitoring-monorepo", queueIssue: 500 },
    { runGh: makeRunGh({ issue: local }).runGh },
  );
  assertEqual(result.projectable, false);
  assertEqual(result.verdict, "code-fix");
});

await test("runParseOnly maps upstream-transient to the asymmetric label", async () => {
  const issue = queueIssue({
    comments: [
      botComment(
        verdictComment({ verdict: "upstream-transient" }),
        "2026-07-17T10:00:00Z",
      ),
    ],
  });
  const { runGh } = makeRunGh({ issue });
  const result = await runParseOnly(
    { localRepo: "mento-protocol/monitoring-monorepo", queueIssue: 500 },
    { runGh },
  );
  assertDeepEqual(result, {
    verdict: "upstream-transient",
    label: "sentry:verdict-upstream",
    projectable: false,
  });
});

await test("runParseOnly fails loud on missing, hostile-author, stale, and invalid verdicts", async () => {
  const opts = {
    localRepo: "mento-protocol/monitoring-monorepo",
    queueIssue: 500,
  };
  const cases = [
    // No verdict comment at all.
    { comments: [botComment("chatter", "x")], pattern: /no-verdict-comment/ },
    // Marker comment from an untrusted author.
    {
      comments: [
        {
          body: verdictComment(),
          createdAt: "2026-07-17T10:00:00Z",
          author: { login: "attacker" },
        },
      ],
      pattern: /no-verdict-comment/,
    },
    // Stale pre-regression verdict.
    {
      comments: [
        botComment(verdictComment(), "2026-07-17T09:00:00Z"),
        botComment(
          "Regressed in Sentry (last seen 2026-07-17T11:00:00Z)",
          "2026-07-17T10:00:00Z",
        ),
      ],
      pattern: /stale-verdict/,
    },
    // Out-of-enum verdict value.
    {
      comments: [
        botComment(
          verdictComment({ verdict: "bogus-value" }),
          "2026-07-17T10:00:00Z",
        ),
      ],
      pattern: /missing\/invalid verdict value/,
    },
  ];
  for (const { comments, pattern } of cases) {
    const { runGh } = makeRunGh({ issue: queueIssue({ comments }) });
    await assertRejects(runParseOnly(opts, { runGh }), pattern);
  }
});

// ---------------------------------------------------------------------------
// --batch (the serialized project job's driver)
// ---------------------------------------------------------------------------

await test("batch mode: same-run duplicate family coalesces via the in-run registry (one create)", async () => {
  // Stub 500 (APP-MENTO-ORG-12) and stub 501 (APP-MENTO-ORG-77, verdict lists
  // 12 as a duplicate) are in the SAME batch. The owning-repo search returns
  // NOTHING for either (models GitHub's search-index lag on the seconds-old
  // created issue). Serial processing + the shared registry must still
  // coalesce: exactly one create, the second stub reuses it via an alias.
  const stubs = {
    500: queueIssue({ number: 500 }),
    501: queueIssue({
      number: 501,
      shortId: "APP-MENTO-ORG-77",
      comments: [
        botComment(
          verdictComment({ duplicates: "[APP-MENTO-ORG-12]" }),
          "2026-07-17T10:00:00Z",
        ),
      ],
    }),
  };
  const { runGh, calls } = makeRunGh({ stubs, createdUrl: CREATED_URL });
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [500, 501],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(rows.length, 2);
  assertEqual(rows[0].status, "projected");
  assertEqual(rows[0].url, CREATED_URL);
  assertEqual(rows[1].status, "reused");
  assertEqual(rows[1].url, CREATED_URL);
  const creates = calls.filter(
    (c) => c.args[0] === "issue" && c.args[1] === "create",
  );
  assertEqual(creates.length, 1);
  // The coalescing alias comment landed on the JUST-created issue (#999 from
  // the create URL), naming the second stub's SHORT-ID.
  const aliasComment = calls.find(
    (c) => c.args[1] === "comment" && c.token === PAT,
  );
  assert(aliasComment, "expected the alias comment on the created issue");
  assertEqual(aliasComment.args[2], "999");
  assert(
    aliasComment.args[aliasComment.args.indexOf("--body") + 1].includes(
      "APP-MENTO-ORG-77",
    ),
    "expected the second short id in the alias comment",
  );
});

await test("batch mode coalesces a duplicate family regardless of batch order", async () => {
  // REVERSE order: the stub that DECLARES the duplicate (B, dup_of [12])
  // processes FIRST and creates the family issue; the referenced stub (A,
  // 12 itself, declaring no duplicates) comes second. Family registration —
  // every settlement registers the issue under its own id AND its declared
  // dups — must still coalesce: one create, A reuses via the registry and
  // persists its membership with an alias comment.
  const stubs = {
    500: queueIssue({
      number: 500,
      shortId: "APP-MENTO-ORG-77",
      comments: [
        botComment(
          verdictComment({ duplicates: "[APP-MENTO-ORG-12]" }),
          "2026-07-17T10:00:00Z",
        ),
      ],
    }),
    501: queueIssue({ number: 501 }), // APP-MENTO-ORG-12, duplicates []
  };
  const { runGh, calls } = makeRunGh({ stubs, createdUrl: CREATED_URL });
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [500, 501],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(rows[0].status, "projected");
  assertEqual(rows[1].status, "reused");
  assertEqual(rows[1].url, CREATED_URL);
  assertEqual(
    calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").length,
    1,
  );
  // A's membership was persisted durably: an alias comment for 12 landed on
  // the created issue, so a future regression of 12 resolves via search.
  const aliasComment = calls.find(
    (c) => c.args[1] === "comment" && c.token === PAT,
  );
  assert(aliasComment, "expected the alias comment for the referenced id");
  assertEqual(aliasComment.args[2], "999");
  assert(
    aliasComment.args[aliasComment.args.indexOf("--body") + 1].includes(
      "APP-MENTO-ORG-12",
    ),
    "expected the referenced short id in the alias comment",
  );
});

await test("batch registry never aliases across owning repos", async () => {
  // Same declared family, but the two verdicts name DIFFERENT owning repos —
  // repo-qualified registry keys must keep them apart: two creates, one per
  // repo, no cross-repo alias comment.
  const stubs = {
    500: queueIssue({ number: 500 }), // frontend-monorepo (fixture default)
    501: queueIssue({
      number: 501,
      shortId: "APP-MENTO-ORG-77",
      comments: [
        botComment(
          verdictComment({
            affectedRepo: "mento-protocol/mento-analytics-api",
            duplicates: "[APP-MENTO-ORG-12]",
          }),
          "2026-07-17T10:00:00Z",
        ),
      ],
    }),
  };
  const { runGh, calls } = makeRunGh({ stubs, createdUrl: CREATED_URL });
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [500, 501],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(rows[0].status, "projected");
  assertEqual(rows[1].status, "projected");
  const creates = calls.filter(
    (c) => c.args[0] === "issue" && c.args[1] === "create",
  );
  assertEqual(creates.length, 2);
  assertDeepEqual(
    creates.map((c) => c.args[c.args.indexOf("-R") + 1]),
    ["mento-protocol/frontend-monorepo", "mento-protocol/mento-analytics-api"],
  );
  assert(
    !calls.some((c) => c.args[1] === "comment" && c.token === PAT),
    "expected no cross-repo alias comment",
  );
});

await test("batch mode skips closed, needs-triage, and non-actionable stubs untouched", async () => {
  const stubs = {
    1: queueIssue({ number: 1, state: "CLOSED" }),
    2: queueIssue({
      number: 2,
      labels: ["sentry-triage", "sentry:needs-triage"],
    }),
    3: queueIssue({
      number: 3,
      labels: ["sentry-triage", "sentry:verdict-needs-human"],
    }),
  };
  const { runGh, calls } = makeRunGh({ stubs });
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [1, 2, 3],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertDeepEqual(
    rows.map((r) => [r.issue, r.status, r.reason]),
    [
      [1, "skipped-state", "closed"],
      [2, "skipped-state", "needs-triage"],
      [3, "skipped-state", "not-actionable"],
    ],
  );
  // Reads only — no PAT calls, no stub writes of any kind. (The batch-start
  // label self-heal is the one expected non-read: local token, repo metadata.)
  assert(
    calls
      .filter((c) => c.args[0] !== "label")
      .every((c) => c.token === null && c.args[1] === "view"),
    "expected ambient reads only",
  );
});

await test("batch mode isolates per-issue failures and continues", async () => {
  const stubs = {
    600: queueIssue({
      number: 600,
      shortId: "APP-MENTO-ORG-60",
      comments: [botComment("no verdict here", "2026-07-17T10:00:00Z")],
    }),
    601: queueIssue({ number: 601, shortId: "APP-MENTO-ORG-61" }),
  };
  const { runGh, calls } = makeRunGh({ stubs, createdUrl: CREATED_URL });
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [600, 601],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(rows[0].status, "failed");
  assertEqual(rows[0].label, "sentry:verdict-code-fix");
  assert(
    /No usable verdict comment/.test(rows[0].message),
    "expected the failure message recorded",
  );
  assertEqual(rows[1].status, "projected");
  assertEqual(
    calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

await test("parseArgs reads --issue/--repo and the token from env", () => {
  const options = parseArgs(["--issue", "500", "--repo", "o/r"], {
    SENTRY_PROJECTION_TOKEN: "tok",
  });
  assertEqual(options.queueIssue, 500);
  assertEqual(options.localRepo, "o/r");
  assertEqual(options.projectionToken, "tok");
  assertEqual(options.parseOnly, false);
  assertEqual(options.expectedVerdict, null);
});

await test("parseArgs reads --batch/--issues and validates the array", () => {
  const options = parseArgs(["--batch", "--issues", "[1,2]"], {});
  assertEqual(options.batch, true);
  assertDeepEqual(options.queueIssues, [1, 2]);
  // --batch needs no --issue; bad members fail loud.
  assertThrows(
    () => parseArgs(["--batch", "--issues", "[0]"], {}),
    /Invalid issue number/,
  );
  assertThrows(
    () => parseArgs(["--batch", "--issues", "nope"], {}),
    /JSON array/,
  );
});

await test("parseArgs reads --parse-only and --verdict, validating the enum", () => {
  const parseOnly = parseArgs(["--issue", "5", "--parse-only"], {});
  assertEqual(parseOnly.parseOnly, true);
  const withVerdict = parseArgs(
    ["--issue", "5", "--verdict", "config-fix"],
    {},
  );
  assertEqual(withVerdict.expectedVerdict, "config-fix");
  assertThrows(
    () => parseArgs(["--issue", "5", "--verdict", "bogus"], {}),
    /--verdict must be one of/,
  );
});

await test("parseArgs defaults repo and empties an absent token", () => {
  const options = parseArgs(["--issue", "1"], {});
  assertEqual(options.localRepo, "mento-protocol/monitoring-monorepo");
  assertEqual(options.projectionToken, "");
});

await test("parseArgs rejects a non-integer issue and unknown options", () => {
  assertThrows(() => parseArgs(["--issue", "x"], {}), /positive integer/);
  assertThrows(() => parseArgs(["--issue", "0"], {}), /positive integer/);
  assertThrows(() => parseArgs(["--nope"], {}), /Unknown option/);
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}

await test("runProjectionBatch self-heals the sentry:projected label from LABEL_DEFINITIONS", async () => {
  const stubs = { 500: queueIssue({ number: 500 }) };
  const { runGh, calls } = makeRunGh({ stubs, createdUrl: CREATED_URL });
  await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [500],
      projectionToken: PAT,
    },
    { runGh },
  );
  const ensure = calls.find(
    (c) => c.args[0] === "label" && c.args[1] === "create",
  );
  assert(ensure, "expected a gh label create call before settling");
  assertEqual(ensure.args[2], "sentry:projected");
  assert(ensure.args.includes("--force"), "label ensure must be idempotent");
  assert(
    ensure.args.includes("0052cc"),
    "label color must come from LABEL_DEFINITIONS (single source of truth)",
  );
  assert(
    ensure.token == null || ensure.token === "",
    "label ensure must use the local token, not the projection PAT",
  );
});

await test("runProjectionBatch survives a failing label ensure", async () => {
  const stubs = { 500: queueIssue({ number: 500 }) };
  const base = makeRunGh({ stubs, createdUrl: CREATED_URL });
  const runGh = async (args, opts) => {
    if (args[0] === "label") throw new Error("boom");
    return base.runGh(args, opts);
  };
  const rows = await runProjectionBatch(
    {
      localRepo: "mento-protocol/monitoring-monorepo",
      queueIssues: [500],
      projectionToken: PAT,
    },
    { runGh },
  );
  assertEqual(rows[0].status, "projected");
});
