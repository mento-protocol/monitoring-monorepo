#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autofixBranchName,
  AUTOFIX_BRANCH_PREFIX,
  buildAnalysisComment,
  buildAutofixComment,
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
// The run-record marker moved to its own module (the finalize CLI still renders
// the body); the marker is used here to test the CLI's rolling-comment upsert
// and the untrusted-author selection fence.
import { AUTOFIX_RUN_RECORD_MARKER } from "./sentry-autofix-run-record.mjs";
// The select leg's per-run cost caps. This suite already reads the autofix
// workflow, so it is where the job budget those caps are sized against can be
// pinned against the caps themselves — see the timeout test at the end.
import { MAX_CANDIDATE_EVALUATIONS } from "./sentry-autofix-select.mjs";
import {
  MAX_SECOND_LOOK_EVALUATIONS,
  SECOND_LOOK_FAMILY_BUDGETS,
} from "./sentry-autofix-second-look.mjs";
import { MAX_HANDLED_ID_QUERIES } from "./sentry-autofix-family-handled.mjs";
import {
  MAX_REVERSE_PROBE_QUERIES,
  MAX_REVERSE_VERIFY_READS,
} from "./sentry-autofix-reverse-verify.mjs";
import { AUTOFIX_COMMENT_PREFIX } from "../triage/sentry-triage-digest.mjs";
import {
  FIX_SCOPE_MECHANICAL,
  selectMarkedComment,
  VERDICT_MARKER,
} from "../triage/sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  FIX_SCOPE_ARCHITECTURAL_LABEL,
} from "../triage/sentry-triage-ingest.mjs";
// The record-run backfill labeler (#1812) is a new record-run-job module; its
// tests live in this suite, which already covers the record-run body.
import {
  backfillArchitecturalLabels,
  MAX_BACKFILL_LABELS,
  planArchitecturalBackfill,
  SKIP_FIX_SCOPE_ARCHITECTURAL,
  skipReportFromIssueList,
} from "./sentry-autofix-record-labels.mjs";

const GHS_LEAK = "ghs" + "_AbCdEfGhIjKlMnOpQrStUvWxYz012345";

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
    "scripts/deploy/deploy-indexer.sh",
    "scripts/sentry/autofix/sentry-autofix-finalize.mjs",
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
    `const t = "${GHS_LEAK}";\n`,
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
    `const t = "${GHS_LEAK}";\n`,
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
  assert(
    body.includes("Before this PR") && body.includes("This PR changes"),
    "body explains the trusted before/after boundary",
  );
  assert(body.includes(`Fixes ${SHORT_ID}`), "Fixes SHORT-ID present");
  assert(body.includes("Refs #1278"), "Refs queue issue present");
  assert(body.includes("merge stays human"), "provenance present");
  // No fenced agent block, ever — the diff is the authoritative artifact.
  assert(!body.includes("```"), "no fenced block in the body");
  assert(
    body.includes("cannot safely publish its agent notes"),
    "body explains why technical agent detail is omitted",
  );
});

