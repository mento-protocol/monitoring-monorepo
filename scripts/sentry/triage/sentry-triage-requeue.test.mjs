#!/usr/bin/env node
/**
 * Tests for the re-queue chokepoint itself.
 *
 * The two call sites are covered end-to-end by
 * scripts/sentry/triage/sentry-triage-ingest.test.mjs and
 * scripts/sentry/triage/sentry-triage-archive.test.mjs. What those cannot reach is the
 * chokepoint's own contract — the properties a NEW caller would rely on and a
 * refactor could quietly drop while both existing sites stay green:
 *
 *   - the cause decides the fence, and an undeclared cause refuses;
 *   - the fence text has exactly one definition and one caller;
 *   - the fence precedes the label write and the state change goes last;
 *   - the claim records ATTEMPTS, including ones that throw;
 *   - admissibility is asked by recency, never by presence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { settlementHeld } from "./sentry-triage-archive.mjs";
import { buildUnwindCorrections } from "./sentry-triage-requeue-sentinel.mjs";
import {
  REGRESSION_PREFIX,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";
import {
  NEEDS_TRIAGE_LABEL,
  STRAND_SHAPE_CLOSED_NEEDS_TRIAGE,
  STRAND_SHAPE_OPEN_VERDICT,
} from "./sentry-triage-queue-contract.mjs";
import {
  buildRegressedComment,
  buildRequeueAddLabelArgs,
  buildRequeueShedLabelArgs,
  buildRequeueFence,
  buildStrandedRecoveryComment,
  hasAdmissibleVerdict,
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_CAUSE_SENTRY_EVIDENCE,
  REQUEUE_ON_FAILURE_VERIFY_END_STATE,
  requeueFences,
  requeueQueueStub,
} from "./sentry-triage-requeue.mjs";
import {
  buildRequeueNote,
  isTerminalStub,
  parseRequeueArgs,
  REQUEUE_REASON_BRIEF_CLEAR,
  REQUEUE_REASON_CLOSE_FAILURE,
  REQUEUE_REASON_VERDICT_UNSETTLED,
  REQUEUE_REASONS,
  runWorkflowRequeue,
} from "./sentry-triage-workflow-requeue.mjs";

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
  // Repo-root scripts/, walked recursively: the sentry family (and other
  // module directories) no longer sit flat at scripts/ top level, so a
  // non-recursive readdirSync of "wherever this test file lives" would
  // silently stop seeing exactly the files most likely to call this builder.
  // This file itself sits two directories below scripts/, so scriptsDir walks
  // up two levels rather than using its own directory directly.
  const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const offenders = [];
  let scanned = 0;
  for (const relative of readdirSync(scriptsDir, { recursive: true })) {
    if (!relative.endsWith(".mjs")) continue;
    if (relative.endsWith(".test.mjs")) continue; // tests pin the text, by design
    // Path-exact, not basename: a recursive walk yields `<subdir>/<name>`, so
    // excluding by basename would skip a future second copy of this file
    // living in a different directory — the second-owner case this test
    // exists to catch. This file itself now lives at
    // scripts/sentry/triage/sentry-triage-requeue.mjs, so the exact relative
    // path excluded here must match that nested location.
    if (relative === "sentry/triage/sentry-triage-requeue.mjs") continue;
    scanned += 1;
    const src = readFileSync(join(scriptsDir, relative), "utf8");
    // A bare re-export is not a call site.
    const withoutExports = src.replace(
      /export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];/g,
      "",
    );
    if (/\bbuildRegressedComment\s*\(/.test(withoutExports)) {
      offenders.push(relative);
    }
  }
  // An enumeration that finds almost nothing PASSES, silently, having checked
  // almost nothing — the failure mode a sparse view creates (Codex 3761902959:
  // 25 of 92 modules were visible inside the gate's per-suite snapshot). A
  // floor makes that loud instead. It is deliberately well under the real count
  // so ordinary additions and deletions never touch it.
  assert(
    scanned >= 60,
    `only ${scanned} non-test scripts/**/*.mjs were scanned — this check is running against a partial view of scripts/, so its result means nothing`,
  );
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
  assertDeepEqual(w.verbs(), ["comment", "edit", "edit", "reopen"]);
  assertEqual(
    w.calls[0][w.calls[0].indexOf("--body") + 1],
    buildRegressedComment("2026-07-20T08:00:00Z"),
  );
  assertDeepEqual(w.calls[1], buildRequeueAddLabelArgs(42, REPO));
  assertDeepEqual(w.calls[2], buildRequeueShedLabelArgs(42, REPO));
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
  assertDeepEqual(w.verbs(), ["edit", "edit", "comment", "reopen"]);
  assertEqual(
    w.calls[2][w.calls[2].indexOf("--body") + 1],
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

await test("no re-queue write mixes --add-label with --remove-label (#1693)", async () => {
  // `gh issue edit --add-label X --remove-label Y` is TWO concurrent GraphQL
  // mutations, not one write. The half that can be lost is the add, and losing
  // it on the regression path leaves a CLOSED stub with `sentry:archived` shed
  // and `sentry:needs-triage` never applied — invisible to `decideDedupAction`'s
  // baseline branch AND to the stranded sweep. Ordering the two flags into two
  // calls is what removes that state, so no single call may carry both again.
  for (const [cause, extra] of [
    [REQUEUE_CAUSE_SENTRY_EVIDENCE, { lastSeen: "2026-07-20T08:00:00Z" }],
    [REQUEUE_CAUSE_BOOKKEEPING, { note: buildStrandedRecoveryComment() }],
  ]) {
    const w = makeWriter();
    await requeueQueueStub(
      { writeGh: w.writeGh },
      { repo: REPO, issueNumber: 42, cause, ...extra },
    );
    for (const args of w.calls) {
      assert(
        !(args.includes("--add-label") && args.includes("--remove-label")),
        `one call carried both label flags: ${args.join(" ")}`,
      );
    }
    // And in the order that makes every interruption sweep-visible.
    const labelEdits = w.calls.filter((args) => args[1] === "edit");
    assertDeepEqual(labelEdits, [
      buildRequeueAddLabelArgs(42, REPO),
      buildRequeueShedLabelArgs(42, REPO),
    ]);
  }
});

await test("a failed needs-triage add never proceeds to the shed (#1693)", async () => {
  // Abort ordering, stated as the property that matters: the stub keeps the
  // markers ingest's baseline branch reads, because the shed never ran.
  const w = makeWriter({
    failOn: (args) =>
      args.includes("--add-label") ? "gh issue edit: 500" : null,
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
  assert(
    !w.calls.some((args) => args.includes("--remove-label")),
    "the shed must not run once the add has failed",
  );
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
  assertDeepEqual(w.verbs(), ["comment", "edit", "edit", "reopen"]);
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
  assertDeepEqual(w.verbs(), ["edit", "edit", "reopen"]);
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
    assertDeepEqual(w.verbs(), ["comment", "edit", "edit", "reopen"]);
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
  assertDeepEqual(w.verbs(), ["comment", "edit", "edit", "reopen"]);
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

await test("a reported add failure still gets the markers shed once selectability is back", async () => {
  // THE SEQUENCING HAZARD. The add and the shed share one try, so an add that
  // REPORTS failure jumps past the shed — never attempted, not merely failed.
  // `ensureSelectableForTriage` then re-adds the label and the stub is
  // SELECTABLE again, which is the worst place to stop: a stranded stub is
  // inert, but a selectable one still wearing `sentry:approved-archive` hands
  // the next archive dispatch a human approval this re-queue was meant to
  // consume, and its autofix markers suppress the next fix attempt.
  const live = {
    state: "OPEN",
    labels: [
      "sentry-triage",
      "sentry:verdict-upstream",
      "sentry:projected",
      "sentry:approved-archive",
      "sentry:fix-pr-opened",
    ],
    comments: [],
  };
  let addAttempts = 0;
  const w = makeWriter({
    failOn: (args) => {
      // Only the chokepoint's OWN add reports failure; the verifier's retry
      // succeeds. That is the transient case this must self-heal.
      if (args.includes("--add-label")) {
        addAttempts += 1;
        return addAttempts === 1 ? "gh issue edit: 502" : null;
      }
      return null;
    },
  });
  const writeGh = async (args) => {
    const out = await w.writeGh(args);
    if (args.includes("--add-label"))
      for (const n of args[args.indexOf("--add-label") + 1].split(","))
        if (!live.labels.includes(n)) live.labels.push(n);
    if (args.includes("--remove-label")) {
      const rm = new Set(args[args.indexOf("--remove-label") + 1].split(","));
      live.labels = live.labels.filter((n) => !rm.has(n));
    }
    return out;
  };

  // No throw: the retry healed it, so the run is honest about being fine.
  await requeueQueueStub(
    { writeGh, readStub: async () => live },
    {
      repo: REPO,
      issueNumber: 42,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
      onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      fallbackState: "OPEN",
    },
  );

  assert(
    w.calls.some((args) => args.includes("--remove-label")),
    "the skipped shed must be re-attempted after selectability is restored",
  );
  assertDeepEqual(live.labels, ["sentry-triage", NEEDS_TRIAGE_LABEL]);
  assert(
    !live.labels.includes("sentry:approved-archive"),
    "a consumed archive approval must never survive onto a selectable stub",
  );
});

await test("a shed that never lands still fails RED rather than healing on paper", async () => {
  // The retry is BOUNDED and the check still decides. A stub whose markers
  // genuinely survive must stay loud — self-healing the transient case must not
  // become quietly tolerating the persistent one.
  const live = {
    state: "OPEN",
    labels: ["sentry-triage", NEEDS_TRIAGE_LABEL, "sentry:approved-archive"],
    comments: [],
  };
  const w = makeWriter({
    failOn: (args) =>
      args.includes("--remove-label") ? "gh issue edit: 500" : null,
  });
  await assertRejects(
    requeueQueueStub(
      { writeGh: w.writeGh, readStub: async () => live },
      {
        repo: REPO,
        issueNumber: 42,
        cause: REQUEUE_CAUSE_BOOKKEEPING,
        note: buildStrandedRecoveryComment(),
        onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
        fallbackState: "OPEN",
      },
    ),
    /these stale markers survived: sentry:approved-archive/,
  );
  const shedAttempts = w.calls.filter((args) =>
    args.includes("--remove-label"),
  ).length;
  assert(
    shedAttempts >= 1 && shedAttempts <= 2,
    `the shed retry must be bounded, saw ${shedAttempts} attempts`,
  );
  // The note is intent-worded, so a stub left carrying markers is not sitting
  // under a comment claiming they were removed.
  assert(
    !buildStrandedRecoveryComment().includes("have been shed"),
    "the note must not attest a shed that did not land",
  );
});

// ---------------------------------------------------------------------------
// The stub BODY is nobody's to rewrite here.
// ---------------------------------------------------------------------------

await test("no re-queue path rewrites the stub body (#1692)", async () => {
  // The reopen baseline `pickReopenBaseline` hands ingest is the stub body's
  // `last_seen`, and its whole worth is that ingest wrote it ONCE, at creation:
  // that is what makes it provably earlier than the human approval. A body write
  // on this path would break two things at once. It would move the baseline
  // later, narrowing the gate #1692 exists to widen; and because
  // `gh issue edit --body` replaces the WHOLE body, it would put a second writer
  // beside the archive leg — the only one the trust boundary in
  // sentry-triage-queue-contract.mjs allows — racing it over the
  // `archive_*_last_seen` fields ingest reads back.
  //
  // Bodies are still written here, as COMMENTS. The distinction is the property.
  let reads = 0;
  const cases = [
    [
      {},
      {
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
      },
    ],
    [
      {},
      {
        cause: REQUEUE_CAUSE_BOOKKEEPING,
        note: buildStrandedRecoveryComment(),
      },
    ],
    [
      {
        // Closed and unlabelled on the first read, so the verifier's own repair
        // writes run too; selectable on the next, so it settles.
        readStub: async () => {
          reads += 1;
          return reads === 1
            ? { state: "CLOSED", labels: ["sentry-triage"], comments: [] }
            : {
                state: "OPEN",
                labels: ["sentry-triage", NEEDS_TRIAGE_LABEL],
                comments: [fenceAt("2026-07-22T10:00:00Z")],
              };
        },
      },
      {
        cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
        lastSeen: "2026-07-20T08:00:00Z",
        onFailure: REQUEUE_ON_FAILURE_VERIFY_END_STATE,
      },
    ],
  ];
  for (const [deps, options] of cases) {
    const w = makeWriter();
    await requeueQueueStub(
      { writeGh: w.writeGh, ...deps },
      { repo: REPO, issueNumber: 42, ...options },
    );
    assert(w.calls.length > 0, "the case must actually write something");
    for (const args of w.calls) {
      assert(
        !args.includes("--body") || args[1] === "comment",
        `a re-queue wrote a body outside a comment: ${args.join(" ")}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The workflow re-queue CLI (#1769 round 16, generalized in #1782). Every
// compensating exit in .github/workflows/sentry-triage-agent.yml runs on a stub
// that is open, verdict-labeled and off sentry:needs-triage — a strand no stage
// sees. This entry drives it back to selectable through the chokepoint,
// OPEN-safe, unless the stub went TERMINAL underneath the failing step.
// ---------------------------------------------------------------------------

/**
 * `after(args, state)` runs once each call has been applied, which is how the
 * racing-interleaving tests below land the archive leg's writes at a CHOSEN
 * point in the compensation's sequence rather than hoping for a timing.
 */
function makeClearFailureGh(
  initial,
  { failOn = () => null, after = () => {} } = {},
) {
  const state = {
    state: initial.state ?? "OPEN",
    labels: [...(initial.labels ?? [])],
    comments: [],
  };
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    const failure = failOn(args);
    if (failure) throw new Error(failure);
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({
        state: state.state,
        labels: state.labels.map((name) => ({ name })),
      });
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const addAt = args.indexOf("--add-label");
      if (addAt !== -1) {
        for (const name of args[addAt + 1].split(",")) {
          if (name && !state.labels.includes(name)) state.labels.push(name);
        }
      }
      const removeAt = args.indexOf("--remove-label");
      if (removeAt !== -1) {
        const remove = new Set(args[removeAt + 1].split(","));
        state.labels = state.labels.filter((name) => !remove.has(name));
      }
      return "";
    }
    if (args[0] === "issue" && args[1] === "comment") {
      state.comments.push(args[args.indexOf("--body") + 1]);
      return "";
    }
    if (args[0] === "issue" && args[1] === "reopen") {
      state.state = "OPEN";
      return "";
    }
    if (args[0] === "issue" && args[1] === "close") {
      state.state = "CLOSED";
      return "";
    }
    return "";
  };
  return {
    state,
    calls,
    runGh: async (args) => {
      const out = await runGh(args);
      after(args, state);
      return out;
    },
  };
}

