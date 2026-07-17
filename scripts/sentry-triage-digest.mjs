#!/usr/bin/env node
/**
 * Observability leg of the Sentry triage pipeline (ADR 0036,
 * docs/adr/0036-sentry-triage-pipeline.md): a deterministic, no-LLM collector
 * that turns one triage-agent run's batch into a single Slack digest payload —
 * what was triaged, with what verdicts, with links — so verdict review needs
 * zero GitHub polling. ADR 0036's dominant failure mode is "unauditable
 * automation going dark"; this digest is the per-run heartbeat that makes a
 * run's output visible where the team already looks.
 *
 * This script is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md — it reads each batch issue's current
 * labels and its latest `<!-- sentry-triage-verdict:v1 -->` comment and never
 * changes the contract, the labels, or Sentry. It builds the Slack payload
 * (including escaping); the workflow's posting step is the only place the
 * Slack token lives and the only thing that POSTs.
 *
 * Security posture: verdict summaries are agent-authored from untrusted Sentry
 * data — treated exactly like the queue-issue body text in Stage A. Every
 * free-form value embedded in the payload (summary, plus the short-id/project
 * lifted from the queue title) is neutralized and Slack-escaped before it
 * reaches a payload field, using the SAME `& < >` escape the main-failure
 * notifier uses (.github/workflows/notify-slack-on-main-failure.yml). That
 * escape is what neutralizes Slack mention/link control syntax (`<!channel>`,
 * `<@U123>`, `<url|text>`): the closed-set fields (verdict, confidence) are
 * validated against their enums so only known-safe tokens ever render.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";

export const VERDICT_MARKER = "<!-- sentry-triage-verdict:v1 -->";
export const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

// Verdict LABEL -> verdict VALUE. This is the inverse of the ingest's
// value->label map; note the deliberate asymmetry the verdict contract calls
// out: label `sentry:verdict-upstream` <-> value `upstream-transient`.
export const LABEL_TO_VERDICT = {
  "sentry:verdict-code-fix": "code-fix",
  "sentry:verdict-config-fix": "config-fix",
  "sentry:verdict-upstream": "upstream-transient",
  "sentry:verdict-needs-human": "needs-human",
};

export const VALID_VERDICTS = [
  "code-fix",
  "config-fix",
  "upstream-transient",
  "needs-human",
];
export const VALID_CONFIDENCE = ["high", "medium", "low"];

// The `failed` bucket is not a verdict — it is batch issues still carrying
// `sentry:needs-triage` (their triage job died before a verdict landed). It
// must stay visible, never hidden.
export const FAILED_BUCKET = "failed";

// Counts header order — matches the verdict contract's parenthetical
// (`code-fix / config-fix / upstream-transient / needs-human`) plus the
// failed-triage bucket.
export const COUNTS_ORDER = [
  "code-fix",
  "config-fix",
  "upstream-transient",
  "needs-human",
  FAILED_BUCKET,
];

// Per-issue line order — `code-fix`/`config-fix` first, then `needs-human`,
// then `upstream-transient` (verdict contract), with failed-triage lines last.
export const LINE_ORDER = [
  "code-fix",
  "config-fix",
  "needs-human",
  "upstream-transient",
  FAILED_BUCKET,
];

const BUCKET_LABELS = {
  "code-fix": "code-fix",
  "config-fix": "config-fix",
  "upstream-transient": "upstream-transient",
  "needs-human": "needs-human",
  [FAILED_BUCKET]: "failed triage",
};

// Hard bound on the one free-form field we embed. "Truncate hard" mirrors the
// Stage A queue-body defense; also keeps every Slack section well under the
// 3000-char block limit (batch is capped at 6 issues upstream).
const MAX_SUMMARY_LEN = 300;

// ---------------------------------------------------------------------------
// Untrusted-text neutralization + Slack escaping.
// ---------------------------------------------------------------------------

/**
 * Slack mrkdwn escape — identical to the main-failure notifier's
 * `gsub("&";"&amp;") | gsub("<";"&lt;") | gsub(">";"&gt;")`. Order matters:
 * `&` first, or the later substitutions corrupt their own output. Escaping
 * `<`/`>` is what makes Slack mention/link control syntax inert.
 */
export function escapeSlackText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Collapse control chars/newlines/tabs to single spaces so an untrusted
 * summary stays on one line. Same intent as the ingest's sanitizeFreeText. */
export function sanitizeSummary(text) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars from untrusted agent text is the whole point here
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Sanitize -> hard-truncate -> Slack-escape, in that order (escape last so
 * the byte bound applies to the human-visible text, not the entity soup). */
export function formatSummaryForSlack(text) {
  const clean = sanitizeSummary(text);
  const bounded =
    clean.length > MAX_SUMMARY_LEN
      ? `${clean.slice(0, MAX_SUMMARY_LEN).trimEnd()}…`
      : clean;
  return escapeSlackText(bounded);
}

// ---------------------------------------------------------------------------
// Pure parsing: queue title, verdict comment.
// ---------------------------------------------------------------------------

// Queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`.
const QUEUE_TITLE_PATTERN = /^\[sentry\]\s+(\S+)\s+\(([^,()]+),/;

export function parseQueueTitle(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  if (!match) return { shortId: null, project: null };
  return { shortId: match[1], project: match[2].trim() };
}

/** Extract the fenced ```yaml block from a verdict comment body. Falls back to
 * the whole body if no fence is found (defensive — still line-parseable). */
export function extractVerdictYamlBlock(commentBody) {
  const match = /```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(
    String(commentBody ?? ""),
  );
  return match ? match[1] : "";
}

function stripYamlQuotes(value) {
  const v = String(value ?? "").trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Line-oriented, tolerant parse of the verdict yaml (matches the workflow's
 * deterministic label step, which sed-extracts the same fields). `verdict`
 * and `confidence` are read as their leading enum token so a trailing
 * `# ...` inline comment is ignored; `summary` keeps its full line value
 * (it may legitimately contain `#`) minus one layer of surrounding quotes.
 * Returns validated enums or null; summary is returned raw for later
 * sanitize+escape.
 */
export function parseVerdictComment(commentBody) {
  const block = extractVerdictYamlBlock(commentBody);
  const source = block || String(commentBody ?? "");
  const verdictMatch = /^verdict:[ \t]*([a-z-]+)/m.exec(source);
  const confidenceMatch = /^confidence:[ \t]*([a-z]+)/m.exec(source);
  const summaryMatch = /^summary:[ \t]*(.*)$/m.exec(source);

  const verdict = verdictMatch ? verdictMatch[1] : null;
  const confidence = confidenceMatch ? confidenceMatch[1] : null;
  const summary = summaryMatch ? stripYamlQuotes(summaryMatch[1]) : "";

  return {
    verdict: VALID_VERDICTS.includes(verdict) ? verdict : null,
    confidence: VALID_CONFIDENCE.includes(confidence) ? confidence : null,
    summary,
  };
}

/** Latest verdict-marker comment on the issue. `gh issue view --json comments`
 * returns comments oldest-first, so the last match is the newest. */
export function findLatestVerdictComment(comments) {
  const marked = (comments ?? []).filter(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.startsWith(VERDICT_MARKER),
  );
  return marked.length ? marked[marked.length - 1].body : null;
}

// ---------------------------------------------------------------------------
// Classification: one collected issue -> one digest entry.
// ---------------------------------------------------------------------------

/**
 * The bucket is decided from LABELS (deterministic, validated by the workflow
 * label step), not from the agent's free-text comment:
 *   - still carrying `sentry:needs-triage`  -> failed (triage did not finish);
 *   - carries a `sentry:verdict-*` label    -> that verdict;
 *   - neither (shouldn't happen for a batch issue) -> failed, so it stays
 *     visible rather than silently dropped.
 * The comment supplies only the human-readable confidence + summary.
 */
export function classifyIssue(issue) {
  const labelNames = (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
  const { shortId, project } = parseQueueTitle(issue?.title);
  const verdictCommentBody = findLatestVerdictComment(issue?.comments);
  const parsed = verdictCommentBody
    ? parseVerdictComment(verdictCommentBody)
    : { verdict: null, confidence: null, summary: "" };

  const stillNeedsTriage = labelNames.includes(NEEDS_TRIAGE_LABEL);
  const verdictLabel = labelNames.find((name) =>
    Object.hasOwn(LABEL_TO_VERDICT, name),
  );
  const verdictFromLabel = verdictLabel ? LABEL_TO_VERDICT[verdictLabel] : null;

  let bucket;
  if (stillNeedsTriage) bucket = FAILED_BUCKET;
  else if (verdictFromLabel) bucket = verdictFromLabel;
  else bucket = FAILED_BUCKET;

  return {
    number: issue?.number,
    shortId: shortId ?? `#${issue?.number}`,
    project: project ?? "unknown",
    url: typeof issue?.url === "string" ? issue.url : "",
    bucket,
    verdict: bucket === FAILED_BUCKET ? null : bucket,
    confidence: parsed.confidence,
    summary: parsed.summary,
  };
}

// ---------------------------------------------------------------------------
// Slack payload assembly.
// ---------------------------------------------------------------------------

function formatUtcTimestamp(date) {
  // 2026-07-17T14:20:33.123Z -> "2026-07-17 14:20 UTC"
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function renderIssueLine(entry) {
  const idText = escapeSlackText(entry.shortId);
  // Only render a real Slack link for a trusted https URL (the issue URL comes
  // from `gh issue view --json url`); otherwise show the escaped id as text.
  const linked = isHttpsUrl(entry.url) ? `<${entry.url}|${idText}>` : idText;
  const project = escapeSlackText(entry.project);

  if (entry.bucket === FAILED_BUCKET) {
    return `• ${linked} (${project}) — triage incomplete (still \`${NEEDS_TRIAGE_LABEL}\`)`;
  }

  const confidence = entry.confidence ?? "unknown";
  const summary = entry.summary
    ? formatSummaryForSlack(entry.summary)
    : "_(no summary)_";
  return `• ${linked} (${project}) — ${entry.verdict} (${confidence}): ${summary}`;
}

/**
 * Build the deterministic Slack `chat.postMessage` payload for one batch.
 * `channel` is passed in (hardcoded by the workflow); `now` is injectable for
 * tests. Pure — no I/O, no escaping omissions: every free-form value is routed
 * through the escape/format helpers here.
 */
export function buildDigest(issues, { channel, now = new Date() } = {}) {
  const entries = (issues ?? []).map(classifyIssue);

  const counts = Object.fromEntries(COUNTS_ORDER.map((key) => [key, 0]));
  for (const entry of entries) {
    counts[entry.bucket] = (counts[entry.bucket] ?? 0) + 1;
  }

  const total = entries.length;
  const headerText = `*Sentry triage — ${total} issue(s) triaged*\n${formatUtcTimestamp(now)}`;
  const countsText = COUNTS_ORDER.map(
    (key) => `${BUCKET_LABELS[key]}: ${counts[key] ?? 0}`,
  ).join(" · ");

  const ordered = [];
  for (const key of LINE_ORDER) {
    for (const entry of entries) {
      if (entry.bucket === key) ordered.push(entry);
    }
  }
  const linesText = ordered.map(renderIssueLine).join("\n");

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: headerText } },
    { type: "section", text: { type: "mrkdwn", text: countsText } },
  ];
  if (linesText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: linesText } });
  }

  return {
    channel,
    // Plain-text fallback for notifications/screen readers (no untrusted text).
    text: `Sentry triage — ${total} issue(s) triaged`,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// GitHub collection (via `gh`, mirroring the ingest script's runGh). Read-only
// — `gh issue view` needs only `issues: read`.
// ---------------------------------------------------------------------------

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          new Error(
            `gh ${args.join(" ")} failed with exit ${status}:\n${stderr}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function fetchIssue(repo, number, run) {
  const stdout = await run([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,url,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    url: data.url ?? "",
    labels: (data.labels ?? []).map((label) => label?.name),
    comments: data.comments ?? [],
  };
}

/** Fetch each batch issue's title/url/labels/comments. `run` is injectable for
 * tests. ≤6 issues per run (upstream batch cap), so a serial loop is fine. */
export async function collectIssues(repo, numbers, deps = {}) {
  const run = deps.runGh ?? runGh;
  const issues = [];
  for (const number of numbers ?? []) {
    issues.push(await fetchIssue(repo, number, run));
  }
  return issues;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse the batch from a JSON array of positive integers (the select job's
 * `issues` output). Empty/absent -> [] (the empty-batch guard). Fails loud on
 * anything that isn't a JSON array of positive integers. */
export function parseIssueNumbers(raw) {
  if (raw == null || String(raw).trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(
      `--issues must be a JSON array of issue numbers, got: ${raw}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--issues must be a JSON array of issue numbers");
  }
  return parsed.map((value) => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid issue number: ${JSON.stringify(value)}`);
    }
    return value;
  });
}

function usage() {
  return `Usage: pnpm sentry:digest --channel <slack-channel> [options]

Collects the current triage batch's verdicts and prints a deterministic Slack
chat.postMessage payload (JSON) to stdout. The workflow's posting step is the
only thing that holds the Slack token and POSTs.

Options:
  --channel <name>     Slack channel to post to (e.g. '#engineering'). Required.
                       Env fallback: SENTRY_TRIAGE_CHANNEL.
  --issues <json>      JSON array of queue-issue numbers (the select job's
                       output). Env fallback: SENTRY_TRIAGE_ISSUES.
  --repo <owner/name>  Repository the queue issues live in (default: ${DEFAULT_REPO}).
  -h, --help           Show this help.
`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    repo: DEFAULT_REPO,
    channel: env.SENTRY_TRIAGE_CHANNEL ?? null,
    help: false,
  };
  let issuesRaw = env.SENTRY_TRIAGE_ISSUES ?? null;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--repo":
        options.repo = readValue();
        break;
      case "--channel":
        options.channel = readValue();
        break;
      case "--issues":
        issuesRaw = readValue();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  options.issues = parseIssueNumbers(issuesRaw);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.channel || !String(options.channel).trim()) {
    throw new Error("--channel is required (or set SENTRY_TRIAGE_CHANNEL)");
  }

  // Empty-batch guard: nothing to report. Emit nothing on stdout so the
  // posting step has no payload to POST (defense in depth — the digest job is
  // already gated on a non-zero select count).
  if (options.issues.length === 0) {
    process.stderr.write(
      "::notice::No issues in the triage batch; nothing to post.\n",
    );
    return;
  }

  const issues = await collectIssues(options.repo, options.issues);
  const payload = buildDigest(issues, {
    channel: options.channel,
    now: new Date(),
  });
  // ONLY the payload goes to stdout (the workflow redirects it to a file for
  // the posting step); all diagnostics go to stderr.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
