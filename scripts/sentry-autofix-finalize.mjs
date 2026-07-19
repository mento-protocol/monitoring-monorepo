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
 *   - `buildPrBody(...)` — assembles the repo-standard PR body from an
 *     agent-written Problem/Solution summary, splicing in `Fixes <SHORT-ID>`
 *     (Sentry release-linked auto-resolve) + `Refs #<queue issue>` + a
 *     machine-authored provenance note. Falls back to a fully templated body
 *     when the agent's summary is missing or junk.
 *   - `buildAutofixComment(url)` — the exact `Autofixed by PR: <url>` queue-stub
 *     comment the outcome digest reads (AUTOFIX_COMMENT_PREFIX, imported from
 *     the digest so the contract can never drift).
 *   - `fixPrOpenedLabelDef()` — the `sentry:fix-pr-opened` label definition from
 *     the ingest's LABEL_DEFINITIONS (single source of truth), so the workflow
 *     can self-heal the label before applying it.
 *
 * Every credential is confined to the workflow's deterministic steps: the LLM
 * step holds no write token, so nothing here can be reached with agent-supplied
 * instructions as its authority.
 */

import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  FIX_PR_OPENED_LABEL,
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

/**
 * The mechanical diff guard. Returns `{ ok: true }` when the changed-file set
 * is a legitimate scoped autofix, or `{ ok: false, reason }` otherwise. The
 * reason is posted verbatim onto the queue stub as the no-PR analysis note.
 */
export function evaluateDiffGuard(files) {
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
  return { ok: true };
}

/** The `sentry:fix-pr-opened` label definition from the single source of truth
 * (ingest LABEL_DEFINITIONS), so the workflow self-heals it before labeling. */
export function fixPrOpenedLabelDef() {
  const def = LABEL_DEFINITIONS.find((d) => d.name === FIX_PR_OPENED_LABEL);
  if (!def) {
    throw new Error(
      `${FIX_PR_OPENED_LABEL} is missing from LABEL_DEFINITIONS; the label single-source drifted.`,
    );
  }
  return def;
}

/** The exact queue-stub comment the outcome digest reads to link the fix PR
 * (AUTOFIX_COMMENT_PREFIX). Body is exactly `Autofixed by PR: <url>`. */
export function buildAutofixComment(url) {
  return `${AUTOFIX_COMMENT_PREFIX}${String(url ?? "").trim()}`;
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
  // neutralizeBlock (the same helper the projection body uses) strips control
  // chars, DEFANGS backticks so an embedded ``` run cannot close the fence and
  // reactivate markdown, defangs @-mentions/HTML-comment openers, and bounds
  // the length. The agent summary is untrusted-influenced text on a public
  // issue, so it must stay inert.
  const bounded = neutralizeBlock(summary, { maxLen: 2000, maxLines: 40 });
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

// A usable agent summary must carry both repo-standard headings with real
// content under them. Anything else falls back to the fully templated body so a
// blank/junk summary can never produce an empty or malformed PR description.
const PROBLEM_HEADING = "## The Problem";
const SOLUTION_HEADING = "## The Solution";

/** True when the agent-written summary has both required headings and some
 * non-heading content — otherwise the caller uses the templated fallback. */
export function isUsableSummary(text) {
  const raw = String(text ?? "");
  if (!raw.includes(PROBLEM_HEADING) || !raw.includes(SOLUTION_HEADING)) {
    return false;
  }
  // Require some non-blank, non-heading line so "## The Problem\n## The
  // Solution" alone is rejected.
  const meaningful = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return meaningful.length > 0;
}

/** Strip control chars and hard-bound the agent summary before it lands in a PR
 * body. It is agent-authored text; this is defense in depth (the PR still goes
 * through human + required-CI review), not the trust boundary. */
function boundSummary(text, { maxLen = 4000 } = {}) {
  let s = String(text ?? "")
    // eslint-disable-next-line no-control-regex -- strip control chars from agent text; keep \n + \t
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "")
    .trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen).trimEnd()}…`;
  return s;
}

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
 * Assemble the repo-standard PR body. When the agent's Problem/Solution summary
 * is usable it leads (so the body starts with `## The Problem`, per the repo PR
 * standard); otherwise a fully templated Problem/Solution is used. Either way
 * the provenance + `Fixes`/`Refs` footer is appended deterministically.
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

  let head;
  if (isUsableSummary(summary)) {
    head = boundSummary(summary);
  } else {
    head = [
      PROBLEM_HEADING,
      "",
      `- A Sentry-triaged code bug (\`${shortId}\`) was verdicted \`code-fix\` for this repo.`,
      "- The autofix agent implemented a scoped fix but did not leave a usable Problem/Solution summary.",
      "",
      SOLUTION_HEADING,
      "",
      "- A small, mechanically-bounded code change addresses the triaged root cause. See the diff for specifics and confirm against the linked Sentry issue.",
    ].join("\n");
  }

  return `${head}\n\n${provenanceSection(shortId, issue)}\n`;
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
  guard --files-file <path>
      Read a newline-separated changed-file list and print {"ok":bool,"reason"?}
      JSON to stdout (always exit 0 — the caller branches on .ok).
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
      const files = readFileMaybe(filesFile)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      stdout.write(`${JSON.stringify(evaluateDiffGuard(files))}\n`);
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
