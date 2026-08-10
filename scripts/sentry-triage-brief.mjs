#!/usr/bin/env node
/**
 * needs-human BRIEF leg of the Sentry triage pipeline (issue #1748): a
 * deterministic, no-LLM step that renders the decision a human must make into
 * the queue stub's BODY, above the fold, so opening the issue from a
 * notification shows the question, how to check it, and what each answer leads
 * to — instead of a wall of YAML whose action is 300 words down.
 *
 * It is a PURE CONSUMER of the verdict contract in
 * docs/notes/sentry-triage-pipeline.md. It re-reads the stub from GitHub,
 * resolves the verdict through `resolveVerdict` (the pipeline's single
 * authoritative parser — the same one the label and projection steps run),
 * renders, and writes. It never re-fetches Sentry, never runs an LLM, never
 * touches labels or state, and never posts a comment.
 *
 * WHAT IT DOES NOT MOVE: the machine-readable YAML. The verdict YAML stays in
 * the verdict comment where `parseVerdictComment` / `resolveVerdict` (label
 * step, projection, digest, autofix select) read it, and the stub's metadata
 * YAML stays in its body where `extractPermalink` and `parseArchiveBaseline`
 * read it. This leg only PREPENDS a rendered block; every existing parser sees
 * exactly what it saw before.
 *
 * Security posture — the rendered fields are agent-authored text derived from
 * attacker-reachable Sentry payloads, and this repo is public:
 *   - Every free-form field goes through the SHARED selection+bound
 *     (`selectNeedsHumanBriefFields`, `MAX_BRIEF_TEXT_LEN`) and then
 *     `neutralizeUntrusted` — control chars stripped, newlines collapsed,
 *     backticks defanged, `@` defanged, `<!--` broken.
 *   - SINGLE-LINE by construction. That is load-bearing, not cosmetic: a
 *     surviving newline would let a field emit a body line of its own, and a
 *     line reading `permalink: https://<attacker>.sentry.io/...` ABOVE the
 *     metadata block would shadow the real one for `extractPermalink`, whose
 *     regex is multiline-anchored and first-match-wins.
 *   - No fenced code block is emitted anywhere in the brief. `extractYamlBlock`
 *     (and through it `parseArchiveBaseline`) takes the FIRST ```yaml fence in
 *     the body, so a fence above the metadata block would shadow the archive
 *     freshness baseline — the one field whose placement in the body IS the
 *     trust boundary (see sentry-triage-queue-contract.mjs). Backtick defanging
 *     already makes an agent-authored fence impossible; emitting none of our
 *     own keeps that true without depending on it.
 *   - Closed-set and shape-validated values only in the header: SHORT-ID
 *     (`isValidShortId`), confidence (closed enum), affected repo (bare
 *     `owner/name` slug or nothing), Sentry permalink (`extractPermalink`,
 *     https `*.sentry.io`).
 *   - `assertInertBlock` fails the write CLOSED if the assembled block would
 *     open with the verdict marker or reproduce a prefix-anchored control
 *     comment (regression reopen / projection pointer / autofix pointer) at the
 *     start of a line.
 *
 * The write is idempotent: the block is delimited, so a re-triage after a
 * regression reopen REPLACES it rather than stacking a second one.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The autofix pointer prefix is owned by the digest module (it defines the
// emission contract #1278 reads); import it rather than restating the literal.
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  DEFAULT_REPO,
  extractPermalink,
  isValidShortId,
  neutralizeUntrusted,
  parseShortId,
  PROJECTED_COMMENT_PREFIX,
  REGRESSION_PREFIX,
  resolveVerdict,
  selectNeedsHumanBriefFields,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";

// The stub body's own first line, owned by the ingest (`BODY_MARKER` there).
// The brief goes AFTER it and BEFORE the metadata yaml block: the marker stays
// the body's first line, which is how every stub written since queue contract
// v2 looks, and the yaml block keeps its position relative to the readers that
// find it by fence rather than by offset.
export const STUB_BODY_MARKER = "<!-- sentry-triage:v1 -->";

// Delimiters of the rendered block. Both are required for the replace path: an
// opener without a closer is a malformed block this leg refuses to guess at,
// because guessing would either eat the rest of the body or stack a duplicate.
export const BRIEF_BLOCK_START = "<!-- sentry-triage-brief:v1 -->";
export const BRIEF_BLOCK_END = "<!-- /sentry-triage-brief:v1 -->";

// Prefix-anchored control comments elsewhere in the pipeline. The brief must
// never reproduce one at the start of a line — see `assertInertBlock`.
const CONTROL_PREFIXES = [
  VERDICT_MARKER,
  REGRESSION_PREFIX,
  PROJECTED_COMMENT_PREFIX,
  AUTOFIX_COMMENT_PREFIX,
];

// ---------------------------------------------------------------------------
// Rendering (pure).
// ---------------------------------------------------------------------------

/** Neutralize one already-selected, already-bounded field for GitHub markdown.
 * Single-line in, single-line out. */
