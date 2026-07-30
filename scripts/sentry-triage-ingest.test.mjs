#!/usr/bin/env node
import {
  buildIssueBody,
  buildMetadataYaml,
  buildNewIssuesQuery,
  buildQueueLabels,
  buildQueueTitle,
  buildRegressedComment,
  buildReopenLabelEditArgs,
  buildRunRecordBody,
  buildStrandedRecoveryComment,
  classifyNoise,
  decideDedupAction,
  defangBackticks,
  defangMentions,
  extractShortIdFromTitle,
  ghPaginate,
  indexQueueIssuesByShortId,
  isSafeNextPageUrl,
  isStrandedNeedsTriage,
  LABEL_DEFINITIONS,
  mapSentryIssue,
  mergeSentryIssues,
  NEEDS_TRIAGE_LABEL,
  normalizeRestIssues,
  parseArgs,
  parseLinkHeader,
  PROJECTED_LABEL,
  recoverStrandedQueueIssue,
  reopenQueueIssue,
  REOPEN_SHED_LABELS,
  resolveLookbackDays,
  resolveTokenGuard,
  runIngest,
  sanitizeFreeText,
  toMetadata,
  truncateTitle,
  VERDICT_LABELS,
} from "./sentry-triage-ingest.mjs";

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

async function assertRejectsAsync(fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("expected the call to reject");
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

// ---------------------------------------------------------------------------
// Title truncation
// ---------------------------------------------------------------------------

await test("title truncation leaves short titles untouched", () => {
  assertEqual(truncateTitle("short title", 90), "short title");
});

await test("title truncation cuts at 90 chars and adds an ellipsis", () => {
  const long = "x".repeat(120);
  const truncated = truncateTitle(long, 90);
  assertEqual(truncated.length, 91);
  assert(truncated.endsWith("…"), "expected ellipsis suffix");
  assertEqual(truncated.slice(0, 90), "x".repeat(90));
});

// ---------------------------------------------------------------------------
// Label definitions must satisfy GitHub's limits — the bootstrap `gh label
// create` calls them at ingest startup, and an over-length description returns
// HTTP 422 that fails the whole scheduled run (this test guards that at PR
// time, since the ensure calls are mocked elsewhere).
// ---------------------------------------------------------------------------

await test("every label description is within GitHub's 100-char limit", () => {
  for (const { name, description } of LABEL_DEFINITIONS) {
    assert(
      description.length <= 100,
      `label ${name} description is ${description.length} chars (max 100): ${description}`,
    );
  }
});

await test("queue title format matches the normative v2 contract", () => {
  const title = buildQueueTitle(
    "GOVERNANCE-MENTO-ORG-51",
    "governance-mento-org",
    "error",
  );
  assertEqual(
    title,
    "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
  );
});

await test("queue title contains no Sentry payload text (public repo)", () => {
  // v2: only Sentry-assigned identifiers/metadata render — the issue title
  // (production error payload) must never be passed into the queue title.
  const title = buildQueueTitle("X-1", "app-mento-org", "warning");
  assertEqual(title, "[sentry] X-1 (app-mento-org, warning)");
});

// ---------------------------------------------------------------------------
// Untrusted-text neutralization
// ---------------------------------------------------------------------------

await test("sanitizeFreeText collapses newlines/control chars to spaces", () => {
  assertEqual(
    sanitizeFreeText("line one\nline two\tthree"),
    "line one line two three",
  );
});

await test("defangBackticks removes every backtick to prevent fence breakout", () => {
  const result = defangBackticks("```yaml\nfoo: bar\n```");
  assert(!result.includes("`"), "expected no backticks to survive");
});

await test("queue title neutralizes hostile project/level values", () => {
  // Defense in depth: project/level are Sentry-org-controlled, but they
  // still get the full neutralize+truncate treatment before rendering.
  const title = buildQueueTitle("X-1", "```\nmalicious-project", "@someuser");
  assert(!title.includes("`"), "expected backticks stripped from queue title");
  assert(!title.includes("\n"), "expected newlines collapsed in queue title");
  assert(!/@[a-z]/i.test(title), "expected mention defanged in queue title");
});

// ---------------------------------------------------------------------------
// Noise classification
// ---------------------------------------------------------------------------

await test("noise classification matches CSP block reports", () => {
  assertEqual(
    classifyNoise("Blocked 'script-src' from https://evil.example"),
    true,
  );
});

await test("noise classification matches timeout/fetch/chunk/abort patterns", () => {
  assertEqual(classifyNoise("TimeoutError: request timed out"), true);
  assertEqual(classifyNoise("Failed to fetch"), true);
  assertEqual(classifyNoise("Failed to load chunk 4"), true);
  assertEqual(classifyNoise("AbortError: aborted"), true);
});

await test("noise classification leaves real errors alone", () => {
  assertEqual(
    classifyNoise("TypeError: cannot read property 'foo' of undefined"),
    false,
  );
});

await test("queue labels add the noise label only when classified as noise", () => {
  assertDeepEqual(buildQueueLabels(false), [
    "sentry-triage",
    "sentry:needs-triage",
  ]);
  assertDeepEqual(buildQueueLabels(true), [
    "sentry-triage",
    "sentry:needs-triage",
    "sentry:candidate-noise",
  ]);
});

// ---------------------------------------------------------------------------
// YAML metadata rendering
// ---------------------------------------------------------------------------

await test("metadata YAML renders every v2 contract field and nothing payload-derived", () => {
  const yaml = buildMetadataYaml({
    short_id: "GOVERNANCE-MENTO-ORG-51",
    sentry_issue_id: "123456",
    project: "governance-mento-org",
    level: "error",
    status: "unresolved",
    events: 42,
    users: 7,
    first_seen: "2026-07-01T00:00:00Z",
    last_seen: "2026-07-14T10:00:00Z",
    permalink: "https://mento-labs.sentry.io/issues/123456/",
  });

  assert(yaml.startsWith("```yaml\n"), "expected yaml fence to open the block");
  assert(yaml.endsWith("```"), "expected yaml fence to close the block");
  assert(
    yaml.includes('short_id: "GOVERNANCE-MENTO-ORG-51"'),
    "missing short_id",
  );
  assert(yaml.includes("events: 42"), "expected numeric events field unquoted");
  assert(yaml.includes("users: 7"), "expected numeric users field unquoted");
  assert(
    yaml.includes('permalink: "https://mento-labs.sentry.io/issues/123456/"'),
    "missing permalink",
  );
  // v2: payload-derived fields must not exist in the public yaml block.
  assert(!yaml.includes("title:"), "expected no title field in v2 yaml");
  assert(!yaml.includes("culprit:"), "expected no culprit field in v2 yaml");
});

await test("metadata YAML defangs an embedded fence-breakout attempt", () => {
  // Defense in depth: even identifier-ish fields get the full neutralize
  // treatment before rendering.
  const yaml = buildMetadataYaml({
    short_id: "X-1",
    sentry_issue_id: "1",
    project: "```\n@everyone this breaks out",
    level: "error",
    status: "unresolved",
    events: 0,
    users: 0,
    first_seen: null,
    last_seen: null,
    permalink: "",
  });
  const lines = yaml.split("\n");
  assertEqual(lines[0], "```yaml");
  // Only the closing fence line may be a bare triple-backtick; the embedded
  // "```" from the hostile value must have been defanged, so it must not
  // introduce a second one anywhere in the block.
  const bareFenceLines = lines.filter((line) => line.trim() === "```");
  assertEqual(bareFenceLines.length, 1);
  assert(!/@[a-z]/i.test(yaml), "expected mention defanged in yaml block");
});

await test("metadata YAML hard-bounds unbounded string fields", () => {
  const yaml = buildMetadataYaml({
    short_id: "X-1",
    sentry_issue_id: "1",
    project: "x".repeat(500),
    level: "error",
    status: "unresolved",
    events: 0,
    users: 0,
    first_seen: null,
    last_seen: null,
    permalink: "https://mento-labs.sentry.io/issues/1/",
  });
  const projectLine = yaml
    .split("\n")
    .find((line) => line.startsWith("project:"));
  const projectValue = JSON.parse(projectLine.slice("project:".length).trim());
  assertEqual(projectValue.length, 201); // 200-char bound + ellipsis
  assert(
    projectValue.endsWith("…"),
    "expected bounded project to end with ellipsis",
  );
  // A legitimate permalink stays intact (well under the bound).
  assert(
    yaml.includes('permalink: "https://mento-labs.sentry.io/issues/1/"'),
    "expected short permalink untouched",
  );
});

// ---------------------------------------------------------------------------
// Mention defanging
// ---------------------------------------------------------------------------

await test("mention defanging breaks user and team mentions", () => {
  const result = defangMentions("cc @someuser and @some-org/some-team");
  assert(!/@[a-z]/i.test(result), "expected no live @mention to survive");
  assert(result.includes("someuser"), "expected mention text kept readable");
});

// ---------------------------------------------------------------------------
// Issue body assembly
// ---------------------------------------------------------------------------

const BODY_TEST_META = {
  short_id: "X-1",
  sentry_issue_id: "1",
  project: "p",
  level: "error",
  status: "unresolved",
  events: 1,
  users: 1,
  first_seen: "2026-07-01T00:00:00Z",
  last_seen: "2026-07-14T10:00:00Z",
  permalink: "https://mento-labs.sentry.io/issues/1/",
};

await test("issue body is marker + yaml + safe link, nothing else", () => {
  const body = buildIssueBody(BODY_TEST_META);
  assert(body.startsWith("<!-- sentry-triage:v1 -->"), "missing body marker");
  assert(
    body.includes("[View in Sentry](https://mento-labs.sentry.io/issues/1/)"),
    "missing permalink link",
  );
});

await test("issue body publishes no Sentry payload text (public repo, v2)", () => {
  // Even when the in-memory Sentry issue carries payload text, none of it
  // may reach the rendered body — the yaml block and human-readable section
  // only contain Sentry-assigned identifiers, counters, and the permalink.
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "SECRET-PAYLOAD-TITLE: user@example.com crashed",
    culprit: "SECRET-CULPRIT in payments.ts",
    level: "error",
    status: "unresolved",
    project: { slug: "app-mento-org" },
    count: "1",
    userCount: 1,
    firstSeen: "2026-07-01T00:00:00Z",
    lastSeen: "2026-07-14T10:00:00Z",
    permalink: "https://mento-labs.sentry.io/issues/9/",
  });
  const body = buildIssueBody(toMetadata(sentryIssue));
  assert(!body.includes("SECRET-PAYLOAD-TITLE"), "payload title leaked");
  assert(!body.includes("SECRET-CULPRIT"), "payload culprit leaked");
  assert(!body.includes("title:"), "expected no title field in body yaml");
  assert(!body.includes("culprit:"), "expected no culprit field in body yaml");
  // ... and the queue title carries no payload text either.
  const queueTitle = buildQueueTitle(
    sentryIssue.shortId,
    sentryIssue.project,
    sentryIssue.level,
  );
  assertEqual(queueTitle, "[sentry] X-9 (app-mento-org, error)");
});

