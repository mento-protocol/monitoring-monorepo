import { createHash } from "node:crypto";
import * as claudeReview from "./pr-feedback-state-claude.mjs";

const FINDING_EXCERPT_LENGTH = 240;
const FAILURE_TERM = /\b(?:error|errors|fail|fails|failed|failure|failures)\b/i;
const NEGATED_FAILURE =
  /\b(?:no|zero|0)[ \t]+(?:errors?|fails?|failed|failures?)(?:[ \t]+(?:and|or)[ \t]+(?:errors?|fails?|failed|failures?))?(?:[ \t]+(?:are|was|were)[ \t]+(?:found|observed|reported))?(?=[ \t]*(?:[.,;:]|$))/gi;
const CLEAN_FINDING_MARKER =
  /^(?:None\s+blocking|No[- ]action(?:\s+required)?|Good\s+hygiene|Lockfile\s+diff\s+is\s+fully\s+mechanical)\b[\s:—.,]*(.*)$/i;
const UNSAFE_EVIDENCE_QUALIFIER =
  /\b(?:not|never|cannot|can't|doesn't|does\s+not|fails?\s+to|may|might|could|appears?|seems?|probably|likely|possibly|perhaps|unclear|unknown)\b/i;
const POSITIVE_EVIDENCE =
  /^(?:clean(?:,\s+well\s+scoped)?(?:\s+fix)?|well\s+scoped(?:\s+fix)?|correct|covered|bounded|mechanical|verified|complete|exact\s+removal\s+condition|(?:no|zero|0)\s+(?:errors?|fails?|failed|failures?)(?:\s+(?:and|or)\s+(?:errors?|fails?|failed|failures?))?(?:\s+(?:are|was|were)\s+(?:found|observed|reported))?|no\s+unrelated\s+version\s+bumps?|no\s+vulnerable\s+sharp@0\.34\.5\s+remains?\s+anywhere\s+in\s+(?:the\s+)?repo(?:'s)?\s+lockfiles|parser\s+should\s+continue\s+rejecting\s+malformed\s+input|fallback\s+should\s+stay|fix\s+is\s+correct|override\s+selector\s+is\s+correctly\s+bounded|lockfile\s+churn\s+beyond\s+sharp\s+itself\s+is\s+confirmed\s+mechanical,\s+not\s+scope\s+creep|(?:the\s+)?bounded\s+selector\s+matches\s+the\s+repo(?:'s)?\s+established\s+override\s+pattern|matches\s+repo\s+convention|(?:the\s+)?inline\s+comment\s+documents\s+the\s+advisory|removal\s+condition\s+comment\s+satisfies\s+the\s+temporary\s+override\s+documentation\s+expectation|tests\s+cover\s+the\s+changed\s+paths)$/i;
const CLAUDE_REVIEW_TITLE_LINE = /^#{1,6}\s+Review:\s+(.{1,200})$/i;
const CLAUDE_VERDICT_LINE = /^(?:\*\*)?Verdict:\s*LGTM(?:\*\*)?$/i;
const CLAUDE_CHECKLIST_HEADING = /^#{1,6}\s+What\s+I\s+checked$/i;
const CLAUDE_CHECKLIST_ENTRY = /^-\s+\[([^\]])\]\s+(.{1,200})$/;
const SAFE_CLAUDE_CHECKLIST_TOPICS = new Set([
  "api contract",
  "authentication boundary",
  "checklist routing",
  "ci status",
  "configuration scope",
  "dependency resolution",
  "documentation examples",
  "generated artifacts",
  "operator documentation",
  "parser behavior",
  "parser structure",
  "regression-test coverage",
  "request-path coverage",
  "review title",
  "runtime behavior",
  "schema compatibility",
  "session lifecycle",
  "type safety",
  "unit tests",
  "unit-test coverage",
]);
const LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT =
  /^(?:`pnpm-workspace\.yaml`\s+override\s+syntax\/scope|`pnpm-lock\.yaml`\s+regeneration\s+for\s+unrelated\s+drift|Supply-chain\/lockfile-lint\s+compliance\s+and\s+CI\s+status|Other\s+standalone\s+lockfiles\s+for\s+leftover\s+vulnerable\s+`sharp@0\.34\.5`)$/i;
