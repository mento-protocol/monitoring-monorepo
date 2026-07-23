#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
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
  buildStaleVerdictCloseComment,
  diffTrees,
  evaluateDiffGuard,
  fixPrOpenedLabelDef,
  fixRefusedLabelDef,
  isForbiddenPath,
  markerWriteStillValid,
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

await test("guard refuses nested scripts dirs and CI-executed config surfaces", () => {
  // CI workflows execute package-local scripts and configs from the PR head
  // (some with secrets in env, e.g. the Lighthouse deploy-protection bypass) —
  // an autofix diff must never be able to place code on those surfaces.
  for (const path of [
    "ui-dashboard/scripts/measure-inp.mjs",
    "indexer-envio/scripts/helper.mjs",
    "ui-dashboard/vitest.config.ts",
    "ui-dashboard/next.config.mjs",
    "ui-dashboard/playwright.config.ts",
    "ui-dashboard/.lighthouserc.js",
    "aegis/config.yaml",
    "aegis/bin/deploy.sh",
    "ui-dashboard/vercel.json",
    "turbo.json",
    "indexer-envio/Dockerfile",
    // Terraform at ANY depth: the non-root stacks' PR plan jobs execute
    // `terraform plan` on the PR head, and HCL runs programs at plan time
    // (data "external") with a state-reading SA + checkout token in the job.
    "alerts/rules/oracle.tf",
    "alerts/infra/main.tf",
    "governance-watchdog/infra/storage.tf",
    "aegis/terraform/dashboard.tf",
    "anywhere/nested/module.hcl",
    "terraform/terraform.tfvars.example",
    // Terraform's JSON syntax loads identically to HCL — same plan-time
    // execution surface, same prohibition.
    "alerts/infra/main.tf.json",
    "aegis/terraform/values.tfvars.json",
  ]) {
    assert(isForbiddenPath(path), `expected forbidden: ${path}`);
  }
  // Ordinary product source stays allowed, including files that merely have
  // "scripts" in their NAME (only a path SEGMENT is a scripts dir).
  for (const path of [
    "ui-dashboard/lib/scripts-helper.ts",
    "indexer-envio/src/EventHandlers.ts",
    "ui-dashboard/app/pool/page.tsx",
  ]) {
    assert(!isForbiddenPath(path), `expected allowed: ${path}`);
  }
});

await test("guard refuses a diff whose file content is credential-shaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-credscan-"));
  mkdirSync(join(dir, "ui-dashboard"), { recursive: true });
  writeFileSync(
    join(dir, "ui-dashboard", "leak.ts"),
    'const t = "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz012345";\n',
  );
  writeFileSync(
    join(dir, "ui-dashboard", "clean.ts"),
    "export const ok = 1;\n",
  );
  const r = evaluateDiffGuard(
    ["ui-dashboard/leak.ts", "ui-dashboard/clean.ts"],
    { workRoot: dir },
  );
  assert(
    !r.ok && /credential-shaped/i.test(r.reason),
    "credential-shaped content refused",
  );
  // The refusal reason names the file but never the matched value.
  assert(!r.reason.includes("ghs_AbCd"), "reason must not echo the token");
  assert(
    evaluateDiffGuard(["ui-dashboard/clean.ts"], { workRoot: dir }).ok,
    "clean file passes the scan",
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("guard refuses a changed path the agent turned into a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-symlink-"));
  mkdirSync(join(dir, "ui-dashboard"), { recursive: true });
  writeFileSync(join(dir, "ui-dashboard", "ok.ts"), "real\n");
  // The agent replaced an allowed source path with a symlink to a secret-bearing
  // path; the target need not exist for lstat to report a symlink.
  symlinkSync("/proc/self/environ", join(dir, "ui-dashboard", "evil.ts"));
  const r = evaluateDiffGuard(["ui-dashboard/ok.ts", "ui-dashboard/evil.ts"], {
    workRoot: dir,
  });
  assert(!r.ok && /symlink/i.test(r.reason), "symlinked changed path refused");
  // A genuine deletion (path absent in the work tree) is not a symlink.
  assert(
    evaluateDiffGuard(["ui-dashboard/deleted.ts"], { workRoot: dir }).ok,
    "genuine deletion is not treated as a symlink",
  );
  // Back-compat: without workRoot the symlink check is skipped.
  assert(
    evaluateDiffGuard(["ui-dashboard/ok.ts"]).ok,
    "no workRoot -> no symlink check",
  );
  rmSync(dir, { recursive: true, force: true });
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