await test("analysis comment is deterministic — no summary channel to smuggle text through", () => {
  // buildAnalysisComment takes ONLY the machine-generated guard reason. Even if
  // a caller tried to pass extra args, the signature ignores them.
  const reason = "The autofix diff touches 25 files (limit 20).";
  const c = buildAnalysisComment(reason, `${GHS_LEAK} leak attempt`);
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
    "--refused-inventory",
    JSON.stringify({ state: "known", count: 1, issues: [1304] }),
  ]);
  assert(
    record.includes(AUTOFIX_RUN_RECORD_MARKER) &&
      record.includes("Fix PRs opened: 1") &&
      record.includes(
        "Deferred (duplicate_of family): 3 (#1313, #1316, #1326)",
      ) &&
      record.includes(
        "https://github.com/mento-protocol/monitoring-monorepo/issues/1304",
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
  const T36 = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"; // 36 alnum
  const G = "ghs" + "_";
  const attacks = [
    `ui-dashboard/lib/x${G}${T36}.ts`, // padded before the prefix (kills \b)
    `${G}a1b2/c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8.ts`, // body split by /
    `${G}a1b2-c3d4-e5f6-g7h8-i9j0-k1l2-m3n4-o5p6.ts`, // body split by -
    `g/hs_${T36}.ts`, // prefix split by /
    `x${"github" + "_pat_"}${T36}.ts`, // padded github_pat
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
  const red = redactCredentialShaped(`forbidden: scripts/x${G}${T36}.ts`);
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

const BOT = { login: "github-actions[bot]" };
const NEEDS_TRIAGE = "sentry:needs-triage";

// A `gh issue view --json …` body carrying ONE trusted verdict comment — the
// shape `readStub`/`resolveVerdict` re-read during the backfill revalidation.
// `fixScope: null` omits the line (normalizes to architectural, the pre-#1785
// shape); FIX_SCOPE_MECHANICAL makes the stub selectable again. `affectedRepo`
// defaults to this repo; set it to an allowlisted-external repo to model a
// re-triage that moved the owning repo off-local.
function verdictView(
  number,
  {
    verdict = "code-fix",
    fixScope = null,
    affectedRepo = "mento-protocol/monitoring-monorepo",
    labels = null,
  } = {},
) {
  const body = [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict}`,
    "confidence: medium",
    `affected_repo: ${affectedRepo}`,
    "summary: A scoped bug",
    "root_cause: |",
    "  Abstract root cause.",
    "proposed_action: |",
    "  Abstract action.",
    "duplicate_of: []",
    ...(fixScope === null ? [] : [`fix_scope: ${fixScope}`]),
    "```",
    "",
    "Diagnosis prose.",
  ].join("\n");
  return JSON.stringify({
    number: Number(number),
    title: `[sentry] APP-MENTO-ORG-${number} (analytics-mento-org, error)`,
    body: "",
    // The re-queue chokepoint reads STATE too (its selectable pair is
    // open + sentry:needs-triage), so the fixture carries both.
    state: "OPEN",
    labels: (labels ?? ["sentry-triage"]).map((name) => ({ name })),
    comments: [{ author: BOT, body, createdAt: "2026-07-18T00:00:00Z" }],
  });
}

// runGh mock for the backfill loop: `label create` and `issue edit` succeed;
// `issue view` returns the configured LIVE verdict per number so the
// revalidation re-read runs for real. `scopeByNumber` maps a number string to a
// `verdictView` spec, or the sentinel "gone" (no verdict comment) / "error" (the
// read throws). A number not in the map defaults to still-architectural.
//
// The write is bracketed by TWO reads (the #1389-shaped pre/post guard), so a
// spec may also be an ARRAY of specs consumed one per read for that number: the
// first entry answers the pre-write check, the second the post-write check. That
// is how the TOCTOU window is modelled — the state moves between the two reads.
// A one-entry array (or a plain spec) answers every read the same way.
// `removeFails` makes the compensating `--remove-label` edit throw.
// A withdrawal also RE-QUEUES the stub through the chokepoint, which issues its
// own label edits and then READS the stub back to confirm the selectable pair
// (open + sentry:needs-triage). So the mock tracks live labels per issue and
// answers `issue view` from them — otherwise the chokepoint's end-state
// verification could never observe the label it just wrote. `requeueFails` makes
// the needs-triage add fail, which is what drives the chokepoint to throw.
// `terminalByNumber` flips a stub to a settled state for every read AFTER the
// post-write check — modelling projection or the archive leg completing in the
// gap before the compensating re-queue. `{ state, labels }` are merged into the
// view the chokepoint's revalidation reads. `terminalReadFails` makes that
// revalidation read throw instead.
function makeBackfillRunGh({
  scopeByNumber = {},
  calls = [],
  removeFails = false,
  requeueFails = false,
  terminalByNumber = {},
  terminalReadFails = false,
} = {}) {
  const reads = new Map();
  const labelsByNumber = new Map();
  const labelsOf = (number) => {
    if (!labelsByNumber.has(number)) {
      labelsByNumber.set(number, new Set(["sentry-triage"]));
    }
    return labelsByNumber.get(number);
  };
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "edit") {
      const number = String(args[2]);
      const addIdx = args.indexOf("--add-label");
      const removeIdx = args.indexOf("--remove-label");
      if (removeFails && removeIdx !== -1) {
        throw new Error("gh issue edit --remove-label failed: boom");
      }
      if (requeueFails && addIdx !== -1 && args[addIdx + 1] === NEEDS_TRIAGE) {
        throw new Error("gh issue edit --add-label failed: boom");
      }
      if (addIdx !== -1) {
        for (const name of String(args[addIdx + 1]).split(",")) {
          labelsOf(number).add(name);
        }
      }
      if (removeIdx !== -1) {
        for (const name of String(args[removeIdx + 1]).split(",")) {
          labelsOf(number).delete(name);
        }
      }
      return "{}";
    }
    if (a0 === "issue" && a1 === "view") {
      const number = String(args[2]);
      const configured = scopeByNumber[number] ?? {};
      let spec = configured;
      if (Array.isArray(configured)) {
        const seen = reads.get(number) ?? 0;
        reads.set(number, seen + 1);
        spec = configured[Math.min(seen, configured.length - 1)];
      }
      const live = [...labelsOf(number)];
      // Reads 1 and 2 are the guard's pre/post pair; anything after is the
      // re-queue chokepoint's own revalidation/verification read, which is where
      // a stub that went terminal in the gap becomes visible.
      const seenSoFar = reads.get(number) ?? 0;
      const terminal = terminalByNumber[number];
      if (terminal && seenSoFar > 2) {
        if (terminalReadFails) {
          throw new Error("gh issue view failed: boom");
        }
        return JSON.stringify({
          number: Number(number),
          title: "t",
          body: "",
          state: terminal.state ?? "CLOSED",
          labels: [...live, ...(terminal.labels ?? [])].map((name) => ({
            name,
          })),
          comments: [],
        });
      }
      if (spec === "error") throw new Error("gh issue view failed: boom");
      if (spec === "gone") {
        return JSON.stringify({
          number: Number(number),
          title: "t",
          body: "",
          state: "OPEN",
          labels: live.map((name) => ({ name })),
          comments: [],
        });
      }
      return verdictView(number, { ...spec, labels: live });
    }
    return "{}";
  };
  return { runGh, calls };
}