/**
 * An `after` hook that lands the archive leg's settlement — the stub closes and
 * gains the terminal marker — at the WORST point for the compensation: right
 * after it restores `sentry:needs-triage`, so the archive's own post-settlement
 * verification (closed + terminal marker + a verdict) has already passed and
 * that run reported success. Everything the compensation does from here is
 * invisible to it. Landing the settlement any later would let a blind shed
 * survive the test, which is the mechanism under test.
 *
 * ONCE, because the archive settles a given stub once and a hook that re-fired
 * would quietly repair whatever the unwind got wrong. `settleQueueStub` consumes
 * the approval before this point, so it goes here too.
 */
function settleLikeArchiveOnRequeue() {
  let settled = false;
  return (args, state) => {
    if (settled || args[1] !== "edit" || !args.includes("--add-label")) return;
    settled = true;
    state.state = "CLOSED";
    state.labels = state.labels.filter(
      (name) => name !== "sentry:approved-archive",
    );
    if (!state.labels.includes("sentry:archived"))
      state.labels.push("sentry:archived");
  };
}

await test("runWorkflowRequeue restores needs-triage and sheds the verdict on an OPEN stub (#1769 round 16)", async () => {
  const gh = makeClearFailureGh({
    state: "OPEN",
    labels: ["sentry-triage", "sentry:verdict-upstream"],
  });
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assertEqual(result.requeued, true);
  assert(
    gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "sentry:needs-triage must be restored",
  );
  assert(
    !gh.state.labels.includes("sentry:verdict-upstream"),
    "the just-applied verdict label must be shed",
  );
  assertEqual(gh.state.state, "OPEN");
  // A bookkeeping note rides with the labels; it is NOT a regression fence.
  assertEqual(gh.state.comments.length, 1);
  assertEqual(
    gh.state.comments[0],
    buildRequeueNote(REQUEUE_REASON_BRIEF_CLEAR),
  );
  assert(
    !gh.state.comments[0].startsWith(REGRESSION_PREFIX),
    "the recovery note must never be a regression fence",
  );
  // An already-open stub is confirmed selectable, never spuriously reopened.
  assert(
    !gh.calls.some((a) => a[0] === "issue" && a[1] === "reopen"),
    "an already-open stub must not be reopened",
  );
});

