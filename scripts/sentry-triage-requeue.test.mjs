#!/usr/bin/env node
/**
 * Tests for the re-queue chokepoint itself.
 *
 * The two call sites are covered end-to-end by
 * scripts/sentry-triage-ingest.test.mjs and
 * scripts/sentry-triage-archive.test.mjs. What those cannot reach is the
 * chokepoint's own contract — the properties a NEW caller would rely on and a
 * refactor could quietly drop while both existing sites stay green:
 *
 *   - the cause decides the fence, and an undeclared cause refuses;
 *   - the fence text has exactly one definition and one caller;
 *   - the fence precedes the label write and the state change goes last;
 *   - the claim records ATTEMPTS, including ones that throw;
 *   - admissibility is asked by recency, never by presence;
 *   - a fencing re-queue clears the RENDERED verdict too, and does it without
 *     disturbing anything else in the body.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REGRESSION_PREFIX,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
import {
  BRIEF_BLOCK_END,
  BRIEF_BLOCK_START,
  NEEDS_TRIAGE_LABEL,
  parseArchiveBaseline,
} from "./sentry-triage-queue-contract.mjs";
import {
  buildRegressedComment,
  buildReopenLabelEditArgs,
  buildRequeueFence,
  buildStrandedRecoveryComment,
  hasAdmissibleVerdict,
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_CAUSE_SENTRY_EVIDENCE,
  REQUEUE_ON_FAILURE_VERIFY_END_STATE,
  requeueFences,
  requeueQueueStub,
} from "./sentry-triage-requeue.mjs";

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

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pattern && !pattern.test(message)) {
      throw new Error(`expected /${pattern.source}/, got: ${message}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected a rejection");
}

const REPO = "mento-protocol/monitoring-monorepo";
const BOT = { author: { login: "github-actions" } };

/** Records every `gh` call the chokepoint makes, and can fail a chosen verb. */
function makeWriter({ failOn = () => null } = {}) {
  const calls = [];
  return {
    calls,
    writeGh: async (args) => {
      calls.push(args);
      const failure = failOn(args);
      if (failure) throw new Error(failure);
      return "";
    },
    verbs: () => calls.map((args) => args[1]),
  };
}

// ---------------------------------------------------------------------------
// The rule itself.
// ---------------------------------------------------------------------------

await test("the cause, and only the cause, decides the fence", () => {
  assertEqual(requeueFences(REQUEUE_CAUSE_SENTRY_EVIDENCE), true);
  assertEqual(requeueFences(REQUEUE_CAUSE_BOOKKEEPING), false);
});

await test("an undeclared cause refuses instead of defaulting", () => {
  // Both defaults are wrong. A silent no-fence buries regressions; a silent
  // fence discards verdicts the pipeline means to keep. A caller that cannot
  // name its cause has not decided anything yet.
  for (const bad of [undefined, null, "", "regression", "Sentry-Evidence"]) {
    let threw = false;
    try {
      requeueFences(bad);
    } catch (err) {
      threw = /Unknown re-queue cause/.test(err.message);
    }
    assert(threw, `cause ${JSON.stringify(bad)} must refuse, not default`);
  }
});

await test("buildRequeueFence renders the fence only for Sentry evidence", () => {
  const fence = buildRequeueFence(REQUEUE_CAUSE_SENTRY_EVIDENCE, {
    lastSeen: "2026-07-20T08:00:00Z",
  });
  assertEqual(fence, buildRegressedComment("2026-07-20T08:00:00Z"));
  assert(fence.startsWith(REGRESSION_PREFIX), "the parser reads the prefix");
  assertEqual(
    buildRequeueFence(REQUEUE_CAUSE_BOOKKEEPING, {
      lastSeen: "2026-07-20T08:00:00Z",
    }),
    null,
  );
});

await test("caller prose renders UNDER the fence line, never over it", () => {
  // A caller can explain its refusal; it can never author — or omit — the line
  // selectVerdictComment actually reads.
  const body = buildRequeueFence(REQUEUE_CAUSE_SENTRY_EVIDENCE, {
    lastSeen: "2026-07-20T08:00:00Z",
    prose: ["**Not archived.** because reasons", "second line"],
  });
  const lines = body.split("\n");
  assertEqual(lines[0], buildRegressedComment("2026-07-20T08:00:00Z"));
  assertEqual(lines[1], "");
  assertEqual(lines[2], "**Not archived.** because reasons");
  assert(body.startsWith(REGRESSION_PREFIX), "prose cannot displace the fence");
});

