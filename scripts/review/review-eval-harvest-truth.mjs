#!/usr/bin/env node

// Harvest one answer key for the review-skill evaluation: the defects the CI
// review bots raised on a pull request's first head, with the author's
// disposition read from the reply forms this repo mandates.
//
// This replaces the one-off bench2 `extract_truth.py`. The severity rule and
// the frozen byte style are that script's, unchanged. Six rules differ, and a
// key harvested here is therefore NOT byte-comparable with the 2026-08-21
// keys; `docs/evals/review-skill.md` records what the differences move.
//
//  1. First head is the `commit_id` of the earliest submitted bot review, not
//     `commits[0].sha`. A bot raises a finding against the head it read: on PR
//     1990, finding 3830259678 named a file absent at `commits[0]`.
//     `commits[0].sha` is the fallback when no bot reviewed the PR at all.
//  2. Findings are the bot-authored root comments on that head; bench2 kept
//     every root comment. The number dropped for sitting on a later head is
//     printed, because it is the denominator the exam is scored against.
//  3. Dispositions read only replies by the PR author (`meta.user.login`).
//     bench2 read any reply, so a bot quoting `Fixed in` set the disposition.
//  4. Title and body are derived after every `<details>` block, every HTML
//     comment marker and a leading CodeRabbit badge line are stripped, so the
//     finding statement leads instead of a collapsed analysis chain that can
//     run past the 2500-character body and past what a match judge reads.
//     Severity still reads the raw body, which is where the badge lives.
//  5. `base_sha` is `git merge-base <first head> <the PR's base ref>`, the
//     base ref fetched from `--repo` into a temporary ref in `--src`; the run
//     refuses when `--src`'s `origin` does not name `--repo`. bench2 recorded
//     `meta.base.sha`, the moving branch tip.
//  6. Pages come from `gh api --paginate --slurp` and are flattened
//     structurally. bench2 spliced `][` out of the serialized pages, which
//     corrupts any body holding that pair, such as a Markdown reference link.
//
// A relative `--out-dir` resolves against the repository root; a relative
// `--src` resolves against the current directory, being an arbitrary checkout.
//
// Usage: node scripts/review/review-eval-harvest-truth.mjs --pr 1990 [--pr N]
//   [--out-dir docs/evals/review-skill-truth] [--repo owner/name]
//   [--src <git-dir>] [--json] [--dry-run]

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_OUT_DIR = "docs/evals/review-skill-truth";

/** The four CI reviewers whose findings the evaluation scores against. */
export const BOT_AUTHORS = Object.freeze([
  "chatgpt-codex-connector[bot]",
  "claude[bot]",
  "coderabbitai[bot]",
  "cursor[bot]",
]);
const BOT_AUTHOR_SET = new Set(BOT_AUTHORS);

const SEVERITY_P1 = /P1|CRITICAL|High Severity|🔴|Major/;
const SEVERITY_P2 = /P2|Medium Severity|Minor|🟡/;
const ACTED_ON = /\bFixed in\b|\bfixed in\b/;
// The apostrophe may be straight or typographic (U+2019): a reply typed in a
// GitHub editor that curls quotes must still count as the author's decline.
const DECLINED = /[Ww]on['’]t fix|Not applicable|not applicable/;
const HTML_TAG = /<[^>]+>/g;
const TITLE_NOISE = /[*_`#]|!\[[^\]]*\]\([^)]*\)/g;
const DETAILS_TAG = /<details\b[^>]*>|<\/details\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// A blank line, or CodeRabbit's marker: `_🎯 Correctness_ | _🟡 Minor_`.
const LEADING_NOISE = /^\s*$|^\s*_[^_\n]+_(?:\s*\|\s*_[^_\n]+_)+\s*$/;
const BODY_LIMIT = 2500;
const TITLE_LIMIT = 150;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// A branch name safe to place on the right of a colon in a refspec.
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// Serializer: Python `json.dump(obj, indent=1)` bytes, exactly.

/** Encode one string the way Python's ensure_ascii encoder does. */
export function encodeJsonString(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function serializeValue(value, depth) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialize non-finite number ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return encodeJsonString(value);
  const inner = " ".repeat(depth + 1);
  const outer = " ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(
      (item) => `${inner}${serializeValue(item, depth + 1)}`,
    );
    return `[\n${items.join(",\n")}\n${outer}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, entry]) => entry !== undefined,
    );
    if (entries.length === 0) return "{}";
    const items = entries.map(
      ([key, entry]) =>
        `${inner}${encodeJsonString(key)}: ${serializeValue(entry, depth + 1)}`,
    );
    return `{\n${items.join(",\n")}\n${outer}}`;
  }
  throw new Error(`cannot serialize ${typeof value}`);
}

/** Serialize a truth object to the frozen answer-key byte style. */
export function serializeTruth(value) {
  return serializeValue(value, 0);
}