await test("backfill: self-heal-creates the label FIRST, then one ^[0-9]+$-validated --add-label per stub", async () => {
  // Every stub is still live-architectural, so all pass revalidation and label.
  const { runGh, calls } = makeBackfillRunGh();
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
  const { runGh, calls } = makeBackfillRunGh();
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
    const { runGh, calls } = makeBackfillRunGh();
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

await test("backfill: revalidates each stub's LIVE scope before labeling — stale/gone/unreadable are left selectable (#1812 race)", async () => {
  // The skip report is a snapshot from the select run. Between select and this
  // record run each stub can move: #10 is still architectural (label it), #22 was
  // re-triaged to mechanical (must NOT be re-excluded off the stale snapshot), #33
  // lost its verdict comment, #44 fails to read. The last three fail CLOSED: no
  // label, so they stay selectable and self-heal next run.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      10: { fixScope: null },
      22: { fixScope: FIX_SCOPE_MECHANICAL },
      33: "gone",
      44: "error",
    },
  });
  const res = await backfillArchitecturalLabels(
    [
      architecturalSkip("10"),
      architecturalSkip("22"),
      architecturalSkip("33"),
      architecturalSkip("44"),
    ],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, ["10"]);
  assertDeepEqual(res.revalidated, ["22", "33", "44"]);
  // Only the still-architectural stub got an --add-label edit; the stale ones did
  // not (the whole point — a now-mechanical stub must not be re-excluded).
  const editedNumbers = calls
    .filter((c) => c[0] === "issue" && c[1] === "edit")
    .map((c) => c[2]);
  assertDeepEqual(editedNumbers, ["10"]);
});

await test("backfill NEGATIVE CONTROL: a stub whose live verdict is now mechanical is NEVER re-labeled (reds if the re-read is dropped)", async () => {
  // Drop the revalidation re-read and #77 gets the stale architectural label back
  // — the exact race Finding 1 closes. So this asserts the absence of that write:
  // remove `liveArchitecturalScope` from the loop and both assertions go red.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: { 77: { fixScope: FIX_SCOPE_MECHANICAL } },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("77")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, []);
  assertDeepEqual(res.revalidated, ["77"]);
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "edit" && c[2] === "77"),
    "a now-mechanical stub must receive no --add-label edit",
  );
});

await test("backfill: a stub re-triaged to an allowlisted-EXTERNAL repo is not labeled (the hold is local-only)", async () => {
  // The sentry:fix-scope-architectural hold is a LOCAL-only window exclusion.
  // A local architectural stub re-triaged to an external allowlisted owning repo
  // (still code-fix + architectural) must NOT get it: the hold would make
  // runProjectionBatch's skipped-state guard drop the external issue from
  // projection with no retry label. So the revalidation re-confirms the owning
  // repo, exactly as the selector's evaluateCandidate does.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      // Still LOCAL architectural -> labeled.
      88: { fixScope: null },
      // code-fix + architectural, but now an allowlisted-external repo -> NOT.
      89: { fixScope: null, affectedRepo: "mento-protocol/frontend-monorepo" },
    },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("88"), architecturalSkip("89")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, ["88"]);
  assertDeepEqual(res.revalidated, ["89"]);
  // Negative control: the ONLY thing keeping #89 unlabeled is the live repo
  // re-check. Drop it from liveArchitecturalScope and #89 (code-fix +
  // architectural) is labeled — this asserts the external stub gets no edit.
  assertDeepEqual(
    calls.filter((c) => c[0] === "issue" && c[1] === "edit").map((c) => c[2]),
    ["88"],
  );
});

