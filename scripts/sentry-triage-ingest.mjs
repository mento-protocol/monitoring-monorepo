#!/usr/bin/env node
/**
 * Stage A of the Sentry triage pipeline (ADR 0036,
 * docs/adr/0036-sentry-triage-pipeline.md): a deterministic, no-LLM ingest
 * that turns every new or regressed Sentry issue across the `mento-labs` org
 * into exactly one labeled GitHub queue issue in this repo, idempotent by
 * Sentry short ID. Read-only against Sentry (GET only) — never resolves,
 * archives, assigns, or otherwise mutates a Sentry issue.
 *
 * The queue contract (title format, label names, body shape, idempotency
 * rules) is normative — see the GitHub issue that authored this script
 * (mento-protocol/monitoring-monorepo#1274) and
 * docs/notes/sentry-triage-pipeline.md. Do not change it without updating
 * both, since the Stage B triage-agent workflow builds against it.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { selectMarkedComment } from "./sentry-triage-project-core.mjs";
import {
  ARCHIVED_LABEL,
  LABEL_DEFINITIONS,
  NEEDS_TRIAGE_LABEL,
  neutralizeUntrusted,
  parseArchiveBaseline,
  truncateTitle,
} from "./sentry-triage-queue-contract.mjs";
import {
  buildStrandedRecoveryComment,
  REQUEUE_CAUSE_BOOKKEEPING,
  REQUEUE_CAUSE_SENTRY_EVIDENCE,
  requeueQueueStub,
} from "./sentry-triage-requeue.mjs";

// The queue label namespace, the untrusted-text neutralization, and the archive
// freshness-baseline contract now live in `sentry-triage-queue-contract.mjs`;
// the re-queue sequence and its fence live in `sentry-triage-requeue.mjs`. Both
// are re-exported here because ingest is the queue's public surface for the
// sibling scripts (archive, project, digest, autofix) and their tests.
export {
  APPROVED_ARCHIVE_LABEL,
  ARCHIVE_BASELINE_FIELD,
  ARCHIVE_BASELINE_ID_FIELD,
  ARCHIVED_LABEL,
  CODE_FIX_VERDICT_LABEL,
  defangBackticks,
  defangMentions,
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
  LABEL_DEFINITIONS,
  NEEDS_TRIAGE_LABEL,
  neutralizeUntrusted,
  parseArchiveBaseline,
  PROJECTED_LABEL,
  REOPEN_SHED_LABELS,
  sanitizeFreeText,
  truncateTitle,
  VERDICT_LABELS,
  withArchiveBaseline,
} from "./sentry-triage-queue-contract.mjs";
export {
  buildRegressedComment,
  buildReopenLabelEditArgs,
  buildStrandedRecoveryComment,
} from "./sentry-triage-requeue.mjs";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";
export const DEFAULT_ORG = "mento-labs";
export const DEFAULT_SENTRY_BASE_URL = "https://us.sentry.io";
// Tracker issue for the whole pipeline rollout (ADR 0036 evidence section);
// the run record described in the queue contract lands here as a single
// rolling comment.
export const DEFAULT_TRACKER_ISSUE = 1282;

// Default firstSeen lookback. 8 days comfortably covers the 2x/day schedule
// plus weekend-long gaps, but a fixed window cannot backfill issues first
// seen during a longer outage or inert period — hence the
// SENTRY_TRIAGE_LOOKBACK_DAYS / --lookback-days override (see the runbook in
// docs/notes/sentry-triage-pipeline.md).
export const DEFAULT_LOOKBACK_DAYS = 8;
const MAX_LOOKBACK_DAYS = 90;

export function buildNewIssuesQuery(lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  return `is:unresolved firstSeen:-${lookbackDays}d`;
}

export const REGRESSED_ISSUES_QUERY = "is:unresolved is:regressed";

/**
 * CLI flag wins over the env var; default 8. Fails loud on anything that is
 * not an integer in [1, 90] — a typo'd override should turn the run red, not
 * silently fall back to a window the operator didn't ask for.
 */
export function resolveLookbackDays(cliValue, env = process.env) {
  const raw = cliValue ?? env.SENTRY_TRIAGE_LOOKBACK_DAYS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_LOOKBACK_DAYS;
  const trimmed = String(raw).trim();
  const days = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || days < 1 || days > MAX_LOOKBACK_DAYS) {
    throw new Error(
      `Lookback days must be an integer between 1 and ${MAX_LOOKBACK_DAYS}, got: ${trimmed}`,
    );
  }
  return days;
}

// The run record is also a machine-read contract, not just an operator note.
// `alerts/infra/sentry-ingest-watcher/` pins this exact marker and parses the
// first ISO-8601 instant in the body as the last-ingest time, because a run
// that no-ops on the kill switch or a missing token still concludes `success`
// and never reaches this writer. Bump the version here only together with that
// reader — an unmatched marker makes the dead-man switch fail closed and page.
export const RUN_RECORD_MARKER = "<!-- sentry-triage-ingest:run-record:v1 -->";
const BODY_MARKER = "<!-- sentry-triage:v1 -->";