// Finding rules.

/** bench2's severity rule, read against the raw body the bot posted. */
export function classifySeverity(body) {
  const text = typeof body === "string" ? body : "";
  if (SEVERITY_P1.test(text)) return "P1";
  if (SEVERITY_P2.test(text)) return "P2";
  return "P3";
}

/**
 * Drop every `<details>` block, matching open and close tags so a nested block
 * takes its parent with it. An unterminated block takes the rest of the text.
 */
export function stripDetailsBlocks(body) {
  const text = typeof body === "string" ? body : "";
  if (text === "") return "";
  const kept = [];
  let depth = 0;
  let cursor = 0;
  DETAILS_TAG.lastIndex = 0;
  let match;
  while ((match = DETAILS_TAG.exec(text)) !== null) {
    const isOpen = match[0][1] !== "/";
    if (isOpen) {
      if (depth === 0) kept.push(text.slice(cursor, match.index));
      depth += 1;
    } else if (depth === 0) {
      // A close tag with no open tag: drop the tag, keep the text around it.
      kept.push(text.slice(cursor, match.index));
      cursor = match.index + match[0].length;
    } else {
      depth -= 1;
      if (depth === 0) cursor = match.index + match[0].length;
    }
  }
  if (depth > 0) return kept.join("");
  kept.push(text.slice(cursor));
  return kept.join("");
}

/**
 * The finding statement with the noise around it removed: `<details>` blocks,
 * HTML comment markers, and the leading CodeRabbit badge line. Idempotent, so a
 * stored body cleans to itself. A comment that is nothing but a collapsed block
 * keeps its raw text rather than becoming empty.
 */
export function cleanBody(body) {
  const raw = typeof body === "string" ? body : "";
  const stripped = stripDetailsBlocks(raw).replace(HTML_COMMENT, "");
  const lines = stripped.split("\n");
  while (lines.length > 0 && LEADING_NOISE.test(lines[0])) lines.shift();
  const cleaned = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return cleaned.trim() === "" ? raw.trim() : cleaned;
}

/** The first line of the cleaned body, without markdown or HTML decoration. */
export function deriveTitle(body) {
  return cleanBody(body)
    .split("\n")[0]
    .replace(HTML_TAG, "")
    .replace(TITLE_NOISE, "")
    .trim()
    .slice(0, TITLE_LIMIT);
}

/**
 * Only the pull request author's replies set a disposition. Any reviewer can
 * write `Fixed in <sha>`, and CodeRabbit routinely quotes the author's reply
 * back, so an unfiltered read let a bot mark a finding fixed. An unknown
 * author sets no disposition.
 */
function replyMatches(replies, author, pattern) {
  if (typeof author !== "string" || author === "") return false;
  return (Array.isArray(replies) ? replies : []).some(
    (reply) => reply?.user?.login === author && pattern.test(reply?.body ?? ""),
  );
}

export function isActedOn(replies, author) {
  return replyMatches(replies, author, ACTED_ON);
}

export function isDeclined(replies, author) {
  return replyMatches(replies, author, DECLINED);
}

function buildFinding(comment, replies, author) {
  const raw = typeof comment.body === "string" ? comment.body : "";
  return {
    id: comment.id,
    author: comment.user.login,
    path: comment.path ?? null,
    line: comment.line || comment.original_line || null,
    severity: classifySeverity(raw),
    title: deriveTitle(raw),
    acted_on: isActedOn(replies, author),
    declined: isDeclined(replies, author),
    body: cleanBody(raw).slice(0, BODY_LIMIT),
  };
}

function hasReplyParent(comment) {
  const parent = comment.in_reply_to_id;
  return parent !== null && parent !== undefined;
}

/**
 * Split the inline comments into scorable findings and the count excluded for
 * sitting on a head other than the one under review.
 */
export function buildFindings({ comments, firstHead, author }) {
  const all = Array.isArray(comments) ? comments : [];
  const repliesByRoot = new Map();
  for (const comment of all) {
    if (!hasReplyParent(comment)) continue;
    const bucket = repliesByRoot.get(comment.in_reply_to_id);
    if (bucket) bucket.push(comment);
    else repliesByRoot.set(comment.in_reply_to_id, [comment]);
  }
  const findings = [];
  let excludedLaterHead = 0;
  for (const comment of all) {
    if (hasReplyParent(comment)) continue;
    if (!BOT_AUTHOR_SET.has(comment?.user?.login)) continue;
    if (comment.original_commit_id !== firstHead) {
      excludedLaterHead += 1;
      continue;
    }
    findings.push(
      buildFinding(comment, repliesByRoot.get(comment.id) ?? [], author),
    );
  }
  return { findings, excludedLaterHead };
}

/**
 * The head the bots reviewed: the `commit_id` of the earliest submitted bot
 * review, or `commits[0].sha` when no bot reviewed this pull request.
 */
