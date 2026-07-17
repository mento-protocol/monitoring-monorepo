import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildContextBudgetReport,
  resolveProjectDocMaxBytes,
  trackedInstructionFiles,
} from "./agent-context-budget.mjs";
import { GARDEN_LANES } from "./docs-index-helpers.mjs";

export const MAX_SHARD_DOCUMENTS = 10;
export const MAX_SHARD_WORDS = 15_000;
export const AUDIT_DISPOSITIONS = [
  "Keep",
  "Tighten",
  "Merge",
  "Update",
  "Supersede",
  "Archive",
  "Delete",
  "Needs owner decision",
];

export function shardDocuments(
  records,
  { maxDocuments = MAX_SHARD_DOCUMENTS, maxWords = MAX_SHARD_WORDS } = {},
) {
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0) {
    throw new Error("maxDocuments must be a positive integer");
  }
  if (!Number.isSafeInteger(maxWords) || maxWords <= 0) {
    throw new Error("maxWords must be a positive integer");
  }

  const shards = [];
  let current = [];
  let currentWords = 0;
  const flush = () => {
    if (current.length === 0) return;
    shards.push(current);
    current = [];
    currentWords = 0;
  };

  for (const record of [...records].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if (record.words > maxWords) {
      flush();
      shards.push([record]);
      continue;
    }
    if (
      current.length >= maxDocuments ||
      (current.length > 0 && currentWords + record.words > maxWords)
    ) {
      flush();
    }
    current.push(record);
    currentWords += record.words;
  }
  flush();
  return shards;
}

export function weeklySelection(dateInput, laneShards, explicit = {}) {
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
  const mondayEpoch = Date.UTC(1970, 0, 5);
  const weekSerial = Math.floor(
    (date.valueOf() - mondayEpoch) / (7 * 86_400_000),
  );
  const lane =
    explicit.lane ||
    GARDEN_LANES[
      ((weekSerial % GARDEN_LANES.length) + GARDEN_LANES.length) %
        GARDEN_LANES.length
    ];
  if (!GARDEN_LANES.includes(lane)) throw new Error(`unknown lane: ${lane}`);
  const shards = laneShards.get(lane) || [];
  if (shards.length === 0) throw new Error(`lane has no documents: ${lane}`);
  const cycle = Math.floor(weekSerial / GARDEN_LANES.length);
  const defaultShard =
    ((cycle % shards.length) + shards.length) % shards.length;
  const shardIndex =
    explicit.shard === undefined ? defaultShard : explicit.shard - 1;
  if (
    !Number.isSafeInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= shards.length
  ) {
    throw new Error(`shard must be between 1 and ${shards.length} for ${lane}`);
  }
  return { lane, shardIndex, weekSerial, cycle, shardCount: shards.length };
}

