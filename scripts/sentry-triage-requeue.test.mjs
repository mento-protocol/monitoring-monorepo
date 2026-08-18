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
 *   - admissibility is asked by recency, never by presence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  // Recursive: scripts/ is a tree now (ADR 0064). A flat readdir silently stops
  // seeing every module the reorganization relocates, so "one call site" would
  // become "one call site among the files that happen to still be flat".
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const offenders = [];
  let scanned = 0;
  for (const file of readdirSync(scriptsDir, { recursive: true })) {
    if (!file.endsWith(".mjs")) continue;
    if (file.endsWith(".test.mjs")) continue; // tests pin the text, by design
    // Path-exact, not basename: a recursive walk yields `<subdir>/<name>`, so
    // excluding by basename would skip a future `scripts/<subdir>/
    // sentry-triage-requeue.mjs` — the second-owner case this test exists to
    // catch. The flat entry is its own relative path, so this still matches it.
    if (file === "sentry-triage-requeue.mjs") continue;
    scanned += 1;
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
  // An enumeration that finds almost nothing PASSES, silently, having checked
  // almost nothing — the failure mode a sparse view creates (Codex 3761902959:
  // 25 of 92 modules were visible inside the gate's per-suite snapshot). A
  // floor makes that loud instead. It is deliberately well under the real count
  // so ordinary additions and deletions never touch it.
  assert(
    scanned >= 60,
    `only ${scanned} non-test scripts/*.mjs were scanned — this check is running against a partial view of scripts/, so its result means nothing`,
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

function makeClearFailureGh(initial, { failOn = () => null } = {}) {
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
    return "";
  };
  return { state, calls, runGh };
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
