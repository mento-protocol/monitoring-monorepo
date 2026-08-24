#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildIssueBody,
  buildMetadataYaml,
  buildNewIssuesQuery,
  buildQueueLabels,
  buildQueueTitle,
  buildRegressedComment,
  buildRequeueAddLabelArgs,
  buildRequeueShedLabelArgs,
  buildRunRecordBody,
  buildStrandedRecoveryComment,
  APPROVED_ARCHIVE_LABEL,
  ARCHIVED_LABEL,
  classifyNoise,
  defaultFetchMergedSentryIssues,
  ESCALATING_ISSUES_QUERY,
  REOPEN_CAUSE_ESCALATING as ESCALATING_REOPEN_CAUSE,
  REOPEN_CAUSE_REGRESSED as REGRESSED_REOPEN_CAUSE,
  REGRESSED_ISSUES_QUERY,
  decideDedupAction,
  defangBackticks,
  defangMentions,
  extractShortIdFromTitle,
  fetchAllSentryIssues,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
  ghPaginate,
  indexQueueIssuesByShortId,
  isSafeNextPageUrl,
  isStrandedNeedsTriage,
  isStrandedOpenVerdict,
  LABEL_DEFINITIONS,
  mapSentryIssue,
  mergeSentryIssues,
  NEEDS_HUMAN_VERDICT_LABEL,
  NEEDS_TRIAGE_LABEL,
  normalizeRestIssues,
  parseArchiveBaseline,
  parseArgs,
  parseLinkHeader,
  PROJECTED_LABEL,
  recoverStrandedQueueIssue,
  reopenBaselineOf,
  reopenQueueIssue,
  REOPEN_SHED_LABELS,
  resolveLookbackDays,
  resolveTokenGuard,
  RUN_RECORD_MARKER,
  runIngest,
  sanitizeFreeText,
  STRAND_SHAPE_CLOSED_NEEDS_TRIAGE,
  STRAND_SHAPE_OPEN_VERDICT,
  STRANDED_OPEN_VERDICT_MIN_IDLE_MS,
  strandedShapeOf,
  toMetadata,
  truncateTitle,
  VERDICT_LABELS,
  withArchiveBaseline,
} from "./sentry-triage-ingest.mjs";
import * as ingestModule from "./sentry-triage-ingest.mjs";
import {
  ARCHIVE_COMMENT_MARKER,
  REGRESSION_PREFIX,
  selectMarkedComment,
  selectVerdictComment,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
// The two workflow-facing helpers the round binding (#1717) spans: what the
// select job records before the agent runs, and what the verdict job resolves
// after it. Imported from the entry module because that is where they live.
import { runParseOnly, runPriorVerdicts } from "./sentry-triage-project.mjs";

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    // The message is what says WHICH property was being asserted; call sites
    // already pass one, and dropping it left a bare value mismatch to read.
    throw new Error(
      `${message ? `${message}: ` : ""}expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
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

await test("assertEqual reports the message its call site passed", () => {
  let thrown = null;
  try {
    assertEqual(3, 10, "the count is the signal; the list is an affordance");
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert(thrown !== null, "a mismatch must throw");
  assert(
    thrown.includes("the count is the signal; the list is an affordance"),
    `the failure output must name what was asserted; got: ${thrown}`,
  );
  assert(thrown.includes("expected 10, got 3"), `values kept: ${thrown}`);
});

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

// ---------------------------------------------------------------------------
// Archive freshness baseline (issue #1371). An archived stub's close postdates
// any event that landed inside the archive's mutation window, so the reopen
// gate must compare against the baseline the archive recorded — not closedAt,
// which would evaluate false for that event forever.
// ---------------------------------------------------------------------------

function archivedStub(closedAt = "2026-07-17T08:00:00Z") {
  return {
    state: "CLOSED",
    closedAt,
    labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
  };
}

await test("dedup: archived stub reopens when lastSeen is newer than the archive baseline", () => {
  // The event landed BEFORE the close (so the closedAt gate would skip it
  // forever) but AFTER the baseline the archive observed — a real regression.
  const decision = decideDedupAction({
    existingIssue: archivedStub("2026-07-17T08:00:00Z"),
    isRegressed: true,
    lastSeen: "2026-07-17T07:59:30Z",
    archiveBaseline: "2026-07-17T07:59:00Z",
    archiveBaselineIssueId: "6197137101",
    sentryIssueId: "6197137101",
  });
  assertEqual(decision.action, "reopen");
});

await test("dedup: archived stub stays closed when the baseline is newer than lastSeen", () => {
  const decision = decideDedupAction({
    existingIssue: archivedStub(),
    isRegressed: true,
    lastSeen: "2026-07-17T07:00:00Z",
    archiveBaseline: "2026-07-17T07:59:00Z",
    archiveBaselineIssueId: "6197137101",
    sentryIssueId: "6197137101",
  });
  assertEqual(decision.action, "skip");
  assertEqual(
    decision.reason,
    "archived, no events since the archive baseline",
  );
});

await test("dedup: a usable bound baseline wins over a missing closedAt", () => {
  // Pins the branch ORDER. Hoisting the closedAt fail-open above the baseline
  // branch — the shape this code had before #1371 — makes both cases below
  // reopen, defeating the baseline on every run for a stub whose closed_at the
  // REST payload omitted. The baseline names the instant the archive actually
  // observed; closedAt is only a proxy for it, so the baseline decides.
  const decision = decideDedupAction({
    existingIssue: {
      state: "CLOSED",
      closedAt: null,
      labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
    },
    isRegressed: true,
    lastSeen: "2026-07-17T07:00:00Z",
    archiveBaseline: "2026-07-17T07:59:00Z",
    archiveBaselineIssueId: "6197137101",
    sentryIssueId: "6197137101",
  });
  assertEqual(decision.action, "skip");
  assertEqual(
    decision.reason,
    "archived, no events since the archive baseline",
  );
  // The same missing closedAt with an event past the baseline still reopens —
  // the baseline decides in both directions, not just toward skip.
  assertEqual(
    decideDedupAction({
      existingIssue: {
        state: "CLOSED",
        closedAt: null,
        labels: ["sentry-triage", "sentry:archived"],
      },
      isRegressed: true,
      lastSeen: "2026-07-17T08:30:00Z",
      archiveBaseline: "2026-07-17T07:59:00Z",
      archiveBaselineIssueId: "6197137101",
      sentryIssueId: "6197137101",
    }).action,
    "reopen",
  );
});

await test("dedup: a baseline bound to another Sentry issue cannot gate the decision", () => {
  // The archive leg records the id it mutated beside the timestamp. A baseline
  // naming a different id — or naming none, which is what an injected one looks
  // like — is evidence about some other issue, so it must not suppress this
  // issue's reopen. Fails OPEN toward re-triage, like every other ambiguity
  // here: a wrongly skipped regression is silent, a wrongly reopened one merely
  // re-triages (and the reopen sheds sentry:archived, so it cannot loop).
  const skipShaped = {
    existingIssue: archivedStub("2026-07-17T08:00:00Z"),
    isRegressed: true,
    lastSeen: "2026-07-17T07:00:00Z",
    archiveBaseline: "2026-07-17T07:59:00Z",
  };
  // Same inputs WITH a bound id would skip (previous test) — only the binding
  // differs here.
  assertEqual(
    decideDedupAction({
      ...skipShaped,
      archiveBaselineIssueId: "999",
      sentryIssueId: "6197137101",
    }).action,
    "reopen",
  );
  assertEqual(
    decideDedupAction({
      ...skipShaped,
      archiveBaselineIssueId: "",
      sentryIssueId: "6197137101",
    }).action,
    "reopen",
  );
  assertEqual(
    decideDedupAction({
      ...skipShaped,
      archiveBaselineIssueId: "6197137101",
      sentryIssueId: "",
    }).action,
    "reopen",
  );
});

await test("dedup: a missing baseline falls back to the closedAt comparison", () => {
  // Backward compatibility with every stub archived before the baseline
  // contract existed: no baseline means the old closedAt gate, unchanged.
  assertEqual(
    decideDedupAction({
      existingIssue: archivedStub("2026-07-17T08:00:00Z"),
      isRegressed: true,
      lastSeen: "2026-07-17T07:59:30Z",
    }).action,
    "skip",
  );
  assertEqual(
    decideDedupAction({
      existingIssue: archivedStub("2026-07-17T08:00:00Z"),
      isRegressed: true,
      lastSeen: "2026-07-17T09:30:00Z",
      archiveBaseline: null,
    }).action,
    "reopen",
  );
});

await test("dedup: an unparsable baseline falls back without throwing", () => {
  for (const garbage of ["not-a-date", "", "   ", "{}", "2026-13-45T99:99Z"]) {
    assertEqual(
      decideDedupAction({
        existingIssue: archivedStub("2026-07-17T08:00:00Z"),
        isRegressed: true,
        lastSeen: "2026-07-17T07:59:30Z",
        archiveBaseline: garbage,
      }).action,
      "skip",
    );
    assertEqual(
      decideDedupAction({
        existingIssue: archivedStub("2026-07-17T08:00:00Z"),
        isRegressed: true,
        lastSeen: "2026-07-17T09:30:00Z",
        archiveBaseline: garbage,
      }).action,
      "reopen",
    );
  }
});

await test("dedup: a baseline on a stub without sentry:archived is ignored", () => {
  // Only the archive leg records a baseline; a stub closed by the ordinary
  // verdict path must keep using closedAt even if a baseline is passed in.
  assertEqual(
    decideDedupAction({
      existingIssue: {
        state: "CLOSED",
        closedAt: "2026-07-17T08:00:00Z",
        labels: ["sentry-triage", "sentry:verdict-upstream"],
      },
      isRegressed: true,
      lastSeen: "2026-07-17T07:59:30Z",
      archiveBaseline: "2026-07-17T07:59:00Z",
    }).action,
    "skip",
  );
});

await test("dedup: an event absorbed by the approval-to-run window still reopens (#1692)", () => {
  // T0 the stub's own `last_seen`; T1 the human approves; T2 the event lands;
  // T3 the archive reads Sentry and sees T2. Comparing T2 against the archive's
  // T3 read answers "skip" — for the very event that produced it, forever. The
  // archive now records T0 for this gate, and T2 > T0 is a reopen.
  const absorbedEvent = "2026-07-17T07:59:30Z";
  const archiveRead = absorbedEvent; // the archive's read IS the absorbed event
  const preApproval = "2026-07-14T10:00:00Z";
  const stub = archivedStub("2026-07-17T08:00:00Z");

  const decide = (archiveBaseline) =>
    decideDedupAction({
      existingIssue: stub,
      isRegressed: true,
      lastSeen: absorbedEvent,
      archiveBaseline,
      archiveBaselineIssueId: "6197137101",
      sentryIssueId: "6197137101",
    }).action;

  assertEqual(decide(archiveRead), "skip", "the window this issue closes");
  assertEqual(decide(preApproval), "reopen");
});

await test("reopenBaselineOf prefers the pre-approval field and falls back to the live read", () => {
  const body = (fields) =>
    ["<!-- sentry-triage:v1 -->", "", "```yaml", ...fields, "```"].join("\n");
  const both = parseArchiveBaseline(
    body([
      'archive_baseline_last_seen: "2026-07-19T11:59:00.000Z"',
      'archive_reopen_baseline_last_seen: "2026-07-14T10:00:00Z"',
      'archive_baseline_sentry_issue_id: "6197137101"',
    ]),
  );
  assertEqual(reopenBaselineOf(both), "2026-07-14T10:00:00Z");

  // A stub archived before the second field existed keeps its old behaviour
  // rather than losing the baseline entirely.
  const legacy = parseArchiveBaseline(
    body([
      'archive_baseline_last_seen: "2026-07-19T11:59:00.000Z"',
      'archive_baseline_sentry_issue_id: "6197137101"',
    ]),
  );
  assertEqual(legacy.reopenLastSeen, "");
  assertEqual(reopenBaselineOf(legacy), "2026-07-19T11:59:00.000Z");
  assertEqual(reopenBaselineOf(null), null);
});

await test("an archived stub's PRE-APPROVAL baseline drives the reopen decision (#1692)", async () => {
  // Wiring, end to end: runIngest must hand decideDedupAction the reopen
  // baseline out of the body, not the archive-time read sitting beside it.
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "Regressed bug",
    lastSeen: "2026-07-19T11:59:00Z",
  });
  let reopenCount = 0;
  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    {
      fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
      listQueueIssues: async () => [
        {
          number: 200,
          title: buildQueueTitle("X-9", "unknown", "error"),
          state: "CLOSED",
          closedAt: "2026-07-19T12:00:00Z",
          labels: ["sentry-triage", "sentry:archived"],
          // The archive read exactly this event, so the old baseline skips it.
          body: archivedStubBody({
            lastSeen: "2026-07-19T11:59:00Z",
            reopenLastSeen: "2026-07-19T00:00:00Z",
          }),
        },
      ],
      ensureLabels: async () => {},
      createIssue: async () => {
        throw new Error("unexpected create in this scenario");
      },
      reopenIssue: async () => {
        reopenCount += 1;
      },
      postRunRecord: async () => {},
      now: () => new Date("2026-07-20T05:30:00.000Z"),
    },
  );
  assertEqual(result.reopened, 1);
  assertEqual(reopenCount, 1);
});

await test("the stub body is rendered once, at creation (#1692)", () => {
  // `buildIssueBody` is the only thing that renders `last_seen` into a body, and
  // the reopen baseline's whole worth is that the value it renders is never
  // refreshed: that is what makes it provably earlier than the human approval a
  // later archive run acts on. A second call site — a "freshen it on reopen"
  // edit being the obvious one — would move the baseline later and narrow the
  // gate this issue exists to widen, so the docstrings on `parseStubMetadata`
  // and `pickReopenBaseline` name creation specifically. Pin it.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-triage-ingest.mjs"),
    "utf8",
  );
  const calls = src.match(/(?<!function\s)\bbuildIssueBody\s*\(/g) ?? [];
  // Exactly one — the declaration is excluded by the lookbehind.
  assertEqual(calls.length, 1);
  assert(
    /async function createQueueIssue\([\s\S]*?buildIssueBody\(/.test(src),
    "the single call must sit inside createQueueIssue",
  );
});

await test("parseArchiveBaseline reads the yaml fields and tolerates junk", () => {
  const parsed = parseArchiveBaseline(
    [
      "<!-- sentry-triage-archive:v1 -->",
      "",
      "```yaml",
      'archive_baseline_last_seen: "2026-07-19T11:59:00.000Z"',
      'archive_baseline_sentry_issue_id: "6197137101"',
      "```",
    ].join("\n"),
  );
  assertEqual(parsed.lastSeen, "2026-07-19T11:59:00.000Z");
  assertEqual(parsed.sentryIssueId, "6197137101");
  // No yaml block, no baseline field, and a nonsense body all return null.
  assertEqual(parseArchiveBaseline("just a comment"), null);
  assertEqual(parseArchiveBaseline("```yaml\nother: 1\n```"), null);
  assertEqual(parseArchiveBaseline(null), null);
});