await test("issue body survives hostile metadata with one fence intact", () => {
  const body = buildIssueBody({
    ...BODY_TEST_META,
    project: "```\n@everyone breakout " + "z".repeat(200),
    status: "```yaml\ninjected: true",
  });
  const bareFenceLines = body
    .split("\n")
    .filter((line) => line.trim() === "```");
  // Exactly one bare fence line: the yaml block's closing fence.
  assertEqual(bareFenceLines.length, 1);
  assert(!/@[a-z]/i.test(body), "expected mentions defanged in body");
});

await test("issue body falls back to plain text for a non-Sentry permalink", () => {
  const body = buildIssueBody({
    ...BODY_TEST_META,
    permalink: "https://evil.example/phish",
  });
  assert(
    body.includes("(permalink unavailable)"),
    "expected permalink fallback",
  );
  // The URL may still appear as quoted data inside the yaml block, but it
  // must never be rendered as a clickable markdown link.
  assert(
    !body.includes("[View in Sentry]"),
    "expected no clickable link for unsafe URL",
  );
});

await test("issue body rejects a permalink with Slack link-control chars (#1586)", () => {
  // The permalink written here is later read back and embedded in a Slack
  // `<url|text>` link by the digest, so `<`, `>`, `|` (and control chars /
  // whitespace) must fail closed at write time. Built as base + char so no
  // literal control byte lands in the source.
  const base = "https://mento-labs.sentry.io/issues/1";
  for (const bad of ["<", ">", "|", "\x00", "\x7f", "\n", " "]) {
    const body = buildIssueBody({
      ...BODY_TEST_META,
      permalink: `${base}${bad}x`,
    });
    assert(
      body.includes("(permalink unavailable)"),
      `expected fallback for permalink containing ${JSON.stringify(bad)}`,
    );
    assert(
      !body.includes("[View in Sentry]"),
      `expected no clickable link for permalink containing ${JSON.stringify(bad)}`,
    );
  }
});

