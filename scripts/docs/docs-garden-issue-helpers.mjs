import { createHash } from "node:crypto";

import { renderAuditPacket } from "./docs-audit-helpers.mjs";
import {
  normalizeIssuePages,
  parseLeadingMarkerBlock,
  requireSingleQueueState,
  selectQueueIssues,
} from "../lib/gh-issue-lifecycle.mjs";

export const DOCS_GARDEN_MARKER = "<!-- docs-garden-issue:v1 -->";
export const DOCS_GARDEN_PACKET_MARKER_PREFIX = "<!-- docs-garden-packet:v1 ";
export const DOCS_GARDEN_EPIC = 1341;
export const MAX_ISSUE_BODY_CHARS = 65_000;
export const DOCS_AUTOMATION_OWNERSHIP_LABEL = "source:audit";
const QUEUE_KIND = "docs-garden";

const BASE_LABELS = [
  "agent-ready",
  "documentation",
  "pkg:tooling",
  "kind:refactor",
  "source:audit",
  "priority:p2",
];

function parseDate(dateInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    throw new Error(`invalid date: ${dateInput}`);
  }
  const date = new Date(`${dateInput}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== dateInput
  ) {
    throw new Error(`invalid date: ${dateInput}`);
  }
  return date;
}

export function weekSerialForDate(dateInput) {
  const date = parseDate(dateInput);
  const mondayEpoch = Date.UTC(1970, 0, 5);
  return Math.floor((date.valueOf() - mondayEpoch) / (7 * 86_400_000));
}

export function mondayForWeekSerial(weekSerial) {
  if (!Number.isSafeInteger(weekSerial)) {
    throw new Error("week serial must be a safe integer");
  }
  const mondayEpoch = Date.UTC(1970, 0, 5);
  return new Date(mondayEpoch + weekSerial * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function packetMarker(packet) {
  const metadata = {
    week_serial: packet.cycle.week_serial,
    fingerprint: packet.fingerprint,
    selected_for: packet.selected_for,
    scope_digest: packetScopeDigest(packet),
  };
  return `${DOCS_GARDEN_PACKET_MARKER_PREFIX}${JSON.stringify(metadata)} -->`;
}

export function parseLeadingDocsGardenMarkers(body) {
  const metadata = parseLeadingMarkerBlock(body, {
    marker: DOCS_GARDEN_MARKER,
    metadataPrefix: DOCS_GARDEN_PACKET_MARKER_PREFIX,
    malformedMessage:
      "docs-garden issue has a missing or malformed packet marker",
    invalidJsonMessage: "docs-garden issue packet marker is not valid JSON",
  });
  if (metadata === undefined) return null;
  if (
    !Number.isSafeInteger(metadata.week_serial) ||
    typeof metadata.fingerprint !== "string" ||
    !metadata.fingerprint.startsWith("docs-garden:") ||
    typeof metadata.selected_for !== "string" ||
    weekSerialForDate(metadata.selected_for) !== metadata.week_serial ||
    !/^[a-f0-9]{16}$/.test(metadata.scope_digest)
  ) {
    throw new Error("docs-garden issue packet marker has invalid metadata");
  }
  return metadata;
}

export function normalizeGithubIssuePages(pages) {
  return normalizeIssuePages(pages, {
    ownershipLabel: DOCS_AUTOMATION_OWNERSHIP_LABEL,
    parseMarker: parseLeadingDocsGardenMarkers,
  });
}

export function resolveTargetWeekSerial(currentWeekSerial, issues) {
  if (!Number.isSafeInteger(currentWeekSerial)) {
    throw new Error("current week serial must be a safe integer");
  }
  const { tracked: gardenIssues, open } = selectQueueIssues(issues, {
    kind: QUEUE_KIND,
  });
  if (open) return open.marker.week_serial;

  const closedSerials = gardenIssues
    .filter((issue) => issue.state === "CLOSED")
    .map((issue) => issue.marker.week_serial);
  if (closedSerials.length === 0) return currentWeekSerial;
  return Math.max(currentWeekSerial, Math.max(...closedSerials) + 1);
}

function defangMentions(text) {
  return String(text).replaceAll("@", "@\u200B");
}

function riskForLane(lane) {
  return lane === "package-readmes-reference" ? "low" : "medium";
}

export function packetScopeDigest(packet) {
  const scope = {
    lane: packet.lane,
    shard: packet.shard,
    shard_count: packet.shard_count,
    files: packet.files.map((file) => file.path),
  };
  return createHash("sha256")
    .update(JSON.stringify(scope))
    .digest("hex")
    .slice(0, 16);
}

export function buildDocsGardenIssueSpec(
  packet,
  { epic = DOCS_GARDEN_EPIC } = {},
) {
  if (packet.empty_lane) {
    throw new Error("cannot build an issue for an empty documentation lane");
  }
  const shard = `${packet.shard}/${packet.shard_count}`;
  const risk = riskForLane(packet.lane);
  const expectedPaths = packet.files.map((file) => `- \`${file.path}\``);
  const renderedPacket = defangMentions(renderAuditPacket(packet));
  const title = `[Agent task] docs garden: ${packet.lane} (${shard})`;
  const body = [
    DOCS_GARDEN_MARKER,
    packetMarker(packet),
    "",
    "### Goal",
    "",
    `Audit and garden every document in the generated \`${packet.lane}\` lane shard ${shard}. Leave the repository's documentation smaller, more accurate, or explicitly verified with evidence.`,
    "",
    "### Context and links",
    "",
    `- Documentation-audit epic: #${epic}`,
    "- Canonical runbook: `docs/notes/documentation-gardening.md`",
    `- Scheduled packet key: week serial \`${packet.cycle.week_serial}\`, fingerprint \`${packet.fingerprint}\``,
    "- The complete deterministic planner packet is embedded below; it is the scope source of truth.",
    "",
    "### Acceptance criteria",
    "",
    "- [ ] Review every document in the packet; do not silently omit files.",
    "- [ ] Assign each document one evidence-backed disposition from the runbook.",
    "- [ ] Remove, merge, tighten, update, archive, or supersede content only when current repository or provider evidence supports it.",
    "- [ ] Repair inbound links and navigation for every moved, merged, archived, or deleted document.",
    "- [ ] Regenerate the documentation catalog when classification or paths change.",
    "- [ ] Open a normal reviewed PR and include the disposition/evidence summary in its body.",
    "",
    "### Expected files or package area",
    "",
    ...expectedPaths,
    "- `docs/README.md` only when catalog regeneration changes it",
    "",
    "### Verification commands",
    "",
    "```bash",
    "pnpm docs:index --write",
    "pnpm docs:index --check",
    "pnpm agent:context-check",
    "pnpm agent:context-budget --strict",
    "pnpm agent:quality-gate --run",
    "```",
    "",
    "### Risks, non-goals, and do-not-touch",
    "",
    `- Risk: ${risk}. This is semantic documentation maintenance and still requires normal review.`,
    "- Age alone is never deletion evidence. Do not bump `last_verified` without checking the owning source.",
    "- Preserve accepted ADR history; supersede decisions instead of rewriting the past.",
    "- Do not edit files outside the packet except to repair navigation, update the generated catalog, or document directly proven workflow drift.",
    "- Do not deploy, mutate production, create secrets, merge a PR, or perform unrelated repository cleanup.",
    "",
    "### Dependencies or blockers",
    "",
    "None at generation time. Claim this issue through the repository issue workflow before semantic edits. Escalate contradictory canonical sources or unclear ownership instead of guessing.",
    "",
    "### Done means",
    "",
    "A reviewed PR containing a disposition and evidence for every packet document is merged, all affected links and catalog entries are correct, and the issue is closed by that PR. Use `Closes` only when the whole packet is complete.",
    "",
    "## Generated audit packet",
    "",
    renderedPacket.trimEnd(),
    "",
  ].join("\n");

  if (body.length > MAX_ISSUE_BODY_CHARS) {
    throw new Error(
      `docs-garden issue body is ${body.length} characters; maximum is ${MAX_ISSUE_BODY_CHARS}`,
    );
  }

  return {
    title,
    body,
    labels: [...BASE_LABELS, `risk:${risk}`],
  };
}

