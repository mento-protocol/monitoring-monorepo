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

await test("REST issue normalization flattens pages, drops PRs, uppercases state, carries closed_at + labels + body", () => {
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
      body: "",
      labels: ["sentry-triage", "sentry:needs-triage"],
    },
    {
      number: 2,
      title: "[sentry] X-2: b",
      state: "CLOSED",
      closedAt: "2026-07-16T12:00:00Z",
      body: '```yaml\narchive_baseline_last_seen: "2026-07-16T11:00:00Z"\n```',
      labels: ["sentry-triage", "sentry:archived"],
    },
    {
      number: 4,
      title: "[sentry] X-4: c",
      state: "CLOSED",
      closedAt: null,
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
  assert(body.includes("Reopened (regressed): 1"), "missing reopened count");
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
      "duplicate_of: []\nhuman_question: |\n  Decide whether to roll back or wait for upstream.",
    ),
  ]);
  const result = await triageRoundHelpers(after).settle(prior["42"]);
  assertEqual(result.verdict, "needs-human");
  assertEqual(result.label, "sentry:verdict-needs-human");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
