/**
 * Trusted host half of the local-agent GitHub App boundary.
 *
 * The installed broker owns token minting and execution. The agent sends one
 * validated operation. The broker calls one fixed GitHub REST endpoint and
 * returns one normalized response. It never writes a credential to stdout,
 * stderr, argv, a file, returned JSON, or a caller-controlled child.
 */

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientFailure,
  EXACT_REPOSITORY,
  FORBIDDEN_AMBIENT_ENV,
  PROFILE,
  TRUSTED_PROFILES,
  parseStructuredOperation,
} from "./local-agent-github-command-policy.mjs";

export const BROKER_INSTALL_PATH =
  "/usr/local/libexec/mento-local-agent-github-broker";
export const BROKER_MODULE_INSTALL_PATH =
  "/usr/local/libexec/mento-local-agent-github-broker.mjs";
export const BROKER_POLICY_INSTALL_PATH =
  "/usr/local/libexec/mento-local-agent-github-command-policy.mjs";
export const BROKER_NODE_PATH =
  "/usr/local/libexec/mento-node-runtime/bin/node";
export const BROKER_NODE_ROOT = "/usr/local/libexec/mento-node-runtime";
export const GCLOUD_SDK_ROOT = "/usr/local/libexec/google-cloud-sdk";
export const GCLOUD_PATH = `${GCLOUD_SDK_ROOT}/bin/gcloud`;
export const GCLOUD_PYTHON_ROOT = "/usr/local/libexec/mento-python-runtime";
export const GCLOUD_PYTHON_PATH = `${GCLOUD_PYTHON_ROOT}/bin/python3`;
export const BROKER_OPERATION_CWD = "/var/empty";
export const BROKER_OS_USER = "mento-github-broker";
export const GCP_PROJECT_ID = "mento-monitoring";
export const GCP_BROKER_SERVICE_ACCOUNT =
  "local-agent-github-broker@mento-monitoring.iam.gserviceaccount.com";
export const PRIVATE_KEY_SECRET_ID = "local-agent-github-app-private-key";
export const REPOSITORY_NAME = "monitoring-monorepo";
export const REPOSITORY_FULL_NAME = EXACT_REPOSITORY;
export const GITHUB_API_VERSION = "2022-11-28";
export const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_TRUSTED_RUNTIME_ENTRIES = 100_000;

const API_ROOT = "https://api.github.com";
const REPOSITORY_API_PATH = `/repos/${REPOSITORY_FULL_NAME}`;
const REPOSITORY_WEB_PATH = `/${REPOSITORY_FULL_NAME}`;
const EXEC_ENV = Object.freeze({ ...process.env });

export const FIXED_BROKER_ENV = Object.freeze({
  HOME: "/var/lib/mento-github-broker",
  LANG: "C",
  LC_ALL: "C",
  LOGNAME: "mento-github-broker",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/var/lib/mento-github-broker/tmp",
  USER: "mento-github-broker",
  CLOUDSDK_CONFIG: "/var/lib/mento-github-broker/gcloud",
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  CLOUDSDK_CORE_LOG_HTTP: "false",
  CLOUDSDK_CORE_VERBOSITY: "error",
  CLOUDSDK_PYTHON: GCLOUD_PYTHON_PATH,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONNOUSERSITE: "1",
  PYTHONSAFEPATH: "1",
});

export const INSTALLATION_PERMISSIONS = Object.freeze({
  [PROFILE.READ]: Object.freeze({
    actions: "read",
    issues: "read",
    pull_requests: "read",
  }),
  [PROFILE.PR_ISSUE]: Object.freeze({
    issues: "write",
    pull_requests: "write",
  }),
  [PROFILE.GIT_PUBLICATION]: Object.freeze({
    contents: "write",
  }),
  [PROFILE.ISSUE_BOARD]: Object.freeze({
    issues: "write",
  }),
});

class BrokerFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "BrokerFailure";
  }
}

function fail(message) {
  throw new BrokerFailure(message);
}

function safeFileStat(value) {
  return (
    value.isFile() &&
    value.isSymbolicLink?.() !== true &&
    value.uid === 0 &&
    (value.mode & 0o022) === 0
  );
}

