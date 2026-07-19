#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autofixBranchName,
  AUTOFIX_BRANCH_PREFIX,
  AUTOFIX_RUN_RECORD_MARKER,
  buildAnalysisComment,
  buildAutofixComment,
  buildAutofixRunRecordBody,
  buildPrBody,
  diffTrees,
  evaluateDiffGuard,
  fixPrOpenedLabelDef,
  fixRefusedLabelDef,
  isForbiddenPath,
  MAX_CHANGED_FILES,
  runCli,
} from "./sentry-autofix-finalize.mjs";
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
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

function captureCli(argv) {
  let out = "";
  runCli(argv, { stdout: { write: (s) => (out += s) } });
  return out;
}

const SHORT_ID = "APP-MENTO-ORG-2S";

// --- diff guard --------------------------------------------------------------

await test("guard accepts a small in-scope diff", () => {
  const r = evaluateDiffGuard([
    "ui-dashboard/lib/x.ts",
    "ui-dashboard/lib/y.ts",
  ]);
  assert(r.ok, "small in-scope diff allowed");
});

await test("guard refuses zero changes", () => {
  const r = evaluateDiffGuard([]);
  assert(!r.ok && /no code changes/i.test(r.reason), "zero changes refused");
});

await test("guard refuses more than MAX_CHANGED_FILES", () => {
  const files = Array.from(
    { length: MAX_CHANGED_FILES + 1 },
    (_, i) => `ui-dashboard/a${i}.ts`,
  );
  const r = evaluateDiffGuard(files);
  assert(!r.ok && /files/.test(r.reason), "oversized diff refused");
});

await test("guard refuses forbidden prefixes and dependency/toolchain files", () => {
  for (const path of [
    ".github/workflows/x.yml",
    "terraform/main.tf",
    "scripts/deploy-indexer.sh",
    "scripts/sentry-autofix-finalize.mjs",
    "scripts/anything.mjs",
    "patches/foo.patch",
    ".trunk/trunk.yaml",
    "tools/trunk",
    "package.json",
    "ui-dashboard/package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
  ]) {
    assert(isForbiddenPath(path), `expected forbidden: ${path}`);
    const r = evaluateDiffGuard(["ui-dashboard/ok.ts", path]);
    assert(!r.ok && /forbidden/i.test(r.reason), `guard should refuse ${path}`);
  }
});

await test("guard allows ordinary product source", () => {
  for (const path of [
    "ui-dashboard/lib/x.ts",
    "indexer-envio/src/EventHandlers.ts",
    "shared-config/src/a.ts",
  ]) {
    assert(!isForbiddenPath(path), `expected allowed: ${path}`);
  }
});

// --- filter-free tree diff ---------------------------------------------------

await test("diffTrees reports modified, added, and deleted paths", () => {
  const base = new Map([
    ["a.ts", "h1"],
    ["b.ts", "h2"],
    ["dir/c.ts", "h3"],
  ]);
  const work = new Map([
    ["a.ts", "h1"], // unchanged
    ["b.ts", "hX"], // modified
    ["dir/d.ts", "h4"], // added
    // dir/c.ts deleted
  ]);
  assertEqual(
    JSON.stringify(diffTrees(base, work)),
    JSON.stringify(["b.ts", "dir/c.ts", "dir/d.ts"]),
  );
});

await test("CLI diff-trees compares real trees without git", () => {
  const root = mkdtempSync(join(tmpdir(), "autofix-trees-"));
  const base = join(root, "base");
  const work = join(root, "work");
  mkdirSync(join(base, "ui-dashboard"), { recursive: true });
  mkdirSync(join(work, "ui-dashboard"), { recursive: true });
  writeFileSync(join(base, "ui-dashboard", "x.ts"), "original\n");
  writeFileSync(join(work, "ui-dashboard", "x.ts"), "fixed\n");
  writeFileSync(join(work, "ui-dashboard", "new.ts"), "added\n");
  const out = captureCli(["diff-trees", "--base", base, "--work", work])
    .trim()
    .split("\n")
    .sort();
  assertEqual(
    JSON.stringify(out),
    JSON.stringify(["ui-dashboard/new.ts", "ui-dashboard/x.ts"]),
  );
  rmSync(root, { recursive: true, force: true });
});