export function selectFirstHead({ reviews, commits }) {
  const botReviews = (Array.isArray(reviews) ? reviews : [])
    .filter(
      (review) =>
        BOT_AUTHOR_SET.has(review?.user?.login) &&
        typeof review?.commit_id === "string" &&
        review.commit_id.length > 0 &&
        typeof review?.submitted_at === "string" &&
        review.submitted_at.length > 0,
    )
    .sort((left, right) => {
      if (left.submitted_at !== right.submitted_at) {
        return left.submitted_at < right.submitted_at ? -1 : 1;
      }
      return (left.id ?? 0) - (right.id ?? 0);
    });
  if (botReviews.length > 0) {
    return {
      sha: botReviews[0].commit_id,
      source: "bot-review",
      review_id: botReviews[0].id ?? null,
    };
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error("pull request has no commits and no bot review");
  }
  return { sha: commits[0].sha, source: "first-commit", review_id: null };
}

// Injected process boundaries.

/** Parse one `gh api` response. Never rewrite the serialized bytes. */
export function parseGhJson(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return [];
  return JSON.parse(trimmed);
}

/**
 * Flatten `gh api --paginate --slurp`, which returns one array per page. The
 * pages are joined as values, so a body containing `][` survives intact.
 */
export function flattenPages(pages) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("gh --slurp did not return an array of page arrays");
  }
  return pages.flat();
}

export function defaultGh({ repo, apiPath, paginate }) {
  const args = ["api", `repos/${repo}/${apiPath}`];
  if (paginate) args.push("--paginate", "--slurp");
  const parsed = parseGhJson(
    execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return paginate ? flattenPages(parsed) : parsed;
}

export function defaultGit({ args, cwd }) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitPresent({ sha, src, git }) {
  try {
    git({ args: ["cat-file", "-e", `${sha}^{commit}`], cwd: src });
    return true;
  } catch {
    return false;
  }
}

/** `owner/name` for a git remote URL, in any of the forms git accepts. */
export function normalizeRemoteRepo(url) {
  const text = typeof url === "string" ? url.trim() : "";
  if (text === "") return null;
  const segments = text
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^[^/:]+[:/]/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  return segments.slice(-2).join("/").toLowerCase();
}

/**
 * Refuse when `--src` is not a checkout of `--repo`: the base ref is fetched
 * through `--src`'s `origin`, so a mismatch would take the merge-base against
 * another repository's branch of the same name.
 */
export function assertSrcMatchesRepo({ repo, src, git }) {
  let url;
  try {
    url = git({ args: ["remote", "get-url", "origin"], cwd: src }).trim();
  } catch {
    throw new Error(`--src ${src} has no origin remote to fetch ${repo} from`);
  }
  const named = normalizeRemoteRepo(url);
  if (named !== String(repo).toLowerCase()) {
    throw new Error(
      `--src ${src} origin is ${url}, which does not name ${repo}`,
    );
  }
}

function mergeBase({ sha, ref, src, git }) {
  const out = git({ args: ["merge-base", sha, ref], cwd: src }).trim();
  if (!SHA_PATTERN.test(out)) {
    throw new Error(`git merge-base returned an unusable base sha: ${out}`);
  }
  return out;
}

/**
 * `git merge-base <first head> <the PR's base ref>` in `--src`. The base ref
 * is fetched into a temporary ref, and so is the first head when that commit
 * is absent. Both refs are deleted afterwards.
 */
export function resolveBaseSha({ pr, firstHead, baseRef, repo, src, git }) {
  if (!BRANCH_PATTERN.test(String(baseRef)) || String(baseRef).includes("..")) {
    throw new Error(`PR ${pr} base ref is not a usable branch: ${baseRef}`);
  }
  assertSrcMatchesRepo({ repo, src, git });
  const suffix = randomBytes(6).toString("hex");
  const baseTemp = `refs/review-eval-harvest/pr-${pr}-base-${suffix}`;
  const headTemp = `refs/review-eval-harvest/pr-${pr}-head-${suffix}`;
  const created = [];
  try {
    git({
      args: ["fetch", "origin", `refs/heads/${baseRef}:${baseTemp}`],
      cwd: src,
    });
    created.push(baseTemp);
    if (!commitPresent({ sha: firstHead, src, git })) {
      git({
        args: ["fetch", "origin", `refs/pull/${pr}/head:${headTemp}`],
        cwd: src,
      });
      created.push(headTemp);
    }
    return mergeBase({ sha: firstHead, ref: baseTemp, src, git });
  } finally {
    for (const ref of created) {
      try {
        git({ args: ["update-ref", "-d", ref], cwd: src });
      } catch {
        process.stderr.write(
          `review-eval-harvest-truth: could not delete ${ref} in ${src}\n`,
        );
      }
    }
  }
}

// Harvest.

export function harvestPr({ pr, repo, src, gh, git }) {
  const meta = gh({ repo, apiPath: `pulls/${pr}`, paginate: false });
  const commits = gh({ repo, apiPath: `pulls/${pr}/commits`, paginate: true });
  const reviews = gh({ repo, apiPath: `pulls/${pr}/reviews`, paginate: true });
  const comments = gh({
    repo,
    apiPath: `pulls/${pr}/comments`,
    paginate: true,
  });
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error(`PR ${pr} reports no commits`);
  }
  const author = meta?.user?.login;
  if (typeof author !== "string" || author === "") {
    throw new Error(`PR ${pr} has no author login to attribute replies to`);
  }
  const head = selectFirstHead({ reviews, commits });
  const { findings, excludedLaterHead } = buildFindings({
    comments,
    firstHead: head.sha,
    author,
  });
  const baseSha = resolveBaseSha({
    pr,
    firstHead: head.sha,
    baseRef: meta.base.ref,
    repo,
    src,
    git,
  });
  const counts = {
    total: findings.length,
    acted_on: findings.filter((finding) => finding.acted_on).length,
    declined: findings.filter((finding) => finding.declined).length,
    P1: findings.filter((finding) => finding.severity === "P1").length,
  };
  const truth = {
    pr,
    title: meta.title,
    base: meta.base.ref,
    base_sha: baseSha,
    first_head: head.sha,
    last_head: commits[commits.length - 1].sha,
    commits: commits.length,
    reviewers: [...new Set(findings.map((finding) => finding.author))].sort(),
    findings,
    counts,
  };
  return {
    truth,
    summary: {
      pr,
      first_head: head.sha,
      first_head_source: head.source,
      base_sha: baseSha,
      last_head: truth.last_head,
      commits: truth.commits,
      reviewers: truth.reviewers.length,
      excluded_later_head: excludedLaterHead,
      ...counts,
    },
  };
}

