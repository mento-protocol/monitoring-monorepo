#!/usr/bin/env node
/**
 * Observability leg of the Sentry triage pipeline (ADR 0036,
 * docs/adr/0036-sentry-triage-pipeline.md): a deterministic, no-LLM collector
 * that turns one triage-agent run's batch into a single Slack digest payload.
 * The digest is OUTCOME-oriented (issue #1355): a reader must know in two
 * seconds what was handled and what needs them. Sections render in this order,
 * empty ones omitted, each header carrying its own count:
 *
 *   1. ⚠️  Needs human — decisions required   (FIRST + visually distinct: each
 *      item is a decision-ready brief — the exact question, the agent's
 *      hypotheses, what was investigated, why it was escalated, plus links).
 *   2. 🤖 Autofixed                            (renders ONLY when fix-PR data
 *      exists — see the #1278 emission interface below).
 *   3. 📮 Routed to owning repo                (code/config-fix verdicts, each
 *      linking the PROJECTED owning-repo issue; falls back to the queue-issue
 *      verdict when projection was skipped — a LOCAL code-fix never projects,
 *      and one the autofix leg will never attempt is marked as such rather
 *      than left reading as handed to a team that does not exist).
 *   4. 🙅 Wontfix / transient                  (upstream-transient verdicts,
 *      each linking the rationale on the queue issue, with a nudge toward the
 *      existing `sentry:approved-archive` label flow for that stub).
 *   5. 🛑 Failed triage                        (batch issues still carrying
 *      sentry:needs-triage — their matrix job died; kept visible, never hidden).
 *
 * This script is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md — it reads each batch issue's labels,
 * body, and latest `<!-- sentry-triage-verdict:v1 -->` comment and never
 * changes the contract, the labels, or Sentry. It builds the Slack payload
 * (including escaping); the workflow's posting step is the only place the Slack
 * token lives and the only thing that POSTs.
 *
 * Single-parser rule: the verdict comment is parsed by the SAME authoritative
 * parser the label/projection steps use (`parseVerdictComment` from
 * sentry-triage-project-core.mjs), so the digest can never disagree with the
 * pipeline about what a verdict says — including the four needs-human brief
 * fields. The digest does NOT re-validate `human_question`; that fail-loud gate
 * lives in the workflow's `--parse-only` label step (`resolveVerdict`), so a
 * needs-human stub that reaches the digest already carries one.
 *
 * Security posture: verdict text is agent-authored from untrusted Sentry data —
 * treated exactly like the queue-issue body text in Stage A. Every free-form
 * value embedded in the payload (summary, the needs-human brief fields, plus
 * the short-id/project lifted from the queue title) is neutralized and
 * Slack-escaped before it reaches a payload field, using the SAME `& < >`
 * escape the main-failure notifier uses (.github/workflows/notify-slack-on-main-failure.yml).
 * That escape neutralizes Slack mention/link control syntax (`<!channel>`,
 * `<@U123>`, `<url|text>`). Closed-set fields (verdict, confidence) are
 * validated against their enums so only known-safe tokens ever render; the URLs
 * we turn into links are shape-validated (queue/projected/fix = https github.com,
 * Sentry permalink = https *.sentry.io) before rendering.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The archive leg's approval-label name is owned by the ingest module (it
// defines the label); import it rather than duplicating the string literal so
// the two can never drift apart.
import { APPROVED_ARCHIVE_LABEL } from "./sentry-triage-ingest.mjs";

// Verdict-comment parsing is delegated to the pipeline's single authoritative
// parser (the same one the label/projection steps run) so the digest can never
// diverge from what the pipeline decided. The permalink extractor + the
// projected-comment prefix are contract constants owned by the same module.
import {
  extractPermalink,
  isTrustedComment,
  parseVerdictComment,
  PROJECTED_COMMENT_PREFIX,
  REGRESSION_PREFIX,
  selectVerdictComment,
  validateAffectedRepo,
} from "./sentry-triage-project-core.mjs";

// The pure Slack-render layer (escaping, per-issue line renderers, the section
// taxonomy, block chunking) lives in its own module (#1812 file split); this
// module owns classification, verdict-parse orchestration, Slack-payload
// assembly, gh collection and the CLI. Imported directly, no re-export shim.
import {
  ARCHITECTURAL_SECTION,
  AUTOFIXED_SECTION,
  chunkBriefs,
  chunkLines,
  FAILED_SECTION,
  isArchitecturalLocalCodeFix,
  issueCountText,
  mrkdwnSection,
  NEEDS_HUMAN_SECTION,
  renderNeedsHumanBrief,
  renderSectionBodyLines,
  ROUTED_SECTION,
  SECTION_ORDER,
  SECTION_TITLES,
  UNSAFE_URL_CHARS,
  WONTFIX_SECTION,
} from "./sentry-triage-digest-render.mjs";

// Re-export the authoritative parser under the digest's historical name so
// consumers/tests keep one import surface (the digest never owns a second
// verdict parser).
export {
  extractPermalink,
  parseVerdictComment,
  PROJECTED_COMMENT_PREFIX,
} from "./sentry-triage-project-core.mjs";
export { extractYamlBlock as extractVerdictYamlBlock } from "./sentry-triage-project-core.mjs";

export const DEFAULT_REPO = "mento-protocol/monitoring-monorepo";

export const VERDICT_MARKER = "<!-- sentry-triage-verdict:v1 -->";
export const NEEDS_TRIAGE_LABEL = "sentry:needs-triage";

// #1278 emission interface (Phase 2b autofix). The Autofixed section renders an
// issue ONLY when the pipeline recorded a fix PR for it. The contract #1278
// must emit: a trusted-bot comment on the queue stub whose body is exactly this
// prefix followed by the fix PR's https github.com URL — e.g.
// `Autofixed by PR: https://github.com/mento-protocol/frontend-monorepo/pull/42`.
// The digest reads the newest such comment (authorship-fenced, URL
// shape-validated) and links it. Until #1278 lands no emitter posts this, so
// the Autofixed section stays empty and is omitted. Mirrors the machine-parseable
// PROJECTED_COMMENT_PREFIX the projection step already posts.
export const AUTOFIX_COMMENT_PREFIX = "Autofixed by PR: ";

// Verdict LABEL -> verdict VALUE. This is the inverse of the ingest's
// value->label map; note the deliberate asymmetry the verdict contract calls
// out: label `sentry:verdict-upstream` <-> value `upstream-transient`.
export const LABEL_TO_VERDICT = {
  "sentry:verdict-code-fix": "code-fix",
  "sentry:verdict-config-fix": "config-fix",
  "sentry:verdict-upstream": "upstream-transient",
  "sentry:verdict-needs-human": "needs-human",
};

// The `failed` bucket is not a verdict — it is batch issues still carrying
// `sentry:needs-triage` (their triage job died before a verdict landed). It
// must stay visible, never hidden.
export const FAILED_BUCKET = "failed";

// ---------------------------------------------------------------------------
// Pure parsing: queue title.
// ---------------------------------------------------------------------------

// Queue contract v2 title: `[sentry] <SHORT-ID> (<project>, <level>)`.
const QUEUE_TITLE_PATTERN = /^\[sentry\]\s+(\S+)\s+\(([^,()]+),/;

export function parseQueueTitle(title) {
  const match = QUEUE_TITLE_PATTERN.exec(String(title ?? ""));
  if (!match) return { shortId: null, project: null };
  return { shortId: match[1], project: match[2].trim() };
}

// Authorship fence: only comments the pipeline's own Actions bot posted may
// supply the digest's rendered text — this repo is public, so a drive-by
// marker-bearing comment must not feed text (or a projected/fix URL) into the
// Slack digest. The predicate (and its rationale) lives in
// sentry-triage-project-core.mjs (`isTrustedComment`, imported above);
// re-export the login list so the digest's consumers keep one import surface.
export { TRUSTED_COMMENT_AUTHORS } from "./sentry-triage-project-core.mjs";

// Newest-first ordering must never trust API array order — sort by createdAt
// explicitly (same comparator as core's selectVerdictComment; stable, so
// fixtures without createdAt keep their relative order).
function compareCreatedAt(a, b) {
  return String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""));
}

/** The verdict comment to render text from — delegated to the pipeline's
 * SINGLE selection path (`selectVerdictComment` in sentry-triage-project-core.mjs:
 * trusted authors only, explicit createdAt sort — never API array order — and
 * the regression fence), so the digest can never render a different comment
 * than the one the label/projection steps acted on. Null when there is no
 * usable verdict comment (none, or stale pre-regression). */
