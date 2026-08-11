#!/usr/bin/env node
/**
 * needs-human BRIEF leg of the Sentry triage pipeline (issue #1748): a
 * deterministic, no-LLM step that renders the decision a human must make as a
 * dedicated, updated-in-place COMMENT on the queue stub — the question, how to
 * check it, and what each answer leads to — so opening the issue from a
 * notification shows the decision instead of a wall of YAML.
 *
 * WHY A COMMENT, NOT THE BODY. An earlier revision rendered the brief INTO the
 * stub BODY and tried to keep it safe against the archive leg — the other writer
 * of that body — through label observation. That was fundamentally insufficient
 * (PR #1769 review): the archive's settlement deletes `sentry:approved-archive`
 * BEFORE it writes its freshness baseline and adds `sentry:archived` only AFTER
 * the close, so between them the stub carries NEITHER coordination label and a
 * whole-body edit here could silently clobber the archive's baseline — a window
 * no label check can see. And yielding on an approval label meant a stub
 * re-triaged away from needs-human while still carrying that label never had its
 * stale brief removed, so a later close could bury an obsolete "Decision needed"
 * block permanently.
 *
 * A comment dissolves both, and restores the single-writer invariant PR #1766
 * established (the archive leg is the SOLE stub-body writer; losing the baseline
 * strands the archive contract, #1371):
 *   - This leg NEVER writes the stub body. It cannot drop the archive freshness
 *     baseline in ANY interleaving — labeled, unlabeled, or first-archive —
 *     because it never touches the surface the baseline lives on.
 *   - Stale-brief removal is deleting THIS leg's own marked comment, regardless
 *     of any label. A re-triage to code-fix / config-fix / upstream-transient
 *     removes the brief even while the stub still carries a stale archive
 *     approval, so a re-triaged stub can never close showing an obsolete brief.
 *
 * THE COMMENT'S LIFECYCLE, in one place, because a rendering that outlives what
 * it renders is worse than no rendering. The comment exists IFF a live
 * needs-human verdict describes the stub:
 *   - needs-human verdict -> create the comment, or update it in place if it is
 *     already there (idempotent, so a re-triage never stacks a second one), and
 *     delete any duplicate brief comment.
 *   - ANY other verdict -> DELETE the brief comment. The workflow step is
 *     therefore ungated: gating it on needs-human is what let a brief survive a
 *     re-triage to code-fix / config-fix / upstream-transient permanently.
 *   - a re-queue would be the earliest moment to drop the rendering, and this
 *     leg deliberately does not reach there: the re-queue chokepoint writes no
 *     stub body and posts no comment (issue #1692). So a re-queued stub carries
 *     its old comment until the next round's verdict lands, on a stub whose
 *     labels already read `sentry:needs-triage`.
 *
 * Security posture — the rendered fields are agent-authored text derived from
 * attacker-reachable Sentry payloads, and this repo is public:
 *   - Every free-form field goes through the SHARED selection+bound
 *     (`selectNeedsHumanBriefFields`, `MAX_BRIEF_TEXT_LEN`), then
 *     `neutralizeUntrusted` — control chars stripped, newlines collapsed,
 *     backticks defanged, `@` defanged — and finally this emitter's own surface
 *     escape, `escapeGithubMarkdown`. The escape is what makes agent text render
 *     as text and never as a control of its own: neutralization alone leaves
 *     `[text](url)`, `![img](url)`, raw HTML and entity references active, which
 *     is enough for agent text to put a clickable link beside the trusted
 *     `[View in Sentry]` one.
 *   - SINGLE-LINE by construction, so a field cannot emit a line of its own.
 *   - No fenced code block is emitted anywhere, so the comment cannot be parsed
 *     as a verdict comment (`parseVerdictComment` needs a ```yaml fence).
 *   - Closed-set and shape-validated values only in the header: SHORT-ID
 *     (`isValidShortId`), confidence (closed enum), affected repo (bare
 *     `owner/name` slug or nothing), Sentry permalink (`extractPermalink`,
 *     https `*.sentry.io`).
 *   - `assertInertBlock` fails the write CLOSED if the comment would open with
 *     the verdict marker or reproduce a prefix-anchored control comment
 *     (regression reopen / projection pointer / autofix pointer) at the start of
 *     a line. That keeps the display-only brief comment inert to every
 *     prefix-anchored pipeline consumer (`selectVerdictComment` and friends).
 *   - The brief comment is DISPLAY-ONLY: no pipeline consumer parses it as a
 *     contract, so its author identity is not a trust boundary. This leg selects
 *     the comment to update/delete by the shared trusted-author + marker fence
 *     (`isTrustedComment` + `BRIEF_COMMENT_MARKER`), so a drive-by commenter
 *     cannot make it PATCH or DELETE their comment.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The autofix pointer prefix is owned by the digest module (it defines the
// emission contract #1278 reads); import it rather than restating the literal.
import { AUTOFIX_COMMENT_PREFIX } from "./sentry-triage-digest.mjs";
import {
  DEFAULT_REPO,
  extractPermalink,
  isTrustedComment,
  isValidShortId,
  neutralizeUntrusted,
  parseShortId,
  PROJECTED_COMMENT_PREFIX,
  REGRESSION_PREFIX,
  resolveVerdict,
  selectNeedsHumanBriefFields,
  VERDICT_MARKER,
  verdictCommentIdFromUrl,
} from "./sentry-triage-project-core.mjs";
// The terminal marker the write-side guard refuses to write past — one source of
// truth with the archive leg that applies it.
import { ARCHIVED_LABEL } from "./sentry-triage-queue-contract.mjs";

// The brief comment's anchor. The selector matches a comment by trusted author
// AND `startsWith(BRIEF_COMMENT_MARKER)` — the same fence the rolling run-record
// writers use — so an untrusted commenter cannot plant the marker and have this
// leg PATCH or DELETE their comment. Escaping already stops an agent-authored
// field from reproducing these literal bytes.
export const BRIEF_COMMENT_MARKER = "<!-- sentry-triage-brief:v1 -->";

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

// Every character GitHub markdown treats as ACTIVE. A backslash before ASCII
// punctuation is a CommonMark escape, so escaping the whole set costs nothing
// visually — the reader sees the original characters, the renderer sees no
// syntax — which is why the set is deliberately wide rather than minimal.
//
// `&` is in the set because GitHub decodes entity references: leaving it live
// would let `&#60;` render as `<` and reintroduce every character escaped here.
// `<` and `>` cover raw HTML and autolinks; `[` `]` `(` `)` `!` cover links and
// images; `#` `+` `-` `.` cover the block constructs a field could start after
// the renderer's own `- ` bullet prefix; `*` `_` `~` cover emphasis; `|` covers
// table cells; the backslash itself must come first, and does, because the
// class is applied in one pass.
const GITHUB_MARKDOWN_ACTIVE = /[\\`*_[\]()<>&#+.!|~-]/g;

/**
 * The GitHub emitter's surface escape — the counterpart of the Slack emitter's
 * `escapeSlackText`, applied on top of the shared bound + neutralization.
 *
 * Neutralization makes a field single-line and kills backticks and mentions; it
 * does NOT stop the field from RENDERING. A question carrying
 * `[View in Sentry](https://evil.example)` or a step carrying
 * `![ok](https://evil.example/x)` renders as a live link or image next to the
 * pipeline's own trusted controls, which is the whole spoof. After this, agent
 * text can only ever render as text.
 */