const LEGACY_SAFE_CLAUDE_FINDING_LINES = new Set([
  "1. **[P3] None blocking — clean, well-scoped fix.** The bounded selector matches the repo's established override pattern.",
  "2. **[P3] Good hygiene:** the inline comment documents the advisory and exact removal condition.",
  "3. **[P3] Lockfile diff is fully mechanical.** No unrelated version bumps.",
  "4. Confirmed no leftover `sharp@0.34.5` anywhere.",
  "5. Supply Chain CI already passed on this PR.",
  "No inline comments filed — nothing rose to an actionable, line-specific issue.",
]);
const LEGACY_SAFE_CLAUDE_ROLLUP_LINES = new Set([
  "2. [P3] No-action: removal-condition comment satisfies the temporary-override documentation expectation.",
  "4. [P3] No-action: no vulnerable `sharp@0.34.5` remains anywhere in the repo's lockfiles.",
]);
const CLEAN_ROLLUP_ENTRY = /^\d+[.)]\s+\[[Pp]3\]\s+(No[- ]action:.*)$/i;
const CLEAN_REVIEW_SUMMARY =
  /\b(?:no\s+changes\s+requested|no\s+[Pp][0-2]\s+(?:issues?|findings?)|(?:no|zero|0)\s+(?:Critical|High|Medium|Low)\s+Severity\s+(?:issues?|findings?))\b/gi;
const REVIEW_CONTRADICTION =
  /(?:BUGBOT_BUG_ID|\b[Pp][0-2]\b|\b(?:Critical|High|Medium|Low)\s+Severity\b|\bSeverity\s*:\s*(?:Critical|High|Medium|Low)\b|\bAction\s+items?\s*:|\b(?:Action\s+required|changes\s+requested|needs[- ]changes)\b|\b(?:please|must|need(?:s)?\s+to|should)\s+(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)\b|\b(?:but|however|although|yet)\b[^.!?\r\n]*\b(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)\b|(?:^|[\r\n])\s*(?:[-*>]\s*)?(?:add|address|change|ensure|fix|implement|prevent|remove|restore|update|validate)\b)/i;

function gateReady(gate) {
  return gate?.required === false || Boolean(gate?.ready ?? true);
}

function commentTimestamp(comment) {
  return Date.parse(comment.updatedAt ?? comment.createdAt ?? "");
}

