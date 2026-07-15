#!/usr/bin/env node
import {
  buildMetadataYaml,
  buildQueueLabels,
  buildQueueTitle,
  buildRegressedComment,
  buildRunRecordBody,
  classifyNoise,
  decideDedupAction,
  defangBackticks,
  extractShortIdFromTitle,
  indexQueueIssuesByShortId,
  mapSentryIssue,
  mergeSentryIssues,
  parseArgs,
  parseLinkHeader,
  resolveTokenGuard,
  runIngest,
  sanitizeFreeText,
  truncateTitle,
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

await test("queue title format matches the normative contract", () => {
  const title = buildQueueTitle(
    "GOVERNANCE-MENTO-ORG-51",
    "CombinedGraphQLErrors",
  );
  assertEqual(title, "[sentry] GOVERNANCE-MENTO-ORG-51: CombinedGraphQLErrors");
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

await test("queue title neutralizes an attempted fence breakout in the title", () => {
  const title = buildQueueTitle("X-1", "```\nmalicious");
  assert(!title.includes("`"), "expected backticks stripped from queue title");
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

await test("metadata YAML renders every contract field in order", () => {
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
    culprit: "handler in routes.ts",
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
});

await test("metadata YAML defangs an embedded fence-breakout attempt", () => {
  const yaml = buildMetadataYaml({
    short_id: "X-1",
    sentry_issue_id: "1",
    project: "p",
    level: "error",
    status: "unresolved",
    events: 0,
    users: 0,
    first_seen: null,
    last_seen: null,
    culprit: "```\n@everyone this breaks out",
    permalink: "",
  });
  const lines = yaml.split("\n");
  assertEqual(lines[0], "```yaml");
  // Only the closing fence line may be a bare triple-backtick; the embedded
  // "```" from the untrusted culprit must have been defanged, so it must not
  // introduce a second one anywhere in the block.
  const bareFenceLines = lines.filter((line) => line.trim() === "```");
  assertEqual(bareFenceLines.length, 1);
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

await test("regressed comment matches the contract phrasing", () => {
  assertEqual(
    buildRegressedComment("2026-07-14T10:00:00Z"),
    "Regressed in Sentry (last seen 2026-07-14T10:00:00Z)",
  );
});

await test("queue issue index extracts short IDs from titles and dedupes", () => {
  assertEqual(
    extractShortIdFromTitle("[sentry] GOVERNANCE-MENTO-ORG-51: Some title"),
    "GOVERNANCE-MENTO-ORG-51",
  );
  assertEqual(extractShortIdFromTitle("not a queue issue"), null);

  const index = indexQueueIssuesByShortId([
    { number: 1, title: "[sentry] X-1: first", state: "OPEN" },
    { number: 2, title: "[sentry] X-1: duplicate", state: "OPEN" },
    { number: 3, title: "[sentry] X-2: other", state: "CLOSED" },
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
    { fetched: 5, created: 2, skippedExisting: 2, reopened: 1, errors: 0 },
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
  assert(body.includes("Errors: 0"), "missing errors count");
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

await test("parseArgs applies defaults", () => {
  const options = parseArgs([]);
  assertEqual(options.repo, "mento-protocol/monitoring-monorepo");
  assertEqual(options.org, "mento-labs");
  assertEqual(options.trackerIssue, 1282);
  assertEqual(options.dryRun, false);
});

await test("parseArgs reads flags and rejects a bad tracker issue", () => {
  const options = parseArgs(["--dry-run", "--tracker-issue", "42"]);
  assertEqual(options.dryRun, true);
  assertEqual(options.trackerIssue, 42);
  assertThrows(() => parseArgs(["--tracker-issue", "0"]), /positive integer/);
  assertThrows(() => parseArgs(["--nope"]), /Unknown option/);
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
        title: buildQueueTitle(sentryIssue.shortId, sentryIssue.title),
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
      title: buildQueueTitle("X-9", "Regressed bug"),
      state: "CLOSED",
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

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
