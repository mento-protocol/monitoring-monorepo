import { isDeepStrictEqual } from "node:util";

import {
  baseEvidence,
  claudeActionsRunEvidence,
  VERIFIED_CLAUDE_ACTIONS_EVIDENCE,
} from "./review-process-metrics-core.mjs";

const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLAUDE_WORKFLOW_PATH = /^\.github\/workflows\/claude\.yml(?:@[^\s]+)?$/;
const MANUAL_WORKFLOW_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);
const UNKNOWN_CLAUDE_ACTIONS_ATTRIBUTION = Symbol(
  "unknown-claude-actions-attribution",
);

export function hasUnknownClaudeActionsAttribution(record) {
  return record?.[UNKNOWN_CLAUDE_ACTIONS_ATTRIBUTION]?.status === "unknown";
}

function runTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pullRequestSnapshot(pull) {
  return {
    number: Number.isSafeInteger(pull?.number) ? pull.number : null,
    baseRepository: pull?.base?.repo?.full_name ?? null,
    baseRef: pull?.base?.ref ?? null,
    baseSha: pull?.base?.sha ?? null,
    headRepository: pull?.head?.repo?.full_name ?? null,
    headRef: pull?.head?.ref ?? null,
    headSha: pull?.head?.sha ?? null,
  };
}

function pullRequestLookupSnapshot(pulls) {
  if (!Array.isArray(pulls)) return null;
  return pulls
    .map(pullRequestSnapshot)
    .sort(
      (left, right) =>
        (left.number ?? 0) - (right.number ?? 0) ||
        String(left.headRepository).localeCompare(
          String(right.headRepository),
        ) ||
        String(left.headRef).localeCompare(String(right.headRef)),
    );
}

function assertClaudeActionsRunEnvelope(run, runId) {
  if (
    String(run?.id ?? "") !== runId ||
    !Number.isSafeInteger(run?.workflow_id) ||
    run.workflow_id <= 0 ||
    !Number.isSafeInteger(run?.run_attempt) ||
    run.run_attempt <= 0 ||
    !REPOSITORY_NAME.test(run?.repository?.full_name ?? "") ||
    !REPOSITORY_NAME.test(run?.head_repository?.full_name ?? "") ||
    typeof run?.head_branch !== "string" ||
    run.head_branch.length === 0 ||
    !GIT_OBJECT_ID.test(run?.head_sha ?? "") ||
    typeof run?.path !== "string" ||
    typeof run?.event !== "string" ||
    typeof run?.actor?.login !== "string" ||
    typeof run?.status !== "string" ||
    (run?.conclusion !== null && typeof run?.conclusion !== "string") ||
    runTimestamp(run?.created_at) === null ||
    runTimestamp(run?.run_started_at ?? run?.created_at) === null ||
    runTimestamp(run?.updated_at) === null ||
    !Array.isArray(run?.pull_requests)
  ) {
    throw new Error(`Claude Actions run ${runId} returned invalid metadata`);
  }
  return run;
}

function runEvidenceSnapshot(run) {
  return {
    id: String(run.id),
    workflowId: run.workflow_id,
    runAttempt: run.run_attempt,
    repository: run.repository.full_name,
    headRepository: run.head_repository.full_name,
    headRef: run.head_branch,
    headSha: run.head_sha.toLowerCase(),
    workflowPath: run.path,
    event: run.event,
    actor: run.actor.login.toLowerCase(),
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    runStartedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    pullRequests: run.pull_requests.map(pullRequestSnapshot),
  };
}

function matchesUniqueHeadPullRequest(pulls, run, repo, prNumber) {
  if (!Array.isArray(pulls) || pulls.length !== 1) return null;
  const pull = pulls[0];
  if (
    pull.number !== prNumber ||
    pull.baseRepository?.toLowerCase() !== repo.toLowerCase() ||
    pull.headRepository?.toLowerCase() !== run.headRepository.toLowerCase() ||
    pull.headRef !== run.headRef
  ) {
    return null;
  }
  const [owner] = run.headRepository.split("/");
  return {
    type: "unique_owner_head_lookup",
    pullRequest: prNumber,
    head: `${owner}:${run.headRef}`,
  };
}

function pullRequestAssociation(run, options) {
  if (run.pullRequests.length > 0) {
    return run.pullRequests.length === 1 &&
      run.pullRequests[0]?.number === options.prNumber
      ? { type: "workflow_run_pull_request", pullRequest: options.prNumber }
      : null;
  }
  return matchesUniqueHeadPullRequest(
    options.pullRequestsForHead(run),
    run,
    options.repo,
    options.prNumber,
  );
}