await test("every stub read on the verification path ASKS for state, which the OPEN selector now requires", async () => {
  // `isSelectableForTriage` demands `state === "OPEN"`, and every reader
  // normalizes a missing field to `""`. So a `--json` list that forgets `state`
  // does not degrade — it makes the predicate return false for every stub, and
  // each re-queue ends in the loud stranded path though nothing is wrong. That
  // precondition was held by inspection; this holds it by test.
  const readers = [];
  const gh = makeClearFailureGh({
    state: "OPEN",
    labels: ["sentry-triage", "sentry:verdict-upstream"],
  });
  const runGh = async (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const jsonAt = args.indexOf("--json");
      readers.push(jsonAt === -1 ? "" : args[jsonAt + 1]);
    }
    return gh.runGh(args);
  };
  await runWorkflowRequeue({
    runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assert(readers.length > 0, "the re-queue must read the stub at all");
  for (const fields of readers) {
    assert(
      fields.split(",").includes("state"),
      `a stub read asked for "${fields}", which never yields a state the selector can accept`,
    );
  }
});

await test("parseRequeueArgs requires a numeric issue, a repo and a known reason", () => {
  const ok = parseRequeueArgs([
    "--issue",
    "1731",
    "--repo",
    "o/r",
    "--reason",
    REQUEUE_REASON_CLOSE_FAILURE,
  ]);
  assertEqual(ok.issueNumber, 1731);
  assertEqual(ok.repo, "o/r");
  assertEqual(ok.reason, REQUEUE_REASON_CLOSE_FAILURE);
  for (const bad of [
    [],
    ["--issue", "x", "--repo", "o/r", "--reason", REQUEUE_REASON_CLOSE_FAILURE],
    ["--issue", "1731", "--reason", REQUEUE_REASON_CLOSE_FAILURE],
    ["--repo", "o/r", "--reason", REQUEUE_REASON_CLOSE_FAILURE],
    ["--issue", "1731", "--repo", "o/r"],
    ["--issue", "1731", "--repo", "o/r", "--reason", "made-up"],
    ["--bogus"],
  ]) {
    let threw = false;
    try {
      parseRequeueArgs(bad);
    } catch {
      threw = true;
    }
    assert(threw, `parseRequeueArgs(${JSON.stringify(bad)}) must throw`);
  }
});

await test("the advisory note failing never skips selectability verification (#1769 round 17)", async () => {
  // The load-bearing label restoration succeeds; only the ADVISORY bookkeeping
  // note post fails. Under verify-end-state the note error must NOT escape before
  // ensureSelectableForTriage runs — the stub IS selectable, so this is success.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) =>
        args[1] === "comment" ? "HTTP 500 server error" : null,
    },
  );
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assertEqual(result.requeued, true);
  assert(
    gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "sentry:needs-triage must be restored even though the note failed",
  );
  assert(
    !gh.state.labels.includes("sentry:verdict-upstream"),
    "the verdict label must be shed",
  );
  // The note never landed, but selectability was still confirmed.
  assertEqual(gh.state.comments.length, 0);
});