// ---------------------------------------------------------------------------
// Pure helpers: title/body construction, noise classification, dedup decision.
// The neutralization these apply to attacker-reachable Sentry text lives in
// sentry-triage-queue-contract.mjs — never execute/eval anything derived from
// that text, and never let it reach a public queue issue unneutralized.
// ---------------------------------------------------------------------------

/**
 * `[sentry] <SHORT-ID> (<project>, <level>)` — queue contract v2.
 *
 * This repo is PUBLIC: the Sentry issue title is production error payload
 * and must never appear in the queue issue. Only Sentry-assigned
 * identifiers/metadata render; project and level are still neutralized and
 * bounded as defense in depth.
 */
export function buildQueueTitle(shortId, project, level) {
  const safeProject = truncateTitle(neutralizeUntrusted(project), 40);
  const safeLevel = truncateTitle(neutralizeUntrusted(level), 20);
  return `[sentry] ${shortId} (${safeProject}, ${safeLevel})`;
}

// Noise heuristics from the queue contract: CSP reports, RPC timeouts,
// chunk-load errors, and aborted fetches account for most of the org's
// operational noise (ADR 0036 context). The raw Sentry title is classified
// IN-MEMORY only — it never renders anywhere; only the resulting
// `sentry:candidate-noise` label is public (queue contract v2).
const NOISE_PATTERNS = [
  /^Blocked '/,
  /TimeoutError/,
  /Failed to fetch/,
  /Failed to load chunk/,
  /AbortError/,
];

export function classifyNoise(rawTitle) {
  const title = String(rawTitle ?? "");
  return NOISE_PATTERNS.some((pattern) => pattern.test(title));
}

export function buildQueueLabels(isNoise) {
  const labels = ["sentry-triage", NEEDS_TRIAGE_LABEL];
  if (isNoise) labels.push("sentry:candidate-noise");
  return labels;
}

// Short ID is the first whitespace-delimited token after the `[sentry] `
// prefix (queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`).
const QUEUE_TITLE_PATTERN = /^\[sentry\] (\S+)/;

export function extractShortIdFromTitle(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  return match ? match[1] : null;
}

export function indexQueueIssuesByShortId(issues) {
  const map = new Map();
  for (const issue of issues ?? []) {
    const shortId = extractShortIdFromTitle(issue.title);
    if (!shortId) continue;
    if (!map.has(shortId)) map.set(shortId, issue);
  }
  return map;
}

/**
 * Idempotency rule (normative): open match -> skip. Closed match + the
 * Sentry issue is regressed -> reopen ONLY when the Sentry issue's lastSeen
 * is strictly newer than the queue issue's closedAt. Sentry keeps
 * `substatus=regressed` for days after a regression, so an unconditional
 * reopen would loop a verdict-closed, already-triaged stub through
 * reopen -> re-triage -> close on every run until Sentry flips the
 * substatus (the counterpart of the Stage B queue-closing step). A missing or
 * unparsable `lastSeen` fails open toward triage (reopen): a wrongly skipped
 * regression is silent, a wrongly reopened one merely re-triages.
 * Closed match, not regressed -> skip (stays closed). No match -> create.
 *
 * An ARCHIVED stub (`sentry:archived`) compares against `archiveBaseline` — the
 * Sentry `lastSeen` the archive leg observed just before it mutated the issue —
 * instead of `closedAt` (issue #1371). The archive's close postdates any event
 * that landed inside its mutation window, so `closedAt` would hide that event
 * forever. A missing, unparsable, or non-date baseline falls back to the
 * `closedAt` comparison, which keeps every stub archived before this contract
 * existed working exactly as before.
 *
 * Order matters, and it is deliberate: a usable, bound baseline wins over
 * `closedAt` even when `closedAt` itself is missing or unparsable. The baseline
 * is strictly better evidence — it names the instant the archive observed, while
 * `closedAt` is only a proxy for it — so a NaN `closedAt` must not short-circuit
 * to reopen ahead of the baseline branch and defeat the mechanism on every run.
 * The `closedAt` fail-open still applies once no usable baseline is in play.
 *
 * That baseline only gates the decision while it is BOUND to the Sentry issue
 * the stub tracks: the archive leg records the id it mutated
 * (`archiveBaselineIssueId`) beside the timestamp, and a baseline naming a
 * different id — or naming none at all — is evidence about some other issue and
 * cannot speak for this one. An unbound baseline therefore reopens rather than
 * falling back to `closedAt`: same fail-open direction as the unparsable
 * timestamps above and for the same reason (a wrongly skipped regression is
 * silent, a wrongly reopened one merely re-triages), and the `closedAt` fallback
 * is reserved for stubs archived before this contract existed, not for a
 * baseline that is present but does not describe this issue. It cannot loop —
 * the reopen sheds `sentry:archived` (REOPEN_SHED_LABELS), so the stub takes the
 * ordinary `closedAt` path from then on.
 *
 */
