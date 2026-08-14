import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const CLAUDE_APP_TOKEN_AUDIENCE = "claude-code-github-action";
export const CLAUDE_APP_TOKEN_EXCHANGE_URL =
  "https://api.anthropic.com/api/github/github-app-token-exchange";
export const CLAUDE_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export const GITHUB_ACCEPT = "application/vnd.github+json";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_API_URL = "https://api.github.com";
export const REVIEW_COMMAND = /(?:^|\s)@claude\s+review\b/i;
export const REVIEW_WORKFLOW_PATH = ".github/workflows/claude.yml";
export const REQUEST_WORKFLOW_NAME = "Claude Review Request";
export const REQUEST_WORKFLOW_PATH =
  ".github/workflows/claude-review-request.yml";
export const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVIEW_VERDICTS = new Set(["clean", "needs_changes", "needs_discussion"]);
const FINDING_SEVERITIES = new Set(["P1", "P2", "P3"]);
const REVIEW_KEYS = new Set(["verdict", "findings", "follow_up"]);
const FINDING_KEYS = new Set(["severity", "title", "detail", "path", "line"]);
const MAX_REVIEW_FINDINGS = 12;
const MAX_FINDING_TITLE_LENGTH = 120;
const MAX_FINDING_DETAIL_LENGTH = 400;
const MAX_FOLLOW_UP_LENGTH = 400;
const MAX_STRUCTURED_REVIEW_BYTES = 48_000;
export const MAX_REVIEW_COMMENT_BYTES = 65_536;
export const MAX_REVIEW_INPUT_BYTES = 750_000;
export const REVIEW_INPUT_RELATIVE_PATH = "review-input/review.txt";
export const REVIEW_TARGET_RELATIVE_PATH = "review-target";
const ATTESTATION_ARTIFACT_PREFIX = "mento-claude-clean-review-v1";

export function fail(message) {
  throw new Error(message);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail(`${label} has an unexpected or missing field`);
  }
}

function hasForbiddenControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    );
  });
}