await test("PR body is fully deterministic (no agent free-text accepted or published)", () => {
  // buildPrBody takes ONLY shortId + queueIssue — there is no summary param, so
  // there is no channel for agent-authored text to reach the public PR body.
  const body = buildPrBody({ shortId: SHORT_ID, queueIssue: 1278 });
  assert(
    body.startsWith("## The Problem"),
    "body starts with repo-standard heading (required check)",
  );
  assert(body.includes("## The Solution"), "deterministic Solution heading");
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes SHORT-ID present");
  assert(body.includes("Refs #1278"), "Refs queue issue present");
  assert(body.includes("merge stays human"), "provenance present");
  // No fenced agent block, ever — the diff is the authoritative artifact.
  assert(!body.includes("```"), "no fenced block in the body");
  assert(
    body.toLowerCase().includes("untrusted-input"),
    "body notes the agent notes are intentionally omitted",
  );
});

await test("analysis comment is deterministic — no summary channel to smuggle text through", () => {
  // buildAnalysisComment takes ONLY the machine-generated guard reason. Even if
  // a caller tried to pass extra args, the signature ignores them.
  const reason = "The autofix diff touches 5 files (limit 3).";
  const c = buildAnalysisComment(
    reason,
    "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz012345 leak attempt",
  );
  assert(c.includes(reason), "deterministic reason rendered");
  assert(
    !c.includes("ghs_AbCd"),
    "extra arg is not rendered (no summary param)",
  );
  assert(!c.includes("```"), "no fenced agent block");
  assert(
    c.toLowerCase().includes("omitted by policy"),
    "explains agent notes are omitted",
  );
});

await test("neither builder can be tricked by a whitespace-fragmented token", () => {
  // The P1 that killed pattern-based redaction: `ghs_ABC DEF GHI` slips every
  // shape/length check. Omission is the defense — no agent text is rendered at
  // all, so a fragmented (or any) token simply never appears.
  const fragmented = "ghs_AAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE FFFFFFFF";
  const body = buildPrBody({ shortId: SHORT_ID, queueIssue: 1278 });
  const comment = buildAnalysisComment("No changes.", fragmented);
  assert(!body.includes("ghs_AAAA"), "fragment absent from PR body");
  assert(
    !comment.includes("ghs_AAAA"),
    "fragment absent from analysis comment",
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
      buildPrBody({ shortId, queueIssue: issue });
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

await test("analysis comment leads with the deterministic reason only", () => {
  const c = buildAnalysisComment("Too many files.");
  assert(c.includes("**Autofix: no PR opened.**"), "header present");
  assert(c.includes("Too many files."), "reason present");
  assert(!c.includes("```"), "no fenced agent block");
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

await test("markerWriteStillValid tracks the code-fix verdict presence", () => {
  assert(
    markerWriteStillValid(["sentry:verdict-code-fix", "sentry:projected"]),
    "verdict present → valid",
  );
  assert(
    !markerWriteStillValid(["sentry:projected", "sentry:needs-triage"]),
    "verdict shed → invalid",
  );
  assert(!markerWriteStillValid([]), "no labels → invalid");
  assert(!markerWriteStillValid(null), "non-array → invalid");
  assert(
    markerWriteStillValid(["  sentry:verdict-code-fix  ", ""]),
    "whitespace/empties tolerated",
  );
});

await test("stale-verdict close comment names the regression re-queue reason", () => {
  const body = buildStaleVerdictCloseComment();
  assert(/verdict was removed/i.test(body), "explains the shed verdict");
  assert(/regression re-queue/i.test(body), "names the cause");
});

await test("CLI marker-still-valid reads a labels file; stale-verdict-close-comment prints", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-marker-"));
  const valid = join(dir, "valid.txt");
  const shed = join(dir, "shed.txt");
  writeFileSync(valid, "sentry:verdict-code-fix\nsentry:projected\n");
  writeFileSync(shed, "sentry:projected\n");
  assertEqual(
    captureCli(["marker-still-valid", "--labels-file", valid]).trim(),
    "yes",
  );
  assertEqual(
    captureCli(["marker-still-valid", "--labels-file", shed]).trim(),
    "no",
  );
  assert(
    /^Autofix withdrew this PR/.test(
      captureCli(["stale-verdict-close-comment"]),
    ),
    "close comment emitted",
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
