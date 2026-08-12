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
  filesWithCredentialShapedName,
  fixPrOpenedLabelDef,
  fixRefusedLabelDef,
  isForbiddenPath,
  markerWriteStillValid,
  MAX_CHANGED_FILES,
  redactCredentialShaped,
  runCli,
} from "./sentry-autofix-finalize.mjs";
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import { selectMarkedComment } from "./sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
} from "./sentry-triage-ingest.mjs";
// The record-run backfill labeler (#1812) is a new record-run-job module; its
// tests live in this suite, which already covers the record-run body.
import {
  backfillArchitecturalLabels,
  MAX_BACKFILL_LABELS,
  planArchitecturalBackfill,
  SKIP_FIX_SCOPE_ARCHITECTURAL,
  skipReportFromIssueList,
} from "./sentry-autofix-record-labels.mjs";

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
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
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

await test("guard refuses a credential file whose path has a trailing space (#1526)", () => {
  // The load-bearing fix keeps EXACT path bytes: pre-fix, String(f).trim() ate
  // the trailing space so the credential scan lstat'd ENOENT and skipped it
  // (ok:true) while the byte-copy still published the real token-bearing file.
  // The malformed check now refuses it structurally BEFORE the scan runs.
  const dir = mkdtempSync(join(tmpdir(), "autofix-ws-cred-"));
  mkdirSync(join(dir, "ui-dashboard"), { recursive: true });
  writeFileSync(
    join(dir, "ui-dashboard", "leak.ts "),
    'const t = "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz012345";\n',
  );
  const r = evaluateDiffGuard(["ui-dashboard/leak.ts "], { workRoot: dir });
  assert(
    !r.ok && /whitespace or control/i.test(r.reason),
    "trailing-space credential path refused as malformed",
  );
  // Count-only reason — the offending path (which could be named after a real
  // token) is NEVER echoed.
  assert(!r.reason.includes("ghs_AbCd"), "reason must not echo the token");
  rmSync(dir, { recursive: true, force: true });
});