function renderField(text) {
  return neutralizeUntrusted(text);
}

/** `- item` bullets for one neutralized list; empty list -> no lines. */
function renderBullets(items) {
  return items
    .map((item) => `- ${renderField(item)}`)
    .filter((l) => l !== "- ");
}

/**
 * Render the decision-ready brief for ONE resolved needs-human verdict.
 *
 * Fixed order, so the format cannot drift comment to comment: decision header
 * -> the question -> how to check -> what each answer leads to -> everything
 * else collapsed. Sections whose field the verdict did not carry are omitted
 * entirely rather than rendered empty; `human_question` is always present
 * because `resolveVerdict` rejects a needs-human verdict without one.
 *
 * @param {object} args
 * @param {object} args.parsed  parsed verdict comment (parseVerdictComment)
 * @param {string} args.shortId Sentry SHORT-ID from the queue title
 * @param {string|null} args.permalink Sentry permalink from the stub body
 */
export function renderBriefBlock({ parsed, shortId, permalink }) {
  const fields = selectNeedsHumanBriefFields(parsed);
  const lines = [BRIEF_BLOCK_START, ""];

  // Header: shape-validated / closed-enum values only, never free text.
  const headerParts = ["**Decision needed**"];
  if (isValidShortId(shortId)) headerParts.push(`\`${shortId}\``);
  if (permalink) headerParts.push(`[View in Sentry](${permalink})`);
  headerParts.push(`confidence: ${parsed?.confidence ?? "unknown"}`);
  lines.push(`> ${headerParts.join(" · ")}`, "");

  lines.push(`**Question:** ${renderField(fields.question)}`, "");

  if (fields.howToCheck.length) {
    // `affected_repo` parses as a bare `owner/name` slug or empty — safe to
    // inline, and it is the one piece of routing a checker needs first.
    const repo = parsed?.affectedRepo ? ` — in \`${parsed.affectedRepo}\`` : "";
    lines.push(
      `**How to check**${repo}:`,
      "",
      ...renderBullets(fields.howToCheck),
      "",
    );
  }

  if (fields.decisionBranches.length) {
    lines.push("**Then:**", "", ...renderBullets(fields.decisionBranches), "");
  }

  // Justification, not instruction — collapsed, per #1748. Rendered as bullets
  // (never a fence: see the module header).
  const evidence = [];
  if (fields.escalationReason) {
    evidence.push(
      `- **Why escalated:** ${renderField(fields.escalationReason)}`,
    );
  }
  evidence.push(...labelledBullets("Hypothesis", fields.hypotheses));
  evidence.push(...labelledBullets("Checked", fields.investigated));
  if (evidence.length) {
    lines.push(
      "<details><summary>Evidence and context</summary>",
      "",
      ...evidence,
      "",
      "</details>",
      "",
    );
  }

  lines.push(
    "_Rendered from the verdict comment below by the Sentry triage pipeline; the machine-readable verdict YAML lives there. Edits here are overwritten on re-triage._",
    "",
    BRIEF_BLOCK_END,
  );
  return lines.join("\n");
}

/** `- **<label>:** <item>` per list entry, so a collapsed evidence bullet says
 * what kind of evidence it is without a nested list. */
function labelledBullets(label, items) {
  return items
    .map((item) => renderField(item))
    .filter(Boolean)
    .map((item) => `- **${label}:** ${item}`);
}

/**
 * Fail CLOSED if the assembled block could be misread by a prefix-anchored
 * consumer: it must not START with the verdict marker, and no line may START
 * with a control-comment prefix. Neither is reachable through a rendered field
 * today (every field is single-line and lands after our own literal prefix),
 * which is exactly why this is an assertion rather than a rewrite — if it ever
 * fires, the renderer changed shape and the change needs a human.
 */
