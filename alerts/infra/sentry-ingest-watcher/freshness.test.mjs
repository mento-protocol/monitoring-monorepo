#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_RECORD_MARKER,
  freshnessSeconds,
  parseLatestRunRecord,
} from "./freshness.mjs";

const recordBody = (timestampIso) =>
  [
    RUN_RECORD_MARKER,
    "",
    `**Sentry triage ingest — last run:** ${timestampIso}`,
    "",
    "- Fetched: 21",
    "- Created: 1",
    "- Skipped (existing): 17",
    "- Reopened (regressed): 3",
    "- Errors: 0",
  ].join("\n");

const comment = ({
  timestampIso = "2026-07-29T15:26:11.381Z",
  login = "github-actions[bot]",
  body,
  ...rest
} = {}) => ({
  id: 4_994_763_784,
  user: { login, type: "Bot" },
  created_at: "2026-07-16T17:28:01Z",
  updated_at: "2026-07-29T15:26:12Z",
  body: body ?? recordBody(timestampIso),
  ...rest,
});

test("reads the run record's body timestamp", () => {
  const parsed = parseLatestRunRecord([
    { id: 1, user: { login: "chapati23" }, body: "unrelated chatter" },
    comment({ timestampIso: "2026-07-29T15:26:11.381Z" }),
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-29T15:26:11.381Z"),
  });
});

test("accepts the GraphQL author login shape too", () => {
  const parsed = parseLatestRunRecord([
    comment({ login: "github-actions", timestampIso: "2026-07-29T05:41:12Z" }),
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-29T05:41:12Z"),
  });
});

// Finding 1. `updated_at` moves on any mutation of the comment object, so a
// metadata edit long after the pipeline died would drive the gauge fresh.
// Only the body timestamp — written by the ingest after it finished the work —
// may decide freshness.
test("ignores comment metadata timestamps that postdate the body timestamp", () => {
  const parsed = parseLatestRunRecord([
    comment({
      timestampIso: "2026-07-20T05:41:12Z",
      created_at: "2026-07-30T09:00:00Z",
      updated_at: "2026-07-30T09:00:00Z",
    }),
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-20T05:41:12Z"),
  });

  // And the gauge that follows from it must read stale, not fresh.
  const nowMs = Date.parse("2026-07-30T09:00:00Z");
  assert.equal(
    freshnessSeconds(parsed.completedAtMs, nowMs) > 26 * 60 * 60,
    true,
  );
});

// Finding 2. `sentry-triage-ingest.yml` concludes `success` with the kill
// switch off or `SENTRY_TRIAGE_TOKEN` absent, but neither path reaches the run
// record. The record therefore still carries the last real ingest, and the
// gauge must keep ageing past the 26h threshold rather than report health for
// a pipeline producing nothing.
test("a successful but no-op ingest leaves the gauge ageing", () => {
  const lastRealIngest = "2026-07-27T05:41:12Z";
  const parsed = parseLatestRunRecord([
    comment({ timestampIso: lastRealIngest }),
  ]);
  assert.equal(parsed.ok, true);

  // Three days of green-but-no-op runs later.
  const nowMs = Date.parse("2026-07-30T09:00:00Z");
  const seconds = freshnessSeconds(parsed.completedAtMs, nowMs);

  assert.equal(seconds, 271_128);
  assert.equal(seconds > 26 * 60 * 60, true);
});

// A public repo means anyone can comment on #1282. A planted record carrying a
// fresh timestamp must not hold the gauge green.
test("ignores a marker-bearing record from an untrusted author", () => {
  const parsed = parseLatestRunRecord([
    comment({ login: "drive-by", timestampIso: "2026-07-30T08:59:00Z" }),
    comment({ timestampIso: "2026-07-20T05:41:12Z" }),
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-20T05:41:12Z"),
  });
});

test("ignores a planted record when it is the only candidate", () => {
  const parsed = parseLatestRunRecord([
    comment({ login: "drive-by", timestampIso: "2026-07-30T08:59:00Z" }),
  ]);

  assert.deepEqual(parsed, { ok: false, reason: "no_trusted_run_record" });
});

test("ignores comments with a missing or malformed author", () => {
  const parsed = parseLatestRunRecord([
    { ...comment(), user: undefined },
    { ...comment(), user: {} },
    { ...comment(), user: { login: 42 } },
  ]);

  assert.deepEqual(parsed, { ok: false, reason: "no_trusted_run_record" });
});

test("requires the marker at the start of the body", () => {
  const parsed = parseLatestRunRecord([
    comment({
      body: `quoting the pipeline:\n\n${recordBody("2026-07-30T08:59:00Z")}`,
    }),
  ]);

  assert.deepEqual(parsed, { ok: false, reason: "no_trusted_run_record" });
});

test("rejects a different run-record marker version", () => {
  const parsed = parseLatestRunRecord([
    comment({
      body: recordBody("2026-07-30T08:59:00Z").replace(
        "run-record:v1",
        "run-record:v2",
      ),
    }),
  ]);

  assert.deepEqual(parsed, { ok: false, reason: "no_trusted_run_record" });
});

test("takes the newest trusted record when several exist", () => {
  const parsed = parseLatestRunRecord([
    comment({ timestampIso: "2026-07-28T13:44:00Z" }),
    comment({ timestampIso: "2026-07-29T05:41:12Z" }),
    comment({ timestampIso: "2026-07-27T05:39:03Z" }),
  ]);

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-29T05:41:12Z"),
  });
});

// Every one of these must resolve toward "stale": the handler publishes no
// point, the series goes absent, and the absence condition alerts.
for (const [name, payload] of [
  ["null body", null],
  ["object body", { workflow_runs: [] }],
  ["string body", "not json"],
  ["number body", 42],
]) {
  test(`rejects a ${name} without inventing freshness`, () => {
    assert.deepEqual(parseLatestRunRecord(payload), {
      ok: false,
      reason: "response_not_an_array",
    });
  });
}

test("rejects an empty comment list", () => {
  assert.deepEqual(parseLatestRunRecord([]), {
    ok: false,
    reason: "no_trusted_run_record",
  });
});

test("reports a trusted record whose timestamp cannot be read", () => {
  const parsed = parseLatestRunRecord([
    comment({ body: `${RUN_RECORD_MARKER}\n\nlast run: some time last week` }),
    null,
    "surprise",
  ]);

  assert.deepEqual(parsed, {
    ok: false,
    reason: "run_record_timestamp_unreadable",
  });
});

test("computes whole seconds since the last successful ingest", () => {
  const completedAtMs = Date.parse("2026-07-29T05:41:12Z");
  const nowMs = Date.parse("2026-07-30T09:11:13Z");

  assert.equal(freshnessSeconds(completedAtMs, nowMs), 99_001);
});

test("floors freshness at zero when the ingest clock runs ahead", () => {
  const completedAtMs = Date.parse("2026-07-30T10:00:00Z");
  const nowMs = Date.parse("2026-07-30T09:59:00Z");

  assert.equal(freshnessSeconds(completedAtMs, nowMs), 0);
});

test("returns null instead of a bogus age for non-finite timestamps", () => {
  assert.equal(freshnessSeconds(Number.NaN, Date.now()), null);
  assert.equal(freshnessSeconds(Date.now(), Number.NaN), null);
  assert.equal(freshnessSeconds(Number.POSITIVE_INFINITY, Date.now()), null);
});