export function findLatestVerdictComment(comments) {
  return selectVerdictComment(comments).body;
}

// Every URL below is embedded in Slack mrkdwn link syntax (`<url|text>`, in the
// render layer's `link()` / `idAndProject()`), so `<`, `>`, `|` in the URL would
// break out of the link. `UNSAFE_URL_CHARS` (imported from the render module,
// the single source) rejects those plus any ASCII control char or whitespace.
// `new URL()` accepts all of them in the path/query and these validators embed
// the RAW input string, so the shape check must run on the original — not on
// the re-encoded `parsed.href`.

/** True for an https `github.com` URL. The projected-issue and fix-PR pointers
 * are trusted-bot-posted, but shape-validate them anyway before turning them
 * into links (defense in depth on the authorship fence). */
function isGithubUrl(value) {
  const str = String(value);
  if (UNSAFE_URL_CHARS.test(str)) return false;
  try {
    const parsed = new URL(str);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

/** `createdAt` of the newest trusted regression-reopen comment, or "" when the
 * stub never regressed. Outcome pointers older than this describe the PREVIOUS
 * occurrence and must be ignored (see extractTrustedUrlComment). Mirrors the
 * regression fence in sentry-triage-project-core.mjs `selectVerdictComment`. */
function newestRegressionAt(comments) {
  let newest = "";
  for (const comment of comments ?? []) {
    if (
      typeof comment?.body === "string" &&
      isTrustedComment(comment) &&
      comment.body.startsWith(REGRESSION_PREFIX)
    ) {
      const at = String(comment.createdAt ?? "");
      if (at > newest) newest = at;
    }
  }
  return newest;
}

/** Newest trusted comment whose body is `<prefix><url>`, with `url` a valid
 * https github.com URL. Null when none. Used for the projected-issue pointer
 * (PROJECTED_COMMENT_PREFIX) and the #1278 fix-PR pointer
 * (AUTOFIX_COMMENT_PREFIX).
 *
 * Regression fence: a queue stub is REOPENED and re-triaged when its Sentry
 * issue regresses (Stage A), and its old comment history — including a stale
 * `Projected to owning repo:` / `Autofixed by PR:` pointer from the previous
 * occurrence — survives. Only a pointer strictly newer than the newest
 * regression-reopen comment describes THIS occurrence; older ones are dropped
 * so a re-triaged issue can't inherit a stale projection link or be misplaced
 * into the Autofixed section off a previous run's fix PR. A pointer missing a
 * `createdAt` after a regression fails closed (treated as stale). */
function extractTrustedUrlComment(comments, prefix) {
  const regressionAt = newestRegressionAt(comments);
  const matches = (comments ?? [])
    .filter(
      (comment) =>
        typeof comment?.body === "string" &&
        isTrustedComment(comment) &&
        comment.body.startsWith(prefix) &&
        (regressionAt === "" || String(comment.createdAt ?? "") > regressionAt),
    )
    // Newest-first is decided by createdAt, never by API array order (same
    // comparator as core's selectVerdictComment).
    .sort(compareCreatedAt);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const url =
      matches[i].body.slice(prefix.length).trim().split(/\s+/)[0] ?? "";
    if (isGithubUrl(url)) return url;
  }
  return null;
}

export function extractProjectedUrl(comments) {
  return extractTrustedUrlComment(comments, PROJECTED_COMMENT_PREFIX);
}

export function extractAutofixUrl(comments) {
  return extractTrustedUrlComment(comments, AUTOFIX_COMMENT_PREFIX);
}

// ---------------------------------------------------------------------------
// Classification: one collected issue -> one digest entry.
// ---------------------------------------------------------------------------

// No verdict comment on the stub. `affectedRepo`/`fixScope` stay unreadable
// rather than defaulted: the fix_scope annotation below must describe a verdict
// that was actually read, never one inferred from a missing comment.
const EMPTY_PARSED = {
  verdict: null,
  confidence: null,
  affectedRepo: "",
  fixScope: null,
  summary: "",
  humanQuestion: "",
  hypotheses: [],
  investigated: [],
  escalationReason: "",
};

/** Which outcome section an entry renders in. Bucket is the verdict; a
 * code/config-fix with recorded fix-PR data (#1278) goes to Autofixed. A LOCAL
 * code-fix scoped architectural gets its OWN "Open design work" section (#1812,
 * operator resolution #3) — it is held open under sentry:fix-scope-architectural
 * and the autofix leg never acts on it, so it is not "Routed" anywhere. Every
 * other actionable code/config-fix goes to Routed. */
function sectionForEntry({ bucket, autofixUrl, owningRepoIsLocal, fixScope }) {
  if (bucket === FAILED_BUCKET) return FAILED_SECTION;
  if (bucket === "needs-human") return NEEDS_HUMAN_SECTION;
  if (bucket === "upstream-transient") return WONTFIX_SECTION;
  // code-fix / config-fix.
  if (autofixUrl) return AUTOFIXED_SECTION;
  if (isArchitecturalLocalCodeFix({ bucket, owningRepoIsLocal, fixScope })) {
    return ARCHITECTURAL_SECTION;
  }
  return ROUTED_SECTION;
}

/**
 * The bucket is decided from LABELS (deterministic, validated by the workflow
 * label step), not from the agent's free-text comment:
 *   - still carrying `sentry:needs-triage`  -> failed (triage did not finish);
 *   - carries a `sentry:verdict-*` label    -> that verdict;
 *   - neither (shouldn't happen for a batch issue) -> failed, so it stays
 *     visible rather than silently dropped.
 * The comment supplies only human-readable fields (confidence, summary, and —
 * for needs-human — the decision-ready brief). The projected-issue URL / fix-PR
 * URL come from trusted-bot pointer comments; the Sentry permalink from the
 * queue-issue body.
 */
export function classifyIssue(issue) {
  const labelNames = (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
  const { shortId, project } = parseQueueTitle(issue?.title);
  const verdictCommentBody = findLatestVerdictComment(issue?.comments);
  const parsed = verdictCommentBody
    ? parseVerdictComment(verdictCommentBody)
    : EMPTY_PARSED;

  const stillNeedsTriage = labelNames.includes(NEEDS_TRIAGE_LABEL);
  // A stub is supposed to carry exactly one verdict label — the workflow's
  // verdict step sheds the others in the same edit (#1745). Keep the full list
  // so a violation is reportable; the bucket still takes the first match,
  // because picking a different loser would not make the answer any more true.
  const verdictLabels = labelNames.filter((name) =>
    Object.hasOwn(LABEL_TO_VERDICT, name),
  );
  const verdictLabel = verdictLabels[0];
  const verdictFromLabel = verdictLabel ? LABEL_TO_VERDICT[verdictLabel] : null;

  let bucket;
  if (stillNeedsTriage) bucket = FAILED_BUCKET;
  else if (verdictFromLabel) bucket = verdictFromLabel;
  else bucket = FAILED_BUCKET;

  const autofixUrl = extractAutofixUrl(issue?.comments);
  // The verdict contract's `fix_scope` (issue #1785) and whether the verdict
  // named THIS repo — computed here so the section decision (which now routes a
  // local architectural code-fix to its own #1812 section) and the entry agree.
  const fixScope = parsed.fixScope ?? null;
  const owningRepoIsLocal =
    validateAffectedRepo(parsed.affectedRepo).reason === "local-repo";

  return {
    number: issue?.number,
    shortId: shortId ?? `#${issue?.number}`,
    project: project ?? "unknown",
    verdictLabels,
    url: typeof issue?.url === "string" ? issue.url : "",
    bucket,
    section: sectionForEntry({
      bucket,
      autofixUrl,
      owningRepoIsLocal,
      fixScope,
    }),
    verdict: bucket === FAILED_BUCKET ? null : bucket,
    confidence: parsed.confidence,
    // Carried here for the same reason the needs-human brief is: the digest and
    // the selector are two consumers of one contract, so a field that gates the
    // selector cannot land on it alone and leave the human surface asserting the
    // opposite.
    fixScope,
    owningRepoIsLocal,
    summary: parsed.summary,
    // needs-human decision-ready brief. The full contract rides along even
    // though the Slack render below shows a subset (#1748) — carrying it here
    // keeps "which fields exist" a contract question and "which fields show"
    // a render one.
    humanQuestion: parsed.humanQuestion ?? "",
    howToCheck: parsed.howToCheck ?? [],
    decisionBranches: parsed.decisionBranches ?? [],
    hypotheses: parsed.hypotheses ?? [],
    investigated: parsed.investigated ?? [],
    escalationReason: parsed.escalationReason ?? "",
    sentryPermalink: extractPermalink(issue?.body),
    // Routed / Autofixed pointers.
    projectedUrl: extractProjectedUrl(issue?.comments),
    autofixUrl,
  };
}

// ---------------------------------------------------------------------------
// Slack payload assembly.
// ---------------------------------------------------------------------------

/**
 * Stubs carrying more than one `sentry:verdict-*` label, as ready-to-emit
 * warning lines. The verdict step enforces the one-label invariant and fails
 * its own matrix job on a violation (#1745); the digest only REPORTS one,
 * because it is the batch's single daily Slack notification and taking the run
 * down would trade a mis-bucketed row for no notification at all. A stub can
 * still reach here double-labelled if a human hand-labelled it or it predates
 * the shed. Pure — the caller does the writing.
 */
export function doubleVerdictWarnings(issues) {
  return (issues ?? [])
    .map(classifyIssue)
    .filter((entry) => entry.verdictLabels.length > 1)
    .map(
      (entry) =>
        `Issue #${entry.number} carries ${entry.verdictLabels.length} verdict labels (${entry.verdictLabels.join(", ")}); this digest bucketed it as "${entry.bucket}" from the first one. Remove the stale label.`,
    );
}

/**
 * Build the deterministic Slack `chat.postMessage` payload for one batch.
 * `channel` is passed in (hardcoded by the workflow). Pure — no I/O, no
 * escaping omissions: every free-form value is routed through the
 * escape/format helpers here.
 *
 * The payload carries no clock: Slack stamps every message itself, so the
 * digest renders nothing time-dependent and needs no injectable `now`.
 */
export function buildDigest(issues, { channel } = {}) {
  const entries = (issues ?? []).map(classifyIssue);

  const total = entries.length;
  // No timestamp: Slack renders its own next to the app name, and a second
  // one in the body is a line every reader skips.
  const headerText = `*Sentry triage — ${issueCountText(total)}*`;

  const blocks = [mrkdwnSection(headerText)];

  const bySection = new Map(SECTION_ORDER.map((key) => [key, []]));
  for (const entry of entries) bySection.get(entry.section).push(entry);

  for (const section of SECTION_ORDER) {
    const sectionEntries = bySection.get(section);
    if (sectionEntries.length === 0) continue; // omit empty sections
    const headerLine = `*${SECTION_TITLES[section]} (${sectionEntries.length})*`;
    // Chunk each section independently (header stays with its first chunk) so
    // escape-expanded summaries/briefs can never push a single text object
    // past Slack's 3000-char cap. needs-human chunks at ENTRY boundaries
    // (chunkBriefs — a brief is atomic); one-line sections pack line-greedily.
    // Batch cap is 6, so this stays well under Slack's 50-blocks limit.
    const chunks =
      section === NEEDS_HUMAN_SECTION
        ? chunkBriefs(headerLine, sectionEntries.map(renderNeedsHumanBrief))
        : chunkLines([
            headerLine,
            ...renderSectionBodyLines(section, sectionEntries),
          ]);
    for (const chunk of chunks) {
      blocks.push(mrkdwnSection(chunk));
    }
  }

  // The archive nudge, ONCE. It used to hang off every wontfix line, which in a
  // six-issue digest repeated the same sentence six times and buried the lines
  // that differ. It is guidance about a flow, not a fact about an issue, so it
  // belongs at the end and only when the digest actually contains something
  // archivable. Archiving stays human-gated (ADR 0036): this points at the
  // `sentry:approved-archive` label flow, never a Sentry mutation from here.
  if ((bySection.get(WONTFIX_SECTION) ?? []).length > 0) {
    blocks.push(
      mrkdwnSection(
        `_To archive a *${SECTION_TITLES[WONTFIX_SECTION]}* issue in Sentry: add \`${APPROVED_ARCHIVE_LABEL}\` to its queue issue._`,
      ),
    );
  }

  return {
    channel,
    // Plain-text fallback for notifications/screen readers (no untrusted text).
    text: `Sentry triage — ${issueCountText(total)}`,
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
    // `body` is needed for the needs-human brief's Sentry permalink (queue-body
    // yaml). All fields are read-only.
    "number,title,url,body,labels,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    url: data.url ?? "",
    body: data.body ?? "",
    labels: (data.labels ?? []).map((label) => label?.name),
    comments: data.comments ?? [],
  };
}

/** Fetch each batch issue's title/url/body/labels/comments. `run` is injectable
 * for tests. ≤6 issues per run (upstream batch cap), so a serial loop is fine. */
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
  for (const warning of doubleVerdictWarnings(issues)) {
    process.stderr.write(`::warning::${warning}\n`);
  }
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