await test("the bookkeeping note is not, and must never become, a fence", () => {
  assert(
    !buildStrandedRecoveryComment().startsWith(REGRESSION_PREFIX),
    "a bookkeeping re-queue must not stale out a still-valid verdict",
  );
});

// ---------------------------------------------------------------------------
// One definition, one caller.
// ---------------------------------------------------------------------------

await test("buildRegressedComment has exactly one call site: the chokepoint", () => {
  // #1716 shipped a re-queue that quietly lacked the fence because the fence was
  // something each producer chose to emit. Keeping the builder to a single
  // caller is what makes "declare a cause" the only way to get one.
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith(".mjs")) continue;
    if (file.endsWith(".test.mjs")) continue; // tests pin the text, by design
    if (file === "sentry-triage-requeue.mjs") continue;
    const src = readFileSync(join(scriptsDir, file), "utf8");
    // A bare re-export is not a call site.
    const withoutExports = src.replace(
      /export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];/g,
      "",
    );
    if (/\bbuildRegressedComment\s*\(/.test(withoutExports)) {
      offenders.push(file);
    }
  }
  assertDeepEqual(offenders, []);
});

await test("the chokepoint reaches the fence builder through buildRequeueFence", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "sentry-triage-requeue.mjs"),
    "utf8",
  );
  const calls = src.match(/(?<!function\s)\bbuildRegressedComment\s*\(/g) ?? [];
  // Exactly one call — the declaration is excluded by the lookbehind.
  assertEqual(calls.length, 1);
  assert(
    /export function buildRequeueFence[\s\S]*?buildRegressedComment\(lastSeen\)/.test(
      src,
    ),
    "the single call must sit inside buildRequeueFence",
  );
});

// ---------------------------------------------------------------------------
// Ordering.
// ---------------------------------------------------------------------------

await test("a Sentry-evidence re-queue posts the fence before it touches labels", async () => {
  const w = makeWriter();
  await requeueQueueStub(
    { writeGh: w.writeGh },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
    },
  );
  assertDeepEqual(w.verbs(), ["comment", "edit", "reopen"]);
  assertEqual(
    w.calls[0][w.calls[0].indexOf("--body") + 1],
    buildRegressedComment("2026-07-20T08:00:00Z"),
  );
  assertDeepEqual(w.calls[1], buildReopenLabelEditArgs(42, REPO));
});

await test("a bookkeeping re-queue writes labels, its note, then the state", async () => {
  const w = makeWriter();
  await requeueQueueStub(
    { writeGh: w.writeGh },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
    },
  );
  assertDeepEqual(w.verbs(), ["edit", "comment", "reopen"]);
  assertEqual(
    w.calls[1][w.calls[1].indexOf("--body") + 1],
    buildStrandedRecoveryComment(),
  );
});

await test("an interrupted fence post never leaves the stub queued", async () => {
  // The whole reason the fence goes first: the interrupted state must be
  // fenced-but-unqueued (inert, retried), never queued-but-unfenced.
  const w = makeWriter({
    failOn: (args) => (args[1] === "comment" ? "gh issue comment: 500" : null),
  });
  await assertRejects(
    requeueQueueStub(
      { writeGh: w.writeGh },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
      },
    ),
  );
  assertDeepEqual(w.verbs(), ["comment"]);
});

await test("the state change is the last write on both causes", async () => {
  for (const [cause, extra] of [
    [REQUEUE_CAUSE_SENTRY_EVIDENCE, { lastSeen: "2026-07-20T08:00:00Z" }],
    [REQUEUE_CAUSE_BOOKKEEPING, { note: buildStrandedRecoveryComment() }],
  ]) {
    const w = makeWriter();
    await requeueQueueStub(
      { writeGh: w.writeGh },
      { repo: REPO, issueNumber: 42, cause, ...extra },
    );
    assertEqual(w.verbs().at(-1), "reopen");
  }
});