export function formatSummaryLine(summary) {
  const fallback =
    summary.first_head_source === "first-commit"
      ? " | first_head from commits[0]: no bot review"
      : "";
  return (
    `PR ${summary.pr}: ${summary.total} findings ` +
    `(${summary.acted_on} acted on, ${summary.declined} declined, ` +
    `${summary.P1} P1) | ${summary.commits} commits | ` +
    `first_head ${summary.first_head.slice(0, 8)} | ` +
    `reviewers ${summary.reviewers} | ` +
    `${summary.excluded_later_head} excluded on later heads${fallback}`
  );
}

export function parseHarvestArgs(argv, { cwd = process.cwd() } = {}) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      pr: { type: "string", multiple: true },
      "out-dir": { type: "string" },
      repo: { type: "string" },
      src: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: false,
  });
  const prs = [];
  for (const raw of values.pr ?? []) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(`--pr must be a pull request number, got "${raw}"`);
    }
    const pr = Number.parseInt(raw, 10);
    if (!prs.includes(pr)) prs.push(pr);
  }
  if (prs.length === 0) {
    throw new Error("--pr is required and may be repeated");
  }
  const outDir = values["out-dir"] ?? DEFAULT_OUT_DIR;
  const src = values.src ?? REPO_ROOT;
  return {
    prs,
    outDir: path.isAbsolute(outDir) ? outDir : path.resolve(REPO_ROOT, outDir),
    repo: values.repo ?? DEFAULT_REPO,
    src: path.resolve(cwd, src),
    json: values.json === true,
    dryRun: values["dry-run"] === true,
  };
}

export function runHarvest(argv, options = {}) {
  const args = parseHarvestArgs(argv, { cwd: options.cwd });
  const gh = options.gh ?? defaultGh;
  const git = options.git ?? defaultGit;
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const writeOut = options.writeFile ?? writeFileSync;
  const makeDir =
    options.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  const summaries = [];
  for (const pr of args.prs) {
    const { truth, summary } = harvestPr({
      pr,
      repo: args.repo,
      src: args.src,
      gh,
      git,
    });
    const outPath = path.join(args.outDir, `pr-${pr}.json`);
    const bytes = serializeTruth(truth);
    if (!args.dryRun) {
      makeDir(args.outDir);
      writeOut(outPath, bytes);
    }
    summaries.push({
      ...summary,
      out_path: outPath,
      bytes: Buffer.byteLength(bytes, "utf8"),
      written: !args.dryRun,
    });
  }
  if (args.json) log(JSON.stringify(summaries, null, 2));
  else for (const summary of summaries) log(formatSummaryLine(summary));
  return summaries;
}

function isCliEntrypoint() {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  );
}

if (isCliEntrypoint()) {
  try {
    runHarvest(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`review-eval-harvest-truth: ${message}\n`);
    process.exitCode = 1;
  }
}