export function decideDedupAction({
  existingIssue,
  isRegressed,
  lastSeen,
  archiveBaseline = null,
  archiveBaselineIssueId = null,
  sentryIssueId = null,
}) {
  if (!existingIssue) return { action: "create" };
  if (existingIssue.state === "OPEN") {
    return { action: "skip", reason: "already open" };
  }
  if (!isRegressed) return { action: "skip", reason: "closed, not regressed" };
  // Date.parse (not string comparison): Sentry lastSeen can carry fractional
  // seconds while GitHub closed_at does not, and lexicographic comparison
  // would order "…00.500Z" BEFORE "…00Z".
  const closedAtMs = Date.parse(existingIssue.closedAt ?? "");
  const lastSeenMs = Date.parse(lastSeen ?? "");
  if (Number.isNaN(lastSeenMs)) return { action: "reopen" };

  const isArchived = (existingIssue.labels ?? []).includes(ARCHIVED_LABEL);
  const baselineMs = Date.parse(archiveBaseline ?? "");
  if (isArchived && !Number.isNaN(baselineMs)) {
    const recordedId = String(archiveBaselineIssueId ?? "").trim();
    const currentId = String(sentryIssueId ?? "").trim();
    if (!recordedId || recordedId !== currentId) return { action: "reopen" };
    if (lastSeenMs > baselineMs) return { action: "reopen" };
    return {
      action: "skip",
      reason: "archived, no events since the archive baseline",
    };
  }

  if (Number.isNaN(closedAtMs)) return { action: "reopen" };
  if (lastSeenMs > closedAtMs) return { action: "reopen" };
  return { action: "skip", reason: "closed, no events since close" };
}

// The validated permalink is written into the queue-issue body and later read
// back and embedded in Slack mrkdwn link syntax (`<url|text>`) by the digest,
// so `<`, `>`, `|` in the URL would break out of the link — spoofing the
// display text or splitting the Slack block. Reject those plus any ASCII
// control char or whitespace (space, tab, newline, …). `new URL()` accepts all
// of them in the path/query and this validator returns the RAW input string,
// so the shape check must run on the original — not on the re-encoded
// `parsed.href`.
// eslint-disable-next-line no-control-regex -- rejecting control chars in a link target is the point
const UNSAFE_URL_CHARS = /[<>|\x00-\x20\x7f]/;