await test("toMetadata maps v2 contract keys and drops payload-derived fields", () => {
  const meta = toMetadata(
    mapSentryIssue({
      id: 7,
      shortId: "X-7",
      title: "Boom",
      culprit: "foo()",
      level: "warning",
      status: "unresolved",
      project: { slug: "app-mento-org" },
      count: "3",
      userCount: 2,
      firstSeen: "2026-07-01T00:00:00Z",
      lastSeen: "2026-07-14T10:00:00Z",
      permalink: "https://mento-labs.sentry.io/issues/7/",
    }),
  );
  assertEqual(meta.short_id, "X-7");
  assertEqual(meta.sentry_issue_id, "7");
  assertEqual(meta.project, "app-mento-org");
  assertEqual(meta.level, "warning");
  assertEqual(meta.events, 3);
  assertEqual(meta.users, 2);
  assertEqual(meta.first_seen, "2026-07-01T00:00:00Z");
  assertEqual(meta.last_seen, "2026-07-14T10:00:00Z");
  assertEqual(meta.permalink, "https://mento-labs.sentry.io/issues/7/");
  // v2: payload-derived text must not survive the mapping.
  assert(!("title" in meta), "expected no title key in metadata");
  assert(!("culprit" in meta), "expected no culprit key in metadata");
});

// ---------------------------------------------------------------------------
// Dedup decision (open / closed / regressed)
// ---------------------------------------------------------------------------

await test("dedup: no existing issue creates a new one", () => {
  assertDeepEqual(
    decideDedupAction({ existingIssue: null, isRegressed: false }),
    {
      action: "create",
    },
  );
});

await test("dedup: open match always skips, regressed or not", () => {
  assertEqual(
    decideDedupAction({ existingIssue: { state: "OPEN" }, isRegressed: false })
      .action,
    "skip",
  );
  assertEqual(
    decideDedupAction({ existingIssue: { state: "OPEN" }, isRegressed: true })
      .action,
    "skip",
  );
});

await test("dedup: closed match reopens only when regressed", () => {
  assertEqual(
    decideDedupAction({ existingIssue: { state: "CLOSED" }, isRegressed: true })
      .action,
    "reopen",
  );
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED" },
      isRegressed: false,
    }).action,
    "skip",
  );
});

await test("dedup: regressed-but-stale closed match stays closed (no reopen loop)", () => {
  // Sentry keeps substatus=regressed for days after a regression; every
  // event predates the close, so this occurrence was already triaged before
  // the ledger entry closed — reopening would loop reopen -> re-triage ->
  // close on every run.
  const decision = decideDedupAction({
    existingIssue: { state: "CLOSED", closedAt: "2026-07-17T08:00:00Z" },
    isRegressed: true,
    lastSeen: "2026-07-16T10:00:00Z",
  });
  assertEqual(decision.action, "skip");
});

await test("dedup: regressed closed match with a fresh event reopens", () => {
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED", closedAt: "2026-07-17T08:00:00Z" },
      isRegressed: true,
      lastSeen: "2026-07-17T09:30:00Z",
    }).action,
    "reopen",
  );
});

await test("dedup: lastSeen equal to closedAt stays closed (conservative)", () => {
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED", closedAt: "2026-07-17T08:00:00Z" },
      isRegressed: true,
      lastSeen: "2026-07-17T08:00:00Z",
    }).action,
    "skip",
  );
});

await test("dedup: fractional-second lastSeen compares numerically, not lexically", () => {
  // String comparison would order "…00.500Z" BEFORE "…00Z" and wrongly skip
  // this genuinely-newer event.
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED", closedAt: "2026-07-17T08:00:00Z" },
      isRegressed: true,
      lastSeen: "2026-07-17T08:00:00.500Z",
    }).action,
    "reopen",
  );
});

await test("dedup: missing closedAt or lastSeen fails open toward triage (reopen)", () => {
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED" },
      isRegressed: true,
      lastSeen: "2026-07-17T09:30:00Z",
    }).action,
    "reopen",
  );
  assertEqual(
    decideDedupAction({
      existingIssue: { state: "CLOSED", closedAt: "2026-07-17T08:00:00Z" },
      isRegressed: true,
    }).action,
    "reopen",
  );
});

await test("regressed comment matches the contract phrasing", () => {
  assertEqual(
    buildRegressedComment("2026-07-14T10:00:00Z"),
    "Regressed in Sentry (last seen 2026-07-14T10:00:00Z)",
  );
});

await test("regressed comment neutralizes a hostile lastSeen value", () => {
  const comment = buildRegressedComment(
    "2026-07-14\n\n## Injected heading `code` @someuser " + "x".repeat(200),
  );
  assert(!comment.includes("\n"), "expected newlines collapsed");
  assert(!comment.includes("`"), "expected backticks defanged");
  assert(!/@[a-z]/i.test(comment), "expected mention defanged");
  assert(comment.length < 150, "expected hostile lastSeen hard-bounded");
  assert(
    comment.startsWith("Regressed in Sentry (last seen "),
    "contract phrasing kept",
  );
});

await test("queue issue index extracts short IDs from titles and dedupes", () => {
  assertEqual(
    extractShortIdFromTitle(
      "[sentry] GOVERNANCE-MENTO-ORG-51 (governance-mento-org, error)",
    ),
    "GOVERNANCE-MENTO-ORG-51",
  );
  assertEqual(extractShortIdFromTitle("not a queue issue"), null);

  const index = indexQueueIssuesByShortId([
    { number: 1, title: "[sentry] X-1 (p, error)", state: "OPEN" },
    { number: 2, title: "[sentry] X-1 (p, error)", state: "OPEN" },
    { number: 3, title: "[sentry] X-2 (q, warning)", state: "CLOSED" },
  ]);
  assertEqual(index.get("X-1").number, 1);
  assertEqual(index.get("X-2").number, 3);
});

// ---------------------------------------------------------------------------
// Kill-switch / secret guard
// ---------------------------------------------------------------------------

await test("secret guard no-ops when SENTRY_TRIAGE_TOKEN is unset", () => {
  assertEqual(resolveTokenGuard({}).shouldRun, false);
  assertEqual(resolveTokenGuard({ SENTRY_TRIAGE_TOKEN: "" }).shouldRun, false);
  assertEqual(
    resolveTokenGuard({ SENTRY_TRIAGE_TOKEN: "   " }).shouldRun,
    false,
  );
});

await test("secret guard runs when SENTRY_TRIAGE_TOKEN is set", () => {
  const guard = resolveTokenGuard({ SENTRY_TRIAGE_TOKEN: " abc123 " });
  assertEqual(guard.shouldRun, true);
  assertEqual(guard.token, "abc123");
});

// ---------------------------------------------------------------------------
// Sentry API mapping / pagination / merge
// ---------------------------------------------------------------------------