await test("withArchiveBaseline round-trips through parseArchiveBaseline", () => {
  const body = buildIssueBody(
    toMetadata({
      id: "6197137101",
      shortId: "GOV-51",
      project: { slug: "gov" },
      lastSeen: "2026-07-14T10:00:00Z",
      permalink: "https://mento-labs.sentry.io/issues/6197137101/",
    }),
  );
  assertEqual(parseArchiveBaseline(body), null, "a fresh stub carries none");

  const stamped = withArchiveBaseline(body, {
    lastSeen: "2026-07-19T11:59:00.000Z",
    sentryIssueId: "6197137101",
  });
  const parsed = parseArchiveBaseline(stamped);
  assertEqual(parsed.lastSeen, "2026-07-19T11:59:00.000Z");
  assertEqual(parsed.sentryIssueId, "6197137101");
  // The rewrite extends the existing block; it must not drop what ingest wrote.
  for (const keep of ["short_id", "sentry_issue_id", "project", "permalink"]) {
    assert(stamped.includes(keep), `lost ${keep}`);
  }

  // A re-archive supersedes rather than appending a second copy.
  const restamped = withArchiveBaseline(stamped, {
    lastSeen: "2026-07-20T00:00:00.000Z",
    sentryIssueId: "6197137101",
  });
  assertEqual(
    parseArchiveBaseline(restamped).lastSeen,
    "2026-07-20T00:00:00.000Z",
  );
  assertEqual(
    restamped.match(/archive_baseline_last_seen:/g).length,
    1,
    "exactly one baseline field survives a re-archive",
  );

  // No yaml block to extend → null, and the archive refuses rather than settling.
  assertEqual(withArchiveBaseline("no yaml here", { lastSeen: "x" }), null);
});

await test("a baseline in a COMMENT is never readable — the forgery surface is gone", () => {
  // .github/workflows/sentry-triage-agent.yml grants the triage LLM
  // `Bash(gh issue comment <its stub>:*)`, and those comments post as
  // github-actions[bot]. So a prompt-injected Sentry payload can produce a
  // comment that clears any author, marker, or id fence. The only durable answer
  // is that nothing machine-read lives in a comment: ingest parses the stub BODY
  // and has no comment-reading path at all.
  const forged = [
    ARCHIVE_COMMENT_MARKER,
    "",
    "**Sentry issue archived**",
    "",
    "```yaml",
    'archive_baseline_last_seen: "2099-01-01T00:00:00Z"',
    'archive_baseline_sentry_issue_id: "6197137101"',
    "```",
  ].join("\n");
  // The string itself parses — that is the point. Nothing in ingest ever hands
  // it to the parser, because the only input is `existingIssue.body`.
  assertEqual(parseArchiveBaseline(forged).lastSeen, "2099-01-01T00:00:00Z");
  assertEqual(
    typeof runIngest,
    "function",
    "ingest exposes no comment-scanning baseline reader",
  );
  for (const gone of ["findArchiveBaseline", "fetchArchiveBaseline"]) {
    assertEqual(
      Object.keys(ingestModule).includes(gone),
      false,
      `${gone} must not exist — it would reopen the comment forgery surface`,
    );
  }
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

await test("Sentry pagination fails loud past maxPages instead of truncating", async () => {
  // The queue is built by DIFFERENCE, so a Sentry issue missing from this
  // result set is one no stub is created for. A cap that returns partial pages
  // and reports success is therefore indistinguishable from a quiet Sentry —
  // the same reason `ghPaginate` throws rather than stopping.
  let served = 0;
  const fetchImpl = async () => {
    served += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [{ id: String(served), shortId: `X-${served}` }],
      // Always another page: this is the runaway the cap exists to bound.
      headers: {
        get: () =>
          '<https://us.sentry.io/api/0/organizations/o/issues/?cursor=next>; rel="next"; results="true"; cursor="next"',
      },
    };
  };

  let threw = null;
  try {
    await fetchAllSentryIssues({
      query: "is:unresolved",
      org: "o",
      baseUrl: "https://us.sentry.io",
      token: "t",
      fetchImpl,
      maxPages: 3,
    });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected a truncated Sentry scan to throw");
  assert(
    /exceeded 3 pages/.test(threw.message),
    `wrong Sentry runaway error: ${threw?.message}`,
  );
  assertEqual(served, 3);

  // The bounded case still returns, and the boundary is where it matters:
  // `maxPages: 2` for a scan that ends ON its last allowed page, so a guard
  // reading "the cap was reached" rather than "a cursor survived it" is caught.
  // Both terminators, because Sentry uses the SECOND one: it keeps sending a
  // `rel="next"` link at the end of a result set and signals exhaustion with
  // `results="false"`. A guard recognising only a missing Link header would
  // throw on every real ingest run.
  for (const [label, terminator] of [
    ["no Link header at all", null],
    [
      "Sentry's results=false terminator",
      '<https://us.sentry.io/api/0/organizations/o/issues/?cursor=end>; rel="next"; results="false"; cursor="end"',
    ],
  ]) {
    let round = 0;
    const finite = async () => {
      round += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: String(round), shortId: `X-${round}` }],
        headers: {
          get: () =>
            round < 2
              ? '<https://us.sentry.io/api/0/organizations/o/issues/?cursor=next>; rel="next"; results="true"; cursor="next"'
              : terminator,
        },
      };
    };
    const issues = await fetchAllSentryIssues({
      query: "is:unresolved",
      org: "o",
      baseUrl: "https://us.sentry.io",
      token: "t",
      fetchImpl: finite,
      maxPages: 2,
    });
    assert(
      issues.length === 2,
      `a scan ending exactly at the page budget with ${label} must return both pages; got ${issues.length}`,
    );
  }
});

