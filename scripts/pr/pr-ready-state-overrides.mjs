/**
 * Readiness overrides for the PR ready-state gates: who may post the
 * `/pr-ready-override` command, how one comment parses, and which overrides
 * are active for the current head.
 */

import { parseTimestamp } from "./pr-ready-state-review-signals.mjs";

export const HUMAN_OVERRIDE_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
const READINESS_OVERRIDE_COMMAND = "/pr-ready-override";
export const CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE =
  "codex-description-approval";
// The `base-red` blocker would otherwise deadlock its own recovery: the fix or
// revert PR that turns `main` green is blocked by the red `main` it exists to
// repair. This is the documented way out, and it carries exactly the same
// conditions as the Codex gate above — a human operator author, a reason, and
// binding to the current head — so it expires on any push.
export const BASE_RED_OVERRIDE_GATE = "base-red";
const SUPPORTED_OVERRIDE_GATES = new Set([
  CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE,
  BASE_RED_OVERRIDE_GATE,
]);

function issueCommentAuthorAssociation(comment) {
  return String(
    comment.author_association ?? comment.authorAssociation ?? "",
  ).toUpperCase();
}

function isHumanOverrideAuthor(comment) {
  return isTrustedHumanAuthor(comment, HUMAN_OVERRIDE_ASSOCIATIONS);
}

export function isTrustedHumanAuthor(comment, allowedAssociations) {
  if (allowedAssociations === null) return false;
  const login = comment.user?.login ?? comment.author?.login ?? "";
  const type = comment.user?.type ?? comment.author?.type ?? "";
  return (
    !String(login).endsWith("[bot]") &&
    type !== "Bot" &&
    allowedAssociations.has(issueCommentAuthorAssociation(comment))
  );
}

function extractOverrideValue(body, key) {
  const source = String(body ?? "");
  const pattern = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "i");
  return source.match(pattern)?.[1] ?? null;
}

function extractOverrideReason(body) {
  const match = String(body ?? "").match(/(?:^|\s)reason=(.+)$/im);
  return match?.[1]?.trim() ?? "";
}

export function parseReadinessOverrideComment(comment, currentHeadOid = null) {
  const body = String(comment.body ?? "");
  if (
    !body
      .trimStart()
      .match(new RegExp(`^${READINESS_OVERRIDE_COMMAND}\\b`, "i"))
  ) {
    return null;
  }

  const gate = extractOverrideValue(body, "gate")?.toLowerCase() ?? null;
  const head = extractOverrideValue(body, "head");
  // `base-red` names a specific red base commit, not just a head: `main`
  // advancing to a different red commit must need a fresh decision.
  const overrideBase = extractOverrideValue(body, "base");
  const reason = extractOverrideReason(body);
  const author = comment.user?.login ?? comment.author?.login ?? null;
  const createdAt = comment.created_at ?? comment.createdAt ?? null;
  const base = {
    gate,
    head,
    base: overrideBase,
    reason,
    author,
    authorAssociation:
      comment.author_association ?? comment.authorAssociation ?? null,
    url: comment.html_url ?? comment.url ?? null,
    createdAt,
    state: "ignored",
  };

  if (!isHumanOverrideAuthor(comment)) {
    return { ...base, reasonIgnored: "author_not_allowed" };
  }
  if (!SUPPORTED_OVERRIDE_GATES.has(gate)) {
    return { ...base, reasonIgnored: "unsupported_gate" };
  }
  if (!head || !currentHeadOid || head !== currentHeadOid) {
    return { ...base, reasonIgnored: "head_mismatch" };
  }
  if (!reason) {
    return { ...base, reasonIgnored: "missing_reason" };
  }
  if (gate === BASE_RED_OVERRIDE_GATE && !overrideBase) {
    return { ...base, reasonIgnored: "missing_base" };
  }

  return {
    ...base,
    state: "active",
  };
}

export function findActiveReadinessOverrides(
  issueComments = [],
  currentHeadOid = null,
) {
  return issueComments
    .map((comment) => parseReadinessOverrideComment(comment, currentHeadOid))
    .filter((override) => override?.state === "active")
    .sort((a, b) => {
      const aTime = parseTimestamp(a.createdAt) ?? 0;
      const bTime = parseTimestamp(b.createdAt) ?? 0;
      return bTime - aTime;
    });
}