await test("a label restoration that cannot be verified selectable is a HARD failure (#1769 round 17)", async () => {
  // The load-bearing add-label mutation keeps failing, so the stub never carries
  // sentry:needs-triage: ensureSelectableForTriage cannot confirm it selectable
  // and must THROW, never report success on an unverified strand.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) =>
        args[1] === "edit" && args.includes("--add-label")
          ? "HTTP 503 unavailable"
          : null,
    },
  );
  await assertRejects(
    runWorkflowRequeue({
      runGh: gh.runGh,
      repo: REPO,
      issueNumber: 1731,
      reason: REQUEUE_REASON_BRIEF_CLEAR,
    }),
    /not selectable for triage/,
  );
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "the stub never became selectable (the add-label kept failing)",
  );
});

// ---------------------------------------------------------------------------
// The TERMINAL guard (#1782, deferred from #1769 round 18). Every caller's
// premise is a snapshot: the step saw a failure, then decided to compensate.
// sentry-triage-archive.yml holds its own concurrency group, so the archive can
// complete in between — and a re-queue would then shed `sentry:archived`, shed
// the verdict labels and reopen a retry stub over an already-archived Sentry
// issue that consumed a human approval. A close whose mutation LANDED and only
// lost its response is the same shape from the other side.
// ---------------------------------------------------------------------------