await test("REST issue normalization flattens pages, drops PRs, uppercases state, carries closed_at + updated_at + labels + body", () => {
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
        // The sweep's idleness clock for the OPEN strand shape rides in the
        // same list response — no extra request, and no sweep without it.
        updated_at: "2026-07-16T12:00:00Z",
        labels: [{ name: "sentry-triage" }, { name: "sentry:archived" }],
        // The REST list already returns the body, so the archive baseline
        // costs no extra request — and lives nowhere a comment can reach.
        body: '```yaml\narchive_baseline_last_seen: "2026-07-16T11:00:00Z"\n```',
      },
      {
        number: 3,
        title: "a PR, not an issue",
        state: "open",
        pull_request: {},
      },
    ],
    // Label name STRINGS (not objects) must normalize identically: the stranded
    // sweep reads this field, and a silent [] here would make it inert. Closed
    // and needing triage is exactly the pairing it looks for.
    [
      {
        number: 4,
        title: "[sentry] X-4: c",
        state: "closed",
        labels: ["sentry-triage", "sentry:needs-triage"],
      },
    ],
  ]);
  assertDeepEqual(normalized, [
    {
      number: 1,
      title: "[sentry] X-1: a",
      state: "OPEN",
      closedAt: null,
      updatedAt: null,
      body: "",
      labels: ["sentry-triage", "sentry:needs-triage"],
    },
    {
      number: 2,
      title: "[sentry] X-2: b",
      state: "CLOSED",
      closedAt: "2026-07-16T12:00:00Z",
      updatedAt: "2026-07-16T12:00:00Z",
      body: '```yaml\narchive_baseline_last_seen: "2026-07-16T11:00:00Z"\n```',
      labels: ["sentry-triage", "sentry:archived"],
    },
    {
      number: 4,
      title: "[sentry] X-4: c",
      state: "CLOSED",
      closedAt: null,
      updatedAt: null,
      body: "",
      labels: ["sentry-triage", "sentry:needs-triage"],
    },
  ]);
  assert(
    isStrandedNeedsTriage(normalized[2]),
    "a closed stub still labeled needs-triage must survive normalization as stranded",
  );
  assertEqual(
    parseArchiveBaseline(normalized[1].body).lastSeen,
    "2026-07-16T11:00:00Z",
  );
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
  // Both regressed and escalating land in this counter (#1765); the label must
  // not tell an operator a reopen was a regression when it was an escalation.
  assert(
    body.includes("Reopened (regressed or escalating): 1"),
    "missing reopened count",
  );
  // A counts object from before the second strand counter existed must still
  // render a number here — an operator reading "undefined" learns nothing.
  assert(
    body.includes("Recovered (stranded open verdict): 0"),
    "missing open-verdict recovery count",
  );
  assert(
    body.includes("Recovered (stranded needs-triage): 3"),
    "missing recovered count",
  );
  assert(body.includes("Errors: 0"), "missing errors count");
});

// Comments as the raw REST endpoint returns them (the shape
// fetchTrackerComments consumes): pipeline-authored comments resolve to the
// Actions bot login "github-actions[bot]".
function trackerComment(id, body, login) {
  return { id, body, user: { login } };
}

// The fence itself (selectMarkedComment) is unit-tested directly in
// sentry-triage-project.test.mjs; these cover the ingest's own wiring of it
// against RUN_RECORD_MARKER.
await test("ingest run-record selection ignores a marker planted by an untrusted author", () => {
  const planted = trackerComment(
    999,
    `${RUN_RECORD_MARKER}\n\nDrive-by defacement.`,
    "drive-by-user",
  );
  assertEqual(selectMarkedComment([planted], RUN_RECORD_MARKER), null);
});

await test("ingest run-record selection rejects a trusted comment where the marker is mid-body, not anchored at the start", () => {
  const midBody = trackerComment(
    1,
    `Some chatter.\n\n${RUN_RECORD_MARKER}`,
    "github-actions[bot]",
  );
  assertEqual(selectMarkedComment([midBody], RUN_RECORD_MARKER), null);
});

await test("ingest run-record selection picks the pipeline's own prefix-anchored, trusted-author record", () => {
  const genuine = trackerComment(
    1,
    `${RUN_RECORD_MARKER}\n\n**Sentry triage ingest — last run:** now`,
    "github-actions[bot]",
  );
  const planted = trackerComment(
    999,
    `${RUN_RECORD_MARKER}\n\nDrive-by defacement.`,
    "drive-by-user",
  );
  const selected = selectMarkedComment([planted, genuine], RUN_RECORD_MARKER);
  assert(selected !== null, "expected the genuine record to be selected");
  assertEqual(selected.id, 1);
});

await test("ingest run-record selection returns null when no comment qualifies", () => {
  assertEqual(selectMarkedComment([], RUN_RECORD_MARKER), null);
  assertEqual(
    selectMarkedComment(
      [trackerComment(1, "chatter", "github-actions")],
      RUN_RECORD_MARKER,
    ),
    null,
  );
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

await test("the architectural hold label sits OUTSIDE the sentry:verdict-* namespace (#1812 settlement post-condition)", () => {
  // The settlement step's post-condition reread counts ONLY labels starting with
  // `sentry:verdict-`, and refuses (re-queues) a stub carrying >1. The hold label
  // rides the SAME atomic edit as the verdict label, so it MUST NOT match that
  // prefix or every held stub would read as double-verdicted and be re-queued.
  assert(
    !FIX_SCOPE_ARCHITECTURAL_LABEL.startsWith("sentry:verdict-"),
    `the hold label must not match the counted verdict prefix: ${FIX_SCOPE_ARCHITECTURAL_LABEL}`,
  );
  assert(
    !VERDICT_LABELS.includes(FIX_SCOPE_ARCHITECTURAL_LABEL),
    "the hold label must not be in the verdict namespace",
  );
  // Concretely: a held stub carrying verdict-code-fix + the hold label counts as
  // exactly ONE verdict label under the survivor filter.
  const heldLabels = ["sentry:verdict-code-fix", FIX_SCOPE_ARCHITECTURAL_LABEL];
  const survivors = heldLabels.filter((name) =>
    name.startsWith("sentry:verdict-"),
  );
  assertEqual(survivors.length, 1);
  // It IS shed on regression so the fresh round re-decides scope.
  assert(
    REOPEN_SHED_LABELS.includes(FIX_SCOPE_ARCHITECTURAL_LABEL),
    "the hold label must be shed on regression",
  );
});

await test("reopen shed set is every verdict label plus projected + autofix + archive markers", () => {
  // A reopened regression is a NEW occurrence: it must not keep reading as
  // verdicted, projected, autofixed/refused, held-architectural, or
  // approved-for-archive/archived — every one of those described the old
  // occurrence (PR #1356 review). A stale autofix marker also blocks re-autofix,
  // the fix-scope hold must clear so the fresh round re-decides scope (#1812),
  // and a stale archive approval must not carry a human sign-off into a fresh
  // occurrence.
  assertDeepEqual(REOPEN_SHED_LABELS, [
    "sentry:verdict-code-fix",
    "sentry:verdict-config-fix",
    "sentry:verdict-upstream",
    "sentry:verdict-needs-human",
    "sentry:projected",
    "sentry:fix-pr-opened",
    "sentry:fix-refused",
    "sentry:fix-scope-architectural",
    "sentry:approved-archive",
    "sentry:archived",
  ]);
  assertEqual(PROJECTED_LABEL, "sentry:projected");
});

await test("reopen label edit re-queues triage and sheds stale verdict + projected + autofix + archive labels", () => {
  // Two calls, never one: `--add-label X --remove-label Y` on a single
  // `gh issue edit` is two concurrent mutations, and losing the add half strands
  // the stub (#1693).
  assertDeepEqual(buildRequeueAddLabelArgs(200, "owner/repo"), [
    "issue",
    "edit",
    "200",
    "-R",
    "owner/repo",
    "--add-label",
    "sentry:needs-triage",
  ]);
  assertDeepEqual(buildRequeueShedLabelArgs(200, "owner/repo"), [
    "issue",
    "edit",
    "200",
    "-R",
    "owner/repo",
    "--remove-label",
    "sentry:verdict-code-fix,sentry:verdict-config-fix,sentry:verdict-upstream,sentry:verdict-needs-human,sentry:projected,sentry:fix-pr-opened,sentry:fix-refused,sentry:fix-scope-architectural,sentry:approved-archive,sentry:archived",
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

/** A stub body carrying an archive baseline, as the archive leg writes it. */
function archivedStubBody({ lastSeen, sentryIssueId = "9", reopenLastSeen }) {
  return withArchiveBaseline(
    buildIssueBody(
      toMetadata({
        id: sentryIssueId,
        shortId: "X-9",
        project: { slug: "unknown" },
        lastSeen: "2026-07-19T00:00:00Z",
        permalink: "https://mento-labs.sentry.io/issues/9/",
      }),
    ),
    { lastSeen, reopenLastSeen, sentryIssueId },
  );
}

await test("an archived stub's body baseline drives the reopen decision", async () => {
  // The event predates the archive's close but postdates the baseline it
  // recorded — the exact case a closedAt comparison buries forever (#1371).
  // Read straight out of the body the dedup scan already fetched: no per-stub
  // comment request, and no comment surface to forge.
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "Regressed bug",
    lastSeen: "2026-07-19T11:59:30Z",
  });
  let reopenCount = 0;

  const deps = {
    fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
    listQueueIssues: async () => [
      {
        number: 200,
        title: buildQueueTitle("X-9", "unknown", "error"),
        state: "CLOSED",
        closedAt: "2026-07-19T12:00:00Z",
        labels: ["sentry-triage", "sentry:archived"],
        body: archivedStubBody({ lastSeen: "2026-07-19T11:59:00Z" }),
      },
    ],
    ensureLabels: async () => {},
    createIssue: async () => {
      throw new Error("unexpected create in this scenario");
    },
    reopenIssue: async () => {
      reopenCount += 1;
    },
    postRunRecord: async () => {},
    now: () => new Date("2026-07-20T05:30:00.000Z"),
  };

  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    deps,
  );
  assertEqual(result.reopened, 1);
  assertEqual(reopenCount, 1);
});

await test("the baseline only gates a decision when it names this Sentry issue", async () => {
  // Wiring check: runIngest must hand decideDedupAction the id the archive
  // recorded AND the id of the Sentry issue in hand. The event predates the
  // baseline, so a BOUND baseline skips; the identical run with a foreign id
  // reopens instead of letting another issue's archive speak for this one.
  const runWithBaselineId = async (baselineIssueId) => {
    const sentryIssue = mapSentryIssue({
      id: 9,
      shortId: "X-9",
      title: "Regressed bug",
      lastSeen: "2026-07-19T11:58:00Z",
    });
    return runIngest(
      { repo: "owner/repo", trackerIssue: 1282 },
      {
        fetchMergedSentryIssues: async () =>
          mergeSentryIssues([], [sentryIssue]),
        listQueueIssues: async () => [
          {
            number: 200,
            title: buildQueueTitle("X-9", "unknown", "error"),
            state: "CLOSED",
            closedAt: "2026-07-19T12:00:00Z",
            labels: ["sentry-triage", "sentry:archived"],
            body: archivedStubBody({
              lastSeen: "2026-07-19T11:59:00Z",
              sentryIssueId: baselineIssueId,
            }),
          },
        ],
        ensureLabels: async () => {},
        createIssue: async () => {},
        reopenIssue: async () => {},
        postRunRecord: async () => {},
        now: () => new Date("2026-07-20T05:30:00.000Z"),
      },
    );
  };

  assertEqual((await runWithBaselineId("9")).skippedExisting, 1);
  assertEqual((await runWithBaselineId("404")).reopened, 1);
  assertEqual((await runWithBaselineId("")).reopened, 1);
});

await test("an archived stub whose body lost its baseline falls back to closedAt", async () => {
  // A stub archived before this contract existed — or one whose body a human
  // edited — carries no baseline. Behaviour must be exactly the pre-#1371 gate,
  // never a crash and never an invented comparison.
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "Regressed bug",
    lastSeen: "2026-07-19T13:00:00Z",
  });
  let reopenCount = 0;

  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    {
      fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
      listQueueIssues: async () => [
        {
          number: 200,
          title: buildQueueTitle("X-9", "unknown", "error"),
          state: "CLOSED",
          closedAt: "2026-07-19T12:00:00Z",
          labels: ["sentry-triage", "sentry:archived"],
          body: "a human replaced this body entirely",
        },
      ],
      ensureLabels: async () => {},
      createIssue: async () => {},
      reopenIssue: async () => {
        reopenCount += 1;
      },
      postRunRecord: async () => {},
      now: () => new Date("2026-07-20T05:30:00.000Z"),
    },
  );
  // lastSeen is newer than closedAt, so the closedAt gate reopens.
  assertEqual(reopenCount, 1);
  assertEqual(result.reopened, 1);
});