export function boundedString(
  value,
  label,
  maxLength,
  { nullable = false } = {},
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasForbiddenControlCharacter(value)
  ) {
    fail(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function normalizeFinding(finding) {
  const allowedKeys = new Set(
    [...FINDING_KEYS].filter(
      (key) =>
        !["path", "line"].includes(key) ||
        Object.prototype.hasOwnProperty.call(finding ?? {}, key),
    ),
  );
  exactKeys(finding, allowedKeys, "finding");
  if (!FINDING_SEVERITIES.has(finding.severity)) {
    fail("finding severity must be P1, P2, or P3");
  }
  const normalized = {
    severity: finding.severity,
    title: boundedString(
      finding.title,
      "finding title",
      MAX_FINDING_TITLE_LENGTH,
    ),
    detail: boundedString(
      finding.detail,
      "finding detail",
      MAX_FINDING_DETAIL_LENGTH,
    ),
  };
  if (Object.prototype.hasOwnProperty.call(finding, "path")) {
    if (
      typeof finding.path !== "string" ||
      finding.path.length === 0 ||
      finding.path.length > 240 ||
      finding.path.startsWith("/") ||
      finding.path.includes("//") ||
      !/^[A-Za-z0-9._/-]+$/.test(finding.path) ||
      finding.path.split("/").some((segment) => [".", ".."].includes(segment))
    ) {
      fail("finding path must be a bounded repository-relative path");
    }
    normalized.path = finding.path;
  }
  if (Object.prototype.hasOwnProperty.call(finding, "line")) {
    if (!Number.isSafeInteger(finding.line) || finding.line < 1) {
      fail("finding line must be a positive integer");
    }
    normalized.line = finding.line;
  }
  return normalized;
}

export function validateStructuredReview(value) {
  exactKeys(value, REVIEW_KEYS, "structured review");
  if (!REVIEW_VERDICTS.has(value.verdict)) {
    fail("structured review verdict is invalid");
  }
  if (
    !Array.isArray(value.findings) ||
    value.findings.length > MAX_REVIEW_FINDINGS
  ) {
    fail("structured review findings must be a bounded array");
  }
  const findings = value.findings.map(normalizeFinding);
  const followUp = boundedString(
    value.follow_up,
    "follow-up",
    MAX_FOLLOW_UP_LENGTH,
    {
      nullable: true,
    },
  );
  if (
    value.verdict === "clean" &&
    (findings.length !== 0 || followUp !== null)
  ) {
    fail("a clean review cannot contain findings or follow-up");
  }
  if (value.verdict !== "clean" && findings.length === 0 && followUp === null) {
    fail("a non-clean review requires a finding or follow-up");
  }
  return { verdict: value.verdict, findings, follow_up: followUp };
}

export function serializeStructuredReview(value) {
  const serialized = `${JSON.stringify(validateStructuredReview(value))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STRUCTURED_REVIEW_BYTES) {
    fail("structured review exceeds the transport bound");
  }
  return serialized;
}

export function parseStructuredReview(value) {
  const raw = String(value ?? "");
  if (Buffer.byteLength(raw, "utf8") > MAX_STRUCTURED_REVIEW_BYTES) {
    fail("structured review exceeds the transport bound");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("structured review is not valid JSON");
  }
  return validateStructuredReview(parsed);
}

export function canonicalPrNumber(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail("pull request number is not canonical");
  }
  return text;
}

export function canonicalHead(value) {
  const head = String(value ?? "");
  if (!SHA_PATTERN.test(head)) fail("pull request head SHA is invalid");
  return head;
}

export function canonicalBranch(value, label) {
  const branch = String(value ?? "");
  if (
    !/^[A-Za-z0-9._/-]{1,240}$/.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail(`${label} is invalid`);
  }
  return branch;
}

export function buildCleanReviewEnvelope({ prNumber, headSha }) {
  const pr = canonicalPrNumber(prNumber);
  const head = canonicalHead(headSha);
  return [
    "<!-- mento-claude-clean-review:v1 -->",
    "MENTO CLAUDE CLEAN REVIEW v1",
    `PR: ${pr}`,
    `HEAD: ${head}`,
    "VERDICT: CLEAN",
    "FINDINGS: 0",
    "FOLLOW-UP: NONE",
    "END MENTO CLAUDE CLEAN REVIEW v1",
  ].join("\n");
}

export function canonicalCommentId(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail("review comment ID is not canonical");
  }
  return text;
}

export function buildClaudeReviewAttestationArtifactName({
  prNumber,
  headSha,
  commentId,
  body,
}) {
  const pr = canonicalPrNumber(prNumber);
  const head = canonicalHead(headSha);
  const comment = canonicalCommentId(commentId);
  const expectedBody = buildCleanReviewEnvelope({
    prNumber: pr,
    headSha: head,
  });
  if (body !== expectedBody) {
    fail("clean-review artifact body does not match the finite envelope");
  }
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `${ATTESTATION_ARTIFACT_PREFIX}-${pr}-${head}-${comment}-${digest}`;
}

function buildBlockingReviewEnvelope(review, { prNumber, headSha }) {
  const pr = canonicalPrNumber(prNumber);
  const head = canonicalHead(headSha);
  const verdict = review.verdict.replaceAll("_", " ").toUpperCase();
  return [
    "<!-- mento-claude-review:v1 -->",
    "MENTO CLAUDE REVIEW v1",
    `PR: ${pr}`,
    `HEAD: ${head}`,
    `VERDICT: ${verdict}`,
    "REVIEW JSON:",
    "```json",
    JSON.stringify(review, null, 2),
    "```",
    "END MENTO CLAUDE REVIEW v1",
  ].join("\n");
}

export function assertBoundedReviewCommentBody(body) {
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body, "utf8") > MAX_REVIEW_COMMENT_BYTES
  ) {
    fail("review comment exceeds the GitHub body bound");
  }
  return body;
}