export function planDocsGardenIssueSync({ packet, issues }) {
  const { tracked: gardenIssues, open: issue } = selectQueueIssues(issues, {
    kind: QUEUE_KIND,
  });

  if (issue) {
    const state = requireSingleQueueState(issue, { kind: QUEUE_KIND });
    if (issue.marker.week_serial !== packet.cycle.week_serial) {
      return {
        action: "skip-prior-open",
        reason: `issue #${issue.number} for week serial ${issue.marker.week_serial} is still open`,
        issue,
      };
    }
    if (state === "agent-ready") {
      if (
        issue.marker.fingerprint !== packet.fingerprint ||
        issue.marker.scope_digest !== packetScopeDigest(packet)
      ) {
        return {
          action: "skip-scope-drift",
          reason: `issue #${issue.number} is still unclaimed but its bounded file scope no longer matches the current planner; preserving the issued scope`,
          issue,
        };
      }
      return {
        action: "keep-current",
        reason: `issue #${issue.number} already owns this packet occurrence; published scope is immutable until it closes`,
        issue,
      };
    }
    if (state === "agent-active" || state === "in-pr") {
      return {
        action: "skip-busy",
        reason: `issue #${issue.number} is ${state}; preserving claimed scope`,
        issue,
      };
    }
    if (state === "needs-grooming") {
      return {
        action: "skip-blocked",
        reason: `issue #${issue.number} needs grooming; preserving blocked scope for human clarification`,
        issue,
      };
    }
    throw new Error(
      `open docs-garden issue #${issue.number} is not claimable or in progress (${state})`,
    );
  }

  const completed = gardenIssues.find(
    (candidate) =>
      candidate.state === "CLOSED" &&
      candidate.marker.week_serial === packet.cycle.week_serial,
  );
  if (completed) {
    return {
      action: "skip-complete",
      reason: `packet occurrence already completed by issue #${completed.number}`,
      issue: completed,
    };
  }
  if (packet.empty_lane) {
    return {
      action: "noop-empty",
      reason: `lane ${packet.lane} currently has no documents`,
    };
  }
  return {
    action: "create",
    reason: "no live or completed issue exists for this packet occurrence",
    spec: buildDocsGardenIssueSpec(packet),
  };
}