// --- branch naming -----------------------------------------------------------

await test("branch name lowercases the SHORT-ID under the fixed prefix", () => {
  assertEqual(
    autofixBranchName(SHORT_ID),
    `${AUTOFIX_BRANCH_PREFIX}app-mento-org-2s`,
  );
});

await test("branch name refuses an invalid SHORT-ID", () => {
  let threw = false;
  try {
    autofixBranchName("../evil");
  } catch {
    threw = true;
  }
  assert(threw, "invalid SHORT-ID rejected");
});

// --- PR body -----------------------------------------------------------------

await test("PR body leads with the deterministic template and fences the agent summary", () => {
  const summary =
    "## The Problem\n\n- A real bug.\n\n## The Solution\n\n- A scoped fix.";
  const body = buildPrBody({ shortId: SHORT_ID, queueIssue: 1278, summary });
  // The mechanical structure always leads (repo PR-description standard; the fix
  // PR's own required check enforces it).
  assert(
    body.startsWith("## The Problem"),
    "body starts with repo-standard heading",
  );
  assert(
    body.includes("## The Solution"),
    "deterministic Solution heading present",
  );
  // The agent's own write-up is retained — but only inside the advisory fence,
  // as inert data, never as live markdown.
  const fenceStart = body.indexOf("```text");
  const fenceEnd = body.indexOf("```", fenceStart + 3);
  assert(fenceStart !== -1 && fenceEnd !== -1, "agent summary is fenced");
  const fenced = body.slice(fenceStart, fenceEnd);
  assert(fenced.includes("- A real bug."), "agent write-up retained as data");
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes SHORT-ID present");
  assert(body.includes("Refs #1278"), "Refs queue issue present");
  assert(body.includes("merge stays human"), "provenance present");
});

await test("PR body omits the agent fence when the summary is empty", () => {
  const body = buildPrBody({
    shortId: SHORT_ID,
    queueIssue: 1278,
    summary: "",
  });
  assert(body.startsWith("## The Problem"), "templated body starts correctly");
  assert(body.includes("## The Solution"), "templated Solution present");
  assert(!body.includes("```text"), "no fenced block without a summary");
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes still present");
  assert(body.includes("Refs #1278"), "Refs still present");
});