await test("a stub without sentry:archived ignores any baseline in its body", async () => {
  // Only the archive leg writes a baseline, and only onto a stub it archived.
  // A stub closed by the ordinary verdict path must keep using closedAt even if
  // its body somehow carries the fields.
  const sentryIssue = mapSentryIssue({
    id: 9,
    shortId: "X-9",
    title: "Regressed bug",
    lastSeen: "2026-07-19T11:59:30Z",
  });

  const result = await runIngest(
    { repo: "owner/repo", trackerIssue: 1282 },
    {
      fetchMergedSentryIssues: async () => mergeSentryIssues([], [sentryIssue]),
      listQueueIssues: async () => [
        {
          number: 200,
          title: buildQueueTitle("X-9", "unknown", "error"),
          state: "CLOSED",
          closedAt: "2026-07-19T12:00:00Z",
          labels: ["sentry-triage", "sentry:verdict-upstream"],
          body: archivedStubBody({ lastSeen: "2026-07-19T11:59:00Z" }),
        },
      ],
      ensureLabels: async () => {},
      createIssue: async () => {},
      reopenIssue: async () => {},
      postRunRecord: async () => {},
      now: () => new Date("2026-07-20T05:30:00.000Z"),
    },
  );
  // The baseline would have reopened; closedAt (12:00) skips.
  assertEqual(result.skippedExisting, 1);
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
// The sweep is deliberately PRODUCER-AGNOSTIC: it repairs the pairing from
// observed state, so it covers every producer that exists today and every one
// added later. The cases below therefore assert the repair, not any particular
// writer's argv sequence.
//
// The class of bug that writes the pairing is an AMBIGUOUS RESPONSE: a mutation
// lands server-side and only its response is lost, so the caller sees a
// rejection — and a rejected command is not proof its remote mutation did not
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
  // `gh issue edit --add-label X --remove-label Y` is NOT one write: the CLI
  // fires addLabels and removeLabels as discrete, concurrent GraphQL mutations
  // (cli/cli, pkg/cmd/pr/shared/editable_http.go). This hook models the half the
  // pipeline cannot afford to lose — the removes land, the adds do not, and the
  // CLI reports failure (issue #1693). It fires per CALL, so a sequence that
  // never puts both flags on one call keeps whatever it added earlier.
  dropAddLabelsOn = () => false,
} = {}) {
  const state = new Map(
    issues.map((issue) => [
      issue.number,
      {
        closedAt: null,
        // The sweep's idleness clock for the OPEN strand shape. Defaults far
        // enough before every fixture's `now` that a test only sets it when
        // idleness is the thing under test.
        updatedAt: "2026-07-01T00:00:00Z",
        // Bodies only — the comments the pipeline itself writes, which keeps the
        // assertions readable. `untrustedComments` models what anyone with a
        // comment box can add on this PUBLIC repo; the read below is what
        // attaches the authorship that tells the two apart.
        comments: [],
        untrustedComments: [],
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
      if (dropAddLabelsOn(args)) {
        throw fail(args);
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
    // A read: the comment scan reopenQueueIssue runs before it posts. Untrusted
    // comments come FIRST, so a guard that stops at the first body match without
    // checking the author picks the attacker's copy.
    if (args[0] === "api") {
      const number = Number(/issues\/(\d+)\/comments/.exec(args[1])?.[1]);
      const issue = state.get(number);
      return JSON.stringify([
        ...(issue?.untrustedComments ?? []).map((body) => ({
          body,
          user: { login: "drive-by-account" },
        })),
        ...(issue?.comments ?? []).map((body) => ({
          body,
          user: { login: "github-actions[bot]" },
        })),
      ]);
    }
    // A read: the sweep's pre-mutation revalidation. Serves LIVE state, so a
    // test can mutate the model after the snapshot and watch the sweep notice.
    if (args[0] === "issue" && args[1] === "view") {
      if (rejectOn(args)) throw fail(args);
      const issue = state.get(Number(args[2]));
      return JSON.stringify({
        number: issue?.number,
        state: issue?.state,
        updatedAt: issue?.updatedAt ?? null,
        labels: (issue?.labels ?? []).map((name) => ({ name })),
      });
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
        updatedAt: issue.updatedAt,
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
    // The sweep hands down the shape it matched and the instant it matched it
    // at; forward both, or the recovery falls back to the closed-pairing policy
    // and real wall-clock time.
    recoverStranded: (options, issue, sweep) =>
      recoverStrandedQueueIssue(options, issue, {
        ...sweep,
        runGh: fake.runGh,
      }),
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

await test("the recovery note does not claim a reopen that has not happened", async () => {
  // The note is posted BEFORE the reopen, because the state change goes last.
  // So it has to read as intent: a stub left closed by a failed reopen carries
  // this text, and each retry adds another copy. Copies are the honest signal
  // that recovery keeps failing — the fix is truthful wording, not a suppressor.
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
    rejectOn: (args) => args[1] === "reopen",
  });

  await assertRejectsAsync(() =>
    recoverStrandedQueueIssue(
      { repo: REPO },
      { number: 42 },
      { runGh: fake.runGh },
    ),
  );

  const issue = fake.get(42);
  assertEqual(issue.state, "CLOSED");
  assertDeepEqual(issue.comments, [buildStrandedRecoveryComment()]);

  // Every claim the note makes must hold for a stub that is still CLOSED.
  const note = issue.comments[0];
  for (const claim of [
    /\bReopened\b/,
    /\bRe-queued\b/,
    /\bhas been reopened\b/,
    /\bwas reopened\b/,
  ]) {
    assert(
      !claim.test(note),
      `the note asserts a completed reopen (${claim}) on a stub that is still ${issue.state}: ${note}`,
    );
  }
  // And it tells the reader why a duplicate is expected, so repeats read as the
  // signal they are rather than as a bug.
  assert(
    /more than once/.test(note),
    "the note should explain why it can appear twice",
  );
});

await test("a retried recovery posts the note again rather than suppressing it", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
    rejectOn: (args) => args[1] === "reopen",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertRejectsAsync(() =>
      recoverStrandedQueueIssue(
        { repo: REPO },
        { number: 42 },
        { runGh: fake.runGh },
      ),
    );
  }

  // Two attempts, two notes. A stub that keeps failing to reopen should show it.
  assertEqual(fake.get(42).comments.length, 2);
  assertEqual(fake.get(42).state, "CLOSED");
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

  // The revalidating read comes FIRST — the sweep decides on live state, never
  // on the snapshot it was handed — and the state change still comes last.
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view", "edit", "edit", "comment", "reopen"],
  );
  assertDeepEqual(fake.calls[1], buildRequeueAddLabelArgs(42, REPO));
  assertDeepEqual(fake.calls[2], buildRequeueShedLabelArgs(42, REPO));
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

// The producers that can STILL write the pairing. The triage workflow's two
// close compensations used to head this list and no longer do (#1782): they
// route through the re-queue chokepoint, whose terminal revalidation declines
// on a CLOSED stub, so a landed-but-unacknowledged close now leaves the stub
// settled rather than stranded. Their removal is asserted where that behaviour
// lives — scripts/sentry/triage/sentry-triage-requeue.test.mjs, "a close whose response was
// lost leaves the stub CLOSED, not re-queued (#1782)".
//
// What survives is the point of the sweep: it repairs the shape from OBSERVED
// state, so it does not care which of these wrote it, nor whether a producer
// added later is on the list at all. Each case starts from the end state rather
// than re-implementing a writer that lives in another module; reachability of
// the crash case is proven next door by "stranded recovery re-queues, sheds
// stale markers, and changes state last", which pins the write ordering that
// makes a crash between the two leave exactly this pairing.
for (const producer of [
  {
    // Re-queues a stub it never reopens (it must not resurrect a stub whose
    // Sentry issue is live-regressed while a human approval is outstanding).
    name: "the archive leg's live-regression refusal",
    labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:projected"],
  },
  {
    // This script's own reopen writes the label BEFORE the state change, so a
    // crash between the two leaves the label on a still-closed stub.
    name: "a crash inside ingest's own reopen sequence",
    labels: ["sentry-triage", "sentry:verdict-code-fix", "sentry:projected"],
  },
]) {
  await test(`ingest recovers a stub stranded by ${producer.name}`, async () => {
    const fake = makeFakeGitHub({
      issues: [
        {
          number: 42,
          title: buildQueueTitle("X-42", "web", "error"),
          // The stranded pairing itself: CLOSED, yet still labeled as awaiting
          // a verdict nothing will ever produce.
          state: "CLOSED",
          labels: [...producer.labels, NEEDS_TRIAGE_LABEL],
        },
      ],
    });

    // Invisible to Stage B, which lists open stubs only.
    assertDeepEqual(fake.selectable(), []);

    const counts = await runIngest(
      { repo: REPO, trackerIssue: 1282 },
      ingestDeps(fake),
    );

    // The next scheduled ingest repairs it from observed state, shedding the
    // stale verdict and projection markers on the way back into the queue.
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
// The OTHER unselectable shape: OPEN + verdict + no `sentry:needs-triage`
// (issue #1817).
//
// The verdict step swaps the queue label off before anything closes the stub,
// so every failing exit in that window owes the stub a re-queue. Those exits go
// through the chokepoint's workflow CLI, whose revalidating read retries within
// a bound and then THROWS — right, and it leaves the stub open, verdicted and
// unqueued when the read outage is persistent. Stage B selects open stubs that
// carry the label; the closed-pairing sweep matches the opposite pairing. Until
// this arm, nothing selected it.
// ---------------------------------------------------------------------------

const SWEEP_NOW = new Date("2026-07-21T05:30:00.000Z");
/** Idle by more than the threshold, relative to SWEEP_NOW. */
const IDLE_SINCE = "2026-07-19T00:00:00Z";
/** Touched moments ago: a stub a workflow is still working on. */
const JUST_TOUCHED = "2026-07-21T05:29:00Z";

const strandedOpenStub = (labels, updatedAt = IDLE_SINCE) => ({
  number: 42,
  title: buildQueueTitle("X-42", "web", "error"),
  state: "OPEN",
  updatedAt,
  labels: ["sentry-triage", ...labels],
});

await test("isStrandedOpenVerdict matches only an idle, unqueued, settling-verdict stub", () => {
  const at = { now: SWEEP_NOW };
  const shape = (labels, updatedAt = IDLE_SINCE) =>
    isStrandedOpenVerdict(strandedOpenStub(labels, updatedAt), at);

  assert(
    shape(["sentry:verdict-upstream"]),
    "open + a settling verdict + no needs-triage, idle, is the strand",
  );
  assert(
    shape(["sentry:verdict-code-fix", PROJECTED_LABEL]),
    "a projected row whose close never landed is the same strand",
  );
  assert(
    !shape([NEEDS_TRIAGE_LABEL, "sentry:verdict-upstream"]),
    "a stub still carrying the queue label is selectable, not stranded",
  );
  assert(
    !shape(["sentry:candidate-noise"]),
    "an open stub with no verdict at all is an ordinary queue member",
  );
  // The false positive that would matter most: `needs-human` RESTS open, by
  // design, and re-queuing it would delete the question a human was asked.
  assert(
    !shape([NEEDS_HUMAN_VERDICT_LABEL]),
    "a needs-human stub is awaiting a human, not stranded",
  );
  assert(
    !shape([NEEDS_HUMAN_VERDICT_LABEL, "sentry:verdict-upstream"]),
    "a double-verdicted stub carrying needs-human is still not this sweep's",
  );
  // Terminal, and a live human approval: both are in REOPEN_SHED_LABELS, so a
  // re-queue would spend them.
  assert(
    !shape(["sentry:verdict-upstream", ARCHIVED_LABEL]),
    "an archived stub must never be resurrected",
  );
  assert(
    !shape(["sentry:verdict-upstream", APPROVED_ARCHIVE_LABEL]),
    "a stub the archive workflow is acting on is not this sweep's to shed",
  );
  // Idleness, both directions, and the fail-closed case.
  assert(
    !shape(["sentry:verdict-upstream"], JUST_TOUCHED),
    "a stub written to moments ago may still be mid-flight",
  );
  assert(
    !shape(["sentry:verdict-upstream"], null),
    "no idleness observation means no sweep",
  );
  assert(
    !shape(["sentry:verdict-upstream"], "not-a-timestamp"),
    "an unparsable timestamp is not an observation either",
  );
  assert(
    !isStrandedOpenVerdict(
      {
        state: "CLOSED",
        labels: ["sentry:verdict-upstream"],
        updatedAt: IDLE_SINCE,
      },
      at,
    ),
    "a settled stub is not this shape",
  );
  // The threshold is a real bound, not a formality: exactly at it counts. It is
  // pinned because it is load-bearing — a live run reaching it needs a
  // 15-minute job queued for a full day, which the triage workflow's own
  // concurrency group would have turned into a visible operational failure long
  // before. Lowering it silently is what this assertion exists to stop.
  assertEqual(STRANDED_OPEN_VERDICT_MIN_IDLE_MS, 24 * 60 * 60 * 1000);
  assert(
    isStrandedOpenVerdict(
      strandedOpenStub(
        ["sentry:verdict-upstream"],
        new Date(
          SWEEP_NOW.getTime() - STRANDED_OPEN_VERDICT_MIN_IDLE_MS,
        ).toISOString(),
      ),
      at,
    ),
    "a stub idle for exactly the threshold is stranded",
  );
});

await test("strandedShapeOf names both shapes and nothing else", () => {
  const at = { now: SWEEP_NOW };
  assertEqual(
    strandedShapeOf(
      { state: "CLOSED", labels: ["sentry-triage", NEEDS_TRIAGE_LABEL] },
      at,
    ),
    STRAND_SHAPE_CLOSED_NEEDS_TRIAGE,
  );
  assertEqual(
    strandedShapeOf(strandedOpenStub(["sentry:verdict-upstream"]), at),
    STRAND_SHAPE_OPEN_VERDICT,
  );
  assertEqual(
    strandedShapeOf(
      { state: "OPEN", labels: ["sentry-triage", NEEDS_TRIAGE_LABEL] },
      at,
    ),
    null,
  );
});

await test("ingest recovers a stub a failed compensation left open and unqueued", async () => {
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-code-fix", PROJECTED_LABEL])],
  });

  // Invisible to Stage B: open, but without the label its selector requires.
  assertDeepEqual(fake.selectable(), []);

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, { now: () => SWEEP_NOW }),
  );

  assertEqual(counts.recoveredOpenVerdict, 1);
  // Counted apart from the closed pairing: the two diagnose different failures.
  assertEqual(counts.recovered, 0);
  assertEqual(counts.errors, 0);
  const issue = fake.get(42);
  assertEqual(issue.state, "OPEN");
  assertDeepEqual(issue.labels, ["sentry-triage", NEEDS_TRIAGE_LABEL]);
  assertDeepEqual(issue.comments, [
    buildStrandedRecoveryComment(STRAND_SHAPE_OPEN_VERDICT),
  ]);
  assertDeepEqual(fake.selectable(), [42]);
  // Through the chokepoint, in its order: revalidate, restore the queue label,
  // shed the previous round's markers, note, and VERIFY the end state. No
  // reopen — the stub was already open, and the verifier reopens only a closed
  // one.
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view", "edit", "edit", "comment", "view"],
  );
  assertDeepEqual(fake.calls[1], buildRequeueAddLabelArgs(42, REPO));
  assertDeepEqual(fake.calls[2], buildRequeueShedLabelArgs(42, REPO));
  // Fence-free, like every bookkeeping recovery: nothing in Sentry moved, so a
  // verdict already posted for this stub stays admissible.
  assert(
    !issue.comments.some((body) =>
      body.startsWith("Regressed in Sentry (last seen "),
    ),
    "a bookkeeping recovery must not post the staleness fence",
  );
});

await test("the open-verdict recovery terminates: a second ingest run is a no-op", async () => {
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"])],
  });
  const deps = () => ingestDeps(fake, { now: () => SWEEP_NOW });

  const first = await runIngest({ repo: REPO, trackerIssue: 1282 }, deps());
  const second = await runIngest({ repo: REPO, trackerIssue: 1282 }, deps());

  assertEqual(first.recoveredOpenVerdict, 1);
  // The shed removed the verdict label, so the shape is gone and the sweep
  // cannot cycle a stub it already fixed.
  assertEqual(second.recoveredOpenVerdict, 0);
  assertEqual(second.recovered, 0);
  assertEqual(fake.get(42).comments.length, 1);
});

