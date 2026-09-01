#!/usr/bin/env node

// review-eval-report.mjs is hash-covered under the current comparison key.
// Adapt its staleness-issue payload only at the GitHub publication boundary so
// issue instructions can use the current publication helper without re-keying
// recorded evaluation rows.

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runGh } from "../lib/gh-issue-lifecycle.mjs";
import { parseArgs, runScheduleIssue } from "./review-eval.mjs";
import { loadContract } from "./review-eval-fixtures.mjs";

const LEGACY_ACCEPTANCE =
  "- [ ] Open the ledger PR with the generated report as its body.";
const SAFE_ACCEPTANCE =
  "- [ ] Prepare the run with `review-eval-publication.mjs` and use `$PR_BODY` as the ledger PR description.";
const LEGACY_COMMANDS = [
  "pnpm review:eval:run",
  "pnpm review:eval -- --report",
].join("\n");
const SAFE_COMMANDS = [
  "pnpm review:eval:run",
  'DETAIL_DIR="docs/evals/review-skill-runs/REPLACE_WITH_RUN_DIR"',
  'PR_BODY="${TMPDIR:-/tmp}/review-eval-pr-body.md"',
  "node scripts/review/review-eval-publication.mjs \\",
  '  --detail-dir "$DETAIL_DIR" >"$PR_BODY"',
  "pnpm review:eval -- --report",
].join("\n");

function replaceLegacyOrAccept(body, legacy, replacement, field) {
  const legacyCount = body.split(legacy).length - 1;
  const replacementCount = body.split(replacement).length - 1;
  if (legacyCount === 1 && replacementCount === 0) {
    return body.replace(legacy, replacement);
  }
  if (legacyCount === 0 && replacementCount === 1) return body;
  throw new Error(
    `review-eval staleness issue ${field} drifted; expected one legacy or publication-safe block`,
  );
}

export function publicationSafeStalenessIssuePayload(payload) {
  if (!payload || typeof payload.body !== "string") {
    throw new Error("review-eval staleness issue payload needs a string body");
  }
  let body = replaceLegacyOrAccept(
    payload.body,
    LEGACY_ACCEPTANCE,
    SAFE_ACCEPTANCE,
    "acceptance criterion",
  );
  body = replaceLegacyOrAccept(
    body,
    LEGACY_COMMANDS,
    SAFE_COMMANDS,
    "verification commands",
  );
  if (
    body.includes("generated report as its body") ||
    !body.includes("review-eval-publication.mjs") ||
    !body.includes("$PR_BODY")
  ) {
    throw new Error(
      "review-eval staleness issue did not reach the publication-safe contract",
    );
  }
  return { ...payload, body };
}

export async function createPublicationSafeStalenessIssue(
  options,
  payload,
  run = runGh,
) {
  const safe = publicationSafeStalenessIssuePayload(payload);
  return run([
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    safe.title,
    "--body",
    safe.body,
    "--label",
    safe.labels.join(","),
  ]);
}

export async function runFreshnessPublication(
  argv,
  { env = process.env, ...deps } = {},
) {
  const options = parseArgs(["--schedule-issue", ...argv], env);
  const repoRoot = path.resolve(options.repoRoot);
  const { contract, digest } = loadContract(
    path.resolve(repoRoot, options.contractPath),
  );
  const { createIssue: publishIssue, ...scheduleDeps } = deps;
  const createIssue = publishIssue
    ? (nextOptions, payload) =>
        publishIssue(nextOptions, publicationSafeStalenessIssuePayload(payload))
    : createPublicationSafeStalenessIssue;
  const result = await runScheduleIssue(
    options,
    { repoRoot, contract, contractDigest: digest },
    { ...scheduleDeps, createIssue },
  );
  return { options, result };
}

function usage() {
  return `Usage: node scripts/review/review-eval-freshness-publication.mjs [--repo OWNER/REPO] [--dry-run] [--date YYYY-MM-DD] [--json]\n\nSynchronizes the LLM-free staleness issue with publication-safe PR instructions.\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const { options, result } = await runFreshnessPublication(argv);
  process.stdout.write(
    `${options.json ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `review-skill eval freshness: ${result.level} — ${result.reason}\n`,
    );
  }
  if (result.level === "red") process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`review-eval-freshness-publication: ${message}\n`);
    process.exitCode = 1;
  });
}