function matchingClaudeActionsAssociation(record, reference, run, options) {
  const recordTime = runTimestamp(
    record.updated_at ?? record.submitted_at ?? record.created_at,
  );
  const startedAt = runTimestamp(run.runStartedAt);
  if (
    run.repository.toLowerCase() !== options.repo.toLowerCase() ||
    run.headRepository.toLowerCase() !==
      String(options.headRepository ?? "").toLowerCase() ||
    run.headRef !== options.headRef ||
    !CLAUDE_WORKFLOW_PATH.test(run.workflowPath) ||
    run.event !== "pull_request" ||
    run.actor !== reference.actorLogin ||
    recordTime === null ||
    startedAt === null ||
    recordTime < startedAt ||
    !options.headShas.has(run.headSha)
  ) {
    return null;
  }
  if (run.status !== "completed") {
    throw new Error(`Claude Actions run ${reference.runId} is not complete`);
  }
  const finishedAt = runTimestamp(run.updatedAt);
  return run.conclusion === "success" &&
    finishedAt !== null &&
    recordTime <= finishedAt
    ? pullRequestAssociation(run, options)
    : null;
}

function unknownAttributionReason(record, reference, run, options) {
  const recordTime = runTimestamp(
    record.updated_at ?? record.submitted_at ?? record.created_at,
  );
  const startedAt = runTimestamp(run.runStartedAt);
  const finishedAt = runTimestamp(run.updatedAt);
  const repositoryMatches =
    run.repository.toLowerCase() === options.repo.toLowerCase();
  const workflowMatches = CLAUDE_WORKFLOW_PATH.test(run.workflowPath);
  const actorMatches = run.actor === reference.actorLogin;
  const timingMatches =
    recordTime !== null &&
    startedAt !== null &&
    finishedAt !== null &&
    recordTime >= startedAt &&
    recordTime <= finishedAt;
  if (
    MANUAL_WORKFLOW_EVENTS.has(run.event) &&
    repositoryMatches &&
    workflowMatches &&
    actorMatches &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    timingMatches
  ) {
    return "manual_workflow_event_has_no_proven_pr_head_binding";
  }
  if (!repositoryMatches) return "workflow_run_repository_mismatch";
  if (
    run.headRepository.toLowerCase() !==
    String(options.headRepository ?? "").toLowerCase()
  ) {
    return "workflow_run_head_repository_mismatch";
  }
  if (run.headRef !== options.headRef) {
    return "workflow_run_head_ref_mismatch";
  }
  if (!workflowMatches) return "workflow_path_is_not_canonical_claude";
  if (run.event !== "pull_request") {
    return "workflow_event_is_not_pull_request";
  }
  if (!actorMatches) return "workflow_run_actor_mismatch";
  if (recordTime === null) return "candidate_timestamp_is_invalid";
  if (startedAt === null || recordTime < startedAt) {
    return "candidate_precedes_workflow_run";
  }
  if (!options.headShas.has(run.headSha)) {
    return "workflow_run_head_is_not_in_pull_request_history";
  }
  if (run.status !== "completed") return "workflow_run_is_not_complete";
  if (run.conclusion !== "success") return "workflow_run_did_not_succeed";
  if (finishedAt === null || recordTime > finishedAt) {
    return "candidate_follows_workflow_run_completion";
  }
  return "pull_request_association_is_not_proven";
}

function attributionProof(reference, run, association, verifiedAt) {
  return Object.freeze({
    type: "claude_github_actions_run",
    runId: reference.runId,
    runUrl: reference.runUrl,
    workflowId: run.workflowId,
    workflowPath: run.workflowPath,
    runAttempt: run.runAttempt,
    event: run.event,
    actor: run.actor,
    repository: run.repository,
    headRepository: run.headRepository,
    headRef: run.headRef,
    headSha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    runStartedAt: run.runStartedAt,
    runCompletedAt: run.updatedAt,
    pullRequestAssociation: Object.freeze(association),
    verifiedAt,
  });
}

