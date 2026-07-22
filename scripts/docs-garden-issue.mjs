#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { buildAuditPacket } from "./docs-audit-helpers.mjs";
import {
  buildDocsGardenIssueSpec,
  LABEL_DEFINITIONS,
  mondayForWeekSerial,
  normalizeGithubIssuePages,
  planDocsGardenIssueSync,
  resolveTargetWeekSerial,
  weekSerialForDate,
} from "./docs-garden-issue-helpers.mjs";
import {
  buildDocumentationInventory,
  trackedDocumentationFiles,
} from "./docs-index-helpers.mjs";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
const GARDEN_OIDC_AUDIENCE = "mento-docs-garden";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_REQUEST_HOST_PATTERN =
  /^pipelines(?:ghub[a-z0-9]+)?\.actions\.githubusercontent\.com$/u;

function isGithubOidcRequestHost(hostname) {
  return GITHUB_OIDC_REQUEST_HOST_PATTERN.test(hostname);
}

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
  return `Usage: node scripts/docs-garden-issue.mjs [options]

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

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@#-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatGh(args) {
  return `gh ${args.map((arg) => quoteArg(String(arg))).join(" ")}`;
}

export function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`${formatGh(args)} failed: ${error.message}`));
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new Error(`${formatGh(args)} failed with exit ${status}:\n${stderr}`),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function decodeOidcClaims(token) {
  const segments = String(token ?? "").split(".");
  if (segments.length !== 3) {
    throw new Error("GitHub OIDC response did not contain a JWT");
  }
  try {
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("GitHub OIDC token payload is malformed", { cause: error });
  }
}

function audienceIncludes(audience, expected) {
  return Array.isArray(audience)
    ? audience.includes(expected)
    : audience === expected;
}

export async function assertAuthorizedGardenWorkflow(
  options,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {},
) {
  const eventName = String(env.GITHUB_EVENT_NAME ?? "");
  const workflowRef = String(env.GITHUB_WORKFLOW_REF ?? "");
  const expectedWorkflowRef = `${options.repo}/.github/workflows/documentation-garden.yml@${env.GITHUB_REF ?? ""}`;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !["schedule", "workflow_dispatch"].includes(eventName) ||
    workflowRef !== expectedWorkflowRef
  ) {
    throw new Error(
      "live issue creation is restricted to the Documentation Garden workflow; use --dry-run locally or dispatch that workflow on the default branch",
    );
  }

  const requestToken = String(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "");
  let requestUrl;
  try {
    requestUrl = new URL(String(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? ""));
  } catch (error) {
    throw new Error("GitHub Actions OIDC request URL is missing or invalid", {
      cause: error,
    });
  }
  if (
    requestUrl.protocol !== "https:" ||
    !isGithubOidcRequestHost(requestUrl.hostname) ||
    !requestToken
  ) {
    throw new Error("GitHub Actions OIDC runner credentials are unavailable");
  }
  requestUrl.searchParams.set("audience", GARDEN_OIDC_AUDIENCE);

  const response = await fetchImpl(requestUrl, {
    headers: {
      accept: "application/json",
      authorization: `bearer ${requestToken}`,
    },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Actions OIDC identity request failed with status ${response.status}`,
    );
  }
  const oidcResponse = await response.json();
  const claims = decodeOidcClaims(oidcResponse?.value);
  const nowSeconds = Math.floor(now() / 1000);
  const valid =
    claims.iss === GITHUB_OIDC_ISSUER &&
    audienceIncludes(claims.aud, GARDEN_OIDC_AUDIENCE) &&
    String(claims.repository ?? "").toLowerCase() ===
      options.repo.toLowerCase() &&
    claims.workflow === "Documentation Garden" &&
    claims.workflow_ref === expectedWorkflowRef &&
    claims.workflow_sha === env.GITHUB_SHA &&
    claims.event_name === eventName &&
    claims.ref === env.GITHUB_REF &&
    String(claims.run_id ?? "") === String(env.GITHUB_RUN_ID ?? "") &&
    String(claims.run_attempt ?? "") === String(env.GITHUB_RUN_ATTEMPT ?? "") &&
    Number(claims.nbf) <= nowSeconds + 30 &&
    Number(claims.iat) <= nowSeconds + 30 &&
    Number(claims.exp) > nowSeconds;
  if (!valid) {
    throw new Error(
      "GitHub OIDC identity does not match the active Documentation Garden workflow run",
    );
  }
  return claims;
}

export async function ghPaginate(
  apiPath,
  { perPage = 100, maxPages = 200, runner = runGh } = {},
) {
  const pages = [];
  for (let page = 1; ; page += 1) {
    if (page > maxPages) {
      throw new Error(
        `GitHub pagination exceeded ${maxPages} pages for ${apiPath}; refusing to continue silently`,
      );
    }
    const separator = apiPath.includes("?") ? "&" : "?";
    const stdout = await runner([
      "api",
      `${apiPath}${separator}per_page=${perPage}&page=${page}`,
    ]);
    const items = stdout.trim() ? JSON.parse(stdout) : [];
    if (!Array.isArray(items)) {
      throw new Error(
        `unexpected non-array GitHub API response for ${apiPath}`,
      );
    }
    if (items.length === 0) break;
    pages.push(items);
    if (items.length < perPage) break;
  }
  return pages;
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

export async function ensureLabelsExist(options, { runner = runGh } = {}) {
  const pages = await ghPaginate(`repos/${options.repo}/labels`, { runner });
  const existing = new Set(
    pages.flat().map((label) => String(label?.name ?? "")),
  );
  for (const label of LABEL_DEFINITIONS) {
    if (existing.has(label.name)) continue;
    await runner([
      "label",
      "create",
      label.name,
      "--repo",
      options.repo,
      "--color",
      label.color,
      "--description",
      label.description,
    ]);
  }
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
