import { actionableFindingSignal } from "./review-process-metrics-finding-classifier.mjs";
import { maskMarkdownNonProse } from "./review-process-metrics-markdown.mjs";
import {
  REVIEW_BOT_KEYS,
  authorLogin,
  baseEvidence,
  botKeyForEvidence,
  evidenceCreatedAt,
  isReviewBotEvidence,
  isReviewBotLogin,
  isTrustedAuthorAssociation,
} from "./review-process-metrics-core.mjs";

const DISPOSITIONS = [
  "fixed",
  "wont_fix",
  "bot_conceded",
  "unclassified",
  "unknown",
];
const SURFACES = ["issue_comments", "review_submissions", "review_comments"];

function isPrAuthor(value, prAuthorLogin) {
  return (
    Boolean(prAuthorLogin) &&
    authorLogin(value) === String(prAuthorLogin).toLowerCase()
  );
}

function isTrustedHumanReply(reply, prAuthorLogin) {
  const login = authorLogin(reply);
  const type = String(
    reply?.user?.type ?? reply?.author?.type ?? "",
  ).toLowerCase();
  if (isReviewBotLogin(login) || type === "bot" || login.endsWith("[bot]")) {
    return false;
  }
  return isPrAuthor(reply, prAuthorLogin) || isTrustedAuthorAssociation(reply);
}