function safeDirectoryStat(value) {
  return (
    value.isDirectory() &&
    value.isSymbolicLink?.() !== true &&
    value.uid === 0 &&
    (value.mode & 0o022) === 0
  );
}

function safePrivateDirectoryStat(value, effectiveUid) {
  return (
    value.isDirectory() &&
    value.isSymbolicLink?.() !== true &&
    value.uid === effectiveUid &&
    (value.mode & 0o077) === 0
  );
}

function trustedTreeEntryName(entry) {
  const name = typeof entry === "string" ? entry : entry?.name;
  if (
    typeof name !== "string" ||
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    fail("a trusted runtime tree contained an invalid entry");
  }
  return name;
}

export async function verifyRootOwnedRuntimeTree(
  root,
  { inspect = lstat, list = readdir } = {},
) {
  const pending = [root];
  let entriesSeen = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await list(directory, { withFileTypes: true });
    } catch {
      fail("a trusted runtime tree could not be read");
    }
    if (!Array.isArray(entries)) {
      fail("a trusted runtime tree could not be read");
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_TRUSTED_RUNTIME_ENTRIES) {
        fail("a trusted runtime tree exceeded its entry bound");
      }
      const child = path.join(directory, trustedTreeEntryName(entry));
      let stats;
      try {
        stats = await inspect(child);
      } catch {
        fail("a trusted runtime tree could not be inspected");
      }
      if (safeDirectoryStat(stats)) {
        pending.push(child);
      } else if (!safeFileStat(stats)) {
        fail("a trusted runtime tree ownership/mode is unsafe");
      }
    }
  }
}

export async function verifyTrustedRuntimePaths({
  inspect = lstat,
  list = readdir,
  effectiveUid = () => process.getuid?.(),
} = {}) {
  const files = [
    BROKER_INSTALL_PATH,
    BROKER_MODULE_INSTALL_PATH,
    BROKER_POLICY_INSTALL_PATH,
    BROKER_NODE_PATH,
    GCLOUD_PATH,
    GCLOUD_PYTHON_PATH,
  ];
  const directories = [
    "/usr/local",
    "/usr/local/libexec",
    BROKER_NODE_ROOT,
    `${BROKER_NODE_ROOT}/bin`,
    GCLOUD_SDK_ROOT,
    `${GCLOUD_SDK_ROOT}/bin`,
    GCLOUD_PYTHON_ROOT,
    `${GCLOUD_PYTHON_ROOT}/bin`,
    "/var/lib/mento-github-broker",
    BROKER_OPERATION_CWD,
  ];
  const privateDirectories = [
    FIXED_BROKER_ENV.CLOUDSDK_CONFIG,
    FIXED_BROKER_ENV.TMPDIR,
  ];
  let fileStats;
  let directoryStats;
  let privateDirectoryStats;
  let brokerUid;
  try {
    brokerUid = effectiveUid();
    if (!Number.isSafeInteger(brokerUid) || brokerUid <= 0) {
      fail("the trusted broker OS identity is unavailable");
    }
    [fileStats, directoryStats, privateDirectoryStats] = await Promise.all([
      Promise.all(files.map((value) => inspect(value))),
      Promise.all(directories.map((value) => inspect(value))),
      Promise.all(privateDirectories.map((value) => inspect(value))),
    ]);
  } catch {
    fail("trusted broker runtime paths are not installed");
  }
  if (fileStats.some((value) => !safeFileStat(value))) {
    fail("a trusted broker executable ownership/mode is unsafe");
  }
  if (directoryStats.some((value) => !safeDirectoryStat(value))) {
    fail("a trusted broker directory ownership/mode is unsafe");
  }
  if (
    privateDirectoryStats.some(
      (value) => !safePrivateDirectoryStat(value, brokerUid),
    )
  ) {
    fail("a private broker directory ownership/mode is unsafe");
  }
  for (const root of [BROKER_NODE_ROOT, GCLOUD_SDK_ROOT, GCLOUD_PYTHON_ROOT]) {
    await verifyRootOwnedRuntimeTree(root, { inspect, list });
  }
}

