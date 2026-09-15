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

// A base commit's rollup can carry several runs of the same check: a rerun
// after a failure leaves the old FAILURE alongside the new SUCCESS. Reduce to
// the latest run per identity here, at the read, so a base someone already
// fixed by rerunning stops blocking every open PR.
export function latestChecksByIdentity(rollup = []) {
  const latest = new Map();
  for (const check of rollup) {
    const identity = checkIdentity(check);
    const previous = latest.get(identity);
    if (previous === undefined) {
      latest.set(identity, check);
      continue;
    }
    const previousMs = checkRunOrderTimestampMs(previous);
    const currentMs = checkRunOrderTimestampMs(check);
    if (previousMs !== null && currentMs !== null && currentMs !== previousMs) {
      if (currentMs > previousMs) latest.set(identity, check);
      continue;
    }
    // Equal or missing timestamps cannot order the runs, so fail closed: keep
    // a failure rather than guess that the passing run is the newer one.
    if (classifyCheck(check) === "fail") latest.set(identity, check);
  }
  return [...latest.values()];
}

// One read, both surfaces. This repo's required contexts span check runs
// ("ci", "Code Quality", "Sentry suites") and commit statuses ("Vercel"), and
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
    rollup: latestChecksByIdentity(
      (contexts?.nodes ?? []).map(baseHealthCheck),
    ),
    error: null,
  };
}