await test("the sweep leaves a stub still mid-flight between its verdict and its close", async () => {
  // The shape is real here — it is what a live triage round looks like between
  // the label swap and the close. Only idleness tells the two apart.
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"], JUST_TOUCHED)],
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, { now: () => SWEEP_NOW }),
  );

  assertEqual(counts.recoveredOpenVerdict, 0);
  assertEqual(counts.errors, 0);
  // Not even a read: the snapshot alone settles it.
  assertDeepEqual(fake.calls, []);
});

for (const resting of [
  {
    name: "a needs-human stub waiting on its human",
    labels: [NEEDS_HUMAN_VERDICT_LABEL],
  },
  {
    name: "a stub the archive workflow holds a live approval for",
    labels: ["sentry:verdict-upstream", APPROVED_ARCHIVE_LABEL],
  },
  {
    name: "a stub whose Sentry issue is already archived",
    labels: ["sentry:verdict-upstream", ARCHIVED_LABEL],
  },
]) {
  await test(`the open-verdict sweep does not touch ${resting.name}`, async () => {
    const fake = makeFakeGitHub({ issues: [strandedOpenStub(resting.labels)] });

    const counts = await runIngest(
      { repo: REPO, trackerIssue: 1282 },
      ingestDeps(fake, { now: () => SWEEP_NOW }),
    );

    assertEqual(counts.recoveredOpenVerdict, 0);
    assertEqual(counts.errors, 0);
    assertDeepEqual(fake.calls, []);
    assertDeepEqual(fake.get(42).labels, ["sentry-triage", ...resting.labels]);
  });
}

await test("the open-verdict sweep revalidates: a compensation that landed first wins", async () => {
  // The snapshot is taken before the whole Sentry loop, so the compensation this
  // arm exists to finish can complete in between. The live read must decide.
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"])],
  });
  const staleSnapshot = fake.snapshot();
  fake.get(42).labels = ["sentry-triage", NEEDS_TRIAGE_LABEL];

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      listQueueIssues: async () => staleSnapshot,
      now: () => SWEEP_NOW,
    }),
  );

  assertEqual(counts.recoveredOpenVerdict, 0);
  assertEqual(counts.errors, 0);
  assertDeepEqual(fake.get(42).comments, []);
  // Read, then nothing: no write was attempted at all.
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view"],
  );
});

await test("a comment posted since the snapshot withdraws the stub from the sweep", async () => {
  // Idleness is part of the premise, so it is REVALIDATED like the rest of it.
  // A bare comment moves no label and no state, yet it is proof something is
  // still working on the stub.
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"])],
  });
  const staleSnapshot = fake.snapshot();
  fake.get(42).updatedAt = JUST_TOUCHED;

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      listQueueIssues: async () => staleSnapshot,
      now: () => SWEEP_NOW,
    }),
  );

  assertEqual(counts.recoveredOpenVerdict, 0);
  assertEqual(counts.errors, 0);
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view"],
  );
});

