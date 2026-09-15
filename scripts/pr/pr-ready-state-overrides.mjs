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
  const reason = extractOverrideReason(body);
  const author = comment.user?.login ?? comment.author?.login ?? null;
  const createdAt = comment.created_at ?? comment.createdAt ?? null;
  const base = {
    gate,
    head,
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
  if (gate !== CODEX_DESCRIPTION_APPROVAL_OVERRIDE_GATE) {
    return { ...base, reasonIgnored: "unsupported_gate" };
  }
  if (!head || !currentHeadOid || head !== currentHeadOid) {
    return { ...base, reasonIgnored: "head_mismatch" };
  }
  if (!reason) {
    return { ...base, reasonIgnored: "missing_reason" };
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