function humanClassification(body) {
  const text = maskMarkdownNonProse(body, {
    maskRawHtmlNonProse: true,
    preserveInlineCode: true,
  });
  const fixed = text.match(/^\s*(Fixed in\s+`?[0-9a-f]{7,40}`?\s+[—-])\s+\S/im);
  if (fixed) {
    return { category: "fixed", signal: fixed[1] };
  }
  const wontFix = text.match(/^\s*(Won['’]t fix:)\s+\S/im);
  if (wontFix) {
    return { category: "wont_fix", signal: wontFix[1] };
  }
  return null;
}

const BOT_STANCE_PATTERNS = {
  concession: [
    String.raw`I\s+(?:am\s+withdrawing|withdraw)\s+(?:this|the)\s+finding`,
    String.raw`(?:this|the)\s+finding\s+(?:is|was)\s+withdrawn`,
    String.raw`(?:this|the)\s+finding\s+does\s+not\s+apply`,
    String.raw`(?:(?:agreed|I agree|you(?:'re| are) right)\s*[,:—-]\s*)?(?:this|it)\s+(?:is|was)\s+(?:indeed\s+)?a\s+false positive`,
  ],
  restoration: [
    String.raw`(?:this|it)\s+(?:is|was)\s+not\s+a\s+false positive`,
    String.raw`(?:this|the)\s+finding\s+(?:still\s+)?applies`,
    String.raw`I\s+(?:still\s+)?stand\s+by\s+(?:this|the)\s+finding`,
    String.raw`(?:this|the)\s+finding\s+(?:is|was)\s+not\s+withdrawn`,
    String.raw`I\s+(?:do\s+not|don't)\s+withdraw\s+(?:this|the)\s+finding`,
  ],
};

function explicitBotStances(body) {
  const sentenceBoundary =
    String.raw`(?:^|[.!?]\s+|\n)\s*(?:` + String.raw`@[^\s,]+,?\s*)?`;
  const sentenceEnd = String.raw`(?=\s*(?:[.!]|$|\n))`;
  const text = maskMarkdownNonProse(body, { maskRawHtmlNonProse: true });
  return Object.entries(BOT_STANCE_PATTERNS)
    .flatMap(([stance, patterns]) =>
      patterns.flatMap((pattern) =>
        [
          ...text.matchAll(
            new RegExp(`${sentenceBoundary}(${pattern})${sentenceEnd}`, "gim"),
          ),
        ].map((match) => ({
          stance,
          index: match.index ?? 0,
          signal: match[1],
        })),
      ),
    )
    .sort((left, right) => left.index - right.index);
}

function orderedSameBotStances(replies, findingBot, prUrl) {
  return replies
    .flatMap((reply, replyIndex) => {
      if (botKeyForEvidence(reply, prUrl) !== findingBot) return [];
      const replyTime = Date.parse(evidenceCreatedAt(reply) ?? "");
      return explicitBotStances(reply.body).map(
        ({ stance, index, signal }) => ({
          stance,
          index,
          signal,
          reply,
          replyIndex,
          replyTime: Number.isFinite(replyTime) ? replyTime : Infinity,
        }),
      );
    })
    .sort(
      (left, right) =>
        left.replyTime - right.replyTime ||
        left.replyIndex - right.replyIndex ||
        left.index - right.index,
    );
}

function classifyInlineDisposition(replies, prUrl, findingBot, prAuthorLogin) {
  const nonBotReplies = replies.filter(
    (reply) => !isReviewBotEvidence(reply, prUrl),
  );
  const humanReplies = nonBotReplies.filter((reply) =>
    isTrustedHumanReply(reply, prAuthorLogin),
  );
  const untrustedReplies = nonBotReplies.filter(
    (reply) => !isTrustedHumanReply(reply, prAuthorLogin),
  );
  const classified = humanReplies
    .map((reply) => ({
      reply,
      classification: humanClassification(reply.body),
    }))
    .filter(({ classification }) => classification !== null);
  const categories = new Set(
    classified.map(({ classification }) => classification.category),
  );
  const botStances = orderedSameBotStances(replies, findingBot, prUrl);
  const finalBotStance = botStances.reduce((effectiveStance, { stance }) => {
    if (stance === "concession") return "concession";
    return effectiveStance === null ? null : "restoration";
  }, null);
  const evidence = classified.map(({ reply, classification }) => ({
    ...baseEvidence(reply, {
      prUrl,
      surface: "review_comments",
    }),
    category: classification.category,
    dispositionSignal: classification.signal,
  }));
  const stanceEvidence = (stance) => {
    const matchesByReply = new Map();
    for (const item of botStances) {
      if (item.stance !== stance || matchesByReply.has(item.reply)) continue;
      matchesByReply.set(item.reply, item);
    }
    return [...matchesByReply.values()].map(({ reply, signal }) => ({
      ...baseEvidence(reply, { prUrl, surface: "review_comments" }),
      dispositionSignal: signal,
    }));
  };
  const untrustedReplyEvidence = untrustedReplies.map((reply) => {
    const classification = humanClassification(reply.body);
    return {
      ...baseEvidence(reply, { prUrl, surface: "review_comments" }),
      claimedCategory: classification?.category ?? null,
      ...(classification === null
        ? {}
        : { dispositionSignal: classification.signal }),
    };
  });
  const classificationEvidence = {
    humanClassificationEvidence: evidence,
    botConcessionEvidence: stanceEvidence("concession"),
    botRestorationEvidence: stanceEvidence("restoration"),
    untrustedReplyEvidence,
  };

  if (categories.size > 1) {
    return {
      disposition: "unknown",
      reason: "conflicting_human_classifications",
      ...classificationEvidence,
    };
  }
  if (categories.has("fixed")) {
    return {
      disposition: "fixed",
      reason: "explicit_human_fixed_reply",
      ...classificationEvidence,
    };
  }
  if (categories.has("wont_fix") && finalBotStance === "concession") {
    return {
      disposition: "bot_conceded",
      reason: "human_wont_fix_and_bot_withdrew",
      ...classificationEvidence,
    };
  }
  if (categories.has("wont_fix")) {
    return {
      disposition: "wont_fix",
      reason: "explicit_human_wont_fix_reply",
      ...classificationEvidence,
    };
  }
  if (finalBotStance === "concession") {
    return {
      disposition: "bot_conceded",
      reason: "bot_withdrew_finding",
      ...classificationEvidence,
    };
  }
  if (finalBotStance === "restoration") {
    return {
      disposition: "unknown",
      reason: "bot_restored_finding_without_human_classification",
      ...classificationEvidence,
    };
  }
  if (humanReplies.length > 0) {
    return {
      disposition: "unknown",
      reason: "human_reply_has_no_supported_classification",
      ...classificationEvidence,
    };
  }
  if (nonBotReplies.length > 0) {
    return {
      disposition: "unknown",
      reason: "reply_author_is_not_trusted",
      ...classificationEvidence,
    };
  }
  return {
    disposition: "unclassified",
    reason: "no_human_classification",
    ...classificationEvidence,
  };
}

function unthreadedDisposition() {
  return {
    disposition: "unknown",
    reason: "surface_has_no_structured_reply_link",
    humanClassificationEvidence: [],
    botConcessionEvidence: [],
    botRestorationEvidence: [],
    untrustedReplyEvidence: [],
  };
}

function emptyDispositionTotals() {
  return Object.fromEntries(DISPOSITIONS.map((category) => [category, 0]));
}

function emptySurface() {
  return { records: 0, findings: 0, evidence: [] };
}

function emptyBotEvidence() {
  return {
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [surface, emptySurface()]),
    ),
    dispositions: emptyDispositionTotals(),
  };
}

function addEvidenceRecord(botEvidence, surface, record) {
  const target = botEvidence.surfaces[surface];
  target.records += 1;
  if (record.finding) {
    target.findings += 1;
    botEvidence.dispositions[record.disposition] += 1;
  }
  target.evidence.push(record);
}

function recordFindingSignal(
  value,
  bot,
  { prUrl, surface, reviewState = null },
) {
  try {
    return actionableFindingSignal(value.body, bot, { reviewState });
  } catch (error) {
    const recordId = String(value.id ?? value.node_id ?? "unknown");
    throw new Error(
      `finding classification failed for ${prUrl}, ${surface} record ${recordId}: ${error.message}`,
      { cause: error },
    );
  }
}

export function buildPerBotEvidence({
  prUrl,
  prAuthorLogin,
  issueComments,
  reviews,
  reviewComments,
}) {
  const byBot = Object.fromEntries(
    REVIEW_BOT_KEYS.map((key) => [key, emptyBotEvidence()]),
  );
  const repliesByRoot = new Map();
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id == null) continue;
    const replies = repliesByRoot.get(comment.in_reply_to_id) ?? [];
    replies.push(comment);
    repliesByRoot.set(comment.in_reply_to_id, replies);
  }

  for (const comment of issueComments) {
    const bot = botKeyForEvidence(comment, prUrl);
    if (!bot) continue;
    const findingSignal = recordFindingSignal(comment, bot, {
      prUrl,
      surface: "issue_comments",
    });
    const finding = findingSignal !== null;
    addEvidenceRecord(byBot[bot], "issue_comments", {
      ...baseEvidence(comment, {
        prUrl,
        surface: "issue_comments",
        finding,
        findingSignal,
      }),
      ...(finding ? unthreadedDisposition() : {}),
    });
  }
  for (const review of reviews) {
    const bot = botKeyForEvidence(review, prUrl);
    if (!bot) continue;
    const findingSignal = recordFindingSignal(review, bot, {
      prUrl,
      surface: "review_submissions",
      reviewState: review.state,
    });
    const finding = findingSignal !== null;
    addEvidenceRecord(byBot[bot], "review_submissions", {
      ...baseEvidence(review, {
        prUrl,
        surface: "review_submissions",
        finding,
        findingSignal,
      }),
      state: review.state ?? null,
      commitId: review.commit_id ?? review.commitId ?? null,
      ...(finding ? unthreadedDisposition() : {}),
    });
  }
  for (const comment of reviewComments) {
    const bot = botKeyForEvidence(comment, prUrl);
    if (!bot) continue;
    const isRoot = comment.in_reply_to_id == null;
    const findingSignal = isRoot
      ? recordFindingSignal(comment, bot, {
          prUrl,
          surface: "review_comments",
        })
      : null;
    const finding = findingSignal !== null;
    const disposition = finding
      ? classifyInlineDisposition(
          repliesByRoot.get(comment.id) ?? [],
          prUrl,
          bot,
          prAuthorLogin,
        )
      : {};
    addEvidenceRecord(byBot[bot], "review_comments", {
      ...baseEvidence(comment, {
        prUrl,
        surface: "review_comments",
        finding,
        findingSignal,
      }),
      inReplyToId:
        comment.in_reply_to_id == null ? null : String(comment.in_reply_to_id),
      ...disposition,
    });
  }
  return byBot;
}