await test("Link header parsing follows rel + results", () => {
  const links = parseLinkHeader(
    '<https://sentry/next>; rel="next"; results="true"; cursor="a", ' +
      '<https://sentry/prev>; rel="previous"; results="false"; cursor="b"',
  );
  assertEqual(links.next.hasResults, true);
  assertEqual(links.previous.hasResults, false);
});

await test("pagination refuses non-https or cross-host next-page URLs", () => {
  const base = "https://us.sentry.io";
  assertEqual(
    isSafeNextPageUrl(
      "https://us.sentry.io/api/0/organizations/x/issues/?cursor=abc",
      base,
    ),
    true,
  );
  // http downgrade would leak the bearer token in cleartext.
  assertEqual(
    isSafeNextPageUrl(
      "http://us.sentry.io/api/0/organizations/x/issues/",
      base,
    ),
    false,
  );
  // Cross-host would hand the bearer token to a third party.
  assertEqual(isSafeNextPageUrl("https://evil.example/steal", base), false);
  assertEqual(isSafeNextPageUrl("https://eu.sentry.io/api/0/", base), false);
  assertEqual(isSafeNextPageUrl("not a url", base), false);
});

await test("mapSentryIssue normalizes the fields used downstream", () => {
  const mapped = mapSentryIssue({
    id: 123,
    shortId: "X-1",
    title: "Boom",
    culprit: "foo()",
    level: "error",
    status: "unresolved",
    project: { slug: "app-mento-org" },
    count: "42",
    userCount: 7,
    firstSeen: "2026-07-01T00:00:00Z",
    lastSeen: "2026-07-14T10:00:00Z",
    permalink: "https://mento-labs.sentry.io/issues/123/",
  });
  assertEqual(mapped.id, "123");
  assertEqual(mapped.project, "app-mento-org");
  assertEqual(mapped.events, 42);
  assertEqual(mapped.users, 7);
  assertEqual(mapped.isRegressed, false);
});

await test("ghPaginate walks pages until a short page and builds page params", async () => {
  const calls = [];
  const item = (n) => ({ n });
  const fullPage = JSON.stringify(Array.from({ length: 3 }, (_, i) => item(i)));
  const shortPage = JSON.stringify([item(0)]);
  const runner = async (args) => {
    calls.push(args[1]);
    return calls.length < 3 ? fullPage : shortPage;
  };

  const pages = await ghPaginate("repos/o/r/issues?labels=x", {
    perPage: 3,
    runner,
  });
  assertEqual(pages.length, 3);
  assertEqual(pages.flat().length, 7);
  assertDeepEqual(calls, [
    "repos/o/r/issues?labels=x&per_page=3&page=1",
    "repos/o/r/issues?labels=x&per_page=3&page=2",
    "repos/o/r/issues?labels=x&per_page=3&page=3",
  ]);
});

await test("ghPaginate handles empty results and uses ? for bare paths", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args[1]);
    return "[]";
  };
  const pages = await ghPaginate("repos/o/r/issues/1/comments", { runner });
  assertDeepEqual(pages, []);
  assertDeepEqual(calls, ["repos/o/r/issues/1/comments?per_page=100&page=1"]);
});

