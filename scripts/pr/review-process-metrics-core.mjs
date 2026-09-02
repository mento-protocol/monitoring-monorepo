const CODEX_BOT_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const CLAUDE_BOT_LOGINS = new Set(["claude", "claude[bot]"]);
const GITHUB_ACTIONS_BOT_LOGINS = new Set([
  "github-actions",
  "github-actions[bot]",
]);
const CODERABBIT_BOT_LOGINS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const CURSOR_BOT_LOGINS = new Set(["cursor", "cursor[bot]"]);
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const TRUSTED_REQUEST_AUTHORS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
  "claude",
  "claude[bot]",
]);

const BOT_DEFINITIONS = [
  { key: "coderabbit", logins: CODERABBIT_BOT_LOGINS },
  { key: "codex", logins: CODEX_BOT_LOGINS },
  { key: "claude", logins: CLAUDE_BOT_LOGINS },
  { key: "cursor", logins: CURSOR_BOT_LOGINS },
];
export const REVIEW_BOT_KEYS = Object.freeze(
  BOT_DEFINITIONS.map(({ key }) => key),
);

const REVIEW_BOT_LOGINS = new Set(
  BOT_DEFINITIONS.flatMap(({ logins }) => [...logins]),
);
export const VERIFIED_CLAUDE_ACTIONS_EVIDENCE = Symbol(
  "verified-claude-actions-evidence",
);
const CLAUDE_ACTIONS_HEADER =
  /^\*\*Claude finished @([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))['’]s task(?: in \d+(?:h|m|s)(?:\s+\d+(?:h|m|s)){0,2})?\*\*/m;
const CLAUDE_ACTIONS_RUN_LINK =
  /\[View job\]\((https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*(?:\/job\/[1-9]\d*)?)\)/i;
const CLAUDE_REVIEW_STRUCTURE =
  /^(?:#{1,6}\s+(?:Claude finished the review|(?:Code\s+)?Review(?::\s*\S|\s+(?:complete|result|summary)\b))|(?:#{1,6}\s+)?\*{0,2}(?:overall\s+)?verdict\*{0,2}\s*:\s*\*{0,2}\S)/im;

export function authorLogin(value) {
  return String(value?.author?.login ?? value?.user?.login ?? "").toLowerCase();
}

function authorAssociation(value) {
  return String(
    value?.author_association ?? value?.authorAssociation ?? "",
  ).toUpperCase();
}

function isKnownLogin(login, logins) {
  return logins.has(String(login ?? "").toLowerCase());
}

export function botKeyForLogin(login) {
  return (
    BOT_DEFINITIONS.find(({ logins }) => isKnownLogin(login, logins))?.key ??
    null
  );
}

function githubRepositoryFromUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const [owner, repository, ...rest] = url.pathname
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      !owner ||
      !repository ||
      rest.length === 0
    ) {
      return null;
    }
    return `${owner}/${repository}`.toLowerCase();
  } catch {
    return null;
  }
}

export function claudeActionsRunEvidence(
  value,
  prUrl = value?.html_url ?? value?.url,
) {
  const body = String(value?.body ?? "");
  const header = body.match(CLAUDE_ACTIONS_HEADER);
  const runUrl = body.match(CLAUDE_ACTIONS_RUN_LINK)?.[1] ?? null;
  const prRepository = githubRepositoryFromUrl(prUrl);
  const runId = /\/actions\/runs\/([1-9]\d*)/i.exec(runUrl ?? "")?.[1];
  return isKnownLogin(authorLogin(value), GITHUB_ACTIONS_BOT_LOGINS) &&
    prRepository !== null &&
    header &&
    githubRepositoryFromUrl(runUrl) === prRepository &&
    CLAUDE_REVIEW_STRUCTURE.test(body) &&
    runId
    ? { runId, runUrl, actorLogin: header[1].toLowerCase() }
    : null;
}

export function isClaudeEvidence(value, prUrl = value?.html_url ?? value?.url) {
  return (
    isClaudeBotLogin(authorLogin(value)) ||
    (value?.[VERIFIED_CLAUDE_ACTIONS_EVIDENCE]?.type ===
      "claude_github_actions_run" &&
      claudeActionsRunEvidence(value, prUrl) !== null)
  );
}

export function botKeyForEvidence(
  value,
  prUrl = value?.html_url ?? value?.url,
) {
  return (
    botKeyForLogin(authorLogin(value)) ??
    (isClaudeEvidence(value, prUrl) ? "claude" : null)
  );
}

export function isReviewBotEvidence(
  value,
  prUrl = value?.html_url ?? value?.url,
) {
  return botKeyForEvidence(value, prUrl) !== null;
}

export function isTrustedRequestAuthor(value) {
  return (
    isTrustedAuthorAssociation(value) ||
    TRUSTED_REQUEST_AUTHORS.has(authorLogin(value))
  );
}

export function isTrustedAuthorAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(authorAssociation(value));
}

export function isReviewBotLogin(login) {
  return isKnownLogin(login, REVIEW_BOT_LOGINS);
}

export function isCodexBotLogin(login) {
  return isKnownLogin(login, CODEX_BOT_LOGINS);
}

export function isClaudeBotLogin(login) {
  return isKnownLogin(login, CLAUDE_BOT_LOGINS);
}

export function isFindingLikeText(value) {
  const body = String(value ?? "");
  return (
    /\[[Pp][0-3]\]/.test(body) ||
    /\b[Pp][0-3]\s+Badge\b/.test(body) ||
    /\bBUGBOT_BUG_ID\b/.test(body) ||
    /<!--\s*cr-indicator-types\s*:/i.test(body) ||
    /_\s*(?:\p{Extended_Pictographic}️?\s*)?(?:Critical|Major|Minor|Trivial)\s*_/u.test(
      body,
    ) ||
    /\bchanges requested\b/i.test(body) ||
    /\b(?:critical|high|medium|low) severity\b/i.test(body) ||
    /\bfindings?\b/i.test(body)
  );
}

export function isCodexUsageLimit(value) {
  return /codex usage limits have been reached/i.test(String(value ?? ""));
}

export function isCodexApprovalComment(value) {
  return /codex review:\s+did(?:n['’]?t| not) find any major issues/i.test(
    String(value ?? ""),
  );
}

export function isClaudeSummary(value) {
  return /claude finished|pr review(?:\s*[:\u2014-]|$)/i.test(
    String(value ?? ""),
  );
}

function normalizedExcerpt(body) {
  return String(body ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function evidenceUrl(value, prUrl) {
  return value.html_url ?? value.url ?? prUrl ?? null;
}

export function evidenceCreatedAt(value) {
  return (
    value.createdAt ??
    value.created_at ??
    value.submittedAt ??
    value.submitted_at ??
    null
  );
}

export function baseEvidence(
  value,
  { prUrl, surface, finding = false, findingSignal = null },
) {
  const attributionProof = value?.[VERIFIED_CLAUDE_ACTIONS_EVIDENCE] ?? null;
  const hasProof = attributionProof?.type === "claude_github_actions_run";
  return {
    id: String(value.id ?? value.node_id ?? "unknown"),
    url: evidenceUrl(value, prUrl),
    author: authorLogin(value) || null,
    authorAssociation:
      value.author_association ?? value.authorAssociation ?? null,
    surface,
    createdAt: evidenceCreatedAt(value),
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
    path: value.path ?? null,
    finding,
    ...(findingSignal === null ? {} : { findingSignal }),
    ...(hasProof ? { attributionProof } : {}),
    excerpt: normalizedExcerpt(value.body),
  };
}
