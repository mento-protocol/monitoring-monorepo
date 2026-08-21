#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import {
  AUTOFIX_RUN_RECORD_MARKER,
  buildAutofixRunRecordBody,
  renderRefusedStubInventory,
} from "./sentry-autofix-run-record.mjs";
import {
  parseRefusedStubInventory,
  readRefusedStubInventory,
  refusedInventoryArgs,
  runGhWithTimeout,
} from "./sentry-autofix-refused-inventory.mjs";

const RUN_RECORD_MODULES = [
  "sentry-autofix-run-record.mjs",
  "sentry-autofix-refused-inventory.mjs",
].map((name) => new URL(`./${name}`, import.meta.url));

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

await test("run-record modules stay under the 600-line soft cap", () => {
  for (const moduleUrl of RUN_RECORD_MODULES) {
    const lineCount = readFileSync(moduleUrl, "utf8").split(/\r?\n/).length;
    assert(
      lineCount <= 600,
      `${moduleUrl.pathname} has ${lineCount} lines; the cap is 600`,
    );
  }
});

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

await test("refused inventory reads the exact oldest-first all-state Search query", async () => {
  let calls = 0;
  const result = await readRefusedStubInventory(
    { repo: "mento-protocol/monitoring-monorepo" },
    {
      runGh: async (args) => {
        calls += 1;
        assertEqual(
          JSON.stringify(args),
          JSON.stringify(
            refusedInventoryArgs("mento-protocol/monitoring-monorepo"),
          ),
          "one bounded Search API request",
        );
        const query = args.find((arg) => arg.startsWith("q=repo:"));
        assert(
          query ===
            'q=repo:mento-protocol/monitoring-monorepo is:issue label:"sentry-triage" label:"sentry:fix-refused"',
          "query includes both labels and is:issue",
        );
        assert(
          !args.some(
            (arg) => arg.includes("is:open") || arg.includes("is:closed"),
          ),
          "no state filter",
        );
        return JSON.stringify({
          total_count: 2,
          incomplete_results: false,
          items: [{ number: 1304 }, { number: 1313 }],
        });
      },
    },
  );
  assertEqual(calls, 1, "single read");
  assertEqual(
    JSON.stringify(result),
    JSON.stringify({ state: "known", count: 2, issues: [1304, 1313] }),
  );
});

await test("refused inventory preserves ordered links and reports a capped remainder", () => {
  const result = parseRefusedStubInventory(
    JSON.stringify({
      total_count: 13,
      incomplete_results: false,
      items: Array.from({ length: 10 }, (_, index) => ({
        number: 1304 + index,
      })),
    }),
  );
  assertEqual(
    renderRefusedStubInventory(result, "mento-protocol/monitoring-monorepo"),
    "- Refused stubs (all states): 13 ([#1304](https://github.com/mento-protocol/monitoring-monorepo/issues/1304), [#1305](https://github.com/mento-protocol/monitoring-monorepo/issues/1305), [#1306](https://github.com/mento-protocol/monitoring-monorepo/issues/1306), [#1307](https://github.com/mento-protocol/monitoring-monorepo/issues/1307), [#1308](https://github.com/mento-protocol/monitoring-monorepo/issues/1308), [#1309](https://github.com/mento-protocol/monitoring-monorepo/issues/1309), [#1310](https://github.com/mento-protocol/monitoring-monorepo/issues/1310), [#1311](https://github.com/mento-protocol/monitoring-monorepo/issues/1311), [#1312](https://github.com/mento-protocol/monitoring-monorepo/issues/1312), [#1313](https://github.com/mento-protocol/monitoring-monorepo/issues/1313), +3 more)",
  );
});

await test("refused inventory defaults only nullish repositories", () => {
  const result = { state: "known", count: 1, issues: [1304] };
  const defaultLine =
    "- Refused stubs (all states): 1 ([#1304](https://github.com/mento-protocol/monitoring-monorepo/issues/1304))";
  assertEqual(renderRefusedStubInventory(result), defaultLine, "omitted repo");
  assertEqual(
    renderRefusedStubInventory(result, null),
    defaultLine,
    "null repo from an omitted CLI flag",
  );
  assertEqual(
    renderRefusedStubInventory(result, "example/custom-repo"),
    "- Refused stubs (all states): 1 ([#1304](https://github.com/example/custom-repo/issues/1304))",
    "explicit repo",
  );
});