function isSafeSentryPermalink(url) {
  const value = String(url);
  if (UNSAFE_URL_CHARS.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" && /(^|\.)sentry\.io$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

// Queue contract v2: NO payload-derived text (`title`, `culprit`, messages)
// may appear here — this repo is public, and those fields would publish
// production error data. Only Sentry-assigned identifiers and counters
// render; triage reads the payload in Sentry via the permalink.
const METADATA_FIELDS = [
  "short_id",
  "sentry_issue_id",
  "project",
  "level",
  "status",
  "events",
  "users",
  "first_seen",
  "last_seen",
  "permalink",
];
const NUMERIC_METADATA_FIELDS = new Set(["events", "users"]);
// Hard bound for the remaining string values embedded in the yaml block
// ("Truncate hard" per the issue spec) — defense in depth even though v2
// only renders identifier-ish fields.
const MAX_YAML_STRING_LEN = 200;

function yamlFieldValue(key, meta) {
  const value = meta[key];
  if (NUMERIC_METADATA_FIELDS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "0";
  }
  return JSON.stringify(
    truncateTitle(neutralizeUntrusted(value), MAX_YAML_STRING_LEN),
  );
}

export function buildMetadataYaml(meta) {
  const lines = METADATA_FIELDS.map(
    (key) => `${key}: ${yamlFieldValue(key, meta)}`,
  );
  return ["```yaml", ...lines, "```"].join("\n");
}

export function buildIssueBody(meta) {
  // Queue contract v2: the human-readable section is ONLY the permalink —
  // no payload-derived text renders in this public repo.
  const link = isSafeSentryPermalink(meta.permalink)
    ? `[View in Sentry](${meta.permalink})`
    : "(permalink unavailable)";
  return [BODY_MARKER, "", buildMetadataYaml(meta), "", link, ""].join("\n");
}

export function toMetadata(sentryIssue) {
  // Deliberately excludes `title` and `culprit` (payload-derived text) —
  // queue contract v2 keeps them out of the public queue issue entirely.
  return {
    short_id: sentryIssue.shortId,
    sentry_issue_id: sentryIssue.id,
    project: sentryIssue.project,
    level: sentryIssue.level,
    status: sentryIssue.status,
    events: sentryIssue.events,
    users: sentryIssue.users,
    first_seen: sentryIssue.firstSeen,
    last_seen: sentryIssue.lastSeen,
    permalink: sentryIssue.permalink,
  };
}

export function buildRunRecordBody(counts, timestampIso) {
  return [
    RUN_RECORD_MARKER,
    "",
    `**Sentry triage ingest — last run:** ${timestampIso}`,
    "",
    `- Fetched: ${counts.fetched}`,
    `- Created: ${counts.created}`,
    `- Skipped (existing): ${counts.skippedExisting}`,
    `- Reopened (regressed): ${counts.reopened}`,
    `- Recovered (stranded needs-triage): ${counts.recovered}`,
    `- Errors: ${counts.errors}`,
  ].join("\n");
}

/** Kill switch (SENTRY_TRIAGE_ENABLED) is checked by the workflow YAML, not
 * here, per the queue contract. This is the secret-guard: the script itself
 * must no-op gracefully (exit 0) when the token isn't provisioned yet,
 * whether invoked from CI or locally. */
export function resolveTokenGuard(env = process.env) {
  const token = env.SENTRY_TRIAGE_TOKEN;
  if (!token || !token.trim()) {
    return {
      shouldRun: false,
      reason:
        "SENTRY_TRIAGE_TOKEN is not set; skipping Sentry triage ingest (secret not yet provisioned).",
      token: null,
    };
  }
  return { shouldRun: true, reason: null, token: token.trim() };
}

// ---------------------------------------------------------------------------
// Sentry REST client: GET-only, paginated via Link headers.
// ---------------------------------------------------------------------------

export function parseLinkHeader(header) {
  if (!header) return {};
  const result = {};
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"(?:;\s*results="([^"]+)")?/.exec(
      part.trim(),
    );
    if (!match) continue;
    const [, url, rel, results] = match;
    result[rel] = { url, hasResults: results === "true" };
  }
  return result;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function mapSentryIssue(raw) {
  return {
    id: String(raw?.id ?? ""),
    shortId: raw?.shortId ?? "",
    title: raw?.title ?? "",
    culprit: raw?.culprit ?? "",
    level: raw?.level ?? "error",
    status: raw?.status ?? "unresolved",
    project: raw?.project?.slug ?? raw?.project?.name ?? "unknown",
    events: toCount(raw?.count),
    users: toCount(raw?.userCount),
    firstSeen: raw?.firstSeen ?? null,
    lastSeen: raw?.lastSeen ?? null,
    permalink: raw?.permalink ?? "",
    isRegressed: false,
  };
}

export function mergeSentryIssues(newIssues, regressedIssues) {
  const byId = new Map();
  for (const issue of newIssues ?? []) {
    byId.set(issue.id, { ...issue, isRegressed: false });
  }
  for (const issue of regressedIssues ?? []) {
    const existing = byId.get(issue.id);
    byId.set(
      issue.id,
      existing
        ? { ...existing, isRegressed: true }
        : { ...issue, isRegressed: true },
    );
  }
  return byId;
}

/**
 * The Link header is response data — never follow it blindly with the
 * Authorization header attached. A next-page URL is only safe when it is
 * https and points at the exact host we started from; anything else would
 * leak the Sentry token to a third-party (or downgraded) origin.
 */
export function isSafeNextPageUrl(nextUrl, baseUrl) {
  try {
    const next = new URL(String(nextUrl));
    const base = new URL(String(baseUrl));
    return next.protocol === "https:" && next.hostname === base.hostname;
  } catch {
    return false;
  }
}

async function fetchSentryIssuesPage(url, token, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Sentry API request failed: ${res.status} ${res.statusText} (${url})`,
    );
  }
  const body = await res.json();
  const links = parseLinkHeader(res.headers.get("link"));
  return { issues: Array.isArray(body) ? body : [], next: links.next };
}

async function fetchAllSentryIssues({
  query,
  org,
  baseUrl,
  token,
  fetchImpl,
  maxPages = 20,
}) {
  let url = `${baseUrl}/api/0/organizations/${encodeURIComponent(org)}/issues/?query=${encodeURIComponent(query)}&limit=100`;
  const collected = [];
  let pages = 0;
  while (url && pages < maxPages) {
    const { issues, next } = await fetchSentryIssuesPage(url, token, fetchImpl);
    collected.push(...issues);
    if (next?.hasResults) {
      if (!isSafeNextPageUrl(next.url, baseUrl)) {
        // Fail loud rather than silently truncating the scan: a hostile or
        // malformed pagination URL should never be followed with the token.
        throw new Error(
          `Refusing to follow unsafe Sentry pagination URL: ${next.url}`,
        );
      }
      url = next.url;
    } else {
      url = null;
    }
    pages += 1;
  }
  return collected.map(mapSentryIssue);
}

async function defaultFetchMergedSentryIssues(options) {
  const common = {
    org: options.org,
    baseUrl: options.sentryBaseUrl,
    token: options.sentryToken,
    fetchImpl: fetch,
  };
  const [newIssues, regressedIssues] = await Promise.all([
    fetchAllSentryIssues({
      ...common,
      query: buildNewIssuesQuery(options.lookbackDays),
    }),
    fetchAllSentryIssues({ ...common, query: REGRESSED_ISSUES_QUERY }),
  ]);
  return mergeSentryIssues(newIssues, regressedIssues);
}

// ---------------------------------------------------------------------------
// GitHub side effects (via `gh`, mirroring scripts/agent-issue-board.mjs).
// Read-only calls always execute; mutating calls are logged and skipped
// under --dry-run.
// ---------------------------------------------------------------------------

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@#-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatGh(args) {
  return `gh ${args.map((arg) => quoteArg(String(arg))).join(" ")}`;
}

function runGh(args, { dryRun = false, mutates = false } = {}) {
  if (dryRun && mutates) {
    process.stderr.write(`[dry-run] ${formatGh(args)}\n`);
    return Promise.resolve("");
  }

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

async function ensureLabelsExist(options) {
  for (const label of LABEL_DEFINITIONS) {
    await runGh(
      [
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description,
        "-R",
        options.repo,
        "--force",
      ],
      { dryRun: options.dryRun, mutates: true },
    );
  }
}

// Normalize a REST-API issue (lowercase `state`, `pull_request` marker on
// PRs, `closed_at` for the regression-reopen timestamp gate, `labels` — read by
// the archive-baseline branch to recognize a `sentry:archived` stub and by the
// stranded-stub sweep to spot a closed one still wearing `sentry:needs-triage` —
// and `body`, which carries that baseline) into the shape decideDedupAction and
// isStrandedNeedsTriage expect. The REST list returns all five, so neither the
// baseline read nor the sweep costs an extra request. Exported for tests.
export function normalizeRestIssues(pages) {
  return (pages ?? [])
    .flat()
    .filter((issue) => issue && !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title ?? "",
      state: String(issue.state ?? "").toUpperCase(),
      closedAt: issue.closed_at ?? null,
      body: issue.body ?? "",
      labels: (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean),
    }));
}

/**
 * Manual REST pagination via explicit `page=N` requests. Deliberately avoids
 * `gh api --paginate --slurp`: `--slurp` only exists on recent gh releases,
 * and an older runner-image gh would fail the very first queue scan (before
 * the run record posts). A plain page loop is version-independent, has no
 * result cap (the Codex 1000-cap fix), and terminates on the first short or
 * empty page. Fails loud past `maxPages` instead of silently truncating.
 * Returns an array of pages; `runner` is injectable for tests.
 */
export async function ghPaginate(
  path,
  { perPage = 100, maxPages = 200, runner } = {},
) {
  const run = runner ?? ((args) => runGh(args, {}));
  const pages = [];
  for (let page = 1; ; page += 1) {
    if (page > maxPages) {
      throw new Error(
        `GitHub pagination exceeded ${maxPages} pages for ${path}; refusing to continue silently`,
      );
    }
    const separator = path.includes("?") ? "&" : "?";
    const stdout = await run([
      "api",
      `${path}${separator}per_page=${perPage}&page=${page}`,
    ]);
    const items = stdout && stdout.trim() ? JSON.parse(stdout) : [];
    if (!Array.isArray(items)) {
      throw new Error(`Unexpected non-array GitHub API response for ${path}`);
    }
    if (items.length === 0) break;
    pages.push(items);
    if (items.length < perPage) break;
  }
  return pages;
}

async function listExistingQueueIssues(options) {
  // The full label set (all states) is the dedup source of truth, so page
  // through it completely via the REST API — `gh issue list --limit N` caps
  // the scan and would silently start creating duplicates once the queue
  // outgrows the cap.
  const pages = await ghPaginate(
    `repos/${options.repo}/issues?labels=sentry-triage&state=all`,
  );
  return normalizeRestIssues(pages);
}

async function createQueueIssue(options, sentryIssue) {
  const title = buildQueueTitle(
    sentryIssue.shortId,
    sentryIssue.project,
    sentryIssue.level,
  );
  const isNoise = classifyNoise(sentryIssue.title);
  const labels = buildQueueLabels(isNoise);
  const body = buildIssueBody(toMetadata(sentryIssue));
  await runGh(
    [
      "issue",
      "create",
      "-R",
      options.repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      labels.join(","),
    ],
    { dryRun: options.dryRun, mutates: true },
  );
}

/**
 * CLOSED + `sentry:needs-triage` is an unreachable pairing, never a resting
 * state: Stage B's selector lists `--state open` only, and the regression path
 * above reopens a closed stub solely when Sentry reports events after
 * `closedAt`. A stub in this pairing is therefore invisible to every stage —
 * labeled as awaiting a verdict that nothing will ever produce.
 *
 * Several stages can produce it, and the list is open-ended. Both
 * `gh issue close` compensation paths in `.github/workflows/sentry-triage-agent.yml`
 * (the `verdict` job's close step and the `project` job's per-row close) restore
 * `sentry:needs-triage` when the close REPORTS failure — correct when the close
 * did not happen, wrong when only its response was lost, because a rejected
 * command is not proof its remote mutation did not happen. The archive leg's
 * live-regression refusal re-queues a stub it never reopens, and this script's
 * own reopen sequence writes the label before the state change, so a crash
 * between the two leaves the same pairing behind. A human can hand-edit it in.
 *
 * So the pairing is repaired HERE, from observed state, rather than guarded at
 * each producer: recovery covers every producer that exists today and every one
 * added later. Reopening (not stripping the label) is the correct repair —
 * every producer that writes this pairing meant the stub to be triaged.
 *
 * The repair runs through the re-queue chokepoint
 * (scripts/sentry-triage-requeue.mjs) with cause `bookkeeping`, which is what
 * makes it fence-free: nothing about the Sentry issue changed, so a verdict
 * already posted for this stub stays valid and admissible. The counterpart
 * declaration lives on the producer that DOES know a regression happened — the
 * archive leg's live-regression refusal names `sentry-evidence`, because Sentry
 * reported new events there. Fencing here would throw away good verdicts; not
 * fencing there would close a stub over a live regression. Neither site writes
 * that decision itself; both name a cause and the chokepoint applies the rule.
 *
 * The chokepoint's label edit sheds REOPEN_SHED_LABELS on both causes, so a
 * hand-edited stub cannot come back carrying both `sentry:needs-triage` and a
 * stale verdict — two verdict labels would misclassify it downstream.
 */
export function isStrandedNeedsTriage(issue) {
  return (
    issue?.state === "CLOSED" &&
    (issue?.labels ?? []).includes(NEEDS_TRIAGE_LABEL)
  );
}

/** Live state of one queue stub, for the sweep's pre-mutation revalidation. */
async function readQueueIssueState(options, issueNumber, runner) {
  const run = runner ?? ((args) => runGh(args, {}));
  const stdout = await run([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    options.repo,
    "--json",
    "number,state,labels",
  ]);
  const data = stdout && stdout.trim() ? JSON.parse(stdout) : {};
  return {
    number: data.number,
    state: String(data.state ?? "").toUpperCase(),
    labels: (data.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean),
  };
}

/**
 * `runGh` is injectable so the test can drive this exact sequence against a
 * stateful fake instead of re-implementing it.
 *
 * Returns `{ recovered }` — false when the live re-read no longer shows the
 * stranded pairing, which is a normal no-op, not a failure.
 */
export async function recoverStrandedQueueIssue(
  options,
  existingIssue,
  deps = {},
) {
  const run = deps.runGh ?? runGh;

  // BOOKKEEPING cause, declared rather than reconstructed: nothing about the
  // Sentry issue changed, so the chokepoint posts NO fence and the verdict
  // already computed for this stub stays valid and admissible. The counterpart
  // declaration lives on the producer that DOES know a regression happened — the
  // archive leg's live-regression refusal names `sentry-evidence`. Fencing here
  // would throw away good verdicts; not fencing there would close a stub over a
  // live regression.
  //
  // `revalidate` is this path's whole premise check. The queue snapshot the stub
  // came from was taken before the Sentry loop ran, and ingest holds its own
  // concurrency group, so minutes can pass — long enough for a human to have
  // declined the stub, which the runbook says to do by REMOVING
  // `sentry:needs-triage`. Re-adding it off a stale snapshot reverses exactly
  // that action. A failed read propagates (the chokepoint never treats one as
  // permission to proceed), the stub stays stranded and visible to the next run,
  // and the run goes nonzero.
  const outcome = await requeueQueueStub(
    {
      writeGh: (args) => run(args, { dryRun: options.dryRun, mutates: true }),
      readStub: (number) => readQueueIssueState(options, number, deps.runGh),
    },
    {
      repo: options.repo,
      issueNumber: existingIssue.number,
      cause: REQUEUE_CAUSE_BOOKKEEPING,
      note: buildStrandedRecoveryComment(),
      revalidate: {
        check: isStrandedNeedsTriage,
        declineNote: (live) =>
          `Queue issue #${existingIssue.number} is no longer closed-and-needing-triage (state=${live.state}, labels=${live.labels.join(",") || "none"}); leaving it as the current state describes.`,
      },
    },
  );
  // False when the live re-read no longer shows the stranded pairing, which is a
  // normal no-op, not a failure.
  return { recovered: outcome.requeued };
}