export function assertInertBlock(block) {
  const text = String(block ?? "");
  if (text.startsWith(VERDICT_MARKER)) {
    throw new Error(
      "Refusing to write a brief block that starts with the verdict marker.",
    );
  }
  for (const line of text.split("\n")) {
    for (const prefix of CONTROL_PREFIXES) {
      if (line.startsWith(prefix)) {
        throw new Error(
          `Refusing to write a brief block whose line reproduces a pipeline control prefix: ${prefix.trim()}`,
        );
      }
    }
  }
  return text;
}

/**
 * Return `body` with `block` written above the metadata yaml, replacing any
 * previous brief block (idempotent across re-triage). Returns null when the
 * body carries an opener with no closer — a malformed block is a hard refusal,
 * not something to guess at.
 */
export function applyBriefToBody(body, block) {
  const source = String(body ?? "");
  const start = source.indexOf(BRIEF_BLOCK_START);
  if (start !== -1) {
    const end = source.indexOf(BRIEF_BLOCK_END, start);
    if (end === -1) return null;
    return `${source.slice(0, start)}${block}${source.slice(end + BRIEF_BLOCK_END.length)}`;
  }
  if (source.startsWith(STUB_BODY_MARKER)) {
    const rest = source.slice(STUB_BODY_MARKER.length).replace(/^\r?\n+/, "");
    return `${STUB_BODY_MARKER}\n\n${block}\n\n${rest}`;
  }
  // No stub marker (hand-created or hand-edited stub): put the brief first
  // rather than refusing — the decision still belongs above the fold.
  return `${block}\n\n${source}`;
}

// ---------------------------------------------------------------------------
// GitHub I/O (via `gh`, mirroring the projection/digest legs).
// ---------------------------------------------------------------------------

function defaultRunGh(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
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
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

async function readQueueIssue(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,comments",
  ]);
  const data = JSON.parse(stdout);
  return {
    number: data.number,
    title: data.title ?? "",
    body: data.body ?? "",
    comments: data.comments ?? [],
  };
}

/**
 * Read the stub, resolve its verdict, render, write. A verdict that is NOT
 * needs-human is a no-op (`written: false`) rather than an error: the workflow
 * step is gated on the verdict too, and a second guard here means a
 * hand-invocation cannot brief a code-fix stub.
 *
 * Fails LOUD on a missing/stale/invalid verdict (via `resolveVerdict`) and on a
 * malformed existing block. The verdict job runs this AFTER the label swap and
 * before its close step, whose needs-human arm is a no-op — so a failure here
 * turns the job red for the notifier without stranding the stub: it stays open,
 * verdict-labeled, exactly where a needs-human stub belongs.
 */
export async function runBrief({
  runGh = defaultRunGh,
  repo = DEFAULT_REPO,
  issueNumber,
  dryRun = false,
  log = console.log,
} = {}) {
  const issue = await readQueueIssue(runGh, repo, issueNumber);
  const { parsed, verdict } = resolveVerdict(issue, issueNumber);
  if (verdict !== "needs-human") {
    log(`Issue #${issueNumber} verdict is ${verdict}; no brief to render.`);
    return { written: false, verdict, body: null };
  }

  const block = assertInertBlock(
    renderBriefBlock({
      parsed,
      shortId: parseShortId(issue.title),
      permalink: extractPermalink(issue.body),
    }),
  );
  const body = applyBriefToBody(issue.body, block);
  if (body === null) {
    throw new Error(
      `Issue #${issueNumber} carries a brief opener with no closing delimiter; refusing to rewrite the body. Repair the body by hand and re-run.`,
    );
  }
  if (body === issue.body) {
    log(`Issue #${issueNumber} brief is already current; nothing to write.`);
    return { written: false, verdict, body };
  }
  if (dryRun) {
    log(body);
    return { written: false, verdict, body };
  }
  // `--body-file -` reads the body from stdin: the rendered text carries
  // untrusted agent prose and must never transit an argv slot or a shell.
  await runGh(
    ["issue", "edit", String(issueNumber), "-R", repo, "--body-file", "-"],
    { stdin: body },
  );
  log(`Wrote the needs-human brief to issue #${issueNumber}.`);
  return { written: true, verdict, body };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { repo: DEFAULT_REPO, issueNumber: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--issue") {
      args.issueNumber = argv[++i];
    } else if (arg === "--repo") {
      args.repo = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!/^\d+$/.test(String(args.issueNumber ?? ""))) {
    throw new Error("--issue <number> is required.");
  }
  args.issueNumber = Number(args.issueNumber);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runBrief(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