function lastContentChange(repoRoot, file) {
  try {
    return (
      execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function findVersionCandidates(content) {
  const candidates = [];
  const versionToken =
    /(?:\bv?\d+\.\d+(?:\.\d+)?\b|@v\d+\b|(?:>=|<=|>|<|\^|~)\s*\d+(?:\.\d+){0,2}\b)/i;
  const context =
    /(?:version|node(?:\.js)?|pnpm|npm|next(?:\.js)?|react|terraform|envio|typescript|grafana|gcloud|github action|uses:|image:)/i;
  for (const [index, line] of content.split("\n").entries()) {
    if (!versionToken.test(line) || !context.test(line)) continue;
    candidates.push({ line: index + 1, text: line.trim().slice(0, 240) });
    if (candidates.length === 20) break;
  }
  return candidates;
}

export function buildLaneShards(records) {
  return new Map(
    GARDEN_LANES.map((lane) => [
      lane,
      shardDocuments(records.filter((record) => record.garden_lane === lane)),
    ]),
  );
}

export function buildAuditPacket({
  repoRoot,
  inventory,
  date,
  lane,
  shard,
  dryRun = false,
}) {
  const laneShards = buildLaneShards(inventory.records);
  const selection = weeklySelection(date, laneShards, { lane, shard });
  const records = laneShards.get(selection.lane)[selection.shardIndex];
  const files = records.map((record) => {
    const content = readFileSync(path.join(repoRoot, record.path), "utf8");
    return {
      ...record,
      last_content_change: lastContentChange(repoRoot, record.path),
      orphan: record.inbound_links === 0,
      authority_gap: record.authority === "unmanaged",
      metadata_warnings: inventory.warnings.filter((warning) =>
        warning.startsWith(`${record.path}:`),
      ),
      broken_links: inventory.broken_links.filter(
        (link) => link.source === record.path,
      ),
      version_reference_candidates: findVersionCandidates(content),
      proposed_disposition: null,
      evidence: null,
    };
  });
  const wordCount = files.reduce((total, record) => total + record.words, 0);
  const contextBudget = buildContextBudgetReport({
    repoRoot,
    files: trackedInstructionFiles(repoRoot),
    limitBytes: resolveProjectDocMaxBytes(repoRoot),
  });
  return {
    schema_version: 1,
    fingerprint: `docs-garden:${selection.lane}:${selection.shardIndex + 1}-of-${selection.shardCount}`,
    selected_for: date,
    dry_run: dryRun,
    cycle: {
      cadence: "weekly",
      rule: "Monday-based UTC week selects one of six lanes; each completed six-week rotation advances that lane's shard modulo its current shard count.",
      week_serial: selection.weekSerial,
      rotation: selection.cycle,
    },
    lane: selection.lane,
    shard: selection.shardIndex + 1,
    shard_count: selection.shardCount,
    document_count: files.length,
    source_words: wordCount,
    oversized_singleton: files.length === 1 && files[0].words > MAX_SHARD_WORDS,
    safety: {
      allowed_dispositions: AUDIT_DISPOSITIONS,
      evidence_required: true,
      age_alone_never_justifies_deletion: true,
      verification_dates_change_only_after_verification: true,
      planner_mutates_documentation: false,
    },
    context_budget: contextBudget,
    files,
  };
}

function escapeCell(value) {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

export function renderAuditPacket(packet) {
  const lines = [
    `# Documentation garden packet: ${packet.lane} ${packet.shard}/${packet.shard_count}`,
    "",
    `Fingerprint: \`${packet.fingerprint}\``,
    `Selected for: ${packet.selected_for} · ${packet.document_count} documents · ${packet.source_words.toLocaleString("en-US")} source words${packet.oversized_singleton ? " · oversized singleton" : ""}`,
    "",
    "Age is a review signal, never deletion evidence. Do not change `last_verified` unless the document was actually checked against its owning source.",
    "",
    `Allowed dispositions: ${AUDIT_DISPOSITIONS.join(", ")}. Every disposition requires evidence.`,
    "",
    `Agent-context budget: ${packet.context_budget.oversized_routes.length} oversized route(s) at a ${packet.context_budget.limit_bytes.toLocaleString("en-US")}-byte limit${packet.context_budget.oversized_routes.length ? ` (${packet.context_budget.oversized_routes.join(", ")})` : ""}.`,
    "",
    "| Document | Authority / lifecycle | Type / scope | Owner | Words / inbound | Last verified / changed | Signals | Disposition | Evidence |",
    "| --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
  ];
  for (const record of packet.files) {
    const signals = [
      record.orphan ? "orphan" : null,
      record.authority_gap ? "authority gap" : null,
      record.metadata_warnings.length
        ? `${record.metadata_warnings.length} metadata warning(s)`
        : null,
      record.broken_links.length
        ? `${record.broken_links.length} broken link(s)`
        : null,
      record.version_reference_candidates.length
        ? `${record.version_reference_candidates.length} version candidate(s)`
        : null,
    ].filter(Boolean);
    lines.push(
      `| \`${escapeCell(record.path)}\` | ${record.authority} / ${record.status} | ${record.doc_type} / ${record.scope} | ${escapeCell(record.owner)} | ${record.words.toLocaleString("en-US")} / ${record.inbound_links} | ${record.last_verified || "—"} / ${record.last_content_change || "—"} | ${signals.join(", ") || "—"} | _required_ | _required_ |`,
    );
  }
  lines.push("", "## Evidence details", "");
  for (const record of packet.files) {
    lines.push(`### \`${record.path}\``, "");
    if (record.metadata_warnings.length) {
      lines.push(
        "Metadata:",
        ...record.metadata_warnings.map((warning) => `- ${warning}`),
        "",
      );
    }
    if (record.broken_links.length) {
      lines.push(
        "Broken links:",
        ...record.broken_links.map(
          (link) => `- \`${link.target}\` (${link.reason})`,
        ),
        "",
      );
    }
    if (record.version_reference_candidates.length) {
      lines.push(
        "Version-reference candidates:",
        ...record.version_reference_candidates.map(
          (candidate) =>
            `- line ${candidate.line}: \`${candidate.text.replaceAll("`", "\\`")}\``,
        ),
        "",
      );
    }
    if (
      !record.metadata_warnings.length &&
      !record.broken_links.length &&
      !record.version_reference_candidates.length
    ) {
      lines.push(
        "No deterministic warning beyond age, authority, and inbound-link signals.",
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