// ---------------------------------------------------------------------------
// The exclusion set records ATTEMPTS.
// ---------------------------------------------------------------------------

await test("the claim lands before the first write, not after the last", async () => {
  const claimed = [];
  const w = makeWriter();
  await requeueQueueStub(
    {
      writeGh: async (args) => {
        claimed.push(`writes-so-far:${claimed.length}`);
        return w.writeGh(args);
      },
      claim: () => claimed.push("claim"),
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
    },
  );
  assertEqual(claimed[0], "claim");
});

await test("a re-queue that throws half-way is still recorded as an attempt", async () => {
  // The #1716 defect this closes: recording only SUCCESSES left a failed
  // Sentry-evidence re-queue unclaimed, and the same run's fence-free
  // bookkeeping sweep then recovered it — laundering the cause.
  for (const verb of ["comment", "edit", "reopen"]) {
    const claimed = new Set();
    const w = makeWriter({
      failOn: (args) => (args[1] === verb ? `gh issue ${verb}: 500` : null),
    });
    await assertRejects(
      requeueQueueStub(
        { writeGh: w.writeGh, claim: () => claimed.add(42) },
        {
          repo: REPO,
          issueNumber: 42,
          cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
          lastSeen: "2026-07-20T08:00:00Z",
        },
      ),
    );
    assert(claimed.has(42), `a failure on ${verb} must still claim the stub`);
  }
});

await test("an undeclared cause refuses before it claims or writes anything", async () => {
  const claimed = new Set();
  const w = makeWriter();
  await assertRejects(
    requeueQueueStub(
      { writeGh: w.writeGh, claim: () => claimed.add(42) },
      { repo: REPO, issueNumber: 42, cause: "regression" },
    ),
    /Unknown re-queue cause/,
  );
  assertEqual(claimed.size, 0);
  assertDeepEqual(w.verbs(), []);
});

// ---------------------------------------------------------------------------
// Revalidation.
// ---------------------------------------------------------------------------

await test("a revalidation that no longer holds stops before any write", async () => {
  const w = makeWriter();
  const outcome = await requeueQueueStub(
    {
      writeGh: w.writeGh,
      readStub: async () => ({ state: "OPEN", labels: ["sentry-triage"] }),
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
      revalidate: {
        check: (live) => live.labels.includes(NEEDS_TRIAGE_LABEL),
        declineNote: () => "declined",
      },
    },
  );
  assertEqual(outcome.requeued, false);
  assertEqual(outcome.reason, "revalidated-away");
  assertDeepEqual(w.verbs(), []);
});

await test("a failed revalidation read aborts rather than proceeding blind", async () => {
  const w = makeWriter();
  await assertRejects(
    requeueQueueStub(
      {
        writeGh: w.writeGh,
        readStub: async () => {
          throw new Error("gh issue view: 500");
        },
      },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_BOOKKEEPING,
        note: buildStrandedRecoveryComment(),
        revalidate: { check: () => true, declineNote: () => "declined" },
      },
    ),
    /gh issue view: 500/,
  );
  assertDeepEqual(w.verbs(), []);
});

// ---------------------------------------------------------------------------
// Author-fenced dedup.
// ---------------------------------------------------------------------------

await test("the dedup read is author-fenced", async () => {
  // This repo is PUBLIC. Without the author check, anyone who guesses the
  // regression's exact lastSeen can pre-post the body and suppress the bot's
  // real fence, while selectVerdictComment ignores theirs.
  const fence = buildRegressedComment("2026-07-20T08:00:00Z");
  const w = makeWriter();
  await requeueQueueStub(
    {
      writeGh: w.writeGh,
      readComments: async () => [
        { body: fence, author: { login: "drive-by-account" } },
      ],
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
      dedupeFence: true,
    },
  );
  assertDeepEqual(w.verbs(), ["comment", "edit", "reopen"]);
});

await test("the bot's own identical fence is deduped", async () => {
  const fence = buildRegressedComment("2026-07-20T08:00:00Z");
  const w = makeWriter();
  await requeueQueueStub(
    {
      writeGh: w.writeGh,
      readComments: async () => [{ ...BOT, body: fence }],
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
      dedupeFence: true,
    },
  );
  assertDeepEqual(w.verbs(), ["edit", "reopen"]);
});