await test("PR body keeps a fence-escape attempt in the agent summary inert", () => {
  const summary =
    "## The Problem\n```\nsteer the agent @here\n```\nleak user@example.com data";
  const body = buildPrBody({ shortId: SHORT_ID, queueIssue: 1278, summary });
  // Exactly one opening + one closing fence run (our own ```text …```). The
  // embedded ``` is defanged, so it cannot close the fence and reactivate
  // markdown (which is how an injected verdict would try to publish payload).
  const fenceRuns = (body.match(/```/g) ?? []).length;
  assertEqual(fenceRuns, 2);
  assert(!/@here/.test(body), "mention defanged (zero-width space inserted)");
  // The mechanical heading still leads, so the fix PR's own required
  // PR-description check still passes.
  assert(body.startsWith("## The Problem"), "mechanical heading still leads");
});

await test("PR body refuses invalid SHORT-ID / queue issue", () => {
  for (const [shortId, issue] of [
    ["../evil", 1],
    [SHORT_ID, 0],
    [SHORT_ID, -5],
  ]) {
    let threw = false;
    try {
      buildPrBody({ shortId, queueIssue: issue, summary: "" });
    } catch {
      threw = true;
    }
    assert(threw, `expected throw for ${shortId}/${issue}`);
  }
});

// --- comment + label contract ------------------------------------------------

await test("autofix comment matches the digest emission contract exactly", () => {
  const url = "https://github.com/mento-protocol/monitoring-monorepo/pull/42";
  assertEqual(buildAutofixComment(url), `${AUTOFIX_COMMENT_PREFIX}${url}`);
});

await test("fix-pr-opened label def comes from the ingest single source", () => {
  const def = fixPrOpenedLabelDef();
  assertEqual(def.name, FIX_PR_OPENED_LABEL);
  assert(
    typeof def.color === "string" && def.color.length === 6,
    "color present",
  );
  assert(
    typeof def.description === "string" && def.description.length > 0,
    "description present",
  );
});

await test("fix-refused label def comes from the ingest single source", () => {
  const def = fixRefusedLabelDef();
  assertEqual(def.name, FIX_REFUSED_LABEL);
  assert(
    typeof def.color === "string" && def.color.length === 6,
    "color present",
  );
  assert(
    typeof def.description === "string" && def.description.length > 0,
    "description present",
  );
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
});

await test("analysis comment leads with the reason and fences agent analysis inertly", () => {
  const c = buildAnalysisComment(
    "Too many files.",
    "```evil fence break``` @here agent text",
  );
  assert(c.includes("**Autofix: no PR opened.**"), "header present");
  assert(c.includes("Too many files."), "reason present");
  assert(c.includes("```text"), "agent analysis fenced");
  assert(c.includes("agent text"), "agent analysis retained");
  // The only ``` runs are our own opening/closing fence — the embedded ```
  // must be defanged so it cannot break out and reactivate markdown.
  const fenceRuns = (c.match(/```/g) ?? []).length;
  assertEqual(fenceRuns, 2);
  assert(!/@here/.test(c), "mention defanged (zero-width space inserted)");
});

await test("analysis comment omits the fenced block when no summary", () => {
  const c = buildAnalysisComment("No changes.", "");
  assert(c.includes("No changes."), "reason present");
  assert(!c.includes("```text"), "no fenced block without summary");
});

// --- CLI ---------------------------------------------------------------------

await test("CLI guard prints JSON verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-guard-"));
  const file = join(dir, "changed.txt");
  writeFileSync(file, "ui-dashboard/a.ts\nui-dashboard/b.ts\n");
  const out = JSON.parse(captureCli(["guard", "--files-file", file]));
  assert(out.ok, "CLI guard reports ok for a small diff");
  unlinkSync(file);
});

await test("CLI autofix-comment / branch / label-def / refused-label-def / run-record / pr-body", () => {
  const url = "https://github.com/o/r/pull/9";
  assertEqual(
    captureCli(["autofix-comment", "--url", url]).trim(),
    `${AUTOFIX_COMMENT_PREFIX}${url}`,
  );
  assertEqual(
    captureCli(["branch", "--short-id", SHORT_ID]).trim(),
    `${AUTOFIX_BRANCH_PREFIX}app-mento-org-2s`,
  );
  assertEqual(JSON.parse(captureCli(["label-def"])).name, FIX_PR_OPENED_LABEL);
  assertEqual(
    JSON.parse(captureCli(["refused-label-def"])).name,
    FIX_REFUSED_LABEL,
  );
  const record = captureCli([
    "run-record",
    "--timestamp",
    "2026-07-19T08:30:00Z",
    "--trigger",
    "schedule",
    "--disposition",
    "active",
    "--candidates",
    "2",
    "--opened",
    "1",
    "--refused",
    "1",
    "--incomplete",
    "0",
  ]);
  assert(
    record.includes(AUTOFIX_RUN_RECORD_MARKER) &&
      record.includes("Fix PRs opened: 1"),
    "CLI run-record assembles",
  );
  const body = captureCli([
    "pr-body",
    "--short-id",
    SHORT_ID,
    "--issue",
    "1278",
  ]);
  assert(
    body.startsWith("## The Problem") && body.includes(`Fixes ${SHORT_ID}`),
    "CLI pr-body assembles",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