// --- post-write TOCTOU guard (#1389-shaped) ---------------------------------
//
// The pre-write check alone cannot close the window between the read and the
// `--add-label` edit: triage runs in its own concurrency group, so a re-triage
// landing there has settlement REMOVE the hold and this backfill ADD IT BACK.
// For an external code-fix that is a permanent strand (projection reads the
// re-added hold as skipped-state and files nothing; the stub keeps no retry
// label). So the write is bracketed by the same live check on both sides, and a
// post-check that does not re-confirm architectural withdraws the label again.

/** Run `fn` with process.stderr.write captured, so a test can assert on the
 * notes the backfill emits (the loud ::error:: for a stuck label). */
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let text = "";
  process.stderr.write = (chunk) => {
    text += String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: text };
  } finally {
    process.stderr.write = original;
  }
}

/** The edits issued for one issue that target the ARCHITECTURAL HOLD exactly, in
 * order. Scoped to that label on purpose: a withdrawal also re-queues the stub,
 * and the chokepoint issues its own `--add-label sentry:needs-triage` plus a
 * comma-joined shed list — neither of which is this guard's add/remove pair. */
function labelEdits(calls, number) {
  const out = [];
  for (const c of calls) {
    if (!(c[0] === "issue" && c[1] === "edit" && c[2] === String(number))) {
      continue;
    }
    const addIdx = c.indexOf("--add-label");
    const removeIdx = c.indexOf("--remove-label");
    if (addIdx !== -1 && c[addIdx + 1] === FIX_SCOPE_ARCHITECTURAL_LABEL) {
      out.push("add");
    }
    if (
      removeIdx !== -1 &&
      c[removeIdx + 1] === FIX_SCOPE_ARCHITECTURAL_LABEL
    ) {
      out.push("remove");
    }
  }
  return out;
}

/** True when the stub was reopened — the write a terminal-state decline must
 * never make (it would reverse a projection or a human-approved archive). */
function reopenedFor(calls, number) {
  return calls.some(
    (c) => c[0] === "issue" && c[1] === "reopen" && c[2] === String(number),
  );
}

/** True when the re-queue chokepoint ran for this issue: it is the only caller
 * that adds `sentry:needs-triage`. */
function requeuedFor(calls, number) {
  return calls.some((c) => {
    if (!(c[0] === "issue" && c[1] === "edit" && c[2] === String(number))) {
      return false;
    }
    const addIdx = c.indexOf("--add-label");
    return addIdx !== -1 && c[addIdx + 1] === NEEDS_TRIAGE;
  });
}

await test("backfill TOCTOU: state moves to mechanical between the pre-read and the write — label added, then REMOVED", async () => {
  // Pre-write read says architectural (so the write proceeds); by the post-write
  // read a concurrent re-triage has made it mechanical. The label must be taken
  // back off, leaving the stub selectable and re-evaluated next run.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      101: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("101")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, []);
  assertDeepEqual(res.withdrawn, ["101"]);
  assertDeepEqual(res.withdrawFailed, []);
  // Negative control: delete the post-write check and this is ["add"] — the
  // stale hold stays on a now-mechanical stub, the strand this guard prevents.
  assertDeepEqual(labelEdits(calls, 101), ["add", "remove"]);
  // Removing the label is not enough: projection may already have skipped this
  // stub on the stale hold, so it must be put back through triage. Negative
  // control: drop the requeueQueueStub call and both of these go red.
  assertDeepEqual(res.requeued, ["101"]);
  assert(requeuedFor(calls, 101), "the withdrawn stub must be re-queued");
  // The CAUSE is load-bearing, so assert its observable consequence: a
  // bookkeeping re-queue posts the explanatory note and NO regression fence.
  // Fencing here would mark the operator's fresh verdict stale and discard the
  // very re-triage this stub should settle on.
  const comments = calls
    .filter((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "101")
    .map((c) => c[c.indexOf("--body") + 1]);
  assert(
    comments.some((b) => b.includes("withdrew the")),
    `expected the withdrawal bookkeeping note, got: ${JSON.stringify(comments)}`,
  );
  assert(
    !comments.some((b) => b.includes("Regressed in Sentry")),
    "a bookkeeping re-queue must not post a regression fence",
  );
});

await test("backfill TOCTOU: a post-check READ ERROR removes the label too (fail-closed, self-healing)", async () => {
  // Same fail-closed stance as the pre-write half: unconfirmed means do not
  // hold. The selector re-parses fix_scope next run, reports the skip, and this
  // backfill re-adds the label — so removing costs at most one wasted cycle,
  // while leaving an unverifiable hold risks the permanent strand.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    // Read 1 (pre-write) confirms architectural; read 2 (post-write) fails —
    // the unconfirmed branch. Read 3 is the re-queue chokepoint's own
    // verification read, modelled as recovered: the blip was transient, and the
    // stub it now sees was re-triaged mechanical.
    scopeByNumber: {
      102: [{ fixScope: null }, "error", { fixScope: FIX_SCOPE_MECHANICAL }],
    },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("102")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, []);
  assertDeepEqual(res.withdrawn, ["102"]);
  assertDeepEqual(labelEdits(calls, 102), ["add", "remove"]);
  // The unconfirmed branch withdraws too, so it must re-queue on the same
  // argument as the selectable one.
  assertDeepEqual(res.requeued, ["102"]);
  assert(requeuedFor(calls, 102), "the withdrawn stub must be re-queued");
});