await test("refused inventory accepts a known empty result", () => {
  assertEqual(
    JSON.stringify(
      parseRefusedStubInventory(
        JSON.stringify({
          total_count: 0,
          incomplete_results: false,
          items: [],
        }),
      ),
    ),
    JSON.stringify({ state: "known", count: 0, issues: [] }),
  );
});

await test("refused inventory rejects duplicate issue numbers", () => {
  assertEqual(
    JSON.stringify(
      parseRefusedStubInventory(
        JSON.stringify({
          total_count: 2,
          incomplete_results: false,
          items: [{ number: 1304 }, { number: 1304 }],
        }),
      ),
    ),
    JSON.stringify({ state: "unknown" }),
  );
});

await test("refused inventory requires the Search API list to be exactly capped", () => {
  assertEqual(
    JSON.stringify(
      parseRefusedStubInventory(
        JSON.stringify({
          total_count: 12,
          incomplete_results: false,
          items: [{ number: 1304 }],
        }),
      ),
    ),
    JSON.stringify({ state: "unknown" }),
  );
});

await test("a non-terminating gh child times out, is terminated, and becomes unknown", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killSignals = [];
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  const timers = [];
  const resultPromise = readRefusedStubInventory(
    { repo: "mento-protocol/monitoring-monorepo" },
    {
      runGh: (args) =>
        runGhWithTimeout(args, {
          spawnFn: () => child,
          timeoutMs: 5,
          killGraceMs: 10,
          setTimeoutFn: (callback, delay) => {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
          },
          clearTimeoutFn: (timer) => {
            timer.cleared = true;
          },
        }),
    },
  );
  assertEqual(timers.length, 1, "read arms one timeout");
  timers[0].callback();
  const result = await resultPromise;
  assertEqual(JSON.stringify(result), JSON.stringify({ state: "unknown" }));
  assertEqual(timers[0].cleared, true, "timeout is cleaned up on rejection");
  assertEqual(
    JSON.stringify(killSignals),
    JSON.stringify(["SIGTERM"]),
    "timed-out gh child first receives SIGTERM",
  );
  assertEqual(timers.length, 2, "SIGTERM arms one forced-kill grace timer");
  timers[1].callback();
  assertEqual(
    JSON.stringify(killSignals),
    JSON.stringify(["SIGTERM", "SIGKILL"]),
    "a child that ignores SIGTERM receives SIGKILL",
  );
});

await test("gh close and error paths clear the read deadline", async () => {
  for (const event of ["close", "error"]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const timers = [];
    const promise = runGhWithTimeout(["search/issues"], {
      spawnFn: () => child,
      setTimeoutFn: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: (timer) => {
        timer.cleared = true;
      },
    });
    if (event === "close") child.emit("close", 0);
    else child.emit("error", new Error("spawn failed"));
    if (event === "close") await promise;
    else await promise.catch(() => {});
    assertEqual(timers.length, 1, `${event} arms one deadline`);
    assertEqual(timers[0].cleared, true, `${event} clears the deadline`);
  }
});

await test("refused inventory fails closed for incomplete, command, JSON, shape, and count errors", async () => {
  const cases = [
    '{"total_count":1,"incomplete_results":true,"items":[{"number":1}]}',
    "not json",
    '{"total_count":1,"incomplete_results":false,"items":[{"number":"1"}]}',
    '{"total_count":0,"incomplete_results":false,"items":[{"number":1}]}',
  ];
  for (const stdout of cases) {
    assertEqual(
      JSON.stringify(parseRefusedStubInventory(stdout)),
      JSON.stringify({ state: "unknown" }),
    );
  }
  assertEqual(
    JSON.stringify(
      await readRefusedStubInventory(
        { repo: "mento-protocol/monitoring-monorepo" },
        {
          runGh: async () => {
            throw new Error("Search API unavailable");
          },
        },
      ),
    ),
    JSON.stringify({ state: "unknown" }),
  );
  const body = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    refused: 0,
    refusedInventory: { state: "unknown" },
  });
  assert(
    body.includes("- Refused stubs (all states): unknown"),
    "degraded read remains explicit",
  );
  assert(
    body.includes("- Refused (no PR): 0"),
    "current-run refusal line is unchanged",
  );
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

