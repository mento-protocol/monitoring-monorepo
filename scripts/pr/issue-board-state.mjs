/**
 * Pure issue-board state machine.
 *
 * Label transitions, project-field value shaping, and the claim/review/release
 * predicates. No `gh`, no network, no filesystem — this is the layer the
 * offline suite (`pnpm issue:board:test`) exercises end to end.
 */

import { ISSUE_STATE_LABELS } from "../lib/gh-issue-lifecycle.mjs";

export { ISSUE_STATE_LABELS };

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_PROJECT_OWNER = "mento-protocol";
export const DEFAULT_PROJECT_NUMBER = 12;

const STATE_TRANSITIONS = {
  ready: {
    addLabels: ["agent-ready"],
    removeLabels: ["agent-active", "in-pr", "needs-grooming"],
    statusOptions: ["Todo", "Ready"],
  },
  active: {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
    statusOptions: ["In Progress"],
  },
  review: {
    addLabels: ["in-pr"],
    removeLabels: ["agent-ready", "agent-active", "needs-grooming"],
    statusOptions: ["In Review", "Review", "In Progress"],
  },
  grooming: {
    addLabels: ["needs-grooming"],
    removeLabels: ["agent-ready", "agent-active", "in-pr"],
    statusOptions: ["Needs Grooming", "Blocked", "Todo"],
  },
  done: {
    addLabels: [],
    removeLabels: ISSUE_STATE_LABELS,
    statusOptions: ["Done"],
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

export function selectStatusOption(statusOptions, state) {
  const transition = STATE_TRANSITIONS[state];
  if (!transition) throw new Error(`Unknown state: ${state}`);
  for (const name of transition.statusOptions) {
    const option = statusOptions.find((candidate) => candidate.name === name);
    if (option) return option;
  }
  throw new Error(
    `Project Status field is missing one of: ${transition.statusOptions.join(", ")}`,
  );
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
  const hasActiveClaim = labels.has("agent-active");
  const hasReviewClaim = labels.has("in-pr");
  return (
    issue.state === "OPEN" &&
    hasActiveClaim !== hasReviewClaim &&
    !labels.has("agent-ready") &&
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

export function shouldRollbackFailedTransition(
  state,
  previousState,
  observedDifferentClaim = false,
) {
  if (!previousState) return false;
  return state !== "active" || !observedDifferentClaim;
}

export function chooseUntriedCandidate(candidates, triedNumbers) {
  for (const item of candidates ?? []) {
    if (!triedNumbers.has(item.number)) return item;
  }
  return null;
}

export function isRecoverableClaimRaceError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("is not claimable") ||
    message.includes("claim was overwritten") ||
    message.includes("did not retain agent-active") ||
    message.includes("has conflicting state labels")
  );
}