await test("a fence that identifies no occurrence is never deduped", async () => {
  // buildRegressedComment renders a CONSTANT body for a missing/unparsable
  // lastSeen, so identical bodies say nothing about which occurrence they
  // belong to. A duplicate fence is noise; a missing one buries a regression.
  for (const lastSeen of [null, "not-a-timestamp"]) {
    const fence = buildRegressedComment(lastSeen);
    const w = makeWriter();
    await requeueQueueStub(
      {
        writeGh: w.writeGh,
        readComments: async () => [{ ...BOT, body: fence }],
      },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen,
        dedupeFence: true,
      },
    );
    assertDeepEqual(w.verbs(), ["comment", "edit", "reopen"]);
  }
});

await test("dedup is opt-in: a site that does not declare it always posts", async () => {
  const fence = buildRegressedComment("2026-07-20T08:00:00Z");
  const w = makeWriter();
  await requeueQueueStub(
    {
      writeGh: w.writeGh,
      readComments: async () => [{ ...BOT, body: fence }],
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
    },
  );
  assertDeepEqual(w.verbs(), ["comment", "edit", "reopen"]);
});

// ---------------------------------------------------------------------------
// Admissibility, by recency.
// ---------------------------------------------------------------------------

const verdictAt = (createdAt) => ({
  ...BOT,
  createdAt,
  body: `${VERDICT_MARKER}\nverdict: upstream-transient`,
});
const fenceAt = (createdAt) => ({
  ...BOT,
  createdAt,
  body: buildRegressedComment("2026-07-20T08:00:00Z"),
});

await test("hasAdmissibleVerdict asks about recency, not presence", () => {
  // A fence that EXISTS but predates the newest verdict protects nothing.
  assertEqual(
    hasAdmissibleVerdict([
      fenceAt("2026-07-21T10:00:00Z"),
      verdictAt("2026-07-22T10:00:00Z"),
    ]),
    true,
  );
  assertEqual(
    hasAdmissibleVerdict([
      verdictAt("2026-07-22T10:00:00Z"),
      fenceAt("2026-07-23T10:00:00Z"),
    ]),
    false,
  );
  assertEqual(hasAdmissibleVerdict([]), false);
  assertEqual(
    hasAdmissibleVerdict([
      {
        author: { login: "drive-by" },
        createdAt: "2026-07-24T10:00:00Z",
        body: `${VERDICT_MARKER}\nverdict: code-fix`,
      },
    ]),
    false,
  );
});

await test("verify-end-state fails RED when a verdict survives the re-queue", async () => {
  const live = {
    state: "OPEN",
    labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
    // A stale fence AND a verdict posted after it: presence passes, recency
    // does not.
    comments: [
      fenceAt("2026-07-21T10:00:00Z"),
      verdictAt("2026-07-22T10:00:00Z"),
    ],
  };
  const w = makeWriter();
  await assertRejects(
    requeueQueueStub(
      { writeGh: w.writeGh, readStub: async () => live },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
        onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      },
    ),
    /a previous verdict is still admissible/,
  );
});

await test("a bookkeeping re-queue is never failed for a surviving verdict", async () => {
  // The over-fencing error, in its verification form: a bookkeeping re-queue
  // MEANS to leave the prior verdict admissible, so asserting the opposite here
  // would turn every correct recovery red.
  const live = {
    state: "OPEN",
    labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
    comments: [verdictAt("2026-07-22T10:00:00Z")],
  };
  const w = makeWriter();
  const outcome = await requeueQueueStub(
    { writeGh: w.writeGh, readStub: async () => live },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
      onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
    },
  );
  assertEqual(outcome.requeued, true);
});

await test("verify-end-state fails RED on a marker the shed left behind", async () => {
  const live = {
    state: "OPEN",
    labels: ["sentry-triage", NEEDS_TRIAGE_LABEL, "sentry:approved-archive"],
    comments: [],
  };
  const w = makeWriter();
  await assertRejects(
    requeueQueueStub(
      { writeGh: w.writeGh, readStub: async () => live },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
        onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      },
    ),
    /these stale markers survived: sentry:approved-archive/,
  );
});