export function verifyClaudeActionsEvidence(
  collections,
  {
    repo,
    prNumber,
    prUrl,
    headRepository,
    headRef,
    headShas = [],
    verifiedAt = null,
    now = () => new Date().toISOString(),
    fetchRun,
    fetchPullRequestsByHead,
    beforeFinalize = () => {},
  },
) {
  if (
    (verifiedAt !== null && runTimestamp(verifiedAt) === null) ||
    typeof now !== "function"
  ) {
    throw new Error(
      "Claude Actions verification requires a valid clock or timestamp",
    );
  }
  const heads = new Set(
    headShas
      .filter((head) => GIT_OBJECT_ID.test(String(head ?? "")))
      .map((head) => String(head).toLowerCase()),
  );
  const runs = new Map();
  const pullsByHead = new Map();
  const matchedRecords = new Map();
  const unknownRecords = new Map();
  const fetchRunSnapshot = (runId) =>
    runEvidenceSnapshot(assertClaudeActionsRunEnvelope(fetchRun(runId), runId));
  const pullRequestsForHead = (run) => {
    const [owner] = run.headRepository.split("/");
    const key = `${owner.toLowerCase()}:${run.headRef}`;
    if (!pullsByHead.has(key)) {
      pullsByHead.set(key, {
        owner,
        headRef: run.headRef,
        snapshot: pullRequestLookupSnapshot(
          typeof fetchPullRequestsByHead === "function"
            ? fetchPullRequestsByHead(owner, run.headRef)
            : null,
        ),
      });
    }
    return pullsByHead.get(key).snapshot;
  };

  for (const record of collections.flat()) {
    const reference = claudeActionsRunEvidence(record, prUrl);
    if (reference === null) continue;
    if (!runs.has(reference.runId)) {
      runs.set(reference.runId, fetchRunSnapshot(reference.runId));
    }
    const run = runs.get(reference.runId);
    const association = matchingClaudeActionsAssociation(
      record,
      reference,
      run,
      {
        repo,
        prNumber,
        headRepository,
        headRef,
        headShas: heads,
        pullRequestsForHead,
      },
    );
    if (association !== null) {
      matchedRecords.set(record, { reference, run, association });
    } else {
      unknownRecords.set(record, {
        reference,
        run,
        reason: unknownAttributionReason(record, reference, run, {
          repo,
          headRepository,
          headRef,
          headShas: heads,
        }),
      });
    }
  }

  beforeFinalize();

  for (const [runId, initial] of runs) {
    if (!isDeepStrictEqual(initial, fetchRunSnapshot(runId))) {
      throw new Error(`Claude Actions run ${runId} changed during collection`);
    }
  }
  for (const { owner, headRef: branch, snapshot } of pullsByHead.values()) {
    const final = pullRequestLookupSnapshot(
      typeof fetchPullRequestsByHead === "function"
        ? fetchPullRequestsByHead(owner, branch)
        : null,
    );
    if (!isDeepStrictEqual(snapshot, final)) {
      throw new Error(
        `Claude Actions head lookup changed during collection for ${owner}:${branch}`,
      );
    }
  }
  const finalizedAt = verifiedAt ?? now();
  const finalizedTime = runTimestamp(finalizedAt);
  if (
    finalizedTime === null ||
    [...matchedRecords.values(), ...unknownRecords.values()].some(
      ({ run }) => finalizedTime < runTimestamp(run.updatedAt),
    )
  ) {
    throw new Error("Claude Actions verification time precedes its evidence");
  }
  for (const [record, { reference, run, association }] of matchedRecords) {
    Object.defineProperty(record, VERIFIED_CLAUDE_ACTIONS_EVIDENCE, {
      value: attributionProof(reference, run, association, finalizedAt),
    });
  }
  for (const [record, { reference, run, reason }] of unknownRecords) {
    Object.defineProperty(record, UNKNOWN_CLAUDE_ACTIONS_ATTRIBUTION, {
      value: Object.freeze({
        status: "unknown",
        reason,
        runId: reference.runId,
        runUrl: reference.runUrl,
        event: run.event,
        checkedAt: finalizedAt,
      }),
    });
  }
  return collections;
}

export function buildUnknownAttributionEvidence({
  prUrl,
  issueComments = [],
  reviews = [],
  reviewComments = [],
}) {
  const evidence = [];
  const seen = new Set();
  const append = (records, surface) => {
    for (const record of records) {
      const attribution = record?.[UNKNOWN_CLAUDE_ACTIONS_ATTRIBUTION];
      if (!hasUnknownClaudeActionsAttribution(record) || seen.has(record)) {
        continue;
      }
      seen.add(record);
      evidence.push({
        ...baseEvidence(record, { prUrl, surface }),
        ...attribution,
      });
    }
  };
  append(issueComments, "issue_comments");
  append(reviews, "review_submissions");
  append(reviewComments, "review_comments");
  return { count: evidence.length, evidence };
}
