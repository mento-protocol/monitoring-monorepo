#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { freshnessSeconds, parseLatestSuccessfulRun } from "./freshness.mjs";

const run = (overrides = {}) => ({
  conclusion: "success",
  status: "completed",
  updated_at: "2026-07-29T05:41:12Z",
  ...overrides,
});

test("parses the newest successful run regardless of array order", () => {
  const parsed = parseLatestSuccessfulRun({
    total_count: 3,
    workflow_runs: [
      run({ updated_at: "2026-07-28T13:44:00Z" }),
      run({ updated_at: "2026-07-29T05:41:12Z" }),
      run({ updated_at: "2026-07-27T05:39:03Z" }),
    ],
  });

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-29T05:41:12Z"),
  });
});

test("ignores runs that did not conclude successfully", () => {
  const parsed = parseLatestSuccessfulRun({
    workflow_runs: [
      run({ conclusion: "failure", updated_at: "2026-07-29T13:44:00Z" }),
      run({ conclusion: null, updated_at: "2026-07-29T12:00:00Z" }),
      run({ updated_at: "2026-07-28T05:41:12Z" }),
    ],
  });

  assert.deepEqual(parsed, {
    ok: true,
    completedAtMs: Date.parse("2026-07-28T05:41:12Z"),
  });
});

// Every one of these must resolve toward "stale": the handler publishes no
// point, the series goes absent, and the absence condition alerts. A `reason`
// that resolved to a fresh value here would disarm the dead-man switch.
for (const [name, payload] of [
  ["null body", null],
  ["array body", []],
  ["string body", "not json"],
  ["number body", 42],
]) {
  test(`rejects a ${name} without inventing freshness`, () => {
    assert.deepEqual(parseLatestSuccessfulRun(payload), {
      ok: false,
      reason: "response_not_an_object",
    });
  });
}

test("rejects a body without a workflow_runs array", () => {
  assert.deepEqual(parseLatestSuccessfulRun({ total_count: 0 }), {
    ok: false,
    reason: "workflow_runs_missing",
  });
  assert.deepEqual(parseLatestSuccessfulRun({ workflow_runs: {} }), {
    ok: false,
    reason: "workflow_runs_missing",
  });
});

test("rejects an empty run list", () => {
  assert.deepEqual(
    parseLatestSuccessfulRun({ total_count: 0, workflow_runs: [] }),
    { ok: false, reason: "no_successful_run" },
  );
});

test("rejects runs whose timestamps cannot be parsed", () => {
  const parsed = parseLatestSuccessfulRun({
    workflow_runs: [
      run({ updated_at: "not-a-date" }),
      run({ updated_at: 1_753_000_000_000 }),
      run({ updated_at: undefined }),
      null,
      "surprise",
    ],
  });

  assert.deepEqual(parsed, { ok: false, reason: "no_successful_run" });
});

test("computes whole seconds since the last successful run", () => {
  const completedAtMs = Date.parse("2026-07-29T05:41:12Z");
  const nowMs = Date.parse("2026-07-30T09:11:13Z");

  assert.equal(freshnessSeconds(completedAtMs, nowMs), 99_001);
});

test("floors freshness at zero when GitHub's clock runs ahead", () => {
  const completedAtMs = Date.parse("2026-07-30T10:00:00Z");
  const nowMs = Date.parse("2026-07-30T09:59:00Z");

  assert.equal(freshnessSeconds(completedAtMs, nowMs), 0);
});

test("returns null instead of a bogus age for non-finite timestamps", () => {
  assert.equal(freshnessSeconds(Number.NaN, Date.now()), null);
  assert.equal(freshnessSeconds(Date.now(), Number.NaN), null);
  assert.equal(freshnessSeconds(Number.POSITIVE_INFINITY, Date.now()), null);
});
