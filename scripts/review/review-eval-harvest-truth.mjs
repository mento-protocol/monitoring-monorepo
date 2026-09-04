#!/usr/bin/env node

// Harvest one answer key for the review-skill evaluation: the defects the CI
// review bots raised on a pull request's first head, with the author's
// disposition read from the reply forms this repo mandates. Replaces bench2's
// extract_truth.py, keeping its severity rule, key order and byte style. Six
// rules differ, so keys here are not byte-comparable with the 2026-08-21 ones.
// First head is the earliest submitted bot review's commit_id, else
// commits[0].sha, named in the summary. Findings are that head's bot-authored
// root comments alone, and the later-head drop count is printed because it
// moves the exam's denominator. Only the author's replies set a disposition.
// <details> blocks, HTML comments and a leading CodeRabbit badge line go before
// the title and the 2500-character body cut, while severity reads the raw body,
// where the badge lives. base_sha is the merge-base of the first head and the
// base ref fetched through --src. Pages come from `--paginate --slurp` and are
// flattened as values, not by splicing "][" out of them.
//
// Usage: --pr N (repeatable) [--out-dir DIR] [--repo owner/name] [--src, a
// checkout of --repo] [--dry-run: no file; key to stdout, summary to stderr]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_OUT_DIR = "docs/evals/review-skill-truth";
export const BOT_AUTHORS = new Set([
  "chatgpt-codex-connector[bot]",
  "claude[bot]",
  "coderabbitai[bot]",
  "cursor[bot]",
]);
const P1 = /P1|CRITICAL|High Severity|🔴|Major/;
const P2 = /P2|Medium Severity|Minor|🟡/;
const ACTED_ON = /\bFixed in\b|\bfixed in\b/;
// The apostrophe may be straight or typographic, as a curling editor writes it.
const DECLINED = /[Ww]on['’]t fix|Not applicable|not applicable/;
const DETAILS = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details\s*>/gi;
// An unterminated <details> takes the rest of the body; a stray close tag goes.
const LEFTOVER = /<details\b[^>]*>[\s\S]*$|<\/details\s*>|<!--[\s\S]*?-->/gi;
// A blank line, or CodeRabbit's badge line: `_🎯 Correctness_ | _🟡 Minor_`.
const BADGE_LINE = /^\s*$|^\s*_[^_\n]+_(?:\s*\|\s*_[^_\n]+_)+\s*$/;
const TITLE_NOISE = /<[^>]+>|[*_`#]|!\[[^\]]*\]\([^)]*\)/g;
// ensure_ascii escapes every code unit outside space..tilde, line by line so
// the serializer's own structural newlines survive.
const NON_ASCII = /[^\x20-\x7e]/g;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const esc = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
// `json.dump(obj, indent=1)` bytes, exactly: JSON.stringify agrees on layout.
export const serializeTruth = (value) =>
  JSON.stringify(value, null, 1)
    .split("\n")
    .map((line) => line.replace(NON_ASCII, esc))
    .join("\n");

// The finding statement without the noise around it. <details> blocks go
// innermost first, so nesting collapses; an all-collapsed comment is kept raw.
export function cleanBody(raw) {
  let text = raw;
  let last = null;
  while (text !== last) [last, text] = [text, text.replace(DETAILS, "")];
  const lines = text.replace(LEFTOVER, "").split("\n");
  while (lines.length > 0 && BADGE_LINE.test(lines[0])) lines.shift();
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  const clean = joined.trimEnd();
  return clean.trim() === "" ? raw.trim() : clean;
}
const isBot = (entry) => BOT_AUTHORS.has(entry?.user?.login);
const isRoot = (entry) => (entry.in_reply_to_id ?? null) === null;
/** The commit_id of the earliest submitted bot review, else commits[0].sha. */
export function selectFirstHead({ reviews, commits }) {
  const key = (r) => `${r.submitted_at}#${String(r.id ?? 0).padStart(20, "0")}`;
  const reviewed = reviews
    .filter((r) => isBot(r) && r.commit_id && r.submitted_at)
    .sort((left, right) => (key(left) < key(right) ? -1 : 1));
  const [first] = reviewed;
  if (first) return { sha: first.commit_id, source: "bot-review" };
  if (commits.length === 0) throw new Error("no commits and no bot review");
  return { sha: commits[0].sha, source: "first-commit" };
}

// Bot root comments on the first head, and how many sat on a later head. Any
// reviewer can write "Fixed in <sha>", so only the author's replies count.
export function buildFindings({ comments, head, author }) {
  const repliesTo = new Map();
  for (const reply of comments.filter((entry) => !isRoot(entry))) {
    const to = reply.in_reply_to_id;
    repliesTo.set(to, [...(repliesTo.get(to) ?? []), reply]);
  }
  const roots = comments.filter((c) => isRoot(c) && isBot(c));
  const onHead = roots.filter((c) => c.original_commit_id === head);
  const findings = onHead.map((c) => {
    const raw = c.body ?? "";
    const clean = cleanBody(raw);
    const replies = repliesTo.get(c.id) ?? [];
    const said = (re) =>
      replies.some((r) => r.user?.login === author && re.test(r.body ?? ""));
    return {
      id: c.id,
      author: c.user.login,
      path: c.path ?? null,
      line: c.line || c.original_line || null,
      severity: P1.test(raw) ? "P1" : P2.test(raw) ? "P2" : "P3",
      title: clean.split("\n")[0].replace(TITLE_NOISE, "").trim().slice(0, 150),
      acted_on: said(ACTED_ON),
      declined: said(DECLINED),
      body: clean.slice(0, 2500),
    };
  });
  return { findings, excludedLaterHead: roots.length - onHead.length };
}

export function defaultGh({ repo, apiPath, paginate }) {
  const args = ["api", `repos/${repo}/${apiPath}`];
  if (paginate) args.push("--paginate", "--slurp");
  const opts = { encoding: "utf8", maxBuffer: 2 ** 26 };
  const parsed = JSON.parse(execFileSync("gh", args, opts));
  return paginate ? parsed.flat() : parsed;
}
export const defaultGit = ({ args, cwd }) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
// The head is fetched first and the base ref last, so FETCH_HEAD names the
// base. A wrong --src shares no history with the head, so merge-base fails.
export function resolveBaseSha({ pr, sha, baseRef, src, git }) {
  if (!BRANCH.test(String(baseRef)) || String(baseRef).includes("..")) {
    throw new Error(`PR ${pr} base ref is not a usable branch: ${baseRef}`);
  }
  git({ args: ["fetch", "origin", `refs/pull/${pr}/head`], cwd: src });
  git({ args: ["fetch", "origin", `refs/heads/${baseRef}`], cwd: src });
  const merge = ["merge-base", sha, "FETCH_HEAD"];
  const base = git({ args: merge, cwd: src }).trim();
  if (!SHA.test(base)) throw new Error(`PR ${pr} merge-base gave: ${base}`);
  return base;
}

export function harvestPr({ pr, repo, src, gh, git }) {
  const page = (n) => gh({ repo, apiPath: `pulls/${pr}/${n}`, paginate: true });
  const meta = gh({ repo, apiPath: `pulls/${pr}`, paginate: false });
  const commits = page("commits");
  const author = meta.user?.login;
  if (!author) throw new Error(`PR ${pr} has no author to attribute to`);
  const baseRef = meta.base.ref;
  const reviews = page("reviews");
  const comments = page("comments");
  const { sha, source } = selectFirstHead({ reviews, commits });
  const found = buildFindings({ comments, head: sha, author });
  const findings = found.findings;
  const tally = (test) => findings.filter(test).length;
  const truth = {
    pr,
    title: meta.title,
    base: baseRef,
    base_sha: resolveBaseSha({ pr, sha, baseRef, src, git }),
    first_head: sha,
    last_head: commits[commits.length - 1].sha,
    commits: commits.length,
    reviewers: [...new Set(findings.map((f) => f.author))].sort(),
    findings,
    counts: {
      total: findings.length,
      acted_on: tally((f) => f.acted_on),
      declined: tally((f) => f.declined),
      P1: tally((f) => f.severity === "P1"),
    },
  };
  const { total, acted_on: acted, declined, P1: p1 } = truth.counts;
  const from = source === "bot-review" ? "" : " (commits[0]: no bot review)";
  const summary =
    `PR ${pr}: ${total} findings, ${acted} acted on, ${declined} declined, ` +
    `${p1} P1 | ${commits.length} commits | head ${sha.slice(0, 8)}${from} ` +
    `| ${found.excludedLaterHead} findings on later heads`;
  return { truth, summary };
}

const CLI_OPTIONS = {
  pr: { type: "string", multiple: true },
  "out-dir": { type: "string" },
  repo: { type: "string" },
  src: { type: "string" },
  "dry-run": { type: "boolean" },
};

export function runHarvest(argv, options = {}) {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS });
  const prs = [...new Set(values.pr ?? [])].map(Number);
  const ok = prs.length > 0 && prs.every((n) => Number.isInteger(n) && n > 0);
  if (!ok) throw new Error("--pr is required, repeatable, and takes a number");
  const outDir = path.resolve(REPO_ROOT, values["out-dir"] ?? DEFAULT_OUT_DIR);
  const dry = values["dry-run"] === true;
  return prs.map((pr) => {
    const { truth, summary } = harvestPr({
      pr,
      repo: values.repo ?? DEFAULT_REPO,
      src: path.resolve(process.cwd(), values.src ?? REPO_ROOT),
      gh: options.gh ?? defaultGh,
      git: options.git ?? defaultGit,
    });
    const bytes = serializeTruth(truth);
    const outPath = path.join(outDir, `pr-${pr}.json`);
    if (!dry) mkdirSync(outDir, { recursive: true });
    if (dry) process.stdout.write(bytes);
    else writeFileSync(outPath, bytes);
    (dry ? process.stderr : process.stdout).write(`${summary}\n`);
    return { truth, summary, outPath, bytes };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runHarvest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`review-eval-harvest-truth: ${error?.message}\n`);
    process.exitCode = 1;
  }
}