export function assertBrokerEnvironment(env = EXEC_ENV) {
  for (const name of FORBIDDEN_AMBIENT_ENV) {
    if (Object.hasOwn(env, name)) fail(`refusing inherited ${name}`);
  }
  if (String(env.GITHUB_ACTIONS ?? "").toLowerCase() === "true") {
    fail("the host broker cannot run in GitHub Actions");
  }
  for (const [name, expected] of Object.entries(FIXED_BROKER_ENV)) {
    if (env[name] !== expected) fail(`broker launcher did not fix ${name}`);
  }
  const allowed = new Set(Object.keys(FIXED_BROKER_ENV));
  for (const name of Object.keys(env)) {
    if (!allowed.has(name)) fail(`broker launcher passed unexpected ${name}`);
  }
}

function positiveSafeInteger(name, raw) {
  if (!/^[1-9][0-9]*$/u.test(String(raw ?? ""))) {
    fail(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail(`${name} must be a positive safe integer`);
  }
  return value;
}

function flagValue(flags, index, flag) {
  const value = flags[index + 1];
  if (value === undefined || value === "") fail(`${flag} requires a value`);
  return value;
}

export function parseBrokerArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    fail("the broker requires one structured operation");
  }
  const result = {
    appId: null,
    installationId: null,
    profile: "",
    operation: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
  const flags = argv.slice(0, separator);
  const seen = new Set();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (seen.has(flag)) fail("a broker flag may be supplied once");
    seen.add(flag);
    if (flag === "--app-id") {
      result.appId = positiveSafeInteger(flag, flagValue(flags, index, flag));
      index += 1;
    } else if (flag === "--installation-id") {
      result.installationId = positiveSafeInteger(
        flag,
        flagValue(flags, index, flag),
      );
      index += 1;
    } else if (flag === "--profile") {
      result.profile = flagValue(flags, index, flag);
      index += 1;
    } else {
      fail("unsupported broker argument");
    }
  }
  if (result.appId === null || result.installationId === null) {
    fail("--app-id and --installation-id are required");
  }
  if (!TRUSTED_PROFILES.includes(result.profile)) {
    fail("one fixed broker profile is required");
  }
  return {
    ...result,
    parameters: parseStructuredOperation(
      result.profile,
      result.operation,
      result.args,
    ),
  };
}

export function requestedPermissions({ profile }) {
  const permissions = INSTALLATION_PERMISSIONS[profile];
  if (!permissions) fail("unknown broker permission profile");
  return { ...permissions };
}

function execFileBuffered(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (Buffer.isBuffer(stderr)) stderr.fill(0);
      if (error) {
        if (Buffer.isBuffer(stdout)) stdout.fill(0);
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function readPrivateKey({ runFile = execFileBuffered } = {}) {
  let output;
  try {
    output = await runFile(
      GCLOUD_PATH,
      [
        "--quiet",
        `--project=${GCP_PROJECT_ID}`,
        `--impersonate-service-account=${GCP_BROKER_SERVICE_ACCOUNT}`,
        "secrets",
        "versions",
        "access",
        "latest",
        `--secret=${PRIVATE_KEY_SECRET_ID}`,
      ],
      {
        cwd: BROKER_OPERATION_CWD,
        encoding: null,
        env: { ...FIXED_BROKER_ENV },
        maxBuffer: MAX_SECRET_BYTES,
        shell: false,
        windowsHide: true,
      },
    );
  } catch {
    fail("Secret Manager access failed");
  }

  const key = Buffer.isBuffer(output)
    ? output
    : Buffer.from(String(output ?? ""), "utf8");
  const pkcs1 =
    key.includes(Buffer.from("-----BEGIN RSA PRIVATE KEY-----")) &&
    key.includes(Buffer.from("-----END RSA PRIVATE KEY-----"));
  const pkcs8 =
    key.includes(Buffer.from("-----BEGIN PRIVATE KEY-----")) &&
    key.includes(Buffer.from("-----END PRIVATE KEY-----"));
  if (key.length === 0 || key.length > MAX_SECRET_BYTES || (!pkcs1 && !pkcs8)) {
    key.fill(0);
    fail("Secret Manager returned an invalid App private key");
  }
  return key;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signRs256(signingInput, privateKey) {
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return signer.sign(privateKey);
}

export function createAppJwt({
  appId,
  privateKey,
  nowSeconds = Math.floor(Date.now() / 1000),
  sign = signRs256,
}) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: String(appId),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign(signingInput, privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function samePermissions(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const normalized = { ...actual };
  if (normalized.metadata === "read") delete normalized.metadata;
  return (
    JSON.stringify(Object.entries(normalized).sort()) ===
    JSON.stringify(Object.entries(expected).sort())
  );
}

function exactRepositoryScope(payload) {
  return (
    payload?.total_count === 1 &&
    Array.isArray(payload.repositories) &&
    payload.repositories.length === 1 &&
    payload.repositories[0]?.full_name === REPOSITORY_FULL_NAME
  );
}

async function readBoundedResponse(response, classification) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== undefined && contentLength !== null) {
    if (!/^[0-9]+$/u.test(contentLength)) {
      fail(`${classification} response had an invalid length`);
    }
    if (Number(contentLength) > MAX_RESPONSE_BYTES) {
      fail(`${classification} response was too large`);
    }
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          chunk.fill(0);
          await reader.cancel().catch(() => {});
          fail(`${classification} response was too large`);
        }
        chunks.push(chunk);
      }
      const combined = Buffer.concat(chunks, length);
      const text = combined.toString("utf8");
      combined.fill(0);
      return text;
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }

  let text;
  try {
    text = await response.text();
  } catch {
    fail(`${classification} response could not be read`);
  }
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    fail(`${classification} response was too large`);
  }
  return text;
}