await test("guard refuses a symlink whose path has a trailing space (#1526)", () => {
  // Same divergence via the symlink vector: pre-fix the trim hid the trailing
  // space so the symlink check lstat'd ENOENT and passed; the byte-copy would
  // then dereference the real symlink and exfiltrate runner secrets.
  const dir = mkdtempSync(join(tmpdir(), "autofix-ws-symlink-"));
  mkdirSync(join(dir, "ui-dashboard"), { recursive: true });
  symlinkSync("/proc/self/environ", join(dir, "ui-dashboard", "evil.ts "));
  const r = evaluateDiffGuard(["ui-dashboard/evil.ts "], { workRoot: dir });
  assert(
    !r.ok && /whitespace or control/i.test(r.reason),
    "trailing-space symlink path refused as malformed (before the symlink check)",
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("guard refuses edge-whitespace and control-char paths; allows internal whitespace (#1526)", () => {
  // Every path with leading/trailing whitespace or a control byte (C0 or DEL)
  // is refused structurally — no workRoot needed, it is a pure string check.
  for (const p of [
    "ui-dashboard/leak.ts\r",
    "ui-dashboard/leak.ts\n",
    "ui-dashboard/leak.ts\t",
    " ui-dashboard/leak.ts",
    "ui-dashboard/leak.ts ",
    "ui-dashboard/le\x00ak.ts",
    "ui-dashboard/leak.ts\x7f", // trailing DEL — exercises the widened class
  ]) {
    const r = evaluateDiffGuard([p]);
    assert(
      !r.ok && /whitespace or control/i.test(r.reason),
      `edge/control path refused: ${JSON.stringify(p)}`,
    );
  }
  // INTERNAL whitespace never caused guard/copy divergence (the trim only
  // touched edges) and the byte-copy quotes "${f}" correctly — stays allowed.
  assert(
    evaluateDiffGuard(["ui-dashboard/lib/a b.ts"]).ok,
    "internal-space path allowed",
  );
  // Locks the count-only reason (revision 1): a path named after a token must
  // NOT surface that token in the public refusal reason.
  const leak = evaluateDiffGuard(["ghs_AAAABBBBCCCCDDDD1234.ts "]);
  assert(!leak.ok, "token-named trailing-space path refused");
  assert(
    !leak.reason.includes("ghs_AAAA"),
    "malformed reason must not echo the offending path bytes",
  );
});

await test("CLI guard refuses a trailing-space line and preserves \\r (split on \\n only) (#1526)", () => {
  // Proves the CLI parser now passes EXACT bytes (no trim) and keeps a trailing
  // \r (split on \n only, matching `IFS= read -r`) so the malformed check can
  // fire. It does NOT exercise the credential scan — malformed short-circuits.
  const dir = mkdtempSync(join(tmpdir(), "autofix-ws-cli-"));
  const file = join(dir, "changed.txt");
  writeFileSync(file, "ui-dashboard/leak.ts \nui-dashboard/other.ts\r\n");
  const out = JSON.parse(captureCli(["guard", "--files-file", file]));
  assert(
    !out.ok && /whitespace or control/i.test(out.reason),
    "CLI guard refuses the trailing-space / trailing-\\r lines",
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
  const reason = "The autofix diff touches 25 files (limit 20).";
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
      "- Reverse family probe truncated: hit the MAX_REVERSE_PROBE_QUERIES budget (some finalists left unverified)",
    ),
    `reverse-probe truncation line renders, got: ${hit}`,
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

// Comments as the raw REST endpoint returns them: pipeline-authored comments
// resolve to the Actions bot login "github-actions[bot]".
function trackerComment(id, body, login) {
  return { id, body, user: { login } };
}

// The fence itself (selectMarkedComment) is unit-tested directly in
// sentry-triage-project.test.mjs; these cover the autofix leg's own wiring
// of it against AUTOFIX_RUN_RECORD_MARKER.
await test("autofix run-record selection ignores a marker planted by an untrusted author", () => {
  const planted = trackerComment(
    999,
    `${AUTOFIX_RUN_RECORD_MARKER}\n\nDrive-by defacement.`,
    "drive-by-user",
  );
  assertEqual(selectMarkedComment([planted], AUTOFIX_RUN_RECORD_MARKER), null);
});

await test("autofix run-record selection rejects a trusted comment where the marker is mid-body, not anchored at the start", () => {
  const midBody = trackerComment(
    1,
    `Some chatter.\n\n${AUTOFIX_RUN_RECORD_MARKER}`,
    "github-actions[bot]",
  );
  assertEqual(selectMarkedComment([midBody], AUTOFIX_RUN_RECORD_MARKER), null);
});

await test("autofix run-record selection picks the pipeline's own prefix-anchored, trusted-author record", () => {
  const genuine = trackerComment(
    1,
    `${AUTOFIX_RUN_RECORD_MARKER}\n\n**Sentry autofix — last run:** now`,
    "github-actions[bot]",
  );
  const planted = trackerComment(
    999,
    `${AUTOFIX_RUN_RECORD_MARKER}\n\nDrive-by defacement.`,
    "drive-by-user",
  );
  const selected = selectMarkedComment(
    [planted, genuine],
    AUTOFIX_RUN_RECORD_MARKER,
  );
  assert(selected !== null, "expected the genuine record to be selected");
  assertEqual(selected.id, 1);
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
    "--deferred",
    "3",
    "--deferred-issues",
    "1313 1316 1326",
  ]);
  assert(
    record.includes(AUTOFIX_RUN_RECORD_MARKER) &&
      record.includes("Fix PRs opened: 1") &&
      record.includes(
        "Deferred (duplicate_of family): 3 (#1313, #1316, #1326)",
      ),
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

await test("selected-verdict-id prints the numeric verdict-comment id (#1506)", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-genid-"));
  const file = join(dir, "stub.json");
  writeFileSync(
    file,
    JSON.stringify({
      labels: [{ name: "sentry:verdict-code-fix" }],
      comments: [
        {
          body: "<!-- sentry-triage-verdict:v1 -->\nverdict: code-fix\n",
          createdAt: "2026-07-17T10:00:00Z",
          author: { login: "github-actions" },
          url: "https://github.com/o/r/issues/1#issuecomment-777",
        },
      ],
    }),
  );
  assert(
    captureCli(["selected-verdict-id", "--comments-file", file]).trim() ===
      "777",
    "prints the live verdict comment's numeric id",
  );
});

await test("selected-verdict-id fails closed to 'none' (#1506)", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-genid-none-"));
  const noVerdict = join(dir, "empty.json");
  writeFileSync(noVerdict, JSON.stringify({ comments: [] }));
  const malformed = join(dir, "bad.json");
  writeFileSync(malformed, "{not json");
  const missing = join(dir, "nope.json");
  for (const f of [noVerdict, malformed, missing]) {
    assert(
      captureCli(["selected-verdict-id", "--comments-file", f]).trim() ===
        "none",
      `fails closed to none for ${f}`,
    );
  }
});

// `gh api ... --paginate --slurp` (what the workflow feeds --comments-file)
// wraps each page in one outer array — i.e. an array of per-page arrays, not
// a single flat array of comments. A fixture with the genuine record on a
// SECOND page is the only way to prove the CLI flattens across pages rather
// than only ever looking at page 1.
await test("select-run-record-id flattens multiple --paginate --slurp pages and finds a trusted, prefix-anchored record on a later page, ignoring a planted decoy on an earlier one", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-runrecord-id-"));
  const file = join(dir, "comments.json");
  writeFileSync(
    file,
    JSON.stringify([
      [
        trackerComment(
          999,
          `${AUTOFIX_RUN_RECORD_MARKER}\n\nDrive-by defacement.`,
          "drive-by-user",
        ),
      ],
      [
        trackerComment(
          1,
          `${AUTOFIX_RUN_RECORD_MARKER}\n\n**Sentry autofix — last run:** now`,
          "github-actions[bot]",
        ),
      ],
    ]),
  );
  assertEqual(
    captureCli(["select-run-record-id", "--comments-file", file]).trim(),
    "1",
  );
});

// Reverting the `.flatMap` in the CLI's "select-run-record-id" case back to a
// bare `Array.isArray(parsed) ? parsed : []` reproduces the bug this test
// guards: the outer array's elements are page-arrays (no `.body`), so
// `isTrustedComment`/`startsWith` never match and this prints "none" instead
// of "1" — silently spamming a fresh comment every run once the tracker
// passes its first page. Mutation-proven by hand against that revert.
await test("select-run-record-id fails closed to 'none' for no record, a mid-body marker, and unparsable input", () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-runrecord-id-none-"));
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "[]");
  const midBody = join(dir, "mid-body.json");
  writeFileSync(
    midBody,
    JSON.stringify([
      [
        trackerComment(
          1,
          `Some chatter.\n\n${AUTOFIX_RUN_RECORD_MARKER}`,
          "github-actions[bot]",
        ),
      ],
    ]),
  );
  const malformed = join(dir, "bad.json");
  writeFileSync(malformed, "{not json");
  const missing = join(dir, "nope.json");
  for (const f of [empty, midBody, malformed, missing]) {
    assert(
      captureCli(["select-run-record-id", "--comments-file", f]).trim() ===
        "none",
      `fails closed to none for ${f}`,
    );
  }
});

// ── #1551: credential-shaped FILENAME bypass + reason path-echo redaction ─────
// Fixtures are built by concatenation so no contiguous credential-shaped literal
// sits in this source file (avoids tripping secret scanners on a test fixture).
const CRED = {
  ghs: "ghs_" + "A".repeat(20),
  pat: "github_pat_" + "A".repeat(16),
  skant: "sk-ant-" + "abcdefgh",
  xox: "xoxb-" + "abcdefghij",
  akia: "AKIA" + "ABCDEFGHIJKLMNOP",
};

await test("guard refuses a changed path whose NAME is credential-shaped (#1551)", () => {
  // The content scan reads file BODIES, so a clean-content file NAMED after a
  // token passes it and the name is published in the public PR file tree. The
  // name scan refuses it, count-only — never echoing the token.
  const dir = mkdtempSync(join(tmpdir(), "autofix-name-"));
  const name = `${CRED.ghs}.ts`;
  writeFileSync(join(dir, name), "export const x = 1;\n");
  const r = evaluateDiffGuard([name], { workRoot: dir });
  assert(!r.ok, "credential-named path refused");
  assert(
    !r.reason.includes(CRED.ghs),
    "reason must not echo the token embedded in the filename",
  );
  // An ordinary source path is unaffected.
  assert(
    evaluateDiffGuard(["ui-dashboard/lib/helper.ts"]).ok,
    "clean path still allowed",
  );
  rmSync(dir, { recursive: true, force: true });
});

await test("filesWithCredentialShapedName matches every credential prefix family (#1551)", () => {
  const hits = filesWithCredentialShapedName([
    "clean/path.ts",
    `${CRED.ghs}.ts`,
    `${CRED.pat}.md`,
    `dir/${CRED.skant}.txt`,
    `${CRED.xox}.json`,
    `${CRED.akia}.env`,
  ]);
  assert(
    hits.length === 5,
    `expected 5 credential-named paths, got ${hits.length}`,
  );
  assert(!hits.includes("clean/path.ts"), "clean path not flagged");
});

await test("redactCredentialShaped masks credential substrings in an echoed path (#1551)", () => {
  const out = redactCredentialShaped(
    `path/${CRED.ghs}/a, dir/${CRED.skant}.tf, ${CRED.akia}`,
  );
  assert(!out.includes(CRED.ghs), "ghs_ token masked");
  assert(!out.includes(CRED.skant), "sk-ant- token masked");
  assert(!out.includes(CRED.akia), "AKIA token masked");
  assert(out.includes("[redacted]"), "redaction marker present");
  assert(
    redactCredentialShaped("ui-dashboard/lib/a.ts") === "ui-dashboard/lib/a.ts",
    "a clean path is unchanged",
  );
});

await test("guard resists filename-credential obfuscation and avoids false positives (#1551 red-team)", () => {
  // Filenames are agent-controlled: padding before the prefix, or splitting the
  // body/prefix with a separator, must not hide a recoverable token. Fixtures are
  // concatenated so no contiguous credential literal sits in this source.
  const TOKEN = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"; // 36 alnum
  const G = "ghs" + "_";
  const attacks = [
    `ui-dashboard/lib/x${G}${TOKEN}.ts`, // padded before the prefix (kills \b)
    `${G}a1b2/c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8.ts`, // body split by /
    `${G}a1b2-c3d4-e5f6-g7h8-i9j0-k1l2-m3n4-o5p6.ts`, // body split by -
    `g/hs_${TOKEN}.ts`, // prefix split by /
    `x${"github" + "_pat_"}${TOKEN}.ts`, // padded github_pat
  ];
  for (const p of attacks) {
    assert(
      filesWithCredentialShapedName([p]).length === 1,
      `obfuscated credential filename must be refused: ${p}`,
    );
  }
  // Legit source paths — including deceptive substrings ("highschool" contains
  // "ghs", "Graphs" nearly does) — must NOT be refused.
  for (const p of [
    "ui-dashboard/src/lib/helper.ts",
    "docs/highschool-notes.md",
    "ui-dashboard/components/LightShowGraphs.tsx",
    "alerts/rules/oracle.tf",
  ]) {
    assert(
      filesWithCredentialShapedName([p]).length === 0,
      `legit path must not false-positive: ${p}`,
    );
  }
  // A padded token that reaches a path-echoing reason is masked by redaction.
  const red = redactCredentialShaped(`forbidden: scripts/x${G}${TOKEN}.ts`);
  assert(!red.includes(`${G}a1b2`), "padded token masked in a redacted reason");
});

await test("guard: full-collapse GitHub/AWS, canonical-only Anthropic/Slack, no camelCase FP (#1551 review)", () => {
  const T = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
  const G = "ghs" + "_";
  const SK = "sk" + "-" + "ant" + "-";
  // GitHub/AWS families collapse EVERY non-token byte, so any inserted separator
  // (incl. '@', '+') rejoins to trip the {16,} floor.
  for (const p of [
    `src/${G}a1b2@c3d4e5f6g7h8i9j0.ts`, // '@' separator
    `src/${G}a1b2+c3d4+e5f6+g7h8+i9j0.ts`, // '+' separators
    `${G}a1b2/c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8.ts`, // '/' split
  ]) {
    assert(
      filesWithCredentialShapedName([p]).length === 1,
      `must refuse: ${p}`,
    );
  }
  // Anthropic/Slack matched only in CANONICAL dashed form — real keys caught.
  for (const p of [`config/${SK}api03-${T}.ts`, `x/${"xox" + "b-"}${T}.ts`]) {
    assert(
      filesWithCredentialShapedName([p]).length === 1,
      `must refuse: ${p}`,
    );
  }
  // No false positive: canonical-only matching keeps ordinary camelCase and
  // hyphenated code clear where the short sk-ant/xox collapsed forms would collide.
  for (const p of [
    "ui-dashboard/src/TaskAntennaComponentHelperFactory.ts",
    "src/risk-antenna.ts",
    "src/task-antler.ts",
    "src/gh/s_util.ts", // cross-segment join, short body
    "docs/highschool-curriculum-planning-notes.md",
  ]) {
    assert(filesWithCredentialShapedName([p]).length === 0, `must allow: ${p}`);
  }
  // Documented residual (NOT asserted; low-value inference/Slack tokens): heavy
  // obfuscation of the short prefixes, e.g. `sk.ant-…` or `sk-ant-a/bcdefgh`.
});

await test("guard catches underscore-containing / underscore-split credential filenames (#1551 review P1)", () => {
  const T = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
  const GP = "github" + "_pat_";
  const GHS = "ghs" + "_";
  for (const p of [
    `ui-dashboard/src/${GP}AAAAAAAA_BBBBBBBB.ts`, // github_pat suffix contains '_' (P1)
    `${GP}11ABCDEFG0${T}.ts`, // realistic github_pat shape
    `${GHS}a1b2_c3d4_e5f6_g7h8_i9j0_k1l2_m3n4_o5p6.ts`, // ghs_ body split with '_'
  ]) {
    assert(
      filesWithCredentialShapedName([p]).length === 1,
      `underscore-obfuscated credential filename must be refused: ${p}`,
    );
  }
  // A SCREAMING_SNAKE constants file must not false-positive.
  assert(
    filesWithCredentialShapedName(["src/AUTH_CONFIG_CONSTANTS.ts"]).length ===
      0,
    "SCREAMING_SNAKE const path allowed",
  );
});

// ---------------------------------------------------------------------------
// Record-run architectural backfill labeler (#1812). Drains the legacy
// architectural backlog by labeling the stubs the selector skipped, so the next
// run excludes them at query time.
// ---------------------------------------------------------------------------

const architecturalSkip = (issue) => ({
  issue,
  reason: SKIP_FIX_SCOPE_ARCHITECTURAL,
});

await test("backfill: self-heal-creates the label FIRST, then one ^[0-9]+$-validated --add-label per stub", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return "{}";
  };
  const skip = [
    architecturalSkip("10"),
    architecturalSkip("22"),
    architecturalSkip("10"), // duplicate collapses
  ];
  const res = await backfillArchitecturalLabels(
    skip,
    { repo: "o/r" },
    { runGh },
  );
  // The FIRST gh call is the self-heal label create (from LABEL_DEFINITIONS).
  assertEqual(calls[0][0], "label");
  assertEqual(calls[0][1], "create");
  assertEqual(calls[0][2], FIX_SCOPE_ARCHITECTURAL_LABEL);
  assert(calls[0].includes("--force"), "self-heal create must be --force");
  // Then exactly one --add-label edit per distinct valid number, in order.
  const edits = calls
    .slice(1)
    .filter((c) => c[0] === "issue" && c[1] === "edit");
  assertDeepEqual(
    edits.map((c) => c[2]),
    ["10", "22"],
  );
  for (const c of edits) {
    assertEqual(c[c.indexOf("--add-label") + 1], FIX_SCOPE_ARCHITECTURAL_LABEL);
  }
  assertDeepEqual(res.labeled, ["10", "22"]);
});