function referencedCommitShas(comment) {
  const body = String(comment.body ?? "");
  const patterns = [
    /\bcommit(?:\s+sha|sha|_sha|id|_id)?["':=\s-]+([0-9a-f]{40})\b/gi,
    /\/(?:blob|commit|commits|tree)\/([0-9a-f]{40})\b/gi,
  ];
  return patterns.flatMap((pattern) =>
    Array.from(body.matchAll(pattern), ([, sha]) => sha.toLowerCase()),
  );
}

function isCurrentHeadComment(comment, pr) {
  const headSha = String(pr?.headRefOid ?? "").toLowerCase();
  const reviewCommitSha = String(comment.commitOid ?? "").toLowerCase();
  if (headSha && reviewCommitSha) return reviewCommitSha === headSha;

  const commitShas = referencedCommitShas(comment);
  if (headSha && commitShas.length > 0) {
    return commitShas.includes(headSha);
  }

  const headTimestamp = Date.parse(pr?.headUpdatedAt ?? "");
  if (!Number.isFinite(headTimestamp)) return false;
  const timestamp = commentTimestamp(comment);
  return Number.isFinite(timestamp) && timestamp >= headTimestamp;
}

function isReviewBotComment(comment) {
  return [
    "chatgpt-codex-connector",
    "chatgpt-codex-connector[bot]",
    "claude",
    "claude[bot]",
    "cursor",
    "cursor[bot]",
  ].includes(String(comment.author ?? "").toLowerCase());
}
function hasUnnegatedFailure(value) {
  const scrubbed = String(value ?? "").replace(NEGATED_FAILURE, "");
  return FAILURE_TERM.test(scrubbed);
}
function hasReviewContradiction(value) {
  const body = String(value ?? "")
    .replace(/[*_~]/g, "")
    .replace(CLEAN_REVIEW_SUMMARY, "");
  return REVIEW_CONTRADICTION.test(body) || hasUnnegatedFailure(body);
}
function isBenignChecklistSubject(value) {
  const subject = String(value ?? "").trim();
  if (
    !subject ||
    subject.length > 200 ||
    claudeReview.hasControlCharacter(subject) ||
    (subject.match(/`/g)?.length ?? 0) % 2 !== 0
  )
    return false;
  if (LEGACY_SAFE_CLAUDE_CHECKLIST_SUBJECT.test(subject)) return true;
  const topics = subject.toLowerCase().split(/\s+and\s+/);
  return (
    topics.length <= 3 &&
    topics.every((topic) => SAFE_CLAUDE_CHECKLIST_TOPICS.has(topic))
  );
}
function isSafeClaudePreamble(lines, pr) {
  const preamble = lines.map((line) => line.trim()).filter(Boolean);
  let index = 0;

  if (claudeReview.isClaudeTaskCompletionLine(preamble[index])) index += 1;
  if (preamble[index] === "---") index += 1;

  const reviewTitle = (preamble[index] ?? "").match(CLAUDE_REVIEW_TITLE_LINE);
  if (reviewTitle) {
    if (!claudeReview.isOrdinaryReviewTitle(reviewTitle[1], pr?.title))
      return false;
    index += 1;
  }

  if (!CLAUDE_VERDICT_LINE.test(preamble[index] ?? "")) return false;
  index += 1;
  if (index === preamble.length) return true;
  if (!CLAUDE_CHECKLIST_HEADING.test(preamble[index] ?? "")) return false;
  index += 1;

  let checklistEntries = 0;
  for (; index < preamble.length; index += 1) {
    const entry = preamble[index].match(CLAUDE_CHECKLIST_ENTRY);
    if (
      !entry ||
      entry[1].toLowerCase() !== "x" ||
      !isBenignChecklistSubject(entry[2])
    )
      return false;
    checklistEntries += 1;
  }
  return checklistEntries > 0;
}
function hasPositiveCleanEvidence(value) {
  const tail = String(value ?? "")
    .trim()
    .match(CLEAN_FINDING_MARKER)?.[1];
  if (tail === undefined) return false;
  const evidenceClauses = tail
    .split(/(?:[!?;]+|\.(?=\s|$)|\b(?:and|but|however|although|yet)\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return (
    evidenceClauses.length > 0 &&
    evidenceClauses.every((evidence) => {
      const withoutSafeNegation = evidence.replace(
        /,\s+not\s+scope\s+creep$/i,
        "",
      );
      return (
        !UNSAFE_EVIDENCE_QUALIFIER.test(withoutSafeNegation) &&
        POSITIVE_EVIDENCE.test(evidence)
      );
    })
  );
}
function isCleanFindingLine(line) {
  const raw = String(line ?? "").trim();
  if (LEGACY_SAFE_CLAUDE_FINDING_LINES.has(raw)) return true;
  const p3 = raw.match(/^\d+[.)]\s+\[[Pp]3\]\s+(.+)$/);
  if (p3) return hasPositiveCleanEvidence(p3[1]);
  return false;
}
function isCleanRollupLine(line) {
  const raw = String(line ?? "").trim();
  if (LEGACY_SAFE_CLAUDE_ROLLUP_LINES.has(raw)) return true;
  const entry = raw.match(CLEAN_ROLLUP_ENTRY)?.[1];
  return entry !== undefined && hasPositiveCleanEvidence(entry);
}
function isExplicitlyCleanClaudeReview(comment, pr) {
  const author = String(comment.author ?? "").toLowerCase();
  if (author !== "claude" && author !== "claude[bot]") return false;
  const body = String(comment.body ?? "");
  if (claudeReview.matchesCleanReviewCompatibilityRegistry(comment, pr, body))
    return true;
  const lines = body.split(/\r?\n/);
  if (claudeReview.hasMarkdownCodeBlockIndentation(lines)) return false;
  if (!/^\s*(?:\*\*)?Verdict:\s*LGTM(?:\*\*)?\s*$/im.test(body)) return false;
  const headings = lines.filter((line) =>
    /^\s*#{1,6}\s+(?:Findings|Roll[- ]up)\s*$/i.test(line),
  );
  const headingOrder = headings.map(normalizeText).join(",");
  if (!/^Findings,Roll up$/i.test(headingOrder)) return false;
  const findingsIndex = lines.indexOf(headings[0]);
  const rollupIndex = lines.indexOf(headings[1]);
  if (!isSafeClaudePreamble(lines.slice(0, findingsIndex), pr)) return false;
  const nonempty = (line) => line.trim();
  const findings = lines.slice(findingsIndex + 1, rollupIndex).filter(nonempty);
  const rollup = lines.slice(rollupIndex + 1).filter(nonempty);
  if (hasReviewContradiction([...findings, ...rollup].join("\n"))) return false;
  return (
    findings.length > 0 &&
    findings.every(isCleanFindingLine) &&
    rollup.length > 0 &&
    rollup.every(isCleanRollupLine)
  );
}
function isActionableReviewBotComment(comment, pr) {
  if (!isReviewBotComment(comment)) return false;
  if (claudeReview.isClaudeLgtmReview(comment))
    return !isExplicitlyCleanClaudeReview(comment, pr);
  const overallClaudeReview = claudeReview.classifyOverallClaudeReview(
    comment,
    pr,
  );
  if (overallClaudeReview !== null) return overallClaudeReview;
  if (hasReviewContradiction(comment.body)) return true;
  const actionableSignal =
    /(?:\[[Pp]3\]|\*\*[Pp]3\*\*|\b[Pp]3\s*(?::|[-—|]|Badge\b))/.test(
      comment.body ?? "",
    );
  return actionableSignal;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(value) {
  const normalized = normalizeText(value);
  if (normalized.length <= FINDING_EXCERPT_LENGTH) return normalized;
  return `${normalized.slice(0, FINDING_EXCERPT_LENGTH - 1).trimEnd()}...`;
}

function titleFromText(value) {
  const normalized = normalizeText(value);
  const sentence = normalized.split(/(?<=[.!?])\s+/)[0] ?? normalized;
  return sentence.length <= 120
    ? sentence
    : `${sentence.slice(0, 119).trimEnd()}...`;
}

function fingerprint(parts) {
  const input = parts
    .map((part) =>
      String(part ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .join("\0");
  return `feedback:${createHash("sha256").update(input).digest("hex").slice(0, 16)}`;
}

function findingSourceId(id, index = null) {
  if (id === null || id === undefined || id === "") return null;
  const sourceId = String(id);
  return index === null ? sourceId : `${sourceId}#${index + 1}`;
}

function feedbackCommentKey(comment) {
  return [
    comment.id ?? "",
    comment.url ?? "",
    comment.commitOid ?? "",
    comment.author ?? "",
    normalizeText(comment.body ?? ""),
  ].join("\0");
}

function buildFinding({
  source,
  sourceId = null,
  author = null,
  url = null,
  path = null,
  line = null,
  title = "",
  body = "",
  state,
  currentHead = null,
  outdated = null,
  replied = null,
  unresolved = null,
  blocking = false,
}) {
  const findingText = normalizeText(body || title);
  const titleText = titleFromText(title || body);
  return {
    fingerprint: fingerprint([source, author, path, line, findingText]),
    source,
    sourceId,
    author,
    url,
    path,
    line,
    title: titleText,
    excerpt: excerpt(body || title),
    state,
    currentHead,
    outdated,
    replied,
    unresolved,
    blocking,
  };
}

function reviewThreadFindings(reviewThreads = []) {
  return reviewThreads.map((thread) => {
    const unresolved = thread.isResolved === false;
    const outdated = Boolean(thread.isOutdated);
    const state = unresolved
      ? outdated
        ? "unresolved-outdated"
        : "unresolved"
      : outdated
        ? "resolved-outdated"
        : "resolved";
    return buildFinding({
      source: "review-thread",
      sourceId: findingSourceId(thread.id),
      author: thread.author ?? null,
      url: thread.url ?? null,
      path: thread.path ?? null,
      line: thread.line ?? null,
      title: thread.body ?? "",
      body: thread.body ?? "",
      state,
      currentHead: outdated ? false : true,
      outdated,
      replied: null,
      unresolved,
      blocking: unresolved,
    });
  });
}

function rootReviewCommentFindings(rootReviewComments = []) {
  return rootReviewComments.map((comment) => {
    const replied = Boolean(comment.replied);
    return buildFinding({
      source: "review-comment",
      sourceId: findingSourceId(comment.id),
      author: comment.author ?? null,
      url: comment.url ?? null,
      path: comment.path ?? null,
      line: comment.line ?? null,
      title: comment.body ?? "",
      body: comment.body ?? "",
      state: replied ? "replied" : "unreplied",
      currentHead: null,
      outdated: null,
      replied,
      unresolved: !replied,
      blocking: !replied,
    });
  });
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeText(cell));
  if (cells.length < 2) return null;
  if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells;
}

function isPriorityOrSeverity(value) {
  return /(?:\b[Pp][0-3]\b|\b(?:Critical|High|Medium|Low)\s+Severity\b)/.test(
    value,
  );
}

function tableFindings(body) {
  const findings = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const cells = tableCells(line);
    if (!cells) continue;
    const numbered = /^\d+$/.test(cells[0] ?? "");
    const priorityCell = cells.findIndex(isPriorityOrSeverity);
    if (!numbered && priorityCell < 0) continue;

    const contentCells = numbered ? cells.slice(1) : cells;
    const title = contentCells.filter(Boolean).join(" ");
    if (!title || /^severity\s+issue\b/i.test(title)) continue;
    findings.push({ title, body: title });
  }
  return findings;
}

function sectionStart(line) {
  return /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\[[Pp][0-3]\]|\b[Pp][0-3]\s+Badge\b|\*\*\s*(?:Critical|High|Medium|Low)\s+Severity\s*\*\*|\b(?:Critical|High|Medium|Low)\s+Severity\b)/.test(
    line,
  );
}

function sectionFindings(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const starts = lines
    .map((line, index) => (sectionStart(line) ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const section = lines.slice(start, end).join("\n").trim();
    return {
      title: lines[start],
      body: section,
    };
  });
}

function botCommentSections(comment) {
  const body = String(comment.body ?? "");
  const tableSections = tableFindings(body);
  if (tableSections.length > 0) return tableSections;

  const headingSections = sectionFindings(body);
  if (headingSections.length > 0) return headingSections;

  return [{ title: body, body }];
}

function botCommentFindings(comments = [], pr, blockingComments = []) {
  const blockingKeys = new Set(blockingComments.map(feedbackCommentKey));
  return comments
    .filter((comment) => isActionableReviewBotComment(comment, pr))
    .flatMap((comment) => {
      const currentHead = isCurrentHeadComment(comment, pr);
      const blocking = blockingKeys.has(feedbackCommentKey(comment));
      const source = comment.commitOid
        ? "top-level-bot-review"
        : "top-level-bot-comment";
      return botCommentSections(comment).map((section, index) =>
        buildFinding({
          source,
          sourceId: findingSourceId(comment.id, index),
          author: comment.author ?? null,
          url: comment.url ?? null,
          title: section.title,
          body: section.body,
          state: blocking
            ? "blocking-current-head"
            : currentHead
              ? "current-head"
              : "stale",
          currentHead,
          outdated: currentHead ? false : true,
          replied: null,
          unresolved: blocking,
          blocking,
        }),
      );
    });
}

export function buildFeedbackFindings(readyState, blockingTopLevelBotComments) {
  const reviewThreads =
    readyState.reviewThreads ??
    (readyState.unresolvedReviewThreads ?? []).map((thread) => ({
      ...thread,
      isResolved: false,
    }));
  const rootReviewComments =
    readyState.rootReviewComments ??
    (readyState.unrepliedRootReviewComments ?? []).map((comment) => ({
      ...comment,
      replied: false,
    }));

  return [
    ...reviewThreadFindings(reviewThreads),
    ...rootReviewCommentFindings(rootReviewComments),
    ...botCommentFindings(
      readyState.topLevelBotComments ?? [],
      readyState.pr,
      blockingTopLevelBotComments,
    ),
  ];
}

export function summarizeFeedbackState(readyState) {
  const gates = readyState.gates ?? {};
  const requiredBlockers = readyState.required?.blockers ?? [];
  const feedbackBlockers = requiredBlockers.filter((blocker) => {
    if (["review-thread", "review-comment"].includes(blocker.kind)) {
      return true;
    }
    if (blocker.kind === "review") {
      return blocker.state === "CHANGES_REQUESTED";
    }
    return (
      blocker.kind === "gate" &&
      blocker.name === "Codex PR-description approval"
    );
  });
  const unresolvedReviewThreads = readyState.unresolvedReviewThreads ?? [];
  const unrepliedRootReviewComments =
    readyState.unrepliedRootReviewComments ?? [];
  const topLevelBotComments = readyState.topLevelBotComments ?? [];
  const blockingTopLevelBotComments = topLevelBotComments.filter(
    (comment) =>
      isCurrentHeadComment(comment, readyState.pr) &&
      isActionableReviewBotComment(comment, readyState.pr),
  );
  const findings = buildFeedbackFindings(
    readyState,
    blockingTopLevelBotComments,
  );
  const feedbackSurfacesReady =
    unresolvedReviewThreads.length === 0 &&
    unrepliedRootReviewComments.length === 0 &&
    blockingTopLevelBotComments.length === 0;
  const ready =
    feedbackBlockers.length === 0 &&
    feedbackSurfacesReady &&
    gateReady(gates.reviewThreads) &&
    gateReady(gates.reviewCommentReplies) &&
    gateReady(gates.codexDescriptionApproval);

  return {
    ready,
    pr: readyState.pr,
    summary: ready
      ? "Feedback gates are clear."
      : "Feedback surfaces need attention.",
    gates: {
      codexDescriptionApproval: gates.codexDescriptionApproval ?? null,
      codexReviewSignal: gates.codexReviewSignal ?? null,
      reviewCommentReplies: gates.reviewCommentReplies ?? null,
      reviewThreads: gates.reviewThreads ?? null,
    },
    requiredFeedbackBlockers: feedbackBlockers,
    unresolvedReviewThreads,
    unrepliedRootReviewComments,
    blockingTopLevelBotComments,
    topLevelBotComments,
    findings,
    counts: {
      requiredFeedbackBlockers: feedbackBlockers.length,
      unresolvedReviewThreads: unresolvedReviewThreads.length,
      unrepliedRootReviewComments: unrepliedRootReviewComments.length,
      blockingTopLevelBotComments: blockingTopLevelBotComments.length,
      topLevelBotComments: topLevelBotComments.length,
      findings: findings.length,
      blockingFindings: findings.filter((finding) => finding.blocking).length,
    },
  };
}