await test("isTerminalStub reads CLOSED and sentry:archived, and nothing else", () => {
  assertEqual(isTerminalStub({ state: "CLOSED", labels: [] }), true);
  assertEqual(isTerminalStub({ state: "closed", labels: [] }), true);
  assertEqual(
    isTerminalStub({ state: "OPEN", labels: ["sentry:archived"] }),
    true,
  );
  assertEqual(
    isTerminalStub({
      state: "OPEN",
      labels: ["sentry:verdict-upstream", "sentry:approved-archive"],
    }),
    false,
  );
  assertEqual(isTerminalStub(), false);
});

await test("a stub ARCHIVED during the failing step is declined, not reopened (#1782)", async () => {
  // The archive leg completed while the brief clear was failing: the stub still
  // reads OPEN but carries the terminal `sentry:archived` marker. Re-queuing
  // would shed it — and nothing here can un-archive the Sentry issue.
  const gh = makeClearFailureGh({
    state: "OPEN",
    labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
  });
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assertEqual(result.requeued, false);
  assertEqual(result.reason, "revalidated-away");
  assert(
    gh.state.labels.includes("sentry:archived"),
    "the terminal archive marker must survive a declined re-queue",
  );
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "a terminal stub must NOT be put back in the triage queue",
  );
  assertEqual(gh.state.comments.length, 0);
  assert(
    !gh.calls.some((a) => a[1] === "edit" || a[1] === "reopen"),
    "a declined re-queue must perform no write at all",
  );
});

await test("a close whose response was lost leaves the stub CLOSED, not re-queued (#1782)", async () => {
  // The close-failure compensation's own worst case: the mutation landed and
  // only its response was lost. Re-queuing would manufacture the
  // closed-plus-needs-triage pairing no pipeline stage can see.
  const gh = makeClearFailureGh({
    state: "CLOSED",
    labels: ["sentry-triage", "sentry:verdict-upstream"],
  });
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_CLOSE_FAILURE,
  });
  assertEqual(result.requeued, false);
  assertEqual(gh.state.state, "CLOSED");
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "a settled stub must not be dragged back into the queue",
  );
});

await test("a TRANSIENT revalidation read failure retries and re-queues normally (#1782)", async () => {
  // The verdict step's first compensating exit runs BECAUSE a `gh` read on this
  // stub just failed, and the compensation's opening act is another read of the
  // same stub — correlated, usually transient. Unretried, that blip aborted the
  // compensation and left the stub OPEN + verdict-labeled + not needs-triage: a
  // shape no sweeper selects. One bounded retry is what closes that.
  let views = 0;
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) => {
        if (args[1] !== "view") return null;
        views += 1;
        return views === 1 ? "HTTP 502 bad gateway" : null;
      },
    },
  );
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_VERDICT_UNSETTLED,
  });
  assertEqual(result.requeued, true);
  assert(
    gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "a stub whose revalidation read recovered must land back in the queue",
  );
  assert(
    !gh.state.labels.includes("sentry:verdict-upstream"),
    "the stale verdict must still be shed on the retried path",
  );
});

await test("the terminal revalidation FAILS CLOSED: an unreadable stub is never re-queued (#1782)", async () => {
  // The chokepoint's invariant 7 — a failed read is not permission to proceed.
  // It propagates, the workflow reports the manual repair and the run goes red,
  // rather than mutating a stub whose terminal state could not be observed. The
  // retry above is BOUNDED, so a persistent outage still lands here.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    { failOn: (args) => (args[1] === "view" ? "HTTP 502 bad gateway" : null) },
  );
  await assertRejects(
    runWorkflowRequeue({
      runGh: gh.runGh,
      repo: REPO,
      issueNumber: 1731,
      reason: REQUEUE_REASON_BRIEF_CLEAR,
    }),
    /502/,
  );
  assert(
    !gh.calls.some((a) => a[1] === "edit" || a[1] === "reopen"),
    "no write may precede a terminal revalidation that could not be taken",
  );
  assertEqual(
    gh.calls.filter((a) => a[1] === "view").length,
    2,
    "the revalidating read retries exactly once before failing closed",
  );
});

// ---------------------------------------------------------------------------
// The archive-settlement race (#1929, ADR 0069). The revalidating read above is
// a snapshot, so the archive leg — its own per-issue concurrency group — can
// settle the stub between it and these writes. The interleaving each test names
// is the one it drives, by landing the archive's writes at a chosen call.
// ---------------------------------------------------------------------------