await test("backfill: a malformed (non-integer) issue number is REFUSED, never interpolated into a gh argv", async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    return "{}";
  };
  const skip = [
    architecturalSkip("7"),
    architecturalSkip("not-a-number"),
    architecturalSkip("9; rm -rf /"),
  ];
  const res = await backfillArchitecturalLabels(
    skip,
    { repo: "o/r" },
    { runGh },
  );
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  assertDeepEqual(
    edits.map((c) => c[2]),
    ["7"],
  );
  assertDeepEqual(res.refused, ["not-a-number", "9; rm -rf /"]);
});

await test("backfill: only fix-scope-architectural skips are labeled (a future skip reason is ignored)", () => {
  const plan = planArchitecturalBackfill([
    architecturalSkip("1"),
    { issue: "2", reason: "some-other-skip" },
    architecturalSkip("3"),
  ]);
  assertDeepEqual(plan.numbers, ["1", "3"]);
});

await test("backfill: idempotent — re-running produces the identical --add-label edits", async () => {
  const run = async () => {
    const calls = [];
    const runGh = async (args) => {
      calls.push(args);
      return "{}";
    };
    await backfillArchitecturalLabels(
      [architecturalSkip("5"), architecturalSkip("6")],
      { repo: "o/r" },
      { runGh },
    );
    return calls
      .filter((c) => c[0] === "issue" && c[1] === "edit")
      .map((c) => c.join(" "));
  };
  assertDeepEqual(await run(), await run());
});

await test("backfill: caps the per-run write volume at MAX_BACKFILL_LABELS, overflow labeled later", () => {
  const many = [];
  for (let i = 0; i < MAX_BACKFILL_LABELS + 5; i += 1) {
    many.push(architecturalSkip(String(1000 + i)));
  }
  const plan = planArchitecturalBackfill(many);
  assertEqual(plan.numbers.length, MAX_BACKFILL_LABELS);
  assertEqual(plan.overflow, 5);
});

await test("backfill: the CLI's space-separated issue list rebuilds an all-architectural skip report", () => {
  const report = skipReportFromIssueList("10 22 33");
  assertDeepEqual(report, [
    architecturalSkip("10"),
    architecturalSkip("22"),
    architecturalSkip("33"),
  ]);
  assertDeepEqual(skipReportFromIssueList(""), []);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