// Withdrawal by removing `sentry-triage` itself. Stage B's selector wants that
// label AND `sentry:needs-triage`, so re-queuing a stub that lost the first one
// sheds its verdict and STILL leaves it unselectable — strictly destructive.
// Both arms revalidate membership, and for the open shape it is the ONLY
// withdrawal gesture available, since that shape has no `sentry:needs-triage`
// left to remove.
for (const withdrawn of [
  {
    name: "closed-and-needing-triage",
    stub: {
      number: 42,
      title: buildQueueTitle("X-42", "web", "error"),
      state: "CLOSED",
      labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
    },
    survives: NEEDS_TRIAGE_LABEL,
  },
  {
    name: "open-and-verdict-labeled",
    stub: strandedOpenStub(["sentry:verdict-upstream"]),
    survives: "sentry:verdict-upstream",
  },
]) {
  await test(`a stub withdrawn from the queue is not re-enrolled (${withdrawn.name})`, async () => {
    const fake = makeFakeGitHub({ issues: [withdrawn.stub] });
    const staleSnapshot = fake.snapshot();
    // The withdrawal lands after the snapshot, before the sweep reaches it.
    fake.get(42).labels = fake
      .get(42)
      .labels.filter((name) => name !== "sentry-triage");

    const counts = await runIngest(
      { repo: REPO, trackerIssue: 1282 },
      ingestDeps(fake, {
        listQueueIssues: async () => staleSnapshot,
        now: () => SWEEP_NOW,
      }),
    );

    assertEqual(counts.recovered, 0);
    assertEqual(counts.recoveredOpenVerdict, 0);
    assertEqual(counts.errors, 0);
    // Read, then nothing — declining costs one request and no write.
    assertDeepEqual(
      fake.calls.map((args) => args[1]),
      ["view"],
    );
    const issue = fake.get(42);
    assert(
      issue.labels.includes(withdrawn.survives),
      `the withdrawn stub must keep ${withdrawn.survives}: ${JSON.stringify(issue.labels)}`,
    );
    assert(
      !issue.labels.includes("sentry-triage"),
      "nothing may put the queue label back",
    );
    assertDeepEqual(issue.comments, []);
  });
}

await test("a withdrawal landing mid-write fails the run loudly, never reports success", async () => {
  // The revalidating read cannot close this window: the operator removes
  // `sentry-triage` AFTER the sweep decided and BEFORE the label writes land. By
  // then the verdict is already shed, and nothing may undo that — a compensating
  // re-add would reintroduce the two-writers race the withdrawal just settled.
  // What must not happen is the run reporting success, which is what it did
  // while the end-state test omitted queue membership (#1817).
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"])],
  });
  let views = 0;
  const runGh = async (args, opts = {}) => {
    const out = await fake.runGh(args, opts);
    // The withdrawal lands the instant the revalidating read returns.
    if (args[1] === "view" && ++views === 1) {
      fake.get(42).labels = fake
        .get(42)
        .labels.filter((name) => name !== "sentry-triage");
    }
    return out;
  };

  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  let counts;
  try {
    counts = await runIngest(
      { repo: REPO, trackerIssue: 1282 },
      ingestDeps(fake, {
        now: () => SWEEP_NOW,
        recoverStranded: (options, issue, sweep) =>
          recoverStrandedQueueIssue(options, issue, { ...sweep, runGh }),
      }),
    );
  } finally {
    process.stderr.write = write;
  }

  // The decisive assertion: NOT counted as a recovery, and the run goes red.
  assertEqual(counts.recoveredOpenVerdict, 0);
  assertEqual(counts.errors, 1);
  // The stub is left as the withdrawal found it — nothing re-adds the queue
  // label, because removing it is how a stub is retired.
  const issue = fake.get(42);
  assert(
    !issue.labels.includes("sentry-triage"),
    `the withdrawal must stand: ${JSON.stringify(issue.labels)}`,
  );
  // And the operator gets the right story, not the generic stranded one.
  const errorLine = stderr.find((line) => line.includes("::error::"));
  assert(errorLine, "a run that shed a verdict for nothing must be loud");
  assert(
    errorLine.includes("sentry-triage"),
    `the failure must name the label that vanished: ${errorLine}`,
  );
  assert(
    !/It is STRANDED/.test(errorLine),
    `a withdrawn stub is retired, not stranded: ${errorLine}`,
  );
});

await test("an open-verdict recovery whose shed fails is loud, not silently selectable", async () => {
  // The OPEN shape has no cover the closed one has: restoring the queue label
  // makes the stub selectable IMMEDIATELY, so a shed that never lands would hand
  // the next triage round a stub still wearing the previous round's markers.
  // `verify-end-state` re-attempts the shed against observed state and then
  // throws naming what survived — the run goes red rather than green over it.
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream", PROJECTED_LABEL])],
    rejectOn: (args) => args.includes("--remove-label"),
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, { now: () => SWEEP_NOW }),
  );

  assertEqual(counts.recoveredOpenVerdict, 0);
  assertEqual(counts.errors, 1);
  const issue = fake.get(42);
  // Selectable again — the invariant this path owes — and the stale markers it
  // could not shed are what the run is red about.
  assert(issue.labels.includes(NEEDS_TRIAGE_LABEL));
  assert(issue.labels.includes(PROJECTED_LABEL));
  // The shed was attempted twice: once in the sequence, once against the
  // verification read.
  assertEqual(
    fake.calls.filter((args) => args.includes("--remove-label")).length,
    2,
  );
});

await test("--dry-run reports the repair without asserting writes it never made", async () => {
  // The end-state verification reads the stub back to prove the writes landed.
  // Under --dry-run none of them do, so that assertion would fail a run that
  // deliberately changed nothing. Modelled with the real runGh contract: a
  // mutating call under dryRun resolves without touching the fake.
  const fake = makeFakeGitHub({
    issues: [strandedOpenStub(["sentry:verdict-upstream"])],
  });
  const runGh = (args, opts = {}) =>
    opts.dryRun && opts.mutates ? Promise.resolve("") : fake.runGh(args);

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282, dryRun: true },
    ingestDeps(fake, {
      now: () => SWEEP_NOW,
      recoverStranded: (options, issue, sweep) =>
        recoverStrandedQueueIssue(options, issue, { ...sweep, runGh }),
    }),
  );

  assertEqual(counts.recoveredOpenVerdict, 1);
  assertEqual(counts.errors, 0);
  // Nothing was written, and the only real call was the revalidating read.
  const issue = fake.get(42);
  assertDeepEqual(issue.labels, ["sentry-triage", "sentry:verdict-upstream"]);
  assertDeepEqual(issue.comments, []);
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view"],
  );
});

await test("the run record counts the two strands apart", () => {
  const body = buildRunRecordBody(
    {
      fetched: 1,
      created: 0,
      skippedExisting: 0,
      reopened: 0,
      recovered: 2,
      recoveredOpenVerdict: 3,
      errors: 0,
    },
    "2026-07-21T05:30:00.000Z",
  );
  assert(body.includes("Recovered (stranded needs-triage): 2"));
  assert(body.includes("Recovered (stranded open verdict): 3"));
});

// ---------------------------------------------------------------------------
// A FAILED Sentry-evidence reopen must not be laundered into a bookkeeping
// recovery (issue #1706, third follow-up).
//
// A stub can be eligible for both paths at once: closed, already wearing
// `sentry:needs-triage` from an earlier bookkeeping compensation, and now
// regressed. The regression path claims it and fences; the sweep does not
// fence, by design. If the reopen throws and the run records only SUCCESSES,
// the sweep inherits that stub inside the same run and re-queues it fence-free
// — so the pre-regression verdict stays admissible over a live regression.
// ---------------------------------------------------------------------------

const BOTH_ELIGIBLE_REGRESSION = mapSentryIssue({
  id: 9,
  shortId: "X-9",
  lastSeen: "2026-07-20T00:00:00Z",
});

const BOTH_ELIGIBLE_STUB = {
  number: 200,
  title: buildQueueTitle("X-9", "web", "error"),
  state: "CLOSED",
  closedAt: "2026-07-19T00:00:00Z",
  // The bookkeeping compensation's leftovers — which is what makes this stub
  // look stranded to the sweep.
  labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
};

await test("a regression reopen that fails is not swept as bookkeeping in the same run", async () => {
  const fake = makeFakeGitHub({
    issues: [{ ...BOTH_ELIGIBLE_STUB }],
    // The fence post itself fails — the first write the regression path makes.
    rejectOn: (args) => args[1] === "comment",
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      fetchMergedSentryIssues: async () =>
        mergeSentryIssues([], [BOTH_ELIGIBLE_REGRESSION]),
      reopenIssue: (options, issue, sentryIssue) =>
        reopenQueueIssue(options, issue, sentryIssue, { runGh: fake.runGh }),
    }),
  );

  // The reopen failed and is counted as an error...
  assertEqual(counts.reopened, 0);
  assertEqual(counts.errors, 1);
  // ...and the decisive assertion: the sweep did NOT pick the stub up.
  assertEqual(counts.recovered, 0);
  const issue = fake.get(200);
  assertEqual(issue.state, "CLOSED");
  assertDeepEqual(issue.comments, []);
  assert(
    !issue.comments.includes(buildStrandedRecoveryComment()),
    "the bookkeeping recovery note must never land on a failed regression reopen",
  );
});

await test("the next run reopens that stub through the regression path, with its fence", async () => {
  const fake = makeFakeGitHub({ issues: [{ ...BOTH_ELIGIBLE_STUB }] });
  const deps = ingestDeps(fake, {
    fetchMergedSentryIssues: async () =>
      mergeSentryIssues([], [BOTH_ELIGIBLE_REGRESSION]),
    reopenIssue: (options, issue, sentryIssue) =>
      reopenQueueIssue(options, issue, sentryIssue, { runGh: fake.runGh }),
  });

  const counts = await runIngest({ repo: REPO, trackerIssue: 1282 }, deps);

  assertEqual(counts.reopened, 1);
  assertEqual(counts.recovered, 0);
  const issue = fake.get(200);
  assertEqual(issue.state, "OPEN");
  assertDeepEqual(issue.comments, [
    buildRegressedComment("2026-07-20T00:00:00Z"),
  ]);
});

// ---------------------------------------------------------------------------
// The sweep revalidates before it mutates (issue #1706, fourth follow-up).
//
// listQueueIssues() snapshots the whole queue before the Sentry loop runs, and
// ingest holds its own concurrency group, so minutes can pass before the sweep
// reaches a given stub. Anything decided from that snapshot is a decision about
// the past.
// ---------------------------------------------------------------------------

await test("the sweep does not reverse a human who declined the stub", async () => {
  // Removing sentry:needs-triage is the DOCUMENTED way to decline a stub, so
  // re-adding it off a stale snapshot reverses the exact action the runbook
  // prescribes.
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
  const staleSnapshot = fake.snapshot();
  // The human declines it after the snapshot, before the sweep gets there.
  fake.get(42).labels = ["sentry-triage"];

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, { listQueueIssues: async () => staleSnapshot }),
  );

  assertEqual(counts.recovered, 0);
  assertEqual(counts.errors, 0);
  const issue = fake.get(42);
  assertEqual(issue.state, "CLOSED");
  assertDeepEqual(issue.labels, ["sentry-triage"]);
  assertDeepEqual(issue.comments, []);
  // Read, then nothing: no write was attempted at all.
  assertDeepEqual(
    fake.calls.map((args) => args[1]),
    ["view"],
  );
});