export function escapeGithubMarkdown(text) {
  return String(text ?? "").replace(GITHUB_MARKDOWN_ACTIVE, "\\$&");
}

/** Neutralize AND escape one already-selected, already-bounded field for GitHub
 * markdown. Single-line in, single-line inert text out. */
function renderField(text) {
  return escapeGithubMarkdown(neutralizeUntrusted(text));
}

/** `- item` bullets for one neutralized list; empty list -> no lines. */
function renderBullets(items) {
  return items
    .map((item) => `- ${renderField(item)}`)
    .filter((l) => l !== "- ");
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
 * Render the decision-ready brief comment for ONE resolved needs-human verdict.
 *
 * Fixed order, so the format cannot drift comment to comment: marker -> decision
 * header -> the question -> how to check -> what each answer leads to ->
 * everything else collapsed. Sections whose field the verdict did not carry are
 * omitted entirely rather than rendered empty; `human_question` is always
 * present because `resolveVerdict` rejects a needs-human verdict without one.
 *
 * @param {object} args
 * @param {object} args.parsed  parsed verdict comment (parseVerdictComment)
 * @param {string} args.shortId Sentry SHORT-ID from the queue title
 * @param {string|null} args.permalink Sentry permalink from the stub body
 */
export function renderBriefComment({ parsed, shortId, permalink }) {
  const fields = selectNeedsHumanBriefFields(parsed);
  const lines = [BRIEF_COMMENT_MARKER, ""];

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
    "_Rendered by the Sentry triage pipeline from this issue's verdict comment; the machine-readable verdict YAML lives there. This comment is overwritten on re-triage and removed once the verdict is no longer needs-human._",
  );
  return lines.join("\n");
}

