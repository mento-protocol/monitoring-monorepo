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

import { repoPath } from "./pr-ready-state-gh.mjs";

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
// (the token may not read protection). Only the first can license trusting a
// ruleset's `false` in place of an unread classic `strict`.
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

// Prove classic protection is absent from two independent signals before the
// 404 path trusts anything a ruleset says: the 404 must be the API's "Branch
// not protected" message, and the branch object must report
// `protection.enabled: false`. The branch object's top-level `protected` flag
// cannot serve here — a ruleset-protected branch with no classic protection
// still reports `protected: true` (observed on this repo's `main`). Anything
// else — another 404 message, `protection.enabled` true or absent, or a failed
// branch read — means an unread classic protection cannot be ruled out. The one
// shortcut is a branch that is protected but has no required-status-checks
// configuration at all, which GitHub reports conclusively.
//
// One proof serves both the strictness reading and the context list. They were
// separate once, and the context list silently trusted a permission-masked 404
// that the strictness reading refused: a hidden classic-only required check was
// then classified as optional, so a PR could read ready while it was pending or
// failing. Keep them on this single helper so they cannot drift again.
export async function classicProtectionConfirmedAbsent({
  repo,
  encodedBaseRef,
  error,
  fetchBranch,
}) {
  if (isRequiredStatusChecksNotEnabledError(error)) return true;
  if (!isBranchNotProtectedError(error)) return false;
  const branchResult = await fetchBranch(repo, [
    `repos/${repoPath(repo)}/branches/${encodedBaseRef}`,
  ]);
  if (!branchResult.ok) return false;
  return branchResult.value?.protection?.enabled === false;
}
