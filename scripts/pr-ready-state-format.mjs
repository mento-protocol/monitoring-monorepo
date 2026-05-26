import { BOT_APPROVER } from "./pr-ready-state-core.mjs";

function formatCount(label, items) {
  return `${label}: ${items.length}`;
}

function formatShortBody(body) {
  const oneLine = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= 100) return oneLine;
  return `${oneLine.slice(0, 97)}...`;
}

export function formatHuman(summary) {
  const lines = [];
  const pr = summary.pr;
  lines.push(
    `PR #${pr.number}: ${summary.ready ? "READY" : "NOT READY"} - ${pr.title}`,
  );
  lines.push(`URL: ${pr.url}`);
  lines.push(`Head: ${pr.headRefName} @ ${pr.headRefOid}`);
  lines.push(`Base: ${pr.baseRefName}`);
  lines.push(
    `Mergeability: ${pr.mergeable ?? "UNKNOWN"}; review decision: ${
      pr.reviewDecision ?? "UNKNOWN"
    }; draft: ${pr.isDraft ? "yes" : "no"}`,
  );
  lines.push(
    `Readiness: ${summary.required.ready ? "required clear" : "required blocked"}; optional: ${
      summary.optional.ready
        ? "clear"
        : `${summary.optional.items.length} item(s)`
    }`,
  );
  lines.push(
    `Checks: ${[
      formatCount("pass", summary.statusChecks.pass),
      formatCount("fail", summary.statusChecks.fail),
      formatCount("pending", summary.statusChecks.pending),
      formatCount("skipped", summary.statusChecks.skipped),
    ].join(", ")}`,
  );
  lines.push(
    `Review threads unresolved: ${summary.unresolvedReviewThreads.length}`,
  );
  lines.push(
    `Unreplied root review comments: ${summary.unrepliedRootReviewComments.length}`,
  );
  lines.push(`Top-level bot comments: ${summary.topLevelBotComments.length}`);
  lines.push(
    `${BOT_APPROVER} +1 reaction on PR description: ${
      summary.codexApprovalReaction ? "yes" : "no"
    }`,
  );
  lines.push(`Codex review signal: ${summary.codexReviewSignal}`);

  const sections = [
    [
      "Required blockers",
      summary.required.blockers,
      (item) =>
        `${item.kind}: ${item.name} (${item.state}) ${item.url ?? ""}`.trim(),
    ],
    [
      "Optional lag",
      summary.optional.items,
      (item) =>
        `${item.kind}: ${item.name} (${item.state}) ${item.url ?? ""}`.trim(),
    ],
    [
      "Unresolved review threads",
      summary.unresolvedReviewThreads,
      (item) =>
        `${item.path ?? "unknown path"}:${item.line ?? "?"} ${
          item.author ? `by ${item.author}` : ""
        } ${item.url ?? ""}`.trim(),
    ],
    [
      "Unreplied root review comments",
      summary.unrepliedRootReviewComments,
      (item) =>
        `#${item.id} ${item.path ?? "unknown path"}:${item.line ?? "?"} ${
          item.author ? `by ${item.author}` : ""
        } ${item.url ?? ""}`.trim(),
    ],
    [
      "Top-level bot comments",
      summary.topLevelBotComments,
      (item) =>
        `${item.author ?? "bot"} ${item.url ?? ""} ${formatShortBody(
          item.body,
        )}`.trim(),
    ],
  ];

  for (const [title, items, render] of sections) {
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`${title}:`);
    for (const item of items) {
      lines.push(`- ${render(item)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function blockerNames(items) {
  if (items.length === 0) return "none";
  return items.map((item) => `${item.kind}:${item.name}`).join(", ");
}

export function formatCompact(summary) {
  const pendingRequiredChecks = summary.required.blockers.filter(
    (item) => item.kind === "check" && item.state === "pending",
  );
  const failingRequiredChecks = summary.required.blockers.filter(
    (item) => item.kind === "check" && item.state === "fail",
  );
  const nonCheckBlockers = summary.required.blockers.filter(
    (item) => item.kind !== "check",
  );

  return [
    `PR #${summary.pr.number} ${summary.ready ? "READY" : "BLOCKED"}`,
    `head=${summary.pr.headRefOid}`,
    `mergeable=${summary.pr.mergeable ?? "UNKNOWN"}`,
    `required_blockers=${summary.required.blockers.length}`,
    `pending_checks=${blockerNames(pendingRequiredChecks)}`,
    `failing_checks=${blockerNames(failingRequiredChecks)}`,
    `other_blockers=${blockerNames(nonCheckBlockers)}`,
    `threads=${summary.unresolvedReviewThreads.length}`,
    `unreplied=${summary.unrepliedRootReviewComments.length}`,
    `codex_approval=${summary.gates.codexDescriptionApproval.state}`,
    `codex_signal=${summary.codexReviewSignal}`,
  ].join(" ");
}