await test("backfill TOCTOU: the steady state keeps the label — exactly one edit, no removal", async () => {
  // Still architectural at BOTH reads: the guard must be silent here, or every
  // healthy backfill would churn a label on and off.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: { 103: [{ fixScope: null }, { fixScope: null }] },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("103")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.labeled, ["103"]);
  assertDeepEqual(res.withdrawn, []);
  assertDeepEqual(res.withdrawFailed, []);
  assertDeepEqual(labelEdits(calls, 103), ["add"]);
  // No churn on the healthy path: a kept hold must NOT re-queue the stub, or
  // every backfill would bounce its own stubs back through triage.
  assertDeepEqual(res.requeued, []);
  assert(
    !requeuedFor(calls, 103),
    "a healthy backfill must not re-queue the stub",
  );
  // Two reads bracket the one write (pre + post), the documented cost.
  assertEqual(
    calls.filter((c) => c[0] === "issue" && c[1] === "view" && c[2] === "103")
      .length,
    2,
  );
});

await test("backfill TOCTOU: a FAILING compensating removal is surfaced, never silent", async () => {
  // A hold that cannot be withdrawn is exactly the strand the guard exists to
  // prevent, and the record-run job is continue-on-error — so it must reach both
  // stderr (as ::error::) and the returned summary.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    removeFails: true,
    scopeByNumber: {
      104: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
  });
  const { result: res, stderr } = await captureStderr(() =>
    backfillArchitecturalLabels(
      [architecturalSkip("104")],
      { repo: "o/r" },
      { runGh },
    ),
  );
  assertDeepEqual(res.labeled, []);
  assertDeepEqual(res.withdrawn, []);
  // Negative control: swallow the removal error (drop withdrawFailed / the
  // ::error:: write) and both of these go red.
  assertDeepEqual(res.withdrawFailed, ["104"]);
  assert(
    stderr.includes("::error::") && stderr.includes("#104"),
    `expected a loud ::error:: for the stuck label, got: ${stderr}`,
  );
});

// --- terminal-state guard on the compensating re-queue ----------------------
//
// The compensation is snapshot-driven too, so settlement can COMPLETE between
// the withdrawal and the re-queue. A bookkeeping re-queue reopens the stub and
// sheds sentry:projected / sentry:archived via REOPEN_SHED_LABELS, so running it
// against a settled stub would reverse a successful projection or a
// human-approved archive. Reuse the triage workflow's terminal predicate and
// DECLINE instead — no compensation is owed once the pipeline reached the
// outcome on its own. The hold removal still stands: the window query already
// excludes a projected/archived stub through its own `-label:` negation, so
// taking our stale hold off one changes nothing about selection.

await test("backfill terminal guard: a stub CLOSED and projected after the withdrawal declines the re-queue", async () => {
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      201: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
    terminalByNumber: {
      201: { state: "CLOSED", labels: ["sentry:projected"] },
    },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("201")],
    { repo: "o/r" },
    { runGh },
  );
  // The stale hold still comes off — harmless on a terminal stub, and correct.
  assertDeepEqual(res.withdrawn, ["201"]);
  assertDeepEqual(labelEdits(calls, 201), ["add", "remove"]);
  // Negative control: drop the `revalidate` guard and this re-queues — reopening
  // a projected stub and shedding sentry:projected.
  assertDeepEqual(res.requeueDeclined, ["201"]);
  assertDeepEqual(res.requeued, []);
  assert(!reopenedFor(calls, 201), "a settled stub must never be reopened");
  assert(!requeuedFor(calls, 201), "a settled stub must not be re-queued");
});