// ---------------------------------------------------------------------------
// INVARIANT 8 — the rendered verdict goes with the fenced one.
// ---------------------------------------------------------------------------

const STUB_TAIL = [
  "```yaml",
  'short_id: "ABC-1"',
  'archive_baseline_last_seen: "2026-08-04T12:29:24Z"',
  'archive_baseline_sentry_issue_id: "7651697505"',
  "```",
  "",
].join("\n");

const UNBRIEFED_BODY = `<!-- sentry-triage:v1 -->\n\n${STUB_TAIL}`;

const BRIEFED_BODY = [
  "<!-- sentry-triage:v1 -->",
  "",
  BRIEF_BLOCK_START,
  "",
  "> **Decision needed** · `ABC-1` · confidence: low",
  "",
  "**Question:** Decide whether to rotate the key",
  "",
  BRIEF_BLOCK_END,
  "",
  STUB_TAIL,
].join("\n");

await test("a Sentry-evidence re-queue clears the brief between the fence and the labels", async () => {
  const w = makeWriter();
  await requeueQueueStub(
    { writeGh: w.writeGh, readBody: async () => BRIEFED_BODY },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
    },
  );
  // fence -> body clear -> labels -> reopen. The ordering matters for the same
  // reason the fence does: every interruption point stays safe.
  assertDeepEqual(w.verbs(), ["comment", "edit", "edit", "reopen"]);
  const cleared = w.calls[1][w.calls[1].indexOf("--body") + 1];
  assert(
    !cleared.includes(BRIEF_BLOCK_START) &&
      !cleared.includes("Decision needed"),
    "expected the rendered brief gone",
  );
  assertEqual(cleared, UNBRIEFED_BODY);
  // Everything else in the body — including the archive freshness baseline,
  // whose loss is silent — survives untouched.
  assertEqual(parseArchiveBaseline(cleared).lastSeen, "2026-08-04T12:29:24Z");
  assertEqual(parseArchiveBaseline(cleared).sentryIssueId, "7651697505");
  assertDeepEqual(w.calls[2], buildReopenLabelEditArgs(42, REPO));
});

await test("a bookkeeping re-queue leaves the brief alone", async () => {
  // Nothing in Sentry moved, so the verdict stays admissible — and so does the
  // brief that renders it. Over-clearing is as wrong as under-clearing.
  let reads = 0;
  const w = makeWriter();
  await requeueQueueStub(
    {
      writeGh: w.writeGh,
      readBody: async () => {
        reads += 1;
        return BRIEFED_BODY;
      },
    },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
    },
  );
  assertEqual(reads, 0);
  assertDeepEqual(w.verbs(), ["edit", "comment", "reopen"]);
});

await test("a body with no brief is not rewritten at all", async () => {
  const w = makeWriter();
  await requeueQueueStub(
    { writeGh: w.writeGh, readBody: async () => UNBRIEFED_BODY },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: "2026-07-20T08:00:00Z",
    },
  );
  assertDeepEqual(w.verbs(), ["comment", "edit", "reopen"]);
});

await test("a brief clear that fails never costs the re-queue", async () => {
  // A stale rendering is a display defect; an unqueued live regression is the
  // failure this module exists to prevent. So every failure mode here — an
  // unreadable body, a malformed block, a failed write — degrades to a notice.
  for (const deps of [
    {
      readBody: async () => {
        throw new Error("gh issue view: 500");
      },
    },
    { readBody: async () => `${BRIEF_BLOCK_START}\nhalf a block\n` },
    {
      readBody: async () => BRIEFED_BODY,
      failEdits: true,
    },
  ]) {
    const w = makeWriter({
      failOn: (args) =>
        deps.failEdits && args[1] === "edit" && args.includes("--body")
          ? "gh issue edit: 500"
          : null,
    });
    const outcome = await requeueQueueStub(
      { writeGh: w.writeGh, readBody: deps.readBody },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
      },
    );
    assertEqual(outcome.requeued, true);
    assertEqual(w.verbs().at(-1), "reopen");
  }
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