/**
 * Read a queue stub's comments — WHOLE objects, never bodies alone, because the
 * only consumer has to fence on authorship and a bare body cannot. Used solely
 * on the reopen path, so the extra call costs one request per regression rather
 * than one per run. The REST shape carries `user.login`, which
 * `isTrustedComment` accepts alongside the GraphQL `author.login`.
 */
async function fetchIssueComments(options, issueNumber, runner) {
  const pages = await ghPaginate(
    `repos/${options.repo}/issues/${issueNumber}/comments`,
    runner ? { runner } : {},
  );
  return pages.flat().filter((comment) => typeof comment?.body === "string");
}

/**
 * Stage A's regression reopen: Sentry reported events after this stub's close,
 * so the previous round's verdict describes a dead occurrence.
 *
 * SENTRY-EVIDENCE cause, so the chokepoint fences — and it, not this function,
 * owns the fence text, the fence-before-labels ordering, and the state-change-
 * last ordering.
 *
 * `dedupeFence` is the one policy this path declares that the archive's refusal
 * deliberately does NOT, and the premise is specific to ingest's gate: an
 * identical body means an identical `lastSeen`, and `decideDedupAction`'s
 * `lastSeen > closedAt` cannot fire twice for one `lastSeen` with a verdict in
 * between — a verdict implies a later close, which puts `closedAt` past that
 * `lastSeen`. So the guard can only ever suppress a duplicate of a fence already
 * in place. The archive's refusal fires on `isActivelyRegressing`, which reads
 * Sentry's substatus and stays true for days regardless of timestamps, so the
 * same premise does not hold there. (The chokepoint additionally disarms the
 * guard whenever `lastSeen` does not parse, since the body then identifies no
 * occurrence at all.)
 *
 * `runGh` is injectable so the test can drive this exact sequence against a
 * stateful fake instead of re-implementing it.
 */
