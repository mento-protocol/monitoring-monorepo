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
  buildAnalysisComment,
  buildAutofixComment,
  buildPrBody,
  diffTrees,
  evaluateDiffGuard,
  fixPrOpenedLabelDef,
  isForbiddenPath,
  isUsableSummary,
  MAX_CHANGED_FILES,
  runCli,
} from "./sentry-autofix-finalize.mjs";
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import { FIX_PR_OPENED_LABEL } from "./sentry-triage-ingest.mjs";

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

await test("PR body uses the agent summary and appends Fixes/Refs + provenance", () => {
  const summary =
    "## The Problem\n\n- A real bug.\n\n## The Solution\n\n- A scoped fix.";
  const body = buildPrBody({ shortId: SHORT_ID, queueIssue: 1278, summary });
  assert(
    body.startsWith("## The Problem"),
    "body starts with repo-standard heading",
  );
  assert(body.includes("- A real bug."), "agent Problem retained");
  assert(body.includes("- A scoped fix."), "agent Solution retained");
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes SHORT-ID present");
  assert(body.includes("Refs #1278"), "Refs queue issue present");
  assert(body.includes("merge stays human"), "provenance present");
});

await test("PR body falls back to a templated body when the summary is junk", () => {
  const body = buildPrBody({
    shortId: SHORT_ID,
    queueIssue: 1278,
    summary: "garbage no headings",
  });
  assert(body.startsWith("## The Problem"), "templated body starts correctly");
  assert(body.includes("## The Solution"), "templated Solution present");
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes still present in fallback");
  assert(body.includes("Refs #1278"), "Refs still present in fallback");
});

await test("isUsableSummary requires both headings plus content", () => {
  assert(!isUsableSummary(""), "empty rejected");
  assert(
    !isUsableSummary("## The Problem\n## The Solution"),
    "headings-only rejected",
  );
  assert(
    !isUsableSummary("## The Problem\n\n- only problem"),
    "missing solution rejected",
  );
  assert(
    isUsableSummary("## The Problem\n\n- x\n\n## The Solution\n\n- y"),
    "full summary accepted",
  );
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

await test("CLI autofix-comment / branch / label-def / pr-body", () => {
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