await test("backfill terminal guard: a stub carrying sentry:archived declines the re-queue", async () => {
  // The archive marker is human-approved. Reversing it is the worst outcome in
  // this whole chain, so it gets its own arm.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      202: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
    terminalByNumber: { 202: { state: "CLOSED", labels: ["sentry:archived"] } },
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("202")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.requeueDeclined, ["202"]);
  assertDeepEqual(res.requeued, []);
  assert(!reopenedFor(calls, 202), "an archived stub must never be reopened");
});

await test("backfill terminal guard: a still-OPEN skipped stub is still re-queued (no regression)", async () => {
  // The normal compensation case must survive the guard: this is the strand the
  // previous commit closed, and the guard must not swallow it.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      203: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
    // No terminalByNumber entry: the stub stays open and unsettled.
  });
  const res = await backfillArchitecturalLabels(
    [architecturalSkip("203")],
    { repo: "o/r" },
    { runGh },
  );
  assertDeepEqual(res.requeued, ["203"]);
  assertDeepEqual(res.requeueDeclined, []);
  assert(requeuedFor(calls, 203), "an open skipped stub must be re-queued");
});

await test("backfill terminal guard: a FAILING terminal re-read does not re-queue, and is loud", async () => {
  // Safe direction: an unconfirmable terminal state must NOT be reopened —
  // wrongly reversing an approved archive is worse than one missed
  // compensation, which the next run's backfill re-detects from the same skip
  // report. The chokepoint propagates the failed revalidation read, so this
  // lands in the loud requeueFailed bucket rather than silently proceeding.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    scopeByNumber: {
      204: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
    terminalByNumber: { 204: { state: "CLOSED", labels: ["sentry:archived"] } },
    terminalReadFails: true,
  });
  const { result: res, stderr } = await captureStderr(() =>
    backfillArchitecturalLabels(
      [architecturalSkip("204")],
      { repo: "o/r" },
      { runGh },
    ),
  );
  assertDeepEqual(res.requeued, []);
  assertDeepEqual(res.requeueDeclined, []);
  assertDeepEqual(res.requeueFailed, ["204"]);
  assert(
    !reopenedFor(calls, 204),
    "an unconfirmable stub must not be reopened",
  );
  assert(
    stderr.includes("::error::"),
    `expected a loud ::error:: for the failed re-queue, got: ${stderr}`,
  );
});

await test("backfill TOCTOU: a FAILING re-queue after a successful withdrawal is surfaced, never silent", async () => {
  // The label came off, so autofix selection is unblocked — but if projection
  // already passed this stub over on the stale hold, only the re-queue brings it
  // back. A re-queue that never lands is therefore its own strand, and the
  // record-run job is continue-on-error, so it must reach stderr and the summary.
  const calls = [];
  const { runGh } = makeBackfillRunGh({
    calls,
    requeueFails: true,
    scopeByNumber: {
      105: [{ fixScope: null }, { fixScope: FIX_SCOPE_MECHANICAL }],
    },
  });
  const { result: res, stderr } = await captureStderr(() =>
    backfillArchitecturalLabels(
      [architecturalSkip("105")],
      { repo: "o/r" },
      { runGh },
    ),
  );
  // The withdrawal itself succeeded — the stale hold is off.
  assertDeepEqual(res.withdrawn, ["105"]);
  assertDeepEqual(labelEdits(calls, 105), ["add", "remove"]);
  // Negative control: swallow the re-queue error (drop requeueFailed / the
  // ::error:: write) and both of these go red.
  assertDeepEqual(res.requeued, []);
  assertDeepEqual(res.requeueFailed, ["105"]);
  assert(
    stderr.includes("::error::") && stderr.includes("re-queue"),
    `expected a loud ::error:: for the failed re-queue, got: ${stderr}`,
  );
});

// --- fork-PR ownership fence across the WHOLE finalize workflow (#1810; P1) ----
//
// A branch-NAME-only read (`gh pr list --head <branch>`) returns FORK PRs too,
// and a capped page could be filled by newer fork PRs that hide our own row — so
// on this public repo anyone can push `sentry-autofix/<short-id>` on a fork and
// open a PR at main before a candidate finalizes. Every open-PR ownership lookup
// in this workflow now queries the OWNER-QUALIFIED REST head filter
// (`GET repos/${REPO}/pulls?head=${REPO%%/*}:${branch}&base=main&state=open`),
// which excludes forks server-side and pins the base the autofix leg always uses
// (GitHub's open-PR uniqueness is per head+base), and keeps the jq
// `.head.repo.fork`/owner check as defense in depth. There are THREE such reads —
// the relink-under-marker read and the dup-guard read in the "Open fix PR from a
// pristine clone" step, PLUS the read in the separate "Reconcile orphaned fix PR"
// step (an earlier revision converted only the first two and left this one on the
// truncatable `gh pr list`). These tests pin that ALL THREE carry the fence, by
// extracting the actual jq programs from the workflow and running them through
// real `jq` — not by string-matching the query, which the selector suite's own
// comments call a broken control.

