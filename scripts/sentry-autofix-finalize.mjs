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
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  LABEL_DEFINITIONS,
} from "./sentry-triage-ingest.mjs";
import {
  isValidShortId,
  neutralizeBlock,
} from "./sentry-triage-project-core.mjs";

// The agent's diff may touch at most this many files — a scoped Sentry fix is
// small by construction, and a large diff is a signal the agent over-reached.
export const MAX_CHANGED_FILES = 3;

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
  // ALL of scripts/ (repo CI/tooling, incl. this autofix helper and its
  // imports) is off-limits: a Sentry runtime bug is fixed in product code
  // (ui-dashboard/, indexer-envio/, …), never in the pipeline that opens the
  // PR. This also stops the agent from editing the deterministic helper the
  // workflow later runs (defense in depth behind running those helpers only
  // from a pristine clone).
  "scripts/",
  "patches/",
  ".trunk/",
  "tools/",
];

const FORBIDDEN_BASENAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  ".npmrc",
]);

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
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  // pnpmfile variants (.pnpmfile.cjs, pnpmfile.cjs, …) anywhere in the tree.
  if (base.includes("pnpmfile")) return true;
  return false;
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
// Mechanical redaction of the agent-authored summary before it becomes public.
// Fencing (neutralizeBlock) makes the summary's markdown INERT but does not
// stop DISCLOSURE: text lands verbatim in a public PR/issue at create time,
// before any human review. The fix agent's only legitimate inputs are the
// already-public verdict comment and this repo's public code, so anything
// credential-shaped, payload-shaped, or externally-addressed in its summary is
// either an injected echo or an attempted secret exfiltration (the documented
// process-env residual) — mask it rather than publish it. Allowlist over
// blocklist for URLs: only this org's GitHub and the org's Sentry hosts
// survive; everything else is masked. Heuristic by nature (a determined
// paraphrase can evade token-shape rules), but it mechanically closes the
// high-value channels: runner tokens, long payload dumps, emails, and
// attacker-controlled links.
// ---------------------------------------------------------------------------
const SUMMARY_URL_PATTERN = /\bhttps?:\/\/[^\s)>\]"'`]+/g;
const SUMMARY_ALLOWED_URL =
  /^https:\/\/(github\.com\/mento-protocol\/|(?:[a-z0-9-]+\.)?sentry\.io\/)/;
const SUMMARY_REDACTIONS = [
  // Known credential shapes: GitHub tokens (App/installation/PAT/OAuth),
  // fine-grained PATs, Anthropic keys, Slack tokens, AWS access key ids.
  [/\b(?:ghs|ghp|gho|ghu|ghr)_[A-Za-z0-9]{16,}\b/g, "[redacted-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[redacted-token]"],
  [/\bsk-ant-[A-Za-z0-9-]{8,}\b/g, "[redacted-token]"],
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g, "[redacted-token]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[redacted-token]"],
  // Long high-entropy runs (base64/hex-alphabet, 40+ chars): token or payload
  // dump shaped. Dots and slashes break the run, so file paths survive.
  [/\b[A-Za-z0-9+=_-]{40,}\b/g, "[redacted-long-string]"],
  // Email-shaped strings (Sentry user data must never reach a public surface).
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[redacted-email]"],
];

/** Mask credential-, payload-, and user-data-shaped content plus any
 * non-allowlisted URL in the agent-authored summary. Runs BEFORE
 * neutralizeBlock (redact raw text first, then defang + bound). Exported for
 * tests. */