await test("an archive settling INSIDE the write window unwinds the re-queue instead of reporting success (#1929)", async () => {
  // The undetectable ordering: the archive's post-settlement verification has
  // already read the stub, so nothing on its side can see this compensation.
  // Its terminal marker is withheld from the shed, so the confirming read here
  // still sees it — and the re-queue undoes itself.
  const gh = makeClearFailureGh(
    {
      state: "OPEN",
      labels: ["sentry-triage", "sentry:verdict-upstream"],
    },
    {
      after: settleLikeArchiveOnRequeue(),
    },
  );
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assertEqual(result.requeued, false);
  assertEqual(result.reason, "settled-underneath");
  assertEqual(gh.state.state, "CLOSED");
  assert(
    gh.state.labels.includes("sentry:archived"),
    "the archive's terminal marker must survive a re-queue that raced it",
  );
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "an archived occurrence must never be left with a selectable retry stub",
  );
  assert(
    gh.state.labels.includes("sentry:verdict-upstream"),
    "the verdict must come back: the archive's own verification demands one",
  );
  assert(
    gh.state.comments.some((body) =>
      body.includes("the re-queue was undone rather than completed"),
    ),
    "the stub's written record must correct the re-queue note it now contradicts",
  );
});

await test("the sentinel marker is never removed blindly, which is what leaves it readable (#1929)", async () => {
  // A `--remove-label` that carries the marker reports nothing about whether it
  // was there, so after it no read can testify. Withholding it is the whole
  // mechanism, and it costs nothing: the revalidation declines outright on a
  // stub that already carries it, so the only marker this shed ever meets is
  // one that appeared mid-window.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      after: settleLikeArchiveOnRequeue(),
    },
  );
  await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_VERDICT_UNSETTLED,
  });
  for (const args of gh.calls) {
    const at = args.indexOf("--remove-label");
    if (at === -1) continue;
    assert(
      !args[at + 1].split(",").includes("sentry:archived"),
      `a re-queue with a sentinel must not shed it: ${args[at + 1]}`,
    );
  }
  // …and everything else the re-queue owes is still shed.
  const shed = buildRequeueShedLabelArgs(1731, REPO, {
    except: ["sentry:archived"],
  });
  const names = shed[shed.indexOf("--remove-label") + 1].split(",");
  assert(!names.includes("sentry:archived"), "the sentinel must be withheld");
  for (const name of [
    "sentry:verdict-upstream",
    "sentry:projected",
    "sentry:approved-archive",
  ]) {
    assert(names.includes(name), `${name} must still be shed`);
  }
});

await test("the unwind restores the shed markers but NEVER the spent approval (#1929)", async () => {
  // The archive consumes `sentry:approved-archive` as its compare-and-swap, so
  // by the time the sentinel fires that approval is spent. Re-adding it would
  // hand a later workflow_dispatch an approval no human gave — and the add
  // itself re-fires the archive workflow's `issues: labeled` trigger.
  const gh = makeClearFailureGh(
    {
      state: "OPEN",
      labels: [
        "sentry-triage",
        "sentry:verdict-upstream",
        "sentry:projected",
        "sentry:approved-archive",
      ],
    },
    {
      after: settleLikeArchiveOnRequeue(),
    },
  );
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_CLOSE_FAILURE,
  });
  assertEqual(result.reason, "settled-underneath");
  assert(
    gh.state.labels.includes("sentry:verdict-upstream") &&
      gh.state.labels.includes("sentry:projected"),
    "the previous round's machine records must be restored",
  );
  assert(
    !gh.state.labels.includes("sentry:approved-archive"),
    "a spent human approval must never be handed back",
  );
});

await test("an unwind that cannot be confirmed is a HARD failure, never a quiet decline (#1929)", async () => {
  // Same discipline as the end-state verification it replaces: the stub is
  // then neither re-queued nor demonstrably settled, so a human has to look.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) => (args[1] === "close" ? "HTTP 503 unavailable" : null),
      after: settleLikeArchiveOnRequeue(),
    },
  );
  await assertRejects(
    runWorkflowRequeue({
      runGh: gh.runGh,
      repo: REPO,
      issueNumber: 1731,
      reason: REQUEUE_REASON_BRIEF_CLEAR,
    }),
    /settled underneath a re-queue and the re-queue could not be unwound/,
  );
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "the failed unwind must still have taken selectability away first",
  );
});

await test("a settlement first visible to the SHED RETRY's read still unwinds (#1929)", async () => {
  // The end-state verification can take a second read: when the first shed
  // failed, the retry sheds again and re-reads. A settlement landing between
  // those two reads is invisible to the first one — and it is precisely the
  // failed shed that lets it happen, because the verdict label it left behind is
  // what makes the archive's own verification hold. The retry then removes that
  // verdict. Every read that can change `verified` gets the sentinel decision.
  let views = 0;
  let sheds = 0;
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) => {
        if (args[1] !== "edit" || !args.includes("--remove-label")) return null;
        sheds += 1;
        return sheds === 1 ? "HTTP 503 unavailable" : null;
      },
      after: (args, state) => {
        if (args[1] !== "view") return;
        views += 1;
        // View 1 revalidates, view 2 is the end-state confirmation. Settle
        // immediately after that one, so only the retry's read can see it.
        if (views !== 2) return;
        state.state = "CLOSED";
        if (!state.labels.includes("sentry:archived"))
          state.labels.push("sentry:archived");
      },
    },
  );
  const result = await runWorkflowRequeue({
    runGh: gh.runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_VERDICT_UNSETTLED,
  });
  assertEqual(result.reason, "settled-underneath");
  assertEqual(gh.state.state, "CLOSED");
  assert(
    !gh.state.labels.includes(NEEDS_TRIAGE_LABEL),
    "a stub the archive settled must not keep a re-queue's needs-triage",
  );
  assert(
    gh.state.labels.includes("sentry:verdict-upstream"),
    "the verdict the retry shed must come back",
  );
});