await test("ghPaginate fails loud on runaway pagination and non-array responses", async () => {
  const fullRunner = async () =>
    JSON.stringify(Array.from({ length: 2 }, (_, i) => ({ i })));
  let threw = null;
  try {
    await ghPaginate("repos/o/r/issues", {
      perPage: 2,
      maxPages: 3,
      runner: fullRunner,
    });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected runaway pagination to throw");
  assert(/exceeded 3 pages/.test(threw.message), "wrong runaway error");

  threw = null;
  try {
    await ghPaginate("repos/o/r/issues", {
      runner: async () => JSON.stringify({ message: "rate limited" }),
    });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected non-array response to throw");
  assert(/non-array/.test(threw.message), "wrong non-array error");
});

await test("REST issue normalization flattens pages, drops PRs, uppercases state, carries closed_at + labels", () => {
  const normalized = normalizeRestIssues([
    [
      {
        number: 1,
        title: "[sentry] X-1: a",
        state: "open",
        labels: [{ name: "sentry-triage" }, { name: "sentry:needs-triage" }],
      },
      {
        number: 2,
        title: "[sentry] X-2: b",
        state: "closed",
        closed_at: "2026-07-16T12:00:00Z",
        // Label name strings (not objects) must normalize identically — the
        // stranded sweep reads this field and a silent [] would make it inert.
        labels: ["sentry-triage", "sentry:verdict-upstream"],
      },
      {
        number: 3,
        title: "a PR, not an issue",
        state: "open",
        pull_request: {},
      },
    ],
    [{ number: 4, title: "[sentry] X-4: c", state: "closed" }],
  ]);
  assertDeepEqual(normalized, [
    {
      number: 1,
      title: "[sentry] X-1: a",
      state: "OPEN",
      closedAt: null,
      labels: ["sentry-triage", "sentry:needs-triage"],
    },
    {
      number: 2,
      title: "[sentry] X-2: b",
      state: "CLOSED",
      closedAt: "2026-07-16T12:00:00Z",
      labels: ["sentry-triage", "sentry:verdict-upstream"],
    },
    {
      number: 4,
      title: "[sentry] X-4: c",
      state: "CLOSED",
      closedAt: null,
      labels: [],
    },
  ]);
});

await test("merging new + regressed issues flags regression by ID union", () => {
  const merged = mergeSentryIssues(
    [
      mapSentryIssue({ id: 1, shortId: "X-1" }),
      mapSentryIssue({ id: 2, shortId: "X-2" }),
    ],
    [
      mapSentryIssue({ id: 2, shortId: "X-2" }),
      mapSentryIssue({ id: 3, shortId: "X-3" }),
    ],
  );
  assertEqual(merged.size, 3);
  assertEqual(merged.get("1").isRegressed, false);
  assertEqual(merged.get("2").isRegressed, true);
  assertEqual(merged.get("3").isRegressed, true);
});

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

await test("run record body includes counts and the rolling-comment marker", () => {
  const body = buildRunRecordBody(
    {
      fetched: 5,
      created: 2,
      skippedExisting: 2,
      reopened: 1,
      recovered: 3,
      errors: 0,
    },
    "2026-07-15T05:30:00.000Z",
  );
  assert(
    body.includes("<!-- sentry-triage-ingest:run-record:v1 -->"),
    "missing marker",
  );
  assert(body.includes("Fetched: 5"), "missing fetched count");
  assert(body.includes("Created: 2"), "missing created count");
  assert(body.includes("Skipped (existing): 2"), "missing skipped count");
  assert(body.includes("Reopened (regressed): 1"), "missing reopened count");
  assert(
    body.includes("Recovered (stranded needs-triage): 3"),
    "missing recovered count",
  );
  assert(body.includes("Errors: 0"), "missing errors count");
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

await test("parseArgs applies defaults", () => {
  const options = parseArgs([], {});
  assertEqual(options.repo, "mento-protocol/monitoring-monorepo");
  assertEqual(options.org, "mento-labs");
  assertEqual(options.trackerIssue, 1282);
  assertEqual(options.dryRun, false);
  assertEqual(options.lookbackDays, 8);
});

await test("parseArgs reads flags and rejects a bad tracker issue", () => {
  const options = parseArgs(["--dry-run", "--tracker-issue", "42"], {});
  assertEqual(options.dryRun, true);
  assertEqual(options.trackerIssue, 42);
  assertThrows(
    () => parseArgs(["--tracker-issue", "0"], {}),
    /positive integer/,
  );
  assertThrows(() => parseArgs(["--nope"], {}), /Unknown option/);
});

// ---------------------------------------------------------------------------
// Lookback window (backfill after outages)
// ---------------------------------------------------------------------------

await test("new-issues query embeds the lookback window", () => {
  assertEqual(buildNewIssuesQuery(), "is:unresolved firstSeen:-8d");
  assertEqual(buildNewIssuesQuery(30), "is:unresolved firstSeen:-30d");
});

await test("lookback resolution: default, env fallback, CLI precedence", () => {
  assertEqual(resolveLookbackDays(null, {}), 8);
  assertEqual(
    resolveLookbackDays(null, { SENTRY_TRIAGE_LOOKBACK_DAYS: "" }),
    8,
  );
  assertEqual(
    resolveLookbackDays(null, { SENTRY_TRIAGE_LOOKBACK_DAYS: "30" }),
    30,
  );
  // CLI flag wins over the env var.
  assertEqual(
    resolveLookbackDays("14", { SENTRY_TRIAGE_LOOKBACK_DAYS: "30" }),
    14,
  );
});

await test("lookback resolution fails loud on invalid values", () => {
  for (const bad of ["0", "91", "abc", "8.5", "-3", "1e2"]) {
    assertThrows(() => resolveLookbackDays(bad, {}), /between 1 and 90/);
    assertThrows(
      () => resolveLookbackDays(null, { SENTRY_TRIAGE_LOOKBACK_DAYS: bad }),
      /between 1 and 90/,
    );
  }
});

await test("parseArgs wires --lookback-days through validation", () => {
  assertEqual(parseArgs(["--lookback-days", "30"], {}).lookbackDays, 30);
  assertEqual(
    parseArgs(["--lookback-days", "14"], { SENTRY_TRIAGE_LOOKBACK_DAYS: "30" })
      .lookbackDays,
    14,
  );
  assertEqual(
    parseArgs([], { SENTRY_TRIAGE_LOOKBACK_DAYS: "21" }).lookbackDays,
    21,
  );
  assertThrows(
    () => parseArgs(["--lookback-days", "999"], {}),
    /between 1 and 90/,
  );
});

// ---------------------------------------------------------------------------
// Regression-reopen label hygiene
// ---------------------------------------------------------------------------

await test("verdict label set is derived from the label definitions", () => {
  assertDeepEqual(VERDICT_LABELS, [
    "sentry:verdict-code-fix",
    "sentry:verdict-config-fix",
    "sentry:verdict-upstream",
    "sentry:verdict-needs-human",
  ]);
});

await test("reopen shed set is every verdict label plus projected + autofix + archive markers", () => {
  // A reopened regression is a NEW occurrence: it must not keep reading as
  // verdicted, projected, autofixed/refused, or approved-for-archive/archived —
  // every one of those described the old occurrence (PR #1356 review). A stale
  // autofix marker also blocks re-autofix, and a stale archive approval must not
  // carry a human sign-off into a fresh occurrence.
  assertDeepEqual(REOPEN_SHED_LABELS, [
    "sentry:verdict-code-fix",
    "sentry:verdict-config-fix",
    "sentry:verdict-upstream",
    "sentry:verdict-needs-human",
    "sentry:projected",
    "sentry:fix-pr-opened",
    "sentry:fix-refused",
    "sentry:approved-archive",
    "sentry:archived",
  ]);
  assertEqual(PROJECTED_LABEL, "sentry:projected");
});

await test("reopen label edit re-queues triage and sheds stale verdict + projected + autofix + archive labels", () => {
  const args = buildReopenLabelEditArgs(200, "owner/repo");
  assertDeepEqual(args, [
    "issue",
    "edit",
    "200",
    "-R",
    "owner/repo",
    "--add-label",
    "sentry:needs-triage",
    "--remove-label",
    "sentry:verdict-code-fix,sentry:verdict-config-fix,sentry:verdict-upstream,sentry:verdict-needs-human,sentry:projected,sentry:fix-pr-opened,sentry:fix-refused,sentry:approved-archive,sentry:archived",
  ]);
});

// ---------------------------------------------------------------------------
// Idempotency: running the ingest twice creates zero new issues the second
// time, proven against mocked Sentry/GitHub I/O (no real network/gh calls).
// ---------------------------------------------------------------------------

await test("running the orchestrator twice creates no duplicate issues", async () => {
  const sentryIssues = [
    mapSentryIssue({
      id: 1,
      shortId: "X-1",
      title: "First bug",
      count: "10",
      userCount: 3,
      lastSeen: "2026-07-14T00:00:00Z",
    }),
    mapSentryIssue({
      id: 2,
      shortId: "X-2",
      title: "Second bug",
      count: "5",
      userCount: 1,
      lastSeen: "2026-07-14T00:00:00Z",
    }),
  ];

  // Fake "GitHub" queue state, mutated by the fake createIssue/reopenIssue
  // implementations exactly like the real gh-backed ones would mutate the
  // repo's issue tracker.
  const fakeQueueIssues = [];
  let nextNumber = 100;

  const deps = {
    fetchMergedSentryIssues: async () => mergeSentryIssues(sentryIssues, []),
    listQueueIssues: async () => fakeQueueIssues.map((issue) => ({ ...issue })),
    ensureLabels: async () => {},
    createIssue: async (options, sentryIssue) => {
      nextNumber += 1;
      fakeQueueIssues.push({
        number: nextNumber,
        title: buildQueueTitle(
          sentryIssue.shortId,
          sentryIssue.project,
          sentryIssue.level,
        ),
        state: "OPEN",
      });
    },
    reopenIssue: async () => {
      throw new Error("unexpected reopen in this scenario");
    },
    postRunRecord: async () => {},
    now: () => new Date("2026-07-15T05:30:00.000Z"),
  };

  const firstRun = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    deps,
  );
  assertEqual(firstRun.fetched, 2);
  assertEqual(firstRun.created, 2);
  assertEqual(firstRun.skippedExisting, 0);
  assertEqual(fakeQueueIssues.length, 2);

  const secondRun = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    deps,
  );
  assertEqual(secondRun.fetched, 2);
  assertEqual(secondRun.created, 0);
  assertEqual(secondRun.skippedExisting, 2);
  assertEqual(fakeQueueIssues.length, 2);
});

await test("a regressed, previously closed issue is reopened exactly once", async () => {
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "Regressed bug",
    lastSeen: "2026-07-15T00:00:00Z",
  });

  const fakeQueueIssues = [
    {
      number: 200,
      title: buildQueueTitle("X-9", "unknown", "error"),
      state: "CLOSED",
      // Closed BEFORE the Sentry lastSeen above, so the reopen flows through
      // the events-since-close gate, not the missing-timestamp fail-open.
      closedAt: "2026-07-14T00:00:00Z",
    },
  ];
  let reopenCount = 0;

  const deps = {
    fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
    listQueueIssues: async () => fakeQueueIssues.map((issue) => ({ ...issue })),
    ensureLabels: async () => {},
    createIssue: async () => {
      throw new Error("unexpected create in this scenario");
    },
    reopenIssue: async (options, existingIssue) => {
      reopenCount += 1;
      assertEqual(existingIssue.number, 200);
    },
    postRunRecord: async () => {},
    now: () => new Date("2026-07-15T05:30:00.000Z"),
  };

  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    deps,
  );
  assertEqual(result.reopened, 1);
  assertEqual(reopenCount, 1);
});