export function redactUntrustedSummary(text) {
  let out = String(text ?? "");
  out = out.replace(SUMMARY_URL_PATTERN, (url) =>
    SUMMARY_ALLOWED_URL.test(url) ? url : "[redacted-url]",
  );
  for (const [pattern, replacement] of SUMMARY_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * The no-PR analysis comment posted on the queue stub when the diff guard
 * refuses (empty/oversized/forbidden diff) or the agent declined to fix. The
 * deterministic `reason` leads; the agent's advisory analysis (if any) is
 * fenced so its markdown is inert and length-bounded — it is agent-authored
 * text on a public issue, so it is treated as data, not trusted prose.
 */
export function buildAnalysisComment(reason, summary) {
  const parts = ["**Autofix: no PR opened.**", "", String(reason ?? "").trim()];
  // Redact FIRST (credential/payload/user-data shapes, non-allowlisted URLs —
  // fencing alone does not stop disclosure), then neutralizeBlock (the same
  // helper the projection body uses) strips control chars, DEFANGS backticks
  // so an embedded ``` run cannot close the fence and reactivate markdown,
  // defangs @-mentions/HTML-comment openers, and bounds the length. The agent
  // summary is untrusted-influenced text on a public issue, so it must stay
  // inert AND disclosure-scrubbed.
  const bounded = neutralizeBlock(redactUntrustedSummary(summary), {
    maxLen: 2000,
    maxLines: 40,
  });
  if (bounded) {
    parts.push(
      "",
      "---",
      "",
      "Agent analysis (advisory):",
      "",
      "```text",
      bounded,
      "```",
    );
  }
  return `${parts.join("\n")}\n`;
}

// Repo-standard PR-description headings. The fix-PR body ALWAYS leads with these
// two mechanical sections (the fix PR's own required PR-description check
// enforces `## The Problem` then `## The Solution`); the agent's untrusted
// write-up is fenced separately as advisory data, never rendered as the live
// heading content.
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
 * Assemble the fix-PR body. The DETERMINISTIC template is the only mechanical
 * structure: it always leads with `## The Problem` then `## The Solution` (the
 * repo PR-description standard, enforced by the fix PR's own required check) and
 * closes with the provenance + `Fixes`/`Refs` footer.
 *
 * The agent's Problem/Solution write-up is UNTRUSTED — it is machine-generated
 * from a second-order untrusted Sentry verdict — so it is NEVER rendered as live
 * markdown. It is run through `neutralizeBlock` (backticks, @-mentions, and
 * HTML-comment openers defanged; control chars stripped; length + line bounded,
 * same bounds as the no-PR analysis comment) and embedded inside a clearly
 * labeled fenced block as inert advisory data — and, because fencing alone
 * neutralizes markdown but not DISCLOSURE, the summary is first run through
 * `redactUntrustedSummary`, which masks credential-shaped strings, long
 * high-entropy runs, email-shaped user data, and every non-allowlisted URL
 * before the text ever reaches the public PR body at `gh pr create` time. The
 * fence stays unbreakable (a `` ``` `` inside the summary is defanged, so it
 * cannot close the block and reactivate markdown), and the mechanical parts
 * stay OUTSIDE the fence so they remain trustworthy.
 */
export function buildPrBody({ shortId, queueIssue, summary }) {
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
    "- A scoped, mechanically-bounded fix is proposed in the diff; the autofix agent's own write-up is included below as advisory data.",
    "",
    SOLUTION_HEADING,
    "",
    "- A small code change addresses the triaged root cause. Review the diff against the linked Sentry issue.",
  ];

  const bounded = neutralizeBlock(redactUntrustedSummary(summary), {
    maxLen: 2000,
    maxLines: 40,
  });
  if (bounded) {
    parts.push(
      "",
      "---",
      "",
      "Agent analysis (advisory — machine-generated from an untrusted triage verdict, included as inert, mechanically-redacted data):",
      "",
      "```text",
      bounded,
      "```",
    );
  }

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
  pr-body --short-id <ID> --issue <n> [--summary-file <path>]
      Print the assembled repo-standard PR body to stdout.
  autofix-comment --url <url>
      Print the exact "Autofixed by PR: <url>" queue-stub comment.
  analysis-comment --reason <text> [--summary-file <path>]
      Print the no-PR analysis comment (guard reason + fenced agent analysis).
  branch --short-id <ID>
      Print the deterministic branch name (sentry-autofix/<short-id-lower>).
  label-def
      Print the sentry:fix-pr-opened label definition as JSON.
  refused-label-def
      Print the sentry:fix-refused label definition as JSON.
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
      const summary = readFileMaybe(readFlag(args, "--summary-file"));
      stdout.write(buildPrBody({ shortId, queueIssue: issue, summary }));
      return;
    }
    case "autofix-comment": {
      stdout.write(`${buildAutofixComment(readFlag(args, "--url"))}\n`);
      return;
    }
    case "analysis-comment": {
      const reason = readFlag(args, "--reason");
      const summary = readFileMaybe(readFlag(args, "--summary-file"));
      stdout.write(buildAnalysisComment(reason, summary));
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