await test("run record distinguishes a SCOPE-suppressed queue from an empty one", () => {
  // The second stand-down class (issue #1785), on the same argument as the
  // first. The selector skips a `fix_scope: architectural` stub and writes
  // nothing to the queue from the select leg — fresh ones settle OPEN under
  // sentry:fix-scope-architectural and are window-excluded (#1812), so this
  // counts the LEGACY stragglers the backfill has not labeled yet. Unreported,
  // "triage is correctly classifying architectural" and "the prompt change never
  // landed" render the same line.
  const idle = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    deferred: 0,
    skipped: 0,
  });
  const scopeStarved = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    deferred: 0,
    skipped: 5,
    skippedIssues: "1304 1313 1316 1326 1328",
  });
  assert(
    idle !== scopeStarved,
    "an all-skipped run must not render as an idle one",
  );
  assert(
    scopeStarved.includes(
      "Skipped (fix_scope: architectural): 5 (#1304, #1313, #1316, #1326, #1328)",
    ),
    `skip line names the issues, got: ${scopeStarved}`,
  );
  assert(
    idle.includes("Skipped (fix_scope: architectural): 0"),
    "missing -> 0",
  );
  // Separate lines because an operator acts on them differently: a deferral
  // lifts when a sibling's marker goes, a skip only on re-triage.
  const both = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    deferred: 2,
    deferredIssues: "1313 1316",
    skipped: 1,
    skippedIssues: "1304",
  });
  assert(
    both.includes("Deferred (duplicate_of family): 2 (#1313, #1316)") &&
      both.includes("Skipped (fix_scope: architectural): 1 (#1304)"),
    `both stand-downs render independently, got: ${both}`,
  );
});

await test("run record skipped-issue list is whitelist-parsed too", () => {
  // Same public-tracker exposure as the deferred list, same agent-authored
  // trigger (`fix_scope` this time): only bare positive integers survive.
  const body = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    skipped: 2,
    skippedIssues: "1304 <img src=x> @everyone ../../etc 1313 -5 0",
  });
  const line = body
    .split("\n")
    .find((l) => l.startsWith("- Skipped (fix_scope: architectural):"));
  assertEqual(line, "- Skipped (fix_scope: architectural): 2 (#1304, #1313)");
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

await test("run record renders the bounded second look only when it actually ran", () => {
  // The second look is extra `gh` spend on a run that already found nothing, so
  // it must never be silent — and it carries an evaluation ceiling of its own,
  // so `evaluated < total` on the same line is its own truncation report.
  //
  // NEGATIVE CONTROL: drop the `if (secondLook === true …)` guard in
  // buildAutofixRunRecordBody and the steady-state assertion below (no line when
  // it did not run) fails.
  const idle = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
  });
  assert(
    !idle.includes("Second look"),
    "no second-look line when it did not run",
  );
  const ran = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 1,
    secondLook: "true",
    secondLookTotal: 7,
    secondLookEvaluated: 7,
  });
  assert(
    ran.includes("- Second look: 7 further stubs past the window, evaluated 7"),
    `second-look line renders, got: ${ran}`,
  );
  assert(
    !ran.includes("MAX_SECOND_LOOK_EVALUATIONS"),
    "an untruncated second look must not claim a cap it never hit",
  );
  const capped = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 1,
    secondLook: true,
    secondLookTotal: 105,
    secondLookEvaluated: 100,
  });
  assert(
    capped.includes(
      "- Second look: 105 further stubs past the window, evaluated 100 (capped by MAX_SECOND_LOOK_EVALUATIONS)",
    ),
    `a truncated second look names its cap, got: ${capped}`,
  );
});