const AUTOFIX_WORKFLOW = readFileSync(
  new URL("../../../.github/workflows/sentry-autofix.yml", import.meta.url),
  "utf8",
);

// Executable lines of the whole workflow (comments stripped): the workflow's
// prose explains the OLD `gh pr list` behavior, so the truncatable-read tripwire
// must not see those mentions.
function workflowCode() {
  return AUTOFIX_WORKFLOW.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// The org owner is spliced into the fence jq via a shell breakout
// (`("` + `'"${REPO%%/*}"'` + `"` -> `("mento-protocol"`), so a real jq receives
// it as a string literal. Reconstruct that EFFECTIVE program for the test.
const SHELL_OWNER_SPLICE = `'"\${REPO%%/*}"'`;

function effectiveProgram(raw, owner = "mento-protocol") {
  return raw.split(SHELL_OWNER_SPLICE).join(owner);
}

/** Every jq ownership-fence program the workflow feeds an owner-qualified
 * `gh api ... pulls` result into. Anchored on the `pulls?head=` query so the
 * unrelated `gh api /users/... --jq '.id'` read is never captured. */
function fenceProgramsIn(body) {
  const re = /pulls\?head=[\s\S]*?--jq '([\s\S]*?)'\)/g;
  const programs = [];
  for (const m of body.matchAll(re)) programs.push(m[1]);
  return programs;
}

const FORK_PR = [
  {
    html_url: "https://github.com/outsider/monitoring-monorepo/pull/9",
    head: { repo: { fork: true, owner: { login: "outsider" } } },
  },
];
// Mixed-case owner to exercise the fence's ascii_downcase.
const OWN_PR = [
  {
    html_url: "https://github.com/mento-protocol/monitoring-monorepo/pull/5",
    head: { repo: { fork: false, owner: { login: "Mento-Protocol" } } },
  },
];

function runFence(program, input, owner = "mento-protocol") {
  return execFileSync("jq", ["-r", effectiveProgram(program, owner)], {
    input: JSON.stringify(input),
    encoding: "utf8",
  }).trim();
}

await test("every open-PR lookup in the finalize workflow is owner-qualified and fenced (all THREE sites)", () => {
  const programs = fenceProgramsIn(AUTOFIX_WORKFLOW);
  assertEqual(
    programs.length,
    3,
    "the relink, dup-guard, AND reconcile-orphaned reads are each owner-qualified",
  );
  const code = workflowCode();
  // Every executable owner-qualified read pins the head branch AND base=main.
  const ownerQualified =
    code.split("pulls?head=${REPO%%/*}:${branch}&base=main&state=open").length -
    1;
  assertEqual(
    ownerQualified,
    3,
    "all three reads owner-qualify the head branch and pin base=main",
  );
  // Regression tripwire: NO fork-truncatable `gh pr list` read may remain
  // anywhere in the workflow's executable body (the reconcile step was the gap).
  assert(
    !code.includes("gh pr list"),
    "the fork-truncatable `gh pr list --head` read must not remain in the workflow",
  );
  for (const program of programs) {
    assert(
      program.includes(".head.repo.fork") &&
        program.includes(".head.repo.owner.login") &&
        program.includes("ascii_downcase"),
      "each fence checks head-repo ownership (fork == false + owner match)",
    );
  }
});

await test("fork fence: a fork PR on the autofix branch is NOT ours; our own PR is kept even behind a spoof (all THREE reads)", () => {
  const programs = fenceProgramsIn(AUTOFIX_WORKFLOW);
  // Not vacuous if a strip removes a fence: all three reads must carry one.
  assertEqual(programs.length, 3);
  for (const program of programs) {
    // Fork PR -> empty: the read finds nothing ours to relink/dedup against.
    assertEqual(runFence(program, FORK_PR), "");
    // Our own same-repo PR -> its url.
    assertEqual(runFence(program, OWN_PR), OWN_PR[0].html_url);
    // Even with a fork spoof present, the jq fence keeps only ours (defense in
    // depth over whatever rows arrive; the owner-qualified query already drops
    // forks server-side).
    assertEqual(runFence(program, [...FORK_PR, ...OWN_PR]), OWN_PR[0].html_url);
  }
});

