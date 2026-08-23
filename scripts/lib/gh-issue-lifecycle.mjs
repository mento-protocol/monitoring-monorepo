/**
 * Shared GitHub issue-queue lifecycle primitives for scheduled automation.
 *
 * `docs-garden-issue.mjs` and `docs-navigation-eval.mjs` both keep at most one
 * open issue per cycle, and both reach that state the same way: one `gh`
 * runner, one bounded pagination guard, one Documentation Garden workflow
 * authorization, one label bootstrap, and one marker-block plus queue-state
 * arbitration. The navigation evaluation used to import the first four from
 * the garden entrypoint — the only entrypoint-imports-entrypoint edge in
 * `scripts/` — and copied the rest. Both now read them from here.
 *
 * The local Sentry projection route also reads the canonical issue-state label
 * definitions. It uses the narrowed `agent-ready` definition before create and
 * the full set before closed repair. Callers own their markers, metadata
 * validation, and decision branches. This module owns the shared lifecycle
 * label definitions and the mechanisms that were byte-identical between the
 * documentation jobs.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const GARDEN_OIDC_AUDIENCE = "mento-docs-garden";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_REQUEST_HOST_SUFFIX = ".actions.githubusercontent.com";

export const NEEDS_GROOMING_LABEL_DEFINITION = {
  name: "needs-grooming",
  color: "d876e3",
  description:
    "Needs scope, acceptance criteria, or human decision before agent work",
};

export const AGENT_READY_LABEL_DEFINITION = {
  name: "agent-ready",
  color: "0e8a16",
  description: "Ready for an agent to implement",
};

export const AGENT_ACTIVE_LABEL_DEFINITION = {
  name: "agent-active",
  color: "ffd33d",
  description:
    "An agent has claimed this issue and is working before or while opening a PR",
};

export const IN_PR_LABEL_DEFINITION = {
  name: "in-pr",
  color: "fef2c0",
  description:
    "Implementation is open in a PR; do not pick up as new agent work",
};

export const ISSUE_STATE_LABEL_DEFINITIONS = [
  NEEDS_GROOMING_LABEL_DEFINITION,
  AGENT_READY_LABEL_DEFINITION,
  AGENT_ACTIVE_LABEL_DEFINITION,
  IN_PR_LABEL_DEFINITION,
];

export const ISSUE_STATE_LABELS = ISSUE_STATE_LABEL_DEFINITIONS.map(
  (label) => label.name,
);

export const LABEL_DEFINITIONS = [
  AGENT_READY_LABEL_DEFINITION,
  {
    name: "documentation",
    color: "0075ca",
    description: "Documentation changes",
  },
  {
    name: "pkg:tooling",
    color: "5319e7",
    description: "Repository tooling and automation",
  },
  {
    name: "kind:refactor",
    color: "c5def5",
    description: "Maintenance or refactoring work",
  },
  {
    name: "source:audit",
    color: "d4c5f9",
    description: "Work generated from a deterministic audit",
  },
  {
    name: "priority:p2",
    color: "fbca04",
    description: "Normal-priority planned work",
  },
  {
    name: "risk:low",
    color: "c2e0c6",
    description: "Low-risk change",
  },
  {
    name: "risk:medium",
    color: "fef2c0",
    description: "Medium-risk change requiring normal review",
  },
];

function isGithubOidcRequestHost(hostname) {
  return hostname.endsWith(GITHUB_OIDC_REQUEST_HOST_SUFFIX);
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

export async function ensureLabelsExist(
  options,
  { runner = runGh, definitions = LABEL_DEFINITIONS } = {},
) {
  const pages = await ghPaginate(`repos/${options.repo}/labels`, { runner });
  const existing = new Set(
    pages.flat().map((label) => String(label?.name ?? "")),
  );
  for (const label of definitions) {
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

/**
 * Read the two leading HTML-comment marker lines that give a scheduled issue
 * its identity.
 *
 * Returns `undefined` — never `null` — when the first line is not the caller's
 * marker, so a hand-written issue carrying the ownership label is simply
 * untracked. A parsed payload of literal `null` is a different case: it reaches
 * the caller, whose own metadata validation rejects it. Reusing `null` for both
 * would let a malformed marker read as "not ours", hide a live issue, and let a
 * duplicate through.
 */
export function parseLeadingMarkerBlock(
  body,
  { marker, metadataPrefix, malformedMessage, invalidJsonMessage },
) {
  const lines = String(body ?? "").split(/\r?\n/);
  if (lines[0] !== marker) return undefined;
  const metadataLine = lines[1] ?? "";
  if (
    !metadataLine.startsWith(metadataPrefix) ||
    !metadataLine.endsWith(" -->")
  ) {
    throw new Error(malformedMessage);
  }
  try {
    return JSON.parse(
      metadataLine.slice(metadataPrefix.length, -" -->".length),
    );
  } catch (error) {
    throw new Error(invalidJsonMessage, { cause: error });
  }
}

function labelName(label) {
  return typeof label === "string" ? label : label?.name;
}

/**
 * Flatten paginated GitHub issue pages into the shape both schedulers plan
 * against: pull requests dropped, first occurrence of a number wins, and the
 * identity marker parsed only for issues carrying the ownership label.
 */
export function normalizeIssuePages(pages, { ownershipLabel, parseMarker }) {
  const unique = new Map();
  for (const issue of (pages ?? []).flat()) {
    if (!issue || issue.pull_request || unique.has(issue.number)) continue;
    const labels = (issue.labels ?? []).map(labelName).filter(Boolean);
    unique.set(issue.number, {
      number: issue.number,
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      state: String(issue.state ?? "").toUpperCase(),
      labels,
      url: issue.html_url ?? null,
      marker: labels.includes(ownershipLabel) ? parseMarker(issue.body) : null,
    });
  }
  return [...unique.values()];
}

export function issueStateLabels(issue) {
  return issue.labels.filter((label) => ISSUE_STATE_LABELS.includes(label));
}

/**
 * Split normalized issues into the automation-tracked set and its single open
 * member. More than one open tracked issue is never a state either scheduler
 * may plan from, so it fails closed rather than picking one.
 */
export function selectQueueIssues(issues, { kind }) {
  const tracked = issues.filter((issue) => issue.marker);
  const open = tracked.filter((issue) => issue.state === "OPEN");
  if (open.length > 1) {
    throw new Error(
      `found ${open.length} open ${kind} issues; expected at most one`,
    );
  }
  return { tracked, open: open[0] ?? null };
}

/**
 * Return the one queue state label an open scheduled issue must carry. Zero
 * labels means the issue left the queue's state machine; more than one means
 * two claims disagree. Neither is a state the schedulers may overwrite.
 */
export function requireSingleQueueState(issue, { kind }) {
  const states = issueStateLabels(issue);
  if (states.length !== 1) {
    throw new Error(
      `open ${kind} issue #${issue.number} has ${states.length} queue state labels; expected exactly one`,
    );
  }
  return states[0];
}