export function buildReviewBody(review, context) {
  return assertBoundedReviewCommentBody(
    review.verdict === "clean"
      ? buildCleanReviewEnvelope(context)
      : buildBlockingReviewEnvelope(review, context),
  );
}

export function assertRepository(value, expected = null) {
  const repository = String(value ?? "");
  if (!REPOSITORY_PATTERN.test(repository))
    fail("repository identity is invalid");
  if (expected !== null && repository !== expected) {
    fail("event repository does not match the workflow repository");
  }
  return repository;
}

export function trustedWorkflowRef(repository, defaultBranch) {
  const branch = canonicalBranch(defaultBranch, "default branch");
  return `${repository}/${REVIEW_WORKFLOW_PATH}@refs/heads/${branch}`;
}

export async function readJsonResponse(response, label) {
  if (!response?.ok)
    fail(`${label} failed with HTTP ${response?.status ?? "unknown"}`);
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

export function githubHeaders(token) {
  if (!token) fail("GitHub token is missing");
  return {
    Accept: GITHUB_ACCEPT,
    Authorization: bearerAuthorization(token),
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

export function bearerAuthorization(token) {
  return ["Bearer", token].join(" ");
}

export function trustedGithubApiUrl(value = GITHUB_API_URL) {
  const apiUrl = String(value ?? "").replace(/\/$/, "");
  if (apiUrl !== GITHUB_API_URL) fail("GitHub API URL is not trusted");
  return apiUrl;
}

export function validateRemotePr(
  remote,
  repository,
  prNumber,
  defaultBranch = null,
) {
  if (canonicalPrNumber(remote?.number) !== canonicalPrNumber(prNumber)) {
    fail("GitHub returned the wrong pull request");
  }
  if (remote?.state !== "open" || remote?.draft === true) {
    fail("pull request is closed or draft");
  }
  assertRepository(remote?.head?.repo?.full_name, repository);
  assertRepository(remote?.base?.repo?.full_name, repository);
  if (defaultBranch !== null && remote?.base?.ref !== defaultBranch) {
    fail("pull request does not target the default branch");
  }
  if (String(remote?.head?.ref ?? "").startsWith("sentry-autofix/")) {
    fail("machine-authored autofix pull requests are not reviewable");
  }
  return {
    repository,
    prNumber: Number(canonicalPrNumber(prNumber)),
    headSha: canonicalHead(remote?.head?.sha),
    headRef: canonicalBranch(remote?.head?.ref, "head ref"),
    baseSha: canonicalHead(remote?.base?.sha),
    baseRef: canonicalBranch(remote?.base?.ref, "base ref"),
  };
}

function trustedReviewFilePath(env) {
  const runnerTemp = resolve(
    boundedString(env.RUNNER_TEMP, "runner temporary directory", 2000),
  );
  const reviewFile = resolve(
    boundedString(
      env.CLAUDE_STRUCTURED_REVIEW_FILE,
      "structured review file",
      2000,
    ),
  );
  const pathFromTemp = relative(runnerTemp, reviewFile);
  if (
    pathFromTemp === "" ||
    pathFromTemp === ".." ||
    pathFromTemp.startsWith(`..${sep}`)
  ) {
    fail("structured review file must be below the runner temporary directory");
  }
  return reviewFile;
}

export function writeStructuredReviewFile(value, env) {
  const reviewFile = trustedReviewFilePath(env);
  const serialized = serializeStructuredReview(value);
  mkdirSync(dirname(reviewFile), { recursive: true, mode: 0o700 });
  writeFileSync(reviewFile, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return reviewFile;
}

export function readStructuredReviewFile(env) {
  const reviewFile = trustedReviewFilePath(env);
  const stats = lstatSync(reviewFile);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_STRUCTURED_REVIEW_BYTES
  ) {
    fail("structured review artifact is not a bounded regular file");
  }
  const raw = readFileSync(reviewFile, "utf8");
  const review = parseStructuredReview(raw);
  if (raw !== serializeStructuredReview(review)) {
    fail("structured review artifact is not canonical");
  }
  return review;
}