await test("the sweep leaves a stub something else already reopened", async () => {
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
  const staleSnapshot = fake.snapshot();
  fake.get(42).state = "OPEN";

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, { listQueueIssues: async () => staleSnapshot }),
  );

  assertEqual(counts.recovered, 0);
  assertDeepEqual(fake.get(42).comments, []);
});

await test("a failed revalidation leaves the stub stranded rather than recovering blind", async () => {
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
      },
    ],
    rejectOn: (args) => args[1] === "view",
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );

  assertEqual(counts.recovered, 0);
  assertEqual(counts.errors, 1);
  assertEqual(fake.get(42).state, "CLOSED");
  assertDeepEqual(fake.get(42).comments, []);
});

await test("a failure while DECIDING also withholds the stub from the sweep", async () => {
  // One step earlier than the reopen: if the decision itself throws we cannot
  // say the cause was bookkeeping, so the sweep must not assume it. Modelled by
  // a body the decision phase cannot read.
  const fake = makeFakeGitHub({ issues: [{ ...BOTH_ELIGIBLE_STUB }] });
  const poisoned = fake.snapshot();
  Object.defineProperty(poisoned[0], "body", {
    get() {
      throw new Error("body unreadable");
    },
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake, {
      listQueueIssues: async () => poisoned,
      fetchMergedSentryIssues: async () =>
        mergeSentryIssues([], [BOTH_ELIGIBLE_REGRESSION]),
    }),
  );

  assertEqual(counts.errors, 1);
  assertEqual(counts.recovered, 0);
  assertEqual(fake.get(200).state, "CLOSED");
  assertDeepEqual(fake.get(200).comments, []);
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

await test("a half-applied label edit leaves a stub some later run recovers (#1693)", async () => {
  // The label write is TWO concurrent GraphQL mutations. When the remove lands
  // and the add does not, the pre-#1693 single edit left a CLOSED stub with
  // `sentry:archived` shed and `sentry:needs-triage` never applied — a state
  // `decideDedupAction`'s baseline branch cannot see (it gates on
  // `sentry:archived`) and the stranded sweep cannot see either (it gates on
  // `sentry:needs-triage`). Nothing frees it but a human.
  let halfFailureArmed = true;
  const fake = makeFakeGitHub({
    issues: [
      {
        ...REGRESSED_STUB,
        labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
      },
    ],
    // One transient half-failure, on the first call that carries a remove; the
    // recovery run below then meets a healthy GitHub, which is what makes this
    // a test about the state left behind rather than about a permanent outage.
    dropAddLabelsOn: (args) => {
      if (!halfFailureArmed || !args.includes("--remove-label")) return false;
      halfFailureArmed = false;
      return true;
    },
  });

  let threw = false;
  try {
    await reopenQueueIssue({ repo: REPO }, { number: 200 }, REGRESSED_SENTRY, {
      runGh: fake.runGh,
    });
  } catch {
    threw = true;
  }
  assert(threw, "the interrupted label write must surface as a rejection");

  // The invariant: the stub still wears a marker SOME recovery path reads.
  const stranded = fake.get(200);
  assert(
    stranded.labels.includes(NEEDS_TRIAGE_LABEL) ||
      stranded.labels.includes("sentry:archived"),
    `no recovery path can see this stub: labels=${JSON.stringify(stranded.labels)}`,
  );

  // And the next scheduled run actually frees it.
  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );
  assertEqual(counts.errors, 0);
  assertEqual(counts.recovered, 1);
  assertDeepEqual(fake.selectable(), [200]);
});

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

for (const [label, lastSeen] of [
  ["missing", null],
  ["unparsable", "not-a-timestamp"],
]) {
  await test(`a ${label} lastSeen posts a fresh fence on every round, never dedups`, async () => {
    // decideDedupAction deliberately fails open on an unusable timestamp and
    // reopens on EVERY closed observation, while buildRegressedComment renders
    // the same constant body each time. Identical bodies then say nothing about
    // which occurrence they belong to, so deduping on one would let round one's
    // fence suppress round two's — leaving round one's VERDICT, posted after
    // that fence, newest-admissible over a fresh occurrence.
    const sentryIssue = mapSentryIssue({ id: 9, shortId: "X-9", lastSeen });
    const fake = makeFakeGitHub({
      issues: [
        {
          number: 200,
          title: buildQueueTitle("X-9", "web", "error"),
          state: "CLOSED",
          closedAt: "2026-07-19T00:00:00Z",
          labels: ["sentry-triage", "sentry:verdict-upstream"],
        },
      ],
    });

    // Round one.
    await reopenQueueIssue({ repo: REPO }, { number: 200 }, sentryIssue, {
      runGh: fake.runGh,
    });
    // Triage runs, posts a verdict, and closes the stub again.
    fake.get(200).comments.push("<!-- sentry-triage-verdict:v1 -->\nupstream");
    fake.get(200).state = "CLOSED";

    // Round two, same unusable timestamp and therefore the same fence body.
    await reopenQueueIssue({ repo: REPO }, { number: 200 }, sentryIssue, {
      runGh: fake.runGh,
    });

    const fences = fake
      .get(200)
      .comments.filter((body) =>
        body.startsWith("Regressed in Sentry (last seen "),
      );
    assertEqual(fences.length, 2);
    // The decisive property: a fence exists AFTER the verdict, so the parser
    // stales that verdict out instead of accepting it over the new occurrence.
    const comments = fake.get(200).comments;
    assert(
      comments.lastIndexOf(fences[1]) >
        comments.findIndex((b) => b.startsWith("<!-- sentry-triage-verdict")),
      "round two's fence must land after round one's verdict",
    );
  });
}

await test("an untrusted pre-posted fence cannot suppress the bot's own", async () => {
  // This repo is PUBLIC. Without an author fence, anyone who guesses the
  // regression's exact lastSeen can post the matching body and have the dedup
  // check swallow the real fence — while selectVerdictComment ignores their
  // comment, because it DOES check authorship. The stub would then be re-queued
  // with the pre-regression verdict still admissible.
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 200,
        title: buildQueueTitle("X-9", "web", "error"),
        state: "CLOSED",
        closedAt: "2026-07-19T00:00:00Z",
        labels: ["sentry-triage", "sentry:verdict-upstream"],
        untrustedComments: [buildRegressedComment("2026-07-20T00:00:00Z")],
      },
    ],
  });

  await reopenQueueIssue({ repo: REPO }, { number: 200 }, REGRESSED_SENTRY, {
    runGh: fake.runGh,
  });

  assertDeepEqual(fake.get(200).comments, [
    buildRegressedComment("2026-07-20T00:00:00Z"),
  ]);
  assertEqual(fake.get(200).state, "OPEN");
});

await test("the bot's own identical fence is still deduped", async () => {
  // The guard must stay useful: an author-trusted copy of the same fence is a
  // genuine retry of the same occurrence and must not be re-posted.
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 200,
        title: buildQueueTitle("X-9", "web", "error"),
        state: "CLOSED",
        closedAt: "2026-07-19T00:00:00Z",
        labels: ["sentry-triage", "sentry:verdict-upstream"],
        comments: [buildRegressedComment("2026-07-20T00:00:00Z")],
      },
    ],
  });

  await reopenQueueIssue({ repo: REPO }, { number: 200 }, REGRESSED_SENTRY, {
    runGh: fake.runGh,
  });

  assertDeepEqual(fake.get(200).comments, [
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

// ---------------------------------------------------------------------------
// The sweep's blind spot, and what stops it laundering a regression (#1717).
//
// The sweep re-queues with cause `bookkeeping` and posts no staleness fence.
// That stays correct and is deliberately unchanged here: it reads GitHub only,
// and fencing every recovery would discard a good verdict on each genuine
// bookkeeping strand — over-fencing, which is as wrong as under-fencing and
// quieter. What no GitHub read can see is a Sentry occurrence that landed after
// this run's `fetchMergedSentryIssues()` returned. The previous round's verdict
// then stays ADMISSIBLE on a stub that is back in the queue, and the `verdict`
// job runs `if: always()` — so a triage round that dies before posting used to
// end with that verdict labeled and the stub closed, its `closed_at` past the
// occurrence's `last_seen`, which makes ingest's own dedup gate skip it.
//
// The fix binds the settlement to the round instead of trying to infer the
// cause. Both tests below drive the REAL sweep, then the REAL select-side
// recorder, then the REAL resolver the verdict job runs.
// ---------------------------------------------------------------------------

/** One trusted verdict comment body, minimal but contract-shaped. */
function verdictCommentBody(verdict) {
  return [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict}`,
    "confidence: medium",
    "affected_repo: mento-protocol/monitoring-monorepo",
    "summary: a redacted one-liner",
    "root_cause: |",
    "  a redacted cause",
    "proposed_action: |",
    "  a redacted action",
    "duplicate_of: []",
    "```",
  ].join("\n");
}

/** Dress the fake's comment BODIES as `gh issue view --json comments` returns
 * them: trusted author, ascending createdAt, and the `#issuecomment-<id>` url
 * the round binding reads its token from. */
function asViewedComments(bodies, firstId = 9000) {
  return bodies.map((body, index) => ({
    body,
    author: { login: "github-actions" },
    createdAt: `2026-07-2${index}T00:00:00Z`,
    url: `https://github.com/${REPO}/issues/42#issuecomment-${firstId + index}`,
  }));
}

/** The two GitHub-facing helpers the triage workflow runs around a round, wired
 * to one fixed comment list: what `select` records before the agent, and what
 * the `verdict` job resolves after it. */
function triageRoundHelpers(comments) {
  const runGh = async () =>
    JSON.stringify({
      number: 42,
      title: buildQueueTitle("X-42", "web", "error"),
      body: "",
      url: `https://github.com/${REPO}/issues/42`,
      state: "OPEN",
      labels: [{ name: "sentry-triage" }, { name: NEEDS_TRIAGE_LABEL }],
      comments,
    });
  return {
    recordPriorVerdicts: () =>
      runPriorVerdicts({ localRepo: REPO, queueIssues: [42] }, { runGh }),
    settle: (priorVerdictCommentId) =>
      runParseOnly(
        { localRepo: REPO, queueIssue: 42, priorVerdictCommentId },
        { runGh },
      ),
  };
}

async function assertRefuses(promise, pattern) {
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
  throw new Error("expected the resolution to refuse");
}

await test("a regression landing after the Sentry query is not laundered by the sweep (#1717)", async () => {
  const verdict = verdictCommentBody("upstream-transient");
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
        comments: [verdict],
      },
    ],
  });

  // `ingestDeps` sees no Sentry results at all — which IS this scenario: the
  // query returned before the occurrence arrived, so the regression branch
  // never claims this stub and the sweep is what reaches it.
  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );
  assertEqual(counts.recovered, 1);
  assertDeepEqual(fake.selectable(), [42]);

  // The re-queue is fence-free — the precondition for the laundering, and the
  // behaviour this fix deliberately leaves alone.
  const bodies = fake.get(42).comments;
  assertDeepEqual(bodies, [verdict, buildStrandedRecoveryComment()]);
  const comments = asViewedComments(bodies);
  assertEqual(
    selectVerdictComment(comments).body,
    verdict,
    "the pre-regression verdict must still be admissible, or this test proves nothing",
  );

  // Select records what the stub arrived with. The round then dies before
  // posting, so nothing is appended.
  const { recordPriorVerdicts, settle } = triageRoundHelpers(comments);
  const prior = await recordPriorVerdicts();
  assertDeepEqual(prior, { 42: "9000" });

  await assertRefuses(
    settle(prior["42"]),
    /round did not produce.*already on the stub before this triage round/s,
  );
  // Nothing was written: the stub keeps sentry:needs-triage for the next run,
  // which is what lets a later occurrence re-fence it properly.
  assertDeepEqual(fake.selectable(), [42]);
});