async function readJsonResponse(response, classification) {
  const text = await readBoundedResponse(response, classification);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${classification} response was malformed`);
  }
}

export async function exchangeInstallationToken({
  installationId,
  jwt,
  permissions,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  let response;
  try {
    response = await fetchImpl(
      `${API_ROOT}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "User-Agent": "monitoring-monorepo-local-agent-broker",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          repositories: [REPOSITORY_NAME],
          permissions,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    fail("GitHub installation-token request failed");
  }
  const status = checkedHttpStatus(response, "GitHub installation-token");
  if (status !== 201) {
    fail(`GitHub installation-token request returned HTTP ${status}`);
  }

  const payload = await readJsonResponse(response, "GitHub installation-token");
  const token = payload?.token;
  if (!/^ghs_[A-Za-z0-9._-]{20,4096}$/u.test(String(token ?? ""))) {
    fail("GitHub installation-token response had no valid token");
  }
  const expiresAt = Date.parse(payload.expires_at);
  const remainingMs = expiresAt - nowMs;
  if (
    !Number.isFinite(expiresAt) ||
    remainingMs < 50 * 60 * 1000 ||
    remainingMs > 61 * 60 * 1000
  ) {
    fail("GitHub installation-token expiry was outside the one-hour bound");
  }
  if (!samePermissions(payload.permissions, permissions)) {
    fail("GitHub installation-token permissions did not match the request");
  }
  if (payload.repository_selection !== "selected") {
    fail("GitHub installation token did not report selected repositories");
  }
  const repositoryScope = await performGithubRequest(
    {
      method: "GET",
      path: "/installation/repositories?per_page=2",
      statuses: [200],
    },
    token,
    fetchImpl,
    "GitHub installation-token scope",
  );
  if (!exactRepositoryScope(repositoryScope)) {
    fail("GitHub installation token was not scoped to the expected repository");
  }
  return token;
}

function listQuery(parameters) {
  return new URLSearchParams({
    state: parameters.state,
    per_page: String(parameters.limit),
  }).toString();
}

function runListQuery(parameters) {
  return new URLSearchParams({
    per_page: String(parameters.limit),
  }).toString();
}