await test("run record: the second look's REGROWTH tripwire is `full`, which the counts cannot carry", () => {
  // With the eval cap equal to the list ceiling the Window line above is inert,
  // and the pipeline note names this line the standing tripwire for queue
  // regrowth. The COUNTS cannot do that job: the second look's own row cap
  // clamps `secondLookTotal`, so `100 further stubs, evaluated 100` reads
  // identically whether 100 or 5,000 stubs sit past the ceiling — a tripwire
  // that cannot distinguish bounded from unbounded. `secondLookFull` is the
  // signal that can.
  //
  // NEGATIVE CONTROL: drop the `secondLookFull` branch from the suffix in
  // buildAutofixRunRecordBody and the first assertion below fails while the
  // saturated counts still render exactly as before.
  const base = {
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 0,
    secondLook: true,
    secondLookTotal: 100,
    secondLookEvaluated: 100,
  };
  const more = buildAutofixRunRecordBody({ ...base, secondLookFull: "true" });
  assert(
    more.includes("and MORE rows sit past even that"),
    `a full second-look page must say the queue is outgrowing one run, got: ${more}`,
  );
  const drained = buildAutofixRunRecordBody({ ...base, secondLookFull: false });
  assert(
    !drained.includes("MORE rows sit past"),
    "a second look that reached the end of the queue must not claim regrowth",
  );
  // A FAILED second look outranks both: it saw nothing at all, so the zeros
  // beside it mean "unknown", not "empty".
  const failed = buildAutofixRunRecordBody({
    ...base,
    secondLookTotal: 0,
    secondLookEvaluated: 0,
    secondLookFull: false,
    secondLookFailed: "true",
  });
  assert(
    failed.includes("the second look's own list read FAILED"),
    `a failed second look must say so, got: ${failed}`,
  );
});

await test("run record names the UNIT of the measured gh count, because two units are in play", () => {
  // The per-run cost ceiling was arithmetic nothing ever counted; this is the
  // observed number, so drift lands on the tracker before it lands as a timeout.
  // The counter counts INVOCATIONS (serial subprocesses — the unit the job
  // timeout is spent in), while the rate-budget arithmetic in the pipeline note
  // counts API REQUESTS, and one `gh issue list --limit 200` is one invocation
  // but two requests. Labelled "gh reads" the number was silently compared
  // against a ceiling in the other unit, which is a drift detector that cannot
  // detect drift.
  const measured = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    ghCalls: 521,
  });
  assert(measured.includes("- gh invocations: 521"), `got: ${measured}`);
  const none = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "off-main",
    candidates: 0,
  });
  assert(
    !none.includes("gh invocations"),
    "a leg that issued no reads carries no count line",
  );
});

await test("run record renders a LOUD degraded line when reads were rate limited", () => {
  // Fail-closed's whole point is that the suppression is visible: a run that
  // emitted zero entries because GitHub throttled it must not render identically
  // to an idle one — that is the #1758 misdiagnosis in a new costume, and here it
  // would be hiding a state in which a duplicate PR was NARROWLY avoided.
  //
  // NEGATIVE CONTROL: drop the `rateLimitedN > 0` push and the assertion below
  // fails while every other line still renders — proving this line is the only
  // durable trace of the degradation.
  const degraded = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "degraded-rate-limited",
    candidates: 0,
    rateLimited: 3,
  });
  assert(
    degraded.includes("**DEGRADED (rate limited):** 3 gh read(s)"),
    `degraded line renders with its count, got: ${degraded}`,
  );
  assert(
    degraded.includes("0 entries emitted"),
    "the degraded line must state that selection was suppressed",
  );
  const clean = buildAutofixRunRecordBody({
    timestampIso: "2026-07-19T08:30:00Z",
    trigger: "schedule",
    disposition: "active",
    candidates: 2,
    rateLimited: 0,
  });
  assert(
    !clean.includes("DEGRADED"),
    "the steady state carries no degraded line",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