await test("an unwind whose marker restoration never lands is a HARD failure (#1929)", async () => {
  // Dropping `sentry:needs-triage` and closing while the verdict re-add reported
  // a real failure leaves a stub the archive's own verification rejects — the
  // outcome this unwind exists to prevent. Judging only the cheap three would
  // have called that a success.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    {
      failOn: (args) =>
        args[1] === "edit" &&
        args.includes("--add-label") &&
        args[args.indexOf("--add-label") + 1].includes("verdict")
          ? "HTTP 503 unavailable"
          : null,
      after: settleLikeArchiveOnRequeue(),
    },
  );
  await assertRejects(
    runWorkflowRequeue({
      runGh: gh.runGh,
      repo: REPO,
      issueNumber: 1731,
      reason: REQUEUE_REASON_BRIEF_CLEAR,
    }),
    /could not be unwound/,
  );
});

await test("an unwind that cannot leave a VERDICT on the stub fails rather than declining (#1929)", async () => {
  // The unwind confirms the shape the settling run demands, and that run needs a
  // `sentry:verdict-*` label. A premise carrying none has nothing to restore, so
  // the unwind would otherwise confirm a closed, archived, verdict-less stub the
  // archive's verification rejects. Only a human can resolve that, so it is loud.
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage"] },
    { after: settleLikeArchiveOnRequeue() },
  );
  await assertRejects(
    runWorkflowRequeue({
      runGh: gh.runGh,
      repo: REPO,
      issueNumber: 1731,
      reason: REQUEUE_REASON_VERDICT_UNSETTLED,
    }),
    /no verdict label/,
  );
});

await test("the unwind's write order leaves every PREFIX of it unselectable (#1929)", async () => {
  // An unwind can die half-way, so its order is a correctness property rather
  // than a style one: `sentry:needs-triage` goes first because it is the only
  // thing that lets another run act on the stub, and the close goes last for the
  // same reason the re-queue puts its state change last. Asserted on the plan,
  // not inferred from a fake's call log, so a reordering reds here directly.
  const corrections = buildUnwindCorrections({
    repo: REPO,
    issueNumber: 1731,
    sentinelLabel: "sentry:archived",
    premise: {
      state: "OPEN",
      labels: ["sentry-triage", "sentry:verdict-upstream", "sentry:archived"],
    },
  });
  assertDeepEqual(
    corrections.map((c) => c.what),
    ["drop-needs-triage", "restore-sentry:verdict-upstream", "close"],
  );
  assertDeepEqual(corrections[0].args.slice(-2), [
    "--remove-label",
    NEEDS_TRIAGE_LABEL,
  ]);
  assertEqual(corrections.at(-1).args[1], "close");
  // The sentinel is never re-added: the unwind never removed it.
  assert(
    !corrections.some((c) => c.args.join(" ").includes("sentry:archived")),
    "the sentinel is left in place, so nothing re-adds it",
  );
});

await test("the archive's own verification covers the OTHER ordering (#1929)", async () => {
  // The two runs cover the two orderings between them, and this is the half
  // that already existed: a compensation whose writes land BEFORE the archive's
  // post-settlement read is caught there, because that read demands closed +
  // the terminal marker + a verdict label and the compensation has removed the
  // verdict and reopened the stub. Pinned here so the claim the sentinel's
  // scope rests on cannot rot in the other file.
  const requeued = {
    state: "OPEN",
    labels: ["sentry-triage", "sentry:needs-triage", "sentry:archived"],
    body: "",
  };
  assertEqual(settlementHeld(requeued), false);
  assertEqual(
    settlementHeld({
      state: "CLOSED",
      labels: ["sentry-triage", "sentry:archived"],
      body: "",
    }),
    false,
  );
  assertEqual(
    settlementHeld({
      state: "CLOSED",
      labels: ["sentry-triage", "sentry:archived", "sentry:verdict-upstream"],
      body: "",
    }),
    true,
  );
});

