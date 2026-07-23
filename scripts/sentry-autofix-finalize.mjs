#!/usr/bin/env node
/**
 * Finalize leg of the Sentry AUTOFIX pipeline (ADR 0036 Stage C, Phase 2b —
 * docs/notes/sentry-triage-pipeline.md "Autofix PRs (Phase 2b)"). PURE logic
 * only — NO gh/git I/O lives here (the workflow's finalize step does all git,
 * App-token minting, push, and PR creation in bash). This module is the
 * deterministic DECISION layer the workflow calls:
 *
 *   - `evaluateDiffGuard(files)` — the mechanical guardrail that decides whether
 *     the agent's edits may become a PR. It refuses on zero changes, more than
 *     MAX_CHANGED_FILES files, or ANY changed path under a forbidden prefix.
 *     This is a hard mechanical limit, NOT just a prompt instruction — a
 *     prompt-injected or over-eager agent cannot get a forbidden-path or
 *     oversized diff pushed.
 *   - `buildPrBody(...)` — assembles the fix-PR body from a DETERMINISTIC
 *     Problem/Solution template (splicing in `Fixes <SHORT-ID>` (Sentry
 *     release-linked auto-resolve) + `Refs #<queue issue>` + a provenance note),
 *     with the agent's untrusted write-up neutralized and fenced as inert
 *     advisory data — never rendered as live markdown, so an injected verdict
 *     cannot publish Sentry payload into the public PR body.
 *   - `buildAutofixComment(url)` — the exact `Autofixed by PR: <url>` queue-stub
 *     comment the outcome digest reads (AUTOFIX_COMMENT_PREFIX, imported from
 *     the digest so the contract can never drift).
 *   - `fixPrOpenedLabelDef()` / `fixRefusedLabelDef()` — the `sentry:fix-pr-opened`
 *     and `sentry:fix-refused` label definitions from the ingest's
 *     LABEL_DEFINITIONS (single source of truth), so the workflow can self-heal
 *     the label before applying it.
 *   - `buildAutofixRunRecordBody(...)` — the tracker run-record comment body
 *     (mirrors the ingest run record), for the workflow's always-run record job.
 *
 * Every credential is confined to the workflow's deterministic steps: the LLM
 * step holds no write token, so nothing here can be reached with agent-supplied
 * instructions as its authority.
 */

import { fileURLToPath } from "node:url";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  CODE_FIX_VERDICT_LABEL,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  LABEL_DEFINITIONS,
} from "./sentry-triage-ingest.mjs";
import {
  isValidShortId,
  selectVerdictComment,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";

// The agent's diff may touch at most this many files. A real fix commonly spans
// the change plus its tests and a couple of related call sites, so the ceiling
// is generous; but an unbounded diff is still a signal the agent over-reached,
// so it stays capped and the guard refuses beyond this. Human review + required
// CI on the fix PR are the substantive gates — this is a scope tripwire, not the
// security control (forbidden-path/symlink/credential checks are separate).
export const MAX_CHANGED_FILES = 20;

// Sentry's release-linked auto-resolve keyword. `Fixes <SHORT-ID>` in a PR
// title/description references the Sentry issue and resolves it in the release
// that ships the merge commit. Verified against Sentry docs:
// https://docs.sentry.io/product/releases/associate-commits/ (2026-07).
export const SENTRY_RESOLVE_DOCS_URL =
  "https://docs.sentry.io/product/releases/associate-commits/";

export const AUTOFIX_BRANCH_PREFIX = "sentry-autofix/";

/** Deterministic branch name for a SHORT-ID: `sentry-autofix/<short-id-lower>`.
 * The SHORT-ID charset ([A-Za-z0-9._-]) is a safe git ref after lowercasing. */
export function autofixBranchName(shortId) {
  if (!isValidShortId(shortId)) {
    throw new Error(
      `Refusing to build a branch name from invalid SHORT-ID: ${shortId}`,
    );
  }
  return `${AUTOFIX_BRANCH_PREFIX}${shortId.toLowerCase()}`;
}

// A changed path is FORBIDDEN when it matches any of these rules. This is the
// mechanical twin of the prompt's fixability guardrails — deploy/infra/CI,
// dependency-manager, and toolchain surfaces are never autofix territory.
// Prefix rules are matched against the repo-relative path; the basename rules
// catch package/lockfile/config files anywhere in the tree.
const FORBIDDEN_PREFIXES = [
  ".github/",
  "terraform/",
  "patches/",
  ".trunk/",
  "tools/",
];

// ANY `scripts/` directory at ANY depth (root repo tooling AND nested package
// helpers like ui-dashboard/scripts/): a Sentry runtime bug is fixed in
// product source, never in tooling — and several CI workflows execute
// package-local scripts from the PR head with secrets in env (e.g. the
// Lighthouse job runs ui-dashboard/scripts/* with a deploy-protection bypass
// secret), so an autofix diff must never be able to place code there. Also
// stops the agent from editing the deterministic helpers this workflow later
// runs (defense in depth behind running those only from a pristine clone).
const FORBIDDEN_SEGMENTS = new Set(["scripts"]);

const FORBIDDEN_BASENAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  ".npmrc",
  // Load-bearing for the autofix trust boundary: ui-dashboard/vercel.json
  // carries `git.deploymentEnabled: { "sentry-autofix/*": false }` (issue
  // #1452), which is what stops Vercel from building an autofix branch with
  // production secrets in scope. If autofix could edit vercel.json it could
  // re-enable its own deployment — do NOT remove this from the forbidden set.
  "vercel.json",
  "turbo.json",
]);