await test("a per-issue error is counted without aborting the whole run", async () => {
  const sentryIssues = [
    mapSentryIssue({ id: 1, shortId: "X-1", title: "Bug one" }),
    mapSentryIssue({ id: 2, shortId: "X-2", title: "Bug two" }),
  ];
  let created = 0;
  let recordedCounts = null;

  const deps = {
    fetchMergedSentryIssues: async () => mergeSentryIssues(sentryIssues, []),
    listQueueIssues: async () => [],
    ensureLabels: async () => {},
    createIssue: async (options, sentryIssue) => {
      if (sentryIssue.shortId === "X-1")
        throw new Error("gh issue create failed");
      created += 1;
    },
    reopenIssue: async () => {},
    postRunRecord: async (options, counts) => {
      recordedCounts = counts;
    },
    now: () => new Date("2026-07-15T05:30:00.000Z"),
  };

  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    deps,
  );
  assertEqual(result.created, 1);
  assertEqual(result.errors, 1);
  assertEqual(created, 1);
  // The run record must still be posted even when a per-issue error occurs —
  // a missing run record is the dead-man-switch signal, not a per-issue one.
  assert(recordedCounts !== null, "expected run record to be posted");
  assertEqual(recordedCounts.errors, 1);
});

// ---------------------------------------------------------------------------
// Stranded `CLOSED + sentry:needs-triage` recovery (issue #1706).
//
// The scenario is a LOST CLOSE RESPONSE: `gh issue close` lands server-side and
// only its response is lost, so the caller sees a rejection and runs its
// compensation. A rejected command is not proof its remote mutation did not
// happen. The fake below is stateful and its `ambiguousOn` hook applies the
// mutation and THEN throws, which is exactly that. Every assertion is on the
// observable end state — never on which call rejected.
// ---------------------------------------------------------------------------

const REPO = "mento-protocol/monitoring-monorepo";

/**
 * Minimal stateful GitHub the `gh` argv arrays actually mutate, so the real
 * argument builders (not a re-implementation of them) drive the state.
 */
function makeFakeGitHub({
  issues = [],
  ambiguousOn = () => false,
  rejectOn = () => false,
} = {}) {
  const state = new Map(
    issues.map((issue) => [
      issue.number,
      {
        closedAt: null,
        comments: [],
        ...issue,
        labels: [...(issue.labels ?? [])],
      },
    ]),
  );
  const calls = [];

  const flag = (args, name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };
  const splitLabels = (value) =>
    String(value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  const apply = (args) => {
    const [resource, verb, rawNumber] = args;
    if (resource !== "issue") throw new Error(`unexpected gh call: ${args[0]}`);
    const issue = state.get(Number(rawNumber));
    if (!issue) throw new Error(`unknown issue ${rawNumber}`);
    if (verb === "edit") {
      for (const name of splitLabels(flag(args, "--remove-label"))) {
        issue.labels = issue.labels.filter((label) => label !== name);
      }
      for (const name of splitLabels(flag(args, "--add-label"))) {
        if (!issue.labels.includes(name)) issue.labels.push(name);
      }
      return;
    }
    if (verb === "comment") {
      issue.comments.push(flag(args, "--body"));
      return;
    }
    if (verb === "close") {
      issue.state = "CLOSED";
      issue.closedAt = "2026-07-20T09:00:00Z";
      const comment = flag(args, "--comment");
      if (comment) issue.comments.push(comment);
      return;
    }
    if (verb === "reopen") {
      issue.state = "OPEN";
      issue.closedAt = null;
      return;
    }
    throw new Error(`unexpected gh issue subcommand: ${verb}`);
  };

  const fail = (args) =>
    new Error(
      `gh ${args.join(" ")} failed with exit 1:\nerror connecting to api.github.com`,
    );

  const runGh = async (args) => {
    calls.push(args);
    // A read: the comment scan reopenQueueIssue runs before it posts.
    if (args[0] === "api") {
      const number = Number(/issues\/(\d+)\/comments/.exec(args[1])?.[1]);
      return JSON.stringify(
        (state.get(number)?.comments ?? []).map((body) => ({ body })),
      );
    }
    // The process died before the call reached GitHub: nothing applied.
    if (rejectOn(args)) throw fail(args);
    // Mutation FIRST, rejection second: the server applied it, the client only
    // lost the answer.
    apply(args);
    if (ambiguousOn(args)) throw fail(args);
    return "";
  };

  return {
    calls,
    runGh,
    get: (number) => state.get(number),
    /** The normalized queue snapshot ingest's listQueueIssues would return. */
    snapshot: () =>
      [...state.values()].map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        closedAt: issue.closedAt,
        labels: [...issue.labels],
      })),
    /** Stage B's selector: `--label sentry-triage --label ... --state open`. */
    selectable: () =>
      [...state.values()]
        .filter(
          (issue) =>
            issue.state === "OPEN" &&
            issue.labels.includes("sentry-triage") &&
            issue.labels.includes(NEEDS_TRIAGE_LABEL),
        )
        .map((issue) => issue.number),
  };
}

