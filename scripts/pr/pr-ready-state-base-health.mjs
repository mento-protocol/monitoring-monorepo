/**
 * Read the base branch head's own status rollup for the readiness probe.
 *
 * ADR 0104 turned off strict required status checks on `main`, so GitHub no
 * longer reruns a PR's required checks against the current base. This read is
 * what lets the oracle refuse to call a PR ready while the base it would merge
 * into is red (docs/adr/0104-non-strict-required-status-checks.md).
 *
 * Split out of pr-ready-state-status-contexts.mjs (docs/pr-checklists/
 * recurring-review-patterns.md "File-size budget").
 */

import { ghApiJsonResult } from "./pr-ready-state-gh.mjs";
import {
  checkIdentity,
  checkRunOrderTimestampMs,
  classifyCheck,
} from "./pr-ready-state-check-state.mjs";

// `classifyCheck` returns "pending" for every non-terminal state (queued,
// in progress, expected, waiting) and for anything it cannot read, so a run is
// settled exactly when it classifies as something else.
function isSettledRun(check) {
  return classifyCheck(check) !== "pending";
}

function laterSettledRun(current, candidate) {
  if (current === null) return candidate;
  const currentMs = checkRunOrderTimestampMs(current);
  const candidateMs = checkRunOrderTimestampMs(candidate);
  if (currentMs !== null && candidateMs !== null && currentMs !== candidateMs) {
    return candidateMs > currentMs ? candidate : current;
  }
  // Equal or missing timestamps cannot order the runs, so fail closed: keep a
  // failure rather than guess that the passing run is the newer one.
  return classifyCheck(candidate) === "fail" ? candidate : current;
}

// A base commit's rollup can carry several runs of the same check. Reduce each
// identity to its latest *settled* run, at the read.
//
// Settled, not merely latest: when someone reruns a failed check on the base,
// the rollup holds the old FAILURE next to a new QUEUED or IN_PROGRESS run.
// Taking the newest run would drop the failure, and a pending base check does
// not block — so every open PR would look mergeable again while the base is
// still known-broken and the rerun has proven nothing. A known failure keeps
// blocking until a newer settled run supersedes it. An identity with no
// settled run yet is genuinely unproven rather than red, and is reported as
// its pending run so the required context still shows up.
export function latestSettledChecksByIdentity(rollup = []) {
  const byIdentity = new Map();
  for (const check of rollup) {
    const identity = checkIdentity(check);
    const entry = byIdentity.get(identity) ?? { settled: null, pending: null };
    if (isSettledRun(check)) {
      entry.settled = laterSettledRun(entry.settled, check);
    } else if (entry.pending === null) {
      entry.pending = check;
    }
    byIdentity.set(identity, entry);
  }
  return [...byIdentity.values()]
    .map((entry) => entry.settled ?? entry.pending)
    .filter((check) => check != null);
}

// One read, both surfaces. This repo's required contexts span check runs
// ("ci", "Code Quality") and commit statuses ("Vercel"), and
// no single REST endpoint returns both; GraphQL's rollup does, and carries the
// app identity each one needs to match an app-bound required context — a check
// run's `checkSuite.app.databaseId`, a status context's `/in/<id>` avatar URL.
const BASE_HEALTH_PAGE_SIZE = 100;
const BASE_HEALTH_QUERY = `
  query($owner: String!, $name: String!, $ref: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $ref) {
        ... on Commit {
          oid
          statusCheckRollup {
            contexts(first: ${BASE_HEALTH_PAGE_SIZE}) {
              totalCount
              pageInfo { hasNextPage }
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                  startedAt
                  completedAt
                  detailsUrl
                  checkSuite { app { databaseId } }
                }
                ... on StatusContext {
                  context
                  state
                  createdAt
                  targetUrl
                  avatarUrl
                }
              }
            }
          }
        }
      }
    }
  }
`;

function appIdFromAvatarUrl(url) {
  const match = String(url ?? "").match(/\/in\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function baseHealthCheck(node) {
  const appId =
    node.checkSuite?.app?.databaseId ?? appIdFromAvatarUrl(node.avatarUrl);
  return {
    ...node,
    startedAt: node.startedAt ?? node.createdAt ?? null,
    detailsUrl: node.detailsUrl ?? node.targetUrl ?? null,
    ...(appId === null || appId === undefined ? {} : { appId: Number(appId) }),
  };
}

function baseHealthError(message) {
  return {
    oid: null,
    rollup: [],
    error: `Base branch health unreadable: ${message}`,
  };
}

// Errors are returned, never thrown: the caller fails closed on them, so a
// base whose health cannot be established blocks exactly like a red one.
export async function fetchBaseBranchHealth({
  repo,
  baseRef,
  fetchJson = ghApiJsonResult,
}) {
  const result = await fetchJson(repo, [
    "graphql",
    "-f",
    `query=${BASE_HEALTH_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `name=${repo.name}`,
    "-F",
    `ref=${baseRef}`,
  ]);

  if (!result.ok) return { oid: null, rollup: [], error: result.error };

  const errors = result.value?.errors ?? [];
  if (errors.length > 0) {
    return baseHealthError(
      errors
        .map((entry) => entry?.message ?? "unknown GraphQL error")
        .join("; "),
    );
  }

  const commit = result.value?.data?.repository?.object ?? null;
  if (!commit?.oid) {
    return baseHealthError(`${baseRef} did not resolve to a commit`);
  }

  // A rollup wider than one page would silently drop contexts, and a dropped
  // required context reads as pending — which does not block. Fail closed on
  // the truncation instead of paginating: the whole point of this read is that
  // it costs one request.
  const contexts = commit.statusCheckRollup?.contexts ?? null;
  if (contexts?.pageInfo?.hasNextPage === true) {
    return baseHealthError(
      `${commit.oid} reports ${contexts.totalCount ?? "more than " + BASE_HEALTH_PAGE_SIZE} status contexts, more than one page`,
    );
  }

  return {
    oid: commit.oid,
    rollup: latestSettledChecksByIdentity(
      (contexts?.nodes ?? []).map(baseHealthCheck),
    ),
    error: null,
  };
}