// CI-executed config surfaces anywhere in the tree: build/test/CI configs are
// loaded and EXECUTED by workflows and platform builds running on the PR head
// (vitest/next/playwright/tailwind configs, lighthouserc, shell scripts,
// container files, workflow/config YAML). Autofix territory is product source
// only; a config-shaped path is refused even when the fix "needs" it — that is
// a human's change to make.
//
// Terraform (*.tf/*.hcl/*.tfvars) is forbidden at ANY depth, not just the root
// terraform/ prefix: the alerts/rules, alerts/infra, governance-watchdog/infra,
// and aegis/terraform stacks live outside root terraform/, and their PR plan
// jobs EXECUTE `terraform plan` on the PR head — HCL can run arbitrary
// programs at plan time (`data "external"`) while that job holds a read-only
// plan SA (whose state-bucket access includes cleartext secret values) and a
// write-scoped checkout token. A Sentry runtime bug is never fixed in HCL.
const FORBIDDEN_BASENAME_PATTERNS = [
  /\.config\.[cm]?[jt]s$/,
  /^\.?lighthouserc/,
  /\.sh$/,
  /^Dockerfile/,
  /\.ya?ml$/,
  // Terraform in BOTH syntaxes: HCL (*.tf/*.hcl/*.tfvars) and the JSON forms
  // Terraform loads identically (*.tf.json, *.tfvars.json).
  /\.tf(\.json)?$/,
  /\.hcl(\.json)?$/,
  /\.tfvars(\.example|\.json)?$/,
];

// ---------------------------------------------------------------------------
// Filter-free change detection. The agent-tainted checkout must NEVER be read
// with git (git add/diff/status run agent-controlled clean/smudge filters and
// textconv from .gitattributes + .git/config — arbitrary code execution). We
// instead compare the tainted working tree against a PRISTINE clone using pure
// filesystem reads, which honor no git configuration at all.
// ---------------------------------------------------------------------------

// Top-level names never compared (git metadata differs between clone + checkout
// and is irrelevant to the fix). node_modules etc. are absent in the autofix job
// (no install step), so tracked source is all that remains.
const TREE_EXCLUDE = new Set([".git"]);

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Content-hash every regular file under `root` (excluding TREE_EXCLUDE at the
 * top level), keyed by root-relative path. Symlinks are skipped. Pure fs — no
 * git, so no filter/textconv/hook ever runs. */
