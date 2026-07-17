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

export const RUN_RECORD_MARKER = "<!-- sentry-triage-ingest:run-record:v1 -->";
const BODY_MARKER = "<!-- sentry-triage:v1 -->";

// ---------------------------------------------------------------------------
// Pure helpers: title/body construction, noise classification, dedup
// decision. Untrusted-input handling lives here (Sentry titles/culprits are
// attacker-reachable text — never execute/eval anything derived from them).
// ---------------------------------------------------------------------------

/** Strip control chars/newlines and collapse whitespace to a single line. */
export function sanitizeFreeText(text) {
  return (
    String(text ?? "")
      // eslint-disable-next-line no-control-regex -- stripping control chars from untrusted Sentry text is the whole point here
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Replace every backtick with a visually similar but byte-distinct
// character. This is what actually prevents an attacker-controlled Sentry
// title/culprit from closing the ```yaml fence early (or a single-backtick
// inline-code span) once embedded in the issue body's markdown.
export function defangBackticks(text) {
  return text.replace(/`/g, "ˋ");
}

// Insert a zero-width space after every `@` so `@user` / `@org/team` in
// attacker-reachable Sentry text can never become a live GitHub mention
// (which would notify/subscribe real users) once embedded in an issue title
// or comment. Visual fidelity is preserved for triage.
export function defangMentions(text) {
  return text.replace(/@/g, "@\u200B");
}

export function neutralizeUntrusted(text) {
  return defangMentions(defangBackticks(sanitizeFreeText(text)));
}

export function truncateTitle(text, maxLen = 90) {
  const clean = text ?? "";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trimEnd()}…`;
}

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
  const labels = ["sentry-triage", "sentry:needs-triage"];
  if (isNoise) labels.push("sentry:candidate-noise");
  return labels;
}

// Idempotently created/updated on every run (`gh label create --force`).
export const LABEL_DEFINITIONS = [
  {
    name: "sentry-triage",
    color: "5319e7",
    description: "Sentry triage pipeline queue issue (ADR 0036)",
  },
  {
    name: "sentry:needs-triage",
    color: "fbca04",
    description: "Awaiting triage-agent verdict",
  },
  {
    name: "sentry:candidate-noise",
    color: "d4c5f9",
    description:
      "Matches known operational-noise heuristics (CSP, timeouts, chunk-load, abort)",
  },
  {
    name: "sentry:verdict-code-fix",
    color: "0e8a16",
    description: "Triage verdict: fixable in this repo's code",
  },
  {
    name: "sentry:verdict-config-fix",
    color: "1d76db",
    description: "Triage verdict: fixable via configuration",
  },
  {
    name: "sentry:verdict-upstream",
    color: "e99695",
    description: "Triage verdict: upstream/third-party, not fixable here",
  },
  {
    name: "sentry:verdict-needs-human",
    color: "d93f0b",
    description: "Triage verdict: needs human judgment",
  },
  {
    name: "sentry:projected",
    color: "0052cc",
    description:
      "Actionable verdict projected as an issue in the owning repo (ADR 0038)",
  },
];

export const PROJECTED_LABEL = "sentry:projected";

// Stage B's verdict namespace, derived from the definitions above so the two
// can't drift. A reopened regression must shed its previous verdict — the
// old verdict described the old occurrence, and downstream consumers filter
// on `sentry:needs-triage` + absence of a verdict.
export const VERDICT_LABELS = LABEL_DEFINITIONS.map(
  (label) => label.name,
).filter((name) => name.startsWith("sentry:verdict-"));

// Labels a regression reopen must shed: the stale verdict labels PLUS the
// stale `sentry:projected` marker (ADR 0038) — the old projection described
// the old occurrence, and leaving it would show a needs-triage issue as
// already projected. If the re-triage round lands on an actionable verdict
// again, the projection step re-applies it, idempotently reusing the same
// owning-repo issue.
export const REOPEN_SHED_LABELS = [...VERDICT_LABELS, PROJECTED_LABEL];

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
 * substatus (the counterpart of the Stage B queue-closing step). Missing or
 * unparsable timestamps fail open toward triage (reopen): a wrongly
 * skipped regression is silent, a wrongly reopened one merely re-triages.
 * Closed match, not regressed -> skip (stays closed). No match -> create.
 */
export function decideDedupAction({ existingIssue, isRegressed, lastSeen }) {
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
  if (Number.isNaN(closedAtMs) || Number.isNaN(lastSeenMs)) {
    return { action: "reopen" };
  }
  if (lastSeenMs > closedAtMs) return { action: "reopen" };
  return { action: "skip", reason: "closed, no events since close" };
}

export function buildRegressedComment(lastSeen) {
  // `lastSeen` should be a Sentry-generated ISO timestamp, but it still
  // transits Sentry's API from event data — neutralize + bound it like every
  // other Sentry-derived string (no-op for a legitimate timestamp).
  return `Regressed in Sentry (last seen ${truncateTitle(neutralizeUntrusted(lastSeen), 90)})`;
}

function isSafeSentryPermalink(url) {
  try {
    const parsed = new URL(String(url));
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
// PRs, `closed_at` for the regression-reopen timestamp gate) into the shape
// decideDedupAction expects. Exported for tests.
export function normalizeRestIssues(pages) {
  return (pages ?? [])
    .flat()
    .filter((issue) => issue && !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title ?? "",
      state: String(issue.state ?? "").toUpperCase(),
      closedAt: issue.closed_at ?? null,
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
 * Label edit for the regression-reopen path: re-queue for triage AND shed
 * any stale `sentry:verdict-*` labels plus the stale `sentry:projected`
 * marker from the previous triage round — the old verdict/projection
 * described the old occurrence, and leaving them would show downstream
 * consumers a needs-triage issue that also reads as verdicted/projected.
 * Removing an absent label is a no-op for `gh issue edit` (the labels
 * themselves always exist because ensureLabelsExist runs first). Exported
 * for tests.
 */
export function buildReopenLabelEditArgs(issueNumber, repo) {
  return [
    "issue",
    "edit",
    String(issueNumber),
    "-R",
    repo,
    "--add-label",
    "sentry:needs-triage",
    "--remove-label",
    REOPEN_SHED_LABELS.join(","),
  ];
}

async function reopenQueueIssue(options, existingIssue, sentryIssue) {
  // Order matters for crash-safety: the reopen (state change) goes LAST.
  // The closed->open transition is what flips the next run onto the
  // open-match skip path, so if the label or comment step failed after an
  // early reopen, the issue would sit open without `sentry:needs-triage`
  // forever — reopened but invisible to triage. With the state change last,
  // any partial failure leaves the issue closed and the whole (idempotent)
  // sequence is retried on the next run; the worst case is a duplicate
  // regression comment.
  await runGh(buildReopenLabelEditArgs(existingIssue.number, options.repo), {
    dryRun: options.dryRun,
    mutates: true,
  });
  await runGh(
    [
      "issue",
      "comment",
      String(existingIssue.number),
      "-R",
      options.repo,
      "--body",
      buildRegressedComment(sentryIssue.lastSeen),
    ],
    { dryRun: options.dryRun, mutates: true },
  );
  await runGh(
    ["issue", "reopen", String(existingIssue.number), "-R", options.repo],
    { dryRun: options.dryRun, mutates: true },
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
  const existing = comments.find(
    (comment) =>
      typeof comment.body === "string" &&
      comment.body.includes(RUN_RECORD_MARKER),
  );
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
    postRunRecord = defaultPostRunRecord,
    now = () => new Date(),
  } = deps;

  const counts = {
    fetched: 0,
    created: 0,
    skippedExisting: 0,
    reopened: 0,
    errors: 0,
  };

  await ensureLabels(options);

  const merged = await fetchMergedSentryIssues(options);
  counts.fetched = merged.size;

  const existingIssues = await listQueueIssues(options);
  const existingByShortId = indexQueueIssuesByShortId(existingIssues);

  for (const sentryIssue of merged.values()) {
    try {
      const existingIssue = existingByShortId.get(sentryIssue.shortId) ?? null;
      const decision = decideDedupAction({
        existingIssue,
        isRegressed: sentryIssue.isRegressed,
        lastSeen: sentryIssue.lastSeen,
      });
      if (decision.action === "skip") {
        counts.skippedExisting += 1;
      } else if (decision.action === "create") {
        await createIssue(options, sentryIssue);
        counts.created += 1;
      } else if (decision.action === "reopen") {
        await reopenIssue(options, existingIssue, sentryIssue);
        counts.reopened += 1;
      }
    } catch (err) {
      counts.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Error processing Sentry issue ${sentryIssue.shortId || sentryIssue.id}: ${message}\n`,
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
      `Sentry triage ingest: fetched=${counts.fetched} created=${counts.created} skipped-existing=${counts.skippedExisting} reopened=${counts.reopened} errors=${counts.errors}\n`,
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