export async function reopenQueueIssue(
  options,
  existingIssue,
  sentryIssue,
  deps = {},
) {
  const run = deps.runGh ?? runGh;
  await requeueQueueStub(
    {
      writeGh: (args) => run(args, { dryRun: options.dryRun, mutates: true }),
      readComments: (number) => fetchIssueComments(options, number, deps.runGh),
      // Records the ATTEMPT in runIngest's exclusion set before the first write,
      // so a reopen that throws half-way is never inherited by the same run's
      // fence-free bookkeeping sweep.
      claim: deps.claim,
    },
    {
      repo: options.repo,
      issueNumber: existingIssue.number,
      cause: REQUEUE_CAUSE_SENTRY_EVIDENCE,
      lastSeen: sentryIssue.lastSeen,
      dedupeFence: true,
    },
  );
}

async function fetchTrackerComments(options) {
  // Same manual page loop as the dedup scan — parseable on any gh version
  // and safe past the 100-comment pagination boundary.
  const pages = await ghPaginate(
    `repos/${options.repo}/issues/${options.trackerIssue}/comments`,
  );
  return pages.flat();
}

async function defaultPostRunRecord(options, counts, now) {
  const body = buildRunRecordBody(counts, now.toISOString());
  const comments = await fetchTrackerComments(options);
  // Fence: trusted author + startsWith(RUN_RECORD_MARKER) anchor, shared with
  // the autofix leg's run-record writer via selectMarkedComment
  // (scripts/sentry-triage-project-core.mjs) so the two writers cannot drift
  // apart. This repo is public and #1282 is open, so without both fences an
  // untrusted commenter could plant the marker anywhere in a comment body and
  // have the next run PATCH its content into their comment.
  const existing = selectMarkedComment(comments, RUN_RECORD_MARKER);
  if (existing) {
    await runGh(
      [
        "api",
        "-X",
        "PATCH",
        `repos/${options.repo}/issues/comments/${existing.id}`,
        "-f",
        `body=${body}`,
      ],
      { dryRun: options.dryRun, mutates: true },
    );
  } else {
    await runGh(
      [
        "issue",
        "comment",
        String(options.trackerIssue),
        "-R",
        options.repo,
        "--body",
        body,
      ],
      { dryRun: options.dryRun, mutates: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestration. Dependency-injectable so tests can prove the dedup
// invariant (a second run creates zero new issues) with mocked I/O instead
// of hitting Sentry/GitHub.
// ---------------------------------------------------------------------------

export async function runIngest(options, deps = {}) {
  const {
    fetchMergedSentryIssues = defaultFetchMergedSentryIssues,
    listQueueIssues = listExistingQueueIssues,
    ensureLabels = ensureLabelsExist,
    createIssue = createQueueIssue,
    reopenIssue = reopenQueueIssue,
    recoverStranded = recoverStrandedQueueIssue,
    postRunRecord = defaultPostRunRecord,
    now = () => new Date(),
  } = deps;

  const counts = {
    fetched: 0,
    created: 0,
    skippedExisting: 0,
    reopened: 0,
    recovered: 0,
    errors: 0,
  };

  await ensureLabels(options);

  const merged = await fetchMergedSentryIssues(options);
  counts.fetched = merged.size;

  const existingIssues = await listQueueIssues(options);
  const existingByShortId = indexQueueIssuesByShortId(existingIssues);

  // Stubs this run's SENTRY-EVIDENCE path has taken responsibility for. The
  // bookkeeping sweep below must not touch them, and the reason is stronger than
  // avoiding a double write on the stale snapshot.
  //
  // These two paths re-queue for OPPOSITE reasons and therefore post opposite
  // comments: the regression reopen fences (new Sentry events make any prior
  // verdict stale), the sweep does not (a lost close response changed nothing).
  // A stub can be eligible for both at once — closed, wearing
  // `sentry:needs-triage` from an earlier bookkeeping compensation, and NOW
  // regressed. If the regression reopen throws, recording only SUCCESSES would
  // leave that stub unclaimed, and the sweep would reopen it seconds later
  // through the fence-free path: a failed Sentry-evidence re-queue laundered
  // into a bookkeeping one, inside a single run. The pre-regression verdict
  // stays admissible, and the next triage round that dies before posting lets
  // the `verdict` job close over the new occurrence.
  //
  // So this records ATTEMPTS, not successes, and it is written before the first
  // write of the attempt (`Set.add` is synchronous, so it survives a throw from
  // the await that follows). The catch below claims the stub too, for the same
  // reason one step earlier: a failure while DECIDING leaves us unable to say
  // the cause was bookkeeping, and the sweep must never assume that. Deferring a
  // genuine recovery by one run is cheap; mislabelling a regression is not.
  const claimedBySentryPath = new Set();

  for (const sentryIssue of merged.values()) {
    let existingIssue = null;
    try {
      existingIssue = existingByShortId.get(sentryIssue.shortId) ?? null;
      // Only an archived, closed, regressed stub needs its audit comment read
      // (issue #1371) — everything else decides off the labels/timestamps we
      // already have.
      // The baseline rides in the stub BODY, which the dedup scan already
      // fetched — no per-stub comment read, and no forgeable comment surface.
      const baseline = parseArchiveBaseline(existingIssue?.body);
      const decision = decideDedupAction({
        existingIssue,
        isRegressed: sentryIssue.isRegressed,
        lastSeen: sentryIssue.lastSeen,
        archiveBaseline: baseline?.lastSeen ?? null,
        archiveBaselineIssueId: baseline?.sentryIssueId ?? null,
        sentryIssueId: sentryIssue.id,
      });
      if (decision.action === "skip") {
        counts.skippedExisting += 1;
      } else if (decision.action === "create") {
        await createIssue(options, sentryIssue);
        counts.created += 1;
      } else if (decision.action === "reopen") {
        // Claim BEFORE the first write, never after it: a reopen that throws
        // half-way is exactly the case the sweep must not inherit.
        //
        // The catch below currently covers this same case, so removing either
        // one alone keeps the tests green — they are deliberate overlapping
        // guards, not dead code (removing BOTH does fail). This one survives a
        // refactor the other does not: give `reopenIssue` its own try/catch, the
        // way the archive leg wraps its best-effort writes, and the outer catch
        // stops firing while this line still holds.
        //
        // `claim` hands the same rule to the chokepoint, which records the
        // attempt before its own first write. That is the copy a caller added
        // later inherits without remembering to; this one covers a caller that
        // replaces `reopenIssue` wholesale (the tests do).
        const claim = () => claimedBySentryPath.add(existingIssue.number);
        claim();
        await reopenIssue(options, existingIssue, sentryIssue, { claim });
        counts.reopened += 1;
      }
    } catch (err) {
      // Anything that threw before the branch above could still have been a
      // regression; with no decision in hand the sweep cannot call it
      // bookkeeping, so claim it and let the next run decide from scratch.
      if (existingIssue) claimedBySentryPath.add(existingIssue.number);
      counts.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Error processing Sentry issue ${sentryIssue.shortId || sentryIssue.id}: ${message}\n`,
      );
    }
  }

  // Stranded-stub sweep (see isStrandedNeedsTriage). It runs over the QUEUE,
  // not over this run's Sentry results: a stranded stub's Sentry issue is
  // usually outside the firstSeen lookback and not regressed, so the loop above
  // never visits it. Same per-item error handling as the loop — one unrecovered
  // stub must not abort the rest, and the run still exits nonzero.
  for (const existingIssue of existingIssues) {
    if (claimedBySentryPath.has(existingIssue.number)) continue;
    if (!isStrandedNeedsTriage(existingIssue)) continue;
    try {
      // A revalidation no-op is not a recovery; only count real ones so the run
      // record cannot read as activity that never happened.
      const outcome = await recoverStranded(options, existingIssue);
      if (outcome?.recovered !== false) counts.recovered += 1;
    } catch (err) {
      counts.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Error recovering stranded queue issue #${existingIssue.number}: ${message}\n`,
      );
    }
  }

  await postRunRecord(options, counts, now());
  return counts;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: pnpm sentry:ingest [options]

Options:
  --repo <owner/name>        Repository to file queue issues in (default: ${DEFAULT_REPO})
  --org <sentry-org>         Sentry organization slug (default: ${DEFAULT_ORG})
  --sentry-base-url <url>    Sentry API base URL (default: ${DEFAULT_SENTRY_BASE_URL})
  --tracker-issue <number>   Tracker issue for the run-record comment (default: ${DEFAULT_TRACKER_ISSUE})
  --lookback-days <days>     firstSeen lookback window, integer 1-${MAX_LOOKBACK_DAYS} (default: ${DEFAULT_LOOKBACK_DAYS};
                             env fallback SENTRY_TRIAGE_LOOKBACK_DAYS; widen to backfill after an outage)
  --dry-run                  Print mutations without applying them
  --json                     Print machine-readable run counts
  -h, --help                 Show this help
`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    repo: DEFAULT_REPO,
    org: DEFAULT_ORG,
    sentryBaseUrl: DEFAULT_SENTRY_BASE_URL,
    trackerIssue: DEFAULT_TRACKER_ISSUE,
    dryRun: false,
    json: false,
    help: false,
  };
  let lookbackCliValue = null;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };

    switch (arg) {
      case "--repo":
        options.repo = readValue();
        break;
      case "--org":
        options.org = readValue();
        break;
      case "--sentry-base-url":
        options.sentryBaseUrl = readValue();
        break;
      case "--tracker-issue":
        options.trackerIssue = Number(readValue());
        break;
      case "--lookback-days":
        lookbackCliValue = readValue();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (!Number.isInteger(options.trackerIssue) || options.trackerIssue <= 0) {
    throw new Error("--tracker-issue must be a positive integer");
  }

  options.lookbackDays = resolveLookbackDays(lookbackCliValue, env);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  // Kill switch (SENTRY_TRIAGE_ENABLED) is checked by the calling workflow
  // step, per the queue contract. This guard covers the secret itself, so
  // the script also no-ops gracefully when invoked directly (locally, or if
  // the workflow step were ever bypassed) instead of throwing an
  // unhelpful fetch error.
  const guard = resolveTokenGuard(process.env);
  if (!guard.shouldRun) {
    process.stdout.write(`::notice::${guard.reason}\n`);
    return;
  }
  options.sentryToken = guard.token;

  const counts = await runIngest(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Sentry triage ingest: fetched=${counts.fetched} created=${counts.created} skipped-existing=${counts.skippedExisting} reopened=${counts.reopened} recovered=${counts.recovered} errors=${counts.errors}\n`,
    );
  }
  // Per-issue mutation failures are tolerated inside the loop (one bad issue
  // must not abort the batch) and the run record still posts, but the run as
  // a whole must FAIL so the scheduled workflow goes red and the
  // Slack-on-failure notifier fires — otherwise a systemic failure mode
  // (bad token permission, API outage) would stay green indefinitely.
  if (counts.errors > 0) {
    process.stderr.write(
      `${counts.errors} Sentry issue(s) failed to ingest; exiting nonzero so the failure notifier fires.\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