function hashTree(root) {
  const hashes = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir === root && TREE_EXCLUDE.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) hashes.set(relative(root, full), hashFile(full));
    }
  }
  return hashes;
}

/** Root-relative paths that differ between two content-hash maps (modified,
 * added, or deleted), sorted. Pure — the caller supplies the hashed trees. */
export function diffTrees(baseHashes, workHashes) {
  const changed = new Set();
  for (const [path, hash] of workHashes) {
    if (baseHashes.get(path) !== hash) changed.add(path);
  }
  for (const path of baseHashes.keys()) {
    if (!workHashes.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/** True when a repo-relative path is off-limits for an autofix diff. */
export function isForbiddenPath(path) {
  const p = String(path ?? "").trim();
  if (p === "") return false;
  if (FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  const segments = p.split("/");
  if (segments.slice(0, -1).some((s) => FORBIDDEN_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1];
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (FORBIDDEN_BASENAME_PATTERNS.some((re) => re.test(base))) return true;
  // pnpmfile variants (.pnpmfile.cjs, pnpmfile.cjs, …) anywhere in the tree.
  if (base.includes("pnpmfile")) return true;
  return false;
}

// Credential-shaped strings that must never appear in a pushed diff. The
// documented residual lets a prompt-injected agent READ the runner's tokens
// from a process-env surface; the summary redactor closes the PR-BODY channel,
// and this scan closes the CODE channel — an agent that writes a token into an
// allowed source file gets the whole attempt refused instead of published.
// Known prefixes only (GitHub, Anthropic, Slack, AWS): entropy heuristics
// false-positive on legitimate hashes/fixtures in source code, and the
// high-value exfil target is exactly these runner credentials.
const DIFF_CREDENTIAL_PATTERNS = [
  /\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9-]{8,}\b/,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

/** Changed paths (present in the work tree as regular files) whose CONTENT
 * contains a credential-shaped string. Pure fs reads from the tainted tree —
 * no git, no execution; the guard runs credential-free from the pristine
 * clone. The refusal reason never echoes the matched value. */
export function filesWithCredentialShapedContent(workRoot, files) {
  const hits = [];
  for (const file of files) {
    const full = join(workRoot, file);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue; // deleted path — nothing to scan
    }
    if (!stat.isFile()) continue;
    let content;
    try {
      content = readFileSync(full, "latin1");
    } catch {
      continue;
    }
    if (DIFF_CREDENTIAL_PATTERNS.some((re) => re.test(content))) {
      hits.push(file);
    }
  }
  return hits;
}

/** True when `path` under `workRoot` is a symlink (lstat, so it never
 * dereferences). A genuine deletion (absent in the work tree) or an lstat error
 * is treated as NOT a symlink — the caller only cares about paths the agent
 * turned INTO a symlink. Pure lstat: no read, no git filter, no dereference. */
function isWorkTreeSymlink(workRoot, path) {
  try {
    return lstatSync(join(workRoot, path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The mechanical diff guard. Returns `{ ok: true }` when the changed-file set
 * is a legitimate scoped autofix, or `{ ok: false, reason }` otherwise. The
 * reason is posted verbatim onto the queue stub as the no-PR analysis note.
 *
 * When `workRoot` is supplied (the credential-free guard step passes the tainted
 * checkout), any changed path that is a SYMLINK in the work tree is refused. The
 * filter-free change detector intentionally does not dereference symlinks, so an
 * agent that replaces an allowed source file with a symlink (e.g. ->
 * `/proc/self/environ`) shows up only as an ordinary changed path; the later
 * credentialed byte-copy would then dereference it and publish the runner's
 * `APP_TOKEN`/`GH_TOKEN` into the public fix branch. Rejecting symlinks here —
 * before any write token is minted — closes that exfiltration path.
 */
export function evaluateDiffGuard(files, { workRoot = null } = {}) {
  const changed = (Array.isArray(files) ? files : [])
    .map((f) => String(f ?? "").trim())
    .filter(Boolean);

  if (changed.length === 0) {
    return {
      ok: false,
      reason:
        "The autofix agent made no code changes — it could not confirm a scoped code-level fix. No PR opened.",
    };
  }
  if (changed.length > MAX_CHANGED_FILES) {
    return {
      ok: false,
      reason: `The autofix diff touches ${changed.length} files (limit ${MAX_CHANGED_FILES}); a scoped fix must stay small. No PR opened.`,
    };
  }
  const forbidden = changed.filter(isForbiddenPath);
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: `The autofix diff touches forbidden path(s): ${forbidden.join(", ")}. Deploy/CI/infra, dependency-manager, and toolchain surfaces are out of scope for autofix. No PR opened.`,
    };
  }
  if (workRoot) {
    const symlinks = changed.filter((f) => isWorkTreeSymlink(workRoot, f));
    if (symlinks.length > 0) {
      return {
        ok: false,
        reason: `The autofix diff replaces path(s) with a symlink: ${symlinks.join(", ")}. Symlinked paths are refused — a symlink would be dereferenced by the credentialed byte-copy and could exfiltrate runner secrets. No PR opened.`,
      };
    }
    const credentialHits = filesWithCredentialShapedContent(workRoot, changed);
    if (credentialHits.length > 0) {
      return {
        ok: false,
        // Names the FILES, never the matched content — the reason lands on a
        // public queue issue.
        reason: `The autofix diff contains credential-shaped content in: ${credentialHits.join(", ")}. Changed files are scanned before any push because a pushed branch is public immediately — a diff carrying anything token-shaped is refused wholesale. No PR opened.`,
      };
    }
  }
  return { ok: true };
}

/** Look up a label definition from the ingest's single source of truth, failing
 * loud if the label single-source drifted. */
function labelDefByName(name) {
  const def = LABEL_DEFINITIONS.find((d) => d.name === name);
  if (!def) {
    throw new Error(
      `${name} is missing from LABEL_DEFINITIONS; the label single-source drifted.`,
    );
  }
  return def;
}

/** The `sentry:fix-pr-opened` label definition from the single source of truth
 * (ingest LABEL_DEFINITIONS), so the workflow self-heals it before labeling. */
export function fixPrOpenedLabelDef() {
  return labelDefByName(FIX_PR_OPENED_LABEL);
}

/** The `sentry:fix-refused` label definition from the same single source, so the
 * workflow's refused path self-heals it before marking a stub as refused. */
export function fixRefusedLabelDef() {
  return labelDefByName(FIX_REFUSED_LABEL);
}

/** The exact queue-stub comment the outcome digest reads to link the fix PR
 * (AUTOFIX_COMMENT_PREFIX). Body is exactly `Autofixed by PR: <url>`. */
export function buildAutofixComment(url) {
  return `${AUTOFIX_COMMENT_PREFIX}${String(url ?? "").trim()}`;
}

/** True when the queue stub STILL carries the code-fix verdict. The terminal
 * autofix marker (fix-pr-opened) must only be written while the verdict that
 * justified the diff still stands. Ingest runs on its own concurrency group and
 * can shed the verdict mid-run (a regression re-queue), so the finalize step
 * re-reads the stub's labels immediately before the marker write and calls this
 * — separate from the pre-push guard, because the push + PR-create span is a
 * second window where the verdict can vanish. Pure + exported for tests. */
export function markerWriteStillValid(labels) {
  const set = new Set(
    (Array.isArray(labels) ? labels : [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean),
  );
  return set.has(CODE_FIX_VERDICT_LABEL);
}

/** Comment posted when a fix PR OPENED this run is closed because the verdict
 * was shed during the push/PR-create span (a regression re-queue). Closing the
 * PR matters because the selector dedups on an OPEN autofix PR as well as the
 * label — leaving it open would suppress the re-fix the regression should
 * trigger. */
export function buildStaleVerdictCloseComment() {
  return (
    "Autofix withdrew this PR: the `sentry:verdict-code-fix` verdict was removed " +
    "while the fix was being pushed — most likely a regression re-queue by the " +
    "ingest workflow. The diff rested on evidence that no longer stands, so the " +
    "PR was closed rather than left open (an open autofix PR would block the " +
    "re-fix the regression should trigger). The issue is reconsidered after " +
    "re-triage.\n"
  );
}

// ---------------------------------------------------------------------------
// Tracker run record. Mirrors the ingest's rolling-comment run record
// (buildRunRecordBody / RUN_RECORD_MARKER, sentry-triage-ingest.mjs) so the
// autofix leg also leaves a durable per-run record on the pipeline tracker
// issue — the ADR 0036 observability invariant (every run leaves a record, so a
// silently-dead schedule is detectable even when the leg is disabled,
// unprovisioned, or finds zero candidates). This module only BUILDS the body
// (pure); the workflow's always-run record job does the best-effort
// rolling-comment upsert keyed by the marker below.
// ---------------------------------------------------------------------------

export const AUTOFIX_RUN_RECORD_MARKER =
  "<!-- sentry-autofix:run-record:v1 -->";

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** One-line, control-char-free rendering of a workflow-controlled label
 * (trigger/disposition are not agent/Sentry-derived, but this comment lands on
 * a public issue, so keep it single-line as defense in depth). */
function oneLine(value, fallback) {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return s || fallback;
}

/**
 * Build the autofix run-record comment body — same shape/family as the ingest
 * run record so the two rolling comments on the tracker read consistently.
 * `trigger` and `disposition` are workflow-controlled; the counters are coerced
 * to non-negative integers.
 */
export function buildAutofixRunRecordBody({
  timestampIso,
  trigger,
  disposition,
  candidates,
  opened,
  refused,
  incomplete,
}) {
  return [
    AUTOFIX_RUN_RECORD_MARKER,
    "",
    `**Sentry autofix — last run:** ${oneLine(timestampIso, "unknown")}`,
    "",
    `- Trigger: ${oneLine(trigger, "unknown")}`,
    `- State: ${oneLine(disposition, "unknown")}`,
    `- Candidates selected: ${nonNegativeInt(candidates)}`,
    `- Fix PRs opened: ${nonNegativeInt(opened)}`,
    `- Refused (no PR): ${nonNegativeInt(refused)}`,
    `- Incomplete / errored: ${nonNegativeInt(incomplete)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Agent free-text is NEVER published.
//
// The fix agent's summary is untrusted second-order Sentry data, and it runs
// with a Read tool that can reach the runner's process environment (the
// documented residual). Any pattern-based redactor is bypassable — a token can
// be fragmented across whitespace (`ghs_ABC DEF …`) so no single chunk matches
// a credential shape or a length threshold, then reconstructed by a reader.
// The only non-bypassable policy for arbitrary untrusted text on a PUBLIC
// surface is to not publish it at all. Both the fix-PR body and the no-PR
// analysis comment are therefore assembled from DETERMINISTIC text only; the
// authoritative artifact is the reviewed diff (for a fix PR) or the
// deterministic guard `reason` (for a refusal). The agent's response may remain
// in externally readable Actions run logs, so the prompt requires abstract,
// redacted responses.
// ---------------------------------------------------------------------------

/**
 * The no-PR analysis comment posted on the queue stub when the diff guard
 * refuses (empty/oversized/forbidden diff) or the agent declined to fix. Fully
 * deterministic: the guard `reason` is machine-generated, so it is safe to
 * render. No agent free-text is included (see the note above).
 */
export function buildAnalysisComment(reason) {
  return (
    [
      "**Autofix: no PR opened.**",
      "",
      String(reason ?? "").trim(),
      "",
      "_The agent's working notes are omitted by policy (untrusted-input " +
        "surface)._",
    ].join("\n") + "\n"
  );
}

// Repo-standard PR-description headings. The fix-PR body is FULLY deterministic
// (the fix PR's own required PR-description check enforces `## The Problem` then
// `## The Solution`); no agent free-text is ever included (see the note above).
const PROBLEM_HEADING = "## The Problem";
const SOLUTION_HEADING = "## The Solution";

function provenanceSection(shortId, queueIssue) {
  return [
    "## Provenance",
    "",
    "This PR was authored automatically by the Mento Sentry autofix pipeline " +
      "(ADR 0036, Phase 2b) from a triage verdict — it implements a scoped, " +
      "machine-written code fix and enters the normal review gauntlet: required " +
      "CI and independent review run on it, and **merge stays human**. Review it " +
      "as you would any other PR; the diff is mechanically bounded to a small, " +
      "scoped change.",
    "",
    `Fixes ${shortId}`,
    `Refs #${queueIssue}`,
  ].join("\n");
}

/**
 * Assemble the fix-PR body. FULLY DETERMINISTIC: the `## The Problem` /
 * `## The Solution` template (the repo PR-description standard, enforced by the
 * fix PR's own required check) plus the provenance + `Fixes`/`Refs` footer. No
 * agent free-text is included — the reviewed diff is the authoritative artifact
 * (see the note above the analysis-comment builder for why free-text passthrough
 * is unsafe on a public surface).
 */
export function buildPrBody({ shortId, queueIssue }) {
  if (!isValidShortId(shortId)) {
    throw new Error(
      `Refusing to build a PR body for invalid SHORT-ID: ${shortId}`,
    );
  }
  const issue = Number(queueIssue);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(
      `Refusing to build a PR body for invalid queue issue: ${queueIssue}`,
    );
  }

  const parts = [
    PROBLEM_HEADING,
    "",
    `- A Sentry-triaged code bug (\`${shortId}\`) was verdicted \`code-fix\` for this repo.`,
    "- The scoped, mechanically-bounded fix is in the diff of this PR.",
    "",
    SOLUTION_HEADING,
    "",
    "- A small code change addresses the triaged root cause. **Review the diff against the linked Sentry issue** — the diff is the authoritative artifact; the agent's working notes are intentionally not reproduced here (untrusted-input policy).",
  ];

  return `${parts.join("\n")}\n\n${provenanceSection(shortId, issue)}\n`;
}

// ---------------------------------------------------------------------------
// CLI — the workflow's bash finalize step calls these subcommands.
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: node scripts/sentry-autofix-finalize.mjs <command> [options]

Commands:
  diff-trees --base <dir> --work <dir>
      Print (newline-separated) the root-relative paths that differ between two
      trees, compared with pure filesystem reads (NO git — honors no agent
      filter/attribute). Used to detect the agent's changes filter-free.
  guard --files-file <path> [--work <dir>]
      Read a newline-separated changed-file list and print {"ok":bool,"reason"?}
      JSON to stdout (always exit 0 — the caller branches on .ok). With --work
      (the tainted checkout), refuse any changed path that is a symlink there.
  pr-body --short-id <ID> --issue <n>
      Print the assembled repo-standard (fully deterministic) PR body to stdout.
  autofix-comment --url <url>
      Print the exact "Autofixed by PR: <url>" queue-stub comment.
  analysis-comment --reason <text>
      Print the no-PR analysis comment (deterministic guard reason only).
  branch --short-id <ID>
      Print the deterministic branch name (sentry-autofix/<short-id-lower>).
  label-def
      Print the sentry:fix-pr-opened label definition as JSON.
  refused-label-def
      Print the sentry:fix-refused label definition as JSON.
  marker-still-valid --labels-file <path>
      Print "yes" if the stub's labels (newline-separated in the file) still
      include the code-fix verdict, else "no". Re-checked before the marker
      write to catch a mid-run regression re-queue.
  selected-verdict-id --comments-file <path>
      Print the numeric id of the currently-selected verdict comment (the #1506
      generation token), or "none". The file holds the stub's comments JSON
      (array, or an object with a .comments array). Fail-closed: prints "none"
      on any parse/selection failure so the workflow withdraws on mismatch.
  stale-verdict-close-comment
      Print the comment posted when a fix PR opened this run is closed because
      the verdict was shed during the push/PR-create span.
  run-record --timestamp <iso> --trigger <t> --disposition <d> \\
             --candidates <n> --opened <n> --refused <n> --incomplete <n>
      Print the tracker run-record comment body (rolling comment, marker-keyed).
  -h, --help
`;
}

function readFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value == null) throw new Error(`${name} requires a value`);
  return value;
}

function readFileMaybe(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function runCli(argv, { stdout = process.stdout } = {}) {
  const [command, ...args] = argv;
  switch (command) {
    case "diff-trees": {
      const base = readFlag(args, "--base");
      const work = readFlag(args, "--work");
      if (!base || !work) throw new Error("diff-trees needs --base and --work");
      const changed = diffTrees(hashTree(base), hashTree(work));
      stdout.write(changed.length ? `${changed.join("\n")}\n` : "");
      return;
    }
    case "guard": {
      const filesFile = readFlag(args, "--files-file");
      // Optional: the tainted work tree, so the guard can refuse changed paths
      // the agent turned into symlinks (credential-free, before token minting).
      const workRoot = readFlag(args, "--work");
      const files = readFileMaybe(filesFile)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      stdout.write(
        `${JSON.stringify(evaluateDiffGuard(files, { workRoot }))}\n`,
      );
      return;
    }
    case "pr-body": {
      const shortId = readFlag(args, "--short-id");
      const issue = readFlag(args, "--issue");
      stdout.write(buildPrBody({ shortId, queueIssue: issue }));
      return;
    }
    case "autofix-comment": {
      stdout.write(`${buildAutofixComment(readFlag(args, "--url"))}\n`);
      return;
    }
    case "analysis-comment": {
      const reason = readFlag(args, "--reason");
      stdout.write(buildAnalysisComment(reason));
      return;
    }
    case "branch": {
      stdout.write(`${autofixBranchName(readFlag(args, "--short-id"))}\n`);
      return;
    }
    case "label-def": {
      stdout.write(`${JSON.stringify(fixPrOpenedLabelDef())}\n`);
      return;
    }
    case "marker-still-valid": {
      // Prints "yes" if the stub still carries the code-fix verdict, else "no".
      // The workflow reads stdout (not the exit code) so a shed verdict is a
      // normal outcome, not an error.
      const labels = readFileSync(
        readFlag(args, "--labels-file"),
        "utf8",
      ).split("\n");
      stdout.write(markerWriteStillValid(labels) ? "yes\n" : "no\n");
      return;
    }
    case "selected-verdict-id": {
      // Prints the NUMERIC id of the currently-selected verdict comment (the
      // #1506 generation token), or "none" when there is no usable verdict
      // comment or the input can't be read/parsed. The workflow compares this
      // against the id select captured at dispatch: a mismatch means a re-triage
      // REPLACED the verdict (ABA) and the fix-pr-opened marker must not be
      // written. Fail CLOSED — any parse/selection failure prints "none", which
      // the workflow treats as a mismatch and withdraws.
      let comments;
      try {
        const parsed = JSON.parse(
          readFileMaybe(readFlag(args, "--comments-file")),
        );
        comments = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
      } catch {
        stdout.write("none\n");
        return;
      }
      const selected = selectVerdictComment(comments);
      const id = selected.url ? verdictCommentIdFromUrl(selected.url) : null;
      stdout.write(id && /^\d+$/.test(id) ? `${id}\n` : "none\n");
      return;
    }
    case "stale-verdict-close-comment": {
      stdout.write(buildStaleVerdictCloseComment());
      return;
    }
    case "refused-label-def": {
      stdout.write(`${JSON.stringify(fixRefusedLabelDef())}\n`);
      return;
    }
    case "run-record": {
      stdout.write(
        `${buildAutofixRunRecordBody({
          timestampIso: readFlag(args, "--timestamp"),
          trigger: readFlag(args, "--trigger"),
          disposition: readFlag(args, "--disposition"),
          candidates: readFlag(args, "--candidates"),
          opened: readFlag(args, "--opened"),
          refused: readFlag(args, "--refused"),
          incomplete: readFlag(args, "--incomplete"),
        })}\n`,
      );
      return;
    }
    case "-h":
    case "--help":
    case undefined:
      stdout.write(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