await test("a malformed sentinel declaration refuses before any I/O (#1929)", async () => {
  // Two ways to declare one wrongly, both fatal here rather than later. Under
  // the abort policy the sentinel is a guarantee nothing ever reads back. And a
  // sentinel with no `declineNote` would throw at the DETECTION site — after the
  // add, the shed and the reopen, before any correction — leaving the open,
  // queued, still-marked stub the whole mechanism exists to prevent.
  const cases = [
    [
      { sentinel: { label: "sentry:archived", declineNote: () => "s" } },
      /needs verify-end-state/,
      false,
    ],
    [
      { sentinel: { label: "sentry:archived" } },
      /must supply declineNote/,
      true,
    ],
    [{ sentinel: { declineNote: () => "s" } }, /non-empty string/, true],
  ];
  for (const [extra, pattern, verify] of cases) {
    const writer = makeWriter();
    await assertRejects(
      requeueQueueStub(
        { writeGh: writer.writeGh, readStub: async () => ({}) },
        {
          repo: REPO,
          issueNumber: 1731,
          cause: REQUEUE_CAUSE_BOOKKEEPING,
          note: "n",
          onFailure: verify ? REQUEUE_ON_FAILURE_VERIFY_END_STATE : undefined,
          revalidate: {
            check: () => true,
            declineNote: () => "d",
            ...extra,
          },
        },
      ),
      pattern,
    );
    assertEqual(writer.calls.length, 0);
  }
});

await test("a transient read failure never turns a converged unwind into a manual-repair alarm (#1929)", async () => {
  // The unwind's confirming read gets the same bounded retry the revalidating
  // read has, for the same reason: a compensation often runs BECAUSE a `gh` read
  // just failed, so this read is correlated with a usually-transient failure and
  // one attempt would raise `repair by hand` over a correctly settled stub.
  let confirmations = 0;
  const gh = makeClearFailureGh(
    { state: "OPEN", labels: ["sentry-triage", "sentry:verdict-upstream"] },
    { after: settleLikeArchiveOnRequeue() },
  );
  // Fail exactly once, on the first read after the unwind's close — which is
  // the confirming read and nothing else.
  let closed = false;
  const runGh = async (args) => {
    if (args[1] === "view" && closed && confirmations === 0) {
      confirmations += 1;
      throw new Error("HTTP 502 bad gateway");
    }
    const out = await gh.runGh(args);
    if (args[1] === "close") closed = true;
    return out;
  };
  const result = await runWorkflowRequeue({
    runGh,
    repo: REPO,
    issueNumber: 1731,
    reason: REQUEUE_REASON_BRIEF_CLEAR,
  });
  assertEqual(confirmations, 1);
  assertEqual(result.reason, "settled-underneath");
  assertEqual(gh.state.state, "CLOSED");
});

await test("every note this chokepoint posts reads as intent, never as a completed write", () => {
  // Ordering makes this a correctness question, not a style one. The note is
  // posted AFTER the label edit — whose error is CAUGHT rather than thrown, so
  // the sequence continues — and BEFORE the end-state verification. A note
  // attesting that markers "have been shed" and `sentry:needs-triage` was
  // "restored" can therefore sit on a stub the verifier then reports as still
  // carrying stale markers, or as stranded. Operator-facing output that asserts
  // a write which did not land is a wrong attestation, so the wording has to be
  // true under every outcome — including the one where every write failed.
  //
  // The stranded-recovery notes are the same shape from ingest's side (its
  // reopen follows the note), so all of them are pinned here rather than only
  // the one that was flagged. There is one per stranded SHAPE (#1817), and the
  // open-verdict note is posted while the label writes it describes can still
  // fail, exactly like the closed one.
  const completedClaims = [
    "have been shed",
    "has been shed",
    "were shed",
    "have been restored",
    "has been restored",
    "restored, so",
  ];
  const notes = [
    ...REQUEUE_REASONS.map((reason) => [reason, buildRequeueNote(reason)]),
    ...[STRAND_SHAPE_CLOSED_NEEDS_TRIAGE, STRAND_SHAPE_OPEN_VERDICT].map(
      (shape) => [
        `stranded-recovery/${shape}`,
        buildStrandedRecoveryComment(shape),
      ],
    ),
    // The default argument is the closed pairing, and a caller that names no
    // shape must still get a real note rather than a throw.
    ["stranded-recovery/default", buildStrandedRecoveryComment()],
  ];
  for (const [label, note] of notes) {
    for (const claim of completedClaims) {
      assert(
        !note.includes(claim),
        `the ${label} note claims a completed write ("${claim}"); phrase it as intent`,
      );
    }
    assert(
      /\bshedding\b/.test(note),
      `the ${label} note must describe the shed as in progress`,
    );
  }
  // …and the re-queue notes must say what they are putting back, so intent
  // wording does not quietly become vagueness.
  for (const reason of REQUEUE_REASONS) {
    assert(
      /\bis restoring\b/.test(buildRequeueNote(reason)),
      `the ${reason} note must name the needs-triage restoration as intent`,
    );
  }
});

await test("every re-queue reason renders a distinct bookkeeping note; an unknown one refuses", () => {
  // The reason is the ONLY thing a compensating exit declares, so an unnamed one
  // must throw BEFORE any I/O rather than inherit some default shed policy.
  const notes = REQUEUE_REASONS.map((reason) => buildRequeueNote(reason));
  assertEqual(new Set(notes).size, REQUEUE_REASONS.length);
  for (const note of notes) {
    assert(
      !note.startsWith(REGRESSION_PREFIX),
      "a bookkeeping note must never be a regression fence",
    );
  }
  for (const bad of [undefined, null, "", "sentry-evidence", "close_failure"]) {
    let threw = false;
    try {
      buildRequeueNote(bad);
    } catch {
      threw = true;
    }
    assert(threw, `buildRequeueNote(${JSON.stringify(bad)}) must throw`);
  }
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}