/**
 * The close-then-compensate shell both producer sites in
 * `.github/workflows/sentry-triage-agent.yml` run. They differ only in which
 * job hosts them (the `verdict` job's "Close queue stub" step and the `project`
 * job's per-row close) and in the exact `labels_to_remove` string; the failure
 * semantics — restore `sentry:needs-triage`, shed the verdict label and
 * `sentry:projected`, fail loud — are identical, so one helper models both.
 */
async function closeWithCompensation(runGh, { number, labelsToRemove }) {
  try {
    await runGh([
      "issue",
      "close",
      String(number),
      "--repo",
      REPO,
      "--reason",
      "completed",
      "--comment",
      "Triage complete: upstream. Ledger entry closed; reopens automatically on Sentry regression.",
    ]);
    return "closed";
  } catch {
    await runGh([
      "issue",
      "edit",
      String(number),
      "--repo",
      REPO,
      "--remove-label",
      labelsToRemove,
      "--add-label",
      NEEDS_TRIAGE_LABEL,
    ]);
    return "compensated";
  }
}

/** Ingest deps that see NO Sentry results at all. A stranded stub's Sentry
 * issue is normally outside the firstSeen lookback and no longer flagged
 * regressed, so the dedup loop never visits it — recovery has to come from the
 * queue sweep or from nowhere. */
function ingestDeps(fake, overrides = {}) {
  return {
    fetchMergedSentryIssues: async () => mergeSentryIssues([], []),
    listQueueIssues: async () => fake.snapshot(),
    ensureLabels: async () => {},
    createIssue: async () => {
      throw new Error("unexpected create in this scenario");
    },
    reopenIssue: async () => {
      throw new Error("unexpected regression reopen in this scenario");
    },
    recoverStranded: (options, issue) =>
      recoverStrandedQueueIssue(options, issue, { runGh: fake.runGh }),
    postRunRecord: async () => {},
    now: () => new Date("2026-07-21T05:30:00.000Z"),
    ...overrides,
  };
}

await test("isStrandedNeedsTriage matches only closed stubs still awaiting a verdict", () => {
  assert(
    isStrandedNeedsTriage({
      state: "CLOSED",
      labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
    }),
    "closed + needs-triage is the stranded pairing",
  );
  assert(
    !isStrandedNeedsTriage({
      state: "OPEN",
      labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
    }),
    "an open stub awaiting triage is the normal queue state",
  );
  assert(
    !isStrandedNeedsTriage({
      state: "CLOSED",
      labels: ["sentry-triage", "sentry:verdict-upstream"],
    }),
    "a verdict-closed stub is settled, not stranded",
  );
  assert(
    !isStrandedNeedsTriage({ state: "CLOSED" }),
    "a stub with no labels field must not be treated as stranded",
  );
});

await test("stranded recovery re-queues, sheds stale markers, and changes state last", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: [
          "sentry-triage",
          NEEDS_TRIAGE_LABEL,
          "sentry:verdict-upstream",
        ],
      },
    ],
  });

  await recoverStrandedQueueIssue(
    { repo: REPO },
    { number: 42 },
    {
      runGh: fake.runGh,
    },
  );

  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["edit", "comment", "reopen"],
  );
  assertDeepEqual(fake.calls[0], buildReopenLabelEditArgs(42, REPO));
  const issue = fake.get(42);
  assertEqual(issue.state, "OPEN");
  assertDeepEqual(issue.labels, ["sentry-triage", NEEDS_TRIAGE_LABEL]);
  assertDeepEqual(issue.comments, [buildStrandedRecoveryComment()]);
  // The recovery note must NOT be the regression comment: that exact lead-in is
  // the verdict parser's staleness fence, and a recovery is not a new Sentry
  // occurrence, so a verdict already posted for this stub stays admissible.
  assert(
    !buildStrandedRecoveryComment().includes("Regressed in Sentry (last seen "),
    "recovery note must not trip the verdict staleness fence",
  );
});

for (const producer of [
  {
    name: "the verdict job's close step",
    labelsToRemove: "sentry:verdict-upstream,sentry:projected",
  },
  {
    name: "the project job's per-row close",
    labelsToRemove: "sentry:verdict-code-fix,sentry:projected",
  },
]) {
  await test(`ingest recovers a stub stranded by a lost close response at ${producer.name}`, async () => {
    const verdictLabel = producer.labelsToRemove.split(",")[0];
    const fake = makeFakeGitHub({
      issues: [
        {
          number: 42,
          title: buildQueueTitle("X-42", "web", "error"),
          state: "OPEN",
          labels: ["sentry-triage", verdictLabel],
        },
      ],
      // The close is the ambiguous call: it lands, then its response is lost.
      ambiguousOn: (args) => args[1] === "close",
    });

    const outcome = await closeWithCompensation(fake.runGh, {
      number: 42,
      labelsToRemove: producer.labelsToRemove,
    });

    // End state after the lost response: the stub is CLOSED (the mutation
    // landed) AND wearing sentry:needs-triage (the compensation ran on the
    // rejection). That pairing is invisible to Stage B.
    assertEqual(outcome, "compensated");
    assertEqual(fake.get(42).state, "CLOSED");
    assert(
      fake.get(42).labels.includes(NEEDS_TRIAGE_LABEL),
      "compensation should have restored the needs-triage label",
    );
    assertDeepEqual(fake.selectable(), []);

    const counts = await runIngest(
      { repo: REPO, trackerIssue: 1282 },
      ingestDeps(fake),
    );

    // The next scheduled ingest repairs it from observed state.
    assertEqual(counts.recovered, 1);
    assertEqual(counts.errors, 0);
    const issue = fake.get(42);
    assertEqual(issue.state, "OPEN");
    assertDeepEqual(issue.labels, ["sentry-triage", NEEDS_TRIAGE_LABEL]);
    assertDeepEqual(fake.selectable(), [42]);
  });
}

await test("stranded recovery terminates: a second ingest run is a no-op", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
  });

  const first = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );
  const second = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );

  assertEqual(first.recovered, 1);
  // Reopened, so no longer stranded: the sweep cannot cycle a stub it already
  // fixed, and it never fights the regression gate (which only ever sees stubs
  // whose needs-triage label the verdict step already removed).
  assertEqual(second.recovered, 0);
  assertEqual(fake.get(42).comments.length, 1);
});

await test("the sweep leaves settled and healthy queue stubs alone", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 10,
        title: buildQueueTitle("X-10", "web", "error"),
        state: "CLOSED",
        closedAt: "2026-07-18T00:00:00Z",
        labels: ["sentry-triage", "sentry:verdict-upstream"],
      },
      {
        number: 11,
        title: buildQueueTitle("X-11", "web", "error"),
        state: "OPEN",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
      {
        number: 12,
        title: buildQueueTitle("X-12", "web", "error"),
        state: "CLOSED",
        closedAt: "2026-07-18T00:00:00Z",
        labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
      },
    ],
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );

  assertEqual(counts.recovered, 0);
  assertDeepEqual(fake.calls, []);
});