await test("an archive refusal whose fence was deleted is not laundered either (#1717)", async () => {
  // The surviving archive-side route (R2): the live-regression refusal
  // re-queued through the chokepoint, someone with write access deleted the
  // fence comment it posted, and the reopen then failed both attempts —
  // leaving CLOSED + needs-triage + no fence, with only the archive's audit
  // comment to show the leg ran. That run was already RED; the laundering is
  // what a LATER ingest run would otherwise do to it.
  const verdict = verdictCommentBody("code-fix");
  const audit = `${ARCHIVE_COMMENT_MARKER}\nArchive refused: the Sentry issue is actively regressing.`;
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
        comments: [verdict, audit],
      },
    ],
  });

  const counts = await runIngest(
    { repo: REPO, trackerIssue: 1282 },
    ingestDeps(fake),
  );
  assertEqual(counts.recovered, 1);

  const bodies = fake.get(42).comments;
  assert(
    !bodies.some((body) => body.startsWith(REGRESSION_PREFIX)),
    "the deleted fence is not restored by the bookkeeping sweep",
  );
  const comments = asViewedComments(bodies);
  assertEqual(
    selectVerdictComment(comments).body,
    verdict,
    "the archive audit comment is not a fence, so the verdict stays admissible",
  );

  const { recordPriorVerdicts, settle } = triageRoundHelpers(comments);
  const prior = await recordPriorVerdicts();
  await assertRefuses(
    settle(prior["42"]),
    /round did not produce.*already on the stub before this triage round/s,
  );
  assertDeepEqual(fake.selectable(), [42]);
});

await test("a round that DOES post a verdict still settles the swept stub (#1717)", async () => {
  // The binding must not become a blanket refusal on every swept stub: a
  // recovery whose next round works normally settles exactly as before.
  const fake = makeFakeGitHub({
    issues: [
      {
        number: 42,
        title: buildQueueTitle("X-42", "web", "error"),
        state: "CLOSED",
        labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
        comments: [verdictCommentBody("upstream-transient")],
      },
    ],
  });
  await runIngest({ repo: REPO, trackerIssue: 1282 }, ingestDeps(fake));

  const before = asViewedComments(fake.get(42).comments);
  const prior = await triageRoundHelpers(before).recordPriorVerdicts();
  // The round posts its own verdict, which lands after everything select saw.
  const after = asViewedComments([
    ...fake.get(42).comments,
    verdictCommentBody("needs-human").replace(
      "duplicate_of: []",
      [
        "duplicate_of: []",
        "human_question: |",
        "  Decide whether to roll back or wait for upstream.",
        "how_to_check:",
        "  - inspect the deploy log",
        "decision_branches:",
        "  - Yes -> roll back",
        "  - No -> wait",
      ].join("\n"),
    ),
  ]);
  const result = await triageRoundHelpers(after).settle(prior["42"]);
  assertEqual(result.verdict, "needs-human");
  assertEqual(result.label, "sentry:verdict-needs-human");
});

// #1765. The archive leg only ever sets `archived_until_escalating`, and Sentry
// surfaces that as substatus `escalating` — a DISTINCT filter from
// `is:regressed`. With only the two original queries an escalated archived
// issue entered no fetch set at all, so the reopen machinery built by #1371,
// #1692 and #1693 was unreachable for exactly the issues the archive produces.
// These drive the real fetch, not a hand-built merge, because the gap was in
// the query SET and nothing that stubbed the merge could ever have seen it.
function sentryFetchStub(byQuery) {
  const seen = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get("query");
    seen.push(query);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => byQuery[query] ?? [],
      headers: { get: () => null },
    };
  };
  return { fetchImpl, seen };
}

await test("ingest fetches escalating issues, not only regressed ones", async () => {
  const { fetchImpl, seen } = sentryFetchStub({});
  await defaultFetchMergedSentryIssues({
    org: "mento-labs",
    sentryBaseUrl: "https://us.sentry.io",
    sentryToken: "t",
    lookbackDays: 8,
    fetchImpl,
  });
  assert(
    seen.includes(ESCALATING_ISSUES_QUERY),
    `expected an ${ESCALATING_ISSUES_QUERY} query; saw ${JSON.stringify(seen)}`,
  );
  // The other two must survive: escalating is an ADDITION, not a replacement.
  assert(seen.includes(REGRESSED_ISSUES_QUERY), "regressed query must remain");
  assert(
    seen.some((q) => q.startsWith("is:unresolved firstSeen:")),
    "firstSeen query must remain",
  );
});

await test("an escalated archived issue reaches a reopen decision", async () => {
  // Fetch-to-decision, the path #1765 says nothing covers: the issue is
  // returned ONLY by the escalating query, exactly as Sentry would.
  const escalated = {
    id: "900",
    shortId: "GOV-900",
    title: "boom",
    project: { slug: "governance-mento-org" },
    lastSeen: "2026-08-12T10:00:00Z",
  };
  const { fetchImpl } = sentryFetchStub({
    [ESCALATING_ISSUES_QUERY]: [escalated],
  });
  const merged = await defaultFetchMergedSentryIssues({
    org: "mento-labs",
    sentryBaseUrl: "https://us.sentry.io",
    sentryToken: "t",
    lookbackDays: 8,
    fetchImpl,
  });

  const entry = merged.get("900");
  assert(entry, "the escalated issue must be in the merged set at all");
  assertEqual(entry.isRegressed, true);
  // Asserted through the PRODUCTION fetch path, not a hand-built merge. An
  // earlier revision wired the cause only into the direct-reopen tests, so the
  // fetch path silently kept collapsing both sets and nothing failed.
  assertEqual(entry.reopenCause, ESCALATING_REOPEN_CAUSE);

  // And it must survive the archive freshness gate: events after the recorded
  // baseline are what the reopen exists for.
  const decision = decideDedupAction({
    existingIssue: {
      state: "CLOSED",
      closedAt: "2026-08-10T12:00:00Z",
      labels: [ARCHIVED_LABEL],
    },
    isRegressed: entry.isRegressed,
    lastSeen: entry.lastSeen,
    archiveBaseline: "2026-08-10T11:00:00Z",
    archiveBaselineIssueId: "900",
    sentryIssueId: "900",
  });
  assertEqual(decision.action, "reopen");
});

await test("an escalation-only reopen is not audited as a regression", async () => {
  // #1765 follow-through: the summary counter was fixed first, but the
  // PER-ISSUE comment is what a person reads on the stub. The fence LINE stays
  // exactly as it is — it is the machine-read contract — so the provenance has
  // to arrive as prose beneath it.
  const posted = [];
  const runGh = async (args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push(args[args.indexOf("--body") + 1]);
    }
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify([]);
    return "";
  };
  await reopenQueueIssue(
    { repo: "o/r", dryRun: false },
    { number: 42 },
    {
      lastSeen: "2026-08-12T10:00:00Z",
      reopenCause: ESCALATING_REOPEN_CAUSE,
    },
    { runGh, claim: () => {} },
  );
  const fence = posted.find((b) => b.includes("Regressed in Sentry"));
  assert(fence, "the machine-read fence line must still be posted verbatim");
  assert(
    fence.includes("escalating, not regressed"),
    "an escalation must say so beneath the fence, not read as a regression",
  );
});

await test("a regressed reopen carries no escalation prose", async () => {
  const posted = [];
  const runGh = async (args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push(args[args.indexOf("--body") + 1]);
    }
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify([]);
    return "";
  };
  await reopenQueueIssue(
    { repo: "o/r", dryRun: false },
    { number: 43 },
    { lastSeen: "2026-08-12T10:00:00Z", reopenCause: REGRESSED_REOPEN_CAUSE },
    { runGh, claim: () => {} },
  );
  const fence = posted.find((b) => b.includes("Regressed in Sentry"));
  assert(fence, "expected the fence");
  assert(
    !fence.includes("escalating, not regressed"),
    "a genuine regression must not claim it was an escalation",
  );
});

await test("adding the escalating pass does not disable regression reopens", async () => {
  // The regression I shipped and did not catch: the escalating pass feeds pass
  // one's OUTPUT back in as `newIssues`, and the merge used to force
  // `isRegressed: false` for that argument. A regressed-only issue therefore
  // came out of the fetch with its flag wiped, `decideDedupAction` answered
  // "closed, not regressed", and every regression reopen silently stopped —
  // while all the escalation tests kept passing.
  const regressedOnly = {
    id: "700",
    shortId: "GOV-700",
    title: "boom",
    project: { slug: "governance-mento-org" },
    lastSeen: "2026-08-12T10:00:00Z",
  };
  const { fetchImpl } = sentryFetchStub({
    [REGRESSED_ISSUES_QUERY]: [regressedOnly],
  });
  const merged = await defaultFetchMergedSentryIssues({
    org: "mento-labs",
    sentryBaseUrl: "https://us.sentry.io",
    sentryToken: "t",
    lookbackDays: 8,
    fetchImpl,
  });

  const entry = merged.get("700");
  assert(entry, "the regressed issue must survive the escalating pass");
  assertEqual(entry.isRegressed, true);
  assertEqual(entry.reopenCause, REGRESSED_REOPEN_CAUSE);

  // And it must still reach the reopen it always did.
  const decision = decideDedupAction({
    existingIssue: {
      state: "CLOSED",
      closedAt: "2026-08-10T12:00:00Z",
      labels: [],
    },
    isRegressed: entry.isRegressed,
    lastSeen: entry.lastSeen,
  });
  assertEqual(decision.action, "reopen");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