/**
 * Fail CLOSED if the assembled comment could be misread by a prefix-anchored
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
      "Refusing to write a brief comment that starts with the verdict marker.",
    );
  }
  for (const line of text.split("\n")) {
    for (const prefix of CONTROL_PREFIXES) {
      if (line.startsWith(prefix)) {
        throw new Error(
          `Refusing to write a brief comment whose line reproduces a pipeline control prefix: ${prefix.trim()}`,
        );
      }
    }
  }
  return text;
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

/** Read the stub: title (short id), body (permalink) and comments (verdict
 * resolution AND the brief comment this leg maintains). This read does not fetch
 * state/labels — the verdict decides what to do. The WRITE path takes a separate
 * terminal-state read (`readStubTerminalState`) right before it writes: that is
 * the one place this leg must see the archive leg's terminal marker, to refuse
 * creating a brief on a stub the archive settled after this read (#1769 round
 * 6). It still never OBSERVES the approval label — only the terminal one. */
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
 * Re-read the stub's terminal signals immediately before a brief WRITE. `state`
 * is CLOSED once the stub is settled; `sentry:archived` is the durable terminal
 * marker the archive leg applies. Both come from a fresh read, so an archive
 * that closed/archived the stub AFTER `runBrief`'s initial read is caught here.
 */
async function readStubTerminalState(runGh, repo, number) {
  const stdout = await runGh([
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "state,labels",
  ]);
  const data = JSON.parse(stdout);
  const labels = (Array.isArray(data.labels) ? data.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
  const state = String(data.state ?? "").toUpperCase();
  return {
    state,
    closed: state === "CLOSED",
    archived: labels.includes(ARCHIVED_LABEL),
  };
}

/**
 * Every brief comment on the stub: trusted author AND anchored by
 * `BRIEF_COMMENT_MARKER`, the same fence `selectMarkedComment` applies for the
 * rolling run-records. Plural so removal can clear a duplicate a prior run or a
 * marker-planting commenter left behind — a re-triaged stub must never keep a
 * "Decision needed" comment, and never two.
 */
export function findBriefComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter(
    (comment) =>
      typeof comment?.body === "string" &&
      isTrustedComment(comment) &&
      comment.body.startsWith(BRIEF_COMMENT_MARKER),
  );
}

/** The numeric REST id of a comment, parsed from its `url` (`gh`'s comment
 * `.id` is an opaque GraphQL node id the REST edit/delete endpoints reject).
 * Throws rather than guess: without it this leg cannot edit or delete. */
function briefCommentId(comment) {
  const id = verdictCommentIdFromUrl(comment?.url);
  if (!id) {
    throw new Error(
      `Brief comment ${JSON.stringify(
        comment?.url ?? null,
      )} has no parseable numeric id; refusing to edit or delete it.`,
    );
  }
  return id;
}

/** Create the brief comment. `--body-file -` reads the body from stdin: it
 * carries untrusted agent prose and must never transit an argv slot or a
 * shell. */
function createBriefComment(runGh, repo, issueNumber, body) {
  return runGh(
    ["issue", "comment", String(issueNumber), "-R", repo, "--body-file", "-"],
    { stdin: body },
  );
}

/** Update the brief comment in place. The JSON request body goes on stdin via
 * `--input -`, so the untrusted body never reaches argv. */
function updateBriefComment(runGh, repo, commentId, body) {
  return runGh(
    [
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${commentId}`,
      "--input",
      "-",
    ],
    { stdin: JSON.stringify({ body }) },
  );
}

/** Delete the brief comment. */
function deleteBriefComment(runGh, repo, commentId) {
  return runGh([
    "api",
    "-X",
    "DELETE",
    `repos/${repo}/issues/comments/${commentId}`,
  ]);
}

/**
 * Delete every marked needs-human brief comment on a stub, given that stub's
 * `comments` (as `gh issue view --json comments` returns them: trusted author,
 * `url` carrying the numeric REST id). Idempotent — no marked comment means no
 * call — and returns the number removed.
 *
 * This is the CLASS fix for the terminal-transition gap (#1769 round 5). The
 * brief's own lifecycle clears the comment on a VERDICT change, but a stub can
 * also reach a terminal state WITHOUT one: a human applies
 * `sentry:approved-archive` to a `needs-human` stub and the archive leg closes
 * it and adds `sentry:archived` without ever re-running this script. Any such
 * close path must call this so the settled stub does not sit closed showing a
 * stale "Decision needed". Deleting a comment is not a body write, so #1766's
 * single-body-writer invariant is untouched; the trusted-author + marker fence
 * (`findBriefComments`) is exactly what gets deleted, so a drive-by comment is
 * never removed by mistake.
 */
export async function clearBriefComments({
  runGh,
  repo = DEFAULT_REPO,
  issueNumber,
  comments,
  log = () => {},
}) {
  let removed = 0;
  for (const comment of findBriefComments(comments)) {
    await deleteBriefComment(runGh, repo, briefCommentId(comment));
    removed += 1;
  }
  if (removed) {
    log(
      `Removed ${removed} needs-human brief comment(s) from issue #${issueNumber} on a terminal transition that did not change its verdict.`,
    );
  }
  return removed;
}