await test("a stub reopened by the regression path is not swept a second time", async () => {
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    lastSeen: "2026-07-20T00:00:00Z",
  });
  // The pairing ingest's own reopen leaves behind when it crashes between the
  // label edit and the state change: closed, already re-labeled needs-triage.
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 200,
        title: buildQueueTitle("X-9", "unknown", "error"),
        state: "CLOSED",
        closedAt: "2026-07-19T00:00:00Z",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
  });
  let reopened = 0;

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
      reopenIssue: async (options, existingIssue) => {
        reopened += 1;
        assertEqual(existingIssue.number, 200);
        await fake.runGh(["issue", "reopen", "200", "-R", REPO]);
      },
    }),
  );

  assertEqual(reopened, 1);
  assertEqual(counts.reopened, 1);
  assertEqual(counts.recovered, 0);
  assertEqual(fake.get(200).state, "OPEN");
});

// ---------------------------------------------------------------------------
// Regression-reopen crash window (issue #1706 follow-up).
//
// `reopenQueueIssue` makes three writes. The invariant across EVERY
// interruption point: the stub is never left re-queued for triage
// (`sentry:needs-triage`) without the regression fence. That combination is the
// dangerous half — once Sentry drops the issue out of `is:regressed`, the
// stranded sweep reopens it carrying only its non-fence bookkeeping note, and a
// triage round that dies before posting lets the `always()` verdict job accept
// the pre-regression verdict and close over the new occurrence.
// ---------------------------------------------------------------------------

const REGRESSED_STUB = {
  number: 200,
  title: buildQueueTitle("X-9", "web", "error"),
  state: "CLOSED",
  closedAt: "2026-07-19T00:00:00Z",
  labels: ["sentry-triage", "sentry:verdict-upstream"],
};
const REGRESSED_SENTRY = mapSentryIssue({
  id: 9,
  shortId: "X-9",
  lastSeen: "2026-07-20T00:00:00Z",
});

for (const verb of ["comment", "edit", "reopen"]) {
  for (const mode of ["reject", "ambiguous"]) {
    await test(`regression reopen never leaves a queued-without-fence stub (${mode} on ${verb})`, async () => {
      const fake = makeFakeGitHub({
        issues: [{ ...REGRESSED_STUB }],
        rejectOn: (args) => mode === "reject" && args[1] === verb,
        ambiguousOn: (args) => mode === "ambiguous" && args[1] === verb,
      });

      let threw = false;
      try {
        await reopenQueueIssue(
          { repo: REPO },
          { number: 200 },
          REGRESSED_SENTRY,
          {
            runGh: fake.runGh,
          },
        );
      } catch {
        threw = true;
      }
      assert(threw, "the interrupted write must surface as a rejection");

      const issue = fake.get(200);
      const queued = issue.labels.includes(NEEDS_TRIAGE_LABEL);
      const fenced = issue.comments.some((body) =>
        body.startsWith("Regressed in Sentry (last seen "),
      );
      const shape = `labels=${JSON.stringify(issue.labels)} state=${issue.state} comments=${JSON.stringify(issue.comments)}`;
      // Rule 1 — fence first: never re-queued for triage without the fence.
      assert(
        !(queued && !fenced),
        `interrupting ${verb} left the stub queued for triage with no fence: ${shape}`,
      );
      // Rule 2 — state change last: never reopened without being selectable,
      // which would leave it open and invisible to triage forever.
      assert(
        !(issue.state === "OPEN" && !queued),
        `interrupting ${verb} left the stub open but not selectable: ${shape}`,
      );
    });
  }
}

await test("an interrupted regression reopen retries without double-posting the fence", async () => {
  // Crash after the fence lands but before the state change — the widest
  // window the fence-first order opens. The retry must complete the sequence
  // and leave exactly ONE fence comment.
  let armed = true; // fires once, so the retry below runs against a live fake
  const fake = makeFakeGitHub({
    issues: [{ ...REGRESSED_STUB }],
    ambiguousOn: (args) => {
      if (args[1] !== "reopen" || !armed) return false;
      armed = false;
      return true;
    },
  });

  await assertRejectsAsync(() =>
    reopenQueueIssue({ repo: REPO }, { number: 200 }, REGRESSED_SENTRY, {
      runGh: fake.runGh,
    }),
  );
  // The ambiguous reopen actually landed, so model the harsher retry: put the
  // stub back where a crashed run would have left it, still closed.
  fake.get(200).state = "CLOSED";
  fake.get(200).closedAt = REGRESSED_STUB.closedAt;

  await reopenQueueIssue({ repo: REPO }, { number: 200 }, REGRESSED_SENTRY, {
    runGh: fake.runGh,
  });

  const issue = fake.get(200);
  assertEqual(issue.state, "OPEN");
  assertDeepEqual(issue.labels, ["sentry-triage", NEEDS_TRIAGE_LABEL]);
  assertDeepEqual(issue.comments, [
    buildRegressedComment("2026-07-20T00:00:00Z"),
  ]);
});

await test("a NEWER regression still posts its own fence over an older one", async () => {
  // The dedup guard is exact-body, so it must never suppress the fence a fresh
  // occurrence needs — only an identical re-post of one already in place.
  const fake = makeFakeGitHub({
    issues: [
      {
        ...REGRESSED_STUB,
        comments: [buildRegressedComment("2026-07-20T00:00:00Z")],
      },
    ],
  });

  await reopenQueueIssue(
    { repo: REPO },
    { number: 200 },
    mapSentryIssue({ id: 9, shortId: "X-9", lastSeen: "2026-07-25T00:00:00Z" }),
    { runGh: fake.runGh },
  );

  assertDeepEqual(fake.get(200).comments, [
    buildRegressedComment("2026-07-20T00:00:00Z"),
    buildRegressedComment("2026-07-25T00:00:00Z"),
  ]);
});

await test("one unrecoverable stub is counted without stranding the rest", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
      {
        number: 43,
        title: buildQueueTitle("X-43", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      recoverStranded: async (options, issue) => {
        if (issue.number === 42) throw new Error("gh issue edit failed");
        await recoverStrandedQueueIssue(options, issue, { runGh: fake.runGh });
      },
    }),
  );

  assertEqual(counts.recovered, 1);
  // Nonzero errors is what makes the scheduled run go red and fire the
  // Slack-on-failure notifier.
  assertEqual(counts.errors, 1);
  assertEqual(fake.get(43).state, "OPEN");
  assertEqual(fake.get(42).state, "CLOSED");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
