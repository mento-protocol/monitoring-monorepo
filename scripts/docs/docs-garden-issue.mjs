#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  buildDocumentationInventory,
  trackedDocumentationFiles,
} from "../context/docs-index-helpers.mjs";
import { buildAuditPacket } from "./docs-audit-helpers.mjs";
import {
  buildDocsGardenIssueSpec,
  mondayForWeekSerial,
  normalizeGithubIssuePages,
  planDocsGardenIssueSync,
  resolveTargetWeekSerial,
  weekSerialForDate,
} from "./docs-garden-issue-helpers.mjs";
import {
  assertAuthorizedGardenWorkflow,
  ensureLabelsExist,
  ghPaginate,
  runGh,
} from "../lib/gh-issue-lifecycle.mjs";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";

function parseBoolean(value, name) {
  if (value == null || String(value).trim() === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

export function parseArgs(argv, env = process.env) {
  const envLane = String(env.DOCS_GARDEN_LANE ?? "").trim();
  const envShard = String(env.DOCS_GARDEN_SHARD ?? "").trim();
  const options = {
    repo: env.DOCS_GARDEN_REPO || env.GITHUB_REPOSITORY || DEFAULT_REPO,
    repoRoot: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    lane: envLane && envLane !== "auto" ? envLane : undefined,
    shard: envShard ? Number(envShard) : undefined,
    dryRun: parseBoolean(env.DOCS_GARDEN_DRY_RUN, "DOCS_GARDEN_DRY_RUN"),
    json: false,
    help: false,
  };

  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--") continue;
    if (arg === "--repo") options.repo = readValue();
    else if (arg === "--root") options.repoRoot = readValue();
    else if (arg === "--date") options.date = readValue();
    else if (arg === "--lane") {
      const lane = readValue();
      options.lane = lane === "auto" ? undefined : lane;
    } else if (arg === "--shard") options.shard = Number(readValue());
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
    throw new Error("--repo must be an owner/repository slug");
  }
  weekSerialForDate(options.date);
  if (
    options.shard !== undefined &&
    (!Number.isSafeInteger(options.shard) || options.shard <= 0)
  ) {
    throw new Error("--shard must be a positive integer");
  }
  return options;
}

function usage() {
  return `Usage: node scripts/docs/docs-garden-issue.mjs [options]

Create or retain the one bounded documentation-garden queue issue. Local
invocations are preview-only and must use --dry-run; live issue creation is
restricted to the serialized Documentation Garden GitHub Actions workflow.

Options:
  --repo OWNER/REPO   GitHub repository (default: current GITHUB_REPOSITORY)
  --root PATH         Repository root (default: current directory)
  --date YYYY-MM-DD   Deterministic current week (default: today UTC)
  --lane NAME|auto    Override the selected gardening lane
  --shard NUMBER      Override the one-based shard within that lane
  --dry-run           Read and plan, but do not create labels or issues
  --json              Print the decision as JSON
  -h, --help          Show this help

Workflow environment fallbacks: DOCS_GARDEN_REPO, DOCS_GARDEN_LANE,
DOCS_GARDEN_SHARD, DOCS_GARDEN_DRY_RUN.
`;
}

export async function listGithubIssues(options, { runner = runGh } = {}) {
  // Structural body markers own queue identity. Enumerate the complete issue
  // set so a removed routing label cannot hide a live garden item and allow a
  // duplicate. normalizeGithubIssuePages removes pull requests locally.
  const pages = await ghPaginate(`repos/${options.repo}/issues?state=all`, {
    runner,
  });
  return normalizeGithubIssuePages(pages);
}

async function defaultCreateIssue(options, spec) {
  return runGh([
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    spec.title,
    "--body",
    spec.body,
    "--label",
    spec.labels.join(","),
  ]);
}

function defaultPacketForWeekSerial(options, weekSerial) {
  const repoRoot = realpathSync(path.resolve(options.repoRoot));
  const inventory = buildDocumentationInventory({
    repoRoot,
    files: trackedDocumentationFiles(repoRoot),
  });
  if (inventory.errors.length) {
    throw new Error(
      `documentation inventory failed:\n${inventory.errors.join("\n")}`,
    );
  }
  return buildAuditPacket({
    repoRoot,
    inventory,
    date: mondayForWeekSerial(weekSerial),
    lane: options.lane,
    shard: options.shard,
    dryRun: options.dryRun,
  });
}

export async function runDocsGardenIssue(options, deps = {}) {
  const {
    listIssues = listGithubIssues,
    authorizeLiveCreation = assertAuthorizedGardenWorkflow,
    ensureLabels = ensureLabelsExist,
    createIssue = defaultCreateIssue,
    packetForWeekSerial = (weekSerial) =>
      defaultPacketForWeekSerial(options, weekSerial),
  } = deps;

  const issues = await listIssues(options);
  const targetWeekSerial = resolveTargetWeekSerial(
    weekSerialForDate(options.date),
    issues,
  );
  const packet = await packetForWeekSerial(targetWeekSerial);
  const decision = planDocsGardenIssueSync({ packet, issues });
  let mutated = false;
  let mutationResult = null;

  if (decision.action === "create" && !options.dryRun) {
    await authorizeLiveCreation(options);
    await ensureLabels(options);
    mutationResult = await createIssue(options, decision.spec);
    mutated = true;
  }

  return {
    action: decision.action,
    reason: decision.reason,
    issue_number: decision.issue?.number ?? null,
    target_week_serial: targetWeekSerial,
    selected_for: packet.selected_for,
    lane: packet.lane,
    shard: packet.shard,
    shard_count: packet.shard_count,
    fingerprint: packet.fingerprint,
    dry_run: options.dryRun,
    mutated,
    mutation_result:
      typeof mutationResult === "string" ? mutationResult.trim() || null : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runDocsGardenIssue(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Documentation garden: action=${result.action} lane=${result.lane} shard=${result.shard ?? "empty"}/${result.shard_count} selected-for=${result.selected_for} mutated=${result.mutated}\n${result.reason}\n`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`docs-garden: ${message}\n`);
    process.exitCode = 1;
  });
}

export { buildDocsGardenIssueSpec };
