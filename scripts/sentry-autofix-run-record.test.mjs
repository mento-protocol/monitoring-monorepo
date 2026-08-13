#!/usr/bin/env node
import {
  AUTOFIX_RUN_RECORD_MARKER,
  buildAutofixRunRecordBody,
} from "./sentry-autofix-run-record.mjs";

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

await test("run record body carries the marker, trigger, state, and tallies", () => {
  const body = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    opened: 1,
    refused: 1,
    incomplete: 0,
  });
  assert(body.includes(AUTOFIX_RUN_RECORD_MARKER), "rolling-comment marker");
  assert(body.includes("2026-07-19T08:30:00Z"), "timestamp");
  assert(body.includes("Trigger: schedule"), "trigger");
  assert(body.includes("State: active"), "disposition");
  assert(body.includes("Candidates selected: 2"), "candidate count");
  assert(body.includes("Fix PRs opened: 1"), "opened count");
  assert(body.includes("Refused (no PR): 1"), "refused count");
  assert(body.includes("Incomplete / errored: 0"), "incomplete count");
});

await test("run record body coerces missing/bad counters and labels safely", () => {
  const body = buildAutofixRunRecordBody({
    timestampIso: "",
    trigger: "",
    disposition: undefined,
    candidates: "not-a-number",
    opened: -3,
  });
  assert(body.includes("Trigger: unknown"), "missing trigger falls back");
  assert(body.includes("State: unknown"), "missing disposition falls back");
  assert(body.includes("Candidates selected: 0"), "bad candidate count -> 0");
  assert(body.includes("Fix PRs opened: 0"), "negative opened -> 0");
  assert(body.includes("Refused (no PR): 0"), "missing refused -> 0");
  assert(body.includes("Deferred (duplicate_of family): 0"), "missing -> 0");
});

await test("run record distinguishes a family-SUPPRESSED queue from an empty one", () => {
  // Deferral writes nothing to the queue, so this line is the only durable
  // trace. Without it, a run that stood its entire window down behind one
  // refused sibling rendered byte-identically to "nothing was queued" — a
  // permanently starved leg reading as a healthy idle one, which inverts the
  // ADR 0036 observability invariant this record exists to serve.
  const idle = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    opened: 0,
    refused: 0,
    incomplete: 0,
    deferred: 0,
  });
  const starved = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    opened: 0,
    refused: 0,
    incomplete: 0,
    deferred: 4,
    deferredIssues: "1313 1316 1326 1328",
  });
  assert(
    idle !== starved,
    "an all-deferred run must not render as an idle one",
  );
  assert(
    starved.includes(
      "Deferred (duplicate_of family): 4 (#1313, #1316, #1326, #1328)",
    ),
    `deferred line names the issues, got: ${starved}`,
  );
  // The numbers are the operator's input to the single-issue dispatch override,
  // so an absent list must not fabricate one.
  assert(
    idle.includes("Deferred (duplicate_of family): 0\n") ||
      idle.endsWith("Deferred (duplicate_of family): 0"),
    "no issue list when nothing was deferred",
  );
});

await test("run record deferred-issue list is whitelist-parsed, not escaped", () => {
  // The list reaches this line because agent-authored `duplicate_of` text
  // triggered a deferral, and it lands on a PUBLIC tracker comment. Only bare
  // positive integers survive — anything else is DROPPED, so no markup, no
  // mention, and no `::workflow command::` line can be smuggled through.
  const body = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    opened: 0,
    refused: 0,
    incomplete: 0,
    deferred: 2,
    deferredIssues: "1313 @everyone <img> 0 -5 1e3 ::error::x [x](y) 1316",
  });
  const line = body
    .split("\n")
    .find((l) => l.startsWith("- Deferred (duplicate_of family):"));
  assertEqual(line, "- Deferred (duplicate_of family): 2 (#1313, #1316)");
});

await test("run record caps the deferred-issue list rather than pasting the whole queue", () => {
  const many = Array.from({ length: 40 }, (_, i) => String(2000 + i)).join(" ");
  const body = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    opened: 0,
    refused: 0,
    incomplete: 0,
    deferred: 40,
    deferredIssues: many,
  });
  const line = body
    .split("\n")
    .find((l) => l.startsWith("- Deferred (duplicate_of family):"));
  assertEqual(
    (line.match(/#\d+/g) ?? []).length,
    10,
    "the count is the signal; the list is an affordance",
  );
  assert(
    line.startsWith("- Deferred (duplicate_of family): 40 ("),
    "count kept",
  );
});

await test("run record renders the Window tripwire only when the window exceeds the eval cap", () => {
  // PR #1810: a growing list window truncates its newest tail at the eval cap.
  // The record surfaces the approach ONLY when total > evaluated, so the steady
  // state (window fits) carries no noise line.
  const fits = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    windowTotal: 8,
    windowEvaluated: 50,
  });
  assert(!fits.includes("Window:"), "no Window line when the window fits");
  const truncated = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    windowTotal: 63,
    windowEvaluated: 50,
  });
  assert(
    truncated.includes("- Window: 63 stubs, evaluated 50"),
    `Window line renders when total exceeds evaluated, got: ${truncated}`,
  );
  // Absent/garbage window fields coerce to 0/0 -> no line (back-compat with
  // callers that do not thread the window).
  const noWindow = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
  });
  assert(!noWindow.includes("Window:"), "no Window line without window fields");
});

await test("run record renders each cost-budget truncation only when its budget was hit", () => {
  // PR #1810 follow-up: a family-dedupe lookup a per-run budget capped, so a stub
  // that should have stood down may re-attempt. Each fails toward MORE candidates
  // (never a wrong close), but the bounded re-attempt must not be silent — that
  // is exactly the byte-identical-to-healthy state the Window line exists to
  // remove. The lines render ONLY when the budget was actually hit, so the steady
  // state carries no noise. Flags arrive from the workflow env as strings.
  const clean = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    handledOverflow: 0,
    reverseTruncated: "false",
    reverseNonconvergent: "false",
  });
  assert(
    !clean.includes("truncated") && !clean.includes("did not converge"),
    "no truncation line in the steady state",
  );
  const hit = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    handledOverflow: 198,
    reverseTruncated: "true",
    reverseNonconvergent: "true",
  });
  assert(
    hit.includes(
      "- Handled-id lookups truncated: 198 over the MAX_HANDLED_ID_QUERIES budget (treated as not-handled)",
    ),
    `handled-overflow line renders with its count, got: ${hit}`,
  );
  assert(
    hit.includes(
      "- Reverse family verification truncated: a per-run budget or search-page limit was reached, so some finalists were left unverified (treated as not-admitted)",
    ),
    `reverse-truncation line renders cause-neutrally, got: ${hit}`,
  );
  // The line must NOT name a single specific budget — the flag has three causes.
  assert(
    !hit.includes("hit the MAX_REVERSE_PROBE_QUERIES budget"),
    "the reverse-truncation line must not assert one specific cause",
  );
  assert(
    hit.includes(
      "- Reverse family verification did not converge within MAX_REVERSE_ITERATIONS",
    ),
    `non-convergence line renders, got: ${hit}`,
  );
  // A garbage/absent overflow coerces to 0 -> no line (back-compat with callers
  // that do not thread the truncations), and the boolean flags accept only the
  // literal "true".
  const garbage = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    handledOverflow: "not-a-number",
    reverseTruncated: "TRUE",
    reverseNonconvergent: undefined,
  });
  assert(
    !garbage.includes("truncated") && !garbage.includes("did not converge"),
    "garbage/absent truncation fields render no line",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