await test("fork-fence negative control: the pre-fix bare jq TRUSTS the fork PR", () => {
  // The bare read the fix replaced (REST `.html_url` field). Run on live jq over
  // the same fork input, it returns the fork's url — which the finalize path
  // would relink the stub to or adopt as its dedup. Anchored: no shipped (fenced)
  // program is this bare jq, so a revert to it at ANY of the three reads restores
  // this trust and reds the assertions above.
  const bare = '.[0].html_url // ""';
  assertEqual(runFence(bare, FORK_PR), FORK_PR[0].html_url);
  const programs = fenceProgramsIn(AUTOFIX_WORKFLOW);
  assertEqual(programs.length, 3);
  for (const program of programs) {
    assert(
      effectiveProgram(program).replace(/\s+/g, " ").trim() !== bare,
      "the shipped fence must not be the bare, fork-trusting read",
    );
  }
});

await test("record-run inventory failure stays explicit and still reaches the upsert path", () => {
  const code = workflowCode();
  assert(
    code.includes(
      "refused_inventory_json=$(node scripts/sentry/autofix/sentry-autofix-refused-inventory.mjs",
    ),
    "record-run invokes the bounded inventory helper",
  );
  assert(
    code.includes("printf '%s\\n' '{\"state\":\"unknown\"}'"),
    "helper failure degrades to an explicit unknown result",
  );
  const renderIndex = code.indexOf(
    '--refused-inventory "${refused_inventory_json}"',
  );
  const upsertIndex = code.indexOf(
    'gh api -X PATCH "repos/${REPO}/issues/comments/${existing_id}"',
  );
  assert(renderIndex >= 0, "unknown inventory reaches run-record rendering");
  assert(
    upsertIndex > renderIndex,
    "run-record rendering precedes tracker upsert",
  );
  const body = captureCli([
    "run-record",
    "--timestamp",
    "2026-08-21T00:00:00Z",
    "--trigger",
    "schedule",
    "--disposition",
    "active",
    "--candidates",
    "0",
    "--opened",
    "0",
    "--refused",
    "0",
    "--incomplete",
    "0",
    "--refused-inventory",
    '{"state":"unknown"}',
  ]);
  assert(
    body.includes("- Refused stubs (all states): unknown"),
    "unknown result renders explicitly",
  );
});

await test("the select job's timeout-minutes is pinned to the selection caps it is sized against", () => {
  // The one change in the window/second-look work with no test at all: a bare
  // YAML scalar. `timeout-minutes` is the REAL binding constraint on this leg —
  // every gh call it makes is serial, so the worst case is wall clock, not a
  // rate limit — and the caps below are what make that worst case finite. The
  // two are a pair, and nothing connected them: reverting the timeout to its old
  // 10 would ship past every suite and then kill the job on precisely the path
  // the second look exists to create (a full window that selects nothing).
  //
  // Derived from the LIVE constants rather than restating 782, so raising a cap
  // without re-checking the budget fails here instead of in production.
  const perRunGhCalls =
    1 + // window list
    2 * MAX_CANDIDATE_EVALUATIONS + // issue view + pulls, per stub
    MAX_HANDLED_ID_QUERIES +
    MAX_REVERSE_PROBE_QUERIES +
    MAX_REVERSE_VERIFY_READS +
    1 + // the second look's own list
    2 * MAX_SECOND_LOOK_EVALUATIONS +
    SECOND_LOOK_FAMILY_BUDGETS.handled +
    SECOND_LOOK_FAMILY_BUDGETS.probe +
    SECOND_LOOK_FAMILY_BUDGETS.verify;
  // A pessimistic 1.0 s per serial call, and the documented rule that the leg
  // must fit inside 60% of the job budget so checkout, setup and latency spikes
  // have room.
  const requiredMinutes = perRunGhCalls / 60 / 0.6;

  const selectJob = /\n {2}select:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/.exec(
    `${AUTOFIX_WORKFLOW}\n  zzz:\n`,
  );
  assert(selectJob, "the select job must be locatable in the workflow");
  const timeout = /^\s{4}timeout-minutes:\s*(\d+)\s*$/m.exec(selectJob[1]);
  assert(timeout, "the select job must declare a timeout-minutes");
  assert(
    Number(timeout[1]) >= requiredMinutes,
    `select timeout-minutes is ${timeout[1]}, but the capped worst case is ${perRunGhCalls} serial gh calls = ${(perRunGhCalls / 60).toFixed(1)} min, which needs at least ${Math.ceil(requiredMinutes)} to stay under 60% of the budget`,
  );
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
