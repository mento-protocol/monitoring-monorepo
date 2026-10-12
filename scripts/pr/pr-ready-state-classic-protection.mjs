/**
 * Interpret the classic branch-protection endpoint's 404s.
 *
 * GitHub answers that endpoint with four different 404s, and they do not mean
 * the same thing. Reading them apart is what lets the readiness probe decide
 * whether a ruleset's required-status-check list and strict flag can be trusted
 * on their own, or whether an unread classic configuration might still be
 * hiding a required check.
 *
 * Split out of pr-ready-state-status-contexts.mjs (docs/pr-checklists/
 * recurring-review-patterns.md "File-size budget").
 */

import { ghApiJsonResult, repoPath } from "./pr-ready-state-gh.mjs";

export function isHttpNotFoundError(error) {
  return /\bHTTP 404\b/i.test(String(error));
}

// Transport errors arrive multiline. Blocker text has to stay on one line, or
// it breaks the compact/watch stream callers quote verbatim.
export function compactSingleLine(value) {
  const collapsed = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 119)}…` : collapsed;
}

// GitHub renders three different 404s on the classic-protection endpoint, and
// only one of them proves classic protection is absent: "Branch not protected"
// (no classic protection), "Branch not found" (no such base), and "Not Found"
// (the token may not read protection). The first supplies conclusive REST
// evidence; generic Not Found needs the independent absence proof below before
// a ruleset's `false` can stand in for an unread classic `strict`.
export function isBranchNotProtectedError(error) {
  return /\bBranch not protected\b/i.test(String(error));
}

// A fourth 404: classic protection exists (for reviews, restrictions, and so
// on) but carries no required-status-checks configuration. GitHub only answers
// this once it has read that protection, so the message is conclusive on its
// own about the one thing this module asks — there are no classic required
// contexts and no classic `strict` flag to miss. A permission gap answers
// "Not Found" instead, never this.
export function isRequiredStatusChecksNotEnabledError(error) {
  return /\bRequired status checks not enabled\b/i.test(String(error));
}

// A generic Not Found remains ambiguous. For this response only, an exact-base
// branch read plus a complete, readable GraphQL inventory supplies independent
// absence proof. Do not accept a missing field, partial inventory or read error.
export function graphqlConfirmsNoClassicProtection(value, repo, baseRef) {
  if (
    value?.errors !== undefined &&
    (!Array.isArray(value.errors) || value.errors.length > 0)
  )
    return false;
  const repository = value?.data?.repository;
  const rules = repository?.branchProtectionRules;
  const ref = repository?.ref;
  return (
    typeof repository?.nameWithOwner === "string" &&
    repository.nameWithOwner.toLowerCase() === repoPath(repo).toLowerCase() &&
    ["WRITE", "MAINTAIN", "ADMIN"].includes(repository?.viewerPermission) &&
    rules?.totalCount === 0 &&
    Array.isArray(rules?.nodes) &&
    rules.nodes.length === 0 &&
    rules?.pageInfo?.hasNextPage === false &&
    ref?.name === baseRef &&
    ref?.branchProtectionRule === null
  );
}

const CLASSIC_ABSENCE_QUERY = `query($owner:String!,$name:String!,$ref:String!) {
  repository(owner:$owner,name:$name) {
    nameWithOwner viewerPermission
    branchProtectionRules(first:100) { totalCount nodes { id } pageInfo { hasNextPage } }
    ref(qualifiedName:$ref) { name branchProtectionRule { id } }
  }
}`;

// Keep one proof for both the strictness reading and the complete context list.
// The old conclusive REST shapes remain unchanged. Generic 404 alone, ruleset
// contents alone, and the branch's top-level protected flag prove nothing.
export async function classicProtectionConfirmedAbsent({
  repo,
  encodedBaseRef,
  error,
  fetchBranch,
  fetchClassicProtection = ghApiJsonResult,
}) {
  if (isRequiredStatusChecksNotEnabledError(error)) return true;
  const conclusiveMessage = isBranchNotProtectedError(error);
  const genericNotFound =
    /(?:^|\n)(?:gh:\s*)?Not Found \(HTTP 404\)(?:\s|$)/i.test(String(error));
  if (!conclusiveMessage && !genericNotFound) return false;
  const branchResult = await fetchBranch(repo, [
    `repos/${repoPath(repo)}/branches/${encodedBaseRef}`,
  ]);
  if (!branchResult.ok || branchResult.value?.protection?.enabled !== false)
    return false;
  if (conclusiveMessage) return true;
  const baseRef = decodeURIComponent(encodedBaseRef);
  if (branchResult.value?.name !== baseRef) return false;
  const result = await fetchClassicProtection(repo, [
    "graphql",
    "-f",
    `query=${CLASSIC_ABSENCE_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
    "-f",
    `ref=refs/heads/${baseRef}`,
  ]);
  return (
    result?.ok === true &&
    graphqlConfirmsNoClassicProtection(result.value, repo, baseRef)
  );
}