/**
 * Read the stub, resolve its verdict, and drive the brief COMMENT to the state
 * that verdict implies: present and current for `needs-human`, ABSENT for every
 * other verdict. The removal arm is why the workflow step is ungated — a brief
 * that survives a re-triage to code-fix describes a decision nobody has to make
 * any more, and it sits on the issue looking current.
 *
 * The write touches only comments, never the stub body, so it cannot race the
 * archive leg's baseline write (the single-writer invariant of PR #1766) and
 * needs no label observation to stay clear of it.
 *
 * Fails LOUD on a missing/stale/invalid verdict (via `resolveVerdict`) and on a
 * brief comment with no parseable id. The verdict job runs this after the label
 * swap, inside the window where `sentry:needs-triage` is already off, so its
 * step catches a failure here and re-queues the stub before failing — see the
 * compensation in .github/workflows/sentry-triage-agent.yml. Everything this leg
 * does is idempotent, so that retry costs nothing.
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
  const existing = findBriefComments(issue.comments);

  if (verdict !== "needs-human") {
    // The decision is gone — delete every brief comment, regardless of any
    // label the stub carries. This is what a stub re-triaged away from
    // needs-human while still holding a stale `sentry:approved-archive` needs:
    // its brief is removed, so a later close can never show an obsolete one.
    if (dryRun) {
      if (existing.length) {
        log(
          `[dry-run] would delete ${existing.length} stale needs-human brief comment(s) from issue #${issueNumber} (verdict is ${verdict}).`,
        );
      }
      return { written: false, verdict };
    }
    let written = false;
    for (const comment of existing) {
      await deleteBriefComment(runGh, repo, briefCommentId(comment));
      written = true;
    }
    log(
      written
        ? `Removed the stale needs-human brief comment(s) from issue #${issueNumber} (verdict is ${verdict}).`
        : `Issue #${issueNumber} carries no needs-human brief; nothing to remove (verdict is ${verdict}).`,
    );
    return { written, verdict };
  }

  const block = assertInertBlock(
    renderBriefComment({
      parsed,
      shortId: parseShortId(issue.title),
      permalink: extractPermalink(issue.body),
    }),
  );

  if (dryRun) {
    log(block);
    return { written: false, verdict };
  }

  // Terminal-write guard (#1769 round 6). The archive leg runs in a DIFFERENT
  // concurrency group and round 5 made it CLEAR this brief on settlement. So an
  // archive can close the stub and add `sentry:archived` AFTER this leg's read
  // but BEFORE this write — its cleanup already ran, and a create here would
  // strand a "Decision needed" comment on the closed archive forever. Re-read the
  // terminal signals right before writing and refuse. Unlike the approval label
  // the redesign deliberately does not observe, `sentry:archived` is terminal and
  // MONOTONIC — only a regression reopen sheds it, and that reopen re-triages — so
  // a stub that reads closed/archived here will not silently revert, and refusing
  // is race-free. This is the write-side complement of the archive's terminal
  // cleanup; together they cover both orderings of the two legs.
  const terminal = await readStubTerminalState(runGh, repo, issueNumber);
  if (terminal.closed || terminal.archived) {
    log(
      `::notice::Issue #${issueNumber} is terminal before the brief write (state=${terminal.state}, archived=${terminal.archived}); refusing to write a needs-human brief onto a settled stub.`,
    );
    return { written: false, verdict, refused: true };
  }

  const [primary, ...duplicates] = existing;
  let written = false;
  if (!primary) {
    await createBriefComment(runGh, repo, issueNumber, block);
    written = true;
  } else if (primary.body !== block) {
    await updateBriefComment(runGh, repo, briefCommentId(primary), block);
    written = true;
  }
  // Never leave two "Decision needed" comments on one stub.
  for (const duplicate of duplicates) {
    await deleteBriefComment(runGh, repo, briefCommentId(duplicate));
    written = true;
  }

  log(
    written
      ? `Wrote the needs-human brief comment to issue #${issueNumber}.`
      : `Issue #${issueNumber} already carries its current needs-human brief; nothing to write.`,
  );
  return { written, verdict };
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
