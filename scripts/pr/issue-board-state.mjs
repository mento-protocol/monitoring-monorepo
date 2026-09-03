/**
 * Pure issue-board state machine.
 *
 * Label transitions, project-field value shaping, and the claim/review/release
 * predicates. No `gh`, no network, no filesystem — this is the layer the
 * offline suite (`pnpm issue:board:test`) exercises end to end.
 */

import { createHash } from "node:crypto";

import { ISSUE_STATE_LABELS } from "../lib/gh-issue-lifecycle.mjs";

export { ISSUE_STATE_LABELS };

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_PROJECT_OWNER = "mento-protocol";
export const DEFAULT_PROJECT_NUMBER = 12;
export const GITHUB_CLI_HOST = "github.com";
export const PROSPECTIVE_PROJECT_ITEM_ID = "dry-run:prospective-project-item";

const CLAIM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BODY_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNSAFE_SINGLE_LINE_CHARACTER_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
export const MAX_CLAIM_AGENT_LENGTH = 120;
export const MAX_CLAIM_BRANCH_LENGTH = 256;

function hasUnsafeSingleLineCharacter(value) {
  return UNSAFE_SINGLE_LINE_CHARACTER_PATTERN.test(value);
}

export function isSafeSingleLineText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasUnsafeSingleLineCharacter(value)
  );
}

export function assertCanonicalGithubCliEnvironment(env = process.env) {
  const ambientHost = env.GH_HOST;
  if (
    ambientHost != null &&
    ambientHost !== "" &&
    ambientHost !== GITHUB_CLI_HOST
  ) {
    throw new Error(
      `GH_HOST must be unset or exactly ${GITHUB_CLI_HOST} for issue-board operations`,
    );
  }

  const ambientRepo = env.GH_REPO;
  if (ambientRepo != null && ambientRepo !== "") {
    const repoParts = String(ambientRepo).split("/");
    if (repoParts.length !== 2) {
      throw new Error(
        "GH_REPO must be an unqualified owner/repo for issue-board operations",
      );
    }
  }
}

export function pinnedGithubCliEnvironment(env = process.env) {
  assertCanonicalGithubCliEnvironment(env);
  const pinned = { ...env, GH_HOST: GITHUB_CLI_HOST };
  delete pinned.GH_REPO;
  return pinned;
}

export class IssueOwnershipConflictError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = "IssueOwnershipConflictError";
    this.code = "ISSUE_OWNERSHIP_CONFLICT";
    this.details = details;
  }
}

export class IssueClaimCandidateLossError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "IssueClaimCandidateLossError";
    this.code = "ISSUE_CLAIM_CANDIDATE_LOSS";
  }
}

export function validateClaimId(value) {
  if (typeof value !== "string" || !CLAIM_ID_PATTERN.test(value)) {
    throw new Error(
      "Claim ID must be 1-200 characters from A-Z, a-z, 0-9, dot, underscore, colon, or hyphen",
    );
  }
  return value;
}

export function validateClaimAgent(value) {
  if (!isSafeSingleLineText(value, MAX_CLAIM_AGENT_LENGTH)) {
    throw new Error(
      `Agent must be 1-${MAX_CLAIM_AGENT_LENGTH} single-line characters with no leading or trailing whitespace and no control characters`,
    );
  }
  return value;
}

export function isValidClaimAgent(value) {
  try {
    validateClaimAgent(value);
    return true;
  } catch {
    return false;
  }
}

export function validateClaimBranch(value) {
  if (!isSafeSingleLineText(value, MAX_CLAIM_BRANCH_LENGTH)) {
    throw new Error(
      `Branch must be 1-${MAX_CLAIM_BRANCH_LENGTH} single-line characters with no leading or trailing whitespace and no control characters`,
    );
  }
  return value;
}

export function isValidClaimBranch(value) {
  try {
    validateClaimBranch(value);
    return true;
  } catch {
    return false;
  }
}

export function issueBodySha256(body) {
  return createHash("sha256")
    .update(String(body ?? ""), "utf8")
    .digest("hex");
}