export function buildOperationRequest(operation, parameters) {
  switch (operation) {
    case "repo-view":
      return { method: "GET", path: REPOSITORY_API_PATH, statuses: [200] };
    case "issue-view":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/issues/${parameters.number}`,
        statuses: [200],
      };
    case "issue-list":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/issues?${listQuery(parameters)}`,
        statuses: [200],
      };
    case "pr-view":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/pulls/${parameters.number}`,
        statuses: [200],
      };
    case "pr-list":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/pulls?${listQuery(parameters)}`,
        statuses: [200],
      };
    case "run-view":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/actions/runs/${parameters.runId}`,
        statuses: [200],
      };
    case "run-list":
      return {
        method: "GET",
        path: `${REPOSITORY_API_PATH}/actions/runs?${runListQuery(parameters)}`,
        statuses: [200],
      };
    case "issue-comment":
    case "pr-comment":
      return {
        method: "POST",
        path: `${REPOSITORY_API_PATH}/issues/${parameters.number}/comments`,
        body: { body: parameters.body },
        statuses: [201],
      };
    case "issue-create":
      return {
        method: "POST",
        path: `${REPOSITORY_API_PATH}/issues`,
        body: { title: parameters.title, body: parameters.body },
        statuses: [201],
      };
    case "pr-create":
      return {
        method: "POST",
        path: `${REPOSITORY_API_PATH}/pulls`,
        body: {
          head: parameters.head,
          base: parameters.base,
          title: parameters.title,
          body: parameters.body,
        },
        statuses: [201],
      };
    case "issue-close":
    case "issue-reopen":
      return {
        method: "PATCH",
        path: `${REPOSITORY_API_PATH}/issues/${parameters.number}`,
        body: { state: operation === "issue-close" ? "closed" : "open" },
        statuses: [200],
      };
    case "pr-close":
    case "pr-reopen":
      return {
        method: "PATCH",
        path: `${REPOSITORY_API_PATH}/pulls/${parameters.number}`,
        body: { state: operation === "pr-close" ? "closed" : "open" },
        statuses: [200],
      };
    case "pr-review": {
      const events = {
        comment: "COMMENT",
        "request-changes": "REQUEST_CHANGES",
      };
      return {
        method: "POST",
        path: `${REPOSITORY_API_PATH}/pulls/${parameters.number}/reviews`,
        body: { event: events[parameters.decision], body: parameters.body },
        statuses: [200],
      };
    }
    default:
      fail("the structured GitHub operation has no active endpoint");
  }
}

export function buildTargetValidationRequest(operation, parameters) {
  if (["issue-close", "issue-comment", "issue-reopen"].includes(operation)) {
    return {
      kind: "issue",
      method: "GET",
      path: `${REPOSITORY_API_PATH}/issues/${parameters.number}`,
      statuses: [200],
    };
  }
  if (operation === "pr-comment") {
    return {
      kind: "pull-request",
      method: "GET",
      path: `${REPOSITORY_API_PATH}/pulls/${parameters.number}`,
      statuses: [200],
    };
  }
  return null;
}

function responseObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseArray(value, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseText(value, maximum = 2048) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > maximum ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return point === 0 || point === 0x7f;
    })
  ) {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseBoolean(value) {
  if (typeof value !== "boolean") {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseState(value) {
  if (value !== "open" && value !== "closed") {
    fail("GitHub operation response was malformed");
  }
  return value;
}

function responseTimestamp(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  const timestamp = Date.parse(responseText(value, 64));
  if (!Number.isFinite(timestamp)) {
    fail("GitHub operation response was malformed");
  }
  return new Date(timestamp).toISOString();
}

function responseUrl(value) {
  const raw = responseText(value, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("GitHub operation response was malformed");
  }
  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== REPOSITORY_WEB_PATH &&
      !url.pathname.startsWith(`${REPOSITORY_WEB_PATH}/`))
  ) {
    fail("GitHub operation response was outside the selected repository");
  }
  return url.toString();
}

function normalizeLabels(value) {
  return responseArray(value).map((entry) => {
    const label = responseObject(entry);
    return responseText(label.name, 100);
  });
}

function normalizeAssignees(value) {
  return responseArray(value).map((entry) => {
    const assignee = responseObject(entry);
    return responseText(assignee.login, 100);
  });
}

function normalizeRepository(value) {
  const repository = responseObject(value);
  if (repository.full_name !== REPOSITORY_FULL_NAME) {
    fail("GitHub operation response was outside the selected repository");
  }
  const visibility = responseText(repository.visibility, 16);
  if (!new Set(["internal", "private", "public"]).has(visibility)) {
    fail("GitHub operation response was malformed");
  }
  return {
    nameWithOwner: REPOSITORY_FULL_NAME,
    defaultBranch: responseText(repository.default_branch, 256),
    visibility,
    archived: responseBoolean(repository.archived),
  };
}

function normalizeIssue(value, { requireIssue = false } = {}) {
  const issue = responseObject(value);
  const isPullRequest = Object.hasOwn(issue, "pull_request");
  if (requireIssue && isPullRequest) {
    fail("GitHub operation response was not an issue");
  }
  return {
    number: responseId(issue.number),
    title: responseText(issue.title, 512),
    state: responseState(issue.state),
    url: responseUrl(issue.html_url),
    labels: normalizeLabels(issue.labels),
    assignees: normalizeAssignees(issue.assignees),
    isPullRequest,
  };
}

function normalizePullRequest(value) {
  const pullRequest = responseObject(value);
  let mergeable = null;
  if (pullRequest.mergeable !== undefined && pullRequest.mergeable !== null) {
    mergeable = responseBoolean(pullRequest.mergeable);
  }
  let merged;
  if (typeof pullRequest.merged === "boolean") {
    merged = pullRequest.merged;
  } else {
    merged =
      pullRequest.merged_at !== undefined && pullRequest.merged_at !== null;
  }
  return {
    number: responseId(pullRequest.number),
    title: responseText(pullRequest.title, 512),
    state: responseState(pullRequest.state),
    url: responseUrl(pullRequest.html_url),
    isDraft: responseBoolean(pullRequest.draft),
    headRefName: responseText(responseObject(pullRequest.head).ref, 256),
    baseRefName: responseText(responseObject(pullRequest.base).ref, 256),
    mergeable,
    merged,
  };
}

function nullableResponseText(value, maximum) {
  return value === null ? null : responseText(value, maximum);
}

function normalizeRun(value) {
  const run = responseObject(value);
  const headSha = responseText(run.head_sha, 64);
  if (!/^[0-9a-f]{7,64}$/u.test(headSha)) {
    fail("GitHub operation response was malformed");
  }
  return {
    id: responseId(run.id),
    name: nullableResponseText(run.name, 256),
    event: responseText(run.event, 64),
    status: responseText(run.status, 64),
    conclusion: nullableResponseText(run.conclusion, 64),
    url: responseUrl(run.html_url),
    headBranch: nullableResponseText(run.head_branch, 256),
    headSha,
    createdAt: responseTimestamp(run.created_at),
    updatedAt: responseTimestamp(run.updated_at),
  };
}

function normalizeComment(value) {
  const comment = responseObject(value);
  return {
    id: responseId(comment.id),
    url: responseUrl(comment.html_url),
    createdAt: responseTimestamp(comment.created_at),
  };
}

function normalizeReview(value) {
  const review = responseObject(value);
  return {
    id: responseId(review.id),
    state: responseText(review.state, 32),
    url: responseUrl(review.html_url),
    submittedAt: responseTimestamp(review.submitted_at, { allowNull: true }),
  };
}

function normalizeOperationResponse(operation, payload, parameters) {
  switch (operation) {
    case "repo-view":
      return normalizeRepository(payload);
    case "issue-view":
      return normalizeIssue(payload, { requireIssue: true });
    case "issue-list":
      return responseArray(payload, parameters.limit)
        .filter((item) => !Object.hasOwn(responseObject(item), "pull_request"))
        .map((item) => normalizeIssue(item, { requireIssue: true }));
    case "pr-view":
    case "pr-create":
    case "pr-close":
    case "pr-reopen":
      return normalizePullRequest(payload);
    case "pr-list":
      return responseArray(payload, parameters.limit).map(normalizePullRequest);
    case "run-view":
      return normalizeRun(payload);
    case "run-list": {
      const runs = responseArray(
        responseObject(payload).workflow_runs,
        parameters.limit,
      );
      return runs.map(normalizeRun);
    }
    case "issue-comment":
    case "pr-comment":
      return normalizeComment(payload);
    case "issue-create":
    case "issue-close":
    case "issue-reopen":
      return normalizeIssue(payload, { requireIssue: true });
    case "pr-review":
      return normalizeReview(payload);
    default:
      fail("the structured GitHub operation has no response schema");
  }
}

function checkedHttpStatus(response, classification) {
  const status = response?.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    fail(`${classification} response was malformed`);
  }
  return status;
}

async function performGithubRequest(
  request,
  token,
  fetchImpl,
  classification = "GitHub operation",
) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "monitoring-monorepo-local-agent-broker",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const requestOptions = {
    method: request.method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(request.body);
  }

  let response;
  try {
    response = await fetchImpl(`${API_ROOT}${request.path}`, requestOptions);
  } catch {
    fail(`${classification} request failed`);
  }
  const status = checkedHttpStatus(response, classification);
  if (!request.statuses.includes(status)) {
    fail(`${classification} returned HTTP ${status}`);
  }
  return await readJsonResponse(response, classification);
}

export async function executeGithubOperation(
  { operation, parameters, token },
  { fetchImpl = fetch } = {},
) {
  const validation = buildTargetValidationRequest(operation, parameters);
  if (validation) {
    const target = await performGithubRequest(validation, token, fetchImpl);
    if (validation.kind === "issue") {
      normalizeIssue(target, { requireIssue: true });
    } else {
      normalizePullRequest(target);
    }
  }
  const request = buildOperationRequest(operation, parameters);
  const payload = await performGithubRequest(request, token, fetchImpl);
  return normalizeOperationResponse(operation, payload, parameters);
}

export function redactBrokerOutput(value, secrets) {
  let output = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : String(value ?? "");
  for (const secret of secrets) {
    if (secret) output = output.split(String(secret)).join("[REDACTED]");
  }
  output = output.replace(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----(?:\r?\n|(?:\\[rn]){1,2})?/gu,
    "[REDACTED]",
  );
  output = output.replace(/ghs_[A-Za-z0-9._-]{20,4096}/gu, "[REDACTED]");
  return output;
}

function redactStructuredOutput(value, secrets) {
  if (typeof value === "string") return redactBrokerOutput(value, secrets);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredOutput(entry, secrets));
  }
  if (
    value &&
    typeof value === "object" &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value))
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        redactStructuredOutput(entry, secrets),
      ]),
    );
  }
  fail("normalized GitHub operation response had an unsupported value");
}

async function withInstallationToken(
  options,
  operation,
  {
    env = EXEC_ENV,
    readKey = readPrivateKey,
    exchangeToken = exchangeInstallationToken,
    nowSeconds = Math.floor(Date.now() / 1000),
    sign = signRs256,
  } = {},
) {
  assertBrokerEnvironment(env);
  const privateKey = await readKey();
  if (!Buffer.isBuffer(privateKey)) {
    fail("Secret Manager returned an invalid App private key");
  }
  try {
    const jwt = createAppJwt({
      appId: options.appId,
      privateKey,
      nowSeconds,
      sign,
    });
    privateKey.fill(0);
    const token = await exchangeToken({
      installationId: options.installationId,
      jwt,
      permissions: requestedPermissions(options),
      nowMs: nowSeconds * 1000,
    });
    return await operation(token, [token, jwt]);
  } finally {
    privateKey.fill(0);
  }
}

export async function runBroker(
  argv,
  {
    env = EXEC_ENV,
    stdout = process.stdout,
    verifyRuntime = verifyTrustedRuntimePaths,
    executeOperation = executeGithubOperation,
    operationDependencies = {},
    tokenDependencies = {},
  } = {},
) {
  const options = parseBrokerArgs(argv);
  await verifyRuntime();
  return await withInstallationToken(
    options,
    async (token, secrets) => {
      const result = await executeOperation(
        {
          operation: options.operation,
          parameters: options.parameters,
          token,
        },
        operationDependencies,
      );
      const safeResult = redactStructuredOutput(result, secrets);
      const output = `${JSON.stringify({
        ok: true,
        operation: options.operation,
        result: safeResult,
      })}\n`;
      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) {
        fail("normalized GitHub operation response was too large");
      }
      stdout.write(output);
      return 0;
    },
    { env, ...tokenDependencies },
  );
}

export function brokerFailureMessage(error) {
  return error instanceof BrokerFailure || error instanceof ClientFailure
    ? error.message
    : "internal broker error";
}

async function main() {
  try {
    process.exitCode = await runBroker(process.argv.slice(2), {
      env: EXEC_ENV,
    });
  } catch (error) {
    const message = brokerFailureMessage(error);
    process.stderr.write(`local-agent GitHub broker failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