export function validateIssueBodySha256(value) {
  if (typeof value !== "string" || !BODY_SHA256_PATTERN.test(value)) {
    throw new Error(
      "Body SHA-256 must be exactly 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

const STATE_TRANSITIONS = {
  ready: {
    addLabels: ["agent-ready"],
    removeLabels: ["agent-active", "in-pr", "needs-grooming"],
  },
  active: {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
  },
  review: {
    addLabels: ["in-pr"],
    removeLabels: ["agent-ready", "agent-active", "needs-grooming"],
  },
  grooming: {
    addLabels: ["needs-grooming"],
    removeLabels: ["agent-ready", "agent-active", "in-pr"],
  },
  done: {
    addLabels: [],
    removeLabels: ISSUE_STATE_LABELS,
  },
};

export const OPTIONAL_PROJECT_FIELDS = {
  agent: "Agent",
  branch: "Branch",
  claimId: "Claim ID",
  claimedAt: "Claimed At",
  pr: "PR",
};

export function splitRepo(repo) {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new Error(`Repository must be owner/name, got: ${repo}`);
  }
  return { owner, name, nameWithOwner: `${owner}/${name}` };
}

export function labelsForState(state) {
  const transition = STATE_TRANSITIONS[state];
  if (!transition) throw new Error(`Unknown state: ${state}`);
  return transition;
}

export function labelNames(issue) {
  return new Set((issue.labels ?? []).map((label) => label.name));
}

export function stateFromLabels(issue) {
  const labels = labelNames(issue);
  if (
    String(issue.state ?? "").toUpperCase() === "CLOSED" &&
    ISSUE_STATE_LABELS.some((label) => labels.has(label))
  ) {
    return "done";
  }
  if (labels.has("in-pr")) return "review";
  if (labels.has("agent-active")) return "active";
  if (labels.has("agent-ready")) return "ready";
  if (labels.has("needs-grooming")) return "grooming";
  return null;
}

export function exactQueueState(issue) {
  const labels = labelNames(issue);
  const queueLabels = ISSUE_STATE_LABELS.filter((label) => labels.has(label));
  if (String(issue.state ?? "").toUpperCase() !== "OPEN") return null;
  if (queueLabels.length !== 1) return null;
  return stateFromLabels(issue);
}

export function isClaimable(issue) {
  const labels = labelNames(issue);
  return (
    issue.state === "OPEN" &&
    labels.has("agent-ready") &&
    !labels.has("agent-active") &&
    !labels.has("in-pr") &&
    !labels.has("needs-grooming")
  );
}

function hasExactUnblockedProjectStatus(issue, project) {
  if (!project?.id || !project.statusField?.id) return false;
  const selectedItems = (issue.projectItems ?? []).filter(
    (item) => item?.project?.id === project.id,
  );
  if (selectedItems.length !== 1) return false;
  const status = selectedItems[0]?.status;
  return (
    status?.fieldId === project.statusField.id &&
    typeof status.name === "string" &&
    status.name.length > 0 &&
    typeof status.optionId === "string" &&
    status.optionId.length > 0 &&
    status.name !== "Blocked"
  );
}

function hasNativeBlocker(issue) {
  const blockedBy = issue.blockedBy;
  if (
    !blockedBy ||
    !Number.isInteger(blockedBy.totalCount) ||
    !Array.isArray(blockedBy.nodes)
  ) {
    return true;
  }
  return blockedBy.totalCount > 0 || blockedBy.nodes.filter(Boolean).length > 0;
}

function labelsWithPrefix(issue, prefix) {
  return [...labelNames(issue)].filter((label) => label.startsWith(prefix));
}

function namesWithPrefix(labels, prefix) {
  return [...labels].filter((label) => label.startsWith(prefix));
}

function hasSweepRoutingNames(labels) {
  const riskLabels = namesWithPrefix(labels, "risk:");
  return (
    riskLabels.length === 1 &&
    riskLabels[0] === "risk:low" &&
    namesWithPrefix(labels, "pkg:").length === 1
  );
}

function hasSweepRouting(issue) {
  return hasSweepRoutingNames(labelNames(issue));
}

/**
 * The backlog-sweep label predicate over label names alone.
 *
 * `hasSweepClaimAttributes` adds the Project and blocker conditions a claim
 * also needs. This is the label half on its own, so a caller holding a
 * prospective set — the labels a write is about to produce — can ask whether
 * that write would leave the issue sweep-eligible. `agent-ready` belongs to the
 * predicate because eligibility is the conjunction: which label completes it
 * depends on what the issue already carries.
 */
export function satisfiesSweepLabelEligibility(labels) {
  const names = labels instanceof Set ? labels : new Set(labels);
  return names.has("agent-ready") && hasSweepRoutingNames(names);
}

/**
 * Routing-label gaps that make an `agent-ready` issue incompletely groomed.
 *
 * `agent-ready` promises an agent can implement the issue without further
 * grooming. Consumers route on exactly one `risk:*` and at least one `pkg:*`,
 * so an issue missing either is not yet ready however complete its body reads.
 * Multiple `pkg:*` labels are correct for cross-package work; the backlog sweep
 * narrows further to exactly one, and that narrowing is the sweep's own rule.
 */
export function agentReadyRoutingGaps(issue) {
  const riskLabels = labelsWithPrefix(issue, "risk:").sort();
  const gaps = [];
  if (riskLabels.length === 0) gaps.push("no risk:* label");
  if (riskLabels.length > 1) {
    gaps.push(`conflicting risk labels (${riskLabels.join(", ")})`);
  }
  if (labelsWithPrefix(issue, "pkg:").length === 0) {
    gaps.push("no pkg:* label");
  }
  return gaps;
}

/**
 * The incomplete-grooming finding, or null when the issue is well formed.
 *
 * Reporting only. Nothing here refuses a claim: manual work on a thinly
 * labeled issue stays possible, and the finding names the repair instead.
 */
export function incompleteGroomingFinding(issue) {
  if (String(issue.state ?? "").toUpperCase() !== "OPEN") return null;
  if (!labelNames(issue).has("agent-ready")) return null;
  const gaps = agentReadyRoutingGaps(issue);
  if (gaps.length === 0) return null;
  return `Issue #${issue.number} is agent-ready but incompletely groomed: ${gaps.join("; ")}`;
}

export function hasSweepClaimAttributes(issue, project) {
  return (
    String(issue.state ?? "").toUpperCase() === "OPEN" &&
    hasSweepRouting(issue) &&
    !hasNativeBlocker(issue) &&
    hasExactUnblockedProjectStatus(issue, project)
  );
}

export function isSweepClaimable(issue, project) {
  return isClaimable(issue) && hasSweepClaimAttributes(issue, project);
}

export function isActiveSweepClaim(issue, project) {
  return isReviewable(issue) && hasSweepClaimAttributes(issue, project);
}

export function isBackfillable(issue) {
  const labels = labelNames(issue);
  const hasActive = labels.has("agent-active");
  const hasReview = labels.has("in-pr");
  return (
    issue.state === "OPEN" &&
    hasActive !== hasReview &&
    !labels.has("agent-ready") &&
    !labels.has("needs-grooming")
  );
}

export function isReviewable(issue) {
  const labels = labelNames(issue);
  return (
    issue.state === "OPEN" &&
    labels.has("agent-active") &&
    !labels.has("agent-ready") &&
    !labels.has("in-pr") &&
    !labels.has("needs-grooming")
  );
}

export function isReleasable(issue) {
  const labels = labelNames(issue);
  return (
    issue.state === "OPEN" &&
    labels.has("agent-active") &&
    !labels.has("agent-ready") &&
    !labels.has("in-pr") &&
    !labels.has("needs-grooming")
  );
}

export function validateOpenPr(pr, options) {
  if (!pr?.id) {
    throw new Error(`PR #${options.pr} was not found in ${options.repo}`);
  }
  if (pr.state !== "OPEN") {
    throw new Error(
      `PR #${options.pr} is ${pr.state}; issue:review requires an open PR in ${options.repo}`,
    );
  }
  return pr;
}

export function projectPrFieldValue(pr) {
  return pr == null || pr === "" ? null : `#${pr}`;
}

export function projectDateFieldValue(value) {
  return value == null || value === "" ? null : value.slice(0, 10);
}

export function shouldRollbackFailedTransition(state, previousState) {
  if (!previousState) return false;
  return state !== "active";
}

export function chooseUntriedCandidate(candidates, triedNumbers) {
  for (const item of candidates ?? []) {
    if (!triedNumbers.has(item.number)) return item;
  }
  return null;
}

export function isRecoverableClaimRaceError(err) {
  const seen = new Set();
  let current = err;
  let recoverable = false;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.code === "ISSUE_MUTATION_LOCK_STALE") return false;
    if (current.partialClaim === true) return false;
    if (
      current instanceof IssueOwnershipConflictError ||
      current instanceof IssueClaimCandidateLossError
    ) {
      recoverable = true;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return recoverable;
}
